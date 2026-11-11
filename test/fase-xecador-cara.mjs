// XECADOR · PIN + cara, fase 1 (migración 134).
//
// Lo que protege, en orden de lo que más caro sale:
//
//   1. Una checada NUNCA se pierde por la cara: sin cámara, sin cara, sin giro,
//      con otra cara o con el motor caído, se registra igual y queda «para
//      revisar» (con aviso si la cara no coincide).
//   2. Sin consentimiento no se guarda ninguna cara, y al retirarlo o con la
//      baja se borra. Lo garantiza la base (triggers), no solo el código; y
//      queda en la bitácora del expediente.
//   3. Lo que se guarda de la cara va cifrado y atado a su expediente; solo el
//      administrador del negocio lo ve, nadie de otro negocio, ni el staff, ni
//      el Superadmin. Una checada que coincide no guarda foto.
//   4. Una foto plana no pasa: hace falta que la cabeza gire, y que la que gira
//      sea la misma persona de la foto de frente.
//   5. El motor de prueba nunca corre en producción; sin motor, la cara no se
//      puede encender ni registrar.
//
// Corre contra una base LOCAL desechable (nombre test_*) con la 134 aplicada.
// Levanta su propio servidor hijo (con el motor de prueba) y un navegador real
// con cámara simulada.
//
// Variables opcionales: TEST_PORT_XECADOR_CARA (4794; el servidor sin motor
// usa el siguiente y el del motor real el que sigue), CASOS=A,B,C.
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrancarServidor } from './lib-servidor.mjs';

const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
process.env.XECADOR_CARA_MOTOR = 'prueba';   // esta suite y su servidor hijo
const PUERTO = process.env.TEST_PORT_XECADOR_CARA || '4794';
const PUERTO_SIN_MOTOR = String(Number(PUERTO) + 1);
const PUERTO_REAL = String(Number(PUERTO) + 2);   // B13: el motor real
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));
const CAPTURAS = process.env.XECADOR_CAPTURAS || tmpdir();

const { default: sharp } = await import('sharp');
const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const G = await import('../src/services/caraGeometria.js');
const MOTOR = await import('../src/services/caraMotor.js');
const K = await import('../src/services/caraCifrado.js');
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
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fotos del motor de prueba: un JPEG de verdad con la marca «XCARA {…}» ──
const LIENZO = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#7a7a7a' } }).jpeg().toBuffer();
function jpegCon(datos) {
  const texto = Buffer.from(MOTOR.MARCA_PRUEBA + JSON.stringify(datos));
  const largo = texto.length + 2;
  return Buffer.concat([LIENZO.subarray(0, 2), Buffer.from([0xff, 0xfe, largo >> 8, largo & 255]), texto, LIENZO.subarray(2)]);
}
const foto = (datos) => ({ datos: jpegCon(datos).toString('base64') });
const sinMarca = () => ({ datos: LIENZO.toString('base64') });
// Una checada: de frente y con la cabeza girada.
const checadaDe = (p, { giro = 0.18, r = 1 } = {}) => [foto({ p, r }), foto({ p, r: r + 1, g: giro / 2 }), foto({ p, r: r + 2, g: giro })];
const registroDe = (p, extra = {}) => [1, 2, 3, 4].map((r) => foto({ p, r: 100 + r, ...extra }));

// ── Fixture ────────────────────────────────────────────────────────────────
const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `cara-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const sucursal = async (neg, nombre) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, true) RETURNING id`, [neg, nombre])).id;
const persona = async (neg, nombre, rol) => {
  const id = (await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@cara.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });

const N = await negocio('Negocio N');
const M = await negocio('Negocio M');
const PLATAFORMA = await negocio('Plataforma');
const MATRIZ = await sucursal(N, 'Matriz');
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
const alta = (neg, datos) => P.crearEmpleado(neg, datos, { actorId: neg === N ? ADMIN_N : ADMIN_M });
let numero = 0;
const empleado = async (nombre, neg = N) => alta(neg, { numero: ++numero, nombre, sucursal_id: neg === N ? MATRIZ : SUC_M });
const PIN = {};
const conPin = async (e, neg = N) => { PIN[e.id] = (await P.asignarPin(neg, e.id, { longitud: 6, actorId: neg === N ? ADMIN_N : ADMIN_M })).pin; return e; };
const HOY = (await q1(`SELECT to_char((NOW() AT TIME ZONE 'America/Matamoros')::date, 'YYYY-MM-DD') AS h`)).h;
const consentir = (e, fecha = HOY) => pool.query(`UPDATE xecador_empleados SET consentimiento_cara_fecha = $2 WHERE id = $1`, [e.id, fecha]);
const eventos = async (e) => (await pool.query(
  `SELECT tipo, cambios, motivo, actor_id FROM xecador_empleado_eventos WHERE empleado_id = $1 ORDER BY id`, [e.id])).rows;
const carasDe = async (e) => (await pool.query(`SELECT * FROM xecador_caras WHERE empleado_id = $1`, [e.id])).rows;
const checadasDe = async (e) => (await pool.query(
  `SELECT id, tipo, foto, origen, revision, cara, cara_detalle, cara_similitud FROM xecador_checadas WHERE empleado_id = $1 ORDER BY id`, [e.id])).rows;

