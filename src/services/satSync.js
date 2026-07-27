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
       (negocio_id, fecha_inicial, fecha_final, download_type, status, requested_at)
     VALUES ($1, $2, $3, 'recibidos', 'pendiente', NOW())
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

// ─── FLUJO PRINCIPAL: sincronizar un rango de fechas ────────────────────────
export async function sincronizarRango(fechaInicial, fechaFinal, { onProgress } = {}) {
  const log = (msg) => {
    console.log(`[SAT Sync] ${msg}`);
    onProgress?.(msg);
  };

  const rfc = await obtenerRfcActivo();
  log(`RFC: ${rfc} | ${fechaInicial} → ${fechaFinal}`);

  // Validar certificado
  validarCertificado(rfc);
  log('Certificado válido ✓');

  // Crear registro de solicitud
  const solicitudDbId = await crearSolicitudDB(rfc, fechaInicial, fechaFinal);

  try {
    // 1. Autenticar
    log('Autenticando con e.firma...');
    const token = await autenticar(rfc, { onDiag: log });
    log('Token obtenido ✓');

    // 2. Solicitar
    log('Enviando solicitud de descarga...');
    const satRequestId = await solicitarDescarga(rfc, token, fechaInicial, fechaFinal);
    log(`Solicitud aceptada: ${satRequestId}`);
    await actualizarSolicitudDB(solicitudDbId, { sat_request_id: satRequestId, status: 'solicitado' });

    // 3. Verificar con polling (hasta 30 intentos, cada 60s = 30 min máx)
    log('Verificando estado... (puede tardar varios minutos)');
    let verificacion;
    for (let intento = 0; intento < 30; intento++) {
      // Re-autenticar si el token venció (5 min)
      const tokenActual = intento > 0 ? await autenticar(rfc) : token;

      verificacion = await verificarSolicitud(rfc, tokenActual, satRequestId);
      log(`Estado: ${verificacion.estadoSolicitud} | Paquetes: ${verificacion.packageIds.length} | CFDIs: ${verificacion.numCfdis}`);

      if (verificacion.terminada) break;
      if (verificacion.error) {
        await actualizarSolicitudDB(solicitudDbId, {
          status: 'error',
          error_code: verificacion.codEstatus,
          error_message: verificacion.mensaje,
          completed_at: new Date().toISOString(),
        });
        throw new Error(`SAT error en solicitud: ${verificacion.mensaje}`);
      }

      await sleep(60000); // esperar 60 segundos antes del siguiente check
    }

    if (!verificacion?.terminada) {
      await actualizarSolicitudDB(solicitudDbId, { status: 'timeout' });
      throw new Error('Tiempo de espera agotado. La solicitud puede seguir procesándose en SAT.');
    }

    await actualizarSolicitudDB(solicitudDbId, {
      status: 'verificado',
      completed_at: new Date().toISOString(),
    });

    // 4. Descargar y procesar cada paquete
    const resumen = { total: 0, nuevos: 0, duplicados: 0, errores: 0, paquetes: 0 };
    // Re-autenticar para las descargas
    const tokenDescarga = await autenticar(rfc);

    for (const packageId of verificacion.packageIds) {
      log(`Descargando paquete ${packageId}...`);
      const paqueteDbId = await crearPaqueteDB(solicitudDbId, packageId);

      try {
        const zipBuffer = await descargarPaquete(rfc, tokenDescarga, packageId);
        await actualizarPaqueteDB(paqueteDbId, {
          status: 'descargado',
          downloaded_at: new Date().toISOString(),
        });

        log(`Procesando paquete ${packageId}...`);
        const r = await procesarPaquete(paqueteDbId, packageId, zipBuffer, rfc);
        resumen.total      += r.total;
        resumen.nuevos     += r.nuevos;
        resumen.duplicados += r.duplicados;
        resumen.errores    += r.errores;
        resumen.paquetes++;
        log(`  → ${r.nuevos} nuevos, ${r.duplicados} duplicados, ${r.errores} errores`);
      } catch (e) {
        await actualizarPaqueteDB(paqueteDbId, { status: 'error', error_message: e.message });
        log(`  ✗ Error en paquete ${packageId}: ${e.message}`);
        resumen.errores++;
      }
    }

    await actualizarSolicitudDB(solicitudDbId, { status: 'completado' });
    log(`✓ Sync completada: ${resumen.nuevos} nuevas, ${resumen.duplicados} duplicadas, ${resumen.errores} errores`);
    return { ok: true, solicitudId: solicitudDbId, ...resumen };

  } catch (e) {
    await actualizarSolicitudDB(solicitudDbId, {
      status: 'error',
      error_message: e.message,
    }).catch(() => {});
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
