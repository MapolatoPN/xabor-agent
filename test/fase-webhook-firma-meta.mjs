// Seguridad del webhook de Meta: validación X-Hub-Signature-256.
//
// Lo que esta suite demuestra:
//   - Con META_APP_SECRET configurado, el webhook es FAIL CLOSED: firma
//     ausente, inválida o body alterado → 403 y CERO efectos (ni mensajes,
//     ni takeover, ni desconexión de integraciones).
//   - Con firma válida, TODOS los flujos (messages, statuses, echoes,
//     history, state_sync, PARTNER_REMOVED) siguen funcionando.
//   - El handshake GET (hub.verify_token/hub.challenge) no se toca.
//   - La comparación es timing-safe y ningún secreto/firma cae a los logs.
//
// La firma se calcula sobre EXACTAMENTE los bytes enviados (nunca sobre un
// JSON re-serializado) -- igual que Meta.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-webhook-firma-meta.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createHmac } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4093';
const FUENTE_WEBHOOK = readFileSync(join(__dirname, '..', 'src', 'channels', 'whatsapp-meta.js'), 'utf8');

const APP_SECRET_PRUEBA = 'app-secret-de-prueba-firma-9271';
const VERIFY_TOKEN_PRUEBA = 'verify-token-prueba-1188';

const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const NEG_A = SEED.negocioA;
const sufijo = Date.now().toString().slice(-6);
const PNID_F = `PNIDFIRMA${sufijo}`;
const WABA_F = `WABAFIRMA${sufijo}`;
const TEL_CLIENTE = `52879${sufijo}1`;

// ─── Setup: integración de prueba con bot global encendido ──────────────────
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = $1`, [NEG_A]);
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo, proveedor, estado, waba_id)
   VALUES ($1,'whatsapp',$2,'Firma prueba', TRUE, 'meta', 'activo', $3)
   ON CONFLICT (canal, identificador) DO NOTHING`, [NEG_A, PNID_F, WABA_F]);
await pool.query(
  `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'bot_whatsapp_activo', 'true')
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true'`, [NEG_A]).catch(() => {});

const srv = await arrancarServidor({
  PORT: PUERTO, META_EMBEDDED_SIGNUP_MOCK: 'true',
  META_APP_ID: 'TEST', META_CONFIG_ID: 'TEST',
  META_APP_SECRET: APP_SECRET_PRUEBA,
  META_VERIFY_TOKEN: VERIFY_TOKEN_PRUEBA,
  OPENAI_API_KEY: '',
}, { timeoutMs: 30000 });
const BASE = srv.base;

// La firma se calcula sobre los BYTES EXACTOS que se envían.
function firmar(cuerpoTexto, secreto = APP_SECRET_PRUEBA) {
  return 'sha256=' + createHmac('sha256', secreto).update(Buffer.from(cuerpoTexto, 'utf8')).digest('hex');
}
function postWebhook(cuerpoTexto, encabezados = {}) {
  return fetch(BASE + '/webhook/whatsapp', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, encabezados),
    body: cuerpoTexto,
  });
}
const payload = (cambios) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_F, changes: cambios }] });
const cambioMensaje = (texto, id) => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_F },
    contacts: [{ profile: { name: 'Cliente Firma' }, wa_id: TEL_CLIENTE }],
    messages: [{ from: TEL_CLIENTE, id, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }],
  },
});
const cambioEcho = (texto, wamid) => ({
  field: 'smb_message_echoes',
  value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_F },
    message_echoes: [{ from: PNID_F, to: TEL_CLIENTE, id: wamid, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }],
  },
});
async function mensajesDe(telefono) {
  const { rows } = await pool.query(
    `SELECT direccion, texto, origen, tipo FROM mensajes WHERE negocio_id = $1 AND telefono = $2 ORDER BY id`, [NEG_A, telefono]);
  return rows;
}

try {

// ═══════════ 1-4. La puerta: válida entra, todo lo demás se rechaza ═════════
await t('FIRMA', '1. POST con firma válida → aceptado (200)', async () => {
  const cuerpo = payload([cambioMensaje('Hola con firma válida', `wamid.fw.${sufijo}.1`)]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo) });
  assert.strictEqual(r.status, 200);
});

