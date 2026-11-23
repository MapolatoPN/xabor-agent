// Fase 1, bloque 2 — «Entrar» (22-nov-2026).
//
//   2.1 Login: 5 intentos por correo y 20 por conexión cada 15 min, guardados
//       en la base (un despliegue ya no los reinicia). scrypt async (no congela
//       el proceso) y el mismo cálculo aunque el correo no exista.
//   2.2 Segundo factor de Superadmin: sus intentos por usuario, en la base. Lo
//       demás del segundo factor vive en fase-superadmin-2fa.mjs.
//   2.3 PIN de mesero: un nombre de negocio con espacios ya no abre otra
//       llave; tope por mesero (también el PIN de «abrir mesa») y por
//       estación, en la base. La clave de quien autoriza, en la base.
//   2.4 Sesiones: un «Cerrar sesión» sobrevive al reinicio; una sesión de
//       Superadmin anterior al cambio de contraseña ya no vale; revocar un
//       Edge corta su conexión abierta.
//
// Servidor y Postgres reales (una copia desechable de la base local). Reinicia
// el servidor dos veces a propósito: es lo que hace un despliegue.
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-bloque2-acceso.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { cookieSuperadminCon2fa } from './lib-superadmin-2fa.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = Number(process.env.TEST_PORT_BLOQUE2 || 4797);

