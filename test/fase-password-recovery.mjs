// Recuperación de contraseña — "¿Olvidaste tu contraseña?".
//
// Un administrador que olvida su contraseña no tenía salida: las
// invitaciones (012) solo sirven para la contraseña inicial y las emite un
// superadmin. Aquí se prueba el flujo completo y, sobre todo, lo que NO debe
// pasar: que el formulario sirva para averiguar qué correos están dados de
// alta en Xabor, que el token quede guardado en claro, que un enlace sirva
// dos veces, o que esto toque el PIN de un mesero.
import assert from 'assert';
import vm from 'vm';
import { createHash } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4959';
const { pool } = await import('../src/services/database.js');
const { hashPassword, hashPin, verifyPassword } = await import('../src/services/password.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const SLUG = 'recuperacion-negocio';
const EMAIL_ADMIN = 'ana.recuperacion@negocio.test';
const EMAIL_STAFF = 'beto.recuperacion@negocio.test';
const PASS_ORIGINAL = 'Original12345!';
const PASS_NUEVA = 'Renovada12345!';

async function limpiar() {
  const { rows } = await pool.query('SELECT id FROM negocios WHERE slug = $1', [SLUG]);
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  await pool.query(`DELETE FROM password_reset_tokens WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query('DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM configuracion WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuarios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocios WHERE id = ANY($1)', [ids]);
}
await limpiar();

const { rows: [negocio] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('Negocio Recuperación', $1) RETURNING id`, [SLUG]);
for (const m of ['restaurante', 'menu', 'usuarios']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
                    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [negocio.id, m]);
}
const { rows: [admin] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Ana Torres',$2,$3) RETURNING id`,
  [negocio.id, EMAIL_ADMIN, hashPassword(PASS_ORIGINAL)]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [admin.id, negocio.id]);
const { rows: [staff] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Beto Ruiz',$2,$3) RETURNING id`,
  [negocio.id, EMAIL_STAFF, hashPassword(PASS_ORIGINAL)]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'staff')`, [staff.id, negocio.id]);
// Mesero: sin correo, con PIN. No debe poder entrar por este flujo ni verse
// afectado por él.
const { rows: [mesero] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,'Juan Mesero',NULL,$2) RETURNING id`,
  [negocio.id, hashPin('4821')]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`, [mesero.id, negocio.id]);
const pinOriginal = (await pool.query('SELECT pin_hash FROM usuarios WHERE id = $1', [mesero.id])).rows[0].pin_hash;

// El límite por correo (3 solicitudes / 15 min) es parte del contrato y no se
// relaja para las pruebas: los casos que necesitan pedir varios enlaces usan
// cada uno su propia cuenta, igual que pasaría con personas distintas.
async function crearAdmin(nombre, correo) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [negocio.id, nombre, correo, hashPassword(PASS_ORIGINAL)]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [u.id, negocio.id]);
  return { id: u.id, email: correo };
}
const carla = await crearAdmin('Carla Díaz', 'carla.recuperacion@negocio.test');
const elena = await crearAdmin('Elena Sosa', 'elena.recuperacion@negocio.test');
const dora = await crearAdmin('Dora Nava', 'dora.recuperacion@negocio.test');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

function cliente() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async pedir(path, { method = 'GET', body, cookieManual } = {}) {
      const h = { 'Content-Type': 'application/json' };
      const c = cookieManual !== undefined ? cookieManual : cookie;
      if (c) h['Cookie'] = c;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set && cookieManual === undefined) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    },
  };
}
const anon = cliente();
const hash = (s) => createHash('sha256').update(s).digest('hex');

// El correo no sale del servidor en pruebas (NODE_ENV != production), así que
// el token se lee de la base: es el mismo que viaja en el enlace. Esto NO es
// un atajo del flujo -- justamente sirve para comprobar que lo guardado es el
// hash y no el token.
async function tokenVigenteDe(usuarioId) {
  const { rows } = await pool.query(
    `SELECT token_hash, expires_at, id FROM password_reset_tokens
      WHERE usuario_id = $1 AND used_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [usuarioId]);
  return rows[0] || null;
}
// Genera un token conocido para poder usar el enlace en las pruebas: se
// inserta su hash igual que lo haría el servidor.
async function sembrarToken(usuarioId, { minutos = 60, usado = false, revocado = false } = {}) {
  const token = 'tk-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await pool.query(
    `INSERT INTO password_reset_tokens (usuario_id, token_hash, expires_at, used_at, revoked_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [usuarioId, hash(token), new Date(Date.now() + minutos * 60000), usado ? new Date() : null, revocado ? new Date() : null]);
  return token;
}

const MENSAJE_GENERICO = 'Si existe una cuenta asociada a ese correo, enviaremos instrucciones para restablecer la contraseña.';

// ── 1-4. La solicitud ──────────────────────────────────────────────────────
await t('UI', '1. el login ofrece "¿Olvidaste tu contraseña?" y su pantalla no promete de más', async () => {
  const html = await (await fetch(base + '/login-negocio.html')).text();
  assert.ok(html.includes('¿Olvidaste tu contraseña?'), 'el enlace es visible en el login');
  assert.ok(html.includes('/api/auth/negocio/forgot-password'), 'llama al endpoint real');
  assert.ok(html.includes('Si existe una cuenta asociada a ese correo'), 'y anuncia la respuesta genérica');
});

await t('SOLICITUD', '2. un correo válido genera exactamente un enlace vigente', async () => {
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: EMAIL_ADMIN } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mensaje, MENSAJE_GENERICO);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE usuario_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [admin.id]);
  assert.strictEqual(rows[0].n, 1);
});

await t('SOLICITUD', '3. un correo inexistente responde exactamente igual y no crea nada', async () => {
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: 'nadie@ningun-negocio.test' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true, mensaje: MENSAJE_GENERICO });
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM password_reset_tokens');
  assert.ok(rows[0].n >= 1, 'los tokens que ya existían siguen ahí');
  const { rows: usuarios } = await pool.query(`SELECT COUNT(*)::int AS n FROM usuarios WHERE email = 'nadie@ningun-negocio.test'`);
  assert.strictEqual(usuarios[0].n, 0, 'no se inventa ningún usuario');
});

await t('SOLICITUD', '4. el correo se normaliza: espacios y mayúsculas encuentran la misma cuenta', async () => {
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: `  ${EMAIL_STAFF.toUpperCase()}  ` } });
  assert.strictEqual(r.status, 200);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE usuario_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [staff.id]);
  assert.strictEqual(rows[0].n, 1, 'le llegó a Beto pese al formato del correo');
});

// ── 5-9. El token ──────────────────────────────────────────────────────────
await t('TOKEN', '5. la base guarda el hash, nunca el token que viaja en el enlace', async () => {
  const token = await sembrarToken(admin.id);
  const { rows } = await pool.query('SELECT token_hash FROM password_reset_tokens WHERE token_hash = $1', [hash(token)]);
  assert.strictEqual(rows.length, 1, 'se guarda el SHA-256');
  const { rows: crudo } = await pool.query('SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE token_hash = $1', [token]);
  assert.strictEqual(crudo[0].n, 0, 'el token en claro no está en ninguna fila');
  // Y el esquema no tiene ninguna columna donde pudiera esconderse.
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'password_reset_tokens'`);
  const nombres = cols.map(c => c.column_name).sort();
  assert.deepStrictEqual(nombres, ['created_at', 'expires_at', 'id', 'revoked_at', 'token_hash', 'used_at', 'usuario_id']);
});

