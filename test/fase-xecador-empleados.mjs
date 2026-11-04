// XECADOR · directorio de empleados con número (migración 127).
//
// Lo que protege, en orden de lo que más caro sale:
//
//   1. Un número de empleado no se reutiliza NUNCA en el mismo negocio: ni
//      después de una baja, ni después de corregirle el número a alguien. La
//      base lo impide aunque el código se equivoque.
//   2. El negocio A no ve ni cambia a los empleados de B, aunque mande ids de
//      B o un negocio_id en el cuerpo.
//   3. Con el módulo apagado, todo contesta 403 'modulo_no_contratado' y no
//      se crea nada. El módulo solo lo enciende el Superadmin, con su ruta de
//      siempre; un administrador de negocio no puede.
//   4. Solo el administrador con sesión real administra empleados: staff,
//      mesero y la contraseña compartida (modo legado) reciben 403.
//   5. La pantalla /personal funciona en un celular, no inserta HTML del
//      cliente y no aparenta estar disponible con el módulo apagado.
//
// Corre contra una base LOCAL desechable (nombre test_*), nunca contra
// Railway. Levanta su propio servidor hijo y un navegador real.
//
// Uso:
//   DATABASE_URL=postgresql://...@127.0.0.1:55453/test_botones_x \
//   SESSION_SECRET=... PANEL_SECRET=... ADMIN_PASSWORD=... PANEL_PASSWORD=... \
//   NODE_OPTIONS=--import=./test/red-solo-local.mjs \
//   node test/fase-xecador-empleados.mjs
//
// Variables opcionales: TEST_PORT_XECADOR (4781), CASOS=A,B,C (partes).
import assert from 'assert';
import { randomUUID, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Barrera: solo bases locales y desechables ───────────────────────────────
const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}

const PUERTO = process.env.TEST_PORT_XECADOR || '4781';
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));

