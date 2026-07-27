/**
 * finanzas.js — Rutas REST para Xabor Finanzas (módulo SAT)
 * Montado en /api/finanzas — solo admin
 */

import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import { exec } from 'child_process';
import https from 'https';
const execAsync = promisify(exec);
const dnsResolve4 = promisify(dns.resolve4);
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

// ─── Diagnóstico de red SAT (temporal) ────────────────────────────────────────
router.get('/debug-network', async (req, res) => {
  const result = { timestamp: new Date().toISOString() };

  // Helper: resolve con un resolver específico
  const resolveWith = (host, server) => new Promise((ok) => {
    const r = new dns.Resolver();
    r.setServers([server]);
    r.resolve4(host, (err, addrs) => ok(err ? { error: err.code } : addrs));
  });

  // Helper: HTTP GET con Node.js nativo, sin seguir redirects
  const httpProbe = (url) => new Promise((ok) => {
    const t0 = Date.now();
    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, (res2) => {
      ok({ status: res2.statusCode, ms: Date.now() - t0 });
      res2.resume();
    });
    req.on('timeout', () => { req.destroy(); ok({ error: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => ok({ error: e.code || e.message, ms: Date.now() - t0 }));
    req.end();
  });

  // 1. Sanity check: dominios conocidos resuelven bien
  const sanity = {};
  for (const h of ['google.com', 'railway.app', 'cloudflare.com']) {
    sanity[h] = await resolveWith(h, '8.8.8.8');
  }
  result.sanity_dns = sanity;

  // 2. DNS de hosts SAT con 3 resolvers
  const SAT_HOSTS = [
    'cfdidescargamasivarfc.sat.gob.mx',
    'www.sat.gob.mx',
    'sat.gob.mx',
    'cfdidescargamasiva3.sat.gob.mx',   // variante alternativa
    'portalcfdi.sat.gob.mx',
  ];
  result.sat_dns = {};
  for (const h of SAT_HOSTS) {
    result.sat_dns[h] = {
      system:     await new Promise(ok => dns.resolve4(h, (e,a) => ok(e ? {error:e.code} : a))),
      cloudflare: await resolveWith(h, '1.1.1.1'),
      google:     await resolveWith(h, '8.8.8.8'),
    };
  }

  // 3. HTTP HEAD a cada endpoint candidato (solo si DNS resolvió)
  const ENDPOINTS = [
    { label: 'auth_svc',      url: 'https://cfdidescargamasivarfc.sat.gob.mx/CFDI/Autenticacion/autenticacion.svc' },
    { label: 'auth_corto',    url: 'https://cfdidescargamasivarfc.sat.gob.mx/autenticacion' },
    { label: 'solicitud_svc', url: 'https://cfdidescargamasivarfc.sat.gob.mx/CFDI/SolicitudDescargaMasivaTercerosMTCC.svc' },
    { label: 'verifica_svc',  url: 'https://cfdidescargamasivarfc.sat.gob.mx/CFDI/VerificaSolicitudDescargaMTCC.svc' },
    { label: 'descarga_svc',  url: 'https://cfdidescargamasivarfc.sat.gob.mx/CFDI/DescargaMasivaServicio.svc' },
    { label: 'sat_home',      url: 'https://www.sat.gob.mx' },
  ];
  result.http_probes = {};
  for (const ep of ENDPOINTS) {
    result.http_probes[ep.label] = await httpProbe(ep.url);
  }

  // 4. IP pública del servidor Railway
  try {
    result.railway_ip = await new Promise((ok) => {
      https.get('https://api.ipify.org?format=json', { timeout: 5000 }, (r2) => {
        let body = '';
        r2.on('data', d => body += d);
        r2.on('end', () => { try { ok(JSON.parse(body)); } catch { ok({ raw: body }); } });
      }).on('error', e => ok({ error: e.message }));
    });
  } catch(e) { result.railway_ip = { error: e.message }; }

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
