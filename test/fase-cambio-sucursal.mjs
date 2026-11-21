// Cambio de sucursal en la misma sesión (21-nov-2026, pedido de Mario).
//
// Garantías:
//  A. La lista de sucursales a las que se puede ir sale SOLO de las membresías
//     activas del usuario (negocio activo, usuario activo, rol admin/staff).
//  B. El login sigue preguntando sucursal a quien tiene varias y entra directo
//     a quien tiene una; el cambio dentro del panel valida el destino contra la
//     lista (nada que mande el navegador la amplía), no alarga la sesión
//     (conserva iat/exp), cierra la sesión anterior y no aplica a soporte.
//  C. Candado entre pestañas: con X-Xabor-Negocio de otra sucursal, la cookie
//     no se atiende (409 SUCURSAL_CAMBIADA); sin la cabecera, todo igual.
//  D. Panel: carga el script con su huella, tiene el lugar del botón, apiFetch
//     manda la cabecera, y en un navegador real dos pestañas convergen a la
//     misma sucursal (la vieja se recarga sola o se frena con 409).
//  E. Guion de datos (scripts/ops/acceso-sucursal-2026-11/dueno.mjs): estado,
//     simulacro, aplicar con respaldo, crear con invitación y revertir.
//
// Uso: DATABASE_URL (base de PRUEBA, nunca Railway), PANEL_SECRET,
// SESSION_SECRET, ADMIN_PASSWORD, PANEL_PASSWORD; migraciones + seed
// (test/.datos-prueba.json). Puerto: TEST_PORT_CAMBIO_SUC (por omisión 4791).
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

for (const v of ['DATABASE_URL', 'PANEL_SECRET', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'PANEL_PASSWORD']) {
  if (!process.env[v]) { console.error(`Falta ${v}`); process.exit(2); }
}
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool } = await import('../src/services/database.js');
const { hashPassword } = await import('../src/services/password.js');
const { crearTokenSesion, verificarTokenSesion, reemitirTokenSesion } = await import('../src/services/session.js');
const { sucursalesParaCambio, crearCandadoSucursal, CODIGO_SUCURSAL_CAMBIADA } = await import('../src/services/cambioSucursal.js');
const { crearSesionSoporte } = await import('../src/services/centralOperaciones.js');
const { arrancarServidor } = await import('./lib-servidor.mjs');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const CASOS = process.env.CASOS ? new RegExp(process.env.CASOS) : null;
const caso = (nombre, fn) => (CASOS && !CASOS.test(nombre) ? Promise.resolve() : t(nombre, fn));

// ─── Fixtures ────────────────────────────────────────────────────────────────
const SUF = Date.now().toString(36);
const PASS = 'clave-de-prueba-cambio-1';
const neg = {};
const usr = {};
async function crearNegocio(clave, nombre, activo = true) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug, activo) VALUES ($1, $2, $3) RETURNING id`,
    [nombre, `cambio-suc-${clave}-${SUF}`, activo]);
  neg[clave] = n.id;
}
async function crearUsuario(clave, nombre, membresias, { activo = true } = {}) {
  const email = `cambio-${clave}-${SUF}@test.local`;
  const primera = neg[membresias[0][0]];
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [primera, nombre, email, hashPassword(PASS), activo]);
  for (const [n, rol, act = true] of membresias) {
    await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, $4)`, [u.id, neg[n], rol, act]);
  }
  usr[clave] = { id: u.id, email };
}

await crearNegocio('obi', `Mapolato Prueba ${SUF} Obispado`);
await crearNegocio('acu', `Mapolato Prueba ${SUF} Acuña`);
await crearNegocio('apagada', `Mapolato Prueba ${SUF} Cerrada`, false);
await crearNegocio('ajena', `Otra Marca ${SUF}`);
await crearNegocio('mesa', `Mapolato Prueba ${SUF} Mesas`);
// El dueño: admin de Obispado y Acuña; además membresía en una sucursal
// apagada, una membresía apagada y una de mesero (ninguna de esas cuenta).
await crearUsuario('dueno', 'Dueño de prueba', [['obi', 'admin'], ['acu', 'admin'], ['apagada', 'admin'], ['ajena', 'admin', false], ['mesa', 'mesero']]);
await crearUsuario('encargada', 'Encargada de prueba', [['obi', 'admin']]);
await crearUsuario('cajera', 'Cajera de dos', [['obi', 'staff'], ['acu', 'staff']]);
await crearUsuario('apagado', 'Cuenta apagada', [['obi', 'admin'], ['acu', 'admin']], { activo: false });

