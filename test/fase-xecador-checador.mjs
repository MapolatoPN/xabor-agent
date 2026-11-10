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
//   7. Parte B2 (130): una corrección es un evento nuevo con motivo, autor y
//      fecha; la checada original no se toca y se ven las dos. Si otra persona
//      corrigió lo mismo entretanto, 409. Lo anulado no cuenta, tampoco para
//      lo que la tablet ofrece; lo agregado sí.
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
const CR = await import('../src/services/correccionesService.js');
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
// 'AAAA-MM-DDTHH:MM' en la hora de los negocios, desplazada unos minutos.
const horaLocalSql = async (minutos) => (await q1(
  `SELECT to_char((NOW() AT TIME ZONE 'America/Matamoros') + make_interval(mins => $1), 'YYYY-MM-DD"T"HH24:MI') AS h`, [minutos])).h;
const aLocalSql = async (instante, minutos = 0) => (await q1(
  `SELECT to_char((($1::timestamptz + make_interval(mins => $2)) AT TIME ZONE 'America/Matamoros'), 'YYYY-MM-DD"T"HH24:MI') AS h`, [instante, minutos])).h;

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
      { posibles: ['fin_descanso'], sugerida: 'fin_descanso', turnoSinCerrar: false }, 'en descanso, solo el fin del descanso');
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
let TK = null;               // tablet de las correcciones (Norte)
const COR = `${CHK}/correcciones`;
const corr = (cuerpo, cookie = COOKIES.adminN) => http('POST', COR, { cookie, cuerpo });

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
    for (const [tipo, posibles] of [['inicio_descanso', ['fin_descanso']], ['fin_descanso', ['salida', 'inicio_descanso']], ['salida', ['entrada']]]) {
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
    assert.deepStrictEqual([on.status, on.datos], [200, { foto_al_checar: true, cara_al_checar: 'apagado' }]);
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
      `DELETE FROM xecador_checadas WHERE id = ${c.id}`, 'TRUNCATE xecador_checadas, xecador_checada_fotos, xecador_correcciones, xecador_revisiones',
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
    assert.deepStrictEqual((await http('GET', `${CHK}/checadas?fecha=2020-01-01`, { cookie: COOKIES.adminN })).datos, { fecha: '2020-01-01', checadas: [], agregadas: [] });
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

  // ── Parte B2: correcciones ────────────────────────────────────────────────
  await t('B17. corregir tipo u hora: la original no se toca; queda quién, cuándo y por qué; validaciones y puertas', async () => {
    const [c0] = await checadasDe(ANA.id);
    const h = await horaLocalSql(-180);
    for (const [cuerpo, st, cod] of [
      [{ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: h, motivo: '  ' }, 400, 'MOTIVO_REQUERIDO'],
      [{ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: await horaLocalSql(120), motivo: 'x' }, 400, 'HORA_FUTURA'],
      [{ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: 'ayer', motivo: 'x' }, 400, 'HORA_INVALIDA'],
      [{ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: '2026-02-30T10:00', motivo: 'x' }, 400, 'HORA_INVALIDA'],
      [{ accion: 'modificar', checada_id: c0.id, tipo: 'pausa', hora: h, motivo: 'x' }, 400, 'TIPO_INVALIDO'],
      [{ accion: 'modificar', tipo: 'entrada', hora: h, motivo: 'x' }, 400, 'OBJETIVO_REQUERIDO'],
      [{ accion: 'borrar', checada_id: c0.id, motivo: 'x' }, 400, 'ACCION_INVALIDA'],
      [{ accion: 'modificar', checada_id: 999999999, tipo: 'entrada', hora: h, motivo: 'x' }, 404, 'CHECADA_NO_ENCONTRADA'],
    ]) {
      const r = await corr(cuerpo);
      assert.deepStrictEqual([r.status, r.datos?.codigo], [st, cod], JSON.stringify(cuerpo));
    }
    for (const [quien, cookie, st] of [['staff', COOKIES.staffN, 403], ['super', COOKIES.super, 403], ['M', COOKIES.adminM, 404], ['sin sesión', null, 401]]) {
      assert.strictEqual((await corr({ accion: 'anular', checada_id: c0.id, motivo: 'intento' }, cookie)).status, st, quien);
    }
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_correcciones WHERE objetivo_checada_id = $1`, [c0.id])).n, 0, 'ningún intento quedó');
    const r = await corr({ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: h, motivo: 'La tablet no tenía red', base: null });
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    assert.deepStrictEqual([r.datos.correccion.accion, r.datos.correccion.autor, r.datos.correccion.motivo], ['modificar', 'Admin N', 'La tablet no tenía red']);
    assert.deepStrictEqual((await checadasDe(ANA.id))[0], c0, 'la checada original no cambió');
    const local = await q1(`SELECT to_char(hora AT TIME ZONE 'America/Matamoros', 'YYYY-MM-DD"T"HH24:MI') AS h FROM xecador_correcciones WHERE id = $1`, [r.datos.correccion.id]);
    assert.strictEqual(local.h, h, 'la hora se entiende en la zona de los negocios');
    const dia = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    const fila = dia.datos.checadas.find((x) => x.id === Number(c0.id));
    assert.ok(fila.efectivo.corregida && !fila.efectivo.anulada, JSON.stringify(fila.efectivo));
    assert.strictEqual(new Date(fila.efectivo.hora).toISOString(), new Date(r.datos.correccion.hora).toISOString(), 'cuenta la corregida');
    assert.strictEqual(new Date(fila.hora_oficial).toISOString(), new Date(c0.hora_oficial).toISOString(), 'y se ve la original');
    assert.deepStrictEqual([fila.correcciones.length, fila.ultima_correccion_id], [1, r.datos.correccion.id]);
    const igual = await corr({ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: h, motivo: 'otra vez', base: r.datos.correccion.id });
    assert.deepStrictEqual([igual.status, igual.datos.codigo], [400, 'SIN_CAMBIOS'], 'lo mismo no es una corrección');
  });

  await t('B18. si otra persona corrigió lo mismo mientras tanto, 409 y no se pisa; dos a la vez con la misma base: entra una', async () => {
    const [c0] = await checadasDe(ANA.id);
    const ultima = (await q1(`SELECT MAX(id)::int AS id FROM xecador_correcciones WHERE objetivo_checada_id = $1`, [c0.id])).id;
    const vieja = await corr({ accion: 'anular', checada_id: c0.id, motivo: 'Con la pantalla vieja', base: null });
    assert.deepStrictEqual([vieja.status, vieja.datos.codigo], [409, 'CORRECCION_CAMBIO']);
    assert.match(vieja.datos.error, /Otra persona corrigió/);
    const [h1, h2] = [await horaLocalSql(-170), await horaLocalSql(-160)];
    const r = await Promise.all([
      corr({ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: h1, motivo: 'Primera', base: ultima }),
      corr({ accion: 'modificar', checada_id: c0.id, tipo: 'entrada', hora: h2, motivo: 'Segunda', base: ultima }),
    ]);
    assert.deepStrictEqual(r.map((x) => x.status).sort(), [201, 409]);
    assert.strictEqual(r.find((x) => x.status === 409).datos.codigo, 'CORRECCION_CAMBIO');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_correcciones WHERE objetivo_checada_id = $1`, [c0.id])).n, 2);
  });

  await t('B19. anular y restaurar: la anulada no cuenta, tampoco para lo que la tablet ofrece', async () => {
    TK = await nuevaTablet('Correcciones', NORTE);
    let id = await identificar(TK.token, 5, PIN.LIBRE);
    if (id.datos.posibles[0] === 'entrada') assert.strictEqual((await checarCon(TK.token, 5, PIN.LIBRE, 'entrada')).status, 201);
    // Salida por error.
    const sal = await checarCon(TK.token, 5, PIN.LIBRE, 'salida');
    assert.strictEqual(sal.status, 201);
    assert.deepStrictEqual((await identificar(TK.token, 5, PIN.LIBRE)).datos.posibles, ['entrada']);
    const an = await corr({ accion: 'anular', checada_id: sal.datos.checada.id, motivo: 'Tocó Salida por error', base: null });
    assert.strictEqual(an.status, 201, JSON.stringify(an.datos));
    id = await identificar(TK.token, 5, PIN.LIBRE);
    assert.deepStrictEqual(id.datos.posibles, ['salida', 'inicio_descanso'], 'sigue en turno');
    assert.notStrictEqual(id.datos.ultima?.tipo, 'salida', 'la tablet ya no la cuenta');
    const ventana = { empleadoId: LIBRE.id, desde: new Date(Date.now() - 6 * 3600e3), hasta: new Date(Date.now() + 60000) };
    assert.ok(!(await CR.lineaEfectiva(pool, N, ventana)).some((x) => x.checada_id === sal.datos.checada.id), 'fuera de la línea efectiva');
    assert.ok((await CR.lineaEfectiva(pool, N, { ...ventana, incluirAnuladas: true })).some((x) => x.checada_id === sal.datos.checada.id && x.efectivo.anulada));
    const otra = await corr({ accion: 'anular', checada_id: sal.datos.checada.id, motivo: 'x', base: an.datos.correccion.id });
    assert.deepStrictEqual([otra.status, otra.datos.codigo], [409, 'YA_ANULADA']);
    const re = await corr({ accion: 'restaurar', checada_id: sal.datos.checada.id, motivo: 'Sí había salido', base: an.datos.correccion.id });
    assert.strictEqual(re.status, 201);
    assert.deepStrictEqual((await identificar(TK.token, 5, PIN.LIBRE)).datos.posibles, ['entrada']);
    const otraVez = await corr({ accion: 'restaurar', checada_id: sal.datos.checada.id, motivo: 'x', base: re.datos.correccion.id });
    assert.deepStrictEqual([otraVez.status, otraVez.datos.codigo], [409, 'NO_ANULADA']);
    const dia = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    const fila = dia.datos.checadas.find((x) => x.id === sal.datos.checada.id);
    assert.deepStrictEqual([fila.correcciones.map((x) => x.accion), fila.efectivo.anulada], [['anular', 'restaurar'], false]);
  });

  await t('B20. agregar la checada que faltó: cuenta para la tablet, se ve en su día y se corrige como cualquier otra', async () => {
    // Caro no tiene checadas propias: la tablet le ofrece entrada hasta que se agrega la suya.
    assert.strictEqual((await checadasDe(CARO.id)).length, 0, 'precondición: Caro sin checadas');
    assert.deepStrictEqual((await identificar(TK.token, 3, PIN.CARO)).datos.posibles, ['entrada']);
    const h = await horaLocalSql(-5);
    const ag = await corr({ accion: 'agregar', empleado_id: CARO.id, tipo: 'entrada', hora: h, motivo: 'Llegó y no checó' });
    assert.strictEqual(ag.status, 201, JSON.stringify(ag.datos));
    assert.deepStrictEqual((await identificar(TK.token, 3, PIN.CARO)).datos.posibles, ['salida', 'inicio_descanso'], 'la agregada cuenta');
    const dia = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    const a = dia.datos.agregadas.find((x) => x.correccion_id === ag.datos.correccion.id);
    assert.deepStrictEqual([a.empleado, a.tipo, a.motivo, a.autor, a.efectivo.anulada], ['Caro Norte', 'entrada', 'Llegó y no checó', 'Admin N', false]);
    const h2 = await horaLocalSql(-8);
    const mod = await corr({ accion: 'modificar', correccion_id: ag.datos.correccion.id, tipo: 'entrada', hora: h2, motivo: 'Fue tres minutos antes', base: null });
    assert.strictEqual(mod.status, 201, JSON.stringify(mod.datos));
    const linea = await CR.lineaEfectiva(pool, N, { empleadoId: CARO.id, desde: new Date(Date.now() - 3600e3), hasta: new Date(Date.now() + 60000) });
    const enLinea = linea.find((x) => x.correccion_id === ag.datos.correccion.id);
    assert.deepStrictEqual([enLinea.origen, new Date(enLinea.efectivo.hora).toISOString()], ['agregada', new Date(mod.datos.correccion.hora).toISOString()]);
    const malo = await corr({ accion: 'anular', correccion_id: mod.datos.correccion.id, motivo: 'x' });
    assert.deepStrictEqual([malo.status, malo.datos.codigo], [400, 'OBJETIVO_INVALIDO'], 'no se corrige una corrección');
    assert.strictEqual((await corr({ accion: 'agregar', empleado_id: CARO.id, tipo: 'entrada', hora: h, motivo: 'x' }, COOKIES.adminM)).status, 404);
    assert.deepStrictEqual((await corr({ accion: 'agregar', empleado_id: 'no-es-uuid', tipo: 'entrada', hora: h, motivo: 'x' })).datos.codigo, 'EMPLEADO_NO_ENCONTRADO');
    // El turno sin cerrar de Beto (B12) se cierra con la salida que faltó.
    const vieja = await q1(`SELECT hora_oficial FROM xecador_checadas WHERE empleado_id = $1 ORDER BY hora_oficial LIMIT 1`, [BETO.id]);
    const salida = await corr({ accion: 'agregar', empleado_id: BETO.id, tipo: 'salida', hora: await aLocalSql(vieja.hora_oficial, 480), motivo: 'Olvidó checar la salida' });
    assert.strictEqual(salida.status, 201, JSON.stringify(salida.datos));
  });

  await t('B21. lo que queda fuera de orden se marca (dos entradas seguidas) y deja de marcarse al anularlo', async () => {
    const ent = await q1(`SELECT id, hora_oficial FROM xecador_checadas WHERE empleado_id = $1 ORDER BY hora_oficial DESC LIMIT 1`, [BETO.id]);
    const dup = await corr({ accion: 'agregar', empleado_id: BETO.id, tipo: 'entrada', hora: await aLocalSql(ent.hora_oficial, 1), motivo: 'Duplicada a propósito' });
    assert.strictEqual(dup.status, 201, JSON.stringify(dup.datos));
    const fecha = (await q1(`SELECT to_char($1::timestamptz AT TIME ZONE 'America/Matamoros', 'YYYY-MM-DD') AS f`, [ent.hora_oficial])).f;
    let dia = await http('GET', `${CHK}/checadas?fecha=${fecha}`, { cookie: COOKIES.adminN });
    assert.strictEqual(dia.datos.agregadas.find((x) => x.correccion_id === dup.datos.correccion.id).fuera_de_orden, true);
    assert.strictEqual(dia.datos.checadas.find((x) => x.id === Number(ent.id)).fuera_de_orden, false, 'la primera está bien');
    assert.strictEqual((await corr({ accion: 'anular', correccion_id: dup.datos.correccion.id, motivo: 'Era un duplicado', base: null })).status, 201);
    dia = await http('GET', `${CHK}/checadas?fecha=${fecha}`, { cookie: COOKIES.adminN });
    const a = dia.datos.agregadas.find((x) => x.correccion_id === dup.datos.correccion.id);
    assert.deepStrictEqual([a.efectivo.anulada, a.fuera_de_orden], [true, false]);
  });

  await t('B22. las correcciones son de solo inserción y no cruzan personas ni negocios, tampoco escribiendo en la base', async () => {
    const r = await q1(`SELECT id FROM xecador_correcciones WHERE negocio_id = $1 LIMIT 1`, [N]);
    for (const sql of [`UPDATE xecador_correcciones SET motivo = 'otro' WHERE id = ${r.id}`, `DELETE FROM xecador_correcciones WHERE id = ${r.id}`,
      'TRUNCATE xecador_correcciones']) {
      const e = await pgFalla('P0001', () => pool.query(sql));
      assert.match(e.message, /solo inserción/, sql);
    }
    const [c0] = await checadasDe(ANA.id);
    await pgFalla('23503', () => pool.query(
      `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_checada_id, motivo, creado_por) VALUES ($1, $2, 'anular', $3, 'ajena', $4)`,
      [N, BETO.id, c0.id, ADMIN_N]), 'xecador_correcciones_checada_fkey');
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_checada_id, tipo, hora, motivo, creado_por) VALUES ($1, $2, 'agregar', $3, 'entrada', NOW(), 'x', $4)`,
      [N, ANA.id, c0.id, ADMIN_N]), 'xecador_correcciones_forma');
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_checada_id, motivo, creado_por) VALUES ($1, $2, 'anular', $3, '   ', $4)`,
      [N, ANA.id, c0.id, ADMIN_N]), 'xecador_correcciones_motivo_check');
    const mod = await q1(`SELECT id, empleado_id FROM xecador_correcciones WHERE negocio_id = $1 AND accion = 'modificar' AND objetivo_checada_id IS NOT NULL LIMIT 1`, [N]);
    const e = await pgFalla('P0001', () => pool.query(
      `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_correccion_id, motivo, creado_por) VALUES ($1, $2, 'anular', $3, 'x', $4)`,
      [N, mod.empleado_id, mod.id, ADMIN_N]));
    assert.match(e.message, /solo puede apuntar a una checada agregada/);
    await pgFalla('23503', () => pool.query(
      `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_checada_id, motivo, creado_por) VALUES ($1, $2, 'anular', $3, 'otro negocio', $4)`,
      [M, DEM.id, c0.id, ADMIN_M]));
  });

  // ── Solo con el PIN (migración 132) ──────────────────────────────────────
  const soloPin = (tablet, pin, extra = {}) => http('POST', '/api/checador/identificar', { tablet, cuerpo: { pin, ...extra } });
  const fallosPin = async () => (await q1(
    `SELECT COALESCE(SUM(pin_fallos), 0)::int AS n, COUNT(pin_ultimo_fallo_at)::int AS con_fecha FROM xecador_empleados WHERE negocio_id = $1`, [N]));
  const indiceDe = async (id) => (await q1(`SELECT pin_indice FROM xecador_empleados WHERE id = $1`, [id])).pin_indice;
  const SOLO = await alta(N, { numero: 20, nombre: 'Solo Pin', sucursal_id: MATRIZ });
  PIN.SOLO = (await P.asignarPin(N, SOLO.id, { actorId: ADMIN_N })).pin;
  const TS = await nuevaTablet('Solo PIN', MATRIZ);

  await t('B23. solo el PIN: reconoce al empleado con la misma respuesta que número + PIN, y su pase sirve para checar', async () => {
    const r = await soloPin(TS.token, PIN.SOLO);
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    const con = await identificar(TS.token, 20, PIN.SOLO);
    assert.strictEqual(con.status, 200, JSON.stringify(con.datos));
    assert.deepStrictEqual(Object.keys(r.datos).sort(), Object.keys(con.datos).sort(), 'la misma forma de respuesta');
    for (const k of ['empleado', 'posibles', 'sugerida', 'ultima', 'foto_al_checar', 'pase_segundos']) {
      assert.deepStrictEqual(r.datos[k], con.datos[k], k);
    }
    assert.deepStrictEqual(r.datos.empleado, { nombre: 'Solo Pin', numero: 20 });
    assert.ok(!r.texto.includes(PIN.SOLO), 'el PIN no regresa');
    // Número vacío o nulo es «sin número» (la tablet nueva no lo manda).
    for (const numero of ['', null]) assert.strictEqual((await soloPin(TS.token, PIN.SOLO, { numero })).status, 200, JSON.stringify(numero));
    const c = await http('POST', '/api/checador/checar', { tablet: TS.token, cuerpo: { pase: r.datos.pase, tipo: 'entrada', clave: randomUUID() } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.datos));
    assert.deepStrictEqual([c.datos.checada.tipo, c.datos.empleado.nombre], ['entrada', 'Solo Pin']);
    const [ch] = (await checadasDe(SOLO.id)).slice(-1);
    assert.deepStrictEqual([ch.tipo, ch.dispositivo_id, ch.sucursal_id], ['entrada', TS.id, MATRIZ]);
    // Formato malo: 400 como siempre.
    for (const pin of ['12', 123456, '1234567', '12a456', undefined]) {
      const x = await soloPin(TS.token, pin);
      assert.deepStrictEqual([x.status, x.datos.codigo], [400, 'PIN_INVALIDO'], JSON.stringify(pin));
    }
  });

  await t('B24. solo el PIN: uno que no es de nadie, el de una baja o el de otro negocio dan «PIN incorrecto.» sin pausar a ningún empleado', async () => {
    const antes = await fallosPin();
    const deN = new Set(Object.entries(PIN).filter(([k]) => k !== 'DEM').map(([, v]) => v));
    const pruebas = [['de nadie', otroPin(PIN.SOLO)], ['de la baja', PIN.BAJA]];
    if (!deN.has(PIN.DEM)) pruebas.push(['de otro negocio', PIN.DEM]);
    for (const [que, pin] of pruebas) {
      const r = await soloPin(TS.token, pin);
      assert.deepStrictEqual([r.status, r.datos.codigo, r.datos.error], [401, 'CREDENCIALES', 'PIN incorrecto.'], que);
      assert.ok(!('pase' in r.datos) && !r.texto.includes('Dada de Baja') && !r.texto.includes('Ana de M'), que);
    }
    assert.deepStrictEqual(await fallosPin(), antes, 'un PIN equivocado no le cuenta un fallo a nadie');
    // Otra sucursal y su permiso: las mismas reglas que con número (B12 se lo dio a Beto).
    await pool.query(`UPDATE xecador_empleados SET puede_checar_otras_sucursales = false WHERE id = $1`, [BETO.id]);
    const beto = await soloPin(TS.token, PIN.BETO);
    await pool.query(`UPDATE xecador_empleados SET puede_checar_otras_sucursales = true WHERE id = $1`, [BETO.id]);
    assert.deepStrictEqual([beto.status, beto.datos.codigo], [403, 'OTRA_SUCURSAL']);
    assert.match(beto.datos.error, /Norte/);
    assert.strictEqual((await soloPin(TS.token, PIN.CARO)).status, 200, 'Caro puede checar en otras sucursales');
    assert.strictEqual((await soloPin(TS.token, PIN.LIBRE)).status, 200, 'sin sucursal no se le impide');
    // El PIN en pausa (por fallos con número desde una tablet vieja) se respeta.
    await pool.query(`UPDATE xecador_empleados SET pin_bloqueado_hasta = NOW() + interval '3 minutes' WHERE id = $1`, [SOLO.id]);
    const pausado = await soloPin(TS.token, PIN.SOLO);
    assert.deepStrictEqual([pausado.status, pausado.datos.codigo], [423, 'PIN_EN_PAUSA']);
    await pool.query(`UPDATE xecador_empleados SET pin_bloqueado_hasta = NOW() - interval '1 second' WHERE id = $1`, [SOLO.id]);
    assert.strictEqual((await soloPin(TS.token, PIN.SOLO)).status, 200);
    assert.deepStrictEqual(await q1(`SELECT pin_fallos, pin_bloqueado_hasta FROM xecador_empleados WHERE id = $1`, [SOLO.id]),
      { pin_fallos: 0, pin_bloqueado_hasta: null }, 'el acierto limpia la pausa vencida');
    // Con un PIN nuevo, el anterior deja de servir al instante.
    const viejo = PIN.SOLO;
    PIN.SOLO = (await P.asignarPin(N, SOLO.id, { actorId: ADMIN_N })).pin;
    assert.strictEqual((await soloPin(TS.token, viejo)).status, 401);
    assert.strictEqual((await soloPin(TS.token, PIN.SOLO)).status, 200);
  });

  await t('B25. PIN anteriores (sin índice o con otra llave): se reconocen por su hash y reciben su índice la primera vez', async () => {
    const { indicePin, HUELLA } = await import('../src/services/pinIndice.js');
    const otraHuella = HUELLA === '00000000' ? '11111111' : '00000000';
    // Sin índice (generado antes de la 132) y con la huella de otra llave.
    for (const indice of [null, `${otraHuella}.${'A'.repeat(43)}`]) {
      await pool.query(`UPDATE xecador_empleados SET pin_indice = $2 WHERE id = $1`, [SOLO.id, indice]);
      assert.strictEqual((await soloPin(TS.token, otroPin(PIN.SOLO))).status, 401, 'el equivocado sigue sin ser de nadie');
      const r = await soloPin(TS.token, PIN.SOLO);
      assert.strictEqual(r.status, 200, `${indice}: ${JSON.stringify(r.datos)}`);
      assert.strictEqual(r.datos.empleado.nombre, 'Solo Pin');
      assert.strictEqual(await indiceDe(SOLO.id), indicePin(N, PIN.SOLO), 'se le puso su índice');
    }
    // Un PIN anterior de 4 dígitos también.
    const { hashPin } = P;
    await pool.query(`UPDATE xecador_empleados SET pin_hash = $2, pin_indice = NULL WHERE id = $1`, [SOLO.id, await hashPin('4321')]);
    assert.strictEqual((await soloPin(TS.token, '4321')).status, 200);
    assert.strictEqual(await indiceDe(SOLO.id), indicePin(N, '4321'));
    // El de una baja no se busca entre los anteriores.
    await pool.query(`UPDATE xecador_empleados SET pin_indice = NULL WHERE id = $1`, [BAJA.id]);
    assert.strictEqual((await soloPin(TS.token, PIN.BAJA)).status, 401);
    assert.strictEqual(await indiceDe(BAJA.id), null);
    await pool.query(`UPDATE xecador_empleados SET pin_indice = $2 WHERE id = $1`, [BAJA.id, indicePin(N, PIN.BAJA)]);
    // Dos PIN anteriores iguales: no se adivina de quién es; con número sigue entrando.
    const DOS = await alta(N, { numero: 21, nombre: 'Mismo PIN', sucursal_id: MATRIZ });
    await P.asignarPin(N, DOS.id, { actorId: ADMIN_N });
    await pool.query(`UPDATE xecador_empleados SET pin_hash = (SELECT pin_hash FROM xecador_empleados WHERE id = $2), pin_indice = NULL WHERE id IN ($1, $2)`,
      [DOS.id, SOLO.id]);
    const rep = await soloPin(TS.token, '4321');
    assert.deepStrictEqual([rep.status, rep.datos.codigo], [409, 'PIN_REPETIDO']);
    assert.match(rep.datos.error, /otra persona/);
    assert.ok(!rep.texto.includes('Mismo PIN') && !rep.texto.includes('Solo Pin'), 'no dice de quién');
    assert.deepStrictEqual([await indiceDe(SOLO.id), await indiceDe(DOS.id)], [null, null], 'a ninguno se le pone índice');
    assert.strictEqual((await identificar(TS.token, 21, '4321')).status, 200, 'con número entra como antes');
    // Al darle a uno un PIN nuevo, el otro vuelve a checar solo con el suyo.
    const nuevo = (await P.asignarPin(N, DOS.id, { actorId: ADMIN_N })).pin;
    assert.strictEqual((await soloPin(TS.token, '4321')).datos.empleado.nombre, 'Solo Pin');
    assert.strictEqual((await soloPin(TS.token, nuevo)).datos.empleado.nombre, 'Mismo PIN');
    PIN.SOLO = (await P.asignarPin(N, SOLO.id, { actorId: ADMIN_N })).pin;
  });

  await t('B26. solo el PIN: muchos PIN equivocados pausan la tablet un minuto (con aviso), no a un empleado', async () => {
    const TPS = await nuevaTablet('Pausa solo PIN', MATRIZ);
    const antes = await fallosPin();
    const malos = new Set();
    for (let i = 0; malos.size < 15; i++) {
      const pin = String(100000 + ((i * 7919) % 900000)).padStart(6, '0');
      if (!Object.values(PIN).includes(pin)) malos.add(pin);
    }
    let i = 0;
    for (const pin of malos) {
      const r = await soloPin(TPS.token, pin);
      assert.strictEqual(r.status, 401, `fallo ${++i}: ${JSON.stringify(r.datos)}`);
    }
    const pausada = await soloPin(TPS.token, PIN.SOLO);
    assert.deepStrictEqual([pausada.status, pausada.datos.codigo], [429, 'TABLET_EN_PAUSA'], 'ni con el PIN correcto');
    assert.strictEqual((await soloPin(TS.token, PIN.SOLO)).status, 200, 'la otra tablet sigue');
    assert.deepStrictEqual(await fallosPin(), antes, 'ningún empleado acumuló fallos');
    await pausa(300);
    const a = (await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminN })).datos.avisos.find((x) => x.tipo === 'dispositivo_pausado' && x.dispositivo === 'Pausa solo PIN');
    assert.ok(a, 'aviso de la tablet en pausa');
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
  await t('C1. la tablet se vincula con el código, y el empleado checa SOLO con su PIN viendo su nombre antes de confirmar', async () => {
    const { pagina, ctx } = await abrirTablet();
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-vincular', ESPERA);
    const c = await crearCodigo('Tablet del navegador');
    await pagina.type('#v-codigo', c.codigo.replace('-', '').toLowerCase());
    assert.strictEqual(await pagina.$eval('#v-codigo', (el) => el.value), c.codigo, 'se escribe con su guion');
    await pagina.click('#v-boton');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    token = await pagina.evaluate(() => localStorage.getItem('xecador_tablet_token'));
    assert.strictEqual((await q1(`SELECT token_hash FROM xecador_dispositivos WHERE id = $1`, [c.dispositivo.id])).token_hash, sha256(token));
    assert.match(await textoDe(pagina, '#donde'), /Negocio N · Matriz · Tablet del navegador/);
    assert.match(await textoDe(pagina, '#reloj'), /\d{1,2}:\d{2}/);
    // Ya no hay pantalla de número: lo primero que pide es el PIN.
    assert.strictEqual(await pagina.evaluate(() => document.getElementById('p-numero')), null);
    assert.strictEqual(await textoDe(pagina, '#pin-titulo'), 'Escribe tu PIN');
    const antes = (await checadasDe(ANA.id)).length;
    // Borrar con el PIN vacío no hace nada (no hay a dónde regresar).
    await pagina.click('#pin-teclado [data-tecla="borrar"]');
    assert.strictEqual(await pantalla(pagina), 'p-pin');
    await teclear(pagina, 'pin-teclado', PIN.ANA);
    assert.strictEqual(await textoDe(pagina, '#pin-campo'), '•'.repeat(PIN.ANA.length), 'el PIN no se ve');
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    assert.strictEqual(await textoDe(pagina, '#c-hola'), 'Ana Matriz', 'el nombre, en grande y solo');
    const html = await pagina.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!html.includes(PIN.ANA), 'el PIN no se queda en la página');
    const botones = await pagina.$$eval('#c-acciones button', (bs) => bs.map((b) => [b.dataset.accion, b.textContent]));
    // Solo lo que le toca, del mismo tamaño y en orden fijo (sin «sugerida» resaltada).
    const trabajando = ['entrada', 'fin_descanso'].includes((await checadasDe(ANA.id)).at(-1)?.tipo);
    assert.deepStrictEqual(botones, trabajando ? [['inicio_descanso', 'Inicio de descanso'], ['salida', 'Salida']] : [['entrada', 'Entrada']]);
    assert.deepStrictEqual(await pagina.$$eval('#c-acciones button', (bs) => bs.map((b) => b.className)), botones.map(() => 'btn'));
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-confirmar.png') });
    await pagina.click('#c-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.match(await textoDe(pagina, '#r-texto'), /registrada$/);
    assert.match(await textoDe(pagina, '#r-detalle'), /Ana Matriz · \d{1,2}:\d{2}/);
    assert.strictEqual((await checadasDe(ANA.id)).length, antes + 1);
    // Vuelve sola al inicio, sin el nombre de nadie.
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', { timeout: 7000 });
    assert.strictEqual(await textoDe(pagina, '#c-hola'), '');
    // La tablet no guarda nada de los empleados (ni nombres ni números).
    const guardado = await pagina.evaluate(() => Object.keys(localStorage).sort());
    assert.deepStrictEqual(guardado.filter((k) => !['xecador_tablet_token', 'xecador_llave', 'xecador_foto', 'xecador_cara'].includes(k)), []);
    await ctx.close();
  });

  await t('C1b. en descanso la tablet ofrece SOLO «Fin de descanso»; al registrar, la acción y el nombre en grande', async () => {
    // Ana queda en descanso (por la API, como si hubiera checado antes).
    const ultima = (await checadasDe(ANA.id)).at(-1)?.tipo;
    if (ultima !== 'inicio_descanso') {
      if (!['entrada', 'fin_descanso'].includes(ultima)) assert.strictEqual((await checarCon(token, 1, PIN.ANA, 'entrada')).status, 201);
      assert.strictEqual((await checarCon(token, 1, PIN.ANA, 'inicio_descanso')).status, 201);
    }
    const { pagina, ctx } = await abrirTablet();
    await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
    await pagina.reload({ waitUntil: 'networkidle0' });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    await teclear(pagina, 'pin-teclado', PIN.ANA);
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    assert.deepStrictEqual(await pagina.$$eval('#c-acciones button', (bs) => bs.map((b) => [b.dataset.accion, b.textContent])),
      [['fin_descanso', 'Fin de descanso']], 'ni Salida ni nada más');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-en-descanso.png') });
    await pagina.click('#c-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.strictEqual(await textoDe(pagina, '#r-texto'), 'Fin de descanso registrada');
    assert.deepStrictEqual(await pagina.evaluate(() => [document.getElementById('r-texto').dataset.accion,
      document.getElementById('r-detalle').classList.contains('grande')]), ['fin_descanso', true]);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-registrada.png') });
    assert.strictEqual((await checadasDe(ANA.id)).at(-1).tipo, 'fin_descanso');
    await ctx.close();
  });

  await t('C2. PIN equivocado: «PIN incorrecto.» y regresa al inicio (con el teclado físico también)', async () => {
    const { pagina, ctx } = await abrirTablet();
    await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
    // Lo que recordaba la página anterior se borra al abrir.
    await pagina.evaluate(() => localStorage.setItem('xecador_nombres', '{"1":"Ana Matriz"}'));
    await pagina.reload({ waitUntil: 'networkidle0' });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    assert.strictEqual(await pagina.evaluate(() => localStorage.getItem('xecador_nombres')), null);
    for (const pin of [otroPin(PIN.ANA), '135790']) {
      await pagina.keyboard.type(pin);
      await pagina.keyboard.press('Enter');
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
      assert.strictEqual(await textoDe(pagina, '#r-texto'), 'PIN incorrecto.', pin);
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', { timeout: 7000 });
    }
    await ctx.close();
  });

  await t('C3. con la foto encendida, la tablet la toma con la cámara y el administrador la ve; luego se apaga la cámara', async () => {
    await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { foto_al_checar: true } });
    try {
      const { pagina, ctx } = await abrirTablet();
      await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
      await pagina.reload({ waitUntil: 'networkidle0' });
      await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
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
    assert.deepStrictEqual((await http('GET', `${CHK}/config`, { cookie: COOKIES.adminN })).datos, { foto_al_checar: true, cara_al_checar: 'apagado' });
    paso = 23;
    await pagina.click('#ch-foto');
    paso = 24;
    await pagina.waitForFunction(() => document.getElementById('aviso').innerText.includes('Ya no se pide'), ESPERA);
    // Atender un aviso.
    const n0 = await pagina.$$eval('#ch-avisos .fila', (f) => f.length);
    paso = 25;
    await pagina.evaluate(() => [...document.querySelectorAll('#ch-avisos .fila button')].find((b) => b.textContent === 'Atendido').click());
    paso = 26;
    await pagina.waitForFunction((n) => document.querySelectorAll('#ch-avisos .fila').length === n - 1, ESPERA, n0);
    await ctx.close();
    } catch (e) { throw new Error(`paso ${paso}: ${e.message}`); }
  });

  await t('C5. una tablet revocada vuelve a la pantalla de vincular y olvida su token', async () => {
    const { pagina, ctx } = await abrirTablet();
    await pagina.evaluate((t) => localStorage.setItem('xecador_tablet_token', t), token);
    await pagina.reload({ waitUntil: 'networkidle0' });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    const id = (await q1(`SELECT id FROM xecador_dispositivos WHERE token_hash = $1`, [sha256(token)])).id;
    assert.strictEqual((await http('POST', `${CHK}/dispositivos/${id}/revocar`, { cookie: COOKIES.adminN, cuerpo: {} })).status, 200);
    await teclear(pagina, 'pin-teclado', PIN.ANA);
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-vincular', ESPERA);
    assert.match(await textoDe(pagina, '#v-error'), /ya no está autorizada/);
    assert.strictEqual(await pagina.evaluate(() => localStorage.getItem('xecador_tablet_token')), null);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-checador-vincular.png') });
    await ctx.close();
  });

  await t('C7. el administrador corrige desde la pantalla: cambiar hora, anular, agregar (también desde el aviso) y ver las dos', async () => {
    let paso = 0;
    try {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await pagina.setCookie({ name: 'xabor_sesion', value: COOKIES.adminN, url: servidor.base });
    await pagina.goto(servidor.base + '/personal', { waitUntil: 'networkidle0' });
    paso = 1;
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    paso = 2;
    await pagina.click('#tab-checador');
    paso = 3;
    await pagina.waitForFunction(() => document.querySelectorAll('#ch-checadas .fila').length > 0, ESPERA);
    // La de Ana corregida en B17/B18: se ve como cuenta, con la original y sus correcciones.
    const [c0] = await checadasDe(ANA.id);
    const fila0 = await pagina.$eval(`#ch-checadas .fila[data-id="${c0.id}"]`, (f) => f.innerText);
    assert.match(fila0, /Corregida/i);   // la etiqueta va en mayúsculas por CSS
    assert.match(fila0, /Como se registró: Entrada/);
    assert.match(fila0, /Admin N cambió a Entrada.*La tablet no tenía red/s);
    // Cambiar la hora de una checada de Caro.
    const cCaro = (await checadasDe(CARO.id)).at(-1) || null;
    const objetivo = cCaro || (await checadasDe(LIBRE.id)).at(-1);
    await pagina.evaluate((id) => [...document.querySelectorAll(`#ch-checadas .fila[data-id="${id}"] button`)].find((b) => b.textContent === 'Corregir').click(), String(objetivo.id));
    paso = 4;
    await pagina.waitForSelector('#dlg-corr[open]', ESPERA);
    assert.strictEqual(await pagina.$eval('#corr-op-anular', (el) => el.classList.contains('oculto')), false);
    assert.strictEqual(await pagina.$eval('#corr-op-restaurar', (el) => el.classList.contains('oculto')), true);
    paso = 5;
    await pagina.click('#corr-guardar');
    paso = 6;
    await pagina.waitForFunction(() => document.getElementById('corr-error').innerText.includes('motivo'), ESPERA);
    await pagina.$eval('#corr-hora', (el, v) => { el.value = v; }, await horaLocalSql(-30));
    paso = 7;
    await pagina.type('#corr-motivo', 'Ajuste desde la pantalla');
    paso = 8;
    await pagina.click('#corr-guardar');
    paso = 9;
    await pagina.waitForFunction(() => !document.querySelector('#dlg-corr[open]'), ESPERA);
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_correcciones WHERE objetivo_checada_id = $1 AND motivo = 'Ajuste desde la pantalla'`, [objetivo.id])).n, 1);
    // Anularla.
    paso = 10;
    // Que la lista ya traiga la primera corrección: si no, el diálogo saldría
    // con la base vieja y el servidor contestaría (con razón) 409.
    await pagina.waitForFunction((id) => (document.querySelector(`#ch-checadas .fila[data-id="${id}"]`)?.innerText || '').includes('Ajuste desde la pantalla'), ESPERA, String(objetivo.id));
    await pagina.evaluate((id) => [...document.querySelectorAll(`#ch-checadas .fila[data-id="${id}"] button`)].find((b) => b.textContent === 'Corregir').click(), String(objetivo.id));
    paso = 11;
    await pagina.waitForSelector('#dlg-corr[open]', ESPERA);
    paso = 12;
    await pagina.click('#corr-op-anular input');
    assert.strictEqual(await pagina.$eval('#corr-valores', (el) => el.classList.contains('oculto')), true, 'anular no pide tipo ni hora');
    paso = 13;
    await pagina.type('#corr-motivo', 'Anulada desde la pantalla');
    paso = 14;
    await pagina.click('#corr-guardar');
    paso = 15;
    await pagina.waitForFunction((id) => document.querySelector(`#ch-checadas .fila[data-id="${id}"]`)?.classList.contains('anulada'), ESPERA, String(objetivo.id));
    // Agregar desde el aviso del turno sin cerrar (si sigue pendiente) o con «+ Agregar».
    const desdeAviso = await pagina.evaluate(() => {
      const b = [...document.querySelectorAll('#ch-avisos .fila button')].find((x) => x.textContent === 'Agregar salida');
      if (b) b.click();
      return !!b;
    });
    if (!desdeAviso) await pagina.click('#ch-agregar');
    paso = 16;
    await pagina.waitForSelector('#dlg-corr[open]', ESPERA);
    paso = 17;
    await pagina.waitForFunction(() => document.querySelectorAll('#corr-empleado option').length > 0, ESPERA);
    if (desdeAviso) {
      assert.strictEqual(await pagina.$eval('#corr-empleado', (el) => el.value), BETO.id, 'el aviso trae a su empleado');
      assert.strictEqual(await pagina.$eval('#corr-tipo', (el) => el.value), 'salida');
    }
    await pagina.select('#corr-empleado', CARO.id);
    await pagina.select('#corr-tipo', 'salida');
    await pagina.$eval('#corr-hora', (el, v) => { el.value = v; }, await horaLocalSql(-2));
    paso = 18;
    await pagina.type('#corr-motivo', 'Salió sin checar');
    paso = 19;
    await pagina.click('#corr-guardar');
    paso = 20;
    await pagina.waitForFunction(() => !document.querySelector('#dlg-corr[open]'), ESPERA);
    paso = 21;
    await pagina.waitForFunction(() => [...document.querySelectorAll('#ch-checadas .fila')].some((f) => f.dataset.agregada && f.innerText.includes('Salió sin checar')), ESPERA);
    assert.match(await textoDe(pagina, '#ch-checadas'), /\nAGREGADA\n/i);
    assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sin scroll horizontal a 390 px');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-correcciones.png'), fullPage: true });
    await ctx.close();
    } catch (e) { throw new Error(`paso ${paso}: ${e.message}`); }
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