await t('TOKEN', '6. el enlace es aleatorio e impredecible, no derivado del usuario', async () => {
  await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: elena.email } });
  const uno = await tokenVigenteDe(elena.id);
  await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: elena.email } });
  const dos = await tokenVigenteDe(elena.id);
  assert.notStrictEqual(uno.token_hash, dos.token_hash, 'dos solicitudes dan enlaces distintos');
  assert.notStrictEqual(dos.token_hash, hash(elena.id), 'no es el id del usuario');
  assert.notStrictEqual(dos.token_hash, hash(elena.email), 'ni el correo');
});

await t('TOKEN', '7. dura poco: la expiración se fija en una hora', async () => {
  const t = await tokenVigenteDe(elena.id);
  const minutos = (new Date(t.expires_at) - Date.now()) / 60000;
  assert.ok(minutos > 55 && minutos <= 60, `la expiración debería rondar los 60 minutos y es ${Math.round(minutos)}`);
});

await t('TOKEN', '8. pedir otro enlace invalida el anterior: solo sirve el último', async () => {
  const primero = await sembrarToken(carla.id);
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: carla.email } });
  assert.strictEqual(r.status, 200);
  const estado = await anon.pedir('/api/auth/reset-password/' + encodeURIComponent(primero));
  assert.strictEqual(estado.body.estado, 'invalido', 'el enlace viejo ya no sirve');
  const consumir = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token: primero, password: PASS_NUEVA, passwordConfirm: PASS_NUEVA },
  });
  assert.strictEqual(consumir.status, 404, 'y tampoco puede consumirse');
  assert.ok(verifyPassword(PASS_ORIGINAL, (await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [carla.id])).rows[0].password_hash),
    'la contraseña sigue siendo la original');
});

