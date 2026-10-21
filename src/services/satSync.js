/**
 * satSync.js — Descarga masiva de CFDI RECIBIDOS del SAT, por negocio.
 *
 * Ciclo de vida de una solicitud (sat_download_requests.status):
 *   solicitando → pendiente_sat → (verificado) → completado | sin_datos
 *   y los finales de error: error, fallida, rechazada, agotada (5002),
 *   duplicada (5005), vencida (72 h sin terminar).
 *
 * No hay espera larga en proceso: el SAT tarda horas. Cada tick (cada 15 min,
 * server.js) verifica una vez las solicitudes vivas de cada negocio con
 * e.firma, descarga las terminadas y, una vez al día, pide el día anterior
 * completo. Una ventana ya pedida no se vuelve a pedir: el SAT limita las
 * solicitudes repetidas del mismo periodo. El código y el mensaje del SAT
 * siempre quedan guardados. El XML de cada CFDI se guarda en la base; el
 * disco de Railway se borra en cada despliegue.
 */

import fs from 'fs';
import { pool } from './database.js';
import {
  autenticar, solicitarDescarga, verificarSolicitud, descargarPaquete,
  extraerXmlsDeZip, parsearCFDI, validarCertificado,
} from './satClient.js';

const ZONA = 'America/Matamoros';
const VIDA_SOLICITUD_H = 72;
const VIVAS = ['solicitando', 'pendiente_sat', 'verificado', 'timeout'];
// Una ventana con alguno de estos estados ya no se vuelve a pedir.
const NO_REPETIR = ['pendiente_sat', 'verificado', 'completado', 'sin_datos', 'agotada', 'duplicada'];

function exigirNegocio(negocioId, fn) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error(`${fn}: negocioId requerido`);
  return negocioId.trim();
}

// ─── Máscaras para logs ──────────────────────────────────────────────────────
function enmascarar(texto) {
  if (!texto) return texto;
  return String(texto)
    .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => m.slice(0, 8) + '…')
    .replace(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/g, (m) => m.slice(0, 3) + '***' + m.slice(-3));
}

// ─── Fechas: ventanas en hora del negocio ────────────────────────────────────
const FECHA_SAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
export function validarVentana(fechaInicial, fechaFinal) {
  if (!FECHA_SAT.test(String(fechaInicial)) || !FECHA_SAT.test(String(fechaFinal))) {
    throw Object.assign(new Error('Las fechas deben tener el formato AAAA-MM-DDTHH:MM:SS.'), { codigo: 'FECHA_INVALIDA' });
  }
  if (!(fechaInicial < fechaFinal)) throw Object.assign(new Error('La fecha inicial debe ser anterior a la final.'), { codigo: 'FECHA_INVALIDA' });
}
function fechaLocal(instante) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(instante).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}
/** El día anterior completo, en hora del negocio. */
export function ventanaDeAyer(ahora = new Date()) {
  const { fecha } = fechaLocal(new Date(ahora.getTime() - 24 * 3600 * 1000));
  return { fechaInicial: `${fecha}T00:00:00`, fechaFinal: `${fecha}T23:59:59` };
}

// ─── RFC del negocio: el de su e.firma ───────────────────────────────────────
export async function obtenerRfcNegocio(negocioId) {
  const nid = exigirNegocio(negocioId, 'obtenerRfcNegocio');
  const { rows: [info] } = await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id::text=$1 AND clave='sat_cert_info'`, [nid]);
  let rfc = null;
  try { rfc = JSON.parse(info?.valor || 'null')?.rfc || null; } catch { rfc = null; }
  if (!rfc) {
    const { rows: [cta] } = await pool.query(
      `SELECT rfc FROM sat_accounts WHERE negocio_id=$1 AND active=TRUE ORDER BY id DESC LIMIT 1`, [nid]);
    rfc = cta?.rfc || null;
  }
  if (!rfc) throw Object.assign(new Error('Este negocio no tiene e.firma con RFC cargada.'), { codigo: 'EFIRMA_NO_CONFIGURADA' });
  return String(rfc).toUpperCase();
}

// ─── Persistencia ────────────────────────────────────────────────────────────
async function actualizarSolicitud(id, campos) {
  const claves = Object.keys(campos);
  const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE sat_download_requests SET ${sets}${sets ? ', ' : ''}last_checked_at = NOW() WHERE id = $1`,
    [id, ...claves.map((k) => campos[k])]);
}

