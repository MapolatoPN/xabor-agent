/**
 * finanzas.js — Rutas REST de Xabor Finanzas (descarga de CFDI recibidos del SAT)
 * Montado en /api/finanzas con requireAdminSeguro + requireModulo('facturacion'):
 * todo es del negocio de la sesión (req.negocioId).
 */

import { Router } from 'express';
import {
  sincronizarRango,
  obtenerEstadoSync,
  listarFacturas,
  obtenerFactura,
  obtenerXmlFactura,
  guardarCuentaSAT,
  obtenerRfcNegocio,
  ventanaDeAyer,
  validarVentana,
} from '../services/satSync.js';
import { validarCertificado } from '../services/satClient.js';
import { pool } from '../services/database.js';

const router = Router();

// Bitácora de la sincronización manual, POR NEGOCIO (en memoria del proceso).
const syncs = new Map(); // negocioId -> { enCurso, log, estado, resultado }
const syncDe = (negocioId) => {
  if (!syncs.has(negocioId)) syncs.set(negocioId, { enCurso: false, log: [], estado: null, resultado: null });
  return syncs.get(negocioId);
};

// ─── GET /api/finanzas/estado ─────────────────────────────────────────────────
router.get('/estado', async (req, res) => {
  try {
    const ultima = await obtenerEstadoSync(req.negocioId);
    const cuenta = await pool.query(
      `SELECT rfc, certificate_serial, certificate_expiration, active, updated_at
         FROM sat_accounts WHERE negocio_id = $1 AND active = TRUE ORDER BY id DESC LIMIT 1`, [req.negocioId]);
    res.json({ cuenta: cuenta.rows[0] || null, ultimaSync: ultima, syncEnCurso: syncDe(req.negocioId).enCurso });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/finanzas/sync ──────────────────────────────────────────────────
// Body: { fechaInicial, fechaFinal } en AAAA-MM-DDTHH:MM:SS. Sin fechas: el día
// anterior completo. Solo pide al SAT la ventana y verifica una vez; lo que
// tarde lo termina el tick de cada 15 min.
router.post('/sync', async (req, res) => {
  const s = syncDe(req.negocioId);
  if (s.enCurso) return res.status(409).json({ error: 'Ya hay una sincronización en curso' });
  let { fechaInicial, fechaFinal } = req.body || {};
  if (!fechaInicial || !fechaFinal) ({ fechaInicial, fechaFinal } = ventanaDeAyer());
  try { validarVentana(fechaInicial, fechaFinal); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  Object.assign(s, { enCurso: true, log: [`Iniciando sincronización ${fechaInicial} → ${fechaFinal}`], estado: null, resultado: null });
  res.json({ ok: true, mensaje: 'Sincronización iniciada', fechaInicial, fechaFinal });

  sincronizarRango(req.negocioId, fechaInicial, fechaFinal, {
    onProgress: (msg) => { s.log.push(msg); if (s.log.length > 150) s.log.shift(); },
  })
    .then((r) => { s.resultado = { ok: r.ok, pendiente: r.pendiente, nuevas: r.verificacion?.nuevas || 0 }; })
    .catch((e) => { s.resultado = { ok: false, error: e.message }; s.log.push(`✗ Error: ${e.message}`); })
    .finally(() => { s.enCurso = false; s.estado = null; });
});

// ─── GET /api/finanzas/sync/log ───────────────────────────────────────────────
router.get('/sync/log', (req, res) => {
  const s = syncDe(req.negocioId);
  res.json({ enCurso: s.enCurso, log: s.log, estado: s.estado, resultado: s.resultado });
});

// ─── GET /api/finanzas/facturas ───────────────────────────────────────────────
router.get('/facturas', async (req, res) => {
  try {
    const { desde, hasta, emisor, tipo, status, q, page, size } = req.query;
    res.json(await listarFacturas(req.negocioId, {
      fechaDesde: desde, fechaHasta: hasta, rfcEmisor: emisor, tipoComprobante: tipo,
      fiscalStatus: status, busqueda: q, page: parseInt(page, 10) || 1, pageSize: parseInt(size, 10) || 50,
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/finanzas/facturas/:id ──────────────────────────────────────────
router.get('/facturas/:id', async (req, res) => {
  try {
    const factura = await obtenerFactura(req.negocioId, parseInt(req.params.id, 10));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json(factura);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/finanzas/facturas/:id/xml ──────────────────────────────────────
router.get('/facturas/:id/xml', async (req, res) => {
  try {
    const xml = await obtenerXmlFactura(req.negocioId, parseInt(req.params.id, 10));
    if (!xml) return res.status(404).json({ error: 'XML no encontrado' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/finanzas/cuenta ────────────────────────────────────────────────
// Registra la cuenta SAT del negocio con el RFC de SU e.firma (Facturación ›
// e.firma SAT). Si se manda un RFC, debe coincidir con el certificado.
router.post('/cuenta', async (req, res) => {
  try {
    const rfc = String(req.body?.rfc || '').trim().toUpperCase() || await obtenerRfcNegocio(req.negocioId);
    const { expiration } = await validarCertificado(req.negocioId, rfc);
    await guardarCuentaSAT(req.negocioId, { rfc, certificateExpiration: expiration });
    res.json({ ok: true, rfc, expiration });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── GET /api/finanzas/cuenta/validar ────────────────────────────────────────
router.get('/cuenta/validar', async (req, res) => {
  try {
    const rfc = await obtenerRfcNegocio(req.negocioId);
    res.json({ valido: true, rfc, ...(await validarCertificado(req.negocioId, rfc)) });
  } catch (e) {
    res.json({ valido: false, mensaje: e.message });
  }
});

export default router;
