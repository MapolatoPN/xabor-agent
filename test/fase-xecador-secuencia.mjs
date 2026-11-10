// XECADOR · secuencia de checadas y red de la tablet (10-nov-2026, pedido de Mario).
//
// Lo que protege:
//   1. La IP es solo un dato. La red habitual se aprende POR TABLET y se
//      compara la red (/24), no la IP exacta: .129 y .130 son la misma, y dos
//      tablets de la misma sucursal en redes distintas no se marcan una a la
//      otra. Una red distinta se anota, pero NO manda la checada a «Para
//      revisar» (tampoco las que ya estaban marcadas así: la checada no cambia).
//   2. La tablet ofrece solo lo que toca: en descanso, solo «Fin de descanso»;
//      el servidor rechaza la salida.
//   3. «Para revisar» muestra los turnos que no cuadran — sin salida, descanso
//      sin cerrar, repetidas en menos de 2 min, de más de 12 h, salió y volvió
//      a entrar en menos de 1 h — calculados sobre lo que cuenta: una
//      corrección los quita y la checada original no cambia; lo que sí pasó se
//      marca «Revisada» (una vez, con autor y nota; solo el administrador del
//      negocio).
//   4. Sin conexión: lo que llega tarde o desordenado se ordena por la hora
//      real; todo se registra y lo imposible se marca.
//
// Los casos que lo motivaron, con datos de prueba: salir y volver a entrar a
// los 17 min, Inicio de descanso y Salida en el mismo minuto, y dos tablets de
// la misma sucursal en redes distintas cuyo módem cambia el último número de la IP.
//
// Base LOCAL desechable (test_*) con la 133. Servidor hijo y navegador real.
// Variables opcionales: TEST_PORT_XECADOR_SECUENCIA (4785), CASOS=A,B,C.
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrancarServidor } from './lib-servidor.mjs';

const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = process.env.TEST_PORT_XECADOR_SECUENCIA || '4785';
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));
const CAPTURAS = process.env.XECADOR_CAPTURAS || tmpdir();
const ZONA = 'America/Matamoros';