// ─── Servidor ────────────────────────────────────────────────────────────────
const PUERTO = process.env.TEST_PORT_CAMBIO_SUC || '4791';
const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const BASE = srv.base;

const cookieDe = (r) => {
  const sc = r.headers.get('set-cookie') || '';
  const m = sc.match(/xabor_sesion=([^;]*)/);
  // Una cookie vacía es la de borrado (Max-Age=0): no es una sesión.
  return m && m[1] ? decodeURIComponent(m[1]) : null;
};
async function pedir(ruta, { token, metodo = 'GET', cuerpo, cabeceras = {} } = {}) {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `xabor_sesion=${encodeURIComponent(token)}` } : {}), ...cabeceras },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  let datos = null;
  try { datos = await r.json(); } catch {}
  return { status: r.status, datos, token: cookieDe(r) };
}
async function entrar(clave, negocioId) {
  const r1 = await pedir('/api/auth/negocio/login', { metodo: 'POST', cuerpo: { email: usr[clave].email, password: PASS } });
  if (r1.token) return { ...r1, primera: r1 };
  if (!negocioId) return { ...r1, primera: r1 };
  const r2 = await pedir('/api/auth/negocio/login', { metodo: 'POST', cuerpo: { preAuth: r1.datos.preAuth, negocioId } });
  return { ...r2, primera: r1 };
}
const payloadDe = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

