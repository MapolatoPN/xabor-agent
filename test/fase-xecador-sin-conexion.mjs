// XECADOR · checador sin conexión y «para revisar» (Parte B3, migración 131).
//
// Lo que protege:
//   1. Una checada hecha sin internet NO se pierde: se guarda en la tablet y,
//      al volver la conexión, se registra (una sola vez) aunque traiga algo
//      raro; lo raro se marca para revisar.
//   2. La hora oficial la calcula el servidor con su referencia firmada y el
//      tiempo transcurrido (reloj monotónico), NO con el reloj de la tablet;
//      si este difiere más de 2 minutos, «reloj desfasado». Sin referencia
//      válida, «sin referencia».
//   3. El PIN sin conexión viaja cifrado para el servidor (la tablet no lo
//      puede leer) y se verifica al sincronizar; si no es válido se registra
//      «PIN no válido» con aviso, y la respuesta no lo revela.
//   4. La IP de cada checada contra la habitual de la sucursal (marca, no
//      bloquea), la lista «para revisar» con «revisada» de solo inserción, y
//      el aviso de activos sin PIN.
//
// Base LOCAL desechable (test_*) con la 131. Servidor hijo y navegador real.
// Variables opcionales: TEST_PORT_XECADOR_SIN_CONEXION (4783), CASOS=A,B,C.
import assert from 'assert';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { arrancarServidor } from './lib-servidor.mjs';

const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = process.env.TEST_PORT_XECADOR_SIN_CONEXION || '4783';
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));
const CAPTURAS = process.env.XECADOR_CAPTURAS || tmpdir();

const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const CRIPTO = await import('../src/services/sinConexionCripto.js');
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
const sha256 = (x) => createHash('sha256').update(String(x)).digest('hex');