const { pool, esSuperadmin, crearUsuarioConPassword, crearMeseroConPin } = await import('../src/services/database.js');
const { crearTokenSesion, verificarTokenSesion } = await import('../src/services/session.js');
const { hashPassword, verifyPassword, verifyPasswordAsync, hashPin, verifyPin, verifyPinAsync } = await import('../src/services/password.js');
const { tomarLugares, usados, limpiarLlave, purgarLimitesVencidos, huellaClave } = await import('../src/services/limitesPersistentes.js');
const { cerrarSesion, purgarSesionesRevocadas } = await import('../src/services/sesionesRevocadas.js');
const { fijarPinAutorizacion, verificarPinAutorizacion } = await import('../src/services/cancelacionesRestaurante.js');
const { crearEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const mediana = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const SUF = randomUUID().slice(0, 8);

// ═════════════ A. Piezas, en este proceso ═════════════

await t('SCRYPT', 'verifyPasswordAsync da lo mismo que la versión síncrona y no congela el proceso mientras calcula', async () => {
  const h = hashPassword('ClaveDePrueba-123');
  assert.equal(await verifyPasswordAsync('ClaveDePrueba-123', h), true);
  assert.equal(await verifyPasswordAsync('ClaveDePrueba-124', h), false);
  assert.equal(await verifyPasswordAsync('ClaveDePrueba-123', null), false);
  assert.equal(await verifyPasswordAsync('ClaveDePrueba-123', 'basura-sin-dos-puntos'), false);
  assert.equal(await verifyPasswordAsync('', h), false);
  assert.equal(verifyPassword('ClaveDePrueba-123', h), true, 'el hash de siempre debía seguir validando en la versión síncrona');
  // Mientras scrypt corre en otro hilo, el proceso sigue atendiendo: cuenta
  // vueltas del ciclo de eventos durante la verificación.
  let vueltas = 0, girando = true;
  const girar = () => { if (!girando) return; vueltas++; setImmediate(girar); };
  setImmediate(girar);
  await verifyPasswordAsync('ClaveDePrueba-123', h);
  girando = false;
  assert.ok(vueltas >= 3, `el proceso se congeló durante la verificación (${vueltas} vueltas)`);
});

await t('SCRYPT', 'verifyPinAsync: mismo resultado que verifyPin, sin congelar', async () => {
  const h = hashPin('4826');
  for (const [pin, esperado] of [['4826', true], ['4827', false], ['48a6', false], ['', false]]) {
    assert.equal(await verifyPinAsync(pin, h), esperado, `PIN ${JSON.stringify(pin)}`);
    assert.equal(verifyPin(pin, h), esperado);
  }
  assert.equal(await verifyPinAsync('4826', null), false);
  let vueltas = 0, girando = true;
  const girar = () => { if (!girando) return; vueltas++; setImmediate(girar); };
  setImmediate(girar);
  await verifyPinAsync('4826', h);
  girando = false;
  assert.ok(vueltas >= 3, `el proceso se congeló (${vueltas} vueltas)`);
});

await t('SCRYPT', 'sin cuenta se calcula igual: verificar contra nada tarda lo mismo que contra un hash real', async () => {
  const h = hashPassword('OtraClave-987');
  await verifyPasswordAsync('x'.repeat(12), h); // calentar
  const real = [], nada = [];
  for (let i = 0; i < 5; i++) {
    let t0 = performance.now(); await verifyPasswordAsync('ClaveEquivocada', h); real.push(performance.now() - t0);
    t0 = performance.now(); await verifyPasswordAsync('ClaveEquivocada', null); nada.push(performance.now() - t0);
  }
  const razon = mediana(nada) / mediana(real);
  assert.ok(razon > 0.5 && razon < 2, `sin cuenta tardó ${mediana(nada).toFixed(1)} ms y con cuenta ${mediana(real).toFixed(1)} ms`);
});

await t('LIMITES', 'tomarLugares: 30 a la vez con tope 5 dejan pasar exactamente 5; devolver libera uno, dos veces no regala lugar', async () => {
  const clave = `prueba-concurrencia:${SUF}`;
  const tomas = await Promise.all(Array.from({ length: 30 }, () => tomarLugares([{ clave, limite: 5, ventanaMs: 60000 }])));
  const dentro = tomas.filter(Boolean);
  assert.equal(dentro.length, 5, `pasaron ${dentro.length}`);
  assert.equal(await usados(clave, 60000), 5);
  await dentro[0](); await dentro[0]();
  assert.equal(await usados(clave, 60000), 4, 'devolver dos veces no debía liberar dos lugares');
  await limpiarLlave(clave);
  assert.equal(await usados(clave, 60000), 0);
});

await t('LIMITES', 'tomarLugares con dos llaves: si una está llena no toma ninguna; la llave se guarda como huella', async () => {
  const llena = `prueba-llena:${SUF}`;
  assert.ok(await tomarLugares([{ clave: llena, limite: 1, ventanaMs: 60000 }]));
  // Las llaves se revisan en el orden de su huella: una libre que va ANTES de
  // la llena y otra que va DESPUÉS, para que el resultado no dependa del azar.
  const hLlena = huellaClave(llena);
  let antes = null, despuesDe = null;
  for (let i = 0; !(antes && despuesDe); i++) {
    const c = `prueba-libre-${i}:${SUF}`;
    if (huellaClave(c) < hLlena) antes ??= c; else despuesDe ??= c;
  }
  for (const libre of [antes, despuesDe]) {
    const r = await tomarLugares([{ clave: libre, limite: 5, ventanaMs: 60000 }, { clave: llena, limite: 1, ventanaMs: 60000 }]);
    assert.equal(r, null);
    assert.equal(await usados(libre, 60000), 0, `tomó lugar en la llave libre (${libre === antes ? 'antes' : 'después'} de la llena) aunque la otra estaba llena`);
  }
  const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM limites_acceso WHERE clave LIKE '%' || $1 || '%'`, [SUF]);
  assert.equal(c.n, 0, 'una llave quedó en claro');
  assert.equal((await q1(`SELECT COUNT(*)::int AS n FROM limites_acceso WHERE clave = $1`, [huellaClave(llena)])).n, 1);
  await assert.rejects(() => tomarLugares([{ clave: antes, limite: 0, ventanaMs: 60000 }]));
});

await t('LIMITES', 'la purga borra lo vencido y deja lo vigente (límites y sesiones cerradas)', async () => {
  const vieja = huellaClave(`purga-vieja:${SUF}`), viva = huellaClave(`purga-viva:${SUF}`);
  await pool.query(`INSERT INTO limites_acceso (clave, creado_at, vence_at) VALUES ($1, now() - interval '2 hours', now() - interval '1 hour'), ($2, now(), now() + interval '1 hour')`, [vieja, viva]);
  await pool.query(`INSERT INTO sesiones_revocadas (huella, vence_at) VALUES ($1, now() - interval '1 minute'), ($2, now() + interval '1 hour')`, [`h-vieja-${SUF}`, `h-viva-${SUF}`]);
  assert.ok((await purgarLimitesVencidos()) >= 1);
  assert.ok((await purgarSesionesRevocadas()) >= 1);
  assert.equal((await q1(`SELECT COUNT(*)::int AS n FROM limites_acceso WHERE clave = ANY($1)`, [[vieja, viva]])).n, 1);
  assert.equal((await q1(`SELECT COUNT(*)::int AS n FROM sesiones_revocadas WHERE huella = ANY($1)`, [[`h-vieja-${SUF}`, `h-viva-${SUF}`]])).n, 1);
});

// ── Negocio de prueba ──
const N = (await q1(`INSERT INTO negocios (nombre, slug, activo, estado) VALUES ('Bloque 2', $1, true, 'activo') RETURNING id`, [`bloque2-${SUF}`])).id;
const SLUG = `bloque2-${SUF}`;
for (const m of ['pos', 'menu', 'restaurante']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [N, m]);
}
const SUC = (await q1(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal') RETURNING id::text`, [N])).id;
const PASS = 'Clave-Bloque2-ok';
const usuario = async (etiqueta, rol = 'admin') => (await crearUsuarioConPassword({
  negocioId: N, nombre: `Bloque 2 ${etiqueta}`, email: `${etiqueta}-${SUF}@bloque2.test.local`, password: PASS, rol,
}));
const correo = (etiqueta) => `${etiqueta}-${SUF}@bloque2.test.local`;
const ADMIN = (await usuario('admin')).id;
const cookieAdmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN, negocioId: N, rol: 'admin' }))}`;

await t('AUTORIZA', 'la clave de quien autoriza: 5 fallos la bloquean y un proceso nuevo (un despliegue) la encuentra bloqueada', async () => {
  await fijarPinAutorizacion(N, ADMIN, '7391');
  const intentar = async (pin, clave) => { try { await verificarPinAutorizacion(N, pin, clave); return 'paso'; } catch (e) { return e.code; } };
  // El bueno no gasta: 4 fallos y tres aciertos, sin bloqueo.
  const k0 = `k0-${SUF}`;
  for (let i = 0; i < 4; i++) assert.equal(await intentar('0000', k0), 'PIN_INCORRECTO');
  for (let i = 0; i < 3; i++) assert.equal(await intentar('7391', k0), 'paso', `acierto ${i + 1}`);
  const k1 = `k1-${SUF}`;
  for (let i = 0; i < 5; i++) assert.equal(await intentar('0000', k1), 'PIN_INCORRECTO', `fallo ${i + 1}`);
  assert.equal(await intentar('7391', k1), 'PIN_BLOQUEADO', 'el 6.º, aun con la clave buena, debía bloquearse');
  const modulo = pathToFileURL(join(RAIZ, 'src', 'services', 'cancelacionesRestaurante.js')).href;
  const modDb = pathToFileURL(join(RAIZ, 'src', 'services', 'database.js')).href;
  const hijo = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { verificarPinAutorizacion } = await import(${JSON.stringify(modulo)});
    const { pool } = await import(${JSON.stringify(modDb)});
    let r; try { await verificarPinAutorizacion(process.env.B2_N, '7391', process.env.B2_K); r = 'paso'; } catch (e) { r = e.code; }
    console.log('RESULTADO=' + r); await pool.end(); process.exit(0);`],
  { cwd: RAIZ, env: { ...process.env, B2_N: N, B2_K: k1 }, encoding: 'utf8', timeout: 60000 });
  const r = (hijo.stdout || '').match(/RESULTADO=(\S+)/)?.[1];
  assert.equal(r, 'PIN_BLOQUEADO', `en un proceso nuevo: ${r} ${(hijo.stderr || '').slice(-400)}`);
});

