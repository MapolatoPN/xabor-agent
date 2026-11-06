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
//      se crea nada; suspendido, 403 'modulo_suspendido' y /api/auth/me deja
//      de anunciarlo (de eso depende que el menú del panel esconda la
//      entrada). El módulo solo lo enciende el Superadmin, con su ruta de
//      siempre; un administrador de negocio no puede.
//   4. Solo el administrador con sesión real administra empleados: staff,
//      mesero y la contraseña compartida (modo legado) reciben 403. El
//      Superadmin de Xabor también (decisión del dueño, 5-nov-2026), con su
//      sesión normal y con una sesión de soporte.
//   5. La pantalla /personal funciona en un celular, no inserta HTML del
//      cliente y no aparenta estar disponible con el módulo apagado.
//   6. Parte A (migración 128): la sucursal es del MISMO negocio; fecha de
//      ingreso y NSS se validan (el NSS va enmascarado en la bitácora); editar
//      con una versión vieja no pisa el cambio de otra persona; la baja lleva
//      motivo de catálogo y fecha efectiva; la jornada tiene vigencia y un
//      cambio no reescribe días pasados; el PIN solo se guarda como hash y se
//      ve una sola vez. Lo que falte no impide nada: la tarjeta lo avisa.
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
const sucursal = async (neg, nombre, activo = true) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, $3) RETURNING id`, [neg, nombre, activo])).id;
// Hoy (más o menos días) en la zona de los negocios, como 'AAAA-MM-DD'.
const hoySql = async (dias = 0) => (await q1(
  `SELECT to_char((NOW() AT TIME ZONE 'America/Matamoros')::date + $1::int, 'YYYY-MM-DD') AS d`, [dias])).d;

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
    const baja = await P.darDeBajaEmpleado(A, e.id, { tipo: 'renuncia', motivo: 'Renuncia', actorId: ADMIN_A });
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

  await t('A6b. un empleado recupera un número que fue SUYO; uno que tuvo otra persona, no', async () => {
    const ana = (await q1(`SELECT id FROM xecador_empleados WHERE negocio_id = $1 AND numero_empleado = 31`, [A])).id;
    // Ana tuvo el 30 y lo dejó por el 31: nadie más lo tuvo, así que lo recupera.
    const vuelta = await P.actualizarEmpleado(A, ana, { numero: '030' }, { actorId: ADMIN_A });
    assert.strictEqual(vuelta.numero_empleado, 30);
    const registro = await pool.query(
      `SELECT numero, empleado_id FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero IN (30, 31) ORDER BY numero`, [A]);
    assert.deepStrictEqual(registro.rows.map((r) => [r.numero, r.empleado_id]), [[30, ana], [31, ana]],
      'recuperar no registra nada nuevo: los dos siguen a su nombre');
    // El 31 que acaba de dejar sigue siendo suyo: otra persona no lo toma...
    await lanza('NUMERO_YA_USADO', () => P.crearEmpleado(A, { nombre: 'Quiere el 31', numero: 31 }));
    // ...y ella sí puede volver a él. (Termina en el 31: A10 usa el 30 libre de
    // expedientes pero registrado a nombre de Ana.)
    assert.strictEqual((await P.actualizarEmpleado(A, ana, { numero: 31 })).numero_empleado, 31);
    // Un número que tuvo OTRA persona no se recupera, aunque esa persona ya lo
    // haya dejado: Beto tuvo el 40 y se cambió al 41.
    const beto = await P.crearEmpleado(A, { nombre: 'Beto', numero: 40 });
    await P.actualizarEmpleado(A, beto.id, { numero: 41 });
    const err = await lanza('NUMERO_YA_USADO', () => P.actualizarEmpleado(A, ana, { numero: 40 }));
    assert.strictEqual(err.http, 409);
    assert.match(err.message, /otra persona/);
    assert.strictEqual((await q1(`SELECT numero_empleado FROM xecador_empleados WHERE id = $1`, [ana])).numero_empleado, 31,
      'Ana se queda con el suyo');
    // Y Beto, que sí lo tuvo, puede recuperarlo.
    assert.strictEqual((await P.actualizarEmpleado(A, beto.id, { numero: 40 })).numero_empleado, 40);
    // Las mayúsculas del id no cambian a quién pertenece el número.
    assert.strictEqual((await P.actualizarEmpleado(A, beto.id.toUpperCase(), { numero: 41 })).numero_empleado, 41);
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
    assert.strictEqual(await P.siguienteNumeroSugerido(A), 42);
    assert.strictEqual(await P.siguienteNumeroSugerido(PLATAFORMA), 1);
    // El mayor número es de alguien dado de baja: no se vuelve a proponer.
    const e = await P.crearEmpleado(PLATAFORMA, { nombre: 'Temporada', numero: 60 });
    await P.darDeBajaEmpleado(PLATAFORMA, e.id, { tipo: 'termino_contrato' });
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
    // Un expediente con historia no se borra a mano (la bitácora lo referencia),
    // y su número sigue apartado.
    const tmp = await P.crearEmpleado(PLATAFORMA, { nombre: 'Temporal', numero: 3 });
    await pgFalla('23001', () => pool.query(`DELETE FROM xecador_empleados WHERE id = $1`, [tmp.id]),
      'xecador_empleado_eventos_empleado_fkey');
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
    const ok = await P.darDeBajaEmpleado(A, e.id, { tipo: 'renuncia', motivo: '  Renuncia  ' });
    assert.strictEqual(ok.baja_motivo, 'Renuncia');
    await P.reactivarEmpleado(A, e.id);
    // Un entero de JavaScript sí vale como número (una API puede mandarlo sin comillas).
    assert.strictEqual((await P.crearEmpleado(A, { nombre: 'Numérico', numero: 81 })).numero_empleado, 81);
  });

  await t('A14. TRUNCATE no vacía el registro de números (ni con CASCADE ni en lista con los expedientes)', async () => {
    const numeros = async () => (await q1(`SELECT COUNT(*)::int n FROM xecador_numeros_empleado`)).n;
    const expedientes = async () => (await q1(`SELECT COUNT(*)::int n FROM xecador_empleados`)).n;
    const n0 = await numeros(), e0 = await expedientes();
    assert.ok(n0 > 0 && e0 > 0, 'precondición: hay números y expedientes que proteger');
    // Solo, ya lo frena la llave foránea de los expedientes; da igual quién lo
    // frene, no puede vaciar nada.
    await assert.rejects(pool.query('TRUNCATE xecador_numeros_empleado'));
    // Con CASCADE la llave ya no lo frena: es el trigger de TRUNCATE del propio
    // registro el que tiene que rechazarlo (es el primero en dispararse).
    const e1 = await pgFalla('P0001', () => pool.query('TRUNCATE xecador_numeros_empleado CASCADE'));
    assert.match(e1.message, /xecador_numeros_empleado es de solo inserción.*TRUNCATE/);
    // En lista con todo lo que lo referencia, tampoco. (Desde la 128 las
    // jornadas y desde la 129 las checadas y los avisos también apuntan a los
    // expedientes: sin ellos en la lista, la base ni siquiera llega a los
    // triggers.)
    const conTodo = 'xecador_jornada_dias, xecador_jornadas, xecador_checada_fotos, xecador_checadas, xecador_avisos';
    for (const sql of [`TRUNCATE ${conTodo}, xecador_empleado_eventos, xecador_empleados, xecador_numeros_empleado`,
      `TRUNCATE TABLE ONLY xecador_numeros_empleado, xecador_empleados, xecador_empleado_eventos, ${conTodo} RESTART IDENTITY`]) {
      const e = await pgFalla('P0001', () => pool.query(sql));
      assert.match(e.message, /solo inserción.*TRUNCATE/, sql);
    }
    assert.strictEqual(await numeros(), n0, 'ningún número se liberó');
    assert.strictEqual(await expedientes(), e0, 'ningún expediente se borró');
  });

  await t('A15. la bitácora guarda cada alta, edición, baja y reactivación: quién, cuándo, antes y después', async () => {
    const lupe = await P.crearEmpleado(A, { nombre: 'Lupe', numero: 90 }, { actorId: ADMIN_A });
    let h = await P.historialEmpleado(A, lupe.id);
    assert.deepStrictEqual(h.map((e) => e.tipo), ['alta']);
    assert.deepStrictEqual(h[0].cambios, { numero: 90, nombre: 'Lupe' });
    assert.strictEqual(h[0].actor, 'Admin A');
    assert.ok(h[0].created_at instanceof Date);
    // Editar: solo lo que cambia, con su valor anterior y el nuevo.
    await P.actualizarEmpleado(A, lupe.id, { nombre: 'Guadalupe', puesto: 'Caja', telefono: null }, { actorId: ADMIN_A });
    h = await P.historialEmpleado(A, lupe.id);
    assert.deepStrictEqual(h[1].cambios, { nombre: { antes: 'Lupe', despues: 'Guadalupe' }, puesto: { antes: null, despues: 'Caja' } });
    // Mandar lo mismo no es un cambio: no se escribe nada.
    await P.actualizarEmpleado(A, lupe.id, { nombre: 'Guadalupe', puesto: 'Caja' }, { actorId: ADMIN_A });
    assert.strictEqual((await P.historialEmpleado(A, lupe.id)).length, 2);
    // Cambiar y recuperar el número también queda.
    await P.actualizarEmpleado(A, lupe.id, { numero: 91 }, { actorId: ADMIN_A });
    await P.actualizarEmpleado(A, lupe.id, { numero: 90 }, { actorId: ADMIN_A });
    // Lo que falla no deja rastro: el 7 es de Rosa, y Lupe no puede darse de baja dos veces.
    await lanza('NUMERO_YA_USADO', () => P.actualizarEmpleado(A, lupe.id, { numero: 7 }, { actorId: ADMIN_A }));
    await P.darDeBajaEmpleado(A, lupe.id, { tipo: 'renuncia', motivo: 'Cambio de ciudad', actorId: ADMIN_A });
    await lanza('EMPLEADO_YA_DE_BAJA', () => P.darDeBajaEmpleado(A, lupe.id, { actorId: ADMIN_A }));
    await P.reactivarEmpleado(A, lupe.id, { actorId: ADMIN_A });
    h = await P.historialEmpleado(A, lupe.id);
    assert.deepStrictEqual(h.map((e) => e.tipo), ['alta', 'edicion', 'edicion', 'edicion', 'baja', 'reactivacion']);
    assert.deepStrictEqual(h[2].cambios, { numero: { antes: 90, despues: 91 } });
    assert.deepStrictEqual(h[3].cambios, { numero: { antes: 91, despues: 90 } });
    // Reactivar NO borra la baja: fecha, motivo y autor siguen en la bitácora.
    assert.strictEqual(h[4].motivo, 'Cambio de ciudad');
    assert.strictEqual(h[4].actor, 'Admin A');
    assert.ok(h[4].created_at instanceof Date);
    assert.strictEqual(h[5].actor, 'Admin A');
    assert.ok(h.every((e, i) => i === 0 || e.id > h[i - 1].id), 'en orden');
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.historialEmpleado(B, lupe.id));
  });

  await t('A16. la bitácora es de solo inserción, y un expediente con historia no se borra', async () => {
    const cuenta = async () => (await q1(`SELECT COUNT(*)::int n FROM xecador_empleado_eventos`)).n;
    const n0 = await cuenta();
    assert.ok(n0 > 0, 'precondición: hay eventos que proteger');
    await pgFalla('P0001', () => pool.query(`UPDATE xecador_empleado_eventos SET motivo = 'reescrito'`));
    await pgFalla('P0001', () => pool.query(`DELETE FROM xecador_empleado_eventos`));
    const e = await pgFalla('P0001', () => pool.query('TRUNCATE xecador_empleado_eventos'));
    assert.match(e.message, /xecador_empleado_eventos es de solo inserción/);
    assert.strictEqual(await cuenta(), n0, 'ningún evento cambió ni se borró');
    const rosa = (await q1(`SELECT id FROM xecador_empleados WHERE negocio_id = $1 AND numero_empleado = 7`, [A])).id;
    await pgFalla('23001', () => pool.query(`DELETE FROM xecador_empleados WHERE id = $1`, [rosa]),
      'xecador_empleado_eventos_empleado_fkey');
  });

  await t('A17. reactivar y renombrar un expediente no pasa en silencio: la bitácora lo cuenta todo', async () => {
    const juan = await P.crearEmpleado(A, { nombre: 'Juan', numero: 95, telefono: '111' }, { actorId: ADMIN_A });
    await P.darDeBajaEmpleado(A, juan.id, { tipo: 'renuncia', motivo: 'Renuncia', actorId: ADMIN_A });
    // Una persona nueva no toma su número...
    await lanza('NUMERO_YA_USADO', () => P.crearEmpleado(A, { nombre: 'Pedro', numero: 95 }, { actorId: ADMIN_A }));
    // ...y si alguien reactiva a Juan y le cambia el nombre, queda escrito.
    await P.reactivarEmpleado(A, juan.id, { actorId: ADMIN_A });
    const pedro = await P.actualizarEmpleado(A, juan.id, { nombre: 'Pedro', telefono: '222' }, { actorId: ADMIN_A });
    assert.strictEqual(pedro.numero_empleado, 95, 'mismo expediente, mismo número');
    const h = await P.historialEmpleado(A, juan.id);
    assert.deepStrictEqual(h.map((e) => e.tipo), ['alta', 'baja', 'reactivacion', 'edicion']);
    assert.strictEqual(h[1].motivo, 'Renuncia');
    assert.deepStrictEqual(h[3].cambios, { nombre: { antes: 'Juan', despues: 'Pedro' }, telefono: { antes: '111', despues: '222' } });
    assert.ok(h.every((e) => e.actor === 'Admin A'), 'cada paso con su autor');
  });

  // Alta idempotente: la pantalla repite la clave al reintentar la MISMA alta.
  const numerosDe = async (neg, lista) => (await q1(
    `SELECT COUNT(*)::int n FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = ANY($2::int[])`, [neg, lista])).n;
  const altasDe = async (empleadoId) => (await q1(
    `SELECT COUNT(*)::int n FROM xecador_empleado_eventos WHERE empleado_id = $1 AND tipo = 'alta'`, [empleadoId])).n;

  await t('A18. la misma clave de alta devuelve el mismo expediente y no aparta otro número; es única por negocio', async () => {
    const X = await negocio('Idempotencia X'), Y = await negocio('Idempotencia Y');
    const clave = randomUUID();
    const r1 = await P.darDeAltaEmpleado(X, { nombre: 'Clara Idem', numero: 300 }, { actorId: ADMIN_A, claveAlta: clave });
    assert.strictEqual(r1.repetida, false);
    // Reintento igual, y reintento con otro número y otro nombre (los corrigieron tras el error).
    const r2 = await P.darDeAltaEmpleado(X, { nombre: 'Clara Idem', numero: 300 }, { actorId: ADMIN_A, claveAlta: clave });
    const r3 = await P.darDeAltaEmpleado(X, { nombre: 'Clara I.', numero: 301 }, { actorId: ADMIN_A, claveAlta: clave.toUpperCase() });
    for (const r of [r2, r3]) {
      assert.strictEqual(r.repetida, true);
      assert.deepStrictEqual([r.empleado.id, r.empleado.numero_empleado, r.empleado.nombre], [r1.empleado.id, 300, 'Clara Idem']);
    }
    assert.strictEqual(await numerosDe(X, [301]), 0, 'el reintento no apartó el 301');
    assert.strictEqual(await altasDe(r1.empleado.id), 1, 'una sola alta en la bitácora');
    // Otro negocio con la misma clave: su propia alta, sin ver ni bloquear la de A.
    const rb = await P.darDeAltaEmpleado(Y, { nombre: 'Clara de B', numero: 300 }, { actorId: ADMIN_A, claveAlta: clave });
    assert.strictEqual(rb.repetida, false);
    assert.notStrictEqual(rb.empleado.id, r1.empleado.id);
    assert.strictEqual(rb.empleado.nombre, 'Clara de B');
    // Clave que no es UUID: 400 y nada creado.
    for (const mala of ['no-es-uuid', 12345, { a: 1 }, ['x']]) {
      await lanza('CLAVE_ALTA_INVALIDA', () => P.darDeAltaEmpleado(X, { nombre: 'Mala clave', numero: 302 }, { actorId: ADMIN_A, claveAlta: mala }));
    }
    assert.strictEqual(await numerosDe(X, [302]), 0);
    // La base lo garantiza aunque el código falle: la misma clave dos veces en un negocio.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = randomUUID();
      await c.query(`INSERT INTO xecador_numeros_empleado (negocio_id, numero, empleado_id) VALUES ($1, 303, $2)`, [X, id]);
      await pgFalla('23505', () => c.query(
        `INSERT INTO xecador_empleados (id, negocio_id, numero_empleado, nombre, clave_alta) VALUES ($1, $2, 303, 'Otra', $3)`,
        [id, X, clave]), 'xecador_empleados_clave_alta_unica');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  await t('A19. seis altas simultáneas con la misma clave (y dos números distintos): un expediente y un número', async () => {
    const X = await negocio('Idempotencia Z');
    const clave = randomUUID();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      P.darDeAltaEmpleado(X, { nombre: 'Simultánea', numero: i % 2 ? 311 : 310 }, { actorId: ADMIN_A, claveAlta: clave })));
    assert.strictEqual(rs.filter((r) => !r.repetida).length, 1, `altas nuevas: ${rs.filter((r) => !r.repetida).length}`);
    assert.strictEqual(new Set(rs.map((r) => r.empleado.id)).size, 1, 'todas contestan con el mismo expediente');
    assert.strictEqual(await numerosDe(X, [310, 311]), 1, 'solo quedó apartado el número del alta que ganó');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'Simultánea'`, [X])).n, 1);
    assert.strictEqual(await altasDe(rs[0].empleado.id), 1);
    // Sin clave, la regla de siempre: dos altas con el mismo número, entra una (A11).
  });

  await t('A20. quién es Superadmin lo dice administradores_plataforma; si no se puede saber, no se deja pasar', async () => {
    assert.strictEqual(await P.usuarioEsSuperadmin(SUPER), true);
    assert.strictEqual(await P.usuarioEsSuperadmin(ADMIN_A), false);
    for (const raro of [null, undefined, '', 'no-es-uuid', 123]) {
      await assert.rejects(() => P.usuarioEsSuperadmin(raro), /no verificable/, `${JSON.stringify(raro)} debía fallar cerrado`);
    }
  });

  // ── Parte A (migración 128) ───────────────────────────────────────────────
  await t('A21. sucursal: la única del negocio por omisión; otra del MISMO negocio sí; la de otro negocio o inactiva, no (ni directo en la base)', async () => {
    const N = await negocio('Sucursales N'), M = await negocio('Sucursales M');
    const centro = await sucursal(N, 'Centro');
    const deM = await sucursal(M, 'De M');
    const uno = await P.crearEmpleado(N, { nombre: 'Uno', numero: 1, fecha_ingreso: '2026-01-10' }, { actorId: ADMIN_A });
    assert.strictEqual(uno.sucursal_id, centro, 'con una sola sucursal activa, esa');
    assert.strictEqual((await P.historialEmpleado(N, uno.id))[0].cambios.sucursal, 'Centro', 'la bitácora la nombra');
    const norte = await sucursal(N, 'Norte');
    const dos = await P.crearEmpleado(N, { nombre: 'Dos', numero: 2 });
    assert.strictEqual(dos.sucursal_id, null, 'con dos, nadie adivina: queda pendiente');
    assert.ok((await P.listarEmpleados(N)).find((e) => e.id === dos.id).faltantes.includes('sucursal'));
    const movido = await P.actualizarEmpleado(N, dos.id, { sucursal_id: norte.toUpperCase(), puede_checar_otras_sucursales: true }, { actorId: ADMIN_A });
    assert.deepStrictEqual([movido.sucursal_id, movido.puede_checar_otras_sucursales], [norte, true]);
    assert.deepStrictEqual((await P.historialEmpleado(N, dos.id)).at(-1).cambios,
      { sucursal: { antes: null, despues: 'Norte' }, otras_sucursales: { antes: false, despues: true } });
    await lanza('SUCURSAL_INVALIDA', () => P.actualizarEmpleado(N, dos.id, { sucursal_id: deM }));
    await lanza('SUCURSAL_INVALIDA', () => P.crearEmpleado(N, { nombre: 'Tres', numero: 3, sucursal_id: deM }));
    await lanza('SUCURSAL_INVALIDA', () => P.actualizarEmpleado(N, dos.id, { sucursal_id: 'no-es-uuid' }));
    await lanza('OTRAS_SUCURSALES_INVALIDO', () => P.actualizarEmpleado(N, dos.id, { puede_checar_otras_sucursales: 'sí' }));
    assert.strictEqual(await P.siguienteNumeroSugerido(N), 3, 'el alta rechazada no apartó el 3');
    // La base tampoco deja ligar a un empleado de N con una sucursal de M.
    await pgFalla('23503', () => pool.query(`UPDATE xecador_empleados SET sucursal_id = $1 WHERE id = $2`, [deM, dos.id]),
      'xecador_empleados_sucursal_fkey');
    // Inactiva: ya no se elige ni sale en la lista; quien ya estaba ahí la conserva.
    await pool.query(`UPDATE sucursales SET activo = false WHERE id = $1`, [norte]);
    await lanza('SUCURSAL_INVALIDA', () => P.actualizarEmpleado(N, uno.id, { sucursal_id: norte }));
    assert.deepStrictEqual((await P.listarSucursales(N)).map((x) => x.nombre), ['Centro']);
    const conservada = (await P.listarEmpleados(N)).find((e) => e.id === dos.id);
    assert.deepStrictEqual([conservada.sucursal_id, conservada.sucursal_nombre], [norte, 'Norte']);
    assert.strictEqual((await P.actualizarEmpleado(N, dos.id, { puesto: 'Caja' })).sucursal_id, norte, 'editar otra cosa no la pierde');
    // Una sucursal con empleados no se borra.
    await pgFalla('23001', () => pool.query(`DELETE FROM sucursales WHERE id = $1`, [centro]), 'xecador_empleados_sucursal_fkey');
  });

  await t('A22. fecha de ingreso y NSS: se validan, salen tal cual y el NSS va enmascarado en la bitácora; lo que falta se lista', async () => {
    const N = await negocio('Expediente N');
    for (const fecha of ['2026-02-30', '15/01/2026', '1949-12-31', 20260115]) {
      await lanza('FECHA_INGRESO_INVALIDA', () => P.crearEmpleado(N, { nombre: 'X', numero: 1, fecha_ingreso: fecha }));
    }
    for (const nss of ['1234', '1234567890a', '123456789012', { n: 1 }]) {
      await lanza('NSS_INVALIDO', () => P.crearEmpleado(N, { nombre: 'X', numero: 1, nss }));
    }
    assert.strictEqual(await cuentaEmpleados(N), 0, 'nada a medias');
    assert.strictEqual(await P.siguienteNumeroSugerido(N), 1, 'ni un número apartado');
    const e = await P.crearEmpleado(N, { nombre: 'Con NSS', numero: 1, fecha_ingreso: '2026-01-15', nss: '123 4567-8901' }, { actorId: ADMIN_A });
    assert.deepStrictEqual([e.fecha_ingreso, e.nss], ['2026-01-15', '12345678901'], 'la fecha no se corre un día y el NSS se guarda limpio');
    const alta = (await P.historialEmpleado(N, e.id))[0].cambios;
    assert.deepStrictEqual([alta.nss, alta.fecha_ingreso], ['•••••••8901', '2026-01-15']);
    await P.actualizarEmpleado(N, e.id, { nss: '98765432109' }, { actorId: ADMIN_A });
    const h = await P.historialEmpleado(N, e.id);
    assert.deepStrictEqual(h.at(-1).cambios, { nss: { antes: '•••••••8901', despues: '•••••••2109' } });
    assert.ok(!JSON.stringify(h).includes('12345678901') && !JSON.stringify(h).includes('98765432109'), 'el NSS completo no queda en la bitácora');
    await pgFalla('23514', () => pool.query(`UPDATE xecador_empleados SET nss = '123' WHERE id = $1`, [e.id]), 'xecador_empleados_nss_check');
    // Lo que falta, para el aviso «expediente incompleto». Una baja no lo lleva.
    const sin = await P.crearEmpleado(N, { nombre: 'Sin datos', numero: 2 });
    assert.deepStrictEqual((await P.listarEmpleados(N)).find((x) => x.id === sin.id).faltantes,
      ['fecha de ingreso', 'sucursal', 'jornada', 'PIN']);
    await P.darDeBajaEmpleado(N, sin.id, { tipo: 'renuncia' });
    assert.deepStrictEqual((await P.listarEmpleados(N, { incluirBajas: true })).find((x) => x.id === sin.id).faltantes, []);
  });

  await t('A23. versión del expediente: con la versión vieja no se pisa el cambio de otra persona (409); lo mismo no la sube', async () => {
    const N = await negocio('Version N');
    const e = await P.crearEmpleado(N, { nombre: 'Versión', numero: 1 });
    assert.strictEqual(e.version, 1);
    assert.strictEqual((await P.actualizarEmpleado(N, e.id, { puesto: 'Cocina' }, { version: 1 })).version, 2);
    const err = await lanza('EXPEDIENTE_CAMBIO', () => P.actualizarEmpleado(N, e.id, { telefono: '555' }, { version: 1 }));
    assert.strictEqual(err.http, 409);
    assert.deepStrictEqual(await q1(`SELECT telefono, version FROM xecador_empleados WHERE id = $1`, [e.id]), { telefono: null, version: 2 });
    assert.strictEqual((await P.actualizarEmpleado(N, e.id, { puesto: 'Cocina' }, { version: 2 })).version, 2, 'mandar lo mismo no es un cambio');
    assert.strictEqual((await P.historialEmpleado(N, e.id)).length, 2);
    // Dos personas con la misma versión, a la vez, cada una con otro campo: entra una.
    const r = await Promise.allSettled([
      P.actualizarEmpleado(N, e.id, { nombre: 'Por la primera' }, { version: 2 }),
      P.actualizarEmpleado(N, e.id, { telefono: '777' }, { version: 2 }),
    ]);
    assert.deepStrictEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    assert.strictEqual(r.find((x) => x.status === 'rejected').reason.codigo, 'EXPEDIENTE_CAMBIO');
    assert.strictEqual((await q1(`SELECT version FROM xecador_empleados WHERE id = $1`, [e.id])).version, 3);
    await lanza('VERSION_INVALIDA', () => P.actualizarEmpleado(N, e.id, { nombre: 'x' }, { version: 'abc' }));
    // Sin versión (otra pantalla, una API) sigue funcionando: solo no se protege.
    assert.strictEqual((await P.actualizarEmpleado(N, e.id, { puesto: 'Barra' })).version, 4);
  });

  await t('A24. baja con motivo de catálogo y fecha efectiva: «otro» pide el texto; ni futura ni antes del ingreso; reactivar la limpia', async () => {
    const N = await negocio('Bajas N');
    const e = await P.crearEmpleado(N, { nombre: 'Baja Cat', numero: 1, fecha_ingreso: '2026-03-01' });
    const manana = await hoySql(1), hoy = await hoySql(0);
    await lanza('TIPO_BAJA_REQUERIDO', () => P.darDeBajaEmpleado(N, e.id, {}));
    await lanza('TIPO_BAJA_INVALIDO', () => P.darDeBajaEmpleado(N, e.id, { tipo: 'vacaciones' }));
    await lanza('MOTIVO_REQUERIDO', () => P.darDeBajaEmpleado(N, e.id, { tipo: 'otro', motivo: '   ' }));
    await lanza('FECHA_BAJA_INVALIDA', () => P.darDeBajaEmpleado(N, e.id, { tipo: 'renuncia', fecha: manana }));
    await lanza('FECHA_BAJA_INVALIDA', () => P.darDeBajaEmpleado(N, e.id, { tipo: 'renuncia', fecha: '2026-02-28' }));
    await lanza('FECHA_BAJA_INVALIDA', () => P.darDeBajaEmpleado(N, e.id, { tipo: 'renuncia', fecha: '2026-13-01' }));
    assert.strictEqual((await q1(`SELECT estatus FROM xecador_empleados WHERE id = $1`, [e.id])).estatus, 'activo', 'ningún intento la dio de baja');
    const b = await P.darDeBajaEmpleado(N, e.id, { tipo: 'despido', fecha: '2026-03-10', motivo: 'Faltas', actorId: ADMIN_A });
    assert.deepStrictEqual([b.baja_tipo, b.baja_fecha, b.baja_motivo], ['despido', '2026-03-10', 'Faltas']);
    const ev = (await P.historialEmpleado(N, e.id)).at(-1);
    assert.deepStrictEqual([ev.tipo, ev.motivo, ev.cambios], ['baja', 'Faltas', { fecha: '2026-03-10', tipo: 'despido' }]);
    const re = await P.reactivarEmpleado(N, e.id);
    assert.deepStrictEqual([re.baja_tipo, re.baja_fecha], [null, null]);
    // Sin fecha: la de hoy en la zona de los negocios.
    const otra = await P.darDeBajaEmpleado(N, e.id, { tipo: 'otro', motivo: 'Se mudó' });
    assert.deepStrictEqual([otra.baja_tipo, otra.baja_fecha], ['otro', hoy]);
    // La base: un activo no arrastra datos de baja, y «otro» sin texto no entra.
    await P.reactivarEmpleado(N, e.id);
    await pgFalla('23514', () => pool.query(`UPDATE xecador_empleados SET baja_tipo = 'renuncia' WHERE id = $1`, [e.id]),
      'xecador_empleados_activo_sin_baja');
    await pgFalla('23514', () => pool.query(
      `UPDATE xecador_empleados SET estatus = 'baja', baja_at = NOW(), baja_tipo = 'otro', baja_motivo = NULL WHERE id = $1`, [e.id]),
      'xecador_empleados_baja_otro_motivo');
  });

  await t('A25. jornada con vigencia: la primera puede regir desde antes; un cambio, de hoy en adelante; las anteriores no se tocan', async () => {
    const N = await negocio('Jornadas N');
    const e = await P.crearEmpleado(N, { nombre: 'Turnos', numero: 1, fecha_ingreso: '2026-01-05' });
    const LV = [1, 2, 3, 4, 5].map((dia) => ({ dia, entrada: '09:00', salida: '17:00' }));
    const base = { tipo: 'diurna', vigente_desde: '2026-01-05', dias: LV };
    for (const [codigo, datos] of [
      ['TIPO_JORNADA_INVALIDO', { ...base, tipo: 'larga' }],
      ['VIGENCIA_INVALIDA', { ...base, vigente_desde: undefined }],
      ['VIGENCIA_INVALIDA', { ...base, vigente_desde: '2026-02-30' }],
      ['DIAS_INVALIDOS', { ...base, dias: [] }],
      ['DIAS_INVALIDOS', { ...base, dias: [{ dia: 8, entrada: '09:00', salida: '17:00' }] }],
      ['DIAS_INVALIDOS', { ...base, dias: [LV[0], LV[0]] }],
      ['HORARIO_INVALIDO', { ...base, dias: [{ dia: 1, entrada: '25:00', salida: '17:00' }] }],
      ['HORARIO_INVALIDO', { ...base, dias: [{ dia: 1, entrada: '9:00', salida: '17:00' }] }],
      ['HORARIO_INVALIDO', { ...base, dias: [{ dia: 1, entrada: '10:00', salida: '10:00' }] }],
    ]) await lanza(codigo, () => P.asignarJornada(N, e.id, datos));
    assert.deepStrictEqual(await P.obtenerJornadas(N, e.id), { vigente: null, versiones: [] }, 'nada a medias');
    const j1 = await P.asignarJornada(N, e.id, base, { actorId: ADMIN_A });
    assert.deepStrictEqual([j1.tipo, j1.vigente_desde, j1.dias.length, j1.dias[0]], ['diurna', '2026-01-05', 5, { dia: 1, entrada: '09:00', salida: '17:00' }]);
    // Un cambio no reescribe días pasados.
    await lanza('VIGENCIA_INVALIDA', () => P.asignarJornada(N, e.id, { ...base, vigente_desde: '2026-02-01' }));
    const hoy = await hoySql(0), semana = await hoySql(7);
    // Viernes nocturno que termina el sábado: salida antes que entrada.
    const j2 = await P.asignarJornada(N, e.id, { tipo: 'nocturna', vigente_desde: hoy, dias: [{ dia: 5, entrada: '22:00', salida: '06:00' }] }, { actorId: ADMIN_A });
    assert.deepStrictEqual(j2.dias, [{ dia: 5, entrada: '22:00', salida: '06:00' }]);
    await P.asignarJornada(N, e.id, { tipo: 'mixta', vigente_desde: semana, dias: [{ dia: 6, entrada: '18:00', salida: '01:30' }] }, { actorId: ADMIN_A });
    const { vigente, versiones } = await P.obtenerJornadas(N, e.id);
    assert.strictEqual(vigente.tipo, 'nocturna', 'rige la de hoy; la de la semana próxima todavía no');
    assert.deepStrictEqual(versiones.map((v) => v.vigente_desde), [semana, hoy, '2026-01-05']);
    assert.deepStrictEqual(versiones[2].dias, j1.dias, 'la primera sigue intacta');
    assert.strictEqual(versiones[0].autor, 'Admin A');
    const enLista = (await P.listarEmpleados(N)).find((x) => x.id === e.id);
    assert.deepStrictEqual(enLista.jornada, { tipo: 'nocturna', vigente_desde: hoy, dias: 1 });
    assert.ok(!enLista.faltantes.includes('jornada'));
    // La bitácora: antes y después de cada cambio.
    const ev = (await P.historialEmpleado(N, e.id)).filter((x) => x.tipo === 'jornada');
    assert.strictEqual(ev.length, 3);
    assert.strictEqual(ev[0].cambios.antes, null);
    assert.deepStrictEqual(ev[1].cambios, {
      antes: { vigente_desde: '2026-01-05', tipo: 'diurna', dias: { 1: '09:00-17:00', 2: '09:00-17:00', 3: '09:00-17:00', 4: '09:00-17:00', 5: '09:00-17:00' } },
      despues: { vigente_desde: hoy, tipo: 'nocturna', dias: { 5: '22:00-06:00' } } });
    // De solo inserción, también escribiendo directo en la base.
    await pgFalla('P0001', () => pool.query(`UPDATE xecador_jornadas SET tipo = 'diurna' WHERE empleado_id = $1`, [e.id]));
    await pgFalla('P0001', () => pool.query(`DELETE FROM xecador_jornada_dias WHERE jornada_id = $1`, [j1.id]));
    await pgFalla('P0001', () => pool.query('TRUNCATE xecador_jornada_dias'));
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_jornada_dias (jornada_id, dia, entrada, salida) VALUES ($1, 7, '08:00', '08:00')`, [j1.id]), 'xecador_jornada_dias_duracion');
    await pgFalla('23514', () => pool.query(
      `INSERT INTO xecador_jornada_dias (jornada_id, dia, entrada, salida) VALUES ($1, 0, '08:00', '09:00')`, [j1.id]), 'xecador_jornada_dias_dia_check');
    // Ni desde otro negocio ni a una baja.
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.asignarJornada(A, e.id, { ...base, vigente_desde: hoy }));
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.obtenerJornadas(A, e.id));
    await P.darDeBajaEmpleado(N, e.id, { tipo: 'renuncia' });
    await lanza('EMPLEADO_DE_BAJA', () => P.asignarJornada(N, e.id, { ...base, vigente_desde: semana }));
  });

  await t('A26. PIN: lo genera el sistema (4 a 6 dígitos, nunca trivial), solo se guarda su hash y restablecerlo invalida el anterior', async () => {
    const N = await negocio('PIN N');
    const e = await P.crearEmpleado(N, { nombre: 'Con PIN', numero: 1 });
    for (const trivial of ['1111', '000000', '1234', '3456', '987654', '0123', '8901']) assert.strictEqual(P.pinTrivial(trivial), true, trivial);
    for (const bueno of ['1357', '4821', '902817']) assert.strictEqual(P.pinTrivial(bueno), false, bueno);
    for (const longitud of [3, 7, 'x', 4.5]) await lanza('PIN_LONGITUD_INVALIDA', () => P.asignarPin(N, e.id, { longitud }));
    const r1 = await P.asignarPin(N, e.id, { longitud: 4, actorId: ADMIN_A });
    assert.match(r1.pin, /^\d{4}$/);
    assert.strictEqual(P.pinTrivial(r1.pin), false);
    assert.strictEqual(r1.empleado.tiene_pin, true);
    assert.ok(!('pin_hash' in r1.empleado), 'el hash no sale');
    assert.strictEqual(r1.empleado.version, 1, 'el PIN no cambia la versión del expediente');
    const h1 = (await q1(`SELECT pin_hash FROM xecador_empleados WHERE id = $1`, [e.id])).pin_hash;
    assert.match(h1, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.strictEqual(await P.verificarPin(h1, r1.pin), true);
    assert.strictEqual(await P.verificarPin(h1, r1.pin === '4821' ? '1357' : '4821'), false);
    for (const raro of [null, '', 'scrypt$1$2', 'texto']) assert.strictEqual(await P.verificarPin(raro, r1.pin), false);
    assert.strictEqual(await P.verificarPin(h1, Number(r1.pin)), false, 'un número no es un PIN (perdería los ceros)');
    // Restablecer: 6 dígitos por omisión; el anterior deja de servir.
    const r2 = await P.asignarPin(N, e.id, { actorId: ADMIN_A });
    assert.match(r2.pin, /^\d{6}$/);
    const h2 = (await q1(`SELECT pin_hash FROM xecador_empleados WHERE id = $1`, [e.id])).pin_hash;
    assert.notStrictEqual(h2, h1);
    assert.strictEqual(await P.verificarPin(h2, r1.pin), false);
    assert.strictEqual(await P.verificarPin(h2, r2.pin), true);
    assert.notStrictEqual(await P.hashPin('4821'), await P.hashPin('4821'), 'cada hash con su propia sal');
    // La bitácora: asignado y restablecido, con su autor; nunca el PIN.
    const ev = (await P.historialEmpleado(N, e.id)).filter((x) => x.tipo === 'pin');
    assert.deepStrictEqual(ev.map((x) => x.cambios), [{ accion: 'asignado', longitud: 4 }, { accion: 'restablecido', longitud: 6 }]);
    assert.ok(ev.every((x) => x.actor === 'Admin A'));
    const enLista = (await P.listarEmpleados(N)).find((x) => x.id === e.id);
    assert.ok(!('pin_hash' in enLista) && enLista.tiene_pin === true && !enLista.faltantes.includes('PIN'));
    await pgFalla('23514', () => pool.query(`UPDATE xecador_empleados SET pin_hash = '1234' WHERE id = $1`, [e.id]), 'xecador_empleados_pin_check');
    await lanza('EMPLEADO_NO_ENCONTRADO', () => P.asignarPin(A, e.id));
    await P.darDeBajaEmpleado(N, e.id, { tipo: 'renuncia' });
    await lanza('EMPLEADO_DE_BAJA', () => P.asignarPin(N, e.id));
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

/** Una sesión de soporte de verdad: la ruta de la Central de Operaciones. Devuelve su cookie. */
async function sesionSoporte(negocioId, motivo) {
  const r = await fetch(`${servidor.base}/api/superadmin/negocios/${negocioId}/sesion-soporte`, {
    method: 'POST', body: JSON.stringify({ motivo }),
    headers: { 'Content-Type': 'application/json', Cookie: `xabor_sesion=${encodeURIComponent(COOKIES.super)}` },
  });
  assert.strictEqual(r.status, 200, await r.text());
  const crudo = /xabor_sesion=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[1];
  assert.ok(crudo, 'la Central emitió la cookie de soporte');
  return decodeURIComponent(crudo);
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
    const baja = await http('POST', `${EMP}/${idA}/baja`, { cookie: COOKIES.adminA, cuerpo: { tipo: 'termino_contrato', motivo: 'Fin de temporada' } });
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

  await t('B8b. por HTTP, recuperar el número propio sí; el de otra persona, 409', async () => {
    const cambio = await http('PATCH', `${EMP}/${idA}`, { cookie: COOKIES.adminA, cuerpo: { numero: 102 } });
    assert.strictEqual(cambio.status, 200, JSON.stringify(cambio.datos));
    const vuelta = await http('PATCH', `${EMP}/${idA}`, { cookie: COOKIES.adminA, cuerpo: { numero: 100 } });
    assert.strictEqual(vuelta.status, 200, JSON.stringify(vuelta.datos));
    assert.strictEqual(vuelta.datos.empleado.numero_empleado, 100);
    const otro = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 103, nombre: 'Otro de A' } });
    assert.strictEqual(otro.status, 201);
    const ajeno = await http('PATCH', `${EMP}/${otro.datos.empleado.id}`, { cookie: COOKIES.adminA, cuerpo: { numero: 102 } });
    assert.strictEqual(ajeno.status, 409);
    assert.strictEqual(ajeno.datos.codigo, 'NUMERO_YA_USADO');
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

  await t('B13. el historial por HTTP: cada paso con su autor, solo para admin y solo del propio negocio', async () => {
    const r = await http('GET', `${EMP}/${idA}/historial`, { cookie: COOKIES.adminA });
    assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
    const tipos = r.datos.eventos.map((e) => e.tipo);
    // B5 alta; B8 baja y reactivación; B8b número 100→102→100; B9 nombre. Lo que se rechazó (B6, B7, B12) no dejó nada.
    assert.deepStrictEqual(tipos, ['alta', 'baja', 'reactivacion', 'edicion', 'edicion', 'edicion'], JSON.stringify(tipos));
    assert.ok(r.datos.eventos.every((e) => e.actor === 'Admin A'), 'cada evento hecho por HTTP lleva a quien lo hizo');
    assert.strictEqual(r.datos.eventos[1].motivo, 'Fin de temporada');
    assert.deepStrictEqual(r.datos.eventos[5].cambios, { nombre: { antes: 'Marta Barra', despues: 'Marta B.' } });
    for (const [quien, cred, esperado] of [['staff', { cookie: COOKIES.staffA }, 403], ['legado', { bearer: LEGADO_ADMIN }, 403],
      ['otro negocio', { cookie: COOKIES.adminB }, 404], ['sin sesión', {}, 401]]) {
      const x = await http('GET', `${EMP}/${idA}/historial`, cred);
      assert.strictEqual(x.status, esperado, `${quien} → ${x.status}`);
      assert.ok(!JSON.stringify(x.datos || {}).includes('Marta'), `${quien} no ve datos`);
    }
    assert.strictEqual((await http('GET', `${EMP}/no-es-un-uuid/historial`, { cookie: COOKIES.adminA })).status, 404);
  });

  // La entrada «Empleados» del panel se muestra con lo que anuncia
  // /api/auth/me: suspendido tiene que desaparecer de ahí, y aunque alguien
  // abra la página o llame a la API, el servidor la rechaza.
  await t('B14. módulo suspendido: /api/auth/me no lo anuncia y cada ruta responde 403 modulo_suspendido', async () => {
    const sus = await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'suspendido' } } });
    assert.strictEqual(sus.status, 200, JSON.stringify(sus.datos));
    try {
      assert.strictEqual(await estadoModulo(A), 'suspendido');
      const me = await http('GET', '/api/auth/me', { cookie: COOKIES.adminA });
      assert.ok(!me.datos.modulos.includes('personal'), '/api/auth/me sigue anunciando el módulo suspendido');
      const antes = await cuentaEmpleados(A);
      for (const [m, ruta, cuerpo] of [['GET', EMP], ['POST', EMP, { numero: 901, nombre: 'Con módulo suspendido' }],
        ['PATCH', `${EMP}/${idA}`, { nombre: 'x' }], ['POST', `${EMP}/${idA}/baja`, {}],
        ['POST', `${EMP}/${idA}/reactivar`, {}], ['GET', `${EMP}/${idA}/historial`],
        ['GET', '/api/personal/sucursales'], ['GET', `${EMP}/${idA}/jornada`],
        ['PUT', `${EMP}/${idA}/jornada`, { tipo: 'diurna', vigente_desde: '2026-01-05', dias: [{ dia: 1, entrada: '09:00', salida: '17:00' }] }],
        ['POST', `${EMP}/${idA}/pin`, {}]]) {
        const r = await http(m, ruta, { cookie: COOKIES.adminA, cuerpo });
        assert.strictEqual(r.status, 403, `${m} ${ruta} → ${r.status}`);
        assert.strictEqual(r.datos?.codigo, 'modulo_suspendido', `${m} ${ruta} → ${JSON.stringify(r.datos)}`);
        assert.ok(!JSON.stringify(r.datos || {}).includes('Marta'), `${m} ${ruta} no trae datos`);
      }
      assert.strictEqual(await cuentaEmpleados(A), antes, 'nada se creó con el módulo suspendido');
    } finally {
      await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    }
    assert.strictEqual(await estadoModulo(A), 'activo');
  });

  const numerosHttp = async (neg, lista) => (await q1(
    `SELECT COUNT(*)::int n FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = ANY($2::int[])`, [neg, lista])).n;

  await t('B15. alta por HTTP con claveAlta: el reintento contesta 200 con el mismo expediente, sin otro número ni datos de otro negocio', async () => {
    const claveAlta = randomUUID();
    const r1 = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 400, nombre: 'Rita Reintento', claveAlta } });
    assert.strictEqual(r1.status, 201, JSON.stringify(r1.datos));
    assert.ok(!r1.datos.repetida);
    const r2 = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 401, nombre: 'Rita R.', claveAlta } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.datos));
    assert.strictEqual(r2.datos.repetida, true);
    assert.deepStrictEqual([r2.datos.empleado.id, r2.datos.empleado.numero_empleado, r2.datos.empleado.nombre],
      [r1.datos.empleado.id, 400, 'Rita Reintento']);
    assert.ok(!('clave_alta' in r2.datos.empleado), 'la clave no sale hacia la pantalla');
    assert.strictEqual(await numerosHttp(A, [401]), 0, 'el reintento no apartó el 401');
    // Negocio B con la misma clave: su propia alta y nada de A.
    const rb = await http('POST', EMP, { cookie: COOKIES.adminB, cuerpo: { numero: 400, nombre: 'Rita de B', claveAlta } });
    assert.strictEqual(rb.status, 201, JSON.stringify(rb.datos));
    assert.notStrictEqual(rb.datos.empleado.id, r1.datos.empleado.id);
    assert.ok(!JSON.stringify(rb.datos).includes('Rita Reintento'), 'B no ve el alta de A');
    // Clave que no es UUID: 400 y nada apartado.
    for (const mala of ['abc', 123, { x: 1 }, ['a']]) {
      const r = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 402, nombre: 'Mala', claveAlta: mala } });
      assert.strictEqual(r.status, 400, `${JSON.stringify(mala)} → ${r.status}`);
      assert.strictEqual(r.datos?.codigo, 'CLAVE_ALTA_INVALIDA');
    }
    assert.strictEqual(await numerosHttp(A, [402]), 0);
    // Sin clave sigue funcionando como antes.
    const sin = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 403, nombre: 'Sin Clave' } });
    assert.strictEqual(sin.status, 201, JSON.stringify(sin.datos));
  });

  await t('B16. doble envío simultáneo por HTTP con la misma clave: un expediente, un número; con claves distintas, la regla de siempre', async () => {
    const claveAlta = randomUUID();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: i % 2 ? 411 : 410, nombre: 'Doble Envío', claveAlta } })));
    assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201], rs.map((r) => r.status).join(','));
    assert.strictEqual(new Set(rs.map((r) => r.datos.empleado.id)).size, 1, 'todas con el mismo expediente');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'Doble Envío'`, [A])).n, 1);
    assert.strictEqual(await numerosHttp(A, [410, 411]), 1, 'un solo número apartado');
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_empleado_eventos WHERE empleado_id = $1 AND tipo = 'alta'`,
      [rs[0].datos.empleado.id])).n, 1);
    // Claves distintas y el mismo número: son personas distintas; entra una y las demás 409.
    const otros = await Promise.all(Array.from({ length: 4 }, () =>
      http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 420, nombre: 'Carrera', claveAlta: randomUUID() } })));
    assert.deepStrictEqual(otros.map((r) => r.status).sort(), [201, 409, 409, 409], otros.map((r) => r.status).join(','));
    assert.strictEqual(await numerosHttp(A, [420]), 1);
  });

  // Decisión del dueño (5-nov-2026): el Superadmin de Xabor NO administra
  // empleados, ni con su sesión normal ni en una sesión de soporte. Solo el
  // administrador del negocio, con el módulo encendido.
  const SIN_SUPER = 'superadmin_sin_acceso_personal';
  const rutasDe = (id, numero) => [
    ['GET', EMP], ['POST', EMP, { numero, nombre: 'Intento del Superadmin', claveAlta: randomUUID() }],
    ['PATCH', `${EMP}/${id}`, { nombre: 'Renombrado por el Superadmin' }], ['POST', `${EMP}/${id}/baja`, { motivo: 'x' }],
    ['POST', `${EMP}/${id}/reactivar`, {}], ['GET', `${EMP}/${id}/historial`],
    ['GET', '/api/personal/sucursales'], ['GET', `${EMP}/${id}/jornada`],
    ['PUT', `${EMP}/${id}/jornada`, { tipo: 'diurna', vigente_desde: '2026-01-05', dias: [{ dia: 1, entrada: '09:00', salida: '17:00' }] }],
    ['POST', `${EMP}/${id}/pin`, {}],
  ];
  const huellaXecador = async (neg) => q1(`SELECT
      (SELECT COUNT(*) FROM xecador_empleados WHERE negocio_id = $1)::int AS empleados,
      (SELECT COUNT(*) FROM xecador_numeros_empleado WHERE negocio_id = $1)::int AS numeros,
      (SELECT COUNT(*) FROM xecador_empleado_eventos WHERE negocio_id = $1)::int AS eventos,
      (SELECT COUNT(*) FROM xecador_jornadas WHERE negocio_id = $1)::int AS jornadas,
      (SELECT string_agg(COALESCE(pin_hash, '-'), ',' ORDER BY id) FROM xecador_empleados WHERE negocio_id = $1) AS pines,
      (SELECT string_agg(nombre || ':' || estatus, ',' ORDER BY id) FROM xecador_empleados WHERE negocio_id = $1) AS filas`, [neg]);
  const todasRechazadas = async (cookie, rutas) => {
    for (const [m, ruta, cuerpo] of rutas) {
      const r = await http(m, ruta, { cookie, cuerpo });
      assert.strictEqual(r.status, 403, `${m} ${ruta} → ${r.status} ${JSON.stringify(r.datos)}`);
      assert.strictEqual(r.datos?.codigo, SIN_SUPER, `${m} ${ruta} → ${JSON.stringify(r.datos)}`);
      assert.ok(!JSON.stringify(r.datos || {}).includes('Marta'), `${m} ${ruta} no trae datos`);
    }
  };

  await t('B17. el Superadmin con su sesión normal no administra empleados: 403 en todas las rutas, con el módulo encendido', async () => {
    // El negocio de su sesión, con el módulo encendido y un empleado: el 403 no
    // puede venir del módulo ni de un id inexistente.
    const on = await http('PATCH', `/api/superadmin/negocios/${PLATAFORMA}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.datos));
    const propio = await P.crearEmpleado(PLATAFORMA, { nombre: 'De la Plataforma', numero: 501 });
    const me = await http('GET', '/api/auth/me', { cookie: COOKIES.super });
    assert.ok(me.status === 200 && me.datos.rol === 'admin' && me.datos.modulos.includes('personal'),
      `precondición: es admin de su negocio con el módulo: ${JSON.stringify(me.datos)}`);
    const antes = [await huellaXecador(PLATAFORMA), await huellaXecador(A)];
    await todasRechazadas(COOKIES.super, rutasDe(propio.id, 502));
    // Con el id de un empleado de A tampoco (y su sesión ni siquiera es de A).
    await todasRechazadas(COOKIES.super, rutasDe(idA, 503));
    assert.deepStrictEqual([await huellaXecador(PLATAFORMA), await huellaXecador(A)], antes, 'nada cambió');
  });

  await t('B18. el Superadmin en sesión de soporte del negocio A: 403 en todas las rutas; el administrador de A sigue igual y queda como autor', async () => {
    const soporte = await sesionSoporte(A, 'Prueba Xecador B18');
    try {
      const me = await http('GET', '/api/auth/me', { cookie: soporte });
      assert.ok(me.status === 200 && me.datos.soporte?.activo === true && me.datos.negocioId === A && me.datos.rol === 'admin'
        && me.datos.modulos.includes('personal'), `precondición: sesión de soporte viva en A con el módulo: ${JSON.stringify(me.datos)}`);
      const antes = await huellaXecador(A);
      await todasRechazadas(soporte, rutasDe(idA, 504));
      assert.deepStrictEqual(await huellaXecador(A), antes, 'nada cambió en A');
    } finally {
      await http('POST', '/api/auth/soporte/salir', { cookie: soporte });
    }
    // El administrador de A sigue administrando, y el autor es él.
    assert.strictEqual((await http('GET', EMP, { cookie: COOKIES.adminA })).status, 200);
    const alta = await http('POST', EMP, { cookie: COOKIES.adminA, cuerpo: { numero: 430, nombre: 'Tras el soporte' } });
    assert.strictEqual(alta.status, 201, JSON.stringify(alta.datos));
    const id = alta.datos.empleado.id;
    assert.strictEqual((await http('PATCH', `${EMP}/${id}`, { cookie: COOKIES.adminA, cuerpo: { puesto: 'Caja' } })).status, 200);
    const autores = await pool.query(`SELECT tipo, actor_id FROM xecador_empleado_eventos WHERE empleado_id = $1 ORDER BY id`, [id]);
    assert.deepStrictEqual(autores.rows.map((e) => [e.tipo, e.actor_id]), [['alta', ADMIN_A], ['edicion', ADMIN_A]]);
    const hist = await http('GET', `${EMP}/${id}/historial`, { cookie: COOKIES.adminA });
    assert.strictEqual(hist.status, 200);
    assert.ok(hist.datos.eventos.every((e) => e.actor === 'Admin A'), JSON.stringify(hist.datos.eventos));
  });

  // Lo que el panel usa para mostrar u ocultar «Empleados». Las rutas siguen
  // siendo la autoridad (B17, B18): aquí se vuelve a comprobar que rechazan.
  await t('B19. /api/auth/me dice quién ve «Empleados»: solo el admin del negocio con el módulo; ni staff, ni el Superadmin, ni el soporte', async () => {
    const puede = async (cookie) => {
      const r = await http('GET', '/api/auth/me', { cookie });
      assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
      return r.datos.puedeAdministrarPersonal;
    };
    assert.strictEqual(await puede(COOKIES.adminA), true, 'admin de A, módulo activo');
    assert.strictEqual(await puede(COOKIES.adminB), true, 'admin de B, módulo activo');
    assert.strictEqual(await puede(COOKIES.staffA), false, 'staff de A');
    assert.strictEqual(await puede(COOKIES.super), false, 'Superadmin con su sesión normal (módulo activo en su negocio)');
    const soporte = await sesionSoporte(A, 'Prueba Xecador B19');
    try {
      assert.strictEqual(await puede(soporte), false, 'Superadmin en soporte de A');
      const r = await http('GET', EMP, { cookie: soporte });
      assert.deepStrictEqual([r.status, r.datos?.codigo], [403, 'superadmin_sin_acceso_personal'], 'y la ruta lo sigue rechazando');
    } finally {
      await http('POST', '/api/auth/soporte/salir', { cookie: soporte });
    }
    const r = await http('GET', EMP, { cookie: COOKIES.super });
    assert.deepStrictEqual([r.status, r.datos?.codigo], [403, 'superadmin_sin_acceso_personal']);
    // Con el módulo apagado o suspendido, tampoco el admin del negocio.
    for (const estado of ['no_configurado', 'suspendido']) {
      await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
      try {
        assert.strictEqual(await puede(COOKIES.adminA), false, `módulo ${estado}`);
      } finally {
        await http('PATCH', `/api/superadmin/negocios/${A}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
      }
    }
    assert.strictEqual(await puede(COOKIES.adminA), true, 'de vuelta encendido');
  });

  // ── Parte A (migración 128) por HTTP, en un negocio propio ───────────────
  const D = await negocio('Negocio D');
  const ADMIN_D = await persona(D, 'Admin D', 'admin');
  const COOKIE_D = sesion(ADMIN_D, D, 'admin');
  const SUC_D = await sucursal(D, 'Matriz D');
  const SUC_AJENA = await sucursal(PLATAFORMA, 'Sucursal ajena');
  const JORNADA_OK = { tipo: 'diurna', vigente_desde: '2026-02-01', dias: [{ dia: 1, entrada: '09:00', salida: '17:00' }] };
  let idD = null;

  await t('B20. por HTTP: alta con sucursal, ingreso y NSS; editar con la versión vieja → 409 EXPEDIENTE_CAMBIO sin pisar nada', async () => {
    const on = await http('PATCH', `/api/superadmin/negocios/${D}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.datos));
    const suc = await http('GET', '/api/personal/sucursales', { cookie: COOKIE_D });
    assert.strictEqual(suc.status, 200, JSON.stringify(suc.datos));
    assert.deepStrictEqual(suc.datos.sucursales.map((x) => x.nombre), ['Matriz D'], 'solo las del propio negocio');
    const alta = await http('POST', EMP, { cookie: COOKIE_D, cuerpo: {
      numero: 1, nombre: 'Dora', fecha_ingreso: '2026-02-01', nss: '12345678901', sucursal_id: SUC_D, puede_checar_otras_sucursales: false } });
    assert.strictEqual(alta.status, 201, JSON.stringify(alta.datos));
    const e = alta.datos.empleado;
    idD = e.id;
    assert.deepStrictEqual([e.fecha_ingreso, e.nss, e.sucursal_id, e.version, e.tiene_pin], ['2026-02-01', '12345678901', SUC_D, 1, false]);
    const ajena = await http('POST', EMP, { cookie: COOKIE_D, cuerpo: { numero: 2, nombre: 'Con sucursal ajena', sucursal_id: SUC_AJENA } });
    assert.deepStrictEqual([ajena.status, ajena.datos.codigo], [400, 'SUCURSAL_INVALIDA']);
    const p1 = await http('PATCH', `${EMP}/${idD}`, { cookie: COOKIE_D, cuerpo: { puesto: 'Caja', version: 1 } });
    assert.strictEqual(p1.status, 200, JSON.stringify(p1.datos));
    assert.strictEqual(p1.datos.empleado.version, 2);
    const viejo = await http('PATCH', `${EMP}/${idD}`, { cookie: COOKIE_D, cuerpo: { nombre: 'Pisado', version: 1 } });
    assert.deepStrictEqual([viejo.status, viejo.datos.codigo], [409, 'EXPEDIENTE_CAMBIO']);
    assert.match(viejo.datos.error, /Otra persona cambió este expediente/);
    assert.deepStrictEqual(await q1(`SELECT nombre, puesto FROM xecador_empleados WHERE id = $1`, [idD]), { nombre: 'Dora', puesto: 'Caja' });
    const fila = (await http('GET', EMP, { cookie: COOKIE_D })).datos.empleados.find((x) => x.id === idD);
    assert.deepStrictEqual([fila.sucursal_nombre, fila.faltantes], ['Matriz D', ['jornada', 'PIN']]);
  });

  await t('B21. por HTTP: la jornada (PUT agrega una versión, GET la devuelve), solo del propio negocio', async () => {
    const mal = await http('PUT', `${EMP}/${idD}/jornada`, { cookie: COOKIE_D, cuerpo: { ...JORNADA_OK, dias: [{ dia: 1, entrada: '9', salida: '17:00' }] } });
    assert.deepStrictEqual([mal.status, mal.datos.codigo], [400, 'HORARIO_INVALIDO']);
    const put = await http('PUT', `${EMP}/${idD}/jornada`, { cookie: COOKIE_D, cuerpo: { ...JORNADA_OK, negocio_id: A } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.datos));
    assert.deepStrictEqual(put.datos.jornada.dias, JORNADA_OK.dias);
    const get = await http('GET', `${EMP}/${idD}/jornada`, { cookie: COOKIE_D });
    assert.strictEqual(get.status, 200, JSON.stringify(get.datos));
    assert.deepStrictEqual([get.datos.vigente.vigente_desde, get.datos.versiones.length], ['2026-02-01', 1]);
    for (const [m, cuerpo] of [['GET'], ['PUT', JORNADA_OK]]) {
      const x = await http(m, `${EMP}/${idD}/jornada`, { cookie: COOKIES.adminA, cuerpo });
      assert.strictEqual(x.status, 404, `otro negocio ${m} → ${x.status}`);
    }
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_jornadas WHERE empleado_id = $1`, [idD])).n, 1);
  });

  await t('B22. por HTTP: el PIN viaja UNA vez (sin caché); la lista y el historial nunca traen el PIN ni su hash', async () => {
    const r = await fetch(`${servidor.base}${EMP}/${idD}/pin`, {
      method: 'POST', body: JSON.stringify({ longitud: 5 }),
      headers: { 'Content-Type': 'application/json', Cookie: `xabor_sesion=${encodeURIComponent(COOKIE_D)}` },
    });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    const { pin, empleado } = await r.json();
    assert.match(pin, /^\d{5}$/);
    assert.strictEqual(empleado.tiene_pin, true);
    const hash = (await q1(`SELECT pin_hash FROM xecador_empleados WHERE id = $1`, [idD])).pin_hash;
    assert.strictEqual(await P.verificarPin(hash, pin), true);
    const lista = await http('GET', EMP, { cookie: COOKIE_D });
    const hist = await http('GET', `${EMP}/${idD}/historial`, { cookie: COOKIE_D });
    for (const [que, x] of [['lista', lista], ['historial', hist]]) {
      assert.strictEqual(x.status, 200);
      assert.ok(!x.texto.includes('pin_hash') && !x.texto.includes(hash) && !x.texto.includes('scrypt$'), `${que} no trae el hash`);
    }
    assert.ok(!JSON.stringify(hist.datos.eventos.map((x) => x.cambios)).includes(pin), 'la bitácora no guarda el PIN');
    assert.deepStrictEqual(lista.datos.empleados.find((x) => x.id === idD).faltantes, [], 'expediente completo');
    const largo = await http('POST', `${EMP}/${idD}/pin`, { cookie: COOKIE_D, cuerpo: { longitud: 8 } });
    assert.deepStrictEqual([largo.status, largo.datos.codigo], [400, 'PIN_LONGITUD_INVALIDA']);
    assert.strictEqual((await http('POST', `${EMP}/${idD}/pin`, { cookie: COOKIES.adminA, cuerpo: {} })).status, 404, 'otro negocio');
    assert.strictEqual((await q1(`SELECT pin_hash FROM xecador_empleados WHERE id = $1`, [idD])).pin_hash, hash, 'los intentos rechazados no lo cambiaron');
  });

  await t('B23. por HTTP: la baja pide su motivo de catálogo; staff, legado y sin sesión no entran a las rutas nuevas', async () => {
    const sinTipo = await http('POST', `${EMP}/${idD}/baja`, { cookie: COOKIE_D, cuerpo: { motivo: 'x' } });
    assert.deepStrictEqual([sinTipo.status, sinTipo.datos.codigo], [400, 'TIPO_BAJA_REQUERIDO']);
    const futura = await http('POST', `${EMP}/${idD}/baja`, { cookie: COOKIE_D, cuerpo: { tipo: 'renuncia', fecha: '2099-01-01' } });
    assert.deepStrictEqual([futura.status, futura.datos.codigo], [400, 'FECHA_BAJA_INVALIDA']);
    const STAFF_D = await persona(D, 'Cajero D', 'staff');
    const nuevas = [['GET', '/api/personal/sucursales'], ['GET', `${EMP}/${idD}/jornada`], ['PUT', `${EMP}/${idD}/jornada`, JORNADA_OK],
      ['POST', `${EMP}/${idD}/pin`, {}]];
    for (const [quien, cred, esperado] of [['staff', { cookie: sesion(STAFF_D, D, 'staff') }, 403], ['legado', { bearer: LEGADO_ADMIN }, 403], ['sin sesión', {}, 401]]) {
      for (const [m, ruta, cuerpo] of nuevas) {
        const r = await http(m, ruta, { ...cred, cuerpo });
        assert.strictEqual(r.status, esperado, `${quien} ${m} ${ruta} → ${r.status} ${r.texto.slice(0, 120)}`);
        assert.ok(!String(r.datos?.codigo || '').startsWith('modulo_'), `${quien} ${m} ${ruta}: el rechazo vino del módulo`);
        assert.ok(!r.texto.includes('Matriz D') && !/"pin"/.test(r.texto), `${quien} ${m} ${ruta} no trae datos`);
      }
    }
    assert.strictEqual((await q1(`SELECT COUNT(*)::int n FROM xecador_jornadas WHERE negocio_id = $1`, [D])).n, 1, 'nadie agregó jornadas');
    const ok = await http('POST', `${EMP}/${idD}/baja`, { cookie: COOKIE_D, cuerpo: { tipo: 'termino_contrato', fecha: '2026-03-31', motivo: 'Fin de temporada' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.datos));
    assert.deepStrictEqual([ok.datos.empleado.baja_tipo, ok.datos.empleado.baja_fecha, ok.datos.empleado.estatus], ['termino_contrato', '2026-03-31', 'baja']);
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
  // Para inputs date/time: el valor y sus eventos, como si se hubiera elegido.
  const ponerValor = (pagina, sel, valor) => pagina.$eval(sel, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, valor);

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
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
    await pagina.type('#emp-puesto', 'Cocina');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp').length === 1, ESPERA);

    // Un nombre con etiquetas se pinta como texto.
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    assert.strictEqual(await pagina.$eval('#emp-numero', (el) => el.value), '2');
    await pagina.type('#emp-nombre', '<img src=x onerror="window.__xss=1">Lupita');
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
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
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
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
    await pagina.select('#baja-tipo', 'renuncia');
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

  // C5 lo apagó: se vuelve a encender para las pruebas siguientes.
  await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });

  await t('C9. editar desde el celular: cambiar el número y recuperar el anterior', async () => {
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    const editar = async (numero) => {
      const tarjeta = await pagina.$('#lista .emp:not(.baja)');
      await (await tarjeta.$$('button'))[0].click();
      await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
      await pagina.$eval('#emp-numero', (el) => { el.value = ''; });
      await pagina.type('#emp-numero', numero);
    };
    await editar('15');
    assert.match(await textoDe(pagina, '#emp-pista-numero'), /queda apartado a nombre de esta persona/);
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]') && document.querySelector('#lista .emp .num').innerText === '#15', ESPERA);
    await editar('1');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]') && document.querySelector('#lista .emp .num').innerText === '#1', ESPERA);
    assert.strictEqual((await q1(`SELECT numero_empleado FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'José Pérez'`, [C_NEG])).numero_empleado, 1);
    // El 2 fue de Lupita (dada de baja): no se recupera para José.
    await editar('2');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('otra persona'), ESPERA);
    await pagina.click('#emp-cancelar');
    await ctx.close();
  });

  await t('C10. en el celular: historial con autor, aviso al cambiar el nombre y sin HTML del cliente', async () => {
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    // José: alta, #1 → #15 y #15 → #1 (C9).
    await (await (await pagina.$('#lista .emp:not(.baja)')).$$('button'))[2].click();
    await pagina.waitForSelector('#dlg-historial[open]', ESPERA);
    await pagina.waitForFunction(() => document.querySelectorAll('#hist-lista li').length >= 3, ESPERA);
    const texto = await textoDe(pagina, '#hist-lista');
    for (const esperado of [/Alta/, /#1 → #15/, /#15 → #1/, /por Admin C/]) assert.match(texto, esperado);
    assert.ok(await sinScrollHorizontal(pagina), 'sin scroll horizontal');
    await pagina.screenshot({ path: join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-historial-celular.png') });
    await pagina.click('#hist-cerrar');
    // Lupita (dada de baja, con etiquetas en el nombre): su historial se pinta como texto.
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp.baja').length === 1, ESPERA);
    await (await (await pagina.$('#lista .emp.baja')).$$('button'))[1].click();
    await pagina.waitForSelector('#dlg-historial[open]', ESPERA);
    await pagina.waitForFunction(() => document.querySelectorAll('#hist-lista li').length >= 2, ESPERA);
    assert.strictEqual(await pagina.evaluate(() => window.__xss === 1 || !!document.querySelector('#dlg-historial img')), false, 'no se insertó HTML');
    assert.match(await textoDe(pagina, '#hist-lista'), /<img src=x/);
    assert.match(await textoDe(pagina, '#hist-lista'), /Motivo: Prueba/);
    await pagina.click('#hist-cerrar');
    // Al editar, cambiar el nombre muestra el aviso; volver al mismo lo quita.
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp.baja').length === 0, ESPERA);
    await (await (await pagina.$('#lista .emp:not(.baja)')).$$('button'))[0].click();
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    assert.strictEqual(await visible(pagina, '#emp-pista-nombre'), false);
    await pagina.type('#emp-nombre', ' Luis');
    assert.strictEqual(await visible(pagina, '#emp-pista-nombre'), true, 'avisa que es para corregir');
    assert.match(await textoDe(pagina, '#emp-pista-nombre'), /otra persona/);
    await pagina.$eval('#emp-nombre', (el) => { el.value = 'José Pérez'; el.dispatchEvent(new Event('input')); });
    assert.strictEqual(await visible(pagina, '#emp-pista-nombre'), false);
    await pagina.click('#emp-cancelar');
    await ctx.close();
  });

  const EMP_C = '/api/personal/empleados';
  const enC = async (sql, p = []) => (await q1(sql, [C_NEG, ...p]));
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

  await t('C11. respuesta tardía: el alta llegó al servidor pero la respuesta tardó más de 15 s; reintentar (también tras cerrar y abrir, con otro número) no crea otro expediente', async () => {
    let retener = true;
    let llego = null;
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => {
        if (retener && req.method() === 'POST' && req.url().endsWith(EMP_C)) {
          retener = false;
          // El alta SÍ llega al servidor (con la misma sesión y el mismo cuerpo)...
          llego = fetch(servidor.base + EMP_C, {
            method: 'POST', body: req.postData(),
            headers: { 'Content-Type': 'application/json', Cookie: `xabor_sesion=${encodeURIComponent(C_COOKIE)}` },
          }).then(async (r) => ({ status: r.status, cuerpo: await r.text() }));
          // ...pero a la pantalla la respuesta le llega a los 16 s, cuando ya se rindió.
          llego.then((x) => setTimeout(() => {
            req.respond({ status: x.status, contentType: 'application/json', body: x.cuerpo }).catch(() => {});
          }, 16000));
          return;
        }
        req.continue().catch(() => {});
      });
    } });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    const numero = Number(await pagina.$eval('#emp-numero', (el) => el.value));
    await pagina.type('#emp-nombre', 'Tardía Pérez');
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('Sin conexión'), { timeout: 22000 });
    assert.match(await textoDe(pagina, '#emp-error'), /no se duplica/);
    const real = await llego;
    assert.strictEqual(real.status, 201, `el alta sí se hizo en el servidor: ${real.cuerpo}`);
    // Quien cree que falló: cierra, vuelve a abrir, escribe otro número y guarda.
    await pagina.click('#emp-cancelar');
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    await pagina.$eval('#emp-numero', (el) => { el.value = ''; });
    await pagina.type('#emp-numero', String(numero + 50));
    await pagina.type('#emp-nombre', 'Tardía Pérez');
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]'), ESPERA);
    assert.match(await textoDe(pagina, '#aviso'), /ya estaba dado de alta: no se creó otro expediente/);
    await pagina.waitForFunction(() => [...document.querySelectorAll('#lista .emp .nom')].some((e) => e.textContent.includes('Tardía Pérez')), ESPERA);
    const enBase = await enC(`SELECT COUNT(*)::int n, MIN(numero_empleado) num FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'Tardía Pérez'`);
    assert.deepStrictEqual([enBase.n, enBase.num], [1, numero], 'un solo expediente, con el número del primer intento');
    assert.strictEqual((await enC(`SELECT COUNT(*)::int n FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = $2`, [numero + 50])).n, 0,
      'el reintento no apartó otro número');
    assert.strictEqual(await pagina.$$eval('#lista .emp .nom', (ns) => ns.filter((n) => n.textContent.includes('Tardía Pérez')).length), 1);
    // La siguiente alta lleva otra clave: es otra persona y se da de alta normal.
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    await pagina.type('#emp-nombre', 'Después de la tardía');
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]'), ESPERA);
    assert.match(await textoDe(pagina, '#aviso'), /Empleado dado de alta/);
    assert.strictEqual((await enC(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'Después de la tardía'`)).n, 1);
    await ctx.close();
  });

  await t('C12. doble envío desde la pantalla (dos «Guardar» a la vez): salen los dos y queda un solo expediente', async () => {
    let posts = 0;
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith(EMP_C)) posts++; req.continue().catch(() => {}); });
    } });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    await pagina.type('#emp-nombre', 'Doble Clic');
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
    await pagina.evaluate(() => { const f = document.getElementById('form-empleado'); f.requestSubmit(); f.requestSubmit(); });
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]'), ESPERA);
    await pausa(1500);
    assert.strictEqual(posts, 2, `envíos que salieron: ${posts}`);
    assert.strictEqual((await enC(`SELECT COUNT(*)::int n FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'Doble Clic'`)).n, 1);
    assert.strictEqual(await pagina.$$eval('#lista .emp .nom', (ns) => ns.filter((n) => n.textContent.includes('Doble Clic')).length), 1);
    await ctx.close();
  });

  await t('C13. historial: abrir a una persona y en seguida a otra no mezcla sus eventos aunque la primera respuesta llegue tarde', async () => {
    const uno = (await http('POST', EMP_C, { cookie: C_COOKIE, cuerpo: { numero: 700, nombre: 'Hist Uno' } })).datos.empleado;
    const dos = (await http('POST', EMP_C, { cookie: C_COOKIE, cuerpo: { numero: 701, nombre: 'Hist Dos' } })).datos.empleado;
    assert.ok(uno?.id && dos?.id, 'precondición: dos empleados');
    let lento = null;
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => {
        if (lento && req.url().includes(`${EMP_C}/${lento}/historial`)) { setTimeout(() => req.continue().catch(() => {}), 1500); return; }
        req.continue().catch(() => {});
      });
    } });
    await pagina.waitForSelector(`#lista .emp[data-id="${dos.id}"]`, ESPERA);
    const historialDe = async (id) => (await (await pagina.$(`#lista .emp[data-id="${id}"]`)).$$('button'))[2].click();
    lento = uno.id;
    await historialDe(uno.id);
    await pagina.waitForSelector('#dlg-historial[open]', ESPERA);
    await pagina.click('#hist-cerrar');
    await historialDe(dos.id);
    await pagina.waitForFunction(() => document.querySelectorAll('#hist-lista li').length >= 1, ESPERA);
    await pausa(2500);   // la respuesta de «Hist Uno» ya llegó
    const texto = await textoDe(pagina, '#dlg-historial');
    assert.match(texto, /Hist Dos/);
    assert.doesNotMatch(texto, /Hist Uno/, `se mezcló el historial de otra persona: ${texto}`);
    assert.strictEqual(await pagina.$$eval('#hist-lista li', (l) => l.length), 1, 'solo el alta de Hist Dos');
    await pagina.click('#hist-cerrar');
    // Y si se cierra (con Esc) antes de que llegue, la respuesta tardía no llena el diálogo vacío.
    await historialDe(uno.id);
    await pagina.waitForSelector('#dlg-historial[open]', ESPERA);
    await pagina.keyboard.press('Escape');
    await pausa(2500);
    assert.strictEqual(await pagina.$$eval('#hist-lista li', (l) => l.length), 0, 'el diálogo cerrado no se llenó');
    await ctx.close();
  });

  await t('C14. «Mostrar bajas» rápido: la lista queda como dice la casilla, no como la respuesta más lenta', async () => {
    const quien = (await http('POST', EMP_C, { cookie: C_COOKIE, cuerpo: { numero: 710, nombre: 'Baja Visible' } })).datos.empleado;
    assert.strictEqual((await http('POST', `${EMP_C}/${quien.id}/baja`, { cookie: C_COOKIE, cuerpo: { tipo: 'otro', motivo: 'C14' } })).status, 200);
    let lentaCon = null;   // true: tarda la consulta con bajas; false: la que no las trae
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => {
        const u = new URL(req.url());
        if (lentaCon !== null && req.method() === 'GET' && u.pathname === EMP_C
            && (u.searchParams.get('incluirBajas') === 'true') === lentaCon) {
          setTimeout(() => req.continue().catch(() => {}), 1500); return;
        }
        req.continue().catch(() => {});
      });
    } });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    const estadoLista = () => pagina.evaluate(() => ({
      marcada: document.getElementById('ver-bajas').checked,
      bajas: document.querySelectorAll('#lista .emp.baja').length,
    }));
    // Encender (respuesta lenta) y apagar (rápida) en seguida: queda apagada y sin bajas.
    lentaCon = true;
    await pagina.click('#ver-bajas');
    await pagina.click('#ver-bajas');
    await pausa(2500);
    let e = await estadoLista();
    assert.deepStrictEqual(e, { marcada: false, bajas: 0 }, `apagada: ${JSON.stringify(e)}`);
    // Al revés: la consulta SIN bajas es la lenta; la casilla termina encendida.
    lentaCon = false;
    await pagina.click('#ver-bajas');   // encendida (rápida)
    await pagina.click('#ver-bajas');   // apagada (lenta)
    await pagina.click('#ver-bajas');   // encendida (rápida)
    await pausa(2500);
    e = await estadoLista();
    assert.ok(e.marcada && e.bajas >= 1, `encendida: ${JSON.stringify(e)}`);
    await ctx.close();
  });

  await t('C15. el Superadmin (sesión normal y de soporte) abre /personal: dice que no tiene acceso y no intenta cargar empleados', async () => {
    // Su negocio de plataforma con el módulo encendido: no es el módulo lo que lo detiene.
    await http('PATCH', `/api/superadmin/negocios/${PLATAFORMA}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    const soporte = await sesionSoporte(C_NEG, 'Prueba Xecador C15');
    try {
      for (const [quien, cookie] of [['sesión normal', COOKIES.super], ['soporte', soporte]]) {
        let pedidasApi = 0;
        const { pagina, ctx } = await abrir(cookie, { antes: async (p) => {
          await p.setRequestInterception(true);
          p.on('request', (req) => { if (req.url().includes(EMP_C)) pedidasApi++; req.continue().catch(() => {}); });
        } });
        await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('Sin acceso'), ESPERA);
        assert.match(await textoDe(pagina, '#estado'), /Superadmin de Xabor no tiene acceso/, quien);
        assert.strictEqual(await visible(pagina, '#directorio'), false, `${quien}: nada que parezca utilizable`);
        assert.strictEqual(pedidasApi, 0, `${quien}: no pidió la lista`);
        await ctx.close();
      }
    } finally {
      await http('POST', '/api/auth/soporte/salir', { cookie: soporte });
    }
  });

  // El panel /app REAL contra el servidor REAL, con sesiones reales: lo que
  // fase-xecador-menu prueba con un servidor de juguete, aquí de punta a punta.
  // No crea pedidos: el panel no tiene nada que imprimir.
  await t('C16. panel real: solo el admin del negocio con el módulo ve y abre «Empleados»; ni el Superadmin, ni el soporte, ni con el módulo apagado o suspendido', async () => {
    let paso = 'inicio';
    const dialogos = [];
    const prohibidas = [];
    try {
    const abrirPanel = async (cookie, ruta, { ancho = 1366, alto = 768 } = {}) => {
      const ctx = await navegador.createBrowserContext();
      const pagina = await ctx.newPage();
      const pedidas = { personal: 0, api: 0 };
      pagina.on('dialog', (d) => { dialogos.push(d.message()); d.dismiss().catch(() => {}); });
      pagina.on('response', (r) => { if (r.status() === 403) prohibidas.push(new URL(r.url()).pathname); });
      pagina.on('request', (req) => {
        const u = new URL(req.url());
        if (u.pathname === '/personal') pedidas.personal++;
        if (u.pathname.startsWith('/api/personal/')) pedidas.api++;
      });
      await pagina.setViewport({ width: ancho, height: alto });
      await pagina.setCookie({ name: 'xabor_sesion', value: cookie, url: servidor.base });
      await pagina.goto(servidor.base + ruta, { waitUntil: 'domcontentloaded' });
      // El panel ya decidió la pantalla de entrada (después de /api/auth/me).
      await pagina.waitForFunction(() => typeof navTabActual !== 'undefined' && navTabActual !== null
        && !!document.querySelector('.tab-btn.activo'), { timeout: 20000 });
      return { pagina, ctx, pedidas };
    };
    const estadoMenu = (pagina) => pagina.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
      const f = document.getElementById('marco-personal');
      return { entrada: vis(document.getElementById('tab-personal')), vista: vis(document.getElementById('vista-personal')),
        src: f.getAttribute('src') || '', hash: location.hash, soporte: !!document.getElementById('barra-soporte') };
    });
    const cajon = async (cookie) => {
      const { pagina, ctx } = await abrirPanel(cookie, '/app', { ancho: 375, alto: 812 });
      await pagina.evaluate(() => abrirMasSheet());
      const items = await pagina.evaluate(() => [...document.querySelectorAll('#mas-lista .mas-item')].map((e) => e.textContent.trim()));
      await ctx.close();
      return items;
    };
    const puede = async (cookie) => (await http('GET', '/api/auth/me', { cookie })).datos?.puedeAdministrarPersonal;
    const sinAcceso = async (quien, cookie, { soporte = false } = {}) => {
      assert.strictEqual(await puede(cookie), false, `${quien}: /api/auth/me`);
      const { pagina, ctx, pedidas } = await abrirPanel(cookie, '/app#empleados');
      const e = await estadoMenu(pagina);
      assert.ok(!e.entrada && !e.vista && !e.src && e.hash !== '#empleados', `${quien}: ${JSON.stringify(e)}`);
      if (soporte) assert.ok(e.soporte, `${quien}: el panel muestra la barra de soporte`);
      await pagina.evaluate(() => { location.hash = '#empleados'; });
      await pausa(600);
      const e2 = await estadoMenu(pagina);
      assert.ok(!e2.vista && !e2.src, `${quien}, tecleando #empleados: ${JSON.stringify(e2)}`);
      assert.deepStrictEqual(pedidas, { personal: 0, api: 0 }, `${quien}: el panel pidió Empleados`);
      await ctx.close();
      assert.ok(!(await cajon(cookie)).includes('Empleados'), `${quien}: el cajón del celular trae Empleados`);
      const r = await http('GET', EMP_C, { cookie });
      assert.strictEqual(r.status, 403, `${quien}: la ruta contesta ${r.status}`);
    };

    // Precondición: módulo encendido en el negocio del admin y en el del Superadmin.
    for (const neg of [C_NEG, PLATAFORMA]) {
      await http('PATCH', `/api/superadmin/negocios/${neg}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    }
    paso = 'admin con el módulo';
    // 1) El admin del negocio: true, la ve, la abre y el directorio carga.
    assert.strictEqual(await puede(C_COOKIE), true, 'admin: /api/auth/me');
    {
      const { pagina, ctx } = await abrirPanel(C_COOKIE, '/app');
      assert.ok((await estadoMenu(pagina)).entrada, 'el admin ve Empleados');
      const grupo = await pagina.evaluate(() => {
        const sec = document.getElementById('tab-personal').closest('[id^="navsec-"]');
        return sec && sec.hidden ? sec.id.replace('navsec-', 'navgrp-') : null;
      });
      if (grupo) await pagina.click('#' + grupo);
      await pagina.click('#tab-personal');
      await pagina.waitForFunction(() => {
        const d = document.getElementById('marco-personal')?.contentDocument;
        return !!d && !!d.querySelector('#directorio:not(.oculto)') && d.querySelectorAll('#lista .emp').length > 0;
      }, { timeout: 15000 });
      const e = await estadoMenu(pagina);
      assert.ok(e.vista && e.src === '/personal' && e.hash === '#empleados', `admin al abrir: ${JSON.stringify(e)}`);
      await ctx.close();
      assert.ok((await cajon(C_COOKIE)).includes('Empleados'), 'el cajón del celular del admin trae Empleados');
    }
    paso = 'Superadmin normal';
    // 2) El Superadmin con su sesión normal (admin de su negocio, módulo encendido).
    await sinAcceso('Superadmin', COOKIES.super);
    paso = 'soporte';
    // 3) El Superadmin en sesión de soporte del mismo negocio del admin.
    const soporte = await sesionSoporte(C_NEG, 'Prueba Xecador C16');
    try {
      await sinAcceso('soporte', soporte, { soporte: true });
    } finally {
      await http('POST', '/api/auth/soporte/salir', { cookie: soporte });
    }
    paso = 'módulo apagado/suspendido';
    // 4) El admin con el módulo apagado y suspendido.
    try {
      for (const estado of ['no_configurado', 'suspendido']) {
        await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
        await sinAcceso(`admin con el módulo ${estado}`, C_COOKIE);
      }
    } finally {
      await http('PATCH', `/api/superadmin/negocios/${C_NEG}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: 'activo' } } });
    }
    assert.strictEqual(await puede(C_COOKIE), true, 'de vuelta encendido');
    // Los diálogos que el panel abrió en el camino (se cierran solos aquí).
    if (dialogos.length) console.log(`      diálogos del panel durante C16: ${JSON.stringify([...new Set(dialogos)])}`);
    if (prohibidas.length) console.log(`      403 que recibió el panel durante C16: ${JSON.stringify([...new Set(prohibidas)])}`);
    } catch (e) {
      throw new Error(`[${paso}] ${e.message} · diálogos del panel: ${JSON.stringify(dialogos)}`);
    }
  });

  // ── Parte A (migración 128) en la pantalla ───────────────────────────────
  await t('C17. alta con fecha de ingreso obligatoria, sucursal y NSS; la tarjeta avisa «Expediente incompleto» con lo que falta', async () => {
    await sucursal(C_NEG, 'Matriz C');
    const norte = await sucursal(C_NEG, 'Norte C');
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#btn-nuevo');
    await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    await pagina.$eval('#emp-numero', (el) => { el.value = '800'; });
    await pagina.type('#emp-nombre', 'Expediente Completo');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('fecha de ingreso'), ESPERA);
    assert.ok(await pagina.$('#dlg-empleado[open]'), 'sin fecha de ingreso no se da de alta');
    assert.deepStrictEqual(await pagina.$$eval('#emp-sucursal option', (os) => os.map((o) => o.textContent)), ['Sin sucursal', 'Matriz C', 'Norte C']);
    assert.strictEqual(await visible(pagina, '#emp-otras-fila'), true, 'con más de una sucursal se ofrece checar en otras');
    await ponerValor(pagina, '#emp-ingreso', '2025-05-01');
    await pagina.select('#emp-sucursal', norte);
    await pagina.click('#emp-otras');
    await pagina.type('#emp-nss', '123');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('11 dígitos'), ESPERA);
    await pagina.$eval('#emp-nss', (el) => { el.value = ''; });
    await pagina.type('#emp-nss', '123 4567 8901');
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]'), ESPERA);
    assert.deepStrictEqual(await enC(`SELECT to_char(fecha_ingreso, 'YYYY-MM-DD') f, sucursal_id, puede_checar_otras_sucursales o, nss
      FROM xecador_empleados WHERE negocio_id = $1 AND nombre = 'Expediente Completo'`), { f: '2025-05-01', sucursal_id: norte, o: true, nss: '12345678901' });
    await pagina.waitForFunction(() => [...document.querySelectorAll('#lista .emp')].some((c) => c.innerText.includes('Expediente Completo') && c.querySelector('.falta')), ESPERA);
    const tarjeta = await pagina.$$eval('#lista .emp', (cs) => cs.find((c) => c.innerText.includes('Expediente Completo')).innerText);
    assert.match(tarjeta, /Expediente incompleto: falta jornada y PIN\./);
    assert.match(tarjeta, /Norte C/, 'con varias sucursales, la tarjeta dice cuál');
    assert.match(await textoDe(pagina, '#resumen'), /con expediente incompleto/);
    assert.ok(await sinScrollHorizontal(pagina), 'sin scroll horizontal');
    await pagina.screenshot({ path: join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-incompleto-celular.png') });
    await ctx.close();
  });

  await t('C18. editar manda solo lo que cambió y la versión; si otra persona cambió el expediente, avisa y no lo pisa', async () => {
    const quien = (await http('POST', EMP_C, { cookie: C_COOKIE, cuerpo: { numero: 810, nombre: 'Editada Dos Veces', fecha_ingreso: '2025-06-01' } })).datos.empleado;
    const enviados = [];
    const { pagina, ctx } = await abrir(C_COOKIE, { antes: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (req) => { if (req.method() === 'PATCH') enviados.push(JSON.parse(req.postData() || '{}')); req.continue().catch(() => {}); });
    } });
    const editar = async () => {
      await (await (await pagina.$(`#lista .emp[data-id="${quien.id}"]`)).$$('button'))[0].click();
      await pagina.waitForSelector('#dlg-empleado[open]', ESPERA);
    };
    await pagina.waitForSelector(`#lista .emp[data-id="${quien.id}"]`, ESPERA);
    await editar();
    // Mientras tanto, otra persona le pone puesto.
    const otra = await http('PATCH', `${EMP_C}/${quien.id}`, { cookie: C_COOKIE, cuerpo: { puesto: 'Cocina', version: 1 } });
    assert.strictEqual(otra.status, 200, JSON.stringify(otra.datos));
    await pagina.$eval('#emp-nombre', (el) => { el.value = 'Editada Tres Veces'; el.dispatchEvent(new Event('input')); });
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => document.getElementById('emp-error').innerText.includes('Otra persona cambió'), ESPERA);
    assert.deepStrictEqual(enviados[0], { nombre: 'Editada Tres Veces', version: 1 }, 'solo el nombre y la versión que se abrió');
    assert.deepStrictEqual(await enC(`SELECT nombre, puesto FROM xecador_empleados WHERE negocio_id = $1 AND id = $2`, [quien.id]),
      { nombre: 'Editada Dos Veces', puesto: 'Cocina' }, 'no pisó el cambio de la otra persona');
    await pagina.click('#emp-cancelar');
    // Al volver a abrirlo trae el puesto nuevo y la versión 2: ahora sí guarda.
    await pagina.waitForFunction((id) => (document.querySelector(`#lista .emp[data-id="${id}"]`)?.innerText || '').includes('Cocina'), ESPERA, quien.id);
    await editar();
    assert.strictEqual(await pagina.$eval('#emp-puesto', (el) => el.value), 'Cocina');
    await pagina.$eval('#emp-nombre', (el) => { el.value = 'Editada Tres Veces'; el.dispatchEvent(new Event('input')); });
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]'), ESPERA);
    assert.deepStrictEqual(enviados[1], { nombre: 'Editada Tres Veces', version: 2 });
    assert.deepStrictEqual(await enC(`SELECT nombre, puesto, version FROM xecador_empleados WHERE negocio_id = $1 AND id = $2`, [quien.id]),
      { nombre: 'Editada Tres Veces', puesto: 'Cocina', version: 3 });
    // Abrir y guardar sin tocar nada no manda nada.
    await editar();
    await pagina.click('#emp-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-empleado[open]'), ESPERA);
    assert.strictEqual(enviados.length, 2, 'sin cambios no hay PATCH');
    await ctx.close();
  });

  await t('C19. jornada con un turno que cruza la medianoche y PIN que se ve una sola vez; después la tarjeta ya no pide nada', async () => {
    const norte = (await enC(`SELECT id FROM sucursales WHERE negocio_id = $1 AND nombre = 'Norte C'`)).id;
    const quien = (await http('POST', EMP_C, { cookie: C_COOKIE, cuerpo: { numero: 820, nombre: 'Turno Nocturno', fecha_ingreso: '2025-07-01', sucursal_id: norte } })).datos.empleado;
    assert.ok(quien?.id, 'precondición: el empleado');
    const { pagina, ctx } = await abrir(C_COOKIE);
    const tarjeta = () => pagina.$(`#lista .emp[data-id="${quien.id}"]`);
    const abrirJornada = async () => {
      await (await (await tarjeta()).$('button[data-accion="jornada"]')).click();
      await pagina.waitForSelector('#dlg-jornada[open]', ESPERA);
      await pagina.waitForFunction(() => !document.getElementById('jor-guardar').disabled, ESPERA);
    };
    await pagina.waitForSelector(`#lista .emp[data-id="${quien.id}"] .falta`, ESPERA);
    await abrirJornada();
    assert.match(await textoDe(pagina, '#jor-actual'), /no tiene jornada/);
    assert.strictEqual(await pagina.$eval('#jor-desde', (el) => el.value), '2025-07-01', 'la primera rige desde su ingreso');
    await pagina.select('#jor-tipo', 'mixta');
    await pagina.click('#jor-d1');
    await ponerValor(pagina, '#jor-e1', '14:00');
    await ponerValor(pagina, '#jor-s1', '22:00');
    await pagina.click('#jor-d5');
    assert.deepStrictEqual(await pagina.evaluate(() => [document.getElementById('jor-e5').value, document.getElementById('jor-s5').value]),
      ['14:00', '22:00'], 'el día que se marca toma el horario del anterior');
    await ponerValor(pagina, '#jor-s5', '02:00');
    assert.strictEqual(await visible(pagina, '#jor-c5'), true, 'avisa que termina al día siguiente');
    assert.strictEqual(await visible(pagina, '#jor-c1'), false);
    assert.ok(await pagina.$eval('#dlg-jornada', (d) => d.scrollWidth <= d.clientWidth + 1), 'el diálogo cabe a 390 px');
    await pagina.screenshot({ path: join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-jornada-celular.png') });
    await pagina.click('#jor-guardar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-jornada[open]'), ESPERA);
    const dias = (await pool.query(
      `SELECT d.dia, to_char(d.entrada, 'HH24:MI') e, to_char(d.salida, 'HH24:MI') s, j.tipo, to_char(j.vigente_desde, 'YYYY-MM-DD') v
         FROM xecador_jornadas j JOIN xecador_jornada_dias d ON d.jornada_id = j.id WHERE j.empleado_id = $1 ORDER BY d.dia`, [quien.id])).rows;
    assert.deepStrictEqual(dias, [{ dia: 1, e: '14:00', s: '22:00', tipo: 'mixta', v: '2025-07-01' }, { dia: 5, e: '14:00', s: '02:00', tipo: 'mixta', v: '2025-07-01' }]);
    await pagina.waitForFunction((id) => !(document.querySelector(`#lista .emp[data-id="${id}"] .falta`)?.innerText || '').includes('jornada'), ESPERA, quien.id);
    // Un cambio ya no puede regir hacia atrás.
    await abrirJornada();
    assert.match(await textoDe(pagina, '#jor-actual'), /Vigente: Mixta desde 1 jul 2025/);
    await ponerValor(pagina, '#jor-desde', await hoySql(-1));
    await pagina.click('#jor-guardar');
    await pagina.waitForFunction(() => document.getElementById('jor-error').innerText.includes('de hoy en adelante'), ESPERA);
    await pagina.click('#jor-cancelar');
    // PIN: se ve una vez y se borra al cerrar.
    const botonPin = await (await tarjeta()).$('button[data-accion="pin"]');
    assert.strictEqual(await botonPin.evaluate((b) => b.textContent), 'Dar PIN');
    await botonPin.click();
    await pagina.waitForSelector('#dlg-pin[open]', ESPERA);
    await pagina.click('#pin-generar');
    await pagina.waitForFunction(() => /^\d{6}$/.test(document.getElementById('pin-valor').textContent), ESPERA);
    const pin = await pagina.$eval('#pin-valor', (el) => el.textContent);
    const hash = (await q1(`SELECT pin_hash FROM xecador_empleados WHERE id = $1`, [quien.id])).pin_hash;
    assert.strictEqual(await P.verificarPin(hash, pin), true, 'el que se ve es el que quedó');
    assert.match(await textoDe(pagina, '#pin-entrega'), /No se vuelve a mostrar/);
    await pagina.screenshot({ path: join(process.env.XECADOR_CAPTURAS || tmpdir(), 'xecador-pin-celular.png') });
    await pagina.click('#pin-cancelar');   // «Listo»
    await pagina.waitForFunction(() => !document.querySelector('#dlg-pin[open]'), ESPERA);
    assert.strictEqual(await pagina.$eval('#pin-valor', (el) => el.textContent), '', 'el PIN se borró de la pantalla');
    await pagina.waitForFunction((id) => {
      const c = document.querySelector(`#lista .emp[data-id="${id}"]`);
      return c && !c.querySelector('.falta') && c.querySelector('button[data-accion="pin"]').textContent === 'Restablecer PIN';
    }, ESPERA, quien.id);
    assert.ok(!(await pagina.evaluate(() => document.documentElement.outerHTML)).includes(pin), 'el PIN no queda en ningún lado de la página');
    // El historial lo cuenta, sin el PIN.
    await (await (await tarjeta()).$$('button'))[2].click();
    await pagina.waitForFunction(() => document.querySelectorAll('#hist-lista li').length >= 3, ESPERA);
    const hist = await textoDe(pagina, '#hist-lista');
    assert.match(hist, /Mixta desde 1 jul 2025: Lun 14:00–22:00, Vie 14:00–02:00/);
    assert.match(hist, /PIN asignado de 6 dígitos/);
    assert.ok(!hist.includes(pin));
    await pagina.click('#hist-cerrar');
    await ctx.close();
  });

  await t('C20. baja desde la pantalla: pide el motivo de catálogo, «Otro» pide el detalle, la fecha efectiva queda y la tarjeta la dice', async () => {
    const quien = (await http('POST', EMP_C, { cookie: C_COOKIE, cuerpo: { numero: 830, nombre: 'Se Va Pronto', fecha_ingreso: '2025-08-01' } })).datos.empleado;
    const { pagina, ctx } = await abrir(C_COOKIE);
    await pagina.waitForSelector(`#lista .emp[data-id="${quien.id}"]`, ESPERA);
    await (await (await pagina.$(`#lista .emp[data-id="${quien.id}"]`)).$$('button'))[1].click();
    await pagina.waitForSelector('#dlg-baja[open]', ESPERA);
    const hoy = await hoySql(0), ayer = await hoySql(-1);
    assert.deepStrictEqual(await pagina.$eval('#baja-fecha', (el) => [el.value, el.max, el.min]), [hoy, hoy, '2025-08-01']);
    await pagina.click('#baja-confirmar');
    await pagina.waitForFunction(() => document.getElementById('baja-error').innerText.includes('Elige el motivo'), ESPERA);
    await pagina.select('#baja-tipo', 'otro');
    assert.strictEqual(await textoDe(pagina, '#baja-motivo-etq'), 'Detalle *');
    await pagina.click('#baja-confirmar');
    await pagina.waitForFunction(() => document.getElementById('baja-error').innerText.includes('escribe el motivo'), ESPERA);
    assert.strictEqual((await enC(`SELECT estatus FROM xecador_empleados WHERE negocio_id = $1 AND id = $2`, [quien.id])).estatus, 'activo');
    await pagina.type('#baja-motivo', 'Cambio de ciudad');
    await ponerValor(pagina, '#baja-fecha', ayer);
    await pagina.click('#baja-confirmar');
    await pagina.waitForFunction(() => !document.querySelector('#dlg-baja[open]'), ESPERA);
    assert.deepStrictEqual(await enC(`SELECT baja_tipo, to_char(baja_fecha, 'YYYY-MM-DD') f, baja_motivo FROM xecador_empleados WHERE negocio_id = $1 AND id = $2`, [quien.id]),
      { baja_tipo: 'otro', f: ayer, baja_motivo: 'Cambio de ciudad' });
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction((id) => !!document.querySelector(`#lista .emp.baja[data-id="${id}"]`), ESPERA, quien.id);
    assert.match(await pagina.$eval(`#lista .emp[data-id="${quien.id}"]`, (c) => c.innerText), /Baja: Otro, desde .* · Motivo: Cambio de ciudad/);
    await ctx.close();
  });

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
    await ponerValor(pagina, '#emp-ingreso', '2025-01-15');
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
    await pagina.select('#baja-tipo', 'renuncia');
    await pagina.click('#baja-confirmar');
    await pagina.waitForFunction(() => document.getElementById('baja-error').innerText.includes('No se pudo completar'), ESPERA);
    await pagina.click('#baja-cancelar');

    modo = 'reactivar';
    await pagina.click('#ver-bajas');
    await pagina.waitForFunction(() => document.querySelectorAll('#lista .emp.baja').length >= 1, ESPERA);
    await (await pagina.$('#lista .emp.baja button')).click();
    await pagina.waitForSelector('#dlg-reactivar[open]', ESPERA);
    assert.match(await textoDe(pagina, '#reac-texto'), /misma persona/);
    await pagina.click('#reac-confirmar');
    await pagina.waitForFunction(() => document.getElementById('reac-error').innerText.includes('Sin conexión'), ESPERA);
    await pagina.click('#reac-cancelar');
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