// ═══ A. Reglas puras, cifrado y base ═══════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Reglas, cifrado y base');
  const motor = MOTOR.obtenerMotor();
  const analizar = (lista) => Promise.all(lista.map((f) => motor.analizar(Buffer.from(f.datos, 'base64'))));
  const registro = (await analizar(registroDe('ana'))).map((a) => a.caras[0].vector);
  const evaluar = async (lista) => G.evaluarChecada({ analisis: await analizar(lista), registro, umbrales: motor.umbrales });

  await t('A1. el giro sale de la nariz respecto a los ojos, y no cambia al inclinar la cabeza de lado', () => {
    const ojos = [[100, 100], [160, 100]];
    assert.strictEqual(G.giro([...ojos, [130, 125]]), 0);
    assert.ok(Math.abs(G.giro([...ojos, [139, 125]]) - 0.15) < 1e-9);
    // La misma cara girada 30° en el plano (cabeza ladeada): el giro es el mismo.
    const rotar = ([x, y]) => [100 + (x - 100) * Math.cos(0.5) - (y - 100) * Math.sin(0.5), 100 + (x - 100) * Math.sin(0.5) + (y - 100) * Math.cos(0.5)];
    assert.ok(Math.abs(G.giro([...ojos, [139, 125]].map(rotar)) - 0.15) < 1e-9);
    assert.strictEqual(G.giro([[1, 1], [1, 1], [1, 1]]), null, 'sin distancia entre ojos no hay giro');
    assert.strictEqual(G.similitud([1, 0], [1, 0]), 1);
    assert.strictEqual(G.similitud([1, 0], [0, 1]), 0);
    assert.strictEqual(G.similitud([1, 0], [1, 0, 0]), -1, 'de distinto largo no se comparan');
  });

  await t('A2. checada: coincide solo con la misma cara Y con giro; una foto plana, de lado, con dos caras o sin fotos queda sin verificar', async () => {
    assert.deepStrictEqual((await evaluar(checadaDe('ana'))).cara, 'coincide');
    const otro = await evaluar(checadaDe('beto'));
    assert.deepStrictEqual([otro.cara, otro.detalle], ['no_coincide', null]);
    assert.ok(otro.similitud < motor.umbrales.coincide);
    // Foto plana: misma cara, sin que la nariz se corra.
    assert.deepStrictEqual((await evaluar([foto({ p: 'ana', r: 1 }), foto({ p: 'ana', r: 2, g: 0.02 })])).detalle, 'sin_giro');
    // La foto de frente es de Ana; la que gira es de otra persona: no pasa.
    assert.deepStrictEqual((await evaluar([foto({ p: 'ana', r: 1 }), foto({ p: 'beto', r: 2, g: 0.2 })])).detalle, 'sin_giro');
    assert.deepStrictEqual((await evaluar([foto({ p: 'ana', g: 0.2 }), foto({ p: 'ana', g: 0.3 })])).detalle, 'de_lado');
    assert.deepStrictEqual((await evaluar([foto({ p: 'ana', n: 2 }), foto({ p: 'ana', n: 2, g: 0.2 })])).detalle, 'varias_caras');
    assert.deepStrictEqual((await evaluar([foto({ p: 'ana', o: 10 }), sinMarca()])).detalle, 'sin_cara', 'muy chica o sin cara');
    assert.deepStrictEqual(G.evaluarChecada({ analisis: [], registro, umbrales: motor.umbrales }).detalle, 'sin_camara');
    // La foto de frente es la que se guarda con la checada.
    assert.strictEqual((await evaluar([foto({ p: 'ana', g: 0.18 }), foto({ p: 'ana', r: 3 })])).frente, 1);
  });

  await t('A3. registro: hacen falta 3 fotos buenas de frente de la misma persona; dice qué pasó con las demás', async () => {
    const ok = G.evaluarRegistro({ analisis: await analizar(registroDe('ana')), minimo: 3, umbrales: motor.umbrales });
    assert.strictEqual(ok.muestras, 4);
    const pocas = G.evaluarRegistro({ analisis: await analizar([foto({ p: 'ana' }), foto({ p: 'ana', r: 2 }), foto({ p: 'ana', g: 0.3 }), sinMarca(), foto({ p: 'ana', n: 2 })]),
      minimo: 3, umbrales: motor.umbrales });
    assert.deepStrictEqual(pocas, { error: 'POCAS_FOTOS', conteo: { buenas: 2, sin_cara: 1, varias_caras: 1, de_lado: 1 } });
    const mezcla = G.evaluarRegistro({ analisis: await analizar([foto({ p: 'ana' }), foto({ p: 'ana', r: 2 }), foto({ p: 'beto' })]),
      minimo: 3, umbrales: motor.umbrales });
    assert.strictEqual(mezcla.error, 'NO_SON_LA_MISMA');
  });

  await t('A4. el motor de prueba no arranca en producción, y sin XECADOR_CARA_MOTOR no hay motor', () => {
    const correr = (env) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(new URL('../src/services/caraMotor.js', import.meta.url).href)}); console.log(JSON.stringify(m.estadoMotor()));`],
      { env: { ...process.env, ...env }, encoding: 'utf8' });
      return JSON.parse(r.stdout.trim().split('\n').at(-1));
    };
    assert.deepStrictEqual(correr({ XECADOR_CARA_MOTOR: 'prueba', NODE_ENV: 'production' }), { disponible: false, modelo: null, motivo: 'prueba_en_produccion' });
    assert.deepStrictEqual(correr({ XECADOR_CARA_MOTOR: '', NODE_ENV: 'development' }), { disponible: false, modelo: null, motivo: 'sin_motor' });
    assert.deepStrictEqual(correr({ XECADOR_CARA_MOTOR: 'otro', NODE_ENV: 'development' }), { disponible: false, modelo: null, motivo: 'motor_desconocido' });
    assert.deepStrictEqual(correr({ XECADOR_CARA_MOTOR: 'prueba', NODE_ENV: 'development' }), { disponible: true, modelo: 'prueba-1', motivo: null });
  });

  await t('A5. cifrado: ida y vuelta; no abre en otro expediente, otro campo, alterado ni con otra llave; sin llave falla cerrado', () => {
    const ctx = { negocioId: N, empleadoId: randomUUID(), campo: 'vectores' };
    const blob = K.cifrarCara(K.vectoresABytes(registro), ctx);
    const de = K.bytesAVectores(K.descifrarCara(blob, ctx));
    assert.deepStrictEqual(de.map((v) => [...v]), registro.map((v) => [...v]));
    assert.ok(!blob.includes(Buffer.from(K.vectoresABytes(registro).subarray(0, 16))), 'no va en claro');
    assert.throws(() => K.descifrarCara(blob, { ...ctx, empleadoId: randomUUID() }));
    assert.throws(() => K.descifrarCara(blob, { ...ctx, campo: 'foto' }));
    const alterado = Buffer.from(blob); alterado[alterado.length - 1] ^= 1;
    assert.throws(() => K.descifrarCara(alterado, ctx));
    const llave = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    const huella = K.huellaLlave();
    try {
      process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
      assert.notStrictEqual(K.huellaLlave(), huella, 'otra llave, otra huella');
      assert.throws(() => K.descifrarCara(blob, ctx));
      process.env.INTEGRATIONS_ENCRYPTION_KEY = 'corta';
      assert.strictEqual(K.huellaLlave(), null);
      assert.throws(() => K.cifrarCara(Buffer.from('x'), ctx), K.LlaveCaraError);
    } finally {
      process.env.INTEGRATIONS_ENCRYPTION_KEY = llave;
    }
  });

  const filaCara = (e, neg = N) => pool.query(
    `INSERT INTO xecador_caras (negocio_id, empleado_id, modelo, llave, vectores, muestras, foto, foto_mime)
     VALUES ($1, $2, 'prueba-1', '0123abcd', '\\x01'::bytea, 1, '\\x01'::bytea, 'image/jpeg')`, [neg, e.id]);

  await t('A6. la base no guarda una cara sin consentimiento, de un empleado de baja ni a nombre de otro negocio', async () => {
    const e = await empleado('Sin firma A6');
    await pgFalla('P0001', () => filaCara(e));
    await pgFalla('23514', () => pool.query(`UPDATE xecador_empleados SET consentimiento_cara_fecha = '2019-12-31' WHERE id = $1`, [e.id]),
      'xecador_empleados_consentimiento_cara_check');
    await consentir(e);
    await filaCara(e);
    // A nombre de otro negocio: la frena el trigger (no hay ese expediente en M)
    // y, detrás, la llave foránea compuesta.
    await pgFalla('P0001', () => filaCara(e, M));
    assert.match((await q1(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'xecador_caras_empleado_fkey'`)).def,
      /FOREIGN KEY \(negocio_id, empleado_id\) REFERENCES xecador_empleados\(negocio_id, id\) ON DELETE CASCADE/);
    const b = await empleado('Baja A6');
    await P.darDeBajaEmpleado(N, b.id, { tipo: 'renuncia', actorId: ADMIN_N });
    await pgFalla('23514', () => consentir(b), 'xecador_empleados_consentimiento_cara_check');
    await pgFalla('P0001', () => filaCara(b));
  });

  await t('A7. retirar el consentimiento borra la cara, y la baja retira los dos; todo queda en la bitácora', async () => {
    const e = await empleado('Retira A7');
    await consentir(e); await filaCara(e);
    const antes = (await eventos(e)).length;
    // Los demás cambios del expediente no la tocan.
    await pool.query(`UPDATE xecador_empleados SET pin_fallos = pin_fallos + 1, nombre = 'Retira A7 bis' WHERE id = $1`, [e.id]);
    assert.strictEqual((await carasDe(e)).length, 1);
    assert.strictEqual((await eventos(e)).length, antes);
    await pool.query(`UPDATE xecador_empleados SET consentimiento_cara_fecha = NULL WHERE id = $1`, [e.id]);
    assert.strictEqual((await carasDe(e)).length, 0);
    assert.deepStrictEqual((await eventos(e)).slice(antes).map((x) => [x.tipo, x.motivo, x.cambios]),
      [['cara', 'Se borra al retirar el consentimiento', { cara: { antes: true, despues: false } }]]);

    const b = await empleado('Baja A7');
    await consentir(b, '2026-01-15'); await filaCara(b);
    const antesB = (await eventos(b)).length;
    const baja = await P.darDeBajaEmpleado(N, b.id, { tipo: 'despido', actorId: ADMIN_N });
    assert.strictEqual(baja.consentimiento_cara_fecha, null, 'la respuesta de la baja ya no lo trae');
    assert.strictEqual((await carasDe(b)).length, 0);
    assert.strictEqual((await q1(`SELECT consentimiento_cara_fecha FROM xecador_empleados WHERE id = $1`, [b.id])).consentimiento_cara_fecha, null);
    assert.deepStrictEqual((await eventos(b)).slice(antesB).map((x) => [x.tipo, x.motivo]), [
      ['consentimiento_cara', 'Se retira con la baja'], ['cara', 'Se borra con la baja'], ['baja', null]]);
    assert.deepStrictEqual((await eventos(b))[antesB].cambios, { consentimiento_cara_fecha: { antes: '2026-01-15', despues: null } });
    // Al reactivarlo no vuelve: hay que firmar y registrar de nuevo.
    await P.reactivarEmpleado(N, b.id, { actorId: ADMIN_N });
    assert.strictEqual((await q1(`SELECT consentimiento_cara_fecha FROM xecador_empleados WHERE id = $1`, [b.id])).consentimiento_cara_fecha, null);
  });

  await t('A8. un retiro de consentimiento que llega mientras se guarda la cara espera, y la borra', async () => {
    const e = await empleado('Carrera A8');
    await consentir(e);
    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c1.query(`INSERT INTO xecador_caras (negocio_id, empleado_id, modelo, llave, vectores, muestras, foto, foto_mime)
                      VALUES ($1, $2, 'prueba-1', '0123abcd', '\\x01'::bytea, 1, '\\x01'::bytea, 'image/jpeg')`, [N, e.id]);
      let listo = false;
      const retiro = c2.query(`UPDATE xecador_empleados SET consentimiento_cara_fecha = NULL WHERE id = $1`, [e.id]).then(() => { listo = true; });
      await pausa(400);
      assert.strictEqual(listo, false, 'el retiro espera a que termine el registro');
      await c1.query('COMMIT');
      await retiro;
      assert.strictEqual((await carasDe(e)).length, 0, 'y al terminar, la borra');
    } finally {
      c1.release(); c2.release();
    }
  });

  await t('A9. checadas, avisos y configuración: solo los valores de la cara que existen', async () => {
    const r = await q1(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'xecador_checadas_cara_detalle_check'`);
    assert.match(r.def, /cara = 'no_verificada'/);
    await pgFalla('23514', () => pool.query(`INSERT INTO xecador_config (negocio_id, cara_al_checar) VALUES ($1, 'siempre')`, [M]),
      'xecador_config_cara_al_checar_check');
    assert.strictEqual((await q1(`SELECT cara_al_checar FROM xecador_config WHERE negocio_id = $1`, [N]))?.cara_al_checar ?? 'apagado', 'apagado',
      'nace apagado');
    const avisos = await q1(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'xecador_avisos_tipo_check'`);
    assert.match(avisos.def, /'cara_no_coincide'/);
  });
}

