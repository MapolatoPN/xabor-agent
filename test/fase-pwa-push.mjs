// Suite persistida: Bloque 4 (PWA y notificaciones push). Cubre lo que no
// dependía únicamente del navegador real: aislamiento de suscripciones por
// usuario y por negocio, múltiples dispositivos por usuario, el endpoint
// "Probar notificación" (scoped al propio usuario, nunca a todo el
// negocio), limpieza de suscripciones expiradas (410/404) y que la
// migración 030 (push_subscriptions.usuario_id) quedó aplicada. La entrega
// real de push nunca toca un servicio real -- se usa un mock HTTP local
// (lib-push-mock.mjs) como "endpoint" de la suscripción.
// dotenv/config: crearTokenSesion() se llama aquí EN ESTE PROCESO (no solo
// dentro del servidor hijo), y ambos deben firmar/verificar con el mismo
// SESSION_SECRET -- arrancarServidor hereda .env vía el propio `import
// 'dotenv/config'` de server.js, así que este proceso necesita cargarlo
// igual para no acabar firmando con el secreto por defecto mientras el
// servidor verifica con el de .env (o viceversa).
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import webpush from 'web-push';
const { generateVAPIDKeys } = webpush;
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarPushMock, generarSuscripcionFalsa } from './lib-push-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4170';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearUsuarioConPassword, guardarSuscripcionPush, obtenerSuscripcionesPushUsuario, obtenerSuscripcionesPush } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// ═══════════ Unidad: aislamiento de suscripciones (sin servidor) ═══════════
const pushMock = await arrancarPushMock();

const adminB = await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin B (prueba push)', email: 'admin-b-push@test.local',
  password: 'ClaveAdminBPushPrueba123!', rol: 'admin',
});

const subUsuarioA1 = generarSuscripcionFalsa(pushMock.baseUrl, 'usuarioA-dispositivo1');
const subUsuarioA2 = generarSuscripcionFalsa(pushMock.baseUrl, 'usuarioA-dispositivo2');
const subUsuarioB1 = generarSuscripcionFalsa(pushMock.baseUrl, 'usuarioB-dispositivo1');
// guardarSuscripcionPush espera {endpoint, auth, p256dh} planos (así es como
// server.js los extrae de sub.toJSON().keys antes de llamarla) -- las
// suscripciones falsas los traen anidados bajo `keys`, como el navegador.
const aPlano = (sub) => ({ endpoint: sub.endpoint, auth: sub.keys.auth, p256dh: sub.keys.p256dh });

