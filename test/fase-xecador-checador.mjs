// XECADOR · checador (Parte B1, migración 129).
//
// Lo que protege, en orden de lo que más caro sale:
//
//   1. Una checada no se cambia ni se borra, ni escribiendo directo en la base
//      (UPDATE, DELETE, TRUNCATE): es el registro de jornada.
//   2. La hora oficial es la del servidor; la de la tablet se guarda aparte y
//      no la sustituye. Un reintento con la misma clave no duplica.
//   3. Solo una tablet autorizada checa, y solo para su sucursal y su negocio.
//      Del código y del token se guarda solo el hash; revocar la deja fuera.
//   4. El PIN: 5 fallos seguidos lo pausan 5 minutos (nunca todo el turno) y
//      dejan un aviso al administrador; un número que no existe contesta igual
//      que un PIN equivocado. Lo que falta en el expediente no impide checar.
//   5. La foto es opcional por negocio; sin cámara se checa igual («sin foto»).
//   6. Nadie de otro negocio, ni el staff, ni el Superadmin ve o toca nada.
//
// Corre contra una base LOCAL desechable (nombre test_*) con la 129 aplicada.
// Levanta su propio servidor hijo y un navegador real (con cámara simulada).
//
// Variables opcionales: TEST_PORT_XECADOR_CHECADOR (4782), CASOS=A,B,C.
import assert from 'assert';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { arrancarServidor } from './lib-servidor.mjs';

const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = process.env.TEST_PORT_XECADOR_CHECADOR || '4782';
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));
const CAPTURAS = process.env.XECADOR_CAPTURAS || tmpdir();

const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const CH = await import('../src/services/checadorService.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const pgFalla = async (codigo, fn, restriccion) => {
  try { await fn(); }
  catch (e) {
    assert.strictEqual(e.code, codigo, `esperaba SQLSTATE ${codigo} y vino ${e.code}: ${e.message}`);
    if (restriccion) assert.strictEqual(e.constraint, restriccion, `restricción ${e.constraint}`);
    return e;
  }
  assert.fail(`la base aceptó lo que debía rechazar (${codigo})`);
};
const sha256 = (x) => createHash('sha256').update(String(x)).digest('hex');
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture: negocios, sucursales, personas y empleados nuevos ──────────────
const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `checador-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const sucursal = async (neg, nombre) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, true) RETURNING id`, [neg, nombre])).id;
const persona = async (neg, nombre, rol) => {
  const id = (await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@checador.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });

const N = await negocio('Negocio N');
const M = await negocio('Negocio M');
const PLATAFORMA = await negocio('Plataforma');
const MATRIZ = await sucursal(N, 'Matriz');
const NORTE = await sucursal(N, 'Norte');
const SUC_M = await sucursal(M, 'Única M');
const ADMIN_N = await persona(N, 'Admin N', 'admin');
const STAFF_N = await persona(N, 'Cajero N', 'staff');
const ADMIN_M = await persona(M, 'Admin M', 'admin');
const SUPER = await persona(PLATAFORMA, 'Superadmin', 'admin');
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, true)`, [SUPER]);
const COOKIES = {
  adminN: sesion(ADMIN_N, N, 'admin'), staffN: sesion(STAFF_N, N, 'staff'),
  adminM: sesion(ADMIN_M, M, 'admin'), super: sesion(SUPER, PLATAFORMA, 'admin'),
};

// Empleados de N: con sucursal, de otra sucursal (con y sin permiso), sin
// sucursal, sin PIN, y una baja. Y uno de M con el mismo número que Ana.
const alta = (neg, datos) => P.crearEmpleado(neg, datos, { actorId: neg === N ? ADMIN_N : ADMIN_M });
const ANA = await alta(N, { numero: 1, nombre: 'Ana Matriz', sucursal_id: MATRIZ, fecha_ingreso: '2025-01-10' });
const BETO = await alta(N, { numero: 2, nombre: 'Beto Norte', sucursal_id: NORTE });
const CARO = await alta(N, { numero: 3, nombre: 'Caro Norte', sucursal_id: NORTE, puede_checar_otras_sucursales: true });
const SINPIN = await alta(N, { numero: 4, nombre: 'Sin PIN', sucursal_id: MATRIZ });
const LIBRE = await alta(N, { numero: 5, nombre: 'Sin Sucursal', sucursal_id: null });
const BAJA = await alta(N, { numero: 6, nombre: 'Dada de Baja', sucursal_id: MATRIZ });
const DEM = await alta(M, { numero: 1, nombre: 'Ana de M', sucursal_id: SUC_M });
const PIN = {};
for (const [k, e] of Object.entries({ ANA, BETO, CARO, LIBRE, BAJA, DEM })) {
  PIN[k] = (await P.asignarPin(e.id === DEM.id ? M : N, e.id, { longitud: 6, actorId: e.id === DEM.id ? ADMIN_M : ADMIN_N })).pin;
}
await P.darDeBajaEmpleado(N, BAJA.id, { tipo: 'renuncia', actorId: ADMIN_N });
// Un PIN equivocado que de seguro no es el suyo.
const otroPin = (pin) => (pin === '135790' ? '246802' : '135790');

// ═══ A. Base de datos y reglas puras ═══════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Base de datos y reglas');

  await t('A1. qué toca registrar: según la última checada, y un turno de más de 16 h ya no es el de hoy', () => {
    const ahora = new Date('2026-11-06T18:00:00Z');
    const hace = (h) => new Date(ahora - h * 3.6e6).toISOString();
    assert.deepStrictEqual(CH.estadoTurno(null, ahora), { posibles: ['entrada'], sugerida: 'entrada', turnoSinCerrar: false });
    assert.deepStrictEqual(CH.estadoTurno({ tipo: 'salida', hora_oficial: hace(1) }, ahora).posibles, ['entrada']);
    assert.deepStrictEqual(CH.estadoTurno({ tipo: 'entrada', hora_oficial: hace(2) }, ahora),
      { posibles: ['salida', 'inicio_descanso'], sugerida: 'salida', turnoSinCerrar: false });
    assert.deepStrictEqual(CH.estadoTurno({ tipo: 'inicio_descanso', hora_oficial: hace(0.5) }, ahora),
      { posibles: ['fin_descanso', 'salida'], sugerida: 'fin_descanso', turnoSinCerrar: false });
    assert.deepStrictEqual(CH.estadoTurno({ tipo: 'fin_descanso', hora_oficial: hace(3) }, ahora).posibles, ['salida', 'inicio_descanso']);
    // Turno nocturno: entrada a las 22:00 y salida a las 6:00 (8 h) sigue siendo el mismo turno.
    assert.deepStrictEqual(CH.estadoTurno({ tipo: 'entrada', hora_oficial: hace(8) }, ahora).posibles, ['salida', 'inicio_descanso']);
    assert.deepStrictEqual(CH.estadoTurno({ tipo: 'entrada', hora_oficial: hace(17) }, ahora),
      { posibles: ['entrada'], sugerida: 'entrada', turnoSinCerrar: true });
  });

  await t('A2. tabla de tablets: sin sucursal de otro negocio, código con vencimiento y token solo en una tablet vinculada', async () => {
    await pgFalla('23503', () => pool.query(
      `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre) VALUES ($1, $2, 'Ajena')`, [N, SUC_M]), 'xecador_dispositivos_sucursal_fkey');
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre, codigo_hash) VALUES ($1, $2, 'Sin vencimiento', 'x')`, [N, MATRIZ]),
      'xecador_dispositivos_codigo_vence');
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre, token_hash) VALUES ($1, $2, 'Token sin vincular', 'x')`, [N, MATRIZ]),
      'xecador_dispositivos_token_vinculado');
  });
}

// ═══ B. Servidor real ══════════════════════════════════════════════════════
let servidor = null;
async function http(metodo, ruta, { cookie, tablet, bearer, cuerpo } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}`;
  if (tablet) headers.Authorization = `Bearer ${tablet}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(servidor.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const tipo = r.headers.get('content-type') || '';
  const crudo = Buffer.from(await r.arrayBuffer());
  let datos = null;
  if (tipo.includes('json')) { try { datos = JSON.parse(crudo.toString('utf8')); } catch { /* nada */ } }
  return { status: r.status, datos, texto: crudo.toString('utf8'), crudo, headers: r.headers };
}
const modulo = (neg, estado) => http('PATCH', `/api/superadmin/negocios/${neg}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
const CHK = '/api/personal/checador';