const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const lanza = async (codigo, fn) => {
  try { await fn(); }
  catch (e) {
    assert.strictEqual(e.codigo, codigo, `esperaba ${codigo} y vino ${e.codigo || e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`no lanzó ${codigo}`);
};
/** Un error de Postgres con el código (y, si se da, la restricción) esperado. */
const pgFalla = async (codigo, fn, restriccion) => {
  try { await fn(); }
  catch (e) {
    assert.strictEqual(e.code, codigo, `esperaba SQLSTATE ${codigo} y vino ${e.code}: ${e.message}`);
    if (restriccion) assert.strictEqual(e.constraint, restriccion, `restricción ${e.constraint}`);
    return e;
  }
  assert.fail(`la base aceptó lo que debía rechazar (${codigo})`);
};

// ── Fixture: negocios y personas nuevas en cada corrida ─────────────────────
// Los números de empleado no se pueden borrar (es la garantía que se prueba),
// así que cada corrida usa negocios propios en vez de limpiar los de la
// anterior.
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `xecador-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const A = await negocio('Negocio A');
const B = await negocio('Negocio B');
const PLATAFORMA = await negocio('Plataforma');
const NEGOCIOS_SUITE = [A, B, PLATAFORMA];

const persona = async (neg, nombre, rol, { pin = false } = {}) => {
  const id = (await q1(
    `INSERT INTO usuarios (negocio_id, nombre, email, activo, pin_hash)
     VALUES ($1, $2, $3, true, $4) RETURNING id`,
    [neg, nombre, pin ? null : `${rol}-${randomUUID().slice(0, 8)}@xecador.test.local`, pin ? 'pin-de-prueba' : null])).id;
  await pool.query(
    `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const ADMIN_A = await persona(A, 'Admin A', 'admin');
const STAFF_A = await persona(A, 'Cajero A', 'staff');
const MESERO_A = await persona(A, 'Mesero A', 'mesero', { pin: true });
const ADMIN_B = await persona(B, 'Admin B', 'admin');
const SUPER = await persona(PLATAFORMA, 'Superadmin', 'admin');
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, true)`, [SUPER]);

const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });
const COOKIES = {
  adminA: sesion(ADMIN_A, A, 'admin'),
  staffA: sesion(STAFF_A, A, 'staff'),
  meseroA: sesion(MESERO_A, A, 'mesero'),
  adminB: sesion(ADMIN_B, B, 'admin'),
  super: sesion(SUPER, PLATAFORMA, 'admin'),
};
// Token del modo legado: la contraseña de administrador compartida.
const LEGADO_ADMIN = createHmac('sha256', process.env.PANEL_SECRET || 'xabor-secret-key')
  .update(process.env.ADMIN_PASSWORD || 'xabor-admin').digest('hex');

const cuentaEmpleados = async (neg) => (await q1(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE negocio_id = $1`, [neg])).n;
const estadoModulo = async (neg) => (await q1(
  `SELECT estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'personal'`, [neg]))?.estado ?? null;

// ═══ A. Servicio y base ═════════════════════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Servicio y base de datos');

  await t('A1. nadie tiene el módulo encendido sin que un Superadmin lo haya encendido (auditado)', async () => {
    // Como en una base reutilizada: un negocio que da de alta el Superadmin
    // trae su fila 'personal' en no_configurado (crearNegocioCompleto inserta
    // una fila por cada módulo válido). Esa fila está apagada y no cuenta; lo
    // que no puede existir es un 'activo'/'configurado' sin su cambio auditado.
    const altaReciente = await negocio('Alta reciente');
    await pool.query(
      `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, 'personal', 'no_configurado')`, [altaReciente]);
    const { rows } = await pool.query(
      `SELECT nm.negocio_id, nm.estado FROM negocio_modulos nm
        WHERE nm.modulo = 'personal' AND nm.estado IN ('activo', 'configurado')
          AND NOT EXISTS (SELECT 1 FROM auditoria_plataforma a
                           WHERE a.negocio_id = nm.negocio_id AND a.accion = 'cambiar_modulos_negocio'
                             AND a.estado_nuevo->>'personal' IN ('activo', 'configurado'))`);
    assert.deepStrictEqual(rows, [], `encendido sin Superadmin: ${JSON.stringify(rows)}`);
    assert.strictEqual(await estadoModulo(altaReciente), 'no_configurado');
  });

  await t('A2. número y nombre son obligatorios; el número es solo dígitos y > 0', async () => {
    await lanza('NUMERO_REQUERIDO', () => P.crearEmpleado(A, { nombre: 'Sin número' }));
    await lanza('NUMERO_REQUERIDO', () => P.crearEmpleado(A, { nombre: 'Sin número', numero: '   ' }));
    for (const malo of ['abc', '0', '-3', '1.5', '12a', '1234567890', '+7']) {
      await lanza('NUMERO_INVALIDO', () => P.crearEmpleado(A, { nombre: 'Número malo', numero: malo }));
    }
    await lanza('NOMBRE_REQUERIDO', () => P.crearEmpleado(A, { nombre: '  ', numero: 1 }));
    assert.strictEqual(await cuentaEmpleados(A), 0, 'ningún intento dejó un expediente');
    const r = await q1(`SELECT COUNT(*)::int n FROM xecador_numeros_empleado WHERE negocio_id = $1`, [A]);
    assert.strictEqual(r.n, 0, 'ningún intento inválido apartó un número');
  });

  await t('A3. "007" es el 7, y un número repetido se rechaza sin dejar nada a medias', async () => {
    const e = await P.crearEmpleado(A, { nombre: 'Rosa Cocina', numero: '007', puesto: 'Cocina' }, { actorId: ADMIN_A });
    assert.strictEqual(e.numero_empleado, 7);
    assert.strictEqual(e.estatus, 'activo');
    const antes = await cuentaEmpleados(A);
    const err = await lanza('NUMERO_YA_USADO', () => P.crearEmpleado(A, { nombre: 'Otro', numero: '7' }));
    assert.strictEqual(err.http, 409);
    assert.strictEqual(await cuentaEmpleados(A), antes, 'el intento repetido no creó expediente');
  });

  await t('A4. dar de alta NO crea una cuenta de acceso', async () => {
    const antes = (await q1(`SELECT COUNT(*)::int n FROM usuarios WHERE negocio_id = $1`, [A])).n;
    await P.crearEmpleado(A, { nombre: 'Luis Lavaloza', numero: 8 });
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM usuarios WHERE negocio_id = $1`, [A])).n, antes);
  });

  await t('A5. la baja es lógica y NO libera el número; al reactivar vuelve con el mismo', async () => {
    const e = await P.crearEmpleado(A, { nombre: 'Pedro Repartidor', numero: 20 });
    const baja = await P.darDeBajaEmpleado(A, e.id, { motivo: 'Renuncia', actorId: ADMIN_A });
    assert.strictEqual(baja.estatus, 'baja');
    assert.ok(baja.baja_at);
    assert.ok(await q1(`SELECT 1 FROM xecador_empleados WHERE id = $1`, [e.id]), 'la fila sigue ahí');
    await lanza('NUMERO_YA_USADO', () => P.crearEmpleado(A, { nombre: 'Nuevo con el 20', numero: 20 }));
    await lanza('EMPLEADO_YA_DE_BAJA', () => P.darDeBajaEmpleado(A, e.id));
    await lanza('EMPLEADO_DE_BAJA', () => P.actualizarEmpleado(A, e.id, { nombre: 'Editar a una baja' }));
    const activos = await P.listarEmpleados(A);
    assert.ok(!activos.some((x) => x.id === e.id), 'una baja no sale en el listado normal');
    const todos = await P.listarEmpleados(A, { incluirBajas: true });
    assert.ok(todos.some((x) => x.id === e.id && x.estatus === 'baja'), 'sí sale si se piden las bajas');
    const re = await P.reactivarEmpleado(A, e.id);
    assert.strictEqual(re.estatus, 'activo');
    assert.strictEqual(re.numero_empleado, 20, 'vuelve con su número');
    assert.strictEqual(re.baja_motivo, null);
    await lanza('EMPLEADO_YA_ACTIVO', () => P.reactivarEmpleado(A, e.id));
  });

  await t('A6. corregir el número NO libera el anterior: queda apartado', async () => {
    const e = await P.crearEmpleado(A, { nombre: 'Ana Caja', numero: 30 });
    const editado = await P.actualizarEmpleado(A, e.id, { numero: '31', puesto: 'Caja' }, { actorId: ADMIN_A });
    assert.strictEqual(editado.numero_empleado, 31);
    assert.strictEqual(editado.puesto, 'Caja');
    await lanza('NUMERO_YA_USADO', () => P.crearEmpleado(A, { nombre: 'Quiere el 30', numero: 30 }));
    const r = await pool.query(
      `SELECT numero FROM xecador_numeros_empleado WHERE negocio_id = $1 AND empleado_id = $2 ORDER BY numero`, [A, e.id]);
    assert.deepStrictEqual(r.rows.map((x) => x.numero), [30, 31], 'los dos números quedan a su nombre');
    // Cambiar a un número que tiene otra persona, tampoco.
    await lanza('NUMERO_YA_USADO', () => P.actualizarEmpleado(A, e.id, { numero: 7 }));
    // Repetir su propio número no es un cambio.
    const igual = await P.actualizarEmpleado(A, e.id, { numero: 31, nombre: 'Ana María' });
    assert.strictEqual(igual.numero_empleado, 31);
    assert.strictEqual(igual.nombre, 'Ana María');
  });

  await t('A7. el número es único POR negocio: otro negocio puede usar el 7', async () => {
    const e = await P.crearEmpleado(B, { nombre: 'Rosa de B', numero: 7 });
    assert.strictEqual(e.numero_empleado, 7);
  });

  await t('A8. un negocio no ve ni cambia a los empleados del otro (servicio)', async () => {
    const deA = (await P.listarEmpleados(A))[0];
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.actualizarEmpleado(B, deA.id, { nombre: 'Robado' }));
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.darDeBajaEmpleado(B, deA.id));
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.reactivarEmpleado(B, deA.id));
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.actualizarEmpleado(A, 'no-es-un-uuid', { nombre: 'x' }));
    const deB = await P.listarEmpleados(B, { incluirBajas: true });
    assert.ok(deB.length > 0, 'B tiene empleados que ver (si no, la siguiente aserción no probaría nada)');
    assert.ok(deB.every((x) => x.nombre === 'Rosa de B'), 'B solo ve lo suyo');
    const sigue = await q1(`SELECT nombre, estatus FROM xecador_empleados WHERE id = $1`, [deA.id]);
    assert.strictEqual(sigue.estatus, 'activo');
    assert.notStrictEqual(sigue.nombre, 'Robado');
    await lanza('TENANT_CONTEXT_REQUIRED', () => P.listarEmpleados(undefined));
  });

  await t('A9. el número sugerido es el siguiente al mayor usado nunca (bajas y corregidos incluidos)', async () => {
    assert.strictEqual(await P.siguienteNumeroSugerido(A), 32);
    assert.strictEqual(await P.siguienteNumeroSugerido(PLATAFORMA), 1);
    // El mayor número es de alguien dado de baja: no se vuelve a proponer.
    const e = await P.crearEmpleado(PLATAFORMA, { nombre: 'Temporada', numero: 60 });
    await P.darDeBajaEmpleado(PLATAFORMA, e.id);
    assert.strictEqual(await P.siguienteNumeroSugerido(PLATAFORMA), 61);
  });

  await t('A10. la BASE impide liberar o reasignar un número aunque el código falle', async () => {
    const e = await q1(`SELECT id, numero_empleado FROM xecador_empleados WHERE negocio_id = $1 AND numero_empleado = 7`, [A]);
    // El registro de números es de solo inserción.
    await pgFalla('P0001', () => pool.query(`DELETE FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = 30`, [A]));
    await pgFalla('P0001', () => pool.query(`UPDATE xecador_numeros_empleado SET numero = 999 WHERE negocio_id = $1 AND numero = 30`, [A]));
    // Tomar el 30 (apartado a nombre de Ana) por escritura directa: la llave lo impide.
    await pgFalla('23503', () => pool.query(`UPDATE xecador_empleados SET numero_empleado = 30 WHERE id = $1`, [e.id]),
      'xecador_empleados_numero_registrado');
    // Un expediente sin su número registrado no entra.
    await pgFalla('23503', () => pool.query(
      `INSERT INTO xecador_empleados (negocio_id, numero_empleado, nombre) VALUES ($1, 555, 'Sin registro')`, [A]),
      'xecador_empleados_numero_registrado');
    // Registrar dos veces el mismo número tampoco.
    await pgFalla('23505', () => pool.query(
      `INSERT INTO xecador_numeros_empleado (negocio_id, numero, empleado_id) VALUES ($1, 7, gen_random_uuid())`, [A]),
      'xecador_numeros_empleado_pkey');
    // Baja y fecha de baja van juntas.
    await pgFalla('23514', () => pool.query(`UPDATE xecador_empleados SET estatus = 'baja' WHERE id = $1`, [e.id]),
      'xecador_empleados_baja_coherente');
    // Si alguien borrara el expediente a mano, su número sigue apartado.
    const tmp = await P.crearEmpleado(PLATAFORMA, { nombre: 'Temporal', numero: 3 });
    await pool.query(`DELETE FROM xecador_empleados WHERE id = $1`, [tmp.id]);
    await lanza('NUMERO_YA_USADO', () => P.crearEmpleado(PLATAFORMA, { nombre: 'Reusa el 3', numero: 3 }));
  });

  await t('A11. dos altas simultáneas con el mismo número: entra una sola', async () => {
    const intentos = await Promise.allSettled([1, 2, 3, 4].map((i) =>
      P.crearEmpleado(PLATAFORMA, { nombre: `Carrera ${i}`, numero: 50 })));
    const ok = intentos.filter((x) => x.status === 'fulfilled').length;
    const choques = intentos.filter((x) => x.status === 'rejected' && x.reason?.codigo === 'NUMERO_YA_USADO').length;
    assert.strictEqual(ok, 1, `entraron ${ok}`);
    assert.strictEqual(choques, 3, 'las demás chocan con NUMERO_YA_USADO');
  });

  const NUMERO_70 = `SELECT negocio_id, numero, empleado_id, creado_por, created_at
                       FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = 70`;
  await t('A12. el autor de un número no se puede borrar (se desactiva) y su registro no cambia', async () => {
    const autor = await persona(A, 'Autor temporal', 'admin');
    await P.crearEmpleado(A, { nombre: 'Registrado por el autor', numero: 70 }, { actorId: autor });
    const antes = await q1(NUMERO_70, [A]);
    assert.strictEqual(antes.creado_por, autor);
    // La llave lo impide con su nombre: no es el trigger respondiendo a un
    // SET NULL que nunca podría aplicarse.
    // 23001 = restrict_violation (ON DELETE RESTRICT), con el nombre de la llave.
    await pgFalla('23001', () => pool.query(`DELETE FROM usuarios WHERE id = $1`, [autor]),
      'xecador_numeros_empleado_creado_por_fkey');
    assert.deepStrictEqual(await q1(NUMERO_70, [A]), antes, 'número, negocio, empleado, autor y fecha intactos');
    // Lo que corresponde en Xabor: desactivarlo.
    await pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [autor]);
    assert.deepStrictEqual(await q1(NUMERO_70, [A]), antes);
  });

  await t('A13. los textos solo aceptan texto: un objeto no se guarda como "[object Object]"', async () => {
    await lanza('NOMBRE_INVALIDO', () => P.crearEmpleado(A, { nombre: { a: 1 }, numero: 80 }));
    await lanza('PUESTO_INVALIDO', () => P.crearEmpleado(A, { nombre: 'X', numero: 80, puesto: ['Cocina'] }));
    await lanza('TELEFONO_INVALIDO', () => P.crearEmpleado(A, { nombre: 'X', numero: 80, telefono: { n: 1 } }));
    await lanza('NUMERO_INVALIDO', () => P.crearEmpleado(A, { nombre: 'X', numero: ['80'] }));
    await lanza('NUMERO_INVALIDO', () => P.crearEmpleado(A, { nombre: 'X', numero: true }));
    const e = await P.crearEmpleado(A, { nombre: 'Motivo raro', numero: 80 });
    for (const motivo of [{ a: 1 }, ['x'], 5, true]) {
      await lanza('MOTIVO_INVALIDO', () => P.darDeBajaEmpleado(A, e.id, { motivo }));
    }
    assert.deepStrictEqual(await q1(`SELECT estatus, baja_motivo FROM xecador_empleados WHERE id = $1`, [e.id]),
      { estatus: 'activo', baja_motivo: null }, 'ningún intento dio de baja ni guardó un motivo');
    const ok = await P.darDeBajaEmpleado(A, e.id, { motivo: '  Renuncia  ' });
    assert.strictEqual(ok.baja_motivo, 'Renuncia');
    await P.reactivarEmpleado(A, e.id);
    // Un entero de JavaScript sí vale como número (una API puede mandarlo sin comillas).
    assert.strictEqual((await P.crearEmpleado(A, { nombre: 'Numérico', numero: 81 })).numero_empleado, 81);
  });
}

