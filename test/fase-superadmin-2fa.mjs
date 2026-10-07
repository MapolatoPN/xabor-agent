// Segundo factor (TOTP) de la consola de Superadmin e IP en la bitácora
// (migración 116).
//
// Origen (7-oct-2026): una cuenta de prueba con privilegio de superadmin, y su
// contraseña escrita en el repositorio público, abría /superadmin en
// producción. La contraseña sola ya no debe bastar.
//
// Cubre:
//   ACCESO   sin segundo factor, /api/superadmin/* responde 403 2FA_REQUERIDO
//   ALTA     pide la contraseña; guarda el secreto cifrado; no se repite
//   CODIGO   código malo no abre; bueno abre; el mismo código no vale dos veces
//   ATADURA  la cookie del 2FA solo vale para SU sesión, SU usuario y SU versión
//   WS       /ws/superadmin exige lo mismo
//   BAJA     usuario desactivado o TOTP reiniciado cortan la consola en el acto
//   BITACORA cada acción de Superadmin guarda usuario e IP
//   LIMITE   el sexto intento fallido en 5 min se rechaza
//
// Crea su propio superadmin; no depende de test/.datos-prueba.json. Solo corre
// contra una base local.
import assert from 'assert';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const host = new URL(process.env.DATABASE_URL || 'postgres://x@nohost/x').hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`ABORTADO: fase-superadmin-2fa solo corre contra una base local (DATABASE_URL apunta a ${host}).`);
  process.exit(1);
}
process.env.INTEGRATIONS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ||= 'sesion-de-prueba-sa2fa';
const PUERTO = process.env.TEST_PORT_SA2FA || '4761';

const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { codigoHotp, pasoActual, desdeBase32, crearCookie2fa } = await import('../src/services/superadmin2fa.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Fixture: dos superadmins y un admin normal propios ──────────────────────
const { rows: [neg] } = await pool.query(`SELECT id FROM negocios WHERE activo ORDER BY created_at LIMIT 1`);
assert.ok(neg, 'hace falta al menos un negocio activo en la base local');
const NEG = neg.id;
const sufijo = randomUUID().slice(0, 8);
const PASSWORD = `Clave-Sa2fa-${sufijo}`;
const nuevo = async (etiqueta, superadmin) => {
  const u = await crearUsuarioConPassword({ negocioId: NEG, nombre: `Sa2fa ${etiqueta}`, email: `sa2fa-${etiqueta}-${sufijo}@test.local`, password: PASSWORD, rol: 'admin' });
  if (superadmin) await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [u.id]);
  return u.id;
};
const SUPER = await nuevo('super', true);
const SUPER2 = await nuevo('super2', true);
const SUPER3 = await nuevo('super3', true);
const ADMIN = await nuevo('admin', false);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const base = srv.base;

const sesion = (usuarioId, extra = {}) => crearTokenSesion({ usuarioId, negocioId: NEG, rol: 'admin', ...extra });
const ck = (token, sa2fa) => `xabor_sesion=${encodeURIComponent(token)}${sa2fa ? `; xabor_sa2fa=${sa2fa}` : ''}`;
// ip: simula la IP que el proxy (trust proxy 1) entrega en X-Forwarded-For,
// para que los casos de límite no compartan contador por IP con los demás.
async function api(path, { cookie, method = 'GET', body, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (ip) headers['X-Forwarded-For'] = ip;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json, setCookie: r.headers.get('set-cookie') || '' };
}
const cookie2faDe = (setCookie) => (setCookie.match(/xabor_sa2fa=([^;]+)/) || [])[1] || null;
const codigoEn = (secreto, desfase = 0) => codigoHotp(desdeBase32(secreto), pasoActual() + desfase);
const ultimaAuditoria = async (usuarioId, accion) => (await pool.query(
  `SELECT accion, ip, superadmin_id FROM auditoria_plataforma WHERE superadmin_id = $1 AND accion = $2 ORDER BY created_at DESC LIMIT 1`,
  [usuarioId, accion])).rows[0];