// ═══ B. Servidor real ══════════════════════════════════════════════════════
let servidor = null;
async function http(metodo, ruta, { cookie, tablet, cuerpo, base } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}`;
  if (tablet) headers.Authorization = `Bearer ${tablet}`;
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch((base || servidor.base) + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const tipo = r.headers.get('content-type') || '';
  const crudo = Buffer.from(await r.arrayBuffer());
  let datos = null;
  if (tipo.includes('json')) { try { datos = JSON.parse(crudo.toString('utf8')); } catch { /* nada */ } }
  return { status: r.status, datos, crudo, headers: r.headers };
}
const modulo = (neg, estado) => http('PATCH', `/api/superadmin/negocios/${neg}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
const CHK = '/api/personal/checador';
const EMP = (e) => `/api/personal/empleados/${e.id}`;

if (PARTES.has('B') || PARTES.has('C')) {
  servidor = await arrancarServidor({ PORT: PUERTO, XECADOR_CARA_MOTOR: 'prueba' }, { timeoutMs: 120000 });
  for (const neg of [N, M]) assert.strictEqual((await modulo(neg, 'activo')).status, 200, 'precondición: módulo encendido');
}
async function nuevaTablet(nombre, sucursalId = MATRIZ, cookie = COOKIES.adminN) {
  const c = await http('POST', `${CHK}/dispositivos`, { cookie, cuerpo: { nombre, sucursal_id: sucursalId } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.datos));
  const v = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: c.datos.codigo } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.datos));
  return { id: c.datos.dispositivo.id, token: v.datos.token };
}
const identificar = (T, e) => http('POST', '/api/checador/identificar', { tablet: T.token, cuerpo: { pin: PIN[e.id] } });
/** PIN, y luego la acción sugerida con las fotos de la cara que se digan. */
async function checar(T, e, cara, extra = {}) {
  const id = await identificar(T, e);
  assert.strictEqual(id.status, 200, `identificar ${e.nombre}: ${id.status} ${JSON.stringify(id.datos)}`);
  const cuerpo = { pase: id.datos.pase, tipo: id.datos.sugerida, clave: randomUUID(), ...extra };
  if (cara !== undefined) cuerpo.cara = cara;
  const r = await http('POST', '/api/checador/checar', { tablet: T.token, cuerpo });
  return { id, r, cuerpo };
}
const config = (cuerpo, cookie = COOKIES.adminN) => http('PUT', `${CHK}/config`, { cookie, cuerpo });

let ANA = null, BETO = null, T = null;
if (PARTES.has('B') || PARTES.has('C')) {
  ANA = await conPin(await empleado('Ana Cara'));
  BETO = await conPin(await empleado('Beto Sin Cara'));
  T = await nuevaTablet('Tablet cara');
}