const { alertasDeSecuencia } = await import('../src/services/alertasSecuencia.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ A. La regla, sin base ═════════════════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Alertas de secuencia (puras)');
  const BASE = Date.parse('2026-11-09T12:45:00Z');   // 06:45 en Matamoros
  const m = (min) => new Date(BASE + min * 60000).toISOString();
  let n = 0;
  const linea = (...pares) => { n = 0; return pares.map(([tipo, min]) => ({ clave: `c:${++n}`, tipo, hora: m(min) })); };
  const cuales = (evs, ahoraMin = 24 * 60) => alertasDeSecuencia(evs, { ahora: m(ahoraMin) }).map((a) => `${a.motivo}@${a.ancla}`);

  await t('A1. Abel: Salida 8:20 y Entrada 8:37 (17 min) → «salió y volvió a entrar», anclada en la salida; nada más', () => {
    const evs = linea(['entrada', 0], ['salida', 95], ['entrada', 112], ['salida', 495]);
    const [a, ...resto] = alertasDeSecuencia(evs, { ahora: m(600) });
    assert.deepStrictEqual(resto, []);
    assert.deepStrictEqual([a.motivo, a.ancla, a.eventos.map((e) => `${e.clave}:${e.tipo}`)], ['reentrada', 'c:2', ['c:2:salida', 'c:3:entrada']]);
    // A la hora no cuenta: es un turno nuevo.
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['salida', 95], ['entrada', 155], ['salida', 495])), []);
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['salida', 95], ['entrada', 154.9], ['salida', 495])), ['reentrada@c:2']);
  });

  await t('A2. Beto: Inicio de descanso y Salida en el mismo minuto → «descanso sin cerrar», anclado en el inicio', () => {
    const evs = linea(['entrada', 0], ['inicio_descanso', 482], ['salida', 482.5]);
    const [a, ...resto] = alertasDeSecuencia(evs, { ahora: m(600) });
    assert.deepStrictEqual(resto, [], 'no es «repetida» (son de distinto tipo)');
    assert.deepStrictEqual([a.motivo, a.ancla, a.eventos.map((e) => e.tipo)], ['descanso_sin_cerrar', 'c:2', ['inicio_descanso', 'salida']]);
    // Dos inicios seguidos (el primero sin fin): el primero queda sin cerrar.
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['inicio_descanso', 60], ['inicio_descanso', 120], ['fin_descanso', 150], ['salida', 300])),
      ['descanso_sin_cerrar@c:2']);
  });

  await t('A3. repetidas: el mismo tipo en menos de 2 min se avisa y no cambia el turno; a los 2 min ya no es repetida', () => {
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['entrada', 1.98], ['salida', 480])), ['repetida@c:2'], 'sin «sin salida» de la primera');
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['salida', 480], ['salida', 481])), ['repetida@c:3']);
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['inicio_descanso', 60], ['inicio_descanso', 60.5], ['fin_descanso', 90], ['salida', 480])), ['repetida@c:3']);
    // A los 2 min exactos: otra entrada con el turno abierto → el primero sin salida.
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['entrada', 2], ['salida', 480])), ['sin_salida@c:1']);
  });

  await t('A4. turno de más de 12 h (de la entrada a la salida); 12 h justas no', () => {
    const [a] = alertasDeSecuencia(linea(['entrada', 0], ['salida', 12 * 60 + 1]), { ahora: m(900) });
    assert.deepStrictEqual([a.motivo, a.ancla, a.eventos.map((e) => e.tipo)], ['turno_largo', 'c:1', ['entrada', 'salida']]);
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['salida', 12 * 60])), []);
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['inicio_descanso', 300], ['fin_descanso', 360], ['salida', 13 * 60])), ['turno_largo@c:1']);
  });

  await t('A5. sin salida: a las 16 h de su última checada (la regla de la tablet), no antes; el turno de noche no se marca', () => {
    const solo = linea(['entrada', 0]);
    assert.deepStrictEqual(cuales(solo, 16 * 60), [], '16 h justas: todavía en turno');
    assert.deepStrictEqual(cuales(solo, 16 * 60 + 1), ['sin_salida@c:1']);
    const enDescanso = linea(['entrada', 0], ['inicio_descanso', 300]);
    assert.deepStrictEqual(cuales(enDescanso, 360), [], 'en descanso, todavía no');
    assert.deepStrictEqual(cuales(enDescanso, 300 + 16 * 60 + 1), ['descanso_sin_cerrar@c:2', 'sin_salida@c:1']);
    const [a] = alertasDeSecuencia(enDescanso, { ahora: m(300 + 16 * 60 + 1) }).filter((x) => x.motivo === 'sin_salida');
    assert.deepStrictEqual(a.eventos.map((e) => e.clave), ['c:1', 'c:2'], 'dice dónde empezó y lo último que checó');
    // Noche: 22:00 a 06:00.
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['salida', 480])), []);
    // Al día siguiente vuelve a entrar sin haber salido.
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['entrada', 24 * 60], ['salida', 24 * 60 + 480]), 48 * 60), ['sin_salida@c:1']);
    // Otra entrada 5 h después (sin conexión, por ejemplo): la primera quedó sin salida.
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['entrada', 300], ['salida', 600])), ['sin_salida@c:1']);
  });

  await t('A6. sin entrada y fin de descanso sin inicio', () => {
    assert.deepStrictEqual(cuales(linea(['salida', 0])), ['sin_entrada@c:1']);
    assert.deepStrictEqual(cuales(linea(['inicio_descanso', 0], ['fin_descanso', 30], ['salida', 300])), ['sin_entrada@c:1']);
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['fin_descanso', 60], ['salida', 300])), ['fin_sin_inicio@c:2']);
  });

  await t('A7. el orden de llegada no importa (sin conexión): se acomoda por la hora; las agregadas también anclan', () => {
    const evs = linea(['entrada', 0], ['salida', 95], ['entrada', 112], ['inicio_descanso', 300], ['salida', 300.5]);
    const esperado = cuales(evs, 600);
    assert.deepStrictEqual(esperado, ['reentrada@c:2', 'descanso_sin_cerrar@c:4']);
    for (const orden of [[4, 2, 0, 3, 1], [1, 0, 4, 3, 2], [3, 4, 1, 2, 0]]) {
      assert.deepStrictEqual(cuales(orden.map((i) => evs[i]), 600), esperado, `orden ${orden}`);
    }
    const conAgregada = [{ clave: 'c:7', tipo: 'entrada', hora: m(0) }, { clave: 'a:3', tipo: 'salida', hora: m(13 * 60) }];
    assert.deepStrictEqual(cuales(conAgregada), ['turno_largo@c:7']);
    assert.deepStrictEqual(cuales([{ clave: 'a:9', tipo: 'entrada', hora: m(0) }], 17 * 60), ['sin_salida@a:9']);
  });

  await t('A8. un día normal, o un turno en curso, no dan alertas; lo vacío tampoco', () => {
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['inicio_descanso', 240], ['fin_descanso', 270], ['salida', 480])), []);
    assert.deepStrictEqual(cuales(linea(['entrada', 0], ['inicio_descanso', 240], ['fin_descanso', 270]), 300), []);
    assert.deepStrictEqual(cuales([]), []);
    assert.deepStrictEqual(alertasDeSecuencia(undefined), []);
  });
}