await t('TOKEN', '9. un enlace expirado o inventado se rechaza sin cambiar nada', async () => {
  const vencido = await sembrarToken(admin.id, { minutos: -1 });
  const estado = await anon.pedir('/api/auth/reset-password/' + encodeURIComponent(vencido));
  assert.strictEqual(estado.body.estado, 'expirado');
  const r = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token: vencido, password: PASS_NUEVA, passwordConfirm: PASS_NUEVA } });
  assert.strictEqual(r.status, 410);
  const inventado = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token: 'no-existe-este-token', password: PASS_NUEVA, passwordConfirm: PASS_NUEVA } });
  assert.strictEqual(inventado.status, 404);
  assert.ok(verifyPassword(PASS_ORIGINAL, (await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [admin.id])).rows[0].password_hash));
});

// ── 10-15. El cambio de contraseña ─────────────────────────────────────────
let sesionPrevia = null;

await t('RESET', '10. la contraseña nueva se confirma y se valida con la misma política de siempre', async () => {
  const token = await sembrarToken(admin.id);
  const noCoincide = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token, password: PASS_NUEVA, passwordConfirm: 'otra-cosa' } });
  assert.strictEqual(noCoincide.status, 400);
  const corta = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token, password: 'corta', passwordConfirm: 'corta' } });
  assert.strictEqual(corta.status, 400);
  const igualAlCorreo = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token, password: EMAIL_ADMIN, passwordConfirm: EMAIL_ADMIN } });
  assert.strictEqual(igualAlCorreo.status, 400);
  const sigueVivo = await anon.pedir('/api/auth/reset-password/' + encodeURIComponent(token));
  assert.strictEqual(sigueVivo.body.estado, 'valido', 'un intento inválido no quema el enlace');
});

await t('RESET', '11. antes de cambiarla, la sesión abierta con la contraseña vieja funciona', async () => {
  sesionPrevia = cliente();
  const login = await sesionPrevia.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: EMAIL_ADMIN, password: PASS_ORIGINAL } });
  assert.strictEqual(login.status, 200);
  const me = await sesionPrevia.pedir('/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.rol, 'admin');
});

await t('RESET', '12. el enlace cambia la contraseña y queda guardada hasheada, nunca en claro', async () => {
  const token = await sembrarToken(admin.id);
  const r = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token, password: PASS_NUEVA, passwordConfirm: PASS_NUEVA } });
  assert.strictEqual(r.status, 200);
  const { rows } = await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [admin.id]);
  assert.ok(!rows[0].password_hash.includes(PASS_NUEVA), 'la contraseña no aparece en claro');
  assert.match(rows[0].password_hash, /^[0-9a-f]{32}:[0-9a-f]+$/, 'formato scrypt salt:hash, el mismo del resto del sistema');
  assert.ok(verifyPassword(PASS_NUEVA, rows[0].password_hash));
});

await t('RESET', '13. la contraseña anterior deja de funcionar y la nueva entra', async () => {
  const conVieja = await cliente().pedir('/api/auth/negocio/login', { method: 'POST', body: { email: EMAIL_ADMIN, password: PASS_ORIGINAL } });
  assert.strictEqual(conVieja.status, 401);
  const conNueva = cliente();
  const r = await conNueva.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: EMAIL_ADMIN, password: PASS_NUEVA } });
  assert.strictEqual(r.status, 200);
  const me = await conNueva.pedir('/api/auth/me');
  assert.strictEqual(me.status, 200, 'y la sesión nueva sí opera');
});