async function crearPaquete(solicitudId, packageId) {
  const { rows } = await pool.query(
    `INSERT INTO sat_packages (download_request_id, sat_package_id, status) VALUES ($1, $2, 'pendiente')
     ON CONFLICT (sat_package_id) DO UPDATE SET download_request_id = $1 RETURNING id, status`, [solicitudId, packageId]);
  return rows[0];
}
async function actualizarPaquete(id, campos) {
  const claves = Object.keys(campos);
  await pool.query(`UPDATE sat_packages SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...claves.map((k) => campos[k])]);
}

async function guardarFactura(negocioId, cfdi, xml) {
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
         xml, source, imported_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'vigente',$24,'sat_descarga',NOW())
       ON CONFLICT (negocio_id, uuid) DO UPDATE SET xml = COALESCE(invoices.xml, EXCLUDED.xml)
       RETURNING id, (xmax = 0) AS nueva`,
      [negocioId, cfdi.uuid, cfdi.version_cfdi, cfdi.fecha_emision, cfdi.fecha_timbrado,
        cfdi.rfc_emisor, cfdi.nombre_emisor, cfdi.rfc_receptor, cfdi.nombre_receptor,
        cfdi.subtotal, cfdi.descuento, cfdi.impuestos_trasladados, cfdi.impuestos_retenidos,
        cfdi.total, cfdi.moneda, cfdi.tipo_cambio, cfdi.tipo_comprobante,
        cfdi.metodo_pago, cfdi.forma_pago, cfdi.uso_cfdi, cfdi.serie, cfdi.folio, cfdi.exportacion, xml]);
    const fila = rows[0];
    if (fila.nueva && cfdi.items?.length) {
      for (const item of cfdi.items) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, clave_prod_serv, no_identificacion, descripcion,
             cantidad, clave_unidad, unidad, valor_unitario, importe, descuento, objeto_impuesto)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [fila.id, item.clave_prod_serv, item.no_identificacion, item.descripcion, item.cantidad,
            item.clave_unidad, item.unidad, item.valor_unitario, item.importe, item.descuento, item.objeto_impuesto]);
      }
    }
    await client.query('COMMIT');
    return fila.nueva;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function procesarPaquete(negocioId, paqueteDbId, zipBuffer) {
  let xmls;
  try { xmls = await extraerXmlsDeZip(zipBuffer); }
  catch (e) { await actualizarPaquete(paqueteDbId, { status: 'error', error_message: e.message }); throw e; }
  let nuevos = 0, duplicados = 0, errores = 0;
  for (const { nombre, xml } of xmls) {
    try {
      const cfdi = parsearCFDI(xml);
      if (!cfdi.uuid) { errores++; continue; }
      if (await guardarFactura(negocioId, cfdi, xml)) nuevos++; else duplicados++;
    } catch (e) {
      console.error(`[SAT] Error procesando ${nombre}:`, e.message);
      errores++;
    }
  }
  await actualizarPaquete(paqueteDbId, {
    status: xmls.length && errores === xmls.length ? 'error' : 'procesado',
    processed_at: new Date().toISOString(),
    error_message: errores ? `${errores} errores de ${xmls.length}` : null,
  });
  return { total: xmls.length, nuevos, duplicados, errores };
}

// ─── Pedir una ventana (una sola vez) ────────────────────────────────────────
const ESTADO_POR_CODIGO = { '5002': 'agotada', '5004': 'sin_datos', '5005': 'duplicada' };

export async function solicitarVentana(negocioId, fechaInicial, fechaFinal, { rfc, token }) {
  const nid = exigirNegocio(negocioId, 'solicitarVentana');
  validarVentana(fechaInicial, fechaFinal);
  const { rows: [previa] } = await pool.query(
    `SELECT id, status, sat_request_id FROM sat_download_requests
      WHERE negocio_id=$1 AND download_type='recibidos' AND fecha_inicial=$2 AND fecha_final=$3
        AND (status = ANY($4) OR (status='timeout' AND requested_at > NOW() - make_interval(hours => $5)))
      ORDER BY requested_at DESC LIMIT 1`, [nid, fechaInicial, fechaFinal, NO_REPETIR, VIDA_SOLICITUD_H]);
  if (previa) return { solicitudId: previa.id, estado: previa.status, nueva: false };

  const { rows: [fila] } = await pool.query(
    `INSERT INTO sat_download_requests (negocio_id, fecha_inicial, fecha_final, download_type, tipo_solicitud, status, requested_at)
     VALUES ($1,$2,$3,'recibidos','CFDI','solicitando',NOW()) RETURNING id`, [nid, fechaInicial, fechaFinal]);
  try {
    const id = await solicitarDescarga(nid, rfc, token, fechaInicial, fechaFinal);
    await actualizarSolicitud(fila.id, { sat_request_id: id, status: 'pendiente_sat', cod_estatus: '5000', mensaje: 'Solicitud aceptada' });
    return { solicitudId: fila.id, estado: 'pendiente_sat', nueva: true };
  } catch (e) {
    const estado = (e.codEstatus && ESTADO_POR_CODIGO[e.codEstatus]) || 'error';
    await actualizarSolicitud(fila.id, {
      status: estado, cod_estatus: e.codEstatus || null, mensaje: e.mensajeSat || null,
      error_code: String(e.codEstatus || e.codigo || 'ERROR'), error_message: enmascarar(e.message || 'sin detalle'),
      completed_at: new Date().toISOString(),
    });
    return { solicitudId: fila.id, estado, nueva: true, error: e.message };
  }
}