await t('FIRMA', '2. firma inválida → rechazado (403)', async () => {
  const cuerpo = payload([cambioMensaje('Con firma inválida', `wamid.fw.${sufijo}.2`)]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo, 'otro-secreto-equivocado') });
  assert.strictEqual(r.status, 403);
});

await t('FIRMA', '3. header ausente → rechazado (403)', async () => {
  const cuerpo = payload([cambioMensaje('Sin header de firma', `wamid.fw.${sufijo}.3`)]);
  const r = await postWebhook(cuerpo);
  assert.strictEqual(r.status, 403);
});

await t('FIRMA', '4. body modificado después de firmar → rechazado (403)', async () => {
  const cuerpoOriginal = payload([cambioMensaje('Cuerpo original', `wamid.fw.${sufijo}.4`)]);
  const firma = firmar(cuerpoOriginal);
  const cuerpoAlterado = cuerpoOriginal.replace('Cuerpo original', 'Cuerpo ALTERADO');
  const r = await postWebhook(cuerpoAlterado, { 'X-Hub-Signature-256': firma });
  assert.strictEqual(r.status, 403);
});

// ═══════════ 5-10. Con firma válida, TODO el pipeline sigue vivo ════════════
await t('FLUJOS', '5. firma válida + messages → el mensaje se procesa y guarda', async () => {
  await esperar(1200);
  const msgs = await mensajesDe(TEL_CLIENTE);
  assert.ok(msgs.some((m) => m.direccion === 'entrante' && m.origen === 'cliente' && m.texto === 'Hola con firma válida'));
});

await t('FLUJOS', '6. firma válida + statuses → procesado sin romper nada', async () => {
  const cuerpo = payload([{ field: 'messages', value: { metadata: { phone_number_id: PNID_F }, statuses: [{ id: 'wamid.fw.st.1', status: 'delivered', recipient_id: TEL_CLIENTE }] } }]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo) });
  assert.strictEqual(r.status, 200);
});

await t('FLUJOS', '7. firma válida + smb_message_echoes → echo guardado saliente/humano', async () => {
  const cuerpo = payload([cambioEcho('Respuesta manual firmada', `wamid.fw.echo.${sufijo}.1`)]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo) });
  assert.strictEqual(r.status, 200);
  await esperar(1000);
  const msgs = await mensajesDe(TEL_CLIENTE);
  const echo = msgs.find((m) => m.texto === 'Respuesta manual firmada');
  assert.ok(echo && echo.direccion === 'saliente' && echo.origen === 'humano');
});

await t('FLUJOS', '8. firma válida + history → mensaje histórico importado', async () => {
  const cuerpo = payload([{
    field: 'history',
    value: {
      metadata: { phone_number_id: PNID_F },
      history: [{ metadata: { phase: '0' }, threads: [{ id: TEL_CLIENTE, messages: [
        { from: TEL_CLIENTE, id: `wamid.fw.hist.${sufijo}.1`, timestamp: `${Math.floor(Date.now() / 1000) - 86400}`, type: 'text', text: { body: 'Histórico firmado' } },
      ] }] }],
    },
  }]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo) });
  assert.strictEqual(r.status, 200);
  await esperar(1000);
  const msgs = await mensajesDe(TEL_CLIENTE);
  assert.ok(msgs.some((m) => m.texto === 'Histórico firmado' && m.tipo === 'texto_historico'));
});

await t('FLUJOS', '9. firma válida + smb_app_state_sync → procesado (200)', async () => {
  const cuerpo = payload([{ field: 'smb_app_state_sync', value: { metadata: { phone_number_id: PNID_F }, state_sync: [{ type: 'contact', contact: { full_name: 'Sync Firmado', phone_number: TEL_CLIENTE } }] } }]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo) });
  assert.strictEqual(r.status, 200);
});

await t('FLUJOS', '10. firma válida + PARTNER_REMOVED → marca desconectado', async () => {
  const cuerpo = payload([{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: WABA_F } } }]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo) });
  assert.strictEqual(r.status, 200);
  await esperar(800);
  const { rows: [fila] } = await pool.query(`SELECT estado FROM integraciones_canal WHERE canal='whatsapp' AND identificador = $1`, [PNID_F]);
  assert.strictEqual(fila.estado, 'desconectado');
  await pool.query(`UPDATE integraciones_canal SET estado = 'activo' WHERE canal='whatsapp' AND identificador = $1`, [PNID_F]);
});