await t('RESET', '14. las sesiones abiertas con la contraseña vieja quedan revocadas', async () => {
  const me = await sesionPrevia.pedir('/api/auth/me', { cookieManual: sesionPrevia.cookie });
  assert.strictEqual(me.status, 401, 'la sesión anterior ya no sirve');
  assert.strictEqual(me.body.code, 'SESION_REVOCADA');
  const { rows } = await pool.query('SELECT sesiones_invalidas_antes FROM usuarios WHERE id = $1', [admin.id]);
  assert.ok(rows[0].sesiones_invalidas_antes, 'quedó la marca que las invalida');
});

await t('RESET', '15. el mismo enlace no sirve una segunda vez', async () => {
  const token = await sembrarToken(staff.id);
  const primera = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token, password: PASS_NUEVA, passwordConfirm: PASS_NUEVA } });
  assert.strictEqual(primera.status, 200);
  const segunda = await anon.pedir('/api/auth/negocio/reset-password', {
    method: 'POST', body: { token, password: 'OtraMas12345!', passwordConfirm: 'OtraMas12345!' } });
  assert.strictEqual(segunda.status, 409, 'ya fue utilizado');
  assert.ok(verifyPassword(PASS_NUEVA, (await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [staff.id])).rows[0].password_hash),
    'y la contraseña quedó en la del primer uso');
  const estado = await anon.pedir('/api/auth/reset-password/' + encodeURIComponent(token));
  assert.strictEqual(estado.body.estado, 'usado');
});

// ── 16-18. Quién puede y quién no ──────────────────────────────────────────
await t('ALCANCE', '16. un mesero no entra por aquí: no tiene correo y su PIN no se toca', async () => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE usuario_id = $1', [mesero.id]);
  assert.strictEqual(rows[0].n, 0, 'nunca se le generó un enlace');
  const { rows: pin } = await pool.query('SELECT pin_hash FROM usuarios WHERE id = $1', [mesero.id]);
  assert.strictEqual(pin[0].pin_hash, pinOriginal, 'el PIN sigue exactamente igual tras todos los cambios');
  const { rows: pass } = await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [mesero.id]);
  assert.strictEqual(pass[0].password_hash, null, 'y sigue sin contraseña administrativa');
});

await t('ALCANCE', '17. una cuenta desactivada no recibe enlace, y la respuesta pública no cambia', async () => {
  await pool.query('UPDATE usuarios SET activo = FALSE WHERE id = $1', [staff.id]);
  await pool.query('UPDATE password_reset_tokens SET revoked_at = NOW() WHERE usuario_id = $1 AND used_at IS NULL', [staff.id]);
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: EMAIL_STAFF } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mensaje, MENSAJE_GENERICO, 'misma respuesta que para una cuenta viva');
  const vigente = await tokenVigenteDe(staff.id);
  assert.strictEqual(vigente, null, 'pero no se generó nada');
  await pool.query('UPDATE usuarios SET activo = TRUE WHERE id = $1', [staff.id]);
});

await t('ALCANCE', '18. sin membresía activa tampoco: la respuesta sigue siendo la misma', async () => {
  await pool.query('UPDATE usuario_negocios SET activo = FALSE WHERE usuario_id = $1', [staff.id]);
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: EMAIL_STAFF } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mensaje, MENSAJE_GENERICO);
  assert.strictEqual(await tokenVigenteDe(staff.id), null);
  await pool.query('UPDATE usuario_negocios SET activo = TRUE WHERE usuario_id = $1', [staff.id]);
});

// ── 19-20. Abuso ───────────────────────────────────────────────────────────
await t('ABUSO', '19. el rate limit corta el bombardeo a un mismo buzón sin tumbar a los demás', async () => {
  const victima = 'objetivo.rate@negocio.test';
  let limitado = false;
  for (let i = 0; i < 6 && !limitado; i++) {
    const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: victima } });
    if (r.status === 429) limitado = true;
  }
  assert.ok(limitado, 'a fuerza de repetir, el mismo correo se corta');
  // Otro correo distinto sigue atendiéndose (el límite por IP es más alto).
  const otro = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: 'otra.persona@negocio.test' } });
  assert.ok(otro.status === 200 || otro.status === 429);
});