// ─── Verificar las solicitudes vivas (una consulta cada una) ────────────────
export async function verificarPendientes(negocioId, { rfc, token }) {
  const nid = exigirNegocio(negocioId, 'verificarPendientes');
  // Lo que pasó de 72 h sin terminar ya no se puede descargar.
  await pool.query(
    `UPDATE sat_download_requests SET status='vencida', completed_at=NOW(), last_checked_at=NOW(),
       mensaje=COALESCE(mensaje,'Sin terminar en 72 h')
     WHERE negocio_id=$1 AND status = ANY($2) AND requested_at <= NOW() - make_interval(hours => $3)`,
    [nid, VIVAS, VIDA_SOLICITUD_H]);
  const { rows } = await pool.query(
    `SELECT id, sat_request_id FROM sat_download_requests
      WHERE negocio_id=$1 AND status = ANY($2) AND sat_request_id IS NOT NULL
      ORDER BY requested_at ASC LIMIT 20`, [nid, ['pendiente_sat', 'verificado', 'timeout']]);
  const resumen = { revisadas: rows.length, completadas: 0, pendientes: 0, errores: 0, nuevas: 0 };
  for (const s of rows) {
    let v;
    try { v = await verificarSolicitud(nid, rfc, token, s.sat_request_id); }
    catch (e) {
      // Red o HTTP: se reintenta en el siguiente tick.
      await pool.query(`UPDATE sat_download_requests SET intentos=intentos+1, error_code=$2, error_message=$3, last_checked_at=NOW() WHERE id=$1`,
        [s.id, String(e.codigo || 'RED'), enmascarar(e.message || 'sin detalle')]);
      resumen.errores++;
      continue;
    }
    const base = { cod_estatus: v.codEstatus, mensaje: v.mensaje, estado_solicitud: v.estadoSolicitud, numero_cfdis: v.numCfdis };
    if (!v.aceptada) {
      // CodEstatus distinto de 5000: el SAT no aceptó la verificación (credencial, solicitud inexistente...).
      await actualizarSolicitud(s.id, { ...base, status: 'error', error_code: String(v.codEstatus || 'SIN_CODIGO'), error_message: v.mensaje || 'Verificación no aceptada', completed_at: new Date().toISOString() });
      resumen.errores++;
      continue;
    }
    if (v.estadoSolicitud === '1' || v.estadoSolicitud === '2') {
      await actualizarSolicitud(s.id, { ...base, status: 'pendiente_sat' });
      resumen.pendientes++;
      continue;
    }
    if (v.estadoSolicitud !== '3') {
      const estado = v.codEstadoSol === '5004' ? 'sin_datos' : ({ '4': 'error', '5': 'rechazada', '6': 'vencida' }[v.estadoSolicitud] || 'error');
      await actualizarSolicitud(s.id, { ...base, status: estado, error_code: estado === 'sin_datos' ? null : String(v.codEstadoSol || v.estadoSolicitud), error_message: estado === 'sin_datos' ? null : (v.mensaje || null), completed_at: new Date().toISOString() });
      if (estado === 'sin_datos') resumen.completadas++; else resumen.errores++;
      continue;
    }
    // Terminada: descargar cada paquete.
    if (!v.packageIds.length) {
      await actualizarSolicitud(s.id, { ...base, status: 'sin_datos', completed_at: new Date().toISOString() });
      resumen.completadas++;
      continue;
    }
    await actualizarSolicitud(s.id, { ...base, status: 'verificado' });
    let fallo = null;
    for (const packageId of v.packageIds) {
      const paquete = await crearPaquete(s.id, packageId);
      if (paquete.status === 'procesado') continue;
      try {
        const zip = await descargarPaquete(nid, rfc, token, packageId);
        await actualizarPaquete(paquete.id, { status: 'descargado', downloaded_at: new Date().toISOString() });
        const r = await procesarPaquete(nid, paquete.id, zip);
        resumen.nuevas += r.nuevos;
      } catch (e) {
        fallo = e;
        await actualizarPaquete(paquete.id, { status: 'error', error_message: enmascarar(e.message || 'sin detalle') });
      }
    }
    if (fallo) {
      // Se queda 'verificado': el siguiente tick reintenta lo que falte.
      await actualizarSolicitud(s.id, { error_code: String(fallo.codEstatus || fallo.codigo || 'DESCARGA'), error_message: enmascarar(fallo.message) });
      resumen.errores++;
    } else {
      await actualizarSolicitud(s.id, { status: 'completado', error_code: null, error_message: null, completed_at: new Date().toISOString() });
      resumen.completadas++;
    }
  }
  return resumen;
}