if (PARTES.has('B') || PARTES.has('C')) {
  servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
  for (const neg of [N, M]) assert.strictEqual((await modulo(neg, 'activo')).status, 200, 'precondición: módulo encendido');
}

/** Autoriza una tablet por HTTP y la vincula: devuelve { id, token, codigo }. */
async function nuevaTablet(nombre, sucursalId, cookie = COOKIES.adminN) {
  const c = await http('POST', `${CHK}/dispositivos`, { cookie, cuerpo: { nombre, sucursal_id: sucursalId } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.datos));
  const v = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: c.datos.codigo } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.datos));
  return { id: c.datos.dispositivo.id, token: v.datos.token, codigo: c.datos.codigo };
}
const identificar = (tablet, numero, pin) => http('POST', '/api/checador/identificar', { tablet, cuerpo: { numero, pin } });
async function checarCon(tablet, numero, pin, tipo, extra = {}) {
  const id = await identificar(tablet, numero, pin);
  assert.strictEqual(id.status, 200, `identificar #${numero}: ${id.status} ${JSON.stringify(id.datos)}`);
  return http('POST', '/api/checador/checar', { tablet, cuerpo: { pase: id.datos.pase, tipo, clave: randomUUID(), ...extra } });
}
const checadasDe = async (empleadoId) => (await pool.query(
  `SELECT id, tipo, hora_oficial, hora_dispositivo, foto, dispositivo_id, sucursal_id FROM xecador_checadas WHERE empleado_id = $1 ORDER BY id`, [empleadoId])).rows;
// Una foto JPEG mínima (solo importan los bytes de cabecera y el tamaño).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]);

let T1 = null, T2 = null;   // tablets de la Matriz de N

