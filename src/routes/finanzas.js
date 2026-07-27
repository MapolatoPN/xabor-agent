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
  const HOST = 'cfdidescargamasivarfc.sat.gob.mx';
  const TARGETS = [
    { label: 'auth_corto',    url: `https://${HOST}/autenticacion` },
    { label: 'auth_svc',      url: `https://${HOST}/CFDI/Autenticacion/autenticacion.svc` },
    { label: 'solicitud_svc', url: `https://${HOST}/CFDI/SolicitudDescargaMasivaTercerosMTCC.svc` },
    { label: 'verifica_svc',  url: `https://${HOST}/CFDI/VerificaSolicitudDescargaMTCC.svc` },
    { label: 'descarga_svc',  url: `https://${HOST}/CFDI/DescargaMasivaServicio.svc` },
    { label: 'sat_home',      url: 'https://www.sat.gob.mx' },
  ];
  const result = { host: HOST, timestamp: new Date().toISOString() };

  // 1. DNS con resolver del sistema
  try { result.dns_system = await dnsResolve4(HOST); }
  catch (e) { result.dns_system = { error: e.code, message: e.message }; }

  // 2. DNS con Cloudflare 1.1.1.1
  try {
    const r = new dns.Resolver();
    r.setServers(['1.1.1.1']);
    result.dns_cloudflare = await new Promise((ok, fail) =>
      r.resolve4(HOST, (err, addrs) => err ? fail(err) : ok(addrs)));
  } catch (e) { result.dns_cloudflare = { error: e.code, message: e.message }; }

  // 3. DNS con Google 8.8.8.8
  try {
    const r = new dns.Resolver();
    r.setServers(['8.8.8.8']);
    result.dns_google = await new Promise((ok, fail) =>
      r.resolve4(HOST, (err, addrs) => err ? fail(err) : ok(addrs)));
  } catch (e) { result.dns_google = { error: e.code, message: e.message }; }

  // 4. nslookup y dig via shell
  for (const cmd of [`nslookup ${HOST}`, `dig +short ${HOST}`]) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 8000 });
      result[cmd.split(' ')[0]] = stdout.trim() || stderr.trim() || '(sin salida)';
    } catch (e) { result[cmd.split(' ')[0]] = { error: e.message }; }
  }

  // 5. curl HEAD a cada endpoint
  result.endpoints = {};
  for (const t of TARGETS) {
    try {
      const { stdout } = await execAsync(
        `curl -sS -o /dev/null -w "%{http_code}|%{time_total}|%{ssl_verify_result}" --max-time 10 -I "${t.url}" 2>&1`,
        { timeout: 15000 }
      );
      const [http, time, ssl] = stdout.split('|');
      result.endpoints[t.label] = { http_code: http, time_s: time, ssl_result: ssl, url: t.url };
    } catch (e) {
      result.endpoints[t.label] = { error: e.message, url: t.url };
    }
  }

  // 6. curl verbose al auth (para ver si es TLS, TCP o DNS)
  try {
    const { stdout, stderr } = await execAsync(
      `curl -sv --max-time 10 https://${HOST}/CFDI/Autenticacion/autenticacion.svc 2>&1 | head -40`,
      { timeout: 15000 }
    );
    result.curl_verbose = (stdout + stderr).trim();
  } catch (e) { result.curl_verbose = e.message; }

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