// ─── Un negocio, bajo candado (un solo proceso a la vez por negocio) ─────────
async function conCandado(negocioId, fn) {
  const client = await pool.connect();
  try {
    const { rows: [l] } = await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [`sat-sync:${negocioId}`]);
    if (!l.ok) return { ocupado: true };
    try { return await fn(); }
    finally { await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`sat-sync:${negocioId}`]).catch(() => {}); }
  } finally {
    client.release();
  }
}

export async function sincronizarNegocio(negocioId, { pedirAyer = true, ahora = new Date() } = {}) {
  const nid = exigirNegocio(negocioId, 'sincronizarNegocio');
  return conCandado(nid, async () => {
    const rfc = await obtenerRfcNegocio(nid);
    await validarCertificado(nid, rfc);
    const token = await autenticar(nid, rfc);
    const verificacion = await verificarPendientes(nid, { rfc, token });
    let solicitud = null;
    // El día anterior, después de las 02:00 locales (timbrados tardíos del cierre).
    if (pedirAyer && fechaLocal(ahora).hora >= 2) {
      const { fechaInicial, fechaFinal } = ventanaDeAyer(ahora);
      solicitud = await solicitarVentana(nid, fechaInicial, fechaFinal, { rfc, token });
    }
    return { verificacion, solicitud };
  });
}