await t('SUPER', 'esSuperadmin con iat: una sesión anterior al cambio de contraseña ya no es de superadmin', async () => {
  const u = await usuario('super-iat');
  await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [u.id]);
  const antes = Date.now();
  assert.equal(await esSuperadmin(u.id, { iat: antes }), true);
  await esperar(20);
  const marca = new Date();
  await pool.query(`UPDATE usuarios SET sesiones_invalidas_antes = $2 WHERE id = $1`, [u.id, marca]);
  assert.equal(await esSuperadmin(u.id, { iat: antes }), false, 'la sesión vieja seguía valiendo');
  assert.equal(await esSuperadmin(u.id, { iat: marca.getTime() + 50 }), true, 'la sesión nueva debía valer');
  assert.equal(await esSuperadmin(u.id), true, 'sin iat (llamadas que no son de sesión) no cambia');
});

// ═════════════ B. Servidor real ═════════════

const arrancar = () => arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
let srv = await arrancar();
async function reiniciar() {
  const p = srv.proc;
  const salio = new Promise((r) => (p.exitCode !== null || p.signalCode !== null) ? r() : p.once('exit', r));
  p.kill();
  await salio;
  srv = await arrancar();
}
async function pedir(ruta, { metodo = 'GET', cuerpo, cookie, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (ip) headers['X-Forwarded-For'] = ip;
  const r = await fetch(srv.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  const sesion = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('xabor_sesion=') && c.length > 'xabor_sesion='.length);
  return { status: r.status, body: json, texto, cookie: sesion || null };
}
let ipN = 1;
const ipNueva = () => { const n = ipN++; return `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`; };
const login = (email, password, ip = ipNueva()) => pedir('/api/auth/negocio/login', { metodo: 'POST', cuerpo: { email, password }, ip });
const pinMesero = (negocio, meseroUsuarioId, pin, ip = ipNueva()) =>
  pedir('/api/auth/mesero/login', { metodo: 'POST', cuerpo: { negocio, meseroUsuarioId, pin }, ip });

function conectarWS(ruta, cookie) {
  const ws = new WebSocket(`ws://localhost:${PUERTO}${ruta}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  const o = { ws, recibidos: [], cerrado: false, status: null };
  o.abierto = new Promise((ok) => {
    ws.once('open', () => ok(true));
    ws.once('unexpected-response', (_req, res) => { o.status = res.statusCode; ok(false); });
    ws.once('error', () => ok(false));
  });
  ws.on('message', (raw) => { try { o.recibidos.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('close', () => { o.cerrado = true; });
  ws.on('error', () => {});
  return o;
}
async function hasta(cond, ms = 3000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return true; await esperar(25); }
  return cond();
}

// Datos que se revisan otra vez después del reinicio.
const despues = {};

try {
  // ── 2.1 Login ──
  await t('LOGIN', '5 fallos bloquean el correo 15 min: el 6.º, aun con la contraseña buena y desde otra conexión, recibe 429', async () => {
    await usuario('bloqueada');
    for (let i = 0; i < 5; i++) {
      const r = await login(correo('bloqueada'), `mala-${i}-xxxx`);
      assert.equal(r.status, 401, `fallo ${i + 1}: ${r.status} ${r.texto.slice(0, 120)}`);
    }
    const r = await login(correo('bloqueada'), PASS);
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 160)}`);
    assert.equal(r.body?.code, 'DEMASIADOS_INTENTOS');
    assert.equal(r.cookie, null, 'el bloqueo emitió una sesión');
    despues.bloqueada = correo('bloqueada');
  });

  await t('LOGIN', 'mayúsculas y espacios no abren otro contador del mismo correo', async () => {
    await usuario('mayus');
    for (const e of [correo('mayus'), correo('mayus').toUpperCase(), `  ${correo('mayus')}  `, correo('mayus'), ` ${correo('mayus').toUpperCase()}`]) {
      assert.equal((await login(e, 'mala-xxxxxxxx')).status, 401);
    }
    assert.equal((await login(correo('mayus'), PASS)).status, 429);
  });

  await t('LOGIN', 'un correo que no existe responde igual que uno que sí (mismo 401, mismo 429)', async () => {
    const r1 = await login(correo('existe-401'), 'mala-xxxxxxxx');
    const r2 = await login(correo('nadie'), 'mala-xxxxxxxx');
    assert.equal(r1.status, 401); assert.equal(r2.status, 401);
    assert.deepEqual(r2.body, r1.body);
    for (let i = 0; i < 4; i++) assert.equal((await login(correo('nadie'), 'mala-xxxxxxxx')).status, 401);
    const r3 = await login(correo('nadie'), 'mala-xxxxxxxx');
    assert.equal(r3.status, 429);
    const r4 = await login(correo('bloqueada'), 'mala-xxxxxxxx');
    assert.deepEqual(r3.body, r4.body);
  });

  await t('LOGIN', 'sin cuenta tarda lo mismo que con cuenta y contraseña equivocada (no delata qué correos existen)', async () => {
    // Lo que cuesta un scrypt en esta máquina: la diferencia entre las dos
    // respuestas tiene que ser mucho menor que eso. (Una razón no basta: las
    // consultas del login pesan tanto como el scrypt y la esconden.)
    const h = hashPassword('MedirScrypt-123'), costo = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); await verifyPasswordAsync('otra-cosa-123', h); costo.push(performance.now() - t0); }
    const scrypt = mediana(costo);
    const quien = [];
    for (let i = 0; i < 2; i++) { await usuario(`tiempo-${i}`); quien.push(correo(`tiempo-${i}`)); }
    await login(correo('nadie-calentar'), 'mala-xxxxxxxx');
    const con = [], sin = [];
    for (let i = 0; i < 8; i++) {
      let t0 = performance.now(); assert.equal((await login(quien[i % 2], `mala-${i}-xxxx`)).status, 401); con.push(performance.now() - t0);
      t0 = performance.now(); assert.equal((await login(correo(`nadie-t${i}`), 'mala-xxxxxxxx')).status, 401); sin.push(performance.now() - t0);
    }
    const dif = mediana(con) - mediana(sin);
    assert.ok(Math.abs(dif) < scrypt / 2,
      `con cuenta ${mediana(con).toFixed(1)} ms, sin cuenta ${mediana(sin).toFixed(1)} ms; un scrypt cuesta ${scrypt.toFixed(1)} ms`);
  });

  await t('LOGIN', 'entrar bien borra los fallos del correo: 4 fallos, entrar, 4 fallos más y entra otra vez', async () => {
    await usuario('limpia');
    for (let i = 0; i < 4; i++) assert.equal((await login(correo('limpia'), 'mala-xxxxxxxx')).status, 401);
    const a = await login(correo('limpia'), PASS);
    assert.equal(a.status, 200, a.texto.slice(0, 160));
    assert.ok(a.cookie, 'no emitió sesión');
    for (let i = 0; i < 4; i++) assert.equal((await login(correo('limpia'), 'mala-xxxxxxxx')).status, 401, `fallo ${i + 1} después de entrar`);
    assert.equal((await login(correo('limpia'), PASS)).status, 200);
  });

  await t('LOGIN', '20 intentos por conexión sumen los correos que sumen; otra conexión entra', async () => {
    await usuario('por-ip');
    const ip = ipNueva();
    for (let i = 0; i < 20; i++) assert.equal((await login(correo(`ip-${i}`), 'mala-xxxxxxxx', ip)).status, 401, `intento ${i + 1}`);
    const r = await login(correo('por-ip'), PASS, ip);
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 120)}`);
    assert.equal((await login(correo('por-ip'), PASS)).status, 200);
  });

  await t('LOGIN', 'entrar bien no gasta el cupo de la conexión: 25 inicios correctos desde la misma oficina', async () => {
    const ip = ipNueva();
    const gente = [];
    for (let i = 0; i < 5; i++) { await usuario(`oficina-${i}`); gente.push(correo(`oficina-${i}`)); }
    for (let i = 0; i < 25; i++) {
      const r = await login(gente[i % gente.length], PASS, ip);
      assert.equal(r.status, 200, `inicio ${i + 1}: ${r.status} ${r.texto.slice(0, 120)}`);
    }
  });

  // ── 2.3 PIN de mesero ──
  const meseros = [];
  for (let i = 0; i < 9; i++) meseros.push((await crearMeseroConPin({ negocioId: N, nombre: `Mesero B2 ${i}`, pin: '4826' })).id);
  const [M1, M2, M3, M4, M5, M6, M7, M8, M9] = meseros;

  await t('PIN', 'un acierto no gasta lugar: 9 fallos y tres aciertos seguidos entran', async () => {
    for (let i = 0; i < 9; i++) assert.equal((await pinMesero(SLUG, M9, '1111')).status, 401);
    for (let i = 0; i < 3; i++) {
      const r = await pinMesero(SLUG, M9, '4826');
      assert.equal(r.status, 200, `acierto ${i + 1}: ${r.status} ${r.texto.slice(0, 120)}`);
    }
  });

  await t('PIN', '10 fallos por mesero, vengan de la conexión que vengan y con el nombre del negocio escrito como sea: el 11.º recibe 429', async () => {
    const variantes = [SLUG, ` ${SLUG}`, SLUG.toUpperCase(), `${SLUG} `, `\t${SLUG}`, `  ${SLUG.toUpperCase()}  `];
    for (let i = 0; i < 10; i++) {
      const r = await pinMesero(variantes[i % variantes.length], M1, '1111');
      assert.equal(r.status, 401, `fallo ${i + 1}: ${r.status} ${r.texto.slice(0, 120)}`);
    }
    const r = await pinMesero(SLUG, M1, '4826');
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 120)}`);
    assert.equal(r.body?.code, 'DEMASIADOS_INTENTOS');
    despues.m1 = M1;
  });

  await t('PIN', 'el freno por conexión ya no se esquiva con espacios o mayúsculas en el nombre del negocio', async () => {
    const ip = ipNueva();
    for (let i = 0; i < 5; i++) assert.equal((await pinMesero(SLUG, M2, '1111', ip)).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await pinMesero(`  ${SLUG.toUpperCase()} `, M2, '1111', ip)).status, 401);
    const r = await pinMesero(SLUG, M3, '4826', ip);
    assert.equal(r.status, 429, `con otro mesero desde la misma conexión: ${r.status}`);
  });

  await t('PIN', '«abrir mesa» con el PIN de otro mesero suma al mismo contador que la entrada de la estación', async () => {
    for (let i = 0; i < 9; i++) assert.equal((await pinMesero(SLUG, M8, '1111')).status, 401);
    const abrir = (pin) => pedir('/api/restaurante/mesas/abrir', { metodo: 'POST', cuerpo: { mesa: 1, personas: 2, meseroUsuarioId: M8, pin }, cookie: cookieAdmin, ip: ipNueva() });
    const f = await abrir('1111');
    assert.equal(f.status, 401, `${f.status} ${f.texto.slice(0, 160)}`);
    assert.equal(f.body?.code, 'PIN_INCORRECTO');
    const b = await abrir('4826');
    assert.equal(b.status, 429, `abrir mesa con el PIN bueno tras 10 fallos: ${b.status} ${b.texto.slice(0, 160)}`);
    assert.equal((await pinMesero(SLUG, M8, '4826')).status, 429, 'la estación debía verlo bloqueado también');
  });

  // Estación: 20 por conexión y negocio. El freno en memoria (10 cada 5 min)
  // ataja antes dentro de un mismo proceso, así que la suma de 20 se ve a
  // través de dos reinicios (dos despliegues): 10, reinicio, 10, reinicio.
  const IP_ESTACION = ipNueva();
  await t('PIN', 'estación: primeros 10 fallos desde la misma tablet', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await pinMesero(SLUG, i < 5 ? M4 : M5, '1111', IP_ESTACION);
      assert.equal(r.status, 401, `fallo ${i + 1}: ${r.status}`);
    }
  });

  // ── 2.2 Segundo factor: intentos por usuario ──
  const SA2 = (await usuario('super-2fa')).id;
  await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [SA2]);
  const cookieSA2 = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SA2, negocioId: N, rol: 'admin' }))}`;
  await t('2FA', 'verificar el código: 5 intentos por usuario, el 6.º recibe 429 aunque cambie de conexión', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await pedir('/api/superadmin-2fa/verificar', { metodo: 'POST', cuerpo: { codigo: '000000' }, cookie: cookieSA2, ip: ipNueva() });
      assert.equal(r.status, 400, `intento ${i + 1}: ${r.status} ${r.texto.slice(0, 120)}`);
    }
    const r = await pedir('/api/superadmin-2fa/verificar', { metodo: 'POST', cuerpo: { codigo: '000000' }, cookie: cookieSA2, ip: ipNueva() });
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 120)}`);
  });

  await t('2FA', 'la contraseña buena del alta y el código bueno no gastan intentos (alta y verificación de verdad)', async () => {
    const SA4 = (await usuario('super-alta')).id;
    await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [SA4]);
    const ck = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SA4, negocioId: N, rol: 'admin' }))}`;
    const alta = (password) => pedir('/api/superadmin-2fa/alta', { metodo: 'POST', cuerpo: { password }, cookie: ck, ip: ipNueva() });
    for (let i = 0; i < 4; i++) assert.equal((await alta('mala-xxxxxxxx')).status, 400, `contraseña mala ${i + 1}`);
    let secreto = null;
    for (let i = 0; i < 3; i++) {
      const r = await alta(PASS);
      assert.equal(r.status, 200, `alta ${i + 1} con la contraseña buena: ${r.status} ${r.texto.slice(0, 120)}`);
      secreto = r.body?.secreto;
    }
    assert.ok(secreto, 'el alta no devolvió el secreto');
    const { codigoHotp, desdeBase32, pasoActual } = await import('../src/services/superadmin2fa.js');
    const clave = desdeBase32(secreto), base = pasoActual();
    const verificar = (codigo) => pedir('/api/superadmin-2fa/verificar', { metodo: 'POST', cuerpo: { codigo }, cookie: ck, ip: ipNueva() });
    for (let i = 0; i < 4; i++) assert.equal((await verificar(codigoHotp(clave, base + 50 + i))).status, 400, `código malo ${i + 1}`);
    // Dos códigos buenos seguidos (pasos distintos; el mismo no vale dos veces).
    for (const paso of [base, base + 1]) {
      const r = await verificar(codigoHotp(clave, paso));
      assert.equal(r.status, 200, `código bueno del paso ${paso - base}: ${r.status} ${r.texto.slice(0, 120)}`);
    }
  });

  // ── 2.4 Sesiones ──
  await t('SESION', 'una sesión de Superadmin anterior al cambio de contraseña ya no abre la consola, ni su WebSocket', async () => {
    const SA1 = (await usuario('super-sesion')).id;
    await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [SA1]);
    const vieja = await cookieSuperadminCon2fa({ usuarioId: SA1, negocioId: N });
    assert.equal((await pedir('/api/superadmin/negocios', { cookie: vieja })).status, 200);
    const w1 = conectarWS('/ws/superadmin', vieja);
    assert.equal(await w1.abierto, true, `el WebSocket con la sesión vigente no abrió (${w1.status})`);
    w1.ws.close();
    await esperar(20);
    await pool.query(`UPDATE usuarios SET sesiones_invalidas_antes = $2 WHERE id = $1`, [SA1, new Date()]);
    await esperar(20);
    const r = await pedir('/api/superadmin/negocios', { cookie: vieja });
    assert.equal(r.status, 403, `${r.status} ${r.texto.slice(0, 120)}`);
    assert.equal((await pedir('/api/superadmin-2fa/estado', { cookie: vieja })).status, 403);
    const w2 = conectarWS('/ws/superadmin', vieja);
    assert.equal(await w2.abierto, false, 'el WebSocket abrió con la sesión vieja');
    assert.equal(w2.status, 403);
    const nueva = await cookieSuperadminCon2fa({ usuarioId: SA1, negocioId: N });
    assert.equal((await pedir('/api/superadmin/negocios', { cookie: nueva })).status, 200, 'la sesión nueva debía entrar');
  });

  await t('SESION', 'la sesión de soporte de un Superadmin muere cuando él cambia su contraseña', async () => {
    const SA3 = (await usuario('super-soporte')).id;
    await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [SA3]);
    const consola = await cookieSuperadminCon2fa({ usuarioId: SA3, negocioId: N });
    const s = await pedir(`/api/superadmin/negocios/${N}/sesion-soporte`, { metodo: 'POST', cuerpo: { motivo: 'prueba bloque 2' }, cookie: consola });
    assert.equal(s.status, 200, `${s.status} ${s.texto.slice(0, 160)}`);
    assert.ok(s.cookie, 'no emitió la sesión de soporte');
    // Dos guardias distintas: la del panel (/api/auth/me) y la «segura» (mesas).
    assert.equal((await pedir('/api/auth/me', { cookie: s.cookie })).status, 200);
    assert.equal((await pedir('/api/restaurante/mesas', { cookie: s.cookie })).status, 200);
    await esperar(20);
    await pool.query(`UPDATE usuarios SET sesiones_invalidas_antes = $2 WHERE id = $1`, [SA3, new Date()]);
    await esperar(20);
    assert.equal((await pedir('/api/auth/me', { cookie: s.cookie })).status, 401, 'la sesión de soporte siguió en el panel');
    assert.equal((await pedir('/api/restaurante/mesas', { cookie: s.cookie })).status, 401, 'la sesión de soporte siguió en mesas');
  });

  await t('SESION', '«Cerrar sesión» guarda solo la huella del token y la sesión deja de valer al instante', async () => {
    await usuario('sale');
    const a = await login(correo('sale'), PASS);
    assert.equal(a.status, 200); assert.ok(a.cookie);
    assert.equal((await pedir('/api/auth/me', { cookie: a.cookie })).status, 200);
    const s = await pedir('/api/auth/negocio/logout', { metodo: 'POST', cuerpo: {}, cookie: a.cookie });
    assert.equal(s.status, 200);
    assert.equal((await pedir('/api/auth/me', { cookie: a.cookie })).status, 401);
    const token = decodeURIComponent(a.cookie.slice('xabor_sesion='.length));
    const { rows } = await pool.query(`SELECT huella FROM sesiones_revocadas WHERE huella = $1 OR huella LIKE '%' || $2 || '%'`,
      [token, token.slice(0, 24)]);
    assert.equal(rows.length, 0, 'el token quedó en claro en la base');
    assert.ok((await q1(`SELECT COUNT(*)::int AS n FROM sesiones_revocadas WHERE vence_at > now()`)).n >= 1);
    despues.salida = a.cookie;
    // Una sesión que NO se cerró, para comprobar que el reinicio no tumba todo.
    despues.viva = (await login(correo('sale'), PASS)).cookie;
    // Y la del mesero: su «salir» también sobrevive.
    const m = await pinMesero(SLUG, M9, '4826');
    assert.equal(m.status, 200);
    assert.equal((await pedir('/api/auth/mesero/logout', { metodo: 'POST', cuerpo: {}, cookie: m.cookie })).status, 200);
    despues.meseroSalida = m.cookie;
  });

  await t('SESION', 'cerrarSesion en proceso: la cierra en memoria al instante aunque no se guarde nada más', async () => {
    const tok = crearTokenSesion({ usuarioId: ADMIN, negocioId: N, rol: 'admin' });
    assert.ok(verificarTokenSesion(tok));
    await cerrarSesion(tok);
    assert.equal(verificarTokenSesion(tok), null);
    await cerrarSesion(tok); // dos veces no truena
    await cerrarSesion('no-es-un-token');
  });

  await t('EDGE', 'revocar un Edge corta su conexión abierta en el momento, y ya no vuelve a autenticarse', async () => {
    const edge = await crearEdge(N, { nombre: `Edge B2 ${SUF}`, sucursalId: SUC });
    const { codigo } = await generarEmparejamiento(N, edge.id);
    const cred = await canjearEmparejamiento(codigo);
    const ws = conectarWS('/ws/print-agent');
    assert.equal(await ws.abierto, true);
    ws.ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: `inst-${SUF}` }));
    assert.ok(await hasta(() => ws.recibidos.some((m) => m.tipo === 'terminal_autenticada')), `no autenticó: ${JSON.stringify(ws.recibidos).slice(0, 200)}`);
    await esperar(300);
    assert.equal(ws.cerrado, false);
    const r = await pedir(`/api/impresion/edges/${edge.id}/revocar`, { metodo: 'POST', cuerpo: {}, cookie: cookieAdmin });
    assert.equal(r.status, 200, `${r.status} ${r.texto.slice(0, 160)}`);
    assert.ok(await hasta(() => ws.cerrado, 1500), 'la conexión del Edge revocado seguía abierta');
    assert.ok(srv.obtenerSalida().includes(`[Edge] terminal=${edge.id} desconectada: credencial revocada`), 'no quedó en el log');
    const otra = conectarWS('/ws/print-agent');
    assert.equal(await otra.abierto, true);
    otra.ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: `inst-${SUF}` }));
    await hasta(() => otra.cerrado, 3000);
    assert.ok(!otra.recibidos.some((m) => m.tipo === 'terminal_autenticada'), 'la credencial revocada volvió a autenticar');
    otra.ws.terminate();
  });

  await t('EDGE', 'revocar un Edge de OTRO negocio no corta nada (404) y el Edge sigue conectado', async () => {
    const otroN = (await q1(`INSERT INTO negocios (nombre, slug, activo, estado) VALUES ('Bloque 2 otro', $1, true, 'activo') RETURNING id`, [`bloque2-otro-${SUF}`])).id;
    const otraSuc = (await q1(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Otra') RETURNING id::text`, [otroN])).id;
    const edge = await crearEdge(otroN, { nombre: `Edge ajeno ${SUF}`, sucursalId: otraSuc });
    const { codigo } = await generarEmparejamiento(otroN, edge.id);
    const cred = await canjearEmparejamiento(codigo);
    const ws = conectarWS('/ws/print-agent');
    assert.equal(await ws.abierto, true);
    ws.ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: `inst-ajeno-${SUF}` }));
    assert.ok(await hasta(() => ws.recibidos.some((m) => m.tipo === 'terminal_autenticada')));
    const r = await pedir(`/api/impresion/edges/${edge.id}/revocar`, { metodo: 'POST', cuerpo: {}, cookie: cookieAdmin });
    assert.notEqual(r.status, 200, `revocó un Edge ajeno: ${r.texto.slice(0, 120)}`);
    await esperar(500);
    assert.equal(ws.cerrado, false, 'cortó la conexión de un Edge de otro negocio');
    ws.ws.terminate();
  });

  // ═════════════ Reinicio 1 (un despliegue) ═════════════
  await reiniciar();

  await t('REINICIO', 'al arrancar recarga las sesiones cerradas antes de atender', async () => {
    const m = srv.obtenerSalida().match(/\[Startup\] Sesiones cerradas recargadas: (\d+)/);
    assert.ok(m, srv.obtenerSalida().slice(-800));
    assert.ok(Number(m[1]) >= 2, `recargó ${m[1]}`);
  });

  await t('REINICIO', 'la sesión cerrada sigue cerrada (panel y mesero); la que no se cerró sigue viva', async () => {
    assert.equal((await pedir('/api/auth/me', { cookie: despues.salida })).status, 401, 'el reinicio revivió la sesión cerrada');
    assert.equal((await pedir('/api/auth/me', { cookie: despues.viva })).status, 200, 'el reinicio tumbó una sesión vigente');
    const r = await pedir('/api/restaurante/mesas', { cookie: despues.meseroSalida });
    assert.equal(r.status, 401, `la sesión de mesero cerrada revivió: ${r.status}`);
  });

  await t('REINICIO', 'el correo bloqueado sigue bloqueado', async () => {
    const r = await login(despues.bloqueada, PASS);
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 120)}`);
  });

  await t('REINICIO', 'el mesero bloqueado sigue bloqueado', async () => {
    assert.equal((await pinMesero(SLUG, despues.m1, '4826')).status, 429);
  });

  await t('REINICIO', 'el segundo factor bloqueado sigue bloqueado', async () => {
    const r = await pedir('/api/superadmin-2fa/verificar', { metodo: 'POST', cuerpo: { codigo: '000000' }, cookie: cookieSA2, ip: ipNueva() });
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 120)}`);
  });

  await t('PIN', 'estación: otros 10 fallos desde la misma tablet después del despliegue', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await pinMesero(SLUG, i < 5 ? M6 : M7, '1111', IP_ESTACION);
      assert.equal(r.status, 401, `fallo ${i + 11}: ${r.status}`);
    }
  });

  // ═════════════ Reinicio 2 ═════════════
  await reiniciar();

  await t('PIN', 'estación: tras 20 fallos la tablet recibe 429 aun con un mesero y PIN buenos; otra tablet entra', async () => {
    const r = await pinMesero(SLUG, M3, '4826', IP_ESTACION);
    assert.equal(r.status, 429, `${r.status} ${r.texto.slice(0, 120)}`);
    assert.equal((await pinMesero(SLUG, M3, '4826')).status, 200);
  });

  await t('VIVO', 'el servidor siguió de pie todo el tiempo', async () => {
    assert.equal((await pedir('/health')).status, 200);
    assert.ok(!/unhandledRejection|TypeError|ReferenceError/.test(srv.obtenerSalida()), srv.obtenerSalida().slice(-1200));
  });
} finally {
  srv.detener();
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('Fallos:'); for (const f of fallos) console.log('  - ' + f); }
process.exit(fallidas ? 1 : 0);
