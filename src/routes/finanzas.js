/**
 * finanzas.js — Rutas REST para Xabor Finanzas (módulo SAT)
 * Montado en /api/finanzas — solo admin
 */

import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import {
  sincronizarRango,
  jobDiarioSAT,
  obtenerEstadoSync,
  listarFacturas,
  obtenerFactura,
  obtenerXmlFactura,
  guardarCuentaSAT,
} from '../services/satSync.js';
import { validarCertificado, cargarCertificado } from '../services/satClient.js';
import { pool } from '../services/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// Estado de sync activo (en memoria, suficiente para un tenant)
let syncEnCurso = false;
let syncLog     = [];

// ─── Diagnóstico de endpoints SAT activos (temporal) ─────────────────────────
router.get('/debug-network', async (req, res) => {
  const { SAT_ENDPOINTS } = await import('../services/sat-endpoints.js');
  const result = { timestamp: new Date().toISOString(), endpoints_configurados: SAT_ENDPOINTS };

  const httpProbe = (url) => new Promise((ok) => {
    const t0 = Date.now();
    const r2 = https.request(url, { method: 'HEAD', timeout: 12000 }, (resp) => {
      ok({ status: resp.statusCode, ms: Date.now() - t0 });
      resp.resume();
    });
    r2.on('timeout', () => { r2.destroy(); ok({ error: 'TIMEOUT', ms: Date.now() - t0 }); });
    r2.on('error', (e) => ok({ error: e.code || e.message, ms: Date.now() - t0 }));
    r2.end();
  });

  result.http_probes = {};
  for (const [k, url] of Object.entries(SAT_ENDPOINTS)) {
    result.http_probes[k] = await httpProbe(url);
  }

  res.json(result);
});

// ─── Diagnóstico temporal (eliminar después) ──────────────────────────────────
router.get('/debug-cert', (req, res) => {
  const raw64 = process.env.SAT_CERT_BASE64 || '';
  if (!raw64) return res.json({ error: 'SAT_CERT_BASE64 no está configurada' });
  const clean = raw64.replace(/\s+/g, '');
  const buf = Buffer.from(clean, 'base64');
  const preview = buf.slice(0, 50).toString('utf8');
  const hexPreview = buf.slice(0, 10).toString('hex');
  res.json({
    envVarLength: raw64.length,
    cleanLength: clean.length,
    bufferLength: buf.length,
    previewUtf8: preview,
    previewHex: hexPreview,
    looksLikePem: preview.trim().startsWith('-----BEGIN'),
    looksLikeDer: buf[0] === 0x30,
  });
});

// ─── Middleware: solo admin ───────────────────────────────────────────────────
// requireAdmin se pasa desde server.js al montar el router

// ─── GET /api/finanzas/estado ─────────────────────────────────────────────────
router.get('/estado', async (req, res) => {
  try {
    const ultima = await obtenerEstadoSync();
    const cuenta = await pool.query(
      `SELECT rfc, certificate_serial, certificate_expiration, active, updated_at
       FROM sat_accounts WHERE negocio_id = 'default' AND active = TRUE LIMIT 1`
    );
    res.json({
      cuenta:       cuenta.rows[0] || null,
      ultimaSync:   ultima,
      syncEnCurso,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/finanzas/sync ──────────────────────────────────────────────────
// Body: { fechaInicial, fechaFinal } — ambos ISO8601
router.post('/sync', async (req, res) => {
  if (syncEnCurso) return res.status(409).json({ error: 'Ya hay una sincronización en curso' });

  let { fechaInicial, fechaFinal } = req.body;

  // Defaults: últimos 7 días
  if (!fechaFinal)   fechaFinal   = new Date().toISOString().split('T')[0] + 'T23:59:59';
  if (!fechaInicial) {
    const d = new Date(); d.setDate(d.getDate() - 7);
    fechaInicial = d.toISOString().split('T')[0] + 'T00:00:00';
  }

  syncEnCurso = true;
  syncLog = [`Iniciando sincronización ${fechaInicial} → ${fechaFinal}`];

  // Responder inmediatamente; el proceso corre en background
  res.json({ ok: true, mensaje: 'Sincronización iniciada', fechaInicial, fechaFinal });

  sincronizarRango(fechaInicial, fechaFinal, {
    onProgress: (msg) => { syncLog.push(msg); if (syncLog.length > 100) syncLog.shift(); }
  })
    .then(r => { syncLog.push(`✓ Completada: ${JSON.stringify(r)}`); })
    .catch(e => { syncLog.push(`✗ Error: ${e.message}`); })
    .finally(() => { syncEnCurso = false; });
});

// ─── GET /api/finanzas/sync/log ───────────────────────────────────────────────
router.get('/sync/log', (req, res) => {
  res.json({ enCurso: syncEnCurso, log: syncLog });
});

// ─── GET /api/finanzas/facturas ───────────────────────────────────────────────
router.get('/facturas', async (req, res) => {
  try {
    const { desde, hasta, emisor, tipo, status, q, page, size } = req.query;
    const result = await listarFacturas({
      fechaDesde:      desde,
      fechaHasta:      hasta,
      rfcEmisor:       emisor,
      tipoComprobante: tipo,
      fiscalStatus:    status,
      busqueda:        q,
      page:            parseInt(page) || 1,
      pageSize:        parseInt(size) || 50,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/finanzas/facturas/:id ──────────────────────────────────────────
router.get('/facturas/:id', async (req, res) => {
  try {
    const factura = await obtenerFactura(parseInt(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json(factura);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/finanzas/facturas/:id/xml ──────────────────────────────────────
router.get('/facturas/:id/xml', async (req, res) => {
  try {
    const xml = await obtenerXmlFactura(parseInt(req.params.id));
    if (!xml) return res.status(404).json({ error: 'XML no encontrado' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/finanzas/cuenta ────────────────────────────────────────────────
// Configura el RFC + guarda referencia del certificado (el archivo ya debe estar en certs/)
router.post('/cuenta', async (req, res) => {
  try {
    const { rfc } = req.body;
    if (!rfc) return res.status(400).json({ error: 'RFC requerido' });

    // Validar que el .cer existe y está vigente
    const { expiration } = validarCertificado(rfc);

    await guardarCuentaSAT({
      rfc,
      certificateSerial:      null, // se podría extraer del .cer si se necesita
      certificateExpiration:  expiration,
    });

    res.json({ ok: true, rfc: rfc.toUpperCase(), expiration });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── GET /api/finanzas/cuenta/validar ────────────────────────────────────────
router.get('/cuenta/validar', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rfc FROM sat_accounts WHERE negocio_id = 'default' AND active = TRUE LIMIT 1`
    );
    if (!rows.length) return res.json({ valido: false, mensaje: 'Sin cuenta configurada' });
    const result = validarCertificado(rows[0].rfc);
    res.json({ valido: true, ...result });
  } catch (e) {
    res.json({ valido: false, mensaje: e.message });
  }
});

export default router;