/** Tick periódico (server.js, cada 15 min): todos los negocios con e.firma. */
export async function tickSAT({ ahora = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT negocio_id::text AS negocio_id FROM configuracion WHERE clave='sat_cert_base64_db' AND negocio_id IS NOT NULL`);
  const resultados = {};
  for (const { negocio_id } of rows) {
    try { resultados[negocio_id] = await sincronizarNegocio(negocio_id, { ahora }); }
    catch (e) {
      resultados[negocio_id] = { error: e.codigo || e.message };
      console.error(`[SAT] negocio ${negocio_id.slice(0, 8)}…: ${enmascarar(e.message)}`);
    }
  }
  return resultados;
}

/** Sincronización manual desde Finanzas: pide la ventana y verifica una vez. */
export async function sincronizarRango(negocioId, fechaInicial, fechaFinal, { onProgress } = {}) {
  const nid = exigirNegocio(negocioId, 'sincronizarRango');
  validarVentana(fechaInicial, fechaFinal);
  const evento = (msg) => onProgress?.(enmascarar(msg), 'evento');
  const r = await conCandado(nid, async () => {
    const rfc = await obtenerRfcNegocio(nid);
    await validarCertificado(nid, rfc);
    evento('e.firma vigente ✓');
    const token = await autenticar(nid, rfc);
    evento('Autenticado con el SAT ✓');
    const s = await solicitarVentana(nid, fechaInicial, fechaFinal, { rfc, token });
    evento(s.nueva ? `Solicitud ${s.estado === 'pendiente_sat' ? 'registrada en el SAT' : `no aceptada (${s.estado})`}` : `Esa ventana ya estaba solicitada (${s.estado})`);
    const v = await verificarPendientes(nid, { rfc, token });
    return { solicitud: s, verificacion: v };
  });
  if (r.ocupado) throw Object.assign(new Error('Ya hay una sincronización en curso para este negocio.'), { codigo: 'SYNC_EN_CURSO' });
  const pendiente = r.verificacion.pendientes > 0 || r.solicitud.estado === 'pendiente_sat';
  if (pendiente) evento('El SAT sigue procesando; Xabor la revisa cada 15 minutos.');
  return { ok: !pendiente, pendiente, ...r };
}

// ─── Consultas del panel ─────────────────────────────────────────────────────
export async function obtenerEstadoSync(negocioId) {
  const nid = exigirNegocio(negocioId, 'obtenerEstadoSync');
  const { rows } = await pool.query(
    `SELECT r.*, COUNT(p.id) AS total_paquetes, COUNT(CASE WHEN p.status = 'procesado' THEN 1 END) AS paquetes_ok
       FROM sat_download_requests r LEFT JOIN sat_packages p ON p.download_request_id = r.id
      WHERE r.negocio_id = $1 GROUP BY r.id ORDER BY r.requested_at DESC LIMIT 1`, [nid]);
  return rows[0] || null;
}

export async function listarFacturas(negocioId, {
  fechaDesde, fechaHasta, rfcEmisor, tipoComprobante, fiscalStatus, busqueda, page = 1, pageSize = 50,
} = {}) {
  const nid = exigirNegocio(negocioId, 'listarFacturas');
  const conditions = ['i.negocio_id = $1'];
  const params = [nid];
  let idx = 2;
  if (fechaDesde) { conditions.push(`i.fecha_emision >= $${idx++}`); params.push(fechaDesde); }
  if (fechaHasta) { conditions.push(`i.fecha_emision <= $${idx++}`); params.push(fechaHasta); }
  if (rfcEmisor) { conditions.push(`i.rfc_emisor ILIKE $${idx++}`); params.push(`%${rfcEmisor}%`); }
  if (tipoComprobante) { conditions.push(`i.tipo_comprobante = $${idx++}`); params.push(tipoComprobante); }
  if (fiscalStatus) { conditions.push(`i.fiscal_status = $${idx++}`); params.push(fiscalStatus); }
  if (busqueda) {
    conditions.push(`(i.uuid ILIKE $${idx} OR i.nombre_emisor ILIKE $${idx} OR i.rfc_emisor ILIKE $${idx} OR i.folio ILIKE $${idx})`);
    params.push(`%${busqueda}%`); idx++;
  }
  const where = conditions.join(' AND ');
  const tam = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * tam;
  const [dataRes, countRes, sumsRes] = await Promise.all([
    pool.query(
      `SELECT id, uuid, fecha_emision, fecha_timbrado, rfc_emisor, nombre_emisor,
              subtotal, descuento, impuestos_trasladados, impuestos_retenidos, total,
              moneda, tipo_comprobante, metodo_pago, forma_pago, uso_cfdi,
              serie, folio, fiscal_status, imported_at
         FROM invoices i WHERE ${where} ORDER BY i.fecha_emision DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, tam, offset]),
    pool.query(`SELECT COUNT(*) AS total FROM invoices i WHERE ${where}`, params),
    pool.query(
      `SELECT COALESCE(SUM(total),0) AS total_facturado, COALESCE(SUM(subtotal),0) AS total_subtotal,
              COALESCE(SUM(impuestos_trasladados),0) AS total_iva, COALESCE(SUM(impuestos_retenidos),0) AS total_retenciones,
              COUNT(*) AS cantidad
         FROM invoices i WHERE ${where}`, params),
  ]);
  return { facturas: dataRes.rows, total: parseInt(countRes.rows[0].total, 10), page, pageSize: tam, resumen: sumsRes.rows[0] };
}

export async function obtenerFactura(negocioId, id) {
  const nid = exigirNegocio(negocioId, 'obtenerFactura');
  const inv = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND negocio_id = $2`, [id, nid]);
  if (!inv.rows.length) return null;
  const items = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [id]);
  const { xml, xml_storage_path: ruta, ...factura } = inv.rows[0];
  return { ...factura, tiene_xml: Boolean(xml || ruta), items: items.rows };
}

/** XML de la base; las facturas viejas pueden tenerlo solo en disco. */
export async function obtenerXmlFactura(negocioId, id) {
  const nid = exigirNegocio(negocioId, 'obtenerXmlFactura');
  const { rows } = await pool.query(`SELECT xml, xml_storage_path FROM invoices WHERE id = $1 AND negocio_id = $2`, [id, nid]);
  if (!rows.length) return null;
  if (rows[0].xml) return rows[0].xml;
  const ruta = rows[0].xml_storage_path;
  return ruta && fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : null;
}

export async function guardarCuentaSAT(negocioId, { rfc, certificateSerial = null, certificateExpiration = null }) {
  const nid = exigirNegocio(negocioId, 'guardarCuentaSAT');
  await pool.query(
    `INSERT INTO sat_accounts (negocio_id, rfc, certificate_serial, certificate_expiration, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (negocio_id, rfc) DO UPDATE SET certificate_serial = $3, certificate_expiration = $4, active = TRUE, updated_at = NOW()`,
    [nid, String(rfc).toUpperCase(), certificateSerial, certificateExpiration]);
}