await t('ABUSO', '20. el endpoint de consumo también está limitado', async () => {
  let limitado = false;
  for (let i = 0; i < 14 && !limitado; i++) {
    const r = await anon.pedir('/api/auth/negocio/reset-password', {
      method: 'POST', body: { token: 'token-inexistente-' + i, password: PASS_NUEVA, passwordConfirm: PASS_NUEVA } });
    if (r.status === 429) limitado = true;
  }
  assert.ok(limitado, 'no se puede tantear enlaces sin freno');
});

// ── 21-22. Lo que no se puede filtrar ──────────────────────────────────────
await t('PRIVACIDAD', '21. ni la respuesta ni los logs revelan el enlace o el token', async () => {
  const r = await anon.pedir('/api/auth/negocio/forgot-password', { method: 'POST', body: { email: dora.email } });
  const cuerpo = JSON.stringify(r.body);
  assert.ok(!/token|enlace|http/i.test(cuerpo), `la respuesta no debe traer el enlace: ${cuerpo}`);
  const salida = srv.obtenerSalida();
  assert.ok(!/restablecer-contrasena\?token=/.test(salida), 'el enlace no aparece en la salida del servidor');
  const t = await tokenVigenteDe(dora.id);
  assert.ok(!salida.includes(t.token_hash), 'ni el hash del token');
});

await t('PRIVACIDAD', '22. existir y no existir son indistinguibles desde afuera', async () => {
  // Se comparan cuerpo, status y encabezados relevantes de las dos rutas.
  const conCuenta = await fetch(base + '/api/auth/negocio/forgot-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana.recuperacion+unica@negocio.test' }) });
  const sinCuenta = await fetch(base + '/api/auth/negocio/forgot-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'inexistente+unica@negocio.test' }) });
  assert.strictEqual(conCuenta.status, sinCuenta.status);
  assert.deepStrictEqual(await conCuenta.json(), await sinCuenta.json());
  assert.strictEqual(conCuenta.headers.get('set-cookie'), sinCuenta.headers.get('set-cookie'));
});

// ── 23-25. Nada de lo anterior se rompe ────────────────────────────────────
await t('COMPATIBILIDAD', '23. el login administrativo conserva su contrato', async () => {
  const vacio = await anon.pedir('/api/auth/negocio/login', { method: 'POST', body: {} });
  assert.strictEqual(vacio.status, 400);
  const malo = await anon.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: EMAIL_ADMIN, password: 'lo-que-sea' } });
  assert.strictEqual(malo.status, 401);
  assert.strictEqual(malo.body.error, 'Correo o contraseña incorrectos', 'sin decir cuál de los dos falló');
});

await t('COMPATIBILIDAD', '24. las invitaciones siguen intactas y son un flujo distinto', async () => {
  const r = await anon.pedir('/api/auth/invitacion/token-que-no-existe');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.estado, 'invalido');
  const crear = await anon.pedir('/api/auth/crear-password', {
    method: 'POST', body: { token: 'token-que-no-existe', password: PASS_NUEVA, passwordConfirm: PASS_NUEVA } });
  assert.strictEqual(crear.status, 404, 'el endpoint de invitación sigue respondiendo lo suyo');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'invitaciones_usuario'`);
  assert.strictEqual(rows[0].n, 1, 'y su tabla sigue ahí');
});

await t('COMPATIBILIDAD', '25. las páginas nuevas se sirven y su JavaScript compila como lo lee el navegador', async () => {
  for (const ruta of ['/restablecer-contrasena', '/login-negocio.html']) {
    const r = await fetch(base + ruta);
    assert.strictEqual(r.status, 200, `${ruta} debe servirse`);
    const html = (await r.text()).replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const abre = /<script\b([^>]*)>/gi;
    let m;
    while ((m = abre.exec(html)) !== null) {
      const ini = abre.lastIndex;
      const fin = html.indexOf('</script>', ini);
      const cuerpo = fin === -1 ? html.slice(ini) : html.slice(ini, fin);
      if (!/\bsrc\s*=/i.test(m[1] || '')) {
        try { new vm.Script(cuerpo, { filename: ruta }); }
        catch (e) { assert.fail(`${ruta}: script inline no compila: ${e.message}`); }
      }
      if (fin === -1) break;
      abre.lastIndex = fin + '</script>'.length;
    }
    assert.ok(!/document\.getElementById\(/.test(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')),
      `${ruta} no debe pintar código como texto`);
  }
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
