/**
 * satSync.js — Orquestador de sincronización SAT
 *
 * Coordina el flujo completo:
 *   autenticar → solicitar → verificar (polling) → descargar → procesar → guardar
 *
 * Independiente de los módulos de pedidos, WhatsApp, llamadas y comandas.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './database.js';
import {
  autenticar,
  solicitarDescarga,
  verificarSolicitud,
  descargarPaquete,
  extraerXmlsDeZip,
  parsearCFDI,
  validarCertificado,
} from './satClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '../../storage/cfdi');
const NEGOCIO_ID  = 'default';

// ─── Asegurar directorio de almacenamiento ───────────────────────────────────
function asegurarDirectorio(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ─── Migración de columnas nuevas ────────────────────────────────────────────
async function migrarTablas() {
  await pool.query(`
    ALTER TABLE sat_download_requests
      ADD COLUMN IF NOT EXISTS tipo_solicitud VARCHAR(20) DEFAULT 'CFDI'
  `).catch(() => {});
}

// ─── Máscaras para logs (ocultar RFC e IdSolicitud completos) ─────────────────
function ocultarRfc(rfc) {
  if (!rfc || rfc.length < 6) return '***';
  return rfc.slice(0, 3) + '***' + rfc.slice(-3);
}
function ocultarId(id) {
  if (!id) return '…';
  return id.slice(0, 8) + '…';
}
// Enmascara cualquier UUID y RFC en texto libre
function enmascarar(texto) {
  if (!texto) return texto;
  return texto
    .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (m) => m.slice(0, 8) + '…')
    .replace(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/g,
      (m) => m.slice(0, 3) + '***' + m.slice(-3));
}

// ─── Esperas progresivas entre polls ─────────────────────────────────────────
// 10 s → 20 s → 30 s → 60 s (constante desde el 4.º intento)
function delayPoll(intento) {
  return [10000, 20000, 30000][intento] ?? 60000;
}

// ─── Obtener RFC configurado ─────────────────────────────────────────────────
async function obtenerRfcActivo() {
  const { rows } = await pool.query(
    `SELECT rfc FROM sat_accounts WHERE negocio_id = $1 AND active = TRUE ORDER BY id DESC LIMIT 1`,
    [NEGOCIO_ID]
  );
  if (!rows.length) throw new Error('No hay cuenta SAT configurada. Ve a Finanzas → Configuración.');
  return rows[0].rfc;
}

// ─── Guardar solicitud en DB ──────────────────────────────────────────────────
async function crearSolicitudDB(rfc, fechaInicial, fechaFinal) {
  const { rows } = await pool.query(
    `INSERT INTO sat_download_requests
       (negocio_id, fecha_inicial, fecha_final, download_type, tipo_solicitud, status, requested_at)
     VALUES ($1, $2, $3, 'recibidos', 'CFDI', 'pendiente_sat', NOW())
     RETURNING id`,
    [NEGOCIO_ID, fechaInicial, fechaFinal]
  );
  return rows[0].id;
}

async function actualizarSolicitudDB(id, campos) {
  const sets = Object.entries(campos).map(([k, v], i) => `${k} = $${i + 2}`).join(', ');
  const vals = Object.values(campos);
  await pool.query(
    `UPDATE sat_download_requests SET ${sets}, last_checked_at = NOW() WHERE id = $1`,
    [id, ...vals]
  );
}

// ─── Guardar paquete en DB ────────────────────────────────────────────────────
async function crearPaqueteDB(solicitudId, packageId) {
  const { rows } = await pool.query(
    `INSERT INTO sat_packages (download_request_id, sat_package_id, status)
     VALUES ($1, $2, 'pendiente')
     ON CONFLICT (sat_package_id) DO UPDATE SET download_request_id = $1
     RETURNING id`,
    [solicitudId, packageId]
  );
  return rows[0].id;
}

async function actualizarPaqueteDB(id, campos) {
  const sets = Object.entries(campos).map(([k, v], i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE sat_packages SET ${sets} WHERE id = $1`,
    [id, ...Object.values(campos)]
  );
}

// ─── Guardar factura + items en DB ────────────────────────────────────────────
async function guardarFactura(cfdi, xmlPath, paqueteDbId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO invoices (
         negocio_id, uuid, version_cfdi, fecha_emision, fecha_timbrado,
         rfc_emisor, nombre_emisor, rfc_receptor, nombre_receptor,
         subtotal, descuento, impuestos_trasladados, impuestos_retenidos,
         total, moneda, tipo_cambio, tipo_comprobante, metodo_pago, forma_pago,
         uso_cfdi, serie, folio, exportacion, fiscal_status,
         xml_storage_path, source, imported_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'vigente',
         $24,'sat_descarga',NOW()
       )
       ON CONFLICT (negocio_id, uuid) DO NOTHING
       RETURNING id`,
      [
        NEGOCIO_ID, cfdi.uuid, cfdi.version_cfdi, cfdi.fecha_emision, cfdi.fecha_timbrado,
        cfdi.rfc_emisor, cfdi.nombre_emisor, cfdi.rfc_receptor, cfdi.nombre_receptor,
        cfdi.subtotal, cfdi.descuento, cfdi.impuestos_trasladados, cfdi.impuestos_retenidos,
        cfdi.total, cfdi.moneda, cfdi.tipo_cambio, cfdi.tipo_comprobante,
        cfdi.metodo_pago, cfdi.forma_pago, cfdi.uso_cfdi, cfdi.serie,
        cfdi.folio, cfdi.exportacion, xmlPath,
      ]
    );

    if (rows.length && cfdi.items?.length) {
      const invoiceId = rows[0].id;
      for (const item of cfdi.items) {
        await client.query(
          `INSERT INTO invoice_items (
             invoice_id, clave_prod_serv, no_identificacion, descripcion,
             cantidad, clave_unidad, unidad, valor_unitario, importe, descuento, objeto_impuesto
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            invoiceId, item.clave_prod_serv, item.no_identificacion, item.descripcion,
            item.cantidad, item.clave_unidad, item.unidad, item.valor_unitario,
            item.importe, item.descuento, item.objeto_impuesto,
          ]
        );
      }
    }

    await client.query('COMMIT');
    return rows.length > 0; // true = insertada, false = ya existía (duplicado)
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Procesar un paquete ZIP: extraer XMLs y guardar cada CFDI ───────────────
async function procesarPaquete(paqueteDbId, packageId, zipBuffer, rfc) {
  let xmls;
  try {
    xmls = await extraerXmlsDeZip(zipBuffer);
  } catch (e) {
    await actualizarPaqueteDB(paqueteDbId, { status: 'error', error_message: e.message });
    throw e;
  }

  let nuevos = 0, duplicados = 0, errores = 0;

  for (const { nombre, xml } of xmls) {
    try {
      const cfdi = parsearCFDI(xml);
      if (!cfdi.uuid) { errores++; continue; }

      // Guardar XML original en disco
      const fecha = cfdi.fecha_emision ? new Date(cfdi.fecha_emision) : new Date();
      const año   = fecha.getFullYear();
      const mes   = String(fecha.getMonth() + 1).padStart(2, '0');
      const dir   = path.join(STORAGE_DIR, String(año), mes);
      asegurarDirectorio(dir);
      const xmlPath = path.join(dir, `${cfdi.uuid}.xml`);
      if (!fs.existsSync(xmlPath)) fs.writeFileSync(xmlPath, xml, 'utf8');

      const insertado = await guardarFactura(cfdi, xmlPath, paqueteDbId);
      if (insertado) nuevos++; else duplicados++;
    } catch (e) {
      console.error(`[SAT] Error procesando ${nombre}:`, e.message);
      errores++;
    }
  }

  await actualizarPaqueteDB(paqueteDbId, {
    status: errores === xmls.length ? 'error' : 'procesado',
    processed_at: new Date().toISOString(),
    error_message: errores > 0 ? `${errores} errores de ${xmls.length}` : null,
  });

  return { total: xmls.length, nuevos, duplicados, errores };
}

// ─── Buscar solicitud pendiente reanudable ────────────────────────────────────
async function buscarSolicitudPendiente(rfc, fechaInicial, fechaFinal) {
  const { rows } = await pool.query(
    `SELECT id, sat_request_id FROM sat_download_requests
     WHERE negocio_id = $1
       AND download_type = 'recibidos'
       AND status IN ('pendiente_sat', 'timeout')
       AND sat_request_id IS NOT NULL
       AND fecha_inicial = $2
       AND fecha_final   = $3
     ORDER BY requested_at DESC
     LIMIT 1`,
    [NEGOCIO_ID, fechaInicial, fechaFinal]
  );
  return rows[0] ?? null;
}

// ─── FLUJO PRINCIPAL: sincronizar un rango de fechas ────────────────────────
export async function sincronizarRango(fechaInicial, fechaFinal, { onProgress } = {}) {
  await migrarTablas();

  // tipo='evento' = línea fija que se agrega al log
  // tipo='estado' = línea única que se sobreescribe (polling)
  const evento = (msg) => {
    const txt = enmascarar(msg);
    console.log(`[SAT Sync] ${txt}`);
    onProgress?.(txt, 'evento');
  };
  const estadoLine = (msg) => {
    onProgress?.(enmascarar(msg), 'estado');
  };

  const rfc = await obtenerRfcActivo();
  evento(`Iniciando sincronización ${fechaInicial} → ${fechaFinal}`);

  validarCertificado(rfc);
  evento('Certificado válido ✓');

  let solicitudDbId, satRequestId;
  let tokenObtenidoEn = 0;

  const renovarToken = async () => {
    const t = await autenticar(rfc);
    tokenObtenidoEn = Date.now();
    return t;
  };
  const tokenFresco = async (t) => {
    if (Date.now() - tokenObtenidoEn > 4.5 * 60 * 1000) {
      evento('Renovando token SAT...');
      return renovarToken();
    }
    return t;
  };

  try {
    evento('Autenticando con e.firma...');
    let token = await renovarToken();
    evento('Token obtenido ✓');

    // ── Reanudar solicitud pendiente si existe ─────────────────────────────
    const pendiente = await buscarSolicitudPendiente(rfc, fechaInicial, fechaFinal);
    if (pendiente) {
      solicitudDbId = pendiente.id;
      satRequestId  = pendiente.sat_request_id;
      evento(`Retomando solicitud existente: ${ocultarId(satRequestId)}`);
      await actualizarSolicitudDB(solicitudDbId, { status: 'pendiente_sat' });
    } else {
      // Crear registro ANTES de llamar a SAT (para guardar el IdSolicitud en cuanto llegue)
      solicitudDbId = await crearSolicitudDB(rfc, fechaInicial, fechaFinal);
      evento('Enviando solicitud de descarga a SAT...');
      satRequestId = await solicitarDescarga(rfc, token, fechaInicial, fechaFinal);
      evento(`Solicitud registrada: ${ocultarId(satRequestId)}`);
      await actualizarSolicitudDB(solicitudDbId, {
        sat_request_id: satRequestId,
        status: 'pendiente_sat',
      });
    }

    // 3. Polling de verificación — progresivo: 10s, 20s, 30s, luego 60s fijo
    evento('SAT está procesando la solicitud...');
    let verificacion;

    for (let intento = 0; intento < 20; intento++) {
      token = await tokenFresco(token);
      verificacion = await verificarSolicitud(rfc, token, satRequestId);

      const hora = new Date().toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      estadoLine(`SAT sigue procesando la solicitud. Última consulta: ${hora}`);

      if (verificacion.terminada) {
        evento('SAT terminó de procesar ✓');
        break;
      }

      // Error/rechazo definitivo del SAT
      const estadoNum = parseInt(verificacion.estadoSolicitud, 10);
      if (verificacion.error || [4, 5, 6].includes(estadoNum)) {
        const codigo  = verificacion.codEstadoSol ?? verificacion.codEstatus ?? estadoNum;
        const mensaje = verificacion.mensaje || `EstadoSolicitud=${estadoNum}`;
        await actualizarSolicitudDB(solicitudDbId, {
          status: 'fallida',
          error_code: String(codigo),
          error_message: mensaje,
          completed_at: new Date().toISOString(),
        });
        throw new Error(`SAT rechazó la solicitud [${codigo}]: ${mensaje}`);
      }

      // Esperar antes del siguiente poll (tiempo progresivo)
      if (intento < 19) await sleep(delayPoll(intento));
    }

    // Si no terminó en 20 polls → timeout no es error, SAT sigue procesando
    if (!verificacion?.terminada) {
      await actualizarSolicitudDB(solicitudDbId, { status: 'timeout' });
      evento('Solicitud registrada en SAT. Xabor continuará consultándola al reintentar.');
      return { ok: false, pendiente: true, satRequestId };
    }

    await actualizarSolicitudDB(solicitudDbId, {
      status: 'verificado',
      completed_at: new Date().toISOString(),
    });

    // 4. Descargar y procesar paquetes
    const resumen = { total: 0, nuevos: 0, duplicados: 0, errores: 0, paquetes: 0 };
    const tokenDescarga = await renovarToken();
    const total = verificacion.packageIds.length;

    for (let i = 0; i < total; i++) {
      const packageId = verificacion.packageIds[i];
      evento(`Descargando paquete ${i + 1}/${total}...`);
      const paqueteDbId = await crearPaqueteDB(solicitudDbId, packageId);
      try {
        const zipBuffer = await descargarPaquete(rfc, tokenDescarga, packageId);
        await actualizarPaqueteDB(paqueteDbId, {
          status: 'descargado',
          downloaded_at: new Date().toISOString(),
        });
        const r = await procesarPaquete(paqueteDbId, packageId, zipBuffer, rfc);
        resumen.total      += r.total;
        resumen.nuevos     += r.nuevos;
        resumen.duplicados += r.duplicados;
        resumen.errores    += r.errores;
        resumen.paquetes++;
        evento(`  → ${r.nuevos} nuevas, ${r.duplicados} duplicadas, ${r.errores} errores`);
      } catch (e) {
        await actualizarPaqueteDB(paqueteDbId, { status: 'error', error_message: e.message });
        evento(`  ✗ Error en paquete ${i + 1}: ${e.message}`);
        resumen.errores++;
      }
    }

    await actualizarSolicitudDB(solicitudDbId, { status: 'completado' });
    evento(`✓ Sincronización completa: ${resumen.nuevos} nuevas, ${resumen.duplicados} duplicadas, ${resumen.errores} errores`);
    return { ok: true, solicitudId: solicitudDbId, ...resumen };

  } catch (e) {
    if (solicitudDbId) {
      await actualizarSolicitudDB(solicitudDbId, {
        status: e.message?.includes('fallida') ? 'fallida' : 'error',
        error_message: e.message,
      }).catch(() => {});
    }
    throw e;
  }
}

// ─── Job diario automático ───────────────────────────────────────────────────
// Llama esto desde server.js en el cron de las 02:00 CST
export async function jobDiarioSAT() {
  try {
    const hoy = new Date();
    const inicio = new Date(hoy);
    inicio.setDate(inicio.getDate() - 7); // 7 días atrás para recuperar facturas tardías

    const fi = inicio.toISOString().split('T')[0] + 'T00:00:00';
    const ff = hoy.toISOString().split('T')[0] + 'T23:59:59';

    console.log(`[SAT Job] Sincronización diaria ${fi} → ${ff}`);
    await sincronizarRango(fi, ff);
  } catch (e) {
    console.error('[SAT Job] Error en sincronización diaria:', e.message);
  }
}

// ─── Obtener estado de la última sincronización ───────────────────────────────
export async function obtenerEstadoSync() {
  const { rows } = await pool.query(
    `SELECT r.*,
       COUNT(p.id) as total_paquetes,
       COUNT(CASE WHEN p.status = 'procesado' THEN 1 END) as paquetes_ok
     FROM sat_download_requests r
     LEFT JOIN sat_packages p ON p.download_request_id = r.id
     WHERE r.negocio_id = $1
     GROUP BY r.id
     ORDER BY r.requested_at DESC
     LIMIT 1`,
    [NEGOCIO_ID]
  );
  return rows[0] || null;
}

// ─── Listar facturas con filtros ──────────────────────────────────────────────
export async function listarFacturas({
  fechaDesde, fechaHasta, rfcEmisor, tipoComprobante,
  fiscalStatus, busqueda, page = 1, pageSize = 50
} = {}) {
  const conditions = [`i.negocio_id = $1`];
  const params = [NEGOCIO_ID];
  let idx = 2;

  if (fechaDesde)       { conditions.push(`i.fecha_emision >= $${idx++}`); params.push(fechaDesde); }
  if (fechaHasta)       { conditions.push(`i.fecha_emision <= $${idx++}`); params.push(fechaHasta); }
  if (rfcEmisor)        { conditions.push(`i.rfc_emisor ILIKE $${idx++}`); params.push(`%${rfcEmisor}%`); }
  if (tipoComprobante)  { conditions.push(`i.tipo_comprobante = $${idx++}`); params.push(tipoComprobante); }
  if (fiscalStatus)     { conditions.push(`i.fiscal_status = $${idx++}`); params.push(fiscalStatus); }
  if (busqueda) {
    conditions.push(`(i.uuid ILIKE $${idx} OR i.nombre_emisor ILIKE $${idx} OR i.rfc_emisor ILIKE $${idx} OR i.folio ILIKE $${idx})`);
    params.push(`%${busqueda}%`); idx++;
  }

  const where = conditions.join(' AND ');
  const offset = (page - 1) * pageSize;

  const [dataRes, countRes, sumsRes] = await Promise.all([
    pool.query(
      `SELECT id, uuid, fecha_emision, fecha_timbrado, rfc_emisor, nombre_emisor,
              subtotal, descuento, impuestos_trasladados, impuestos_retenidos, total,
              moneda, tipo_comprobante, metodo_pago, forma_pago, uso_cfdi,
              serie, folio, fiscal_status, imported_at
       FROM invoices i WHERE ${where}
       ORDER BY i.fecha_emision DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*) as total FROM invoices i WHERE ${where}`, params),
    pool.query(
      `SELECT
         COALESCE(SUM(total),0)                    as total_facturado,
         COALESCE(SUM(subtotal),0)                 as total_subtotal,
         COALESCE(SUM(impuestos_trasladados),0)     as total_iva,
         COALESCE(SUM(impuestos_retenidos),0)       as total_retenciones,
         COUNT(*)                                   as cantidad
       FROM invoices i WHERE ${where}`,
      params
    ),
  ]);

  return {
    facturas: dataRes.rows,
    total: parseInt(countRes.rows[0].total),
    page,
    pageSize,
    resumen: sumsRes.rows[0],
  };
}

// ─── Obtener detalle de una factura ──────────────────────────────────────────
export async function obtenerFactura(id) {
  const [inv, items] = await Promise.all([
    pool.query(`SELECT * FROM invoices WHERE id = $1 AND negocio_id = $2`, [id, NEGOCIO_ID]),
    pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [id]),
  ]);
  if (!inv.rows.length) return null;
  return { ...inv.rows[0], items: items.rows };
}

// ─── Obtener XML original de una factura ─────────────────────────────────────
export async function obtenerXmlFactura(id) {
  const { rows } = await pool.query(
    `SELECT xml_storage_path FROM invoices WHERE id = $1 AND negocio_id = $2`,
    [id, NEGOCIO_ID]
  );
  if (!rows.length || !rows[0].xml_storage_path) return null;
  const xmlPath = rows[0].xml_storage_path;
  if (!fs.existsSync(xmlPath)) return null;
  return fs.readFileSync(xmlPath, 'utf8');
}

// ─── Guardar / actualizar cuenta SAT ─────────────────────────────────────────
export async function guardarCuentaSAT({ rfc, certificateSerial, certificateExpiration }) {
  await pool.query(
    `INSERT INTO sat_accounts (negocio_id, rfc, certificate_serial, certificate_expiration, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (negocio_id, rfc) DO UPDATE SET
       certificate_serial = $3,
       certificate_expiration = $4,
       active = TRUE,
       updated_at = NOW()`,
    [NEGOCIO_ID, rfc.toUpperCase(), certificateSerial, certificateExpiration]
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