// ═══ B. Servidor real ═══════════════════════════════════════════════════════
let servidor = null;
async function http(metodo, ruta, { cookie, bearer, cuerpo } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(servidor.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await r.text();
  let datos = null; try { datos = JSON.parse(texto); } catch { /* HTML */ }
  return { status: r.status, datos, texto };
}

if (PARTES.has('B') || PARTES.has('C')) {
  servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
}

if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');
  const EMP = '/api/personal/empleados';

  await t('B1. sin sesión: 401 en lectura y escritura', async () => {
    assert.strictEqual((await http('GET', EMP)).status, 401);
    assert.strictEqual((await http('POST', EMP, { cuerpo: { numero: 1, nombre: 'x' } })).status, 401);
  });

  await t('B2. módulo apagado: 403 modulo_no_contratado y no se crea nada', async () => {
    assert.strictEqual(await estadoModulo(A), null, 'precondición: A sin el módulo');
    const antes = await cuentaEmpleados(A);
    for (const [m, ruta, cuerpo] of [['GET', EMP], ['POST', EMP, { numero: 900, nombre: 'Con módulo apagado' }]]) {
      const r = await http(m, ruta, { cookie: COOKIES.adminA, cuerpo });
      assert.strictEqual(r.status, 403, `${m} ${ruta} → ${r.status}`);
      assert.strictEqual(r.datos?.codigo, 'modulo_no_contratado', `${m} ${ruta} → ${JSON.stringify(r.datos)}`);
    }
    assert.strictEqual(await cuentaEmpleados(A), antes);
    const me = await http('GET', '/api/auth/me', { cookie: COOKIES.adminA });
    assert.ok(!me.datos.modulos.includes('personal'), '/api/auth/me no lo anuncia');
  });

  await t('B3. el administrador del negocio NO puede encender el módulo', async () => {
    const r = await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.adminA, cuerpo: { modulos: { personal: 'activo' } } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(await estadoModulo(A), null);
  });

  await t('B4. el Superadmin lo enciende con su ruta de siempre, y queda auditado', async () => {
    const r = await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    assert.strictEqual(await estadoModulo(A), 'activo');
    const aud = await q1(
      `SELECT estado_nuevo FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'cambiar_modulos_negocio' ORDER BY created_at DESC LIMIT 1`, [A]);
    assert.strictEqual(aud?.estado_nuevo?.personal, 'activo');
    const me = await http('GET', '/api/auth/me', { cookie: COOKIES.adminA });
    assert.ok(me.datos.modulos.includes('personal'));
    const disp = await http('GET', '/api/superadmin/modulos-disponibles', { cookie: COOKIES.super });
    assert.ok(disp.datos.modulos.some((m) => m.clave === 'personal' && (m.requiere || []).length === 0),
      'la consola lo ofrece, sin dependencias obligatorias');
    assert.ok(disp.datos.grupos.some((g) => g.modulos.includes('personal')), 'y dentro de un grupo');
  });

  let idA = null;
  await t('B5. el admin da de alta con número; repetido → 409 NUMERO_YA_USADO', async () => {
    const r = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: '100', nombre: 'Marta Barra', puesto: 'Barra', telefono: '878 123 4567' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
    assert.strictEqual(r.datos.empleado.numero_empleado, 100);
    assert.ok(!('negocio_id' in r.datos.empleado), 'la respuesta no expone el negocio');
    idA = r.datos.empleado.id;
    const dup = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 100, nombre: 'Otra Marta' } });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.datos.codigo, 'NUMERO_YA_USADO');
    const sinNumero = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { nombre: 'Sin número' } });
    assert.strictEqual(sinNumero.status, 400);
    assert.strictEqual(sinNumero.datos.codigo, 'NUMERO_REQUERIDO');
    const lista = await http('GET', EMP, { cookie: COOKIES.adminA });
    assert.strictEqual(lista.status, 200);
    assert.ok(lista.datos.empleados.some((e) => e.id === idA));
    assert.strictEqual(lista.datos.siguienteNumero, 101);
  });

  await t('B6. staff, mesero y la contraseña compartida no administran empleados', async () => {
    assert.strictEqual(await estadoModulo(A), 'activo', 'precondición: el módulo está encendido, así que un 403 es por permiso');
    const intentos = [
      ['GET', EMP], ['POST', EMP, { numero: 901, nombre: 'Staff' }], ['PATCH', `${EMP}/${idA}`, { nombre: 'Staff' }],
      ['POST', `${EMP}/${idA}/baja`, {}], ['POST', `${EMP}/${idA}/reactivar`, {}],
    ];
    for (const [quien, cred] of [['staff', { cookie: COOKIES.staffA }], ['mesero', { cookie: COOKIES.meseroA }], ['legado', { bearer: LEGADO_ADMIN }]]) {
      for (const [m, ruta, cuerpo] of intentos) {
        const r = await http(m, ruta, { ...cred, cuerpo });
        assert.strictEqual(r.status, 403, `${quien} ${m} ${ruta} → ${r.status} ${JSON.stringify(r.datos)}`);
        assert.ok(!String(r.datos?.codigo || '').startsWith('modulo_'), `${quien} ${m} ${ruta}: el 403 vino del módulo, no del permiso`);
      }
    }
    const e = await q1(`SELECT nombre, estatus FROM xecador_empleados WHERE id = $1`, [idA]);
    assert.deepStrictEqual(e, { nombre: 'Marta Barra', estatus: 'activo' }, 'nada cambió');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE numero_empleado = 901`)).n, 0);
  });

  await t('B7. el negocio B no ve ni toca a A, ni mandando el negocio de A en el cuerpo', async () => {
    const r0 = await http('PATCH', `/api/superadmin/negocios/${B}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    assert.strictEqual(r0.status, 200);
    for (const [m, ruta, cuerpo] of [['PATCH', `${EMP}/${idA}`, { nombre: 'Tomado por B' }], ['POST', `${EMP}/${idA}/baja`, {}], ['POST', `${EMP}/${idA}/reactivar`, {}]]) {
      const r = await http(m, ruta, { cookie: COOKIES.adminB, cuerpo });
      assert.strictEqual(r.status, 404, `${m} ${ruta} → ${r.status}`);
    }
    const sigue = await q1(`SELECT nombre, estatus FROM xecador_empleados WHERE id = $1`, [idA]);
    assert.deepStrictEqual(sigue, { nombre: 'Marta Barra', estatus: 'activo' });
    const colado = await http('POST', EMP, { cookie: COOKIES.adminB, cuerpo: { numero: 777, nombre: 'Colado', negocioId: A, negocio_id: A } });
    assert.strictEqual(colado.status, 201);
    const fila = await q1(`SELECT negocio_id FROM xecador_empleados WHERE id = $1`, [colado.datos.empleado.id]);
    assert.strictEqual(fila.negocio_id, B, 'el negocio sale de la sesión, no del cuerpo');
    const lista = await http('GET', `${EMP}?incluirBajas=true`, { cookie: COOKIES.adminB });
    assert.strictEqual(lista.status, 200);
    assert.ok(lista.datos.empleados.some((e) => e.id === colado.datos.empleado.id), 'B ve lo suyo (la lista no está vacía)');
    assert.ok(!lista.datos.empleados.some((e) => e.id === idA), 'B no ve a A');
  });

  await t('B8. baja y reactivación por HTTP; la baja no libera el número', async () => {
    const baja = await http('POST', `${EMP}/${idA}/baja`, { cookie: COOKIES.adminA, cuerpo: { motivo: 'Fin de temporada' } });
    assert.strictEqual(baja.status, 200);
    assert.strictEqual(baja.datos.empleado.estatus, 'baja');
    const reuso = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 100, nombre: 'Quiere el 100' } });
    assert.strictEqual(reuso.status, 409);
    assert.strictEqual(reuso.datos.codigo, 'NUMERO_YA_USADO');
    const otra = await http('POST', `${EMP}/${idA}/baja`, { cookie: COOKIES.adminA, cuerpo: {} });
    assert.strictEqual(otra.status, 409);
    const re = await http('POST', `${EMP}/${idA}/reactivar`, { cookie: COOKIES.adminA, cuerpo: {} });
    assert.strictEqual(re.status, 200);
    assert.strictEqual(re.datos.empleado.numero_empleado, 100);
  });

  await t('B9. id inválido → 404 (no 500); campos ajenos se ignoran', async () => {
    const r = await http('PATCH', `${EMP}/no-es-un-uuid`, { cookie: COOKIES.adminA, cuerpo: { nombre: 'x' } });
    assert.strictEqual(r.status, 404);
    const raro = await http('PATCH', `${EMP}/${idA}`, { cookie: COOKIES.adminA, cuerpo: { estatus: 'baja', id: randomUUID(), negocio_id: B, nombre: 'Marta B.' } });
    assert.strictEqual(raro.status, 200);
    assert.strictEqual(raro.datos.empleado.estatus, 'activo', 'el estatus no se cambia por PATCH');
    assert.strictEqual(raro.datos.empleado.id, idA);
    assert.strictEqual(raro.datos.empleado.nombre, 'Marta B.');
  });

  await t('B10. al apagar el módulo se cierra todo otra vez, sin borrar datos', async () => {
    const off = await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'no_configurado' } } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.datos));
    const r = await http('GET', EMP, { cookie: COOKIES.adminA });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.datos.codigo, 'modulo_no_contratado');
    assert.ok(await q1(`SELECT 1 FROM xecador_empleados WHERE id = $1`, [idA]), 'los empleados siguen ahí');
    const on = await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    assert.strictEqual(on.status, 200);
  });

  await t('B11. /personal sirve la página sin datos dentro y sin mandar al panel', async () => {
    const r = await http('GET', '/personal');
    assert.strictEqual(r.status, 200);
    assert.match(r.texto, /<title>Empleados · Xecador<\/title>/);
    assert.ok(!r.texto.includes('Marta'), 'el HTML no trae empleados');
    // Cada /app abierto imprime comandas: la página no enlaza ni redirige ahí.
    const codigo = r.texto.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(codigo, /href\s*=\s*["']\/app/i, 'no hay enlace a /app');
    assert.doesNotMatch(codigo, /location(\.href)?\s*=\s*["']\/app|location\.(assign|replace)\(\s*["']\/app/, 'no hay redirección a /app');
  });

  await t('B12. por HTTP, el motivo de baja y el nombre tienen que ser texto (400, nada guardado)', async () => {
    for (const motivo of [{ a: 1 }, ['x'], 5, true]) {
      const r = await http('POST', `${EMP}/${idA}/baja`, { cookie: COOKIES.adminA, cuerpo: { motivo } });
      assert.strictEqual(r.status, 400, JSON.stringify(motivo));
      assert.strictEqual(r.datos.codigo, 'MOTIVO_INVALIDO');
    }
    assert.deepStrictEqual(await q1(`SELECT estatus, baja_motivo FROM xecador_empleados WHERE id = $1`, [idA]),
      { estatus: 'activo', baja_motivo: null });
    const nom = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 950, nombre: { a: 1 } } });
    assert.strictEqual(nom.status, 400);
    assert.strictEqual(nom.datos.codigo, 'NOMBRE_INVALIDO');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = 950`, [A])).n, 0);
  });
}

// ═══ C. Navegador (celular) ═════════════════════════════════════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador, 390 × 844');
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const abrir = async (cookie, { antes = null, esperar = 'networkidle0' } = {}) => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    if (cookie) await pagina.setCookie({ name: 'xabor_sesion', value: cookie, url: servidor.base });
    if (antes) await antes(pagina);
    await pagina.goto(servidor.base + '/personal', { waitUntil: esperar });
    return { pagina, ctx };
  };
  const textoDe = (pagina, sel) => pagina.$eval(sel, (el) => el.innerText);
  const visible = (pagina, sel) => pagina.$eval(sel, (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const sinScrollHorizontal = (pagina) => pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const ESPERA = { timeout: 8000 };

  // Un negocio nuevo, con su admin, para pintar desde cero.
  const C_NEG = await negocio('Negocio C');
  const C_ADMIN = await persona(C_NEG, 'Admin C', 'admin');
  const C_COOKIE = sesion(C_ADMIN, C_NEG, 'admin');

  await t('C1. con el módulo apagado la pantalla lo dice y no ofrece dar de alta', async () => {
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('no está habilitado'), ESPERA);
    assert.strictEqual(await visible(pagina, '#btn-nuevo'), false, 'el botón de alta no se ve');
    assert.strictEqual(await visible(pagina, '#directorio'), false);
    await ctx.close();
  });

  await t('C2. el staff ve que no tiene permiso', async () => {
    const { pagina, ctx } = await abrir(COOKIES.staffA);
    await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('Sin permiso'), ESPERA);
    assert.strictEqual(await visible(pagina, '#btn-nuevo'), false);
    await ctx.close();
  });

  await t('C3. sin sesión manda al login y regresa a /personal', async () => {
    const { pagina, ctx } = await abrir(null);
    await pagina.waitForFunction(() => location.pathname === '/login', ESPERA);
    assert.ok(pagina.url().includes('redirect=%2Fpersonal'), pagina.url());
    await ctx.close();
  });

  await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });

  await t('C4. alta desde el celular: número sugerido, búsqueda, duplicado, baja y sin scroll horizontal', async () => {
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    assert.match(await textoDe(pagina, '#lista'), /Todavía no hay empleados/);

    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    assert.strictEqual(await pagina.$eval('#emp-numero', (el) => el.value), '1', 'propone el 1 en un negocio nuevo');
    await pagina.type('#emp-nombre', 'José Pérez');
    await pagina.type('#emp-puesto', 'Cocina');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp').length === 1, ESPERA);

    // Un nombre con etiquetas se pinta como texto.
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    assert.strictEqual(await pagina.$eval('#emp-numero', (el) => el.value), '2');
    await pagina.type('#emp-nombre', '<img src=x onerror="window.__xss=1">Lupita');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp').length === 2, ESPERA);
    assert.strictEqual(await pagina.evaluate(() => window.__xss === 1 || !!document.querySelector('#lista img')), false, 'no se insertó HTML');
    assert.match(await textoDe(pagina, '#lista'), /<img src=x/);

    // Duplicado: el error queda en el diálogo, no se cierra.
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    await pagina.$eval('#emp-numero', (el) => { el.value = ''; });
    await pagina.type('#emp-numero', '1');
    await pagina.type('#emp-nombre', 'Repetido');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('no se reutilizan'), ESPERA);
    assert.ok(await pagina.$('#dlg-empleado[open]'), 'el diálogo sigue abierto');
    await pagina.click('#emp-cancelar');

    // Búsqueda sin acentos.
    await pagina.type('#buscar', 'jose');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp').length === 1, ESPERA);
    assert.match(await textoDe(pagina, '#lista'), /José Pérez/);
    assert.ok(await sinScrollHorizontal(pagina), 'sin scroll horizontal a 390 px');
    assert.strictEqual(await pagina.$$eval('a[href]', (as) => as.filter((a) => new URL(a.href).pathname.startsWith('/app')).length), 0,
      'la página pintada no ofrece ningún enlace a /app');
    await pagina.screenshot({ path: join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-empleados-celular.png') });

    // Baja desde la tarjeta.
    await pagina.$eval('#buscar', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    const tarjeta = await pagina.$('#lista .emp');
    const botones = await tarjeta.$$('button');
    await botones[1].click();
    await pagina.waitForSelector('#dlg-baja[open]', ESPERA);
    await pagina.type('#baja-motivo', 'Prueba');
    await pagina.click('#baja-confirmar');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp').length === 1, ESPERA);
    const enBase = await q1(`SELECT COUNT(*) FILTER (WHERE estatus = 'baja')::int bajas FROM xecador_empleados WHERE negocio_id = $1`, [C_NEG]);
    assert.strictEqual(enBase.bajas, 1);
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp.baja').length === 1, ESPERA);
    assert.ok(await sinScrollHorizontal(pagina), 'sin scroll horizontal con bajas');
    await pagina.screenshot({ path: join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-empleados-celular-bajas.png') });
    await ctx.close();
  });

  await t('C5. si apagan el módulo a media sesión, la pantalla deja de aparentar que funciona', async () => {
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'no_configurado' } } });
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('no está habilitado'), ESPERA);
    assert.strictEqual(await visible(pagina, '#directorio'), false);
    await ctx.close();
  });

  // C5 lo apagó: se vuelve a encender para las pruebas de errores.
  await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });

  await t('C6. sin red al cargar: dice qué pasó y ofrece reintentar (no se queda en «Cargando…»)', async () => {
    let cortar = true;
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => ((cortar && req.url().includes('/api/personal/empleados')) ? req.abort('failed') : req.continue()));
    } });
    await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('Sin conexión'), ESPERA);
    assert.match(await textoDe(pagina, '#estado'), /No se pudo cargar el directorio/);
    assert.strictEqual(await visible(pagina, '#directorio'), false, 'nada que parezca utilizable');
    cortar = false;
    await pagina.click('#btn-reintentar');
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await ctx.close();
  });

  await t('C7. sin red o con error del servidor al guardar, dar de baja o reactivar: el error se ve y nada cambia', async () => {
    let modo = null;
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => {
        const u = req.url(), m = req.method();
        if (modo === 'guardar' && m === 'POST' && u.endsWith('/api/personal/empleados')) return req.abort('failed');
        if (modo === 'baja' && m === 'POST' && u.endsWith('/baja')) {
          return req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'No se pudo completar la operación' }) });
        }
        if (modo === 'reactivar' && m === 'POST' && u.endsWith('/reactivar')) return req.abort('failed');
        return req.continue();
      });
    } });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    const bajasAntes = (await q1(`SELECT COUNT(*) FILTER (WHERE estatus = 'baja')::int n FROM xecador_empleados WHERE negocio_id = $1`, [C_NEG])).n;

    modo = 'guardar';
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    await pagina.type('#emp-nombre', 'Alta sin red');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('Sin conexión'), ESPERA);
    assert.ok(await pagina.$('#dlg-empleado[open]'), 'el diálogo sigue abierto con lo escrito');
    assert.strictEqual(await pagina.$eval('#emp-guardar', (b) => b.disabled), false, 'el botón vuelve a servir');
    await pagina.click('#emp-cancelar');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE nombre = 'Alta sin red'`)).n, 0);

    modo = 'baja';
    const activa = await pagina.$('#lista .emp:not(.baja)');
    assert.ok(activa, `no hay tarjeta activa: ${await textoDe(pagina, '#lista')}`);
    const botonesActiva = await activa.$$('button');
    assert.ok(botonesActiva.length >= 2, `la tarjeta activa no tiene «Dar de baja»: ${await activa.evaluate((e) => e.outerHTML)}`);
    await botonesActiva[1].click();
    await pagina.waitForSelector('#dlg-baja[open]', ESPERA);
    await pagina.click('#baja-confirmar');
    await pagina.waitForFunction(() => document.getElementById('baja-error').innerText.includes('No se pudo completar'), ESPERA);
    await pagina.click('#baja-cancelar');

    modo = 'reactivar';
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp.baja').length >= 1, ESPERA);
    await (await pagina.$('#lista .emp.baja button')).click();
    await pagina.waitForFunction(() => document.getElementById('aviso').innerText.includes('Sin conexión'), ESPERA);
    const bajasDespues = (await q1(`SELECT COUNT(*) FILTER (WHERE estatus = 'baja')::int n FROM xecador_empleados WHERE negocio_id = $1`, [C_NEG])).n;
    assert.strictEqual(bajasDespues, bajasAntes, 'ni la baja con error ni la reactivación sin red cambiaron nada');
    await ctx.close();
  });

  await t('C8. si el servidor no contesta, a los 15 s dice «Sin conexión» en vez de quedarse cargando', async () => {
    const { pagina, ctx } = await abrir(C_COOKIE, { esperar: 'domcontentloaded', antes: async (p) => {
      await p.setRequestInterception(true);
      // /api/auth/me se queda sin respuesta: ni error ni datos.
      p.on('request', (req) => { if (!req.url().includes('/api/auth/me')) req.continue(); });
    } });
    assert.match(await textoDe(pagina, '#estado'), /Cargando/);
    await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('Sin conexión'), { timeout: 22000 });
    assert.ok(await pagina.$('#btn-reintentar'), 'ofrece reintentar');
    await ctx.close();
  });

  await navegador.close();
}

if (servidor) servidor.detener();
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
writeFileSync(join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-resultado.txt'), `${pasadas} ${fallidas}\n`);
process.exit(fallidas ? 1 : 0);
