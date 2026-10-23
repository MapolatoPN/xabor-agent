// CFDI del negocio: bitácora de quién hizo qué, y descarga o reenvío de un
// CFDI ya timbrado.
//
// Un CFDI se descarga o se reenvía solo si está registrado en ESTE negocio
// (ledger de ventas, recibos, servicios o autofacturas); el id que manda el
// navegador no basta.
import { pool } from './database.js';
import { descargarFacturaPDF, descargarFacturaXML, enviarFacturaPorEmail } from './facturapi.js';
import { FacturacionError } from './facturacionService.js';

const ID_FACTURA = /^[A-Za-z0-9_-]{6,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deja constancia de una acción de facturación. Nunca hace fallar la acción:
 * si la bitácora no se puede escribir, se avisa en el log y se sigue.
 */
export async function registrarBitacoraFacturacion({
  negocioId, usuarioId = null, rol = null, accion, folio = null, facturaId = null, detalle = {},
}, { db = pool } = {}) {
  if (!negocioId || !accion) return false;
  try {
    await db.query(
      `INSERT INTO facturacion_bitacora (negocio_id, usuario_id, rol, accion, folio, factura_id, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [negocioId, usuarioId ? String(usuarioId).slice(0, 80) : null, rol ? String(rol).slice(0, 40) : null,
        String(accion).slice(0, 60), folio ? String(folio).slice(0, 60) : null,
        facturaId ? String(facturaId).slice(0, 80) : null, JSON.stringify(detalle || {})]);
    return true;
  } catch (e) {
    console.error(`[Facturacion] bitácora sin escribir (${accion}): ${e.message}`);
    return false;
  }
}

/** Datos de quien hace la petición, para la bitácora. */
export function actorDe(req) {
  return { usuarioId: req?.usuarioId || null, rol: req?.rol || null };
}

export async function listarBitacoraFacturacion(negocioId, { limite = 100 } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limite, 10) || 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT accion, folio, factura_id, usuario_id, rol, detalle, created_at
       FROM facturacion_bitacora WHERE negocio_id=$1 ORDER BY created_at DESC LIMIT $2`, [negocioId, n]);
  return rows;
}

/** ¿El CFDI `facturaId` está registrado en este negocio? */
export async function cfdiDelNegocio(negocioId, facturaId) {
  const id = String(facturaId || '').trim();
  if (!negocioId || !ID_FACTURA.test(id)) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM facturas_pedido WHERE negocio_id=$1 AND factura_id=$2
     UNION ALL SELECT 1 FROM facturacion_recibos WHERE negocio_id=$1 AND factura_id=$2
     UNION ALL SELECT 1 FROM facturacion_servicios WHERE negocio_id=$1 AND factura_id=$2
     UNION ALL SELECT 1 FROM autofacturas WHERE negocio_id=$1 AND factura_id=$2
     LIMIT 1`, [negocioId, id]);
  return rows.length > 0;
}

async function exigirCfdiDelNegocio(negocioId, facturaId) {
  if (!(await cfdiDelNegocio(negocioId, facturaId))) {
    throw new FacturacionError('No encontramos ese CFDI en este negocio.', 'FACTURA_NO_ENCONTRADA', 404);
  }
}

export async function descargarCfdiDelNegocio(negocioId, facturaId, formato) {
  await exigirCfdiDelNegocio(negocioId, facturaId);
  return formato === 'xml' ? descargarFacturaXML(negocioId, facturaId) : descargarFacturaPDF(negocioId, facturaId);
}

/** Reenvía por correo un CFDI del negocio (lo manda Facturapi). */
export async function reenviarCfdiPorCorreo(negocioId, facturaId, email, actor = {}) {
  const correo = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(correo) || correo.length > 254) {
    throw new FacturacionError('Escribe un correo válido.', 'EMAIL_INVALIDO', 400);
  }
  await exigirCfdiDelNegocio(negocioId, facturaId);
  await enviarFacturaPorEmail(negocioId, facturaId, correo);
  await registrarBitacoraFacturacion({
    negocioId, ...actor, accion: 'reenviar_correo', facturaId,
    detalle: { dominio: correo.split('@')[1] },
  });
  return { enviado: true };
}

function enviarArchivo(res, buf, facturaId, formato) {
  res.setHeader('Content-Type', formato === 'xml' ? 'application/xml' : 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=factura-${facturaId}.${formato}`);
  res.send(Buffer.from(buf));
}

/**
 * Rutas de documentos. PDF también para la caja y Mesas (ya lo tenían); XML,
 * correo y bitácora solo para el admin.
 */
export function registrarRutasDocumentosFactura(app, { requireAdminSeguro, requireAuthSeguro, requireModulo, responderError }) {
  const admin = [requireAdminSeguro, requireModulo('facturacion')];
  const descargar = (formato) => async (req, res) => {
    try { enviarArchivo(res, await descargarCfdiDelNegocio(req.negocioId, req.params.facturaId, formato), req.params.facturaId, formato); }
    catch (e) { responderError(res, e); }
  };
  app.get('/api/facturacion/facturas/:facturaId/pdf', requireAuthSeguro, requireModulo('facturacion'), descargar('pdf'));
  app.get('/api/admin/factura/:facturaId/pdf', ...admin, descargar('pdf'));
  app.get('/api/admin/factura/:facturaId/xml', ...admin, descargar('xml'));
  app.post('/api/admin/factura/:facturaId/correo', ...admin, async (req, res) => {
    try { res.json({ ok: true, ...(await reenviarCfdiPorCorreo(req.negocioId, req.params.facturaId, req.body?.email, actorDe(req))) }); }
    catch (e) { responderError(res, e); }
  });
  app.get('/api/admin/facturacion/bitacora', ...admin, async (req, res) => {
    try { res.json({ ok: true, bitacora: await listarBitacoraFacturacion(req.negocioId, { limite: req.query.limite }) }); }
    catch (e) { responderError(res, e); }
  });
}