let navegador = null;
try {
  // ── A. Lista de sucursales ─────────────────────────────────────────────────
  await caso('A1. el dueño puede ir solo a Obispado y Acuña (no a la apagada, ni a la membresía apagada, ni donde es mesero)', async () => {
    const l = await sucursalesParaCambio(usr.dueno.id, neg.obi);
    assert.deepStrictEqual(l.map((s) => s.negocioId).sort(), [neg.obi, neg.acu].sort());
    assert.deepStrictEqual(l.map((s) => s.etiqueta), ['Acuña', 'Obispado'], 'etiquetas cortas ordenadas');
    assert.strictEqual(l.find((s) => s.actual).negocioId, neg.obi);
    assert.ok(l.every((s) => s.rol === 'admin'));
  });
  await caso('A2. la encargada solo tiene su sucursal; la cuenta apagada no tiene ninguna', async () => {
    assert.strictEqual((await sucursalesParaCambio(usr.encargada.id, neg.obi)).length, 1);
    assert.strictEqual((await sucursalesParaCambio(usr.apagado.id, neg.obi)).length, 0);
    assert.strictEqual((await sucursalesParaCambio(null, neg.obi)).length, 0);
  });

  // ── B. Login y cambio ──────────────────────────────────────────────────────
  let sesionObi = null;
  await caso('B1. el login le pregunta la sucursal al dueño, solo con sus dos sucursales', async () => {
    const r = await pedir('/api/auth/negocio/login', { metodo: 'POST', cuerpo: { email: usr.dueno.email, password: PASS } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.datos.requiereSeleccion, true);
    assert.strictEqual(r.token, null, 'no debe emitir sesión antes de elegir');
    const ids = r.datos.negocios.map((n) => n.negocioId);
    assert.ok(ids.includes(neg.obi) && ids.includes(neg.acu), 'faltan sus sucursales');
    assert.ok(!ids.includes(neg.apagada) && !ids.includes(neg.ajena), 'aparecen sucursales que no debe ver');
    const r2 = await pedir('/api/auth/negocio/login', { metodo: 'POST', cuerpo: { preAuth: r.datos.preAuth, negocioId: neg.obi } });
    assert.strictEqual(r2.status, 200);
    assert.ok(r2.token, 'sin cookie de sesión');
    sesionObi = r2.token;
  });
  await caso('B2. la encargada entra directo a su sucursal y no ve opción de cambio', async () => {
    const r = await entrar('encargada');
    assert.strictEqual(r.status, 200);
    assert.ok(r.token && !r.datos.requiereSeleccion, 'debió entrar directo');
    const s = await pedir('/api/auth/sucursales', { token: r.token });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.datos.puedeCambiar, false);
    const c = await pedir('/api/auth/cambiar-sucursal', { token: r.token, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    assert.strictEqual(c.status, 403);
    assert.strictEqual(c.datos.code, 'SUCURSAL_NO_PERMITIDA');
    assert.strictEqual(c.token, null, 'no debió emitir cookie');
  });
  await caso('B3. GET /api/auth/sucursales del dueño: puede cambiar, dos sucursales, la actual marcada', async () => {
    const s = await pedir('/api/auth/sucursales', { token: sesionObi });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.datos.puedeCambiar, true);
    assert.strictEqual(s.datos.sucursales.length, 2);
    assert.strictEqual(s.datos.sucursales.find((x) => x.actual).negocioId, neg.obi);
    const sin = await pedir('/api/auth/sucursales');
    assert.strictEqual(sin.status, 401, 'sin sesión debe ser 401');
  });
  let sesionAcu = null;
  await caso('B4. cambiar a Acuña: nueva cookie de Acuña, mismo login (iat/exp iguales), /api/auth/me ya dice Acuña', async () => {
    const c = await pedir('/api/auth/cambiar-sucursal', { token: sesionObi, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.datos));
    assert.strictEqual(c.datos.negocioId, neg.acu);
    assert.strictEqual(c.datos.etiqueta, 'Acuña');
    assert.ok(c.token && c.token !== sesionObi, 'sin cookie nueva');
    const antes = payloadDe(sesionObi), despues = payloadDe(c.token);
    assert.strictEqual(despues.negocioId, neg.acu);
    assert.strictEqual(despues.usuarioId, antes.usuarioId);
    assert.strictEqual(despues.iat, antes.iat, 'el cambio no es un login nuevo: iat igual');
    assert.strictEqual(despues.exp, antes.exp, 'el cambio no alarga la sesión: exp igual');
    const me = await pedir('/api/auth/me', { token: c.token });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.datos.negocioId, neg.acu);
    assert.strictEqual(me.datos.rol, 'admin');
    sesionAcu = c.token;
  });
  await caso('B5. la sesión anterior (Obispado) queda cerrada', async () => {
    const me = await pedir('/api/auth/me', { token: sesionObi });
    assert.strictEqual(me.status, 401);
  });
  await caso('B6. destinos que no son suyos: sucursal apagada, membresía apagada, mesero, negocio ajeno, uuid inventado, vacío', async () => {
    const otro = (await entrar('dueno', neg.obi)).token;
    for (const [destino, esperado] of [[neg.apagada, 403], [neg.ajena, 403], [neg.mesa, 403], [SEED.negocioA, 403], ['00000000-0000-4000-8000-000000000000', 403], ['', 400]]) {
      const c = await pedir('/api/auth/cambiar-sucursal', { token: otro, metodo: 'POST', cuerpo: { negocioId: destino } });
      assert.strictEqual(c.status, esperado, `destino ${destino || '(vacío)'} → ${c.status}`);
      assert.strictEqual(c.token, null, `destino ${destino || '(vacío)'} emitió cookie`);
    }
    const me = await pedir('/api/auth/me', { token: otro });
    assert.strictEqual(me.datos.negocioId, neg.obi, 'un intento fallido no debe mover la sesión');
  });
  await caso('B7. cambiar a la misma sucursal no reemite nada', async () => {
    const c = await pedir('/api/auth/cambiar-sucursal', { token: sesionAcu, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.datos.sinCambio, true);
    assert.strictEqual(c.token, null);
  });
  await caso('B8. la cajera con dos sucursales cambia y sigue de operador (staff) en la otra', async () => {
    const r = await entrar('cajera', neg.obi);
    const c = await pedir('/api/auth/cambiar-sucursal', { token: r.token, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.datos.rol, 'staff');
    assert.strictEqual(payloadDe(c.token).rol, 'staff');
  });
  await caso('B9. tras un cambio de contraseña, la sesión vieja no puede cambiar de sucursal', async () => {
    const r = await entrar('dueno', neg.obi);
    // La marca con el reloj de ESTE proceso (el del servidor), no el de la base.
    await pool.query(`UPDATE usuarios SET sesiones_invalidas_antes = $2 WHERE id = $1`, [usr.dueno.id, new Date(payloadDe(r.token).iat + 1000)]);
    try {
      const c = await pedir('/api/auth/cambiar-sucursal', { token: r.token, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
      assert.strictEqual(c.status, 401);
      assert.strictEqual(c.token, null);
    } finally {
      await pool.query(`UPDATE usuarios SET sesiones_invalidas_antes = NULL WHERE id = $1`, [usr.dueno.id]);
    }
  });
  await caso('B10. quitarle la membresía de Acuña corta la sesión ya cambiada a Acuña', async () => {
    const r = await entrar('dueno', neg.obi);
    const c = await pedir('/api/auth/cambiar-sucursal', { token: r.token, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    await pool.query(`UPDATE usuario_negocios SET activo = false WHERE usuario_id = $1 AND negocio_id = $2`, [usr.dueno.id, neg.acu]);
    try {
      const me = await pedir('/api/auth/me', { token: c.token });
      assert.strictEqual(me.status, 403);
      const s = await pedir('/api/auth/sucursales', { token: r.token });
      assert.strictEqual(s.status, 401, 'la de Obispado ya estaba cerrada');
    } finally {
      await pool.query(`UPDATE usuario_negocios SET activo = true WHERE usuario_id = $1 AND negocio_id = $2`, [usr.dueno.id, neg.acu]);
    }
  });
  await caso('B11. una sesión de soporte (Superadmin) no cambia de sucursal ni ve la lista', async () => {
    const sop = await crearSesionSoporte(SEED.superadminUsuarioId, neg.obi, 'prueba cambio de sucursal');
    assert.ok(sop && sop.token, 'no se pudo crear la sesión de soporte');
    const s = await pedir('/api/auth/sucursales', { token: sop.token });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.datos.puedeCambiar, false);
    const c = await pedir('/api/auth/cambiar-sucursal', { token: sop.token, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    assert.strictEqual(c.status, 403);
    assert.strictEqual(c.datos.code, 'SOPORTE_NO_CAMBIA');
    assert.strictEqual(c.token, null);
  });
  await caso('B13. ida y vuelta (Obispado → Acuña → Obispado): la sesión de regreso funciona y las dos anteriores quedan cerradas', async () => {
    const r = await entrar('dueno', neg.obi);
    const ida = await pedir('/api/auth/cambiar-sucursal', { token: r.token, metodo: 'POST', cuerpo: { negocioId: neg.acu } });
    assert.strictEqual(ida.status, 200);
    const vuelta = await pedir('/api/auth/cambiar-sucursal', { token: ida.token, metodo: 'POST', cuerpo: { negocioId: neg.obi } });
    assert.strictEqual(vuelta.status, 200);
    assert.ok(vuelta.token && vuelta.token !== r.token, 'el token de regreso no puede ser el del login (ya cerrado)');
    const me = await pedir('/api/auth/me', { token: vuelta.token });
    assert.strictEqual(me.status, 200, 'la sesión de regreso quedó cerrada');
    assert.strictEqual(me.datos.negocioId, neg.obi);
    assert.strictEqual((await pedir('/api/auth/me', { token: r.token })).status, 401);
    assert.strictEqual((await pedir('/api/auth/me', { token: ida.token })).status, 401);
  });
  await caso('B12. reemitirTokenSesion no reemite soporte, estación, caducada ni sin destino', async () => {
    const base = verificarTokenSesion(crearTokenSesion({ usuarioId: usr.dueno.id, negocioId: neg.obi, rol: 'admin' }));
    assert.ok(reemitirTokenSesion(base, { negocioId: neg.acu, rol: 'admin' }));
    assert.strictEqual(reemitirTokenSesion({ ...base, sop: true }, { negocioId: neg.acu, rol: 'admin' }), null);
    assert.strictEqual(reemitirTokenSesion({ ...base, est: true }, { negocioId: neg.acu, rol: 'admin' }), null);
    assert.strictEqual(reemitirTokenSesion({ ...base, exp: Date.now() - 1 }, { negocioId: neg.acu, rol: 'admin' }), null);
    assert.strictEqual(reemitirTokenSesion(base, { negocioId: '', rol: 'admin' }), null);
    assert.strictEqual(reemitirTokenSesion(null, { negocioId: neg.acu, rol: 'admin' }), null);
  });

  // ── C. Candado entre pestañas ──────────────────────────────────────────────
  await caso('C1. con la cookie en Acuña, una petición que dice venir de un panel de Obispado recibe 409', async () => {
    const r = await entrar('dueno', neg.acu);
    const conVieja = await pedir('/api/auth/me', { token: r.token, cabeceras: { 'X-Xabor-Negocio': neg.obi } });
    assert.strictEqual(conVieja.status, 409);
    assert.strictEqual(conVieja.datos.code, CODIGO_SUCURSAL_CAMBIADA);
    // Una escritura real del panel tampoco pasa.
    const escritura = await pedir('/api/auth/cambiar-sucursal', { token: r.token, metodo: 'POST', cuerpo: { negocioId: neg.obi }, cabeceras: { 'X-Xabor-Negocio': neg.obi } });
    assert.strictEqual(escritura.status, 409);
    assert.strictEqual(escritura.token, null, 'el candado no debe dejar pasar el cambio');
    const igual = await pedir('/api/auth/me', { token: r.token, cabeceras: { 'X-Xabor-Negocio': neg.acu } });
    assert.strictEqual(igual.status, 200);
    const sinCabecera = await pedir('/api/auth/me', { token: r.token });
    assert.strictEqual(sinCabecera.status, 200);
  });
  await caso('C2. el candado nunca autoriza: sin cookie o con cookie inválida responde lo de siempre (401)', async () => {
    assert.strictEqual((await pedir('/api/auth/me', { cabeceras: { 'X-Xabor-Negocio': neg.obi } })).status, 401);
    assert.strictEqual((await pedir('/api/auth/me', { token: 'x.y', cabeceras: { 'X-Xabor-Negocio': neg.obi } })).status, 401);
  });
  await caso('C3. el middleware del candado, aislado', async () => {
    const candado = crearCandadoSucursal({ leerToken: (req) => req.token, verificarToken: (t) => (t === 'ok' ? { negocioId: 'A' } : null) });
    const correr = (req) => { let estado = 'next'; const res = { status: (s) => ({ json: () => { estado = s; } }) }; candado(req, res, () => {}); return estado; };
    assert.strictEqual(correr({ headers: {}, token: 'ok' }), 'next');
    assert.strictEqual(correr({ headers: { 'x-xabor-negocio': 'A' }, token: 'ok' }), 'next');
    assert.strictEqual(correr({ headers: { 'x-xabor-negocio': 'B' }, token: 'ok' }), 409);
    assert.strictEqual(correr({ headers: { 'x-xabor-negocio': 'B' }, token: 'malo' }), 'next');
  });

  // ── D. Panel ───────────────────────────────────────────────────────────────
  const PANEL = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
  const MODULO = readFileSync(join(RAIZ, 'panel', 'cambio-sucursal.js'), 'utf8');
  await caso('D1. index.html carga cambio-sucursal.js con la huella de su contenido', () => {
    const v = createHash('sha256').update(MODULO).digest('hex').slice(0, 8);
    assert.ok(PANEL.includes(`/cambio-sucursal.js?v=${v}"`), `falta <script src="/cambio-sucursal.js?v=${v}">`);
  });
  await caso('D2. la cabecera trae el lugar del botón, oculto hasta que el módulo lo pinte', () => {
    assert.ok(/<button class="header-btn" id="btn-sucursal" type="button" hidden><\/button>/.test(PANEL));
  });
  await caso('D3. apiFetch manda X-Xabor-Negocio con la sucursal cargada y recarga ante 409 SUCURSAL_CAMBIADA', () => {
    const cuerpo = PANEL.slice(PANEL.indexOf('function apiFetch('), PANEL.indexOf('function irALogin('));
    assert.ok(cuerpo.includes(`...(NEGOCIO_ID ? { 'X-Xabor-Negocio': NEGOCIO_ID } : {})`), 'apiFetch sin la cabecera');
    assert.ok(/SUCURSAL_CAMBIADA[\s\S]{0,80}XaborCambioSucursal\.recargar\(\)/.test(cuerpo), 'apiFetch no recarga ante el 409');
  });
  await caso('D4. el panel arranca el módulo tras /api/auth/me y la reconexión del WebSocket revisa la sucursal', () => {
    assert.ok(/NEGOCIO_ID = data\.negocioId;[\s\S]{0,400}XaborCambioSucursal\.iniciar\(/.test(PANEL), 'no arranca el módulo');
    const onclose = PANEL.slice(PANEL.indexOf('ws.onclose = () => {'), PANEL.indexOf('ws.onerror'));
    assert.ok(/d\.negocioId !== NEGOCIO_ID[\s\S]{0,120}recargar\(\)/.test(onclose), 'la reconexión no compara la sucursal');
  });

  let puppeteer = null;
  try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
  if (!puppeteer) {
    await caso('D5. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await navegador.createBrowserContext();
    const r = await entrar('dueno', neg.obi);
    await ctx.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(r.token), url: BASE, httpOnly: true, sameSite: 'Lax' });
    const abrir = async () => {
      const p = await ctx.newPage();
      await p.setViewport({ width: 1280, height: 800 });
      p.on('dialog', (d) => d.accept());
      await p.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => { const b = document.getElementById('btn-sucursal'); return b && !b.hidden; }, { timeout: 20000, polling: 200 });
      return p;
    };
    const etiqueta = (p) => p.$eval('#btn-sucursal .suc-nombre', (e) => e.textContent);
    let p1 = null, p2 = null;
    await caso('D5. con dos sucursales el botón aparece con la actual («Obispado»)', async () => {
      p1 = await abrir();
      p2 = await abrir();
      assert.strictEqual(await etiqueta(p1), 'Obispado');
      assert.strictEqual(await etiqueta(p2), 'Obispado');
    });
    await caso('D6. el menú lista las dos, marca la actual y no la deja elegir', async () => {
      await p1.bringToFront();
      await p1.click('#btn-sucursal');
      await p1.waitForSelector('#menu-sucursal:not([hidden])');
      const items = await p1.$$eval('#menu-sucursal button', (bs) => bs.map((b) => ({ texto: b.textContent, marcado: b.getAttribute('aria-checked'), deshabilitado: b.disabled })));
      assert.strictEqual(items.length, 2);
      const actual = items.find((i) => i.marcado === 'true');
      assert.ok(actual && actual.texto.includes('Obispado') && actual.deshabilitado, JSON.stringify(items));
    });
    await caso('D7. elegir Acuña recarga ESTA pestaña en Acuña y la otra pestaña se recarga sola', async () => {
      const recarga2 = p2.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
      const recarga1 = p1.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await p1.evaluate(() => [...document.querySelectorAll('#menu-sucursal button')].find((b) => b.textContent.includes('Acuña')).click());
      await recarga1;
      await recarga2;
      for (const p of [p1, p2]) {
        await p.waitForFunction(() => { const b = document.getElementById('btn-sucursal'); return b && !b.hidden; }, { timeout: 20000, polling: 200 });
        assert.strictEqual(await etiqueta(p), 'Acuña');
        assert.strictEqual(await p.evaluate(() => NEGOCIO_ID), await p1.evaluate(() => NEGOCIO_ID));
      }
    });
    await caso('D8. una pestaña que no se enteró (sin aviso) no escribe en la otra sucursal: su apiFetch recibe 409 y se recarga', async () => {
      // Otra pestaña cambia la sesión SIN avisar (como lo haría el login en
      // otra pestaña, o una pestaña dormida que se perdió el aviso). La
      // recarga de p2 se sustituye por una marca para poder leerla.
      await p2.evaluate(() => { window.XaborCambioSucursal.recargar = () => { window.__recargaPedida = true; }; });
      const c = await p1.evaluate(async (destino) => {
        const r = await fetch('/api/auth/cambiar-sucursal', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ negocioId: destino }) });
        return r.status;
      }, neg.obi);
      assert.strictEqual(c, 200);
      const resp = await p2.evaluate(async () => { const r = await apiFetch('/api/auth/sucursales'); await new Promise((s) => setTimeout(s, 50)); return { status: r.status, recarga: !!window.__recargaPedida }; });
      assert.strictEqual(resp.status, 409, 'la pestaña vieja debió recibir 409');
      assert.strictEqual(resp.recarga, true, 'el panel debió pedir recargarse');
    });
    await caso('D9. la encargada (una sola sucursal) no ve el botón', async () => {
      const ctx2 = await navegador.createBrowserContext();
      try {
        const r2 = await entrar('encargada');
        await ctx2.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(r2.token), url: BASE, httpOnly: true, sameSite: 'Lax' });
        const p = await ctx2.newPage();
        p.on('dialog', (d) => d.accept());
        let pidioSucursales = false;
        p.on('response', (resp) => { if (resp.url().endsWith('/api/auth/sucursales')) pidioSucursales = true; });
        await p.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
        await p.waitForFunction(() => typeof NEGOCIO_ID !== 'undefined' && !!NEGOCIO_ID, { timeout: 20000, polling: 200 });
        const inicio = Date.now();
        while (!pidioSucursales && Date.now() - inicio < 10000) await new Promise((s) => setTimeout(s, 100));
        await new Promise((s) => setTimeout(s, 400));
        assert.ok(pidioSucursales, 'el panel no preguntó sus sucursales');
        assert.strictEqual(await p.$eval('#btn-sucursal', (b) => b.hidden), true, 'el botón se ve con una sola sucursal');
      } finally {
        await ctx2.close().catch(() => {});
      }
    });
  }

  // ── E. Guion de datos ──────────────────────────────────────────────────────
  const GUION = join(RAIZ, 'scripts', 'ops', 'acceso-sucursal-2026-11', 'dueno.mjs');
  const respaldo = mkdtempSync(join(tmpdir(), 'dueno-'));
  const correr = (...args) => {
    const r = spawnSync(process.execPath, [GUION, ...args, `--respaldo=${respaldo}`], { cwd: RAIZ, env: process.env, encoding: 'utf8' });
    return { codigo: r.status, salida: (r.stdout || '') + (r.stderr || '') };
  };
  const membresia = async (u, n) => (await pool.query(`SELECT rol, activo FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2`, [u, n])).rows[0] || null;
  const slug = async (clave) => (await pool.query(`SELECT slug FROM negocios WHERE id = $1`, [neg[clave]])).rows[0].slug;
  const SLUG_OBI = await slug('obi'), SLUG_ACU = await slug('acu');
  await caso('E1. estado lee sin escribir y dice a dónde entra cada cuenta', async () => {
    const r = correr('estado', `--correos=${usr.dueno.email},${usr.encargada.email},nadie-${SUF}@test.local`);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.ok(r.salida.includes('elige entre'), r.salida);
    assert.ok(r.salida.includes('entra directo'), r.salida);
    assert.ok(r.salida.includes('NO EXISTE'), r.salida);
  });
  await caso('E2. dar en simulacro no cambia nada; con --aplicar deja respaldo y la encargada administra las dos; revertir la regresa', async () => {
    const s = correr('dar', `--correo=${usr.encargada.email}`, `--sucursales=${SLUG_OBI},${SLUG_ACU}`);
    assert.strictEqual(s.codigo, 0, s.salida);
    assert.ok(s.salida.includes('SIMULACRO'));
    assert.strictEqual(await membresia(usr.encargada.id, neg.acu), null, 'el simulacro escribió');
    const a = correr('dar', `--correo=${usr.encargada.email}`, `--sucursales=${SLUG_OBI},${SLUG_ACU}`, '--aplicar');
    assert.strictEqual(a.codigo, 0, a.salida);
    assert.deepStrictEqual(await membresia(usr.encargada.id, neg.acu), { rol: 'admin', activo: true });
    const archivo = readdirSync(respaldo).find((f) => f.startsWith(`dueno-${usr.encargada.id.slice(0, 8)}`));
    assert.ok(archivo, 'sin respaldo');
    const v = correr('revertir', `--desde=${join(respaldo, archivo)}`, '--aplicar');
    assert.strictEqual(v.codigo, 0, v.salida);
    assert.strictEqual(await membresia(usr.encargada.id, neg.acu), null, 'la reversa no quitó la membresía');
    assert.deepStrictEqual(await membresia(usr.encargada.id, neg.obi), { rol: 'admin', activo: true }, 'la reversa tocó la que ya tenía');
  });
  await caso('E3. dar sube a admin una membresía de staff y la reversa la deja en staff', async () => {
    const a = correr('dar', `--correo=${usr.cajera.email}`, `--sucursales=${SLUG_ACU}`, '--aplicar');
    assert.strictEqual(a.codigo, 0, a.salida);
    assert.deepStrictEqual(await membresia(usr.cajera.id, neg.acu), { rol: 'admin', activo: true });
    const archivo = readdirSync(respaldo).find((f) => f.startsWith(`dueno-${usr.cajera.id.slice(0, 8)}`));
    const v = correr('revertir', `--desde=${join(respaldo, archivo)}`, '--aplicar');
    assert.strictEqual(v.codigo, 0, v.salida);
    assert.deepStrictEqual(await membresia(usr.cajera.id, neg.acu), { rol: 'staff', activo: true });
  });
  await caso('E4. se niega con una cuenta apagada, una sucursal apagada, donde es mesero o sin --crear si no existe', async () => {
    assert.strictEqual(correr('dar', `--correo=${usr.apagado.email}`, `--sucursales=${SLUG_OBI}`, '--aplicar').codigo, 1);
    assert.strictEqual(correr('dar', `--correo=${usr.dueno.email}`, `--sucursales=${await slug('apagada')}`, '--aplicar').codigo, 1);
    assert.strictEqual(correr('dar', `--correo=${usr.dueno.email}`, `--sucursales=${await slug('mesa')}`, '--aplicar').codigo, 1);
    assert.deepStrictEqual(await membresia(usr.dueno.id, neg.mesa), { rol: 'mesero', activo: true });
    const r = correr('dar', `--correo=nuevo-${SUF}@test.local`, `--sucursales=${SLUG_OBI}`, '--aplicar');
    assert.strictEqual(r.codigo, 1);
    assert.ok(r.salida.includes('--crear'), r.salida);
  });
  await caso('E5. --crear deja la cuenta sin contraseña con liga de invitación; con la liga elige contraseña y el login pregunta sucursal; revertir la borra', async () => {
    const correo = `nuevo-${SUF}@test.local`;
    const sinAutoriza = correr('dar', `--correo=${correo}`, `--sucursales=${SLUG_OBI},${SLUG_ACU}`, '--crear', '--nombre=Dueño Nuevo', `--autoriza=${usr.cajera.email}`, '--aplicar');
    assert.strictEqual(sinAutoriza.codigo, 1, 'una cajera no debe autorizar');
    const a = correr('dar', `--correo=${correo}`, `--sucursales=${SLUG_OBI},${SLUG_ACU}`, '--crear', '--nombre=Dueño Nuevo', `--autoriza=${usr.encargada.email}`, '--aplicar');
    assert.strictEqual(a.codigo, 0, a.salida);
    const liga = (a.salida.match(/\/crear-password\?token=([A-Za-z0-9_-]+)/) || [])[1];
    assert.ok(liga, 'no imprimió la liga');
    const { rows: [u] } = await pool.query(`SELECT id, password_hash FROM usuarios WHERE email = $1`, [correo]);
    assert.ok(u && u.password_hash === null, 'la cuenta nueva no debe traer contraseña');
    const archivo = readdirSync(respaldo).find((f) => f.startsWith(`dueno-${u.id.slice(0, 8)}`));
    assert.ok(!readFileSync(join(respaldo, archivo), 'utf8').includes(liga), 'el respaldo no debe guardar la liga');
    const nueva = 'clave-nueva-del-dueno-1';
    const cp = await pedir('/api/auth/crear-password', { metodo: 'POST', cuerpo: { token: liga, password: nueva, passwordConfirm: nueva } });
    assert.strictEqual(cp.status, 200, JSON.stringify(cp.datos));
    const login = await pedir('/api/auth/negocio/login', { metodo: 'POST', cuerpo: { email: correo, password: nueva } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.datos.requiereSeleccion, true);
    assert.deepStrictEqual(login.datos.negocios.map((n) => n.negocioId).sort(), [neg.obi, neg.acu].sort());
    const v = correr('revertir', `--desde=${join(respaldo, archivo)}`, '--aplicar');
    assert.strictEqual(v.codigo, 0, v.salida);
    assert.strictEqual((await pool.query(`SELECT 1 FROM usuarios WHERE id = $1`, [u.id])).rowCount, 0, 'la reversa no borró la cuenta');
  });
  rmSync(respaldo, { recursive: true, force: true });
} finally {
  if (navegador) await navegador.close().catch(() => {});
  srv.detener();
  // Limpieza de fixtures (base de prueba).
  const ids = Object.values(usr).map((u) => u.id);
  await pool.query(`DELETE FROM sesiones_soporte WHERE negocio_id = ANY($1::uuid[])`, [Object.values(neg)]).catch(() => {});
  await pool.query(`DELETE FROM usuarios WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM negocios WHERE id = ANY($1::uuid[])`, [Object.values(neg)]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { for (const f of fallos) console.log(`  - ${f}`); process.exit(1); }
process.exit(0);