// ═══ Fixture con base ══════════════════════════════════════════════════════
if (!PARTES.has('B') && !PARTES.has('C')) {
  console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
  process.exit(fallidas ? 1 : 0);
}
const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const CRIPTO = await import('../src/services/sinConexionCripto.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];

const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `secuencia-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const sucursal = async (neg, nombre) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, true) RETURNING id`, [neg, nombre])).id;
const persona = async (neg, nombre, rol) => {
  const id = (await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@secuencia.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });

const N = await negocio('Negocio N');
const M = await negocio('Negocio M');
const PLATAFORMA = await negocio('Plataforma');
const MATRIZ = await sucursal(N, 'Matriz');
const UNICA_M = await sucursal(M, 'Única M');
const ADMIN_N = await persona(N, 'Admin N', 'admin');
const STAFF_N = await persona(N, 'Cajero N', 'staff');
const ADMIN_M = await persona(M, 'Admin M', 'admin');
const SUPER = await persona(PLATAFORMA, 'Superadmin', 'admin');
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, true)`, [SUPER]);
const COOKIES = {
  adminN: sesion(ADMIN_N, N, 'admin'), staffN: sesion(STAFF_N, N, 'staff'),
  adminM: sesion(ADMIN_M, M, 'admin'), super: sesion(SUPER, PLATAFORMA, 'admin'),
};
const alta = (numero, nombre) => P.crearEmpleado(N, { numero, nombre, sucursal_id: MATRIZ }, { actorId: ADMIN_N });
const ABEL = await alta(1, 'Abel Regresa');
const BETO = await alta(2, 'Beto Descansa');
const EMA = await alta(3, 'Ema Repetida');
const FER = await alta(4, 'Fer Doble Turno');
const GIL = await alta(5, 'Gil Sin Salida');
const HUGO = await alta(6, 'Hugo Sin Red');
const IVAN = await alta(7, 'Iván Redes');
const LUZ = await alta(8, 'Luz Descanso');
await P.crearEmpleado(M, { numero: 1, nombre: 'Empleado de M', sucursal_id: UNICA_M }, { actorId: ADMIN_M });
const PIN = {};
for (const [k, e] of Object.entries({ HUGO, IVAN, LUZ })) PIN[k] = (await P.asignarPin(N, e.id, { actorId: ADMIN_N })).pin;

// Historia (por SQL, con su hora exacta): una tablet sin token basta para eso.
const T_SQL = (await q1(`INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre) VALUES ($1, $2, 'Tablet histórica') RETURNING id`, [N, MATRIZ])).id;
async function checada(emp, tipo, hora, extra = {}) {
  return Number((await q1(
    `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, hora_oficial, clave, foto, revision, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'no_requerida', $8::text[], $9::inet) RETURNING id`,
    [N, emp.id, MATRIZ, T_SQL, tipo, hora, randomUUID(), extra.revision || [], extra.ip || null])).id);
}
const MINUTO = Math.floor(Date.now() / 60000) * 60000;   // en minuto exacto: las agregadas son por minuto
const desde = (horasAtras) => (min) => new Date(MINUTO - horasAtras * 3.6e6 + min * 60000);
const fechaLocal = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const entradaLocal = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

// Abel, hace 3 días: Entrada 6:45, Salida 8:20, Entrada 8:37, Salida 15:00.
const jd = desde(72);
const ABEL_E1 = await checada(ABEL, 'entrada', jd(0));
const ABEL_S1 = await checada(ABEL, 'salida', jd(95));
const ABEL_E2 = await checada(ABEL, 'entrada', jd(112));
await checada(ABEL, 'salida', jd(495));
// Beto, hace 2 días: Inicio de descanso y Salida en el mismo minuto.
const rd = desde(48);
await checada(BETO, 'entrada', rd(0));
const BET_I = await checada(BETO, 'inicio_descanso', rd(482));
const BET_S = await checada(BETO, 'salida', new Date(rd(482).getTime() + 30000));
// Ema, hace 4 días: dos entradas en 70 s.
const ed = desde(96);
await checada(EMA, 'entrada', ed(0));
const EMA_E2 = await checada(EMA, 'entrada', new Date(ed(0).getTime() + 70000));
await checada(EMA, 'salida', ed(480));
// Fer, hace 5 días: 13 h 15 min.
const fd = desde(120);
const FER_E = await checada(FER, 'entrada', fd(0));
await checada(FER, 'salida', fd(795));
// Gil, hace 60 h: entró y no salió.
const gd = desde(60);
const GIL_E = await checada(GIL, 'entrada', gd(0));
void ABEL_E1;

// ═══ B. Servidor real ══════════════════════════════════════════════════════
let servidor = null;
async function http(metodo, ruta, { cookie, tablet, cuerpo, ip } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}`;
  if (tablet) headers.Authorization = `Bearer ${tablet}`;
  if (ip) headers['X-Forwarded-For'] = ip;
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(servidor.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await r.text();
  let datos = null; try { datos = JSON.parse(texto); } catch { /* nada */ }
  return { status: r.status, datos, texto };
}
const modulo = (neg, estado) => http('PATCH', `/api/superadmin/negocios/${neg}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
const CHK = '/api/personal/checador';
async function nuevaTablet(nombre) {
  const c = await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminN, cuerpo: { nombre, sucursal_id: MATRIZ } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.datos));
  const v = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: c.datos.codigo } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.datos));
  return { id: c.datos.dispositivo.id, token: v.datos.token };
}
const identificar = (T, numero, pin) => http('POST', '/api/checador/identificar', { tablet: T.token, cuerpo: { numero, pin } });
/** Checa lo que le toque (salida si puede, si no lo primero) desde la IP indicada; devuelve la checada guardada. */
async function checarDesde(T, numero, pin, ip, tipo = null) {
  const id = await identificar(T, numero, pin);
  assert.strictEqual(id.status, 200, JSON.stringify(id.datos));
  const t = tipo || (id.datos.posibles.includes('salida') ? 'salida' : id.datos.posibles[0]);
  const r = await http('POST', '/api/checador/checar', { tablet: T.token, ip, cuerpo: { pase: id.datos.pase, tipo: t, clave: randomUUID() } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
  return q1(`SELECT id, tipo, revision, host(ip) AS ip FROM xecador_checadas WHERE id = $1`, [r.datos.checada.id]);
}
const revisar = async (cookie = COOKIES.adminN) => (await http('GET', `${CHK}/revisar`, { cookie })).datos;
const alertasDe = async (emp) => (await revisar()).secuencia.filter((a) => a.empleado_id === emp.id);
const corr = (cuerpo) => http('POST', `${CHK}/correcciones`, { cookie: COOKIES.adminN, cuerpo: { motivo: 'Ajuste de prueba', ...cuerpo } });
const revisarAlerta = (cuerpo, cookie = COOKIES.adminN) => http('POST', `${CHK}/revisiones-secuencia`, { cookie, cuerpo });
const originales = async (ids) => (await pool.query(
  `SELECT id, tipo, hora_oficial, revision FROM xecador_checadas WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids])).rows;

servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
for (const neg of [N, M]) assert.strictEqual((await modulo(neg, 'activo')).status, 200, 'precondición: módulo encendido');
let TA = null, TB = null, SOLO_RED = null;

if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');
  TA = await nuevaTablet('ENTRADA');
  TB = await nuevaTablet('CELULAR');

  await t('B1. red por tablet: .129 y .130 son la misma red; otra red se anota; la otra tablet de la sucursal tiene la suya', async () => {
    const marcas = [];
    for (let i = 0; i < 8; i++) marcas.push((await checarDesde(TA, 7, PIN.IVAN, `198.51.100.${129 + (i % 2)}`)).revision);
    assert.deepStrictEqual(marcas, Array(8).fill([]), 'ninguna «IP distinta» por el último número');
    SOLO_RED = await checarDesde(TA, 7, PIN.IVAN, '192.0.2.9');
    assert.deepStrictEqual([SOLO_RED.ip, SOLO_RED.revision], ['192.0.2.9', ['ip_distinta']], 'otra red: se anota (no se bloquea)');
    // La tablet «CELULAR» de la MISMA sucursal, en su propia red: no es «distinta».
    const deB = [];
    for (let i = 0; i < 7; i++) deB.push((await checarDesde(TB, 7, PIN.IVAN, `203.0.113.${193 + (i % 2)}`)).revision);
    assert.deepStrictEqual(deB, Array(7).fill([]), 'cada tablet con su red');
    // Y la de ENTRADA sigue con la suya.
    assert.deepStrictEqual((await checarDesde(TA, 7, PIN.IVAN, '198.51.100.130')).revision, []);
  });

  await t('B2. la red distinta es informativa: no manda a «Para revisar» (tampoco las ya marcadas); se ve en el día con su IP', async () => {
    // Como quedaron con la regla anterior: solo «ip_distinta», y con otro motivo.
    const vieja = await checada(IVAN, 'entrada', desde(30)(0), { revision: ['ip_distinta'], ip: '198.51.100.130' });
    const conOtro = await checada(IVAN, 'salida', desde(30)(60), { revision: ['ip_distinta', 'reloj_desfasado'], ip: '198.51.100.129' });
    const r = await revisar();
    const ids = r.checadas.map((c) => c.id);
    assert.ok(!ids.includes(Number(SOLO_RED.id)) && !ids.includes(vieja), 'solo por la red: no está para revisar');
    const otro = r.checadas.find((c) => c.id === conOtro);
    assert.deepStrictEqual([otro?.motivos, otro?.informativos], [['reloj_desfasado'], ['ip_distinta']], 'con otro motivo sí, y la red como dato');
    assert.ok(!r.checadas.some((c) => c.motivos.includes('ip_distinta')));
    // La checada no cambió.
    assert.deepStrictEqual((await q1(`SELECT revision FROM xecador_checadas WHERE id = $1`, [vieja])).revision, ['ip_distinta']);
    // En el día se ve, con la IP.
    const dia = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    const c = dia.datos.checadas.find((x) => x.id === Number(SOLO_RED.id));
    assert.deepStrictEqual([c?.revision, c?.ip], [['ip_distinta'], '192.0.2.9']);
    // El resumen CSV ya no la pone «para revisar».
    const hoy = fechaLocal(new Date());
    const csv = await http('GET', `${CHK}/exportar.csv?vista=resumen&empleado_id=${IVAN.id}&desde=${fechaLocal(new Date(Date.now() - 3 * 864e5))}&hasta=${hoy}`, { cookie: COOKIES.adminN });
    assert.strictEqual(csv.status, 200, csv.texto.slice(0, 200));
    assert.ok(!/IP distinta|Otra red/.test(csv.texto), 'el resumen no la menciona');
    assert.match(csv.texto, /Para revisar: Reloj de la tablet desfasado/, 'lo demás sí');
  });

  await t('B3. en descanso la tablet ofrece SOLO «Fin de descanso»; el servidor rechaza la salida y no registra nada', async () => {
    assert.strictEqual((await checarDesde(TA, 8, PIN.LUZ, undefined, 'entrada')).tipo, 'entrada');
    assert.strictEqual((await checarDesde(TA, 8, PIN.LUZ, undefined, 'inicio_descanso')).tipo, 'inicio_descanso');
    const id = await identificar(TA, 8, PIN.LUZ);
    assert.deepStrictEqual([id.datos.posibles, id.datos.sugerida], [['fin_descanso'], 'fin_descanso']);
    const antes = (await q1(`SELECT COUNT(*)::int AS n FROM xecador_checadas WHERE empleado_id = $1`, [LUZ.id])).n;
    const salida = await http('POST', '/api/checador/checar', { tablet: TA.token, cuerpo: { pase: id.datos.pase, tipo: 'salida', clave: randomUUID() } });
    assert.deepStrictEqual([salida.status, salida.datos.codigo, salida.datos.posibles], [409, 'ACCION_NO_VALIDA', ['fin_descanso']]);
    assert.strictEqual((await q1(`SELECT COUNT(*)::int AS n FROM xecador_checadas WHERE empleado_id = $1`, [LUZ.id])).n, antes, 'no se registró');
    assert.strictEqual((await checarDesde(TA, 8, PIN.LUZ, undefined, 'fin_descanso')).tipo, 'fin_descanso');
    assert.deepStrictEqual((await identificar(TA, 8, PIN.LUZ)).datos.posibles, ['salida', 'inicio_descanso']);
    assert.strictEqual((await checarDesde(TA, 8, PIN.LUZ, undefined, 'salida')).tipo, 'salida');
    assert.deepStrictEqual((await identificar(TA, 8, PIN.LUZ)).datos.posibles, ['entrada']);
  });

  await t('B4. «Para revisar» trae los turnos que no cuadran, con quién, cuándo, el día y lo que pasó', async () => {
    const r = await revisar();
    assert.ok(Array.isArray(r.secuencia));
    const de = (emp) => r.secuencia.filter((a) => a.empleado_id === emp.id).map((a) => `${a.motivo}@${a.ancla}`);
    assert.deepStrictEqual(de(ABEL), [`reentrada@c:${ABEL_S1}`], 'Abel: salió y volvió a entrar');
    assert.deepStrictEqual(de(BETO), [`descanso_sin_cerrar@c:${BET_I}`], 'Beto: descanso sin cerrar');
    assert.deepStrictEqual(de(EMA), [`repetida@c:${EMA_E2}`], 'Ema: dos entradas en 70 s');
    assert.deepStrictEqual(de(FER), [`turno_largo@c:${FER_E}`], 'Fer: 13 h 15 min');
    assert.deepStrictEqual(de(GIL), [`sin_salida@c:${GIL_E}`], 'Gil: sin salida');
    const abel = r.secuencia.find((a) => a.empleado_id === ABEL.id);
    assert.deepStrictEqual([abel.numero_empleado, abel.empleado, abel.fecha], [1, 'Abel Regresa', fechaLocal(jd(95))]);
    assert.deepStrictEqual(abel.eventos.map((e) => [e.clave, e.tipo]), [[`c:${ABEL_S1}`, 'salida'], [`c:${ABEL_E2}`, 'entrada']]);
    // Lo más reciente primero.
    const horas = r.secuencia.map((a) => Date.parse(a.hora));
    assert.deepStrictEqual([...horas].sort((a, b) => b - a), horas);
    // Y M no ve nada de N.
    assert.deepStrictEqual((await revisar(COOKIES.adminM)).secuencia, []);
    assert.strictEqual((await http('GET', `${CHK}/revisar`, { cookie: COOKIES.staffN })).status, 403);
  });

  await t('B5. corregir con el flujo de siempre quita la alerta sola; las checadas originales no cambian', async () => {
    const ids = [GIL_E, BET_I, BET_S, EMA_E2];
    const antes = await originales(ids);
    // Gil: se agrega la salida que faltó.
    assert.strictEqual((await corr({ accion: 'agregar', empleado_id: GIL.id, tipo: 'salida', hora: entradaLocal(gd(480)) })).status, 201);
    assert.deepStrictEqual(await alertasDe(GIL), []);
    // Beto: se agrega el fin del descanso en ese mismo minuto.
    assert.strictEqual((await corr({ accion: 'agregar', empleado_id: BETO.id, tipo: 'fin_descanso', hora: entradaLocal(rd(482)) })).status, 201);
    assert.deepStrictEqual(await alertasDe(BETO), []);
    // Ema: la entrada repetida se anula.
    assert.strictEqual((await corr({ accion: 'anular', checada_id: EMA_E2 })).status, 201);
    assert.deepStrictEqual(await alertasDe(EMA), []);
    assert.deepStrictEqual(await originales(ids), antes, 'las checadas no se tocan');
  });

  await t('B6. «Revisada» para lo que sí pasó: una vez, con autor y nota; desaparece de la lista; solo el administrador del negocio', async () => {
    const [fer] = await alertasDe(FER);
    for (const [quien, cookie, st] of [['staff', COOKIES.staffN, 403], ['M', COOKIES.adminM, 404], ['super', COOKIES.super, 403]]) {
      assert.strictEqual((await revisarAlerta({ motivo: fer.motivo, ancla: fer.ancla }, cookie)).status, st, quien);
    }
    for (const [cuerpo, st, codigo] of [
      [{ motivo: 'otra_cosa', ancla: fer.ancla }, 400, 'MOTIVO_INVALIDO'],
      [{ motivo: 'turno_largo', ancla: 'c:abc' }, 404, 'ALERTA_NO_ENCONTRADA'],
      [{ motivo: 'turno_largo', ancla: 'c:999999999' }, 404, 'ALERTA_NO_ENCONTRADA'],
      [{ motivo: 'sin_salida', ancla: fer.ancla }, 409, 'ALERTA_YA_NO_ESTA'],
      [{ motivo: 'sin_salida', ancla: `c:${GIL_E}` }, 409, 'ALERTA_YA_NO_ESTA'],
      [{ motivo: fer.motivo, ancla: fer.ancla, nota: 'x'.repeat(301) }, 400, 'NOTA_INVALIDA'],
    ]) {
      const r = await revisarAlerta(cuerpo);
      assert.deepStrictEqual([r.status, r.datos?.codigo], [st, codigo], JSON.stringify(cuerpo).slice(0, 80));
    }
    const ok = await revisarAlerta({ motivo: fer.motivo, ancla: fer.ancla, nota: 'Cubrió doble turno' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.datos));
    assert.deepStrictEqual([ok.datos.revision.autor, ok.datos.revision.nota], ['Admin N', 'Cubrió doble turno']);
    assert.deepStrictEqual(await alertasDe(FER), [], 'ya no está para revisar');
    const otra = await revisarAlerta({ motivo: fer.motivo, ancla: fer.ancla });
    assert.deepStrictEqual([otra.status, otra.datos.codigo], [409, 'YA_REVISADA']);
    assert.deepStrictEqual(await q1(`SELECT negocio_id, empleado_id, motivo, ancla, nota, revisada_por FROM xecador_revisiones_secuencia WHERE ancla = $1`, [fer.ancla]),
      { negocio_id: N, empleado_id: FER.id, motivo: 'turno_largo', ancla: fer.ancla, nota: 'Cubrió doble turno', revisada_por: ADMIN_N });
  });

  await t('B7. sin conexión y desordenadas: se registran todas, se ordenan por la hora real y lo imposible se marca', async () => {
    // Hugo checa sin internet: entrada hace 40 min, descanso a los 20 y salida a los 30, sin fin de descanso.
    // La tablet las manda al revés.
    const ref = CRIPTO.firmarReferencia(TA.id, Date.now() - 40 * 60000);
    const pinCifrado = async (clave) => {
      const s = globalThis.crypto.subtle;
      const enc = (x) => new TextEncoder().encode(x);
      const pub = await s.importKey('raw', Buffer.from(CRIPTO.LLAVE_PUBLICA, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const ef = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const bits = await s.deriveBits({ name: 'ECDH', public: pub }, ef.privateKey, 256);
      const base = await s.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      const aes = await s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc('xecador'), info: enc('xecador-pin-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = await s.encrypt({ name: 'AES-GCM', iv, additionalData: enc(clave) }, aes, enc(PIN.HUGO));
      const b64 = (b) => Buffer.from(b).toString('base64');
      return { epk: b64(await s.exportKey('raw', ef.publicKey)), iv: b64(iv), ct: b64(ct) };
    };
    const item = async (tipo, ms) => {
      const clave = randomUUID();
      return { clave, numero: 6, tipo, ref, transcurrido_ms: ms, pin_cifrado: await pinCifrado(clave),
        hora_dispositivo: new Date(Number(ref.split('.')[0]) + ms).toISOString() };
    };
    const [entrada, descanso, salida] = [await item('entrada', 1000), await item('inicio_descanso', 20 * 60000), await item('salida', 30 * 60000)];
    const r = await http('POST', '/api/checador/sincronizar', { tablet: TA.token, cuerpo: { checadas: [salida, entrada, descanso] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    assert.deepStrictEqual(r.datos.resultados.map((x) => x.estado), ['recibida', 'recibida', 'recibida'], 'ninguna se pierde');
    const suyas = (await pool.query(`SELECT id, tipo, origen FROM xecador_checadas WHERE empleado_id = $1 ORDER BY hora_oficial`, [HUGO.id])).rows;
    assert.deepStrictEqual(suyas.map((c) => [c.tipo, c.origen]), [['entrada', 'sin_conexion'], ['inicio_descanso', 'sin_conexion'], ['salida', 'sin_conexion']]);
    const al = await alertasDe(HUGO);
    assert.deepStrictEqual(al.map((a) => `${a.motivo}@${a.ancla}`), [`descanso_sin_cerrar@c:${suyas[1].id}`], 'sin «sin entrada»: el orden es el de la hora');
  });
}

// ═══ C. Navegador: el panel ════════════════════════════════════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador');
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const ESPERA = { timeout: 15000 };

  await t('C1. a 390 px: «Para revisar» muestra cada alerta con su etiqueta y lo que pasó; «Revisada» con nota la quita; «Ver día» lleva al día', async () => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await pagina.setCookie({ name: 'xabor_sesion', value: COOKIES.adminN, url: servidor.base });
    await pagina.goto(servidor.base + '/personal', { waitUntil: 'networkidle0' });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#tab-checador');
    const fila = `#ch-revisar [data-alerta="reentrada|c:${ABEL_S1}"]`;
    await pagina.waitForSelector(fila, ESPERA);
    const texto = await pagina.$eval(fila, (el) => el.textContent);   // la etiqueta va en mayúsculas por CSS
    assert.match(texto, /Abel Regresa/);
    assert.match(texto, /Salió y volvió a entrar/);
    assert.match(texto, /Salida .* y Entrada .*, 17 min después\. ¿Era un descanso\?/);
    if (SOLO_RED) assert.strictEqual(await pagina.$(`#ch-revisar [data-id="${SOLO_RED.id}"]`), null, 'la de solo red distinta no está');
    const etiquetas = await pagina.$$eval('#ch-revisar [data-alerta] .etq', (es) => es.map((e) => e.textContent));
    assert.ok(etiquetas.includes('Descanso sin cerrar'), etiquetas.join(', '));
    // «Otra red» es un dato: gris, nunca con el color de alarma.
    const redes = await pagina.$$eval('.etq', (es) => es.filter((e) => e.textContent === 'Otra red').map((e) => e.className));
    assert.ok(redes.length >= 2, `se ve en el día y en la checada con otro motivo (${redes.length})`);
    assert.deepStrictEqual([...new Set(redes)], ['etq gris']);
    const ancho = await pagina.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(ancho <= 390, `sin scroll horizontal (${ancho})`);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-para-revisar-secuencia.png'), fullPage: true });
    // «Revisada» con nota.
    await pagina.$$eval(`${fila} button`, (bs) => bs.find((b) => b.textContent === 'Revisada').click());
    await pagina.waitForSelector('#dlg-revisada[open]', ESPERA);
    assert.match(await pagina.$eval('#rv-texto', (el) => el.textContent), /Salió y volvió a entrar/);
    await pagina.type('#rv-nota', 'Fue a dejar a su hijo; lo autorizó el gerente');
    await pagina.click('#rv-confirmar');
    await pagina.waitForFunction((sel) => !document.querySelector(sel), ESPERA, fila);
    assert.strictEqual((await q1(`SELECT nota FROM xecador_revisiones_secuencia WHERE ancla = $1`, [`c:${ABEL_S1}`]))?.nota,
      'Fue a dejar a su hijo; lo autorizó el gerente');
    // «Ver día» de la de Hugo: el día de la alerta.
    const [hugo] = await alertasDe(HUGO);
    if (hugo) {
      await pagina.$$eval(`#ch-revisar [data-alerta="${hugo.motivo}|${hugo.ancla}"] button`, (bs) => bs.find((b) => b.textContent === 'Ver día').click());
      await pagina.waitForFunction((f) => document.getElementById('ch-fecha').value === f, ESPERA, hugo.fecha);
    }
    await ctx.close();
  });
  await navegador.close();
}

await servidor?.detener?.().catch?.(() => {});
await pool.end().catch(() => {});
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