if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');

  await t('B1. autorizar una tablet: el código se ve una vez y en la base solo queda su hash; staff, otro negocio y el Superadmin no pueden', async () => {
    const r = await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminN, cuerpo: { nombre: 'Entrada', sucursal_id: MATRIZ } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    assert.match(r.datos.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    assert.strictEqual(r.datos.dispositivo.estado, 'pendiente');
    const fila = await q1(`SELECT codigo_hash, token_hash, codigo_expira_at > NOW() + interval '25 minutes' AS vence_bien FROM xecador_dispositivos WHERE id = $1`,
      [r.datos.dispositivo.id]);
    assert.strictEqual(fila.codigo_hash, sha256(r.datos.codigo.replace('-', '')), 'solo el hash del código');
    assert.ok(fila.vence_bien && fila.token_hash === null);
    const lista = await http('GET', `${CHK}/dispositivos`, { cookie: COOKIES.adminN });
    assert.ok(!lista.texto.includes(r.datos.codigo.replace('-', '')) && !lista.texto.includes('codigo_hash'), 'la lista no trae el código');
    for (const [quien, cookie, esperado] of [['staff', COOKIES.staffN, 403], ['super', COOKIES.super, 403], ['sin sesión', null, 401]]) {
      const x = await http('POST', `${CHK}/dispositivos`, { cookie, cuerpo: { nombre: 'Intento', sucursal_id: MATRIZ } });
      assert.strictEqual(x.status, esperado, `${quien} → ${x.status}`);
    }
    const ajena = await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminM, cuerpo: { nombre: 'Ajena', sucursal_id: MATRIZ } });
    assert.deepStrictEqual([ajena.status, ajena.datos.codigo], [400, 'SUCURSAL_INVALIDA'], 'M no autoriza tablets en la sucursal de N');
    // Canjearlo: una sola vez.
    const v = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: r.datos.codigo.toLowerCase() } });
    assert.strictEqual(v.status, 200, JSON.stringify(v.datos));
    assert.match(v.headers.get('cache-control') || '', /no-store/);
    assert.deepStrictEqual(v.datos.dispositivo, { nombre: 'Entrada', sucursal: 'Matriz', negocio: 'Negocio N' });
    T1 = { id: r.datos.dispositivo.id, token: v.datos.token };
    const otra = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: r.datos.codigo } });
    assert.deepStrictEqual([otra.status, otra.datos.codigo], [400, 'CODIGO_INVALIDO'], 'el código no sirve dos veces');
    const ya = await q1(`SELECT codigo_hash, token_hash FROM xecador_dispositivos WHERE id = $1`, [T1.id]);
    assert.deepStrictEqual(ya, { codigo_hash: null, token_hash: sha256(T1.token) }, 'solo el hash del token');
  });

  await t('B2. un código vencido o inventado no vincula nada', async () => {
    const c = await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminN, cuerpo: { nombre: 'Vencida', sucursal_id: MATRIZ } });
    await pool.query(`UPDATE xecador_dispositivos SET codigo_expira_at = NOW() - interval '1 minute' WHERE id = $1`, [c.datos.dispositivo.id]);
    for (const codigo of [c.datos.codigo, 'ABCD-EFGH', '12', { x: 1 }]) {
      const v = await http('POST', '/api/checador/vincular', { cuerpo: { codigo } });
      assert.deepStrictEqual([v.status, v.datos?.codigo], [400, 'CODIGO_INVALIDO'], JSON.stringify(codigo));
    }
    const l = await http('GET', `${CHK}/dispositivos`, { cookie: COOKIES.adminN });
    assert.strictEqual(l.datos.dispositivos.find((d) => d.id === c.datos.dispositivo.id).estado, 'codigo_vencido');
  });

  await t('B3. sin token de tablet, o con uno falso, el checador no responde nada', async () => {
    for (const tablet of [null, 'falso-falso-falso-falso-falso', T1.token.slice(0, -2) + 'xx']) {
      for (const [m, ruta, cuerpo] of [['GET', '/api/checador/estado'], ['POST', '/api/checador/identificar', { numero: 1, pin: PIN.ANA }]]) {
        const r = await http(m, ruta, { tablet, cuerpo });
        assert.deepStrictEqual([r.status, r.datos?.codigo], [401, 'tablet_no_autorizada'], `${m} ${ruta} con ${tablet}`);
        assert.ok(!r.texto.includes('Ana'), 'no trae datos');
      }
    }
    // La sesión del administrador tampoco sirve como tablet.
    const conCookie = await http('POST', '/api/checador/identificar', { cookie: COOKIES.adminN, cuerpo: { numero: 1, pin: PIN.ANA } });
    assert.strictEqual(conCookie.status, 401);
    const e = await http('GET', '/api/checador/estado', { tablet: T1.token });
    assert.strictEqual(e.status, 200, JSON.stringify(e.datos));
    assert.deepStrictEqual(e.datos.dispositivo, { nombre: 'Entrada', sucursal: 'Matriz', negocio: 'Negocio N' });
    assert.ok(Math.abs(Date.parse(e.datos.ahora) - Date.now()) < 60000, 'la hora es la del servidor');
  });

  await t('B4. identificar: número inexistente y PIN equivocado contestan igual; sin PIN y la baja, no checan; formato malo, 400', async () => {
    const malPin = await identificar(T1.token, 1, otroPin(PIN.ANA));
    const sinNumero = await identificar(T1.token, 777, PIN.ANA);
    const baja = await identificar(T1.token, 6, PIN.BAJA);
    for (const r of [malPin, sinNumero, baja]) {
      assert.deepStrictEqual([r.status, r.datos.codigo, r.datos.error], [401, 'CREDENCIALES', 'Número o PIN incorrecto.']);
      assert.ok(!('pase' in r.datos) && !r.texto.includes('Ana'));
    }
    const sinPin = await identificar(T1.token, 4, '123457');
    assert.deepStrictEqual([sinPin.status, sinPin.datos.codigo], [409, 'SIN_PIN']);
    for (const [numero, pin, codigo] of [[1, '12', 'PIN_INVALIDO'], [1, 123456, 'PIN_INVALIDO'], ['abc', PIN.ANA, 'NUMERO_INVALIDO']]) {
      const r = await identificar(T1.token, numero, pin);
      assert.deepStrictEqual([r.status, r.datos.codigo], [400, codigo], `${numero}/${pin}`);
    }
    const ok = await identificar(T1.token, '001', PIN.ANA);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.datos));
    assert.match(ok.headers.get('cache-control') || '', /no-store/);
    assert.deepStrictEqual([ok.datos.empleado, ok.datos.posibles, ok.datos.sugerida], [{ nombre: 'Ana Matriz', numero: 1 }, ['entrada'], 'entrada']);
    assert.ok(typeof ok.datos.pase === 'string' && ok.datos.pase.length > 40);
    assert.ok(!ok.texto.includes(PIN.ANA), 'el PIN no regresa');
    // El fallo de antes ya no cuenta tras el acierto.
    assert.strictEqual((await q1(`SELECT pin_fallos FROM xecador_empleados WHERE id = $1`, [ANA.id])).pin_fallos, 0);
  });

  await t('B5. sucursal: la de otra sucursal sin permiso no checa aquí; con permiso sí; sin sucursal (expediente incompleto) también', async () => {
    const beto = await identificar(T1.token, 2, PIN.BETO);
    assert.deepStrictEqual([beto.status, beto.datos.codigo], [403, 'OTRA_SUCURSAL']);
    assert.match(beto.datos.error, /Norte/);
    assert.strictEqual((await identificar(T1.token, 3, PIN.CARO)).status, 200, 'Caro puede checar en otras sucursales');
    assert.strictEqual((await identificar(T1.token, 5, PIN.LIBRE)).status, 200, 'sin sucursal no se le impide');
    // El mismo número en otro negocio es otra persona: la tablet de N no la encuentra.
    const deM = await identificar(T1.token, 1, PIN.DEM);
    assert.strictEqual(deM.status, PIN.DEM === PIN.ANA ? 200 : 401);
  });

  await t('B6. checar: la hora oficial es la del servidor; la de la tablet va aparte; la misma clave no duplica; el turno sigue su orden', async () => {
    const id = await identificar(T1.token, 1, PIN.ANA);
    const clave = randomUUID();
    const cuerpo = { pase: id.datos.pase, tipo: 'entrada', clave, hora_dispositivo: '2026-01-01T08:00:00.000Z' };
    const r = await http('POST', '/api/checador/checar', { tablet: T1.token, cuerpo });
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    assert.deepStrictEqual([r.datos.checada.tipo, r.datos.repetida, r.datos.empleado.nombre], ['entrada', false, 'Ana Matriz']);
    const [c] = await checadasDe(ANA.id);
    assert.ok(Math.abs(new Date(c.hora_oficial) - Date.now()) < 60000, 'hora oficial = servidor');
    assert.strictEqual(new Date(c.hora_dispositivo).toISOString(), '2026-01-01T08:00:00.000Z', 'la de la tablet, aparte y sin tocar');
    assert.deepStrictEqual([c.dispositivo_id, c.sucursal_id, c.foto], [T1.id, MATRIZ, 'no_requerida']);
    // El reintento (la respuesta se perdió): la misma checada.
    const otra = await http('POST', '/api/checador/checar', { tablet: T1.token, cuerpo });
    assert.deepStrictEqual([otra.status, otra.datos.repetida, otra.datos.checada.id], [200, true, r.datos.checada.id]);
    assert.strictEqual((await checadasDe(ANA.id)).length, 1);
    // Dos entradas seguidas no: el pase ya no corresponde.
    const doble = await http('POST', '/api/checador/checar', { tablet: T1.token, cuerpo: { ...cuerpo, clave: randomUUID() } });
    assert.deepStrictEqual([doble.status, doble.datos.codigo, doble.datos.posibles], [409, 'ACCION_NO_VALIDA', ['salida', 'inicio_descanso']]);
    // La clave de Ana no sirve para otra persona.
    const idCaro = await identificar(T1.token, 3, PIN.CARO);
    const robada = await http('POST', '/api/checador/checar', { tablet: T1.token, cuerpo: { pase: idCaro.datos.pase, tipo: 'entrada', clave } });
    assert.deepStrictEqual([robada.status, robada.datos.codigo], [409, 'CLAVE_USADA']);
    // Descanso, regreso y salida.
    for (const [tipo, posibles] of [['inicio_descanso', ['fin_descanso', 'salida']], ['fin_descanso', ['salida', 'inicio_descanso']], ['salida', ['entrada']]]) {
      const x = await checarCon(T1.token, 1, PIN.ANA, tipo);
      assert.strictEqual(x.status, 201, `${tipo}: ${JSON.stringify(x.datos)}`);
      assert.deepStrictEqual((await identificar(T1.token, 1, PIN.ANA)).datos.posibles, posibles, `después de ${tipo}`);
    }
    assert.deepStrictEqual((await checadasDe(ANA.id)).map((x) => x.tipo), ['entrada', 'inicio_descanso', 'fin_descanso', 'salida']);
    // Una hora de tablet que no se entiende no se guarda (y no impide checar).
    const rara = await checarCon(T1.token, 1, PIN.ANA, 'entrada', { hora_dispositivo: 'ayer' });
    assert.strictEqual(rara.status, 201);
    assert.strictEqual((await checadasDe(ANA.id)).at(-1).hora_dispositivo, null);
  });

  await t('B7. el pase está firmado y atado a su tablet: alterado o desde otra tablet no registra nada', async () => {
    T2 = await nuevaTablet('Cocina', MATRIZ);
    const antes = (await checadasDe(CARO.id)).length;
    const id = await identificar(T1.token, 3, PIN.CARO);
    const [datos, firma] = id.datos.pase.split('.');
    const otroEmpleado = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(datos, 'base64url')), e: ANA.id })).toString('base64url');
    for (const [nombre, tablet, pase] of [['firma cambiada', T1.token, `${datos}.${firma.slice(0, -2)}AA`],
      ['otro empleado con la misma firma', T1.token, `${otroEmpleado}.${firma}`], ['desde otra tablet', T2.token, id.datos.pase], ['sin pase', T1.token, undefined]]) {
      const r = await http('POST', '/api/checador/checar', { tablet, cuerpo: { pase, tipo: 'entrada', clave: randomUUID() } });
      assert.deepStrictEqual([r.status, r.datos.codigo], [401, 'PASE_INVALIDO'], nombre);
    }
    // Uno vencido (firmado con el secreto del servidor de pruebas).
    const secreto = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
    const viejo = Buffer.from(JSON.stringify({ d: T1.id, n: N, e: CARO.id, x: Date.now() - 1000 })).toString('base64url');
    const firmaVieja = createHmac('sha256', secreto).update(`xecador-pase|${viejo}`).digest('base64url');
    const vencido = await http('POST', '/api/checador/checar', { tablet: T1.token, cuerpo: { pase: `${viejo}.${firmaVieja}`, tipo: 'entrada', clave: randomUUID() } });
    assert.deepStrictEqual([vencido.status, vencido.datos.codigo], [401, 'PASE_INVALIDO'], 'vencido');
    assert.strictEqual((await checadasDe(CARO.id)).length, antes, 'nada se registró');
  });

  await t('B8. PIN: 5 fallos seguidos lo pausan 5 minutos, con aviso al administrador; la pausa no deja probar; termina sola o al restablecer el PIN', async () => {
    // Una tablet propia: sus 11 fallos no deben pausar la de los demás casos.
    const TP = await nuevaTablet('Pruebas de PIN', MATRIZ);
    const T1 = { token: TP.token };
    const pushAntes = (servidor.obtenerSalida().match(/\[Push\] VAPID no configurado/g) || []).length;
    for (let i = 1; i <= 4; i++) {
      const r = await identificar(T1.token, 3, otroPin(PIN.CARO));
      assert.deepStrictEqual([r.status, r.datos.codigo], [401, 'CREDENCIALES'], `fallo ${i}`);
    }
    const quinto = await identificar(T1.token, 3, otroPin(PIN.CARO));
    assert.deepStrictEqual([quinto.status, quinto.datos.codigo, quinto.datos.minutos], [423, 'PIN_EN_PAUSA', 5]);
    // Ni con el PIN correcto mientras dura (no se verifica: no se puede seguir probando).
    const correcto = await identificar(T1.token, 3, PIN.CARO);
    assert.deepStrictEqual([correcto.status, correcto.datos.codigo], [423, 'PIN_EN_PAUSA']);
    const fila = await q1(`SELECT pin_fallos, EXTRACT(EPOCH FROM (pin_bloqueado_hasta - NOW()))::int AS seg FROM xecador_empleados WHERE id = $1`, [CARO.id]);
    assert.ok(fila.seg > 240 && fila.seg <= 300, `pausa de 5 minutos (${fila.seg} s)`);
    // El aviso: lo ve el administrador de N (no el staff, no M).
    const avisos = await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminN });
    const aviso = avisos.datos.avisos.find((a) => a.tipo === 'pin_bloqueado');
    assert.ok(aviso, JSON.stringify(avisos.datos));
    assert.deepStrictEqual([aviso.numero_empleado, aviso.empleado, aviso.dispositivo, aviso.detalle.intentos, aviso.detalle.minutos],
      [3, 'Caro Norte', 'Pruebas de PIN', 5, 5]);
    assert.strictEqual((await http('GET', `${CHK}/avisos`, { cookie: COOKIES.staffN })).status, 403);
    assert.deepStrictEqual((await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminM })).datos.avisos, []);
    await pausa(300);
    const pushDespues = (servidor.obtenerSalida().match(/\[Push\] VAPID no configurado/g) || []).length;
    assert.ok(pushDespues > pushAntes, 'también se intentó el push al panel');
    // El directorio lo muestra.
    const lista = await http('GET', '/api/personal/empleados', { cookie: COOKIES.adminN });
    assert.ok(lista.datos.empleados.find((e) => e.id === CARO.id).pin_en_pausa_hasta, 'la tarjeta sabe que está en pausa');
    // Termina sola: pasado el tiempo, el PIN correcto entra y la cuenta vuelve a cero.
    await pool.query(`UPDATE xecador_empleados SET pin_bloqueado_hasta = NOW() - interval '1 second' WHERE id = $1`, [CARO.id]);
    assert.strictEqual((await identificar(T1.token, 3, PIN.CARO)).status, 200);
    assert.deepStrictEqual(await q1(`SELECT pin_fallos, pin_bloqueado_hasta FROM xecador_empleados WHERE id = $1`, [CARO.id]),
      { pin_fallos: 0, pin_bloqueado_hasta: null });
    // Fallos viejos (más de 15 minutos) ya no cuentan.
    await pool.query(`UPDATE xecador_empleados SET pin_fallos = 4, pin_ultimo_fallo_at = NOW() - interval '20 minutes' WHERE id = $1`, [CARO.id]);
    assert.strictEqual((await identificar(T1.token, 3, otroPin(PIN.CARO))).status, 401);
    assert.strictEqual((await q1(`SELECT pin_fallos FROM xecador_empleados WHERE id = $1`, [CARO.id])).pin_fallos, 1);
    // Restablecer el PIN quita la pausa al instante.
    for (let i = 0; i < 5; i++) await identificar(T1.token, 3, otroPin(PIN.CARO));
    assert.strictEqual((await identificar(T1.token, 3, PIN.CARO)).status, 423);
    PIN.CARO = (await P.asignarPin(N, CARO.id, { actorId: ADMIN_N })).pin;
    assert.strictEqual((await identificar(T1.token, 3, PIN.CARO)).status, 200, 'con el PIN nuevo entra');
    // Atender el aviso.
    const at = await http('POST', `${CHK}/avisos/${aviso.id}/atender`, { cookie: COOKIES.adminN, cuerpo: {} });
    assert.strictEqual(at.status, 200);
    assert.ok(!(await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminN })).datos.avisos.some((a) => a.id === aviso.id));
    assert.strictEqual((await http('POST', `${CHK}/avisos/${aviso.id}/atender`, { cookie: COOKIES.adminM, cuerpo: {} })).status, 404, 'M no atiende avisos de N');
  });

  await t('B9. foto: apagada no se guarda; encendida se guarda la de verdad; sin cámara o con basura se checa igual, «sin foto»', async () => {
    const foto = { datos: JPEG.toString('base64') };
    const apagada = await checarCon(T1.token, 5, PIN.LIBRE, 'entrada', { foto });
    assert.deepStrictEqual([apagada.status, apagada.datos.checada.foto], [201, 'no_requerida']);
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_checada_fotos WHERE checada_id = $1`, [apagada.datos.checada.id])).n, 0);
    assert.strictEqual((await http('PUT', `${CHK}/config`, { cookie: COOKIES.staffN, cuerpo: { foto_al_checar: true } })).status, 403);
    assert.deepStrictEqual((await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { foto_al_checar: 'sí' } })).datos.codigo, 'CONFIG_INVALIDA');
    const on = await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { foto_al_checar: true } });
    assert.deepStrictEqual([on.status, on.datos], [200, { foto_al_checar: true }]);
    assert.strictEqual((await identificar(T1.token, 5, PIN.LIBRE)).datos.foto_al_checar, true, 'la tablet sabe que hay que tomarla');
    const tomada = await checarCon(T1.token, 5, PIN.LIBRE, 'inicio_descanso', { foto });
    assert.deepStrictEqual([tomada.status, tomada.datos.checada.foto], [201, 'tomada']);
    const ver = await http('GET', `${CHK}/checadas/${tomada.datos.checada.id}/foto`, { cookie: COOKIES.adminN });
    assert.strictEqual(ver.status, 200);
    assert.strictEqual(ver.headers.get('content-type'), 'image/jpeg');
    assert.match(ver.headers.get('cache-control') || '', /no-store/);
    assert.ok(ver.crudo.equals(JPEG), 'la misma foto');
    for (const [quien, cookie, esperado] of [['M', COOKIES.adminM, 404], ['staff', COOKIES.staffN, 403], ['super', COOKIES.super, 403]]) {
      assert.strictEqual((await http('GET', `${CHK}/checadas/${tomada.datos.checada.id}/foto`, { cookie })).status, esperado, quien);
    }
    const png = { datos: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50)]).toString('base64') };
    const grande = { datos: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(160 * 1024)]).toString('base64') };
    for (const [nombre, tipo, extra] of [['sin cámara', 'fin_descanso', {}], ['otra cosa', 'salida', { foto: png }], ['enorme', 'entrada', { foto: grande }]]) {
      const r = await checarCon(T1.token, 5, PIN.LIBRE, tipo, extra);
      assert.deepStrictEqual([r.status, r.datos.checada.foto], [201, 'no_disponible'], nombre);
    }
    await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { foto_al_checar: false } });
  });

  await t('B10. checadas y fotos son de solo inserción también en la base; sus llaves no cruzan negocios', async () => {
    const c = (await checadasDe(ANA.id))[0];
    for (const sql of [`UPDATE xecador_checadas SET tipo = 'salida' WHERE id = ${c.id}`, `UPDATE xecador_checadas SET hora_oficial = NOW() WHERE id = ${c.id}`,
      `DELETE FROM xecador_checadas WHERE id = ${c.id}`, 'TRUNCATE xecador_checadas, xecador_checada_fotos',
      'UPDATE xecador_checada_fotos SET mime = mime', 'DELETE FROM xecador_checada_fotos', 'TRUNCATE xecador_checada_fotos']) {
      const e = await pgFalla('P0001', () => pool.query(sql));
      assert.match(e.message, /solo inserción/, sql);
    }
    assert.deepStrictEqual((await checadasDe(ANA.id))[0], c, 'intacta');
    await pgFalla('23503', () => pool.query(
      `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, clave) VALUES ($1, $2, $3, $4, 'entrada', gen_random_uuid())`,
      [M, ANA.id, MATRIZ, T1.id]));
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, clave) VALUES ($1, $2, $3, $4, 'pausa', gen_random_uuid())`,
      [N, ANA.id, MATRIZ, T1.id]), 'xecador_checadas_tipo_check');
  });

  await t('B11. el día de checadas: en orden, con quién, dónde, desde qué tablet y la foto; solo del propio negocio', async () => {
    const r = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    const deAna = r.datos.checadas.filter((c) => c.numero_empleado === 1);
    assert.deepStrictEqual(deAna.slice(0, 4).map((c) => c.tipo), ['entrada', 'inicio_descanso', 'fin_descanso', 'salida']);
    assert.deepStrictEqual([deAna[0].empleado, deAna[0].sucursal, deAna[0].dispositivo], ['Ana Matriz', 'Matriz', 'Entrada']);
    assert.ok(deAna[0].desfase_segundos < -1000, 'el desfase de la tablet se informa');
    assert.ok(r.datos.checadas.some((c) => c.foto === 'tomada') && r.datos.checadas.some((c) => c.foto === 'no_disponible'));
    const horas = r.datos.checadas.map((c) => Date.parse(c.hora_oficial));
    assert.deepStrictEqual(horas, [...horas].sort((a, b) => a - b), 'en orden');
    assert.deepStrictEqual((await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminM })).datos.checadas, [], 'M no ve las de N');
    assert.deepStrictEqual((await http('GET', `${CHK}/checadas?fecha=2020-01-01`, { cookie: COOKIES.adminN })).datos, { fecha: '2020-01-01', checadas: [] });
    assert.deepStrictEqual((await http('GET', `${CHK}/checadas?fecha=ayer`, { cookie: COOKIES.adminN })).datos.codigo, 'FECHA_INVALIDA');
    assert.strictEqual((await http('GET', `${CHK}/checadas`, { cookie: COOKIES.staffN })).status, 403);
  });

  await t('B12. un turno de hace más de 16 h sin salida: se ofrece entrada nueva y el administrador recibe un aviso', async () => {
    await pool.query(`INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, clave, hora_oficial)
                      VALUES ($1, $2, $3, $4, 'entrada', gen_random_uuid(), NOW() - interval '20 hours')`, [N, BETO.id, NORTE, T1.id]);
    await pool.query(`UPDATE xecador_empleados SET puede_checar_otras_sucursales = true WHERE id = $1`, [BETO.id]);
    const id = await identificar(T1.token, 2, PIN.BETO);
    assert.deepStrictEqual(id.datos.posibles, ['entrada']);
    const r = await http('POST', '/api/checador/checar', { tablet: T1.token, cuerpo: { pase: id.datos.pase, tipo: 'entrada', clave: randomUUID() } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    const a = (await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminN })).datos.avisos.find((x) => x.tipo === 'turno_sin_cerrar');
    assert.ok(a, 'aviso de turno sin cerrar');
    assert.deepStrictEqual([a.numero_empleado, a.detalle.ultima], [2, 'entrada']);
  });

  await t('B13. una tablet con muchos fallos se pausa un minuto (con aviso); las demás siguen checando', async () => {
    for (let i = 0; i < 15; i++) {
      const r = await identificar(T2.token, 900 + i, '135790');
      assert.strictEqual(r.status, 401, `fallo ${i + 1}`);
    }
    const pausada = await identificar(T2.token, 1, PIN.ANA);
    assert.deepStrictEqual([pausada.status, pausada.datos.codigo], [429, 'TABLET_EN_PAUSA']);
    assert.ok(pausada.datos.segundos > 0 && pausada.datos.segundos <= 60);
    assert.strictEqual((await identificar(T1.token, 1, PIN.ANA)).status, 200, 'la otra tablet sigue');
    await pausa(300);
    const a = (await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminN })).datos.avisos.find((x) => x.tipo === 'dispositivo_pausado');
    assert.ok(a && a.dispositivo === 'Cocina', JSON.stringify(a));
    // Ningún empleado quedó en pausa por números que no existen.
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE negocio_id = $1 AND pin_bloqueado_hasta > NOW()`, [N])).n, 0);
  });

  await t('B14. revocar: la tablet deja de checar al instante y sus checadas se quedan; M no revoca tablets de N', async () => {
    assert.strictEqual((await http('POST', `${CHK}/dispositivos/${T1.id}/revocar`, { cookie: COOKIES.adminM, cuerpo: {} })).status, 404);
    assert.strictEqual((await http('POST', `${CHK}/dispositivos/${T1.id}/revocar`, { cookie: COOKIES.staffN, cuerpo: {} })).status, 403);
    const antes = (await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE dispositivo_id = $1`, [T1.id])).n;
    const r = await http('POST', `${CHK}/dispositivos/${T1.id}/revocar`, { cookie: COOKIES.adminN, cuerpo: {} });
    assert.deepStrictEqual([r.status, r.datos.dispositivo.estado], [200, 'revocada']);
    for (const [m, ruta, cuerpo] of [['GET', '/api/checador/estado'], ['POST', '/api/checador/identificar', { numero: 1, pin: PIN.ANA }]]) {
      assert.deepStrictEqual((await http(m, ruta, { tablet: T1.token, cuerpo })).datos?.codigo, 'tablet_no_autorizada', ruta);
    }
    assert.deepStrictEqual(await q1(`SELECT token_hash, codigo_hash FROM xecador_dispositivos WHERE id = $1`, [T1.id]), { token_hash: null, codigo_hash: null });
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE dispositivo_id = $1`, [T1.id])).n, antes);
    // Ni a mano se borra: sus checadas (y avisos) la referencian.
    await pgFalla('23001', () => pool.query(`DELETE FROM xecador_dispositivos WHERE id = $1`, [T1.id]));
  });

  await t('B15. módulo suspendido: la tablet y el administrador reciben 403 y nada se registra', async () => {
    const T3 = await nuevaTablet('Respaldo', NORTE);
    assert.strictEqual((await modulo(N, 'suspendido')).status, 200);
    try {
      const n0 = (await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE negocio_id = $1`, [N])).n;
      for (const [m, ruta, opciones] of [['GET', '/api/checador/estado', { tablet: T3.token }],
        ['POST', '/api/checador/identificar', { tablet: T3.token, cuerpo: { numero: 3, pin: PIN.CARO } }],
        ['GET', `${CHK}/checadas`, { cookie: COOKIES.adminN }], ['GET', `${CHK}/dispositivos`, { cookie: COOKIES.adminN }]]) {
        const r = await http(m, ruta, opciones);
        assert.deepStrictEqual([r.status, r.datos?.codigo], [403, 'modulo_suspendido'], `${m} ${ruta}`);
      }
      assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE negocio_id = $1`, [N])).n, n0);
    } finally {
      await modulo(N, 'activo');
    }
    assert.strictEqual((await http('GET', '/api/checador/estado', { tablet: T3.token })).status, 200, 'de vuelta');
  });

  await t('B16. el Superadmin no administra el checador; /checador es una página sin datos y sin enlace a /app', async () => {
    for (const [m, ruta, cuerpo] of [['GET', `${CHK}/dispositivos`], ['GET', `${CHK}/checadas`], ['GET', `${CHK}/avisos`], ['GET', `${CHK}/config`],
      ['PUT', `${CHK}/config`, { foto_al_checar: true }], ['POST', `${CHK}/dispositivos`, { nombre: 'x', sucursal_id: MATRIZ }]]) {
      const r = await http(m, ruta, { cookie: COOKIES.super, cuerpo });
      assert.deepStrictEqual([r.status, r.datos?.codigo], [403, 'superadmin_sin_acceso_personal'], `${m} ${ruta}`);
    }
    const p = await http('GET', '/checador');
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /<title>Checador · Xecador<\/title>/);
    const codigo = p.texto.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(codigo, /href\s*=\s*["']\/app|location(\.href)?\s*=\s*["']\/app|new WebSocket/);
    assert.ok(!p.texto.includes('Ana Matriz'));
  });
}

// ═══ C. Navegador: la tablet y la pestaña del administrador ═════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador');
  const { default: puppeteer } = await import('puppeteer');
  // Cámara simulada: la foto al checar se puede probar de verdad.
  const navegador = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ESPERA = { timeout: 8000 };
  const textoDe = (pagina, sel) => pagina.$eval(sel, (el) => el.innerText);
  const pantalla = (pagina) => pagina.evaluate(() => document.body.dataset.pantalla);
  const abrirTablet = async ({ ancho = 800, alto = 1280 } = {}) => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: ancho, height: alto, hasTouch: true });
    await pagina.goto(servidor.base + '/checador', { waitUntil: 'networkidle0' });
    return { pagina, ctx };
  };
  const teclear = async (pagina, teclado, texto) => {
    for (const d of String(texto)) await pagina.click(`#${teclado} [data-tecla="${d}"]`);
  };
  // Una tablet de N para esta parte (las de B pudieron quedar revocadas o en pausa).
  const crearCodigo = async (nombre, suc = MATRIZ) =>
    (await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminN, cuerpo: { nombre, sucursal_id: suc } })).datos;

  let token = null;
  await t('C1. la tablet se vincula con el código, y el empleado checa con número y PIN viendo su nombre antes de confirmar', async () => {
    const { pagina, ctx } = await abrirTablet();
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-vincular', ESPERA);
    const c = await crearCodigo('Tablet del navegador');
    await pagina.type('#v-codigo', c.codigo.replace('-', '').toLowerCase());
    assert.strictEqual(await pagina.$eval('#v-codigo', (el) => el.value), c.codigo, 'se escribe con su guion');
    await pagina.click('#v-boton');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', ESPERA);
    token = await pagina.evaluate(() => localStorage.getItem('xecador_tablet_token'));
    assert.strictEqual((await q1(`SELECT token_hash FROM xecador_dispositivos WHERE id = $1`, [c.dispositivo.id])).token_hash, sha256(token));
    assert.match(await textoDe(pagina, '#donde'), /Negocio N · Matriz · Tablet del navegador/);
    assert.match(await textoDe(pagina, '#reloj'), /\d{1,2}:\d{2}/);
    const antes = (await checadasDe(ANA.id)).length;
    await teclear(pagina, 'n-teclado', '1');
    await pagina.click('#n-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    await teclear(pagina, 'pin-teclado', PIN.ANA);
    assert.strictEqual(await textoDe(pagina, '#pin-campo'), '•'.repeat(PIN.ANA.length), 'el PIN no se ve');
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    assert.strictEqual(await textoDe(pagina, '#c-hola'), 'Hola, Ana Matriz');
    const html = await pagina.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!html.includes(PIN.ANA), 'el PIN no se queda en la página');
    const botones = await pagina.$$eval('#c-acciones button', (bs) => bs.map((b) => [b.dataset.accion, b.textContent]));
    assert.deepStrictEqual(botones[0][0], (await checadasDe(ANA.id)).at(-1)?.tipo === 'entrada' ? 'salida' : 'entrada');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-confirmar.png') });
    await pagina.click('#c-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.match(await textoDe(pagina, '#r-texto'), /registrada$/);
    assert.match(await textoDe(pagina, '#r-detalle'), /Ana Matriz · \d{1,2}:\d{2}/);
    assert.strictEqual((await checadasDe(ANA.id)).length, antes + 1);
    // Vuelve sola al inicio, sin el nombre de nadie.
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', { timeout: 7000 });
    assert.strictEqual(await textoDe(pagina, '#c-hola'), '');
    await ctx.close();
  });

  await t('C2. PIN equivocado: lo dice y regresa al inicio sin decir si el número existe', async () => {
    const { pagina, ctx } = await abrirTablet();
    await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
    await pagina.reload({ waitUntil: 'networkidle0' });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', ESPERA);
    for (const [numero, pin] of [['1', otroPin(PIN.ANA)], ['888', '135790']]) {
      await teclear(pagina, 'n-teclado', numero);
      await pagina.keyboard.press('Enter');
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
      await pagina.keyboard.type(pin);
      await pagina.keyboard.press('Enter');
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
      assert.strictEqual(await textoDe(pagina, '#r-texto'), 'Número o PIN incorrecto.', `#${numero}`);
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', { timeout: 7000 });
    }
    await ctx.close();
  });

  await t('C3. con la foto encendida, la tablet la toma con la cámara y el administrador la ve; luego se apaga la cámara', async () => {
    await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { foto_al_checar: true } });
    try {
      const { pagina, ctx } = await abrirTablet();
      await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
      await pagina.reload({ waitUntil: 'networkidle0' });
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', ESPERA);
      await teclear(pagina, 'n-teclado', '5');
      await pagina.click('#n-teclado [data-tecla="listo"]');
      await teclear(pagina, 'pin-teclado', PIN.LIBRE);
      await pagina.click('#pin-teclado [data-tecla="listo"]');
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
      await pagina.waitForFunction(() => { const v = document.getElementById('camara'); return v && !v.classList.contains('oculto') && v.videoWidth > 0; }, ESPERA);
      const antes = (await checadasDe(LIBRE.id)).length;
      await pagina.click('#c-acciones button');
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
      const c = (await checadasDe(LIBRE.id)).at(-1);
      assert.strictEqual((await checadasDe(LIBRE.id)).length, antes + 1);
      assert.strictEqual(c.foto, 'tomada');
      const f = await q1(`SELECT mime, octet_length(datos) AS bytes FROM xecador_checada_fotos WHERE checada_id = $1`, [c.id]);
      assert.ok(f.mime === 'image/jpeg' && f.bytes > 500, JSON.stringify(f));
      assert.strictEqual(await pagina.evaluate(() => !!document.getElementById('camara').srcObject), false, 'la cámara se apagó');
      await ctx.close();
    } finally {
      await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { foto_al_checar: false } });
    }
  });

  await t('C4. el administrador: pestaña Checador con avisos, checadas (y su foto), tablets y la configuración; autoriza y revoca desde ahí', async () => {
    let paso = 0;
    try {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await pagina.setCookie({ name: 'xabor_sesion', value: COOKIES.adminN, url: servidor.base });
    await pagina.goto(servidor.base + '/personal', { waitUntil: 'networkidle0' });
    paso = 1;
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    // La pestaña cuenta los avisos pendientes desde que se abre.
    paso = 2;
    await pagina.waitForFunction(() => !document.getElementById('tab-avisos').classList.contains('oculto'), ESPERA);
    paso = 3;
    await pagina.click('#tab-checador');
    paso = 4;
    await pagina.waitForSelector('#checador:not(.oculto)', ESPERA);
    paso = 5;
    await pagina.waitForFunction(() => document.querySelectorAll('#ch-checadas .fila').length > 0, ESPERA);
    assert.strictEqual(await pagina.$eval('#directorio', (el) => el.classList.contains('oculto')), true);
    assert.match(await textoDe(pagina, '#ch-avisos'), /turno anterior|intentos fallidos/);
    assert.match(await textoDe(pagina, '#ch-checadas'), /Ana Matriz/);
    assert.match(await textoDe(pagina, '#ch-url'), /\/checador$/);
    assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sin scroll horizontal a 390 px');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-admin.png'), fullPage: true });
    // La foto.
    // La última foto es la que tomó la cámara en C3 (la de B9 son solo bytes de cabecera).
    await pagina.evaluate(() => [...document.querySelectorAll('#ch-checadas .fila button')].filter((b) => b.textContent === 'Ver foto').at(-1).click());
    paso = 6;
    await pagina.waitForSelector('#dlg-foto[open]', ESPERA);
    paso = 7;
    await pagina.waitForFunction(() => document.getElementById('ft-imagen').naturalWidth > 0, ESPERA);
    paso = 8;
    await pagina.click('#ft-cerrar');
    // Autorizar: el código se ve una vez y se borra al cerrar.
    paso = 9;
    await pagina.click('#ch-nueva');
    paso = 10;
    await pagina.waitForSelector('#dlg-tablet[open]', ESPERA);
    paso = 11;
    await pagina.type('#tab-nombre', 'Desde la pantalla');
    paso = 12;
    await pagina.click('#tab-generar');
    paso = 13;
    await pagina.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.getElementById('tab-codigo').textContent), ESPERA);
    const codigo = await textoDe(pagina, '#tab-codigo');
    assert.match(await textoDe(pagina, '#tab-instrucciones'), /\/checador.*una sola vez/);
    paso = 14;
    await pagina.click('#tab-cancelar');
    assert.strictEqual(await pagina.$eval('#tab-codigo', (el) => el.textContent), '', 'el código se borró');
    paso = 15;
    await pagina.waitForFunction(() => [...document.querySelectorAll('#ch-tablets .fila')].some((f) => f.innerText.includes('Desde la pantalla') && f.dataset.estado === 'pendiente'), ESPERA);
    assert.strictEqual((await http('POST', '/api/checador/vincular', { cuerpo: { codigo } })).status, 200, 'el código de la pantalla sirve');
    // Revocar.
    paso = 16;
    await pagina.click('#tab-checador');
    paso = 17;
    await pagina.waitForFunction(() => [...document.querySelectorAll('#ch-tablets .fila')].some((f) => f.innerText.includes('Desde la pantalla') && f.dataset.estado === 'activa'), ESPERA);
    await pagina.evaluate(() => [...document.querySelectorAll('#ch-tablets .fila')].find((f) => f.innerText.includes('Desde la pantalla')).querySelector('button').click());
    paso = 18;
    await pagina.waitForSelector('#dlg-revocar[open]', ESPERA);
    paso = 19;
    await pagina.click('#rev-confirmar');
    paso = 20;
    await pagina.waitForFunction(() => [...document.querySelectorAll('#ch-tablets .fila')].some((f) => f.innerText.includes('Desde la pantalla') && f.dataset.estado === 'revocada'), ESPERA);
    // La foto al checar se enciende desde aquí.
    paso = 21;
    await pagina.click('#ch-foto');
    paso = 22;
    await pagina.waitForFunction(() => document.getElementById('aviso').innerText.includes('Se pedirá foto'), ESPERA);
    assert.deepStrictEqual((await http('GET', `${CHK}/config`, { cookie: COOKIES.adminN })).datos, { foto_al_checar: true });
    paso = 23;
    await pagina.click('#ch-foto');
    paso = 24;
    await pagina.waitForFunction(() => document.getElementById('aviso').innerText.includes('Ya no se pide'), ESPERA);
    // Atender un aviso.
    const n0 = await pagina.$$eval('#ch-avisos .fila', (f) => f.length);
    paso = 25;
    await pagina.click('#ch-avisos .fila button');
    paso = 26;
    await pagina.waitForFunction((n) => document.querySelectorAll('#ch-avisos .fila').length === n - 1, ESPERA, n0);
    await ctx.close();
    } catch (e) { throw new Error(`paso ${paso}: ${e.message}`); }
  });

  await t('C5. una tablet revocada vuelve a la pantalla de vincular y olvida su token', async () => {
    const { pagina, ctx } = await abrirTablet();
    await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
    await pagina.reload({ waitUntil: 'networkidle0' });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', ESPERA);
    const id = (await q1(`SELECT id FROM xecador_dispositivos WHERE token_hash = $1`, [sha256(token)])).id;
    assert.strictEqual((await http('POST', `${CHK}/dispositivos/${id}/revocar`, { cookie: COOKIES.adminN, cuerpo: {} })).status, 200);
    await teclear(pagina, 'n-teclado', '1');
    await pagina.click('#n-teclado [data-tecla="listo"]');
    await teclear(pagina, 'pin-teclado', PIN.ANA);
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-vincular', ESPERA);
    assert.match(await textoDe(pagina, '#v-error'), /ya no está autorizada/);
    assert.strictEqual(await pagina.evaluate(() => localStorage.getItem('xecador_tablet_token')), null);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-vincular.png') });
    await ctx.close();
  });

  // Al final: deja la IP de las pruebas sin poder canjear códigos 10 minutos.
  await t('C6. canjear códigos a ciegas: tras 10 equivocados desde la misma IP, 429 (también con uno bueno); los buenos no cuentan', async () => {
    const bueno = await crearCodigo('Antes del límite');
    let intentos = 0, r = null;
    do {
      r = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: 'ZZZZ-ZZZZ' } });
      intentos++;
    } while (r.status === 400 && intentos <= 12);
    assert.deepStrictEqual([r.status, r.datos.codigo], [429, 'DEMASIADOS_INTENTOS'], `tras ${intentos} intentos`);
    // B1, B2 y C ya habían fallado algunos desde esta IP; los buenos de antes no contaron.
    assert.ok(intentos <= 10, `${intentos} intentos antes del 429`);
    const conBueno = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: bueno.codigo } });
    assert.strictEqual(conBueno.status, 429, 'ya no se prueba ni con el bueno');
    assert.strictEqual((await q1(`SELECT vinculado_at FROM xecador_dispositivos WHERE id = $1`, [bueno.dispositivo.id])).vinculado_at, null);
  });

  await navegador.close();
}

if (servidor) servidor.detener();
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
writeFileSync(join(CAPTURAS, 'xecador-checador-resultado.txt'), `${pasadas} ${fallidas}\n`);
process.exit(fallidas ? 1 : 0);