function upgrade(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/superadmin', { headers: cookie ? { Cookie: cookie } : {} });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); });
    ws.on('error', () => resolve('error'));
  });
}

const TOKEN = sesion(SUPER);
let SECRETO = null;
let SA2FA = null;

try {
  // ═══ ACCESO ═══
  await t('ACCESO', 'superadmin con contraseña pero sin segundo factor: 403 2FA_REQUERIDO', async () => {
    const r = await api('/api/superadmin/dashboard', { cookie: ck(TOKEN) });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body?.codigo, '2FA_REQUERIDO');
  });
  await t('ACCESO', 'admin normal: ni consola ni rutas del segundo factor', async () => {
    const t2 = sesion(ADMIN);
    assert.strictEqual((await api('/api/superadmin/dashboard', { cookie: ck(t2) })).status, 403);
    assert.strictEqual((await api('/api/superadmin-2fa/estado', { cookie: ck(t2) })).status, 403);
    assert.strictEqual((await api('/api/superadmin-2fa/alta', { cookie: ck(t2), method: 'POST', body: { password: PASSWORD } })).status, 403);
  });
  await t('ACCESO', 'sin sesión: 401; sesión de soporte: 403', async () => {
    assert.strictEqual((await api('/api/superadmin-2fa/estado')).status, 401);
    assert.strictEqual((await api('/api/superadmin-2fa/estado', { cookie: ck(sesion(SUPER, { sop: true })) })).status, 403);
  });
  await t('ACCESO', 'estado inicial: sin configurar y sin verificar', async () => {
    const r = await api('/api/superadmin-2fa/estado', { cookie: ck(TOKEN) });
    assert.deepStrictEqual(r.body, { configurado: false, verificado: false });
  });

  // ═══ ALTA ═══
  await t('ALTA', 'contraseña incorrecta: 400, sin fila y auditado', async () => {
    const r = await api('/api/superadmin-2fa/alta', { cookie: ck(TOKEN), method: 'POST', body: { password: 'otra' } });
    assert.strictEqual(r.status, 400);
    const { rowCount } = await pool.query('SELECT 1 FROM superadmin_totp WHERE usuario_id = $1', [SUPER]);
    assert.strictEqual(rowCount, 0);
    assert.ok(await ultimaAuditoria(SUPER, 'superadmin_2fa_alta_rechazada'), 'falta el rastro del intento');
  });
  await t('ALTA', 'contraseña correcta: secreto, URI otpauth y QR; en la base va cifrado', async () => {
    const r = await api('/api/superadmin-2fa/alta', { cookie: ck(TOKEN), method: 'POST', body: { password: PASSWORD } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    SECRETO = r.body.secreto;
    assert.match(SECRETO, /^[A-Z2-7]{32}$/);
    assert.ok(r.body.uri.startsWith('otpauth://totp/') && r.body.uri.includes(`secret=${SECRETO}`));
    assert.ok(String(r.body.qr).startsWith('data:image/png;base64,'), 'sin QR');
    const { rows: [f] } = await pool.query('SELECT estado, secreto_cifrado FROM superadmin_totp WHERE usuario_id = $1', [SUPER]);
    assert.strictEqual(f.estado, 'pendiente');
    assert.ok(!f.secreto_cifrado.includes(SECRETO), 'el secreto quedó en claro en la base');
  });
  await t('ALTA', 'alta pendiente: la consola sigue cerrada, aun con una cookie de esa versión', async () => {
    const r = await api('/api/superadmin/dashboard', { cookie: ck(TOKEN) });
    assert.strictEqual(r.status, 403);
    // Una cookie bien firmada para la versión PENDIENTE (nadie la emite, pero
    // la consola no puede depender de eso): el TOTP sin confirmar no abre.
    const { rows: [f] } = await pool.query('SELECT version FROM superadmin_totp WHERE usuario_id = $1', [SUPER]);
    const forjada = crearCookie2fa({ usuarioId: SUPER, tokenSesion: TOKEN, version: f.version }).valor;
    assert.strictEqual((await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, forjada) })).status, 403);
  });

  // ═══ CODIGO ═══
  await t('CODIGO', 'código incorrecto: 400 y auditado; la consola sigue cerrada', async () => {
    const malo = codigoEn(SECRETO) === '000000' ? '111111' : '000000';
    const r = await api('/api/superadmin-2fa/verificar', { cookie: ck(TOKEN), method: 'POST', body: { codigo: malo } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(cookie2faDe(r.setCookie), null);
    assert.ok(await ultimaAuditoria(SUPER, 'superadmin_2fa_fallido'));
  });
  await t('CODIGO', 'código correcto: confirma el alta, da la cookie y abre la consola', async () => {
    const r = await api('/api/superadmin-2fa/verificar', { cookie: ck(TOKEN), method: 'POST', body: { codigo: codigoEn(SECRETO) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    SA2FA = cookie2faDe(r.setCookie);
    assert.ok(SA2FA, 'no llegó la cookie xabor_sa2fa');
    assert.match(r.setCookie, /HttpOnly/i);
    const d = await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, SA2FA) });
    assert.strictEqual(d.status, 200);
    const e = await api('/api/superadmin-2fa/estado', { cookie: ck(TOKEN, SA2FA) });
    assert.deepStrictEqual(e.body, { configurado: true, verificado: true });
    const a = await ultimaAuditoria(SUPER, 'superadmin_2fa_alta_confirmada');
    assert.ok(a?.ip, 'la confirmación no guardó la IP');
  });
  await t('CODIGO', 'el mismo código no vale dos veces', async () => {
    const r = await api('/api/superadmin-2fa/verificar', { cookie: ck(sesion(SUPER)), method: 'POST', body: { codigo: codigoEn(SECRETO) } });
    assert.strictEqual(r.status, 400);
  });
  await t('CODIGO', 'dos peticiones simultáneas con un mismo código nuevo: solo una entra', async () => {
    // Superadmin propio y otra IP: el límite de 5 intentos no debe confundirse
    // con la anti-repetición. Alta + confirmación con el código del paso
    // actual; las 4 simultáneas usan el del paso siguiente (la ventana admite
    // ±1), que nadie ha usado.
    const ip = '10.0.0.3', t3 = sesion(SUPER3);
    const alta = await api('/api/superadmin-2fa/alta', { cookie: ck(t3), method: 'POST', body: { password: PASSWORD }, ip });
    assert.strictEqual(alta.status, 200);
    assert.strictEqual((await api('/api/superadmin-2fa/verificar', { cookie: ck(t3), method: 'POST', body: { codigo: codigoEn(alta.body.secreto) }, ip })).status, 200);
    const codigo = codigoEn(alta.body.secreto, 1);
    const pedir = () => api('/api/superadmin-2fa/verificar', { cookie: ck(sesion(SUPER3)), method: 'POST', body: { codigo }, ip });
    const estados = (await Promise.all([pedir(), pedir(), pedir(), pedir()])).map(r => r.status).sort();
    assert.deepStrictEqual(estados, [200, 400, 400, 400]);
  });
  await t('ALTA', 'con el segundo factor confirmado, la web ya no permite otra alta', async () => {
    const r = await api('/api/superadmin-2fa/alta', { cookie: ck(TOKEN, SA2FA), method: 'POST', body: { password: PASSWORD } });
    assert.strictEqual(r.status, 409);
  });

  // ═══ ATADURA ═══
  await t('ATADURA', 'la cookie del 2FA no sirve con otra sesión del mismo usuario', async () => {
    const r = await api('/api/superadmin/dashboard', { cookie: ck(sesion(SUPER), SA2FA) });
    assert.strictEqual(r.body?.codigo, '2FA_REQUERIDO');
  });
  await t('ATADURA', 'ni con la sesión de otro superadmin', async () => {
    const r = await api('/api/superadmin/dashboard', { cookie: ck(sesion(SUPER2), SA2FA) });
    assert.strictEqual(r.status, 403);
  });
  await t('ATADURA', 'una cookie alterada o firmada con otra versión no abre', async () => {
    const [b64, sig] = SA2FA.split('.');
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString());
    const alterada = Buffer.from(JSON.stringify({ ...p, exp: p.exp + 1 })).toString('base64url') + '.' + sig;
    assert.strictEqual((await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, alterada) })).status, 403);
    const otraVersion = crearCookie2fa({ usuarioId: SUPER, tokenSesion: TOKEN, version: p.v + 1 }).valor;
    assert.strictEqual((await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, otraVersion) })).status, 403);
  });

  // ═══ WS ═══
  await t('WS', '/ws/superadmin: sin segundo factor 403, con él abre', async () => {
    assert.strictEqual(await upgrade(ck(TOKEN)), 403);
    assert.strictEqual(await upgrade(ck(TOKEN, SA2FA)), 101);
  });

  // ═══ BITACORA ═══
  await t('BITACORA', 'una acción de Superadmin queda con su usuario y su IP', async () => {
    const { rows: [n] } = await pool.query('SELECT plan FROM negocios WHERE id = $1', [NEG]);
    const otro = n.plan === 'pro' ? 'basico' : 'pro';
    try {
      const r = await api(`/api/superadmin/negocios/${NEG}/plan`, { cookie: ck(TOKEN, SA2FA), method: 'PATCH', body: { plan: otro } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const { rows: [a] } = await pool.query(
        `SELECT superadmin_id, ip FROM auditoria_plataforma WHERE negocio_id = $1 AND superadmin_id = $2 ORDER BY created_at DESC LIMIT 1`, [NEG, SUPER]);
      assert.ok(a, 'la acción no quedó en la bitácora');
      assert.strictEqual(a.superadmin_id, SUPER);
      assert.match(String(a.ip), /127\.0\.0\.1|::1/, `IP inesperada: ${a.ip}`);
    } finally {
      await pool.query('UPDATE negocios SET plan = $2 WHERE id = $1', [NEG, n.plan]);
    }
  });

  // ═══ BAJA ═══
  await t('BAJA', 'usuario desactivado: la consola se cierra aunque traiga el segundo factor', async () => {
    await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [SUPER]);
    try {
      const r = await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, SA2FA) });
      assert.strictEqual(r.status, 403);
      assert.notStrictEqual(r.body?.codigo, '2FA_REQUERIDO');
    } finally { await pool.query('UPDATE usuarios SET activo = true WHERE id = $1', [SUPER]); }
    assert.strictEqual((await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, SA2FA) })).status, 200);
  });
  await t('BAJA', 'reiniciar el TOTP corta en el acto la sesión ya verificada', async () => {
    await pool.query('DELETE FROM superadmin_totp WHERE usuario_id = $1', [SUPER]);
    const r = await api('/api/superadmin/dashboard', { cookie: ck(TOKEN, SA2FA) });
    assert.strictEqual(r.body?.codigo, '2FA_REQUERIDO');
    const e = await api('/api/superadmin-2fa/estado', { cookie: ck(TOKEN) });
    assert.deepStrictEqual(e.body, { configurado: false, verificado: false });
  });

  // ═══ LIMITE ═══ (al final: el contador vive en memoria del servidor)
  await t('LIMITE', 'sexto código fallido en 5 minutos: 429', async () => {
    const t2 = sesion(SUPER2);
    const ip = '10.0.0.2';
    const alta = await api('/api/superadmin-2fa/alta', { cookie: ck(t2), method: 'POST', body: { password: PASSWORD }, ip });
    assert.strictEqual(alta.status, 200);
    const malo = codigoEn(alta.body.secreto) === '000000' ? '111111' : '000000';
    const estados = [];
    for (let i = 0; i < 6; i++) {
      estados.push((await api('/api/superadmin-2fa/verificar', { cookie: ck(t2), method: 'POST', body: { codigo: malo }, ip })).status);
    }
    assert.deepStrictEqual(estados, [400, 400, 400, 400, 400, 429]);
  });
} finally {
  srv.detener();
  await pool.query('DELETE FROM superadmin_totp WHERE usuario_id = ANY($1::uuid[])', [[SUPER, SUPER2, SUPER3]]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { for (const f of fallos) console.log('  - ' + f); process.exit(1); }
