// Convivencia de las dos fases: Restaurante operativo v2 y recuperación de
// contraseña.
//
// Las dos tocan autenticación, pero por caminos distintos: Restaurante usa
// la sesión de ESTACIÓN (PIN, marca `est` en el token) y la recuperación
// toca la sesión ADMINISTRATIVA (correo y contraseña). Esta suite existe
// para fijar por escrito dónde se cruzan y dónde no:
//
//   - cambiar la contraseña de un administrador cierra SUS sesiones;
//   - no toca la sesión de estación de un mesero, que ni siquiera tiene
//     contraseña que cambiar;
//   - un mesero no entra al flujo de recuperación, y su PIN sigue igual.
import assert from 'assert';
import { createHash } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4960';
const { pool } = await import('../src/services/database.js');
const { hashPassword, hashPin } = await import('../src/services/password.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const SLUG = 'integracion-v2-password';
const EMAIL_ADMIN = 'admin.integracion@negocio.test';
const PASS = 'Integracion12345!';
const PASS_NUEVA = 'Integracion67890!';
const PIN = '4821';

async function limpiar() {
  const { rows } = await pool.query('SELECT id FROM negocios WHERE slug = $1', [SLUG]);
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  await pool.query(`DELETE FROM password_reset_tokens WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM configuracion WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuarios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocios WHERE id = ANY($1)', [ids]);
}
await limpiar();

const { rows: [negocio] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('Restaurante Integración', $1) RETURNING id`, [SLUG]);
for (const m of ['restaurante', 'menu', 'usuarios', 'caja']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
                    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [negocio.id, m]);
}
const { rows: [admin] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Ana Integra',$2,$3) RETURNING id`,
  [negocio.id, EMAIL_ADMIN, hashPassword(PASS)]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [admin.id, negocio.id]);
const { rows: [mesero] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,'Ángel Integra',NULL,$2) RETURNING id`,
  [negocio.id, hashPin(PIN)]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`, [mesero.id, negocio.id]);
const pinAntes = (await pool.query('SELECT pin_hash FROM usuarios WHERE id = $1', [mesero.id])).rows[0].pin_hash;

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

function cliente() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    async pedir(path, { method = 'GET', body } = {}) {
      const h = { 'Content-Type': 'application/json' };
      if (cookie) h['Cookie'] = cookie;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    },
  };
}
async function sembrarTokenReset(usuarioId) {
  const token = 'int-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await pool.query(
    `INSERT INTO password_reset_tokens (usuario_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
    [usuarioId, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000)]);
  return token;
}

const estacion = cliente();
const panel = cliente();

await t('CONVIVENCIA', '1. las dos puertas funcionan a la vez sobre el mismo negocio', async () => {
  const entradaMesero = await estacion.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG, meseroUsuarioId: mesero.id, pin: PIN } });
  assert.strictEqual(entradaMesero.status, 200, 'el mesero entra con su PIN');
  const entradaAdmin = await panel.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: EMAIL_ADMIN, password: PASS } });
  assert.strictEqual(entradaAdmin.status, 200, 'y el administrador con su contraseña');
  assert.strictEqual((await estacion.pedir('/api/restaurante/mesas')).status, 200);
  assert.strictEqual((await panel.pedir('/api/restaurante/mesas')).status, 200);
});

await t('CONVIVENCIA', '2. cambiar la contraseña del administrador cierra SUS sesiones', async () => {
  const token = await sembrarTokenReset(admin.id);
  const r = await fetch(base + '/api/auth/negocio/reset-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: PASS_NUEVA, passwordConfirm: PASS_NUEVA }),
  });
  assert.strictEqual(r.status, 200);
  const me = await panel.pedir('/api/auth/me');
  assert.strictEqual(me.status, 401);
  assert.strictEqual(me.body.code, 'SESION_REVOCADA');
});

await t('CONVIVENCIA', '3. la sesión de estación del mesero NO se ve afectada', async () => {
  const mesas = await estacion.pedir('/api/restaurante/mesas');
  assert.strictEqual(mesas.status, 200, 'el mesero sigue trabajando: no tiene contraseña que cambiar');
  const abrir = await estacion.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 3, personas: 2 } });
  assert.strictEqual(abrir.status, 201, 'y puede seguir abriendo mesas');
});

await t('CONVIVENCIA', '4. el PIN del mesero queda intacto tras el cambio de contraseña', async () => {
  const { rows } = await pool.query('SELECT pin_hash, password_hash, sesiones_invalidas_antes FROM usuarios WHERE id = $1', [mesero.id]);
  assert.strictEqual(rows[0].pin_hash, pinAntes, 'mismo PIN');
  assert.strictEqual(rows[0].password_hash, null, 'sigue sin contraseña administrativa');
  assert.strictEqual(rows[0].sesiones_invalidas_antes, null, 'y nadie invalidó su sesión');
});

await t('CONVIVENCIA', '5. el mesero no puede pedir recuperación: no tiene correo', async () => {
  const r = await fetch(base + '/api/auth/negocio/forgot-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '' }) });
  assert.strictEqual(r.status, 200, 'responde genérico igual que siempre');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE usuario_id = $1', [mesero.id]);
  assert.strictEqual(rows[0].n, 0, 'nunca se le genera un enlace');
});

await t('CONVIVENCIA', '6. con la contraseña nueva, el administrador vuelve a Restaurante sin perder nada', async () => {
  const otro = cliente();
  const login = await otro.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: EMAIL_ADMIN, password: PASS_NUEVA } });
  assert.strictEqual(login.status, 200);
  const { body } = await otro.pedir('/api/restaurante/mesas');
  const m3 = body.mesas.find(m => m.mesa === 3);
  assert.strictEqual(m3.ocupada, true, 'la mesa que abrió el mesero sigue ahí');
  assert.strictEqual(m3.meseroUsuarioId, mesero.id, 'con su mesero responsable');
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