await t('DB', 'migración 030 aplicada: push_subscriptions tiene columna usuario_id', async () => {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'push_subscriptions' AND column_name = 'usuario_id'
  `);
  assert.strictEqual(rows.length, 1);
});

await t('DB', 'guardarSuscripcionPush persiste usuario_id junto con negocio_id', async () => {
  await guardarSuscripcionPush(aPlano(subUsuarioA1), SEED.negocioA, SEED.adminNegocioAUsuarioId);
  const { rows } = await pool.query(`SELECT usuario_id, negocio_id FROM push_subscriptions WHERE endpoint = $1`, [subUsuarioA1.endpoint]);
  assert.strictEqual(rows[0].negocio_id, SEED.negocioA);
  assert.strictEqual(rows[0].usuario_id, SEED.adminNegocioAUsuarioId);
});

await t('DB', 'un mismo usuario puede tener varias suscripciones (varios dispositivos)', async () => {
  await guardarSuscripcionPush(aPlano(subUsuarioA2), SEED.negocioA, SEED.adminNegocioAUsuarioId);
  const subs = await obtenerSuscripcionesPushUsuario(SEED.negocioA, SEED.adminNegocioAUsuarioId);
  const endpoints = subs.map(s => s.endpoint);
  assert.ok(endpoints.includes(subUsuarioA1.endpoint));
  assert.ok(endpoints.includes(subUsuarioA2.endpoint));
});

await t('DB', 'obtenerSuscripcionesPushUsuario no devuelve suscripciones de otro usuario del mismo negocio', async () => {
  await guardarSuscripcionPush(aPlano(subUsuarioB1), SEED.negocioA, SEED.staffNegocioAUsuarioId);
  const subsAdminA = await obtenerSuscripcionesPushUsuario(SEED.negocioA, SEED.adminNegocioAUsuarioId);
  assert.ok(!subsAdminA.some(s => s.endpoint === subUsuarioB1.endpoint));
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [subUsuarioB1.endpoint]);
});

await t('DB', 'obtenerSuscripcionesPush (por negocio) sigue viendo ambos dispositivos del usuario', async () => {
  const subsNegocio = await obtenerSuscripcionesPush(SEED.negocioA);
  const endpoints = subsNegocio.map(s => s.endpoint);
  assert.ok(endpoints.includes(subUsuarioA1.endpoint));
  assert.ok(endpoints.includes(subUsuarioA2.endpoint));
});

await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = ANY($1)`, [[subUsuarioA1.endpoint, subUsuarioA2.endpoint]]);

// ═══════════ Integración: endpoints HTTP con servidor real ═══════════
const vapid = generateVAPIDKeys();
// NODE_TLS_REJECT_UNAUTHORIZED=0: SOLO para este proceso hijo desechable de
// prueba -- el mock de push habla TLS con un certificado autofirmado (ver
// lib-push-mock.mjs) y webpush.sendNotification (dentro del servidor) sí
// valida certificados por defecto.
const srv = await arrancarServidor({
  PORT: PUERTO,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_EMAIL: 'mailto:test-push@xabor.mx',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
}, { timeoutMs: 30000 });

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieAdminB = cookieHeader(adminB.id, SEED.negocioB, 'admin');

try {
  await t('HTTP', 'GET /api/push/vapid-public-key responde la clave configurada', async () => {
    const r = await api(srv.base, '/api/push/vapid-public-key', { cookie: cookieAdminA });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.key, vapid.publicKey);
  });

  const subHttpA = generarSuscripcionFalsa(pushMock.baseUrl, 'http-admin-a');
  await t('HTTP', 'POST /api/push/subscribe guarda negocio_id/usuario_id de la SESIÓN, nunca del body', async () => {
    const r = await api(srv.base, '/api/push/subscribe', { cookie: cookieAdminA, method: 'POST', body: { ...subHttpA, negocioId: SEED.negocioB, usuarioId: 'otro-usuario-cualquiera' } });
    assert.strictEqual(r.status, 200);
    const { rows } = await pool.query(`SELECT negocio_id, usuario_id FROM push_subscriptions WHERE endpoint = $1`, [subHttpA.endpoint]);
    assert.strictEqual(rows[0].negocio_id, SEED.negocioA);
    assert.strictEqual(rows[0].usuario_id, SEED.adminNegocioAUsuarioId);
  });

  await t('HTTP', 'POST /api/push/test entrega correctamente al mock y responde ok', async () => {
    const r = await api(srv.base, '/api/push/test', { cookie: cookieAdminA, method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.enviados >= 1);
  });

  await t('HTTP', 'POST /api/push/test responde 404 si el usuario no tiene ninguna suscripción propia', async () => {
    const r = await api(srv.base, '/api/push/test', { cookie: cookieAdminB, method: 'POST' });
    assert.strictEqual(r.status, 404);
  });

  await t('HTTP', 'POST /api/push/test limpia la suscripción si el servicio de push responde 410 (expirada)', async () => {
    pushMock.forzarStatusSiguienteEntrega(410);
    const r = await api(srv.base, '/api/push/test', { cookie: cookieAdminA, method: 'POST' });
    assert.strictEqual(r.status, 502); // única suscripción de A, se limpió y no quedó nadie a quien entregar
    const { rows } = await pool.query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [subHttpA.endpoint]);
    assert.strictEqual(rows.length, 0);
  });

  const subHttpA2 = generarSuscripcionFalsa(pushMock.baseUrl, 'http-admin-a-2');
  await api(srv.base, '/api/push/subscribe', { cookie: cookieAdminA, method: 'POST', body: subHttpA2 });
  await t('HTTP', 'DELETE /api/push/subscribe elimina la suscripción de la sesión actual', async () => {
    const r = await api(srv.base, '/api/push/subscribe', { cookie: cookieAdminA, method: 'DELETE', body: { endpoint: subHttpA2.endpoint } });
    assert.strictEqual(r.status, 200);
    const { rows } = await pool.query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [subHttpA2.endpoint]);
    assert.strictEqual(rows.length, 0);
  });
} finally {
  srv.detener();
  pushMock.detener();
  await pool.query(`DELETE FROM usuarios WHERE id = $1`, [adminB.id]).catch(() => {});
}

// ═══════════ VAPID no configurado ═══════════
const srvSinVapid = await arrancarServidor({ PORT: String(Number(PUERTO) + 1) }, { timeoutMs: 30000, omitir: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] });
try {
  await t('HTTP', 'POST /api/push/test responde 503 si el servidor no tiene VAPID configurado', async () => {
    const r = await api(srvSinVapid.base, '/api/push/test', { cookie: cookieAdminA, method: 'POST' });
    assert.strictEqual(r.status, 503);
  });
} finally {
  srvSinVapid.detener();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas > 0) {
  console.log('\nFallos:');
  fallos.forEach(f => console.log(' - ' + f));
  process.exitCode = 1;
}
await pool.end();