// El mismo cifrado que hace la tablet (WebCrypto también existe en Node).
const enc = (x) => new TextEncoder().encode(x);
const b64 = (buf) => Buffer.from(buf).toString('base64');
async function cifrarPin(pin, clave, llave = CRIPTO.LLAVE_PUBLICA) {
  const s = globalThis.crypto.subtle;
  const pub = await s.importKey('raw', Buffer.from(llave, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ef = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = await s.deriveBits({ name: 'ECDH', public: pub }, ef.privateKey, 256);
  const base = await s.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const aes = await s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc('xecador'), info: enc('xecador-pin-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await s.encrypt({ name: 'AES-GCM', iv, additionalData: enc(clave) }, aes, enc(pin));
  return { epk: b64(await s.exportKey('raw', ef.publicKey)), iv: b64(iv), ct: b64(ct) };
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `sinred-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const sucursal = async (neg, nombre) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, true) RETURNING id`, [neg, nombre])).id;
const persona = async (neg, nombre, rol) => {
  const id = (await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@sinred.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });

const N = await negocio('Negocio N');
const M = await negocio('Negocio M');
const PLATAFORMA = await negocio('Plataforma');
const MATRIZ = await sucursal(N, 'Matriz');
const NORTE = await sucursal(N, 'Norte');
await sucursal(M, 'Única M');
const ADMIN_N = await persona(N, 'Admin N', 'admin');
const STAFF_N = await persona(N, 'Cajero N', 'staff');
const ADMIN_M = await persona(M, 'Admin M', 'admin');
const SUPER = await persona(PLATAFORMA, 'Superadmin', 'admin');
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, true)`, [SUPER]);
const COOKIES = {
  adminN: sesion(ADMIN_N, N, 'admin'), staffN: sesion(STAFF_N, N, 'staff'),
  adminM: sesion(ADMIN_M, M, 'admin'), super: sesion(SUPER, PLATAFORMA, 'admin'),
};
const alta = (datos) => P.crearEmpleado(N, datos, { actorId: ADMIN_N });
const ANA = await alta({ numero: 1, nombre: 'Ana Matriz', sucursal_id: MATRIZ });
const BETO = await alta({ numero: 2, nombre: 'Beto Norte', sucursal_id: NORTE });
const CARO = await alta({ numero: 3, nombre: 'Caro Matriz', sucursal_id: MATRIZ });
const BAJA = await alta({ numero: 4, nombre: 'Dada de Baja', sucursal_id: MATRIZ });
const SINPIN = await alta({ numero: 5, nombre: 'Sin PIN Todavía', sucursal_id: MATRIZ });
const DIEGO = await alta({ numero: 6, nombre: 'Diego Matriz', sucursal_id: MATRIZ });
const PIN = {};
for (const [k, e] of Object.entries({ ANA, BETO, CARO, BAJA, DIEGO })) PIN[k] = (await P.asignarPin(N, e.id, { actorId: ADMIN_N })).pin;
await P.darDeBajaEmpleado(N, BAJA.id, { tipo: 'renuncia', actorId: ADMIN_N });
void SINPIN;
const otroPin = (pin) => (pin === '135790' ? '246802' : '135790');
const checadasDe = async (eid) => (await pool.query(
  `SELECT id, tipo, hora_oficial, hora_dispositivo, origen, revision, host(ip) AS ip, sincronizada_at, ref_servidor, transcurrido_ms, clave
     FROM xecador_checadas WHERE empleado_id = $1 ORDER BY id`, [eid])).rows;

// ═══ A. Lo criptográfico, sin servidor ══════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Cifrado y referencia de hora');

  await t('A1. el PIN cifrado como lo cifra la tablet solo lo abre el servidor, y solo para su checada', async () => {
    const clave = randomUUID();
    const c = await cifrarPin('482917', clave);
    assert.strictEqual(CRIPTO.descifrarPin(c, clave), '482917');
    assert.ok(!JSON.stringify(c).includes('482917'), 'el cifrado no trae el PIN');
    assert.strictEqual(CRIPTO.descifrarPin(c, randomUUID()), null, 'con otra clave de checada no abre');
    const alterado = Buffer.from(c.ct, 'base64'); alterado[0] ^= 1;
    assert.strictEqual(CRIPTO.descifrarPin({ ...c, ct: alterado.toString('base64') }, clave), null, 'alterado no abre');
    for (const raro of [null, {}, { epk: 'x', iv: 'y', ct: 'z' }, 'texto']) assert.strictEqual(CRIPTO.descifrarPin(raro, clave), null);
    assert.strictEqual(Buffer.from(CRIPTO.LLAVE_PUBLICA, 'base64').length, 65, 'llave pública P-256 sin comprimir');
  });

  await t('A2. la referencia de hora: firmada para su tablet; otra tablet, alterada o del futuro no sirve', () => {
    const d = randomUUID();
    const ref = CRIPTO.firmarReferencia(d);
    assert.ok(Math.abs(CRIPTO.leerReferencia(d, ref) - Date.now()) < 1000);
    assert.strictEqual(CRIPTO.leerReferencia(randomUUID(), ref), null);
    const [ms, firma] = ref.split('.');
    assert.strictEqual(CRIPTO.leerReferencia(d, `${Number(ms) - 5000}.${firma}`), null, 'otra hora con la misma firma');
    const futura = CRIPTO.firmarReferencia(d, Date.now() + 10 * 60000);
    assert.strictEqual(CRIPTO.leerReferencia(d, futura), null, 'del futuro');
    for (const raro of [null, '', 'abc', '123.abc', { x: 1 }]) assert.strictEqual(CRIPTO.leerReferencia(d, raro), null);
  });
}

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
async function nuevaTablet(nombre, suc = MATRIZ) {
  const c = await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminN, cuerpo: { nombre, sucursal_id: suc } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.datos));
  const v = await http('POST', '/api/checador/vincular', { cuerpo: { codigo: c.datos.codigo } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.datos));
  return { id: c.datos.dispositivo.id, token: v.datos.token, codigo: c.datos.codigo };
}
const estado = async (T) => (await http('GET', '/api/checador/estado', { tablet: T.token })).datos;
const sincronizar = (T, checadas, extra = {}) => http('POST', '/api/checador/sincronizar', { tablet: T.token, cuerpo: { checadas }, ...extra });
/** Una checada sin conexión con número + PIN cifrado, a `ms` después de la referencia. */
async function sinRed(T, { numero, pin, tipo = 'entrada', ref, ms = 1000, horaDispositivo, clave = randomUUID(), cifrado } = {}) {
  const refMs = ref ? Number(ref.split('.')[0]) : null;
  return {
    clave, numero, tipo, ref, transcurrido_ms: ref ? ms : undefined,
    pin_cifrado: cifrado ?? await cifrarPin(pin, clave),
    hora_dispositivo: horaDispositivo ?? new Date((refMs ?? Date.now()) + ms).toISOString(),
  };
}
const avisosDe = async (tipo) => (await http('GET', `${CHK}/avisos`, { cookie: COOKIES.adminN })).datos.avisos.filter((a) => a.tipo === tipo);

if (PARTES.has('B') || PARTES.has('C')) {
  servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
  for (const neg of [N, M]) assert.strictEqual((await modulo(neg, 'activo')).status, 200, 'precondición: módulo encendido');
}

let T = null;
if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');
  T = await nuevaTablet('Entrada');

  await t('B1. el servidor da su llave pública y una referencia de hora firmada en cada respuesta', async () => {
    const e = await estado(T);
    assert.strictEqual(e.llave, CRIPTO.LLAVE_PUBLICA);
    assert.ok(CRIPTO.leerReferencia(T.id, e.ref) !== null, 'la referencia es de esta tablet');
    const id = await http('POST', '/api/checador/identificar', { tablet: T.token, cuerpo: { numero: 1, pin: PIN.ANA } });
    assert.ok(CRIPTO.leerReferencia(T.id, id.datos.ref) !== null, 'identificar también la trae');
    const ch = await http('POST', '/api/checador/checar', { tablet: T.token, cuerpo: { pase: id.datos.pase, tipo: 'entrada', clave: randomUUID() } });
    assert.strictEqual(ch.status, 201, JSON.stringify(ch.datos));
    assert.ok(CRIPTO.leerReferencia(T.id, ch.datos.ref) !== null, 'checar también');
    assert.strictEqual((await checadasDe(ANA.id)).at(-1).origen, 'en_linea');
  });

  await t('B2. sin conexión con PIN válido: la hora es la referencia + el transcurrido (no la de llegada); la misma clave no duplica', async () => {
    const { ref } = await estado(T);
    const refMs = Number(ref.split('.')[0]);
    await pausa(2500);   // llega 2.5 s después: la hora oficial NO es la de llegada
    const item = await sinRed(T, { numero: 6, pin: PIN.DIEGO, tipo: 'entrada', ref, ms: 1000 });
    const r = await sincronizar(T, [item]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    assert.deepStrictEqual(r.datos.resultados, [{ clave: item.clave, estado: 'recibida' }]);
    const [c] = await checadasDe(DIEGO.id);
    assert.deepStrictEqual([c.origen, c.revision, c.tipo, Number(c.transcurrido_ms)], ['sin_conexion', [], 'entrada', 1000]);
    assert.strictEqual(new Date(c.hora_oficial).getTime(), refMs + 1000, 'hora oficial = referencia + transcurrido');
    assert.strictEqual(new Date(c.ref_servidor).getTime(), refMs);
    assert.ok(new Date(c.sincronizada_at) - new Date(c.hora_oficial) > 1000, 'llegó después');
    const otra = await sincronizar(T, [item]);
    assert.deepStrictEqual(otra.datos.resultados, [{ clave: item.clave, estado: 'repetida' }]);
    assert.strictEqual((await checadasDe(DIEGO.id)).length, 1);
  });

  await t('B3. si el reloj de la tablet difiere más de 2 minutos, se registra con la hora del servidor y «reloj desfasado»', async () => {
    const { ref } = await estado(T);
    const refMs = Number(ref.split('.')[0]);
    const cerca = await sinRed(T, { numero: 6, pin: PIN.DIEGO, tipo: 'inicio_descanso', ref, ms: 500, horaDispositivo: new Date(refMs + 500 + 90000).toISOString() });
    const lejos = await sinRed(T, { numero: 6, pin: PIN.DIEGO, tipo: 'fin_descanso', ref, ms: 800, horaDispositivo: new Date(refMs + 800 + 10 * 60000).toISOString() });
    const r = await sincronizar(T, [cerca, lejos]);
    assert.deepStrictEqual(r.datos.resultados.map((x) => x.estado), ['recibida', 'recibida']);
    const [, c1, c2] = await checadasDe(DIEGO.id);
    assert.deepStrictEqual(c1.revision, [], '1.5 min de diferencia está dentro de lo tolerado');
    assert.deepStrictEqual(c2.revision, ['reloj_desfasado']);
    assert.strictEqual(new Date(c2.hora_oficial).getTime(), refMs + 800, 'la hora oficial no es la del reloj de la tablet');
    assert.strictEqual(new Date(c2.hora_dispositivo).getTime(), refMs + 800 + 10 * 60000, 'la de la tablet se guarda aparte');
  });

  await t('B4. sin referencia válida (reinicio sin red, alterada o de otra tablet): la hora de la tablet y «sin referencia»; un transcurrido que llega al futuro se recorta', async () => {
    const otraTablet = await nuevaTablet('Cocina');
    const refOtra = (await estado(otraTablet)).ref;
    const { ref } = await estado(T);
    const [ms, firma] = ref.split('.');
    const hace = Date.now() - 60000;
    const items = [
      { ...(await sinRed(T, { numero: 1, pin: PIN.ANA, tipo: 'salida', horaDispositivo: new Date(hace).toISOString() })), ref: undefined, transcurrido_ms: undefined },
      await sinRed(T, { numero: 3, pin: PIN.CARO, tipo: 'entrada', ref: `${Number(ms) - 3600000}.${firma}` }),
      await sinRed(T, { numero: 3, pin: PIN.CARO, tipo: 'salida', ref: refOtra }),
    ];
    const r = await sincronizar(T, items);
    assert.deepStrictEqual(r.datos.resultados.map((x) => x.estado), ['recibida', 'recibida', 'recibida']);
    const ana = (await checadasDe(ANA.id)).at(-1);
    assert.deepStrictEqual([ana.revision, new Date(ana.hora_oficial).getTime()], [['sin_referencia'], hace]);
    for (const c of await checadasDe(CARO.id)) assert.deepStrictEqual(c.revision, ['sin_referencia'], 'alterada o de otra tablet');
    // Un «transcurrido» que llevaría la hora al futuro no es de un reloj monotónico.
    const futuro = await sinRed(T, { numero: 3, pin: PIN.CARO, tipo: 'entrada', ref, ms: 3600000, horaDispositivo: new Date().toISOString() });
    await sincronizar(T, [futuro]);
    const c = (await checadasDe(CARO.id)).at(-1);
    assert.ok(c.revision.includes('reloj_desfasado'));
    assert.ok(Math.abs(new Date(c.hora_oficial) - Date.now()) < 5000, 'se recorta a la hora de llegada');
  });

  await t('B5. PIN no válido: se registra igual con «PIN no válido» y aviso al administrador; la respuesta es la misma que con uno válido', async () => {
    const { ref } = await estado(T);
    const bueno = await sinRed(T, { numero: 3, pin: PIN.CARO, tipo: 'salida', ref });
    const malo = await sinRed(T, { numero: 1, pin: otroPin(PIN.ANA), tipo: 'entrada', ref });
    const otraClave = await sinRed(T, { numero: 1, pin: PIN.ANA, tipo: 'salida', ref, cifrado: await cifrarPin(PIN.ANA, randomUUID()) });
    const basura = { ...(await sinRed(T, { numero: 1, pin: PIN.ANA, tipo: 'entrada', ref })), pin_cifrado: { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' } };
    const avisos0 = (await avisosDe('pin_no_valido')).length;
    const r = await sincronizar(T, [bueno, malo, otraClave, basura]);
    assert.deepStrictEqual(r.datos.resultados, [bueno, malo, otraClave, basura].map((x) => ({ clave: x.clave, estado: 'recibida' })),
      'no dice cuál PIN era válido');
    const deAna = (await checadasDe(ANA.id)).filter((c) => [malo.clave, otraClave.clave, basura.clave].includes(c.clave));
    assert.strictEqual(deAna.length, 3, 'ninguna se perdió');
    assert.ok(deAna.every((c) => c.revision.includes('pin_no_valido')), JSON.stringify(deAna.map((c) => c.revision)));
    assert.ok(!(await checadasDe(CARO.id)).find((c) => c.clave === bueno.clave).revision.includes('pin_no_valido'));
    const avisos = await avisosDe('pin_no_valido');
    assert.strictEqual(avisos.length, avisos0 + 3);
    assert.deepStrictEqual([avisos[0].numero_empleado, avisos[0].empleado, avisos[0].dispositivo], [1, 'Ana Matriz', 'Entrada']);
    // El PIN de Ana no se pausó por esto (no son intentos en vivo).
    assert.strictEqual((await q1(`SELECT pin_fallos FROM xecador_empleados WHERE id = $1`, [ANA.id])).pin_fallos, 0);
  });

  await t('B6. un número que no existe: no hay a quién registrarla; aviso al administrador y la tablet ya no la reintenta', async () => {
    const { ref } = await estado(T);
    const item = await sinRed(T, { numero: 999, pin: '135790', tipo: 'entrada', ref });
    const n0 = (await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE negocio_id = $1`, [N])).n;
    const r = await sincronizar(T, [item]);
    assert.deepStrictEqual(r.datos.resultados, [{ clave: item.clave, estado: 'recibida' }]);
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE negocio_id = $1`, [N])).n, n0);
    const a = (await avisosDe('checada_sin_empleado'))[0];
    assert.deepStrictEqual([a.detalle.numero, a.detalle.tipo, a.dispositivo], [999, 'entrada', 'Entrada']);
  });

  await t('B7. si se cayó el internet al confirmar, el pase de esa persona basta; uno que ya no verifica llega «PIN no válido» (no se pierde); uno ilegible o de otro negocio no registra nada', async () => {
    const id = await http('POST', '/api/checador/identificar', { tablet: T.token, cuerpo: { numero: 3, pin: PIN.CARO } });
    const tipo = id.datos.posibles[0];
    const item = { clave: randomUUID(), pase: id.datos.pase, tipo, ref: id.datos.ref, transcurrido_ms: 400, hora_dispositivo: new Date().toISOString() };
    const r = await sincronizar(T, [item]);
    assert.deepStrictEqual(r.datos.resultados, [{ clave: item.clave, estado: 'recibida' }]);
    const c = (await checadasDe(CARO.id)).find((x) => x.clave === item.clave);
    assert.deepStrictEqual([c.tipo, c.origen, c.revision], [tipo, 'sin_conexion', []]);
    // Firma que ya no cuadra (cambió el secreto del servidor) o pase de otra
    // tablet (se volvió a vincular): se registra marcada, con aviso.
    const otraTablet = await nuevaTablet('Barra');
    const [datos, firma] = id.datos.pase.split('.');
    const avisos0 = (await avisosDe('pin_no_valido')).length;
    for (const [nombre, tablet, pase] of [['firma que no cuadra', T, `${datos}.${firma.slice(0, -2)}AA`], ['de otra tablet', otraTablet, id.datos.pase]]) {
      const x = { clave: randomUUID(), pase, tipo: 'salida', ref: (await estado(tablet)).ref, transcurrido_ms: 100, hora_dispositivo: new Date().toISOString() };
      const rr = await sincronizar(tablet, [x]);
      assert.deepStrictEqual(rr.datos.resultados, [{ clave: x.clave, estado: 'recibida' }], nombre);
      const y = await q1(`SELECT empleado_id, revision FROM xecador_checadas WHERE clave = $1`, [x.clave]);
      assert.deepStrictEqual([y?.empleado_id, y?.revision], [CARO.id, ['pin_no_valido']], nombre);
    }
    const avisos = await avisosDe('pin_no_valido');
    assert.strictEqual(avisos.length, avisos0 + 2);
    assert.strictEqual(avisos[0].detalle.via, 'pase');
    // Ilegible, o de otro negocio: no hay a quién registrarla.
    const deOtroNegocio = `${Buffer.from(JSON.stringify({ d: T.id, n: M, e: CARO.id, x: Date.now() })).toString('base64url')}.${firma}`;
    for (const [nombre, pase] of [['ilegible', 'no-es-un-pase'], ['de otro negocio', deOtroNegocio]]) {
      const x = { clave: randomUUID(), pase, tipo: 'salida', hora_dispositivo: new Date().toISOString() };
      const rr = await sincronizar(T, [x]);
      assert.deepStrictEqual(rr.datos.resultados, [{ clave: x.clave, estado: 'invalida', codigo: 'PASE_INVALIDO' }], nombre);
      assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE clave = $1`, [x.clave])).n, 0, nombre);
    }
  });

  await t('B8. otra sucursal y empleado de baja se registran marcados; sin conexión no se exige el orden (lo marca la vista del día)', async () => {
    const { ref } = await estado(T);
    const beto = await sinRed(T, { numero: 2, pin: PIN.BETO, tipo: 'entrada', ref });
    const baja = await sinRed(T, { numero: 4, pin: PIN.BAJA, tipo: 'entrada', ref });
    const e1 = await sinRed(T, { numero: 2, pin: PIN.BETO, tipo: 'entrada', ref, ms: 2000 });
    const r = await sincronizar(T, [beto, baja, e1]);
    assert.deepStrictEqual(r.datos.resultados.map((x) => x.estado), ['recibida', 'recibida', 'recibida']);
    const deBeto = await checadasDe(BETO.id);
    assert.deepStrictEqual(deBeto.map((c) => c.revision), [['otra_sucursal'], ['otra_sucursal']], 'dos entradas seguidas: las dos se registran');
    assert.deepStrictEqual((await checadasDe(BAJA.id)).map((c) => c.revision), [['empleado_de_baja']]);
    const dia = await http('GET', `${CHK}/checadas`, { cookie: COOKIES.adminN });
    const filas = dia.datos.checadas.filter((c) => c.numero_empleado === 2);
    assert.deepStrictEqual(filas.map((c) => c.fuera_de_orden), [false, true]);
    assert.ok(filas.every((c) => c.origen === 'sin_conexion'));
  });

  await t('B9. IP: cada checada guarda la suya; la habitual de la sucursal se aprende sola y una distinta se marca (no se bloquea)', async () => {
    // Norte todavía no tiene IP habitual: una checada desde cualquier IP no se marca.
    const TN = await nuevaTablet('Norte', NORTE);
    const idB = await http('POST', '/api/checador/identificar', { tablet: TN.token, cuerpo: { numero: 2, pin: PIN.BETO } });
    const primera = await http('POST', '/api/checador/checar', { tablet: TN.token, ip: '198.51.100.7', cuerpo: { pase: idB.datos.pase, tipo: idB.datos.posibles[0], clave: randomUUID() } });
    assert.strictEqual(primera.status, 201, JSON.stringify(primera.datos));
    const cb = (await checadasDe(BETO.id)).at(-1);
    assert.deepStrictEqual([cb.ip, cb.revision], ['198.51.100.7', []], 'sin historia no hay «distinta»');
    // Con una sola muestra todavía no hay habitual: otra IP tampoco se marca.
    const idB2 = await http('POST', '/api/checador/identificar', { tablet: TN.token, cuerpo: { numero: 2, pin: PIN.BETO } });
    const segunda = await http('POST', '/api/checador/checar', { tablet: TN.token, ip: '198.51.100.8', cuerpo: { pase: idB2.datos.pase, tipo: idB2.datos.posibles[0], clave: randomUUID() } });
    assert.strictEqual(segunda.status, 201, JSON.stringify(segunda.datos));
    assert.deepStrictEqual((await checadasDe(BETO.id)).at(-1).revision, [], `con menos de ${5} muestras no hay habitual`);
    // Matriz ya tiene 5 o más checadas desde la IP de las pruebas (127.0.0.1 o
    // ::1, según cómo conecte Node): esa es su habitual.
    const habitual = await q1(`SELECT host(ip) AS ip, COUNT(*)::int AS n FROM xecador_checadas
                                WHERE sucursal_id = $1 AND ip IS NOT NULL GROUP BY ip ORDER BY COUNT(*) DESC LIMIT 1`, [MATRIZ]);
    assert.ok(habitual?.n >= 5 && habitual.ip !== '203.0.113.9', JSON.stringify(habitual));
    const id = await http('POST', '/api/checador/identificar', { tablet: T.token, cuerpo: { numero: 6, pin: PIN.DIEGO } });
    const r = await http('POST', '/api/checador/checar', { tablet: T.token, ip: '203.0.113.9', cuerpo: { pase: id.datos.pase, tipo: id.datos.posibles[0], clave: randomUUID() } });
    assert.strictEqual(r.status, 201, 'no se bloquea');
    const c = (await checadasDe(DIEGO.id)).at(-1);
    assert.deepStrictEqual([c.ip, c.revision], ['203.0.113.9', ['ip_distinta']]);
    const desdeLaHabitual = await http('POST', '/api/checador/identificar', { tablet: T.token, cuerpo: { numero: 6, pin: PIN.DIEGO } });
    await http('POST', '/api/checador/checar', { tablet: T.token, cuerpo: { pase: desdeLaHabitual.datos.pase, tipo: desdeLaHabitual.datos.posibles[0], clave: randomUUID() } });
    assert.deepStrictEqual((await checadasDe(DIEGO.id)).at(-1).revision, [], 'desde la habitual, sin marca');
    // Sin conexión también: la IP es la de la sincronización.
    const { ref } = await estado(T);
    await sincronizar(T, [await sinRed(T, { numero: 6, pin: PIN.DIEGO, tipo: 'salida', ref })], { ip: '203.0.113.50' });
    assert.ok((await checadasDe(DIEGO.id)).at(-1).revision.includes('ip_distinta'));
  });

  await t('B10. «para revisar»: lista lo marcado con sus motivos; «revisada» una sola vez, con autor; solo el administrador del negocio', async () => {
    const r = await http('GET', `${CHK}/revisar`, { cookie: COOKIES.adminN });
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    const motivos = new Set(r.datos.checadas.flatMap((c) => c.motivos));
    for (const m of ['reloj_desfasado', 'sin_referencia', 'pin_no_valido', 'otra_sucursal', 'empleado_de_baja', 'ip_distinta']) assert.ok(motivos.has(m), m);
    assert.ok(!r.datos.checadas.some((c) => !c.motivos.length), 'solo lo que tiene algo');
    const uno = r.datos.checadas.find((c) => c.motivos.includes('pin_no_valido'));
    for (const [quien, cookie, st] of [['staff', COOKIES.staffN, 403], ['M', COOKIES.adminM, 404], ['super', COOKIES.super, 403]]) {
      assert.strictEqual((await http('POST', `${CHK}/revisiones`, { cookie, cuerpo: { checada_id: uno.id } })).status, st, quien);
    }
    assert.strictEqual((await http('GET', `${CHK}/revisar`, { cookie: COOKIES.staffN })).status, 403);
    assert.deepStrictEqual((await http('GET', `${CHK}/revisar`, { cookie: COOKIES.adminM })).datos.checadas, [], 'M no ve lo de N');
    assert.deepStrictEqual((await http('POST', `${CHK}/revisiones`, { cookie: COOKIES.adminN, cuerpo: { checada_id: uno.id, nota: 'x'.repeat(301) } })).datos.codigo, 'NOTA_INVALIDA');
    const ok = await http('POST', `${CHK}/revisiones`, { cookie: COOKIES.adminN, cuerpo: { checada_id: uno.id, nota: 'Lo checó su compañera' } });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.datos));
    assert.deepStrictEqual([ok.datos.revision.autor, ok.datos.revision.nota], ['Admin N', 'Lo checó su compañera']);
    const otra = await http('POST', `${CHK}/revisiones`, { cookie: COOKIES.adminN, cuerpo: { checada_id: uno.id } });
    assert.deepStrictEqual([otra.status, otra.datos.codigo], [409, 'YA_REVISADA']);
    assert.ok(!(await http('GET', `${CHK}/revisar`, { cookie: COOKIES.adminN })).datos.checadas.some((c) => c.id === uno.id), 'ya no está para revisar');
    // La checada no cambió por revisarla.
    assert.ok((await q1(`SELECT revision FROM xecador_checadas WHERE id = $1`, [uno.id])).revision.includes('pin_no_valido'));
  });

  await t('B11. límites: hasta 20 por envío; lo mal formado vuelve «invalida» con su código y no frena a las demás', async () => {
    const { ref } = await estado(T);
    const muchas = await Promise.all(Array.from({ length: 21 }, () => sinRed(T, { numero: 6, pin: PIN.DIEGO, ref })));
    assert.deepStrictEqual((await sincronizar(T, muchas)).datos.codigo, 'DEMASIADAS_CHECADAS');
    assert.deepStrictEqual((await sincronizar(T, [])).datos.codigo, 'SIN_CHECADAS');
    const buena = await sinRed(T, { numero: 6, pin: PIN.DIEGO, tipo: 'entrada', ref });
    const r = await sincronizar(T, [{ clave: 'no', tipo: 'entrada' }, { clave: randomUUID(), tipo: 'pausa' }, { clave: randomUUID(), tipo: 'entrada', numero: 'abc' }, buena]);
    assert.deepStrictEqual(r.datos.resultados.map((x) => [x.estado, x.codigo]),
      [['invalida', 'CLAVE_INVALIDA'], ['invalida', 'TIPO_INVALIDO'], ['invalida', 'NUMERO_INVALIDO'], ['recibida', undefined]]);
  });

  await t('B12. en la base: «revisada» es de solo inserción y las reglas nuevas de las checadas se cumplen', async () => {
    const r = await q1(`SELECT id FROM xecador_revisiones WHERE negocio_id = $1 LIMIT 1`, [N]);
    for (const sql of [`UPDATE xecador_revisiones SET nota = 'otra' WHERE id = ${r.id}`, `DELETE FROM xecador_revisiones WHERE id = ${r.id}`, 'TRUNCATE xecador_revisiones']) {
      const e = await pgFalla('P0001', () => pool.query(sql));
      assert.match(e.message, /solo inserción/, sql);
    }
    const base = [N, ANA.id, MATRIZ, T.id];
    const ins = (cols, vals) => pool.query(
      `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, clave, ${cols}) VALUES ($1, $2, $3, $4, 'entrada', gen_random_uuid(), ${vals})`, base);
    await pgFalla('23514', () => ins('origen', `'satelite'`), 'xecador_checadas_origen_check');
    await pgFalla('23514', () => ins('revision', `ARRAY['inventado']`), 'xecador_checadas_revision_check');
    await pgFalla('23514', () => ins('sincronizada_at', 'NOW()'), 'xecador_checadas_datos_sin_conexion');
    await pgFalla('23514', () => ins('origen, transcurrido_ms', `'sin_conexion', -1`), 'xecador_checadas_transcurrido_check');
  });

  await t('B13. sincronizar exige una tablet autorizada y el módulo encendido', async () => {
    const { ref } = await estado(T);
    const item = await sinRed(T, { numero: 6, pin: PIN.DIEGO, ref });
    assert.strictEqual((await http('POST', '/api/checador/sincronizar', { cuerpo: { checadas: [item] } })).status, 401);
    assert.strictEqual((await http('POST', '/api/checador/sincronizar', { cookie: COOKIES.adminN, cuerpo: { checadas: [item] } })).status, 401);
    assert.strictEqual((await modulo(N, 'suspendido')).status, 200);
    try {
      const r = await sincronizar(T, [item]);
      assert.deepStrictEqual([r.status, r.datos.codigo], [403, 'modulo_suspendido']);
    } finally {
      await modulo(N, 'activo');
    }
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_checadas WHERE clave = $1`, [item.clave])).n, 0);
  });

  await t('B14. una tablet manda hasta 300 checadas sin conexión por hora; las demás esperan (429) y otra tablet no se frena', async () => {
    const R = await nuevaTablet('Ráfaga');
    const basura = () => Array.from({ length: 20 }, () => ({ clave: 'no', tipo: 'entrada' }));
    for (let i = 0; i < 15; i++) assert.strictEqual((await sincronizar(R, basura())).status, 200, `envío ${i + 1}`);
    const r = await sincronizar(R, basura());
    assert.deepStrictEqual([r.status, r.datos.codigo], [429, 'SINCRONIZACION_EN_PAUSA']);
    assert.strictEqual((await sincronizar(T, basura())).status, 200, 'la otra tablet sigue');
  });
}

// ═══ C. Navegador: la tablet sin internet y el administrador ════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador');
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const ESPERA = { timeout: 8000 };
  const textoDe = (pagina, sel) => pagina.$eval(sel, (el) => el.innerText);
  const crearCodigo = async (nombre) => (await http('POST', `${CHK}/dispositivos`, { cookie: COOKIES.adminN, cuerpo: { nombre, sucursal_id: MATRIZ } })).datos;
  async function tabletEnNavegador(nombre, { reloj = 0 } = {}) {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 800, height: 1280, hasTouch: true });
    // Reloj de la tablet adelantado (la hora del servidor no se toca).
    if (reloj) {
      await pagina.evaluateOnNewDocument((off) => {
        const D = Date;
        class Falso extends D { constructor(...a) { super(...(a.length ? a : [D.now() + off])); } static now() { return D.now() + off; } }
        Falso.UTC = D.UTC; Falso.parse = D.parse;
        window.Date = Falso;
      }, reloj);
    }
    await pagina.goto(servidor.base + '/checador', { waitUntil: 'networkidle0' });
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-vincular', ESPERA);
    const c = await crearCodigo(nombre);
    await pagina.type('#v-codigo', c.codigo);
    await pagina.click('#v-boton');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-numero', ESPERA);
    return { pagina, ctx, id: c.dispositivo.id };
  }
  const teclear = async (pagina, teclado, texto) => { for (const d of String(texto)) await pagina.click(`#${teclado} [data-tecla="${d}"]`); };
  async function numeroYPin(pagina, numero, pin) {
    await teclear(pagina, 'n-teclado', numero);
    await pagina.click('#n-teclado [data-tecla="listo"]');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-pin', ESPERA);
    await teclear(pagina, 'pin-teclado', pin);
    await pagina.click('#pin-teclado [data-tecla="listo"]');
  }
  const pendientesEnTablet = (pagina) => pagina.evaluate(() => new Promise((ok) => {
    const r = indexedDB.open('xecador', 1);
    r.onsuccess = () => { const q = r.result.transaction('pendientes').objectStore('pendientes').getAll(); q.onsuccess = () => { ok(q.result); r.result.close(); }; };
  }));

  await t('C1. sin internet la tablet guarda la checada (con el PIN cifrado, ilegible) y la manda sola al volver la conexión', async () => {
    const { pagina, ctx } = await tabletEnNavegador('Tablet sin red');
    // En línea primero: la tablet aprende el nombre de Ana y la hora del servidor.
    await numeroYPin(pagina, 1, PIN.ANA);
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    await pagina.click('#c-cancelar');
    await pagina.setOfflineMode(true);
    await numeroYPin(pagina, 1, PIN.ANA);
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-sin-conexion', ESPERA);
    assert.strictEqual(await textoDe(pagina, '#s-hola'), '#1 · Ana Matriz');
    const sugerida = await pagina.$eval('#s-acciones button', (b) => b.dataset.accion);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-sin-conexion.png') });
    await pagina.click('#s-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.match(await textoDe(pagina, '#r-texto'), /guardada sin conexión$/);
    await pagina.waitForFunction(() => document.getElementById('pendientes').innerText === '1 por enviar', ESPERA);
    const [guardada] = await pendientesEnTablet(pagina);
    assert.ok(guardada.pin_cifrado && !('pin' in guardada), 'guarda el PIN cifrado, no el PIN');
    assert.ok(!JSON.stringify(guardada).includes(PIN.ANA), 'el PIN no aparece en lo guardado');
    assert.ok(guardada.ref && guardada.transcurrido_ms >= 0, 'con referencia del servidor y transcurrido');
    const antes = (await checadasDe(ANA.id)).length;
    await pagina.setOfflineMode(false);
    await pagina.waitForFunction(() => document.getElementById('pendientes').classList.contains('oculto'), { timeout: 30000 });
    const c = (await checadasDe(ANA.id)).at(-1);
    assert.strictEqual((await checadasDe(ANA.id)).length, antes + 1);
    assert.deepStrictEqual([c.origen, c.tipo, c.revision, c.clave], ['sin_conexion', sugerida, [], guardada.clave]);
    assert.deepStrictEqual(await pendientesEnTablet(pagina), [], 'la cola quedó vacía');
    await ctx.close();
  });

  await t('C2. con el reloj de la tablet 10 minutos adelantado: hora del servidor y «reloj desfasado»', async () => {
    const { pagina, ctx } = await tabletEnNavegador('Tablet adelantada', { reloj: 10 * 60000 });
    assert.match(await textoDe(pagina, '#reloj'), /\d{1,2}:\d{2}/);
    await pagina.setOfflineMode(true);
    await numeroYPin(pagina, 6, PIN.DIEGO);
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-sin-conexion', ESPERA);
    await pagina.click('#s-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    const despues = Date.now();
    await pagina.setOfflineMode(false);
    await pagina.waitForFunction(() => document.getElementById('pendientes').classList.contains('oculto'), { timeout: 30000 });
    const c = (await checadasDe(DIEGO.id)).at(-1);
    assert.deepStrictEqual([c.origen, c.revision], ['sin_conexion', ['reloj_desfasado']]);
    assert.ok(Math.abs(new Date(c.hora_oficial) - despues) < 15000, `hora del servidor, no la de la tablet (${c.hora_oficial})`);
    assert.ok(new Date(c.hora_dispositivo) - new Date(c.hora_oficial) > 9 * 60000, 'la de la tablet se guardó aparte');
    await ctx.close();
  });

  await t('C3. si se cae el internet entre el PIN y la confirmación, se guarda con el pase y llega a nombre de quien era', async () => {
    const { pagina, ctx } = await tabletEnNavegador('Tablet de confirmar');
    await numeroYPin(pagina, 3, PIN.CARO);
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-confirmar', ESPERA);
    const tipo = await pagina.$eval('#c-acciones button', (b) => b.dataset.accion);
    await pagina.setOfflineMode(true);
    await pagina.click('#c-acciones button');
    await pagina.waitForFunction(() => document.body.dataset.pantalla === 'p-resultado', ESPERA);
    assert.match(await textoDe(pagina, '#r-texto'), /guardada sin conexión$/);
    const [g] = await pendientesEnTablet(pagina);
    assert.ok(g.pase && !g.pin_cifrado, 'con el pase');
    await pagina.setOfflineMode(false);
    await pagina.waitForFunction(() => document.getElementById('pendientes').classList.contains('oculto'), { timeout: 30000 });
    const c = (await checadasDe(CARO.id)).find((x) => x.clave === g.clave);
    assert.deepStrictEqual([c.tipo, c.origen], [tipo, 'sin_conexion']);
    await ctx.close();
  });

  await t('C4. el administrador ve «Para revisar» con los motivos, la marca revisada y el aviso de activos sin PIN', async () => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await pagina.setCookie({ name: 'xabor_sesion', value: COOKIES.adminN, url: servidor.base });
    await pagina.goto(servidor.base + '/personal', { waitUntil: 'networkidle0' });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#tab-checador');
    await pagina.waitForSelector('#ch-revisar-bloque:not(.oculto)', ESPERA);
    assert.match(await textoDe(pagina, '#ch-sin-pin'), /no pueden? checar porque no tienen? PIN: #5 Sin PIN Todavía/);
    const texto = await textoDe(pagina, '#ch-revisar');
    assert.match(texto, /reloj de la tablet desfasado/i);
    assert.match(texto, /PIN no válido/i);
    assert.match(texto, /el reloj de la tablet marcaba/);
    assert.match(await textoDe(pagina, '#ch-checadas'), /sin conexión/i);
    assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sin scroll horizontal a 390 px');
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-para-revisar.png'), fullPage: true });
    const n0 = await pagina.$$eval('#ch-revisar .fila', (f) => f.length);
    const id = await pagina.$eval('#ch-revisar .fila', (f) => f.dataset.id);
    await pagina.evaluate(() => [...document.querySelectorAll('#ch-revisar .fila')][0].querySelectorAll('button')[1].click());
    await pagina.waitForSelector('#dlg-revisada[open]', ESPERA);
    await pagina.type('#rv-nota', 'Revisado en el piloto');
    await pagina.click('#rv-confirmar');
    await pagina.waitForFunction((n) => document.querySelectorAll('#ch-revisar .fila').length === n - 1, ESPERA, n0);
    assert.deepStrictEqual(await q1(`SELECT nota FROM xecador_revisiones WHERE checada_id = $1`, [id]), { nota: 'Revisado en el piloto' });
    await ctx.close();
  });

  await navegador.close();
}

if (servidor) servidor.detener();
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
writeFileSync(join(CAPTURAS, 'xecador-sin-conexion-resultado.txt'), `${pasadas} ${fallidas}\n`);
process.exit(fallidas ? 1 : 0);