// ═══════════ 11-13. Firma inválida = CERO efectos ═══════════════════════════
await t('FAILCLOSED', '11. echo con firma inválida NO activa human takeover', async () => {
  const TEL_NUEVO = `52879${sufijo}2`;
  const cuerpo = payload([{
    field: 'smb_message_echoes',
    value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_F },
      message_echoes: [{ from: PNID_F, to: TEL_NUEVO, id: `wamid.fw.mal.${sufijo}.1`, type: 'text', text: { body: 'Echo forjado' } }] },
  }]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': 'sha256=' + 'a'.repeat(64) });
  assert.strictEqual(r.status, 403);
  await esperar(600);
  const { rows } = await pool.query(`SELECT human_takeover_until FROM clientes WHERE telefono = $1 AND negocio_id = $2`, [TEL_NUEVO, NEG_A]);
  assert.ok(!rows[0] || !rows[0].human_takeover_until, 'un payload forjado jamás puede silenciar al bot');
});

await t('FAILCLOSED', '12. PARTNER_REMOVED con firma inválida NO desconecta la integración', async () => {
  const cuerpo = payload([{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: WABA_F } } }]);
  const r = await postWebhook(cuerpo, { 'X-Hub-Signature-256': firmar(cuerpo, 'secreto-equivocado') });
  assert.strictEqual(r.status, 403);
  await esperar(600);
  const { rows: [fila] } = await pool.query(`SELECT estado FROM integraciones_canal WHERE canal='whatsapp' AND identificador = $1`, [PNID_F]);
  assert.strictEqual(fila.estado, 'activo', 'un payload forjado no puede tumbar una integración');
});

await t('FAILCLOSED', '13. mensaje con firma inválida NO se escribe en mensajes', async () => {
  const msgs = await mensajesDe(TEL_CLIENTE);
  assert.ok(!msgs.some((m) => m.texto === 'Con firma inválida' || m.texto === 'Sin header de firma' || m.texto === 'Cuerpo ALTERADO'),
    'nada de los casos 2-4 puede haber llegado a la base');
});

// ═══════════ 14. Handshake GET intacto ══════════════════════════════════════
await t('GET', '14. la verificación GET de Meta (hub.challenge) sigue funcionando', async () => {
  const r = await fetch(BASE + `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN_PRUEBA}&hub.challenge=reto-12345`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'reto-12345');
  const rMal = await fetch(BASE + `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=token-equivocado&hub.challenge=x`);
  assert.strictEqual(rMal.status, 403);
});

// ═══════════ 15-16. Sin secretos en logs; comparación timing-safe ═══════════
await t('SEGURIDAD', '15. ni el App Secret ni firmas completas aparecen en los logs', async () => {
  const salida = srv.obtenerSalida();
  assert.ok(!salida.includes(APP_SECRET_PRUEBA), 'el App Secret jamás puede aparecer en logs');
  const firmaEjemplo = firmar(payload([cambioMensaje('x', 'y')])).slice('sha256='.length);
  assert.ok(!salida.includes(firmaEjemplo.slice(0, 24)), 'las firmas no se loguean');
  assert.ok(!/sha256=[0-9a-f]{64}/.test(salida), 'ninguna firma completa en la salida');
});

await t('SEGURIDAD', '16. la comparación de firmas es timing-safe (no igualdad simple)', async () => {
  const idx = FUENTE_WEBHOOK.indexOf('function firmaWebhookValida');
  assert.ok(idx !== -1, 'existe la función de validación');
  const cuerpoFn = FUENTE_WEBHOOK.slice(idx, FUENTE_WEBHOOK.indexOf('router.post', idx));
  assert.ok(/timingSafeEqual\(/.test(cuerpoFn), 'usa crypto.timingSafeEqual');
  assert.ok(!/recibidaHex\s*===\s*esperadaHex|esperadaHex\s*===\s*recibidaHex|encabezado\s*===\s*/.test(cuerpoFn),
    'no compara firmas con === de strings');
});

} finally {
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = $1 AND identificador = $2`, [NEG_A, PNID_F]).catch(() => {});
  await pool.query(`DELETE FROM mensajes WHERE negocio_id = $1 AND telefono LIKE '52879${sufijo}%'`, [NEG_A]).catch(() => {});
  await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52879${sufijo}%'`).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