if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');

  await t('B1. solo el administrador del negocio: el staff, el Superadmin y otro negocio no ven ni tocan la cara', async () => {
    const e = await http('GET', '/api/personal/cara/estado', { cookie: COOKIES.adminN });
    assert.deepStrictEqual([e.status, e.datos.disponible, e.datos.modelo, e.datos.registro_min], [200, true, 'prueba-1', 3]);
    for (const [quien, cookie, esperado] of [['staff', COOKIES.staffN, 403], ['superadmin', COOKIES.super, 403], ['otro negocio', COOKIES.adminM, 404]]) {
      for (const [metodo, ruta, cuerpo] of [['GET', `${EMP(ANA)}/cara`], ['PUT', `${EMP(ANA)}/consentimiento-cara`, { firmado: true, fecha: HOY }],
        ['POST', `${EMP(ANA)}/cara`, { fotos: registroDe('ana') }], ['DELETE', `${EMP(ANA)}/cara`], ['GET', `${EMP(ANA)}/cara/foto`]]) {
        const r = await http(metodo, ruta, { cookie, cuerpo });
        assert.strictEqual(r.status, esperado, `${quien} ${metodo} ${ruta}: ${r.status} ${JSON.stringify(r.datos)}`);
      }
    }
    assert.strictEqual((await http('GET', `${EMP(ANA)}/cara`)).status, 401, 'sin sesión');
    assert.strictEqual((await q1(`SELECT consentimiento_cara_fecha FROM xecador_empleados WHERE id = $1`, [ANA.id])).consentimiento_cara_fecha, null);
  });

  await t('B2. el consentimiento: con fecha real y no futura, de un empleado activo; queda en la bitácora con su autor', async () => {
    const put = (cuerpo) => http('PUT', `${EMP(ANA)}/consentimiento-cara`, { cookie: COOKIES.adminN, cuerpo });
    assert.strictEqual((await put({ firmado: 'sí' })).datos.codigo, 'CONSENTIMIENTO_INVALIDO');
    assert.strictEqual((await put({ firmado: true })).datos.codigo, 'FECHA_CONSENTIMIENTO_INVALIDA');
    assert.strictEqual((await put({ firmado: true, fecha: '2026-02-30' })).datos.codigo, 'FECHA_CONSENTIMIENTO_INVALIDA');
    assert.strictEqual((await put({ firmado: true, fecha: '2099-01-01' })).datos.codigo, 'FECHA_CONSENTIMIENTO_INVALIDA');
    const r = await put({ firmado: true, fecha: '2026-11-03' });
    assert.deepStrictEqual([r.status, r.datos.consentimiento_cara_fecha, r.datos.cara], [200, '2026-11-03', null], JSON.stringify(r.datos));
    const ev = (await eventos(ANA)).at(-1);
    assert.deepStrictEqual([ev.tipo, ev.cambios, ev.actor_id], ['consentimiento_cara', { consentimiento_cara_fecha: { antes: null, despues: '2026-11-03' } }, ADMIN_N]);
    const n = (await eventos(ANA)).length;
    await put({ firmado: true, fecha: '2026-11-03' });
    assert.strictEqual((await eventos(ANA)).length, n, 'repetirlo no escribe otro evento');
    const lista = await http('GET', '/api/personal/empleados', { cookie: COOKIES.adminN });
    assert.strictEqual(lista.datos.empleados.find((x) => x.id === ANA.id).consentimiento_cara_fecha, '2026-11-03');
    const b = await empleado('Baja B2');
    await P.darDeBajaEmpleado(N, b.id, { tipo: 'renuncia', actorId: ADMIN_N });
    assert.strictEqual((await http('PUT', `${EMP(b)}/consentimiento-cara`, { cookie: COOKIES.adminN, cuerpo: { firmado: true, fecha: HOY } })).datos.codigo,
      'EMPLEADO_DE_BAJA');
  });

  await t('B3. registrar la cara: sin consentimiento no; fotos que no sirven dicen por qué; se guarda cifrada y la foto de referencia solo la ve el administrador', async () => {
    const reg = (e, cuerpo) => http('POST', `${EMP(e)}/cara`, { cookie: COOKIES.adminN, cuerpo });
    assert.strictEqual((await reg(BETO, { fotos: registroDe('beto') })).datos.codigo, 'SIN_CONSENTIMIENTO');
    assert.strictEqual((await reg(ANA, { fotos: registroDe('ana').slice(0, 2) })).datos.codigo, 'FOTOS_INVALIDAS');
    assert.strictEqual((await reg(ANA, { fotos: [...registroDe('ana').slice(0, 2), { datos: Buffer.from('no es foto').toString('base64') }] })).datos.codigo, 'FOTO_INVALIDA');
    const pocas = await reg(ANA, { fotos: [foto({ p: 'ana' }), foto({ p: 'ana', r: 2 }), foto({ p: 'ana', g: 0.3 }), sinMarca()] });
    assert.deepStrictEqual([pocas.status, pocas.datos.codigo, pocas.datos.conteo.buenas], [422, 'POCAS_FOTOS', 2]);
    assert.match(pocas.datos.error, /Sirvieron 2 de 4 fotos \(1 sin una cara clara, 1 de lado\)/);
    assert.strictEqual((await reg(ANA, { fotos: [foto({ p: 'ana' }), foto({ p: 'ana', r: 2 }), foto({ p: 'beto' })] })).datos.codigo, 'NO_SON_LA_MISMA');
    assert.strictEqual((await carasDe(ANA)).length, 0, 'nada de eso se guardó');

    const fotos = registroDe('ana');
    const r = await reg(ANA, { fotos });
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    assert.deepStrictEqual([r.datos.cara.muestras, r.datos.cara.vigente], [4, true]);
    const [fila] = await carasDe(ANA);
    assert.deepStrictEqual([fila.modelo, fila.llave, fila.muestras, fila.creado_por], ['prueba-1', K.huellaLlave(), 4, ADMIN_N]);
    for (const f of fotos) assert.ok(!fila.foto.includes(Buffer.from(f.datos, 'base64').subarray(0, 40)), 'la foto no va en claro');
    assert.ok(!fila.foto.includes(Buffer.from(MOTOR.MARCA_PRUEBA)) && !fila.vectores.includes(Buffer.from('"v"')), 'nada en claro');
    const ref = await http('GET', `${EMP(ANA)}/cara/foto`, { cookie: COOKIES.adminN });
    assert.strictEqual(ref.status, 200);
    assert.match(ref.headers.get('cache-control') || '', /no-store/);
    assert.ok(fotos.some((f) => Buffer.from(f.datos, 'base64').equals(ref.crudo)), 'la de referencia es una de las fotos del registro');
    const ev = (await eventos(ANA)).at(-1);
    assert.deepStrictEqual([ev.tipo, ev.cambios, ev.actor_id], ['cara', { cara: { antes: false, despues: true }, muestras: 4 }, ADMIN_N]);
    // La lista dice que la tiene, sin sus datos.
    const lista = await http('GET', '/api/personal/empleados', { cookie: COOKIES.adminN });
    const a = lista.datos.empleados.find((x) => x.id === ANA.id);
    assert.deepStrictEqual(Object.keys(a.cara).sort(), ['muestras', 'registrada_at', 'vigente']);
    assert.strictEqual(lista.datos.empleados.find((x) => x.id === BETO.id).cara, null);
  });

  await t('B4. una cara que se parece a la de otro empleado pide confirmarlo, y queda escrito', async () => {
    const caro = await empleado('Caro Parecida');
    await consentir(caro);
    const parecida = registroDe('ana', { mezcla: ['caro', 0.3] });
    const r = await http('POST', `${EMP(caro)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: parecida } });
    assert.deepStrictEqual([r.status, r.datos.codigo, r.datos.parecido?.nombre], [409, 'CARA_PARECIDA', 'Ana Cara'], JSON.stringify(r.datos));
    assert.strictEqual((await carasDe(caro)).length, 0);
    const ok = await http('POST', `${EMP(caro)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: parecida, confirmar_parecido: true } });
    assert.strictEqual(ok.status, 201);
    assert.match((await eventos(caro)).at(-1).motivo, /Se parece a la de Ana Cara .*confirmado por el administrador/);
    // Una cara distinta no pregunta nada.
    const dora = await empleado('Dora Distinta');
    await consentir(dora);
    assert.strictEqual((await http('POST', `${EMP(dora)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: registroDe('dora') } })).status, 201);
  });

  await t('B5. el interruptor: nace apagado, solo admite «apagado» o «confirmar», y la tablet lo ve', async () => {
    assert.deepStrictEqual((await http('GET', `${CHK}/config`, { cookie: COOKIES.adminN })).datos, { foto_al_checar: false, cara_al_checar: 'apagado' });
    assert.strictEqual((await config({ cara_al_checar: 'siempre' })).datos.codigo, 'CONFIG_INVALIDA');
    assert.strictEqual((await config({ cara_al_checar: 'confirmar' }, COOKIES.staffN)).status, 403);
    const on = await config({ cara_al_checar: 'confirmar' });
    assert.deepStrictEqual([on.status, on.datos], [200, { foto_al_checar: false, cara_al_checar: 'confirmar' }]);
    // Cambiar la foto no apaga la cara, ni al revés.
    assert.deepStrictEqual((await config({ foto_al_checar: true })).datos, { foto_al_checar: true, cara_al_checar: 'confirmar' });
    assert.deepStrictEqual((await config({ foto_al_checar: false })).datos, { foto_al_checar: false, cara_al_checar: 'confirmar' });
    assert.strictEqual((await http('GET', '/api/checador/estado', { tablet: T.token })).datos.cara_al_checar, 'confirmar');
    assert.strictEqual((await http('GET', `${CHK}/config`, { cookie: COOKIES.adminM })).datos.cara_al_checar, 'apagado', 'otro negocio no cambia');
  });

  await t('B6. al checar: la tablet toma la cara solo de quien la tiene registrada; si coincide no se guarda foto', async () => {
    assert.strictEqual((await identificar(T, ANA)).datos.cara, true);
    assert.strictEqual((await identificar(T, BETO)).datos.cara, false);
    const { r } = await checar(T, ANA, checadaDe('ana'));
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    assert.strictEqual(r.datos.checada.cara, 'coincide');
    const c = (await checadasDe(ANA)).at(-1);
    assert.deepStrictEqual([c.cara, c.cara_detalle, c.revision, c.foto], ['coincide', null, [], 'no_requerida']);
    assert.ok(c.cara_similitud > 0.9);
    assert.strictEqual((await q1(`SELECT COUNT(*)::int AS n FROM xecador_checada_fotos WHERE checada_id = $1`, [c.id])).n, 0);
    const sin = await checar(T, BETO, checadaDe('beto'));
    assert.deepStrictEqual([sin.r.status, sin.r.datos.checada.cara], [201, 'sin_registro']);
    assert.deepStrictEqual((await checadasDe(BETO)).at(-1).revision, []);
  });

  await t('B7. la cara no coincide: se registra igual, para revisar, con aviso y la foto de frente guardada', async () => {
    const avisosAntes = (await q1(`SELECT COUNT(*)::int AS n FROM xecador_avisos WHERE negocio_id = $1 AND tipo = 'cara_no_coincide'`, [N])).n;
    const fotos = [foto({ p: 'beto', g: 0.2 }), foto({ p: 'beto', r: 7 }), foto({ p: 'beto', r: 8, g: 0.15 })];
    const { r, cuerpo } = await checar(T, ANA, fotos);
    assert.deepStrictEqual([r.status, r.datos.checada.cara], [201, 'no_coincide'], JSON.stringify(r.datos));
    const c = (await checadasDe(ANA)).at(-1);
    assert.deepStrictEqual([c.cara, c.revision, c.foto], ['no_coincide', ['cara_no_coincide'], 'tomada']);
    const guardada = await q1(`SELECT datos FROM xecador_checada_fotos WHERE checada_id = $1`, [c.id]);
    assert.ok(Buffer.from(fotos[1].datos, 'base64').equals(guardada.datos), 'se guarda la de frente');
    const [aviso] = (await pool.query(`SELECT * FROM xecador_avisos WHERE negocio_id = $1 AND tipo = 'cara_no_coincide' ORDER BY id DESC LIMIT 1`, [N])).rows;
    assert.strictEqual((await q1(`SELECT COUNT(*)::int AS n FROM xecador_avisos WHERE negocio_id = $1 AND tipo = 'cara_no_coincide'`, [N])).n, avisosAntes + 1);
    assert.deepStrictEqual([aviso.empleado_id, aviso.detalle.tipo, typeof aviso.detalle.similitud], [ANA.id, cuerpo.tipo, 'number']);
    // El reintento con la misma clave contesta la misma checada, aunque traiga otras fotos.
    const otra = await http('POST', '/api/checador/checar', { tablet: T.token, cuerpo: { ...cuerpo, cara: checadaDe('ana') } });
    assert.deepStrictEqual([otra.status, otra.datos.repetida, otra.datos.checada.cara], [200, true, 'no_coincide']);
    const revisar = await http('GET', `${CHK}/revisar`, { cookie: COOKIES.adminN });
    const fila = revisar.datos.checadas.find((x) => x.id === Number(c.id));
    assert.deepStrictEqual([fila.motivos, fila.cara, fila.cara_registrada, fila.empleado_id], [['cara_no_coincide'], 'no_coincide', true, ANA.id]);
    const dia = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    assert.strictEqual(dia.datos.checadas.find((x) => Number(x.id) === Number(c.id)).cara, 'no_coincide');
  });

  await t('B8. sin cámara, sin giro, con dos caras o con el motor caído: se registra igual, «cara sin verificar»; nunca se pierde', async () => {
    for (const [nombre, cara, detalle] of [
      ['sin fotos', undefined, 'sin_camara'], ['fotos vacías', [], 'sin_camara'], ['basura', [{ datos: 'xx' }, 7, null], 'sin_camara'],
      ['sin giro', [foto({ p: 'ana', r: 1 }), foto({ p: 'ana', r: 2, g: 0.01 })], 'sin_giro'],
      ['dos caras', [foto({ p: 'ana', n: 2 }), foto({ p: 'ana', n: 2, g: 0.2 })], 'varias_caras'],
      ['sin cara', [sinMarca(), sinMarca()], 'sin_cara'],
      ['motor caído', [foto({ p: 'ana', falla: true }), foto({ p: 'ana', g: 0.2 })], 'motor'],
    ]) {
      const { r } = await checar(T, ANA, cara);
      assert.deepStrictEqual([r.status, r.datos?.checada?.cara], [201, 'no_verificada'], `${nombre}: ${JSON.stringify(r.datos)}`);
      const c = (await checadasDe(ANA)).at(-1);
      assert.deepStrictEqual([c.cara, c.cara_detalle, c.revision], ['no_verificada', detalle, ['cara_no_verificada']], nombre);
    }
    // Con «foto al checar» encendida, la foto es la de frente de la cara; sin fotos, «sin foto».
    await config({ foto_al_checar: true });
    try {
      const { r } = await checar(T, ANA, checadaDe('ana'));
      const c = (await checadasDe(ANA)).at(-1);
      assert.deepStrictEqual([r.datos.checada.cara, c.foto], ['coincide', 'tomada']);
      await checar(T, ANA, []);
      assert.strictEqual((await checadasDe(ANA)).at(-1).foto, 'no_disponible');
    } finally {
      await config({ foto_al_checar: false });
    }
  });

  await t('B9. sin conexión: las fotos guardadas en la tablet se comparan al sincronizar', async () => {
    const sinc = async (item) => http('POST', '/api/checador/sincronizar', { tablet: T.token, cuerpo: { checadas: [item] } });
    const item = async (cara) => {
      const id = await identificar(T, ANA);
      const x = { clave: randomUUID(), pase: id.datos.pase, tipo: id.datos.sugerida, ref: id.datos.ref, transcurrido_ms: 300, hora_dispositivo: new Date().toISOString() };
      if (cara) x.cara = cara;
      return x;
    };
    const avisosAntes = (await q1(`SELECT COUNT(*)::int AS n FROM xecador_avisos WHERE negocio_id = $1 AND tipo = 'cara_no_coincide'`, [N])).n;
    for (const [cara, esperado, motivos] of [[checadaDe('ana'), 'coincide', []], [checadaDe('beto'), 'no_coincide', ['cara_no_coincide']],
      [null, 'no_verificada', ['cara_no_verificada']]]) {
      const x = await item(cara);
      const r = await sinc(x);
      assert.deepStrictEqual(r.datos.resultados, [{ clave: x.clave, estado: 'recibida' }], JSON.stringify(r.datos));
      const c = (await checadasDe(ANA)).at(-1);
      assert.deepStrictEqual([c.origen, c.cara, c.revision], ['sin_conexion', esperado, motivos]);
      assert.strictEqual((await sinc(x)).datos.resultados[0].estado, 'repetida');
    }
    assert.strictEqual((await q1(`SELECT COUNT(*)::int AS n FROM xecador_avisos WHERE negocio_id = $1 AND tipo = 'cara_no_coincide'`, [N])).n, avisosAntes + 1);
  });

  await t('B10. con la llave o el motor de otro día, la cara registrada no se usa (se vuelve a registrar) en vez de dar errores', async () => {
    await pool.query(`UPDATE xecador_caras SET llave = '00000000' WHERE empleado_id = $1`, [ANA.id]);
    try {
      assert.strictEqual((await identificar(T, ANA)).datos.cara, false);
      const { r } = await checar(T, ANA, checadaDe('ana'));
      assert.strictEqual(r.datos.checada.cara, 'sin_registro');
      assert.strictEqual((await http('GET', `${EMP(ANA)}/cara`, { cookie: COOKIES.adminN })).datos.cara.vigente, false);
    } finally {
      await pool.query(`UPDATE xecador_caras SET llave = $2 WHERE empleado_id = $1`, [ANA.id, K.huellaLlave()]);
    }
  });

  await t('B11. retirar el consentimiento por el panel borra la cara y la tablet deja de pedirla; borrar la cara deja el consentimiento', async () => {
    const dora = await conPin(await empleado('Dora Retira'));
    await consentir(dora);
    assert.strictEqual((await http('POST', `${EMP(dora)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: registroDe('dora2') } })).status, 201);
    assert.strictEqual((await identificar(T, dora)).datos.cara, true);
    const antes = (await eventos(dora)).length;
    const r = await http('PUT', `${EMP(dora)}/consentimiento-cara`, { cookie: COOKIES.adminN, cuerpo: { firmado: false, motivo: 'Lo pidió el empleado' } });
    assert.deepStrictEqual([r.status, r.datos.consentimiento_cara_fecha, r.datos.cara], [200, null, null]);
    assert.strictEqual((await carasDe(dora)).length, 0);
    assert.deepStrictEqual((await eventos(dora)).slice(antes).map((x) => [x.tipo, x.motivo, x.actor_id]), [
      ['consentimiento_cara', 'Lo pidió el empleado', ADMIN_N], ['cara', 'Se borra al retirar el consentimiento', null]]);
    assert.strictEqual((await identificar(T, dora)).datos.cara, false);
    assert.strictEqual((await checar(T, dora, checadaDe('dora2'))).r.datos.checada.cara, 'sin_registro');
    assert.strictEqual((await http('GET', `${EMP(dora)}/cara/foto`, { cookie: COOKIES.adminN })).status, 404);
    assert.strictEqual((await http('POST', `${EMP(dora)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: registroDe('dora2') } })).datos.codigo,
      'SIN_CONSENTIMIENTO');
    // Borrar solo la cara: el consentimiento se queda.
    const eli = await conPin(await empleado('Eli Borra'));
    await consentir(eli);
    await http('POST', `${EMP(eli)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: registroDe('eli') } });
    const b = await http('DELETE', `${EMP(eli)}/cara`, { cookie: COOKIES.adminN });
    assert.deepStrictEqual([b.status, b.datos.cara, b.datos.consentimiento_cara_fecha], [200, null, HOY]);
    assert.deepStrictEqual([(await eventos(eli)).at(-1).motivo, (await eventos(eli)).at(-1).actor_id], ['Borrada por el administrador', ADMIN_N]);
    // Y la baja por el panel se lleva las dos.
    await http('POST', `${EMP(eli)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: registroDe('eli') } });
    const baja = await http('POST', `${EMP(eli)}/baja`, { cookie: COOKIES.adminN, cuerpo: { tipo: 'renuncia' } });
    assert.strictEqual(baja.status, 200, JSON.stringify(baja.datos));
    assert.deepStrictEqual([(await carasDe(eli)).length, baja.datos.empleado.consentimiento_cara_fecha], [0, null]);
  });

  await t('B12. un servidor sin motor: no se enciende ni se registra, y quien ya tenía cara checa igual («cara sin verificar»)', async () => {
    const sinMotor = await arrancarServidor({ PORT: PUERTO_SIN_MOTOR, XECADOR_CARA_MOTOR: '' }, { timeoutMs: 120000 });
    try {
      const base = sinMotor.base;
      const e = await http('GET', '/api/personal/cara/estado', { cookie: COOKIES.adminN, base });
      assert.deepStrictEqual([e.datos.disponible, e.datos.motivo], [false, 'sin_motor']);
      await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, base, cuerpo: { cara_al_checar: 'apagado' } });
      const on = await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, base, cuerpo: { cara_al_checar: 'confirmar' } });
      assert.deepStrictEqual([on.status, on.datos.codigo], [409, 'CARA_NO_DISPONIBLE']);
      assert.strictEqual((await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, cuerpo: { cara_al_checar: 'confirmar' } })).status, 200,
        'con motor sí');
      const reg = await http('POST', `${EMP(ANA)}/cara`, { cookie: COOKIES.adminN, base, cuerpo: { fotos: registroDe('ana') } });
      assert.deepStrictEqual([reg.status, reg.datos.codigo], [503, 'CARA_NO_DISPONIBLE']);
      const id = await http('POST', '/api/checador/identificar', { tablet: T.token, base, cuerpo: { pin: PIN[ANA.id] } });
      assert.strictEqual(id.datos.cara, false, 'la tablet no pide fotos que nadie va a comparar');
      const r = await http('POST', '/api/checador/checar', { tablet: T.token, base, cuerpo: { pase: id.datos.pase, tipo: id.datos.sugerida, clave: randomUUID() } });
      assert.deepStrictEqual([r.status, r.datos.checada.cara], [201, 'no_verificada']);
      assert.deepStrictEqual((await checadasDe(ANA)).at(-1).cara_detalle, 'motor');
    } finally {
      sinMotor.detener();
    }
  });

  await t('B13. un servidor con el motor real (YuNet + SFace): se enciende; fotos sin cara no registran; la checada se registra igual, «para revisar»', async () => {
    const real = await arrancarServidor({ PORT: PUERTO_REAL, XECADOR_CARA_MOTOR: 'yunet-sface' }, { timeoutMs: 120000 });
    try {
      const base = real.base;
      const e = await http('GET', '/api/personal/cara/estado', { cookie: COOKIES.adminN, base });
      assert.deepStrictEqual([e.status, e.datos.disponible, e.datos.modelo], [200, true, 'yunet-2023mar-sface-2021dec']);
      assert.strictEqual((await http('PUT', `${CHK}/config`, { cookie: COOKIES.adminN, base, cuerpo: { cara_al_checar: 'confirmar' } })).status, 200);
      const dora = await conPin(await empleado('Dora Real'));
      await consentir(dora);
      const reg = await http('POST', `${EMP(dora)}/cara`, { cookie: COOKIES.adminN, base, cuerpo: { fotos: [1, 2, 3, 4, 5].map(sinMarca) } });
      assert.deepStrictEqual([reg.status, reg.datos.codigo, reg.datos.conteo], [422, 'POCAS_FOTOS', { buenas: 0, sin_cara: 5, varias_caras: 0, de_lado: 0 }]);
      assert.strictEqual((await carasDe(dora)).length, 0);
      // Una cara registrada con este motor (puesta directo: aquí no hay fotos de caras de verdad).
      const v = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i + 1));
      await pool.query(
        `INSERT INTO xecador_caras (negocio_id, empleado_id, modelo, llave, vectores, muestras, foto, foto_mime, creado_por)
         VALUES ($1, $2, 'yunet-2023mar-sface-2021dec', $3, $4, 3, $5, 'image/jpeg', $6)`,
        [N, dora.id, K.huellaLlave(), K.cifrarCara(K.vectoresABytes([G.normalizar(v)]), { negocioId: N, empleadoId: dora.id, campo: 'vectores' }),
          K.cifrarCara(LIENZO, { negocioId: N, empleadoId: dora.id, campo: 'foto' }), ADMIN_N]);
      const id = await http('POST', '/api/checador/identificar', { tablet: T.token, base, cuerpo: { pin: PIN[dora.id] } });
      assert.strictEqual(id.datos.cara, true, 'con su cara registrada con este motor, la tablet la pide');
      const r = await http('POST', '/api/checador/checar', { tablet: T.token, base,
        cuerpo: { pase: id.datos.pase, tipo: id.datos.sugerida, clave: randomUUID(), cara: [sinMarca(), sinMarca(), sinMarca()] } });
      assert.deepStrictEqual([r.status, r.datos.checada.cara], [201, 'no_verificada']);
      const c = (await checadasDe(dora)).at(-1);
      assert.deepStrictEqual([c.cara, c.cara_detalle, c.revision.includes('cara_no_verificada')], ['no_verificada', 'sin_cara', true]);
      // Ana se registró con el motor de prueba: con otro motor su cara no sirve y la tablet no se la pide.
      const ana = await http('POST', '/api/checador/identificar', { tablet: T.token, base, cuerpo: { pin: PIN[ANA.id] } });
      assert.strictEqual(ana.datos.cara, false);
    } finally {
      real.detener();
    }
  });
}

// ═══ C. Navegador ══════════════════════════════════════════════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador');
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ESPERA = { timeout: 10000 };
  const textoDe = (pagina, sel) => pagina.$eval(sel, (el) => el.innerText);
  const abrir = async (ruta, { cookie, token, ancho = 800, alto = 1280 } = {}) => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: ancho, height: alto, hasTouch: true });
    if (cookie) await pagina.setCookie({ name: 'xabor_sesion', value: cookie, url: servidor.base });
    if (token) {
      await pagina.goto(servidor.base + '/checador', { waitUntil: 'domcontentloaded' });
      await pagina.evaluate((x) => localStorage.setItem('xecador_tablet_token', x), token);
    }
    await pagina.goto(servidor.base + ruta, { waitUntil: 'networkidle0' });
    return { pagina, ctx };
  };
  await config({ cara_al_checar: 'confirmar' });
  // Ana necesita su cara registrada (la parte B lo hace; si solo corre C, aquí).
  if (!(await carasDe(ANA)).length) {
    await consentir(ANA);
    assert.strictEqual((await http('POST', `${EMP(ANA)}/cara`, { cookie: COOKIES.adminN, cuerpo: { fotos: registroDe('ana') } })).status, 201);
  }

  await t('C1. tablet: tras el PIN pide mirar y girar la cabeza, manda las fotos y dice que se revisará si no pudo confirmar', async () => {
    const { pagina, ctx } = await abrir('/checador', { token: T.token });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    let enviado = null;
    pagina.on('request', (req) => { if (req.url().endsWith('/api/checador/checar')) enviado = JSON.parse(req.postData() || '{}'); });
    for (const d of PIN[ANA.id]) await pagina.click(`#pin-teclado [data-tecla="${d}"]`);
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    await pagina.waitForFunction(() => /gira un poco la cabeza/.test(document.getElementById('c-guia-cara').textContent), ESPERA);
    const video = await pagina.$eval('#camara', (v) => [v.classList.contains('oculto'), v.style.width, v.videoWidth > 0]);
    assert.deepStrictEqual(video, [false, '240px', true], 'la cámara grande, con imagen');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-cara-tablet.png') });
    await pagina.click('#c-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.ok(Array.isArray(enviado?.cara) && enviado.cara.length >= 2, `mandó las fotos: ${enviado?.cara?.length}`);
    assert.ok(enviado.cara.every((f) => typeof f.datos === 'string' && f.datos.startsWith('/9j/')), 'JPEG');
    assert.ok(!('foto' in enviado), 'con la cara no manda otra foto');
    // La cámara simulada no tiene cara: se registra igual y se avisa.
    assert.match(await textoDe(pagina, '#r-texto'), /registrada$/);
    assert.match(await textoDe(pagina, '#r-detalle'), /No se pudo verificar tu cara: el administrador la revisará\./);
    const c = (await checadasDe(ANA)).at(-1);
    assert.deepStrictEqual([c.cara, c.cara_detalle, c.revision, c.foto], ['no_verificada', 'sin_cara', ['cara_no_verificada'], 'tomada']);
    const guardado = await pagina.evaluate(() => Object.keys(localStorage).sort());
    assert.deepStrictEqual(guardado.filter((k) => !['xecador_tablet_token', 'xecador_llave', 'xecador_foto', 'xecador_cara'].includes(k)), []);
    assert.strictEqual(await pagina.evaluate(() => localStorage.getItem('xecador_cara')), '1');
    // Quien no tiene su cara registrada checa como siempre: sin cámara ni fotos.
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', { timeout: 9000 });
    enviado = null;
    for (const d of PIN[BETO.id]) await pagina.click(`#pin-teclado [data-tecla="${d}"]`);
    await pagina.click('#pin-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    assert.strictEqual(await pagina.$eval('#c-guia-cara', (el) => el.classList.contains('oculto')), true);
    assert.strictEqual(await pagina.$eval('#camara', (v) => v.classList.contains('oculto')), true);
    await pagina.click('#c-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.ok(enviado && !('cara' in enviado), 'sin fotos de la cara');
    assert.strictEqual((await checadasDe(BETO)).at(-1).cara, 'sin_registro');
    await ctx.close();
  });

  await t('C2. Empleados › Cara: anota el consentimiento, abre la cámara y registra la cara (con las fotos que toma el navegador)', async () => {
    const fer = await conPin(await empleado('Fer Navegador'));
    const { pagina, ctx } = await abrir('/personal', { cookie: COOKIES.adminN, ancho: 1100, alto: 900 });
    await pagina.waitForSelector(`article.emp[data-id="${fer.id}"] [data-accion="cara"]`, ESPERA);
    await pagina.click(`article.emp[data-id="${fer.id}"] [data-accion="cara"]`);
    await pagina.waitForFunction(() => document.getElementById('dlg-cara').open && /consentimiento firmado/.test(document.getElementById('cara-estado').textContent), ESPERA);
    assert.strictEqual(await pagina.$eval('#cara-registrar', (b) => b.disabled), true, 'sin consentimiento no se registra');
    await pagina.click('#cara-consentimiento');
    assert.strictEqual(await pagina.$eval('#cara-fecha', (i) => i.value), HOY, 'propone la fecha de hoy');
    await pagina.click('#cara-guardar-consentimiento');
    await pagina.waitForFunction(() => /Todavía no tiene su cara registrada/.test(document.getElementById('cara-estado').textContent), ESPERA);
    assert.strictEqual((await q1(`SELECT to_char(consentimiento_cara_fecha, 'YYYY-MM-DD') AS f FROM xecador_empleados WHERE id = $1`, [fer.id])).f, HOY);
    // La cámara simulada no tiene cara: el navegador manda sus fotos y aquí se cambian por unas del motor de prueba.
    await pagina.setRequestInterception(true);
    let mandadas = null;
    pagina.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith(`/api/personal/empleados/${fer.id}/cara`)) {
        mandadas = JSON.parse(req.postData()).fotos;
        req.continue({ postData: JSON.stringify({ fotos: registroDe('fer') }) });
      } else req.continue();
    });
    await pagina.click('#cara-registrar');
    await pagina.waitForFunction(() => document.getElementById('cara-registrar').textContent === 'Tomar fotos', ESPERA);
    assert.strictEqual(await pagina.$eval('#cara-captura', (el) => el.classList.contains('oculto')), false);
    await pagina.click('#cara-registrar');
    await pagina.waitForFunction(() => /Cara registrada el/.test(document.getElementById('cara-estado').textContent), { timeout: 15000 });
    assert.ok(mandadas?.length === 5 && mandadas.every((f) => f.datos.startsWith('/9j/')), `el navegador mandó 5 fotos JPEG (${mandadas?.length})`);
    assert.strictEqual((await carasDe(fer)).length, 1);
    await pagina.waitForFunction(() => document.getElementById('cara-referencia').naturalWidth > 0, ESPERA);
    assert.strictEqual(await pagina.$eval('#cara-captura', (el) => el.classList.contains('oculto')), true, 'la cámara se apaga');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-cara-registro.png') });
    await ctx.close();
  });

  await t('C3. Checador: el interruptor de la cara, y lo que no coincidió se compara con la cara registrada', async () => {
    await checar(T, ANA, checadaDe('beto', { r: 40 }));   // una que no coincide, para revisar
    const { pagina, ctx } = await abrir('/personal', { cookie: COOKIES.adminN, ancho: 1100, alto: 900 });
    let paso = 1;
    try {
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    paso = 2;
    await pagina.click('#tab-checador');
    await pagina.waitForSelector('#checador:not(.oculto)', ESPERA);
    paso = 3;
    await pagina.waitForFunction(() => document.getElementById('ch-cara').value === 'confirmar' && !document.getElementById('ch-cara').disabled, ESPERA);
    paso = 4;
    await pagina.select('#ch-cara', 'apagado');
    await pagina.waitForFunction(() => !document.getElementById('ch-cara').disabled, ESPERA);
    await pausa(300);
    assert.strictEqual((await q1(`SELECT cara_al_checar FROM xecador_config WHERE negocio_id = $1`, [N])).cara_al_checar, 'apagado');
    await pagina.select('#ch-cara', 'confirmar');
    await pagina.waitForFunction(() => !document.getElementById('ch-cara').disabled, ESPERA);
    await pausa(300);
    assert.strictEqual((await q1(`SELECT cara_al_checar FROM xecador_config WHERE negocio_id = $1`, [N])).cara_al_checar, 'confirmar');
    paso = 5;
    await pagina.waitForFunction(() => /La cara no coincide/.test(document.getElementById('ch-revisar').textContent), ESPERA);
    paso = 6;
    const comparar = await pagina.evaluateHandle(() => [...document.querySelectorAll('#ch-revisar button')].find((b) => b.textContent === 'Comparar'));
    assert.ok(comparar.asElement(), 'hay botón «Comparar»');
    await comparar.asElement().click();
    paso = 7;
    await pagina.waitForFunction(() => document.getElementById('dlg-foto').open
      && document.getElementById('ft-checada').naturalWidth > 0 && document.getElementById('ft-registrada').naturalWidth > 0, ESPERA);
    assert.strictEqual(await pagina.$eval('#ft-imagen', (el) => el.classList.contains('oculto')), true);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-cara-comparar.png') });
    } catch (e) {
      await pagina.screenshot({ path: join(CAPTURAS, 'xecador-cara-c3-fallo.png') }).catch(() => {});
      throw new Error(`paso ${paso}: ${e.message}`);
    } finally {
      await ctx.close();
    }
  });

  await navegador.close();
}

if (servidor) servidor.detener();
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { for (const f of fallos) console.log(`  · ${f}`); process.exit(1); }
