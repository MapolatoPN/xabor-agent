// XECADOR · migración 127, su predeploy y su reversa.
//
// Lo que protege:
//   1. El predeploy-127 dice "Ya aplicada" SOLO si están todas las garantías;
//      repara lo que el SQL puede reconstruir (tabla que falta, trigger,
//      llave del autor) y se detiene, sin dejar nada a medias, ante lo que no
//      (la llave primaria de una tabla que ya existe).
//   2. Nunca cambia una fila de negocio_modulos, y lo que informa sobre el
//      módulo es lo que hay en la base, no una suposición.
//   3. La reversa es todo o nada: con empleados registrados falla, con código
//      distinto de cero, y conserva empleados, números y módulos — aunque
//      quien la corra olvide -v ON_ERROR_STOP=1, y aunque falle un paso
//      posterior. Sin empleados, revierte limpio y se puede reaplicar.
//
// Cada escenario corre en su PROPIA copia de la base (CREATE DATABASE ...
// TEMPLATE), así que necesita un rol con permiso para crear bases. Solo corre
// contra Postgres local con bases cuyo nombre empieza con "test".
//
// Uso:
//   DATABASE_URL=postgresql://postgres:...@127.0.0.1:55453/test_botones_x \
//   XECADOR_PSQL="docker exec -i pg-restv2 psql -U postgres" \
//   node test/fase-xecador-migracion.mjs
//
// DATABASE_URL es la PLANTILLA: esquema de producción hasta la 126, sin
// tablas xecador_*. La suite no se conecta a ella mientras copia.
// XECADOR_PSQL: cómo invocar psql (se le agrega "-d <base>" y el SQL va por
// la entrada estándar). Sin ella se usa `psql` del PATH con la URL. Sin psql la
// suite no corre: las pruebas de la reversa no se pueden dar por buenas sin él.
import assert from 'assert';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRACION = readFileSync(join(RAIZ, 'migrations', '127_xecador_empleados.sql'), 'utf8');
const REVERSA = readFileSync(join(RAIZ, 'migrations', '127_xecador_empleados_down.sql'), 'utf8');
const PREDEPLOY = join(RAIZ, 'scripts', 'predeploy-127-xecador-empleados.mjs');

// ── Barreras ────────────────────────────────────────────────────────────────
const URL_BASE = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
const PLANTILLA = URL_BASE.pathname.slice(1);
if (!['localhost', '127.0.0.1', '::1'].includes(URL_BASE.hostname) || !PLANTILLA.startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra Postgres local con una base cuyo nombre empiece con "test".');
  process.exit(2);
}
const PSQL = (process.env.XECADOR_PSQL || '').trim().split(/\s+/).filter(Boolean);
if (!PSQL.length && spawnSync('psql', ['--version']).status !== 0) {
  console.error('ABORTO: no hay psql (define XECADOR_PSQL, p. ej. "docker exec -i pg-restv2 psql -U postgres").');
  process.exit(2);
}

const urlDe = (base) => { const u = new URL(URL_BASE); u.pathname = '/' + base; return u.toString(); };
const ssl = false; // solo local
const SUF = randomUUID().slice(0, 6);
const creadas = [];

async function conAdmin(fn) {
  const c = new pg.Client({ connectionString: urlDe('postgres'), ssl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function copia(nombre) {
  const base = `test_xecmig_${SUF}_${nombre}`;
  // TEMPLATE exige que nadie esté conectado a la plantilla; una conexión recién
  // cerrada puede tardar un instante en soltarse.
  for (let intento = 1; ; intento++) {
    try { await conAdmin((c) => c.query(`CREATE DATABASE ${base} TEMPLATE ${PLANTILLA}`)); break; }
    catch (e) {
      if (intento >= 10 || !/being accessed by other users/.test(e.message)) throw e;
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
  creadas.push(base);
  return base;
}
async function con(base, fn) {
  const c = new pg.Client({ connectionString: urlDe(base), ssl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const q = (base, sql, p) => con(base, async (c) => (await c.query(sql, p)).rows);

function predeploy(base, url = urlDe(base)) {
  const r = spawnSync(process.execPath, [PREDEPLOY], {
    env: { ...process.env, DATABASE_URL: url, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
  return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}
function psql(base, sql, extra = []) {
  const [cmd, ...args] = PSQL.length ? [...PSQL, '-d', base] : ['psql', urlDe(base)];
  const r = spawnSync(cmd, [...args, '-q', ...extra], { input: sql, encoding: 'utf8', timeout: 60000 });
  return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

// Huella de negocio_modulos, de todo o solo de lo que no es 'personal'.
const huella = async (base, { sinPersonal = false } = {}) => (await q(base,
  `SELECT COALESCE(md5(string_agg(negocio_id::text || ':' || modulo || ':' || estado, ',' ORDER BY negocio_id, modulo)), '') AS h
     FROM negocio_modulos ${sinPersonal ? "WHERE modulo <> 'personal'" : ''}`))[0].h;

async function esquema(base) {
  const [r] = await q(base, `SELECT
      to_regclass('public.xecador_empleados') IS NOT NULL AS empleados,
      to_regclass('public.xecador_numeros_empleado') IS NOT NULL AS numeros,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_numeros_empleado_pkey') AS pk,
      (SELECT tgenabled FROM pg_trigger WHERE tgname = 'xecador_numeros_empleado_sin_cambios' AND NOT tgisinternal) AS trigger,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'xecador_numeros_empleado_creado_por_fkey') AS fk_autor,
      (SELECT pg_get_constraintdef(oid) LIKE '%''personal''%' FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check') AS check_personal`);
  return r;
}

/** Como producción: el CHECK de módulos de la 051, sin 'personal' (si se puede). */
async function comoProduccion(base) {
  const [{ n }] = await q(base, `SELECT COUNT(*)::int n FROM negocio_modulos WHERE modulo = 'personal'`);
  if (n) return;
  await q(base, `ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check,
    ADD CONSTRAINT negocio_modulos_modulo_check CHECK (modulo = ANY (ARRAY['pos','usuarios','caja','menu','impresion',
    'whatsapp','voz','rappi','facturacion','rewards','chat_imagenes','chat_documentos_pdf','cotizaciones',
    'generador_cotizaciones','pagos','repartidores','asistente_comercial_cotizaciones','restaurante','tienda_online']))`);
}

async function conEmpleado(base) {
  const [neg] = await q(base, `SELECT id FROM negocios ORDER BY created_at LIMIT 1`);
  await q(base, `WITH n AS (INSERT INTO xecador_numeros_empleado (negocio_id, numero, empleado_id)
                            VALUES ($1, 5, gen_random_uuid()) RETURNING empleado_id)
                 INSERT INTO xecador_empleados (id, negocio_id, numero_empleado, nombre)
                 SELECT empleado_id, $1, 5, 'Empleado real' FROM n`, [neg.id]);
  return neg.id;
}
const conteo = async (base) => (await q(base, `SELECT
    (SELECT COUNT(*) FROM xecador_empleados)::int AS empleados,
    (SELECT COUNT(*) FROM xecador_numeros_empleado)::int AS numeros`))[0];

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

try {
  // Precondición: la plantilla no trae la 127.
  const pre = await esquema(PLANTILLA);
  if (pre.empleados || pre.numeros) {
    console.error('ABORTO: la plantilla ya tiene tablas xecador_*: tiene que ser el esquema de producción sin la 127.');
    process.exit(2);
  }

  console.log('\n── P. Predeploy-127');
  const P1 = await copia('p1');
  await comoProduccion(P1);

  await t('P1. base nueva (CHECK como producción): aplica todo, sin cambiar módulos, e informa lo que hay', async () => {
    const antes = await huella(P1);
    const r = predeploy(P1);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada/);
    assert.match(r.salida, /0 negocio\(s\) con el módulo encendido/);
    const e = await esquema(P1);
    assert.deepStrictEqual([e.empleados, e.numeros, e.pk, e.trigger, e.check_personal], [true, true, true, 'O', true]);
    assert.match(e.fk_autor, /ON DELETE RESTRICT/);
    assert.strictEqual(await huella(P1), antes, 'negocio_modulos no cambió');
  });

  await t('P2. ya aplicada completa: no toca nada', async () => {
    const r = predeploy(P1);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Ya aplicada/);
  });

  await t('P3. esquema parcial (falta la tabla de empleados): la reconstruye', async () => {
    await q(P1, `DROP TABLE xecador_empleados`);
    const r = predeploy(P1);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: tabla xecador_empleados/);
    assert.strictEqual((await esquema(P1)).empleados, true);
    assert.match(predeploy(P1).salida, /Ya aplicada/);
  });

  const P4 = await copia('p4');
  await t('P4. sin la llave primaria del registro de números: NO dice "Ya aplicada"; se detiene y revierte', async () => {
    assert.strictEqual(predeploy(P4).codigo, 0);
    await q(P4, `ALTER TABLE xecador_numeros_empleado DROP CONSTRAINT xecador_numeros_empleado_pkey`);
    const r = predeploy(P4);
    assert.notStrictEqual(r.codigo, 0, `debía fallar:\n${r.salida}`);
    assert.doesNotMatch(r.salida, /Ya aplicada/);
    assert.match(r.salida, /xecador_numeros_empleado_pkey/);
    assert.match(r.salida, /revisión manual/);
    assert.strictEqual((await esquema(P4)).pk, false, 'no dejó nada a medias');
  });

  const P5 = await copia('p5');
  await t('P5. trigger de solo inserción deshabilitado: lo detecta y lo deja habilitado', async () => {
    assert.strictEqual(predeploy(P5).codigo, 0);
    await q(P5, `ALTER TABLE xecador_numeros_empleado DISABLE TRIGGER xecador_numeros_empleado_sin_cambios`);
    const r = predeploy(P5);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_numeros_empleado_sin_cambios deshabilitado/);
    assert.strictEqual((await esquema(P5)).trigger, 'O');
    await conEmpleado(P5);
    await assert.rejects(q(P5, `DELETE FROM xecador_numeros_empleado`), /solo inserción/);
  });

  await t('P6. trigger ausente: lo vuelve a crear', async () => {
    await q(P5, `DROP TRIGGER xecador_numeros_empleado_sin_cambios ON xecador_numeros_empleado`);
    const r = predeploy(P5);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: trigger xecador_numeros_empleado_sin_cambios/);
    assert.strictEqual((await esquema(P5)).trigger, 'O');
  });

  await t('P7. la llave del autor con SET NULL (versión anterior): converge a RESTRICT', async () => {
    await q(P5, `ALTER TABLE xecador_numeros_empleado DROP CONSTRAINT xecador_numeros_empleado_creado_por_fkey,
                 ADD CONSTRAINT xecador_numeros_empleado_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE SET NULL`);
    const r = predeploy(P5);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /restricción xecador_numeros_empleado_creado_por_fkey/);
    assert.match((await esquema(P5)).fk_autor, /ON DELETE RESTRICT/);
    assert.deepStrictEqual(await conteo(P5), { empleados: 1, numeros: 1 }, 'el empleado y su número siguen');
  });

  const P8 = await copia('p8');
  await t('P8. con módulos personal ya existentes: informa el conteo REAL y no los toca', async () => {
    assert.strictEqual(predeploy(P8).codigo, 0);
    const negs = (await q(P8, `SELECT id FROM negocios ORDER BY created_at LIMIT 3`)).map((r) => r.id);
    assert.strictEqual(negs.length, 3, 'la plantilla necesita 3 negocios');
    for (const [i, estado] of ['activo', 'configurado', 'no_configurado'].entries()) {
      await q(P8, `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, 'personal', $2)
                   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $2`, [negs[i], estado]);
    }
    await q(P8, `DROP TABLE xecador_empleados`); // fuerza a que se vuelva a aplicar
    const antes = await huella(P8);
    const r = predeploy(P8);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada/);
    assert.match(r.salida, /2 negocio\(s\) con el módulo encendido \(activo\/configurado\), 1 con fila apagada/);
    assert.strictEqual(await huella(P8), antes, 'ni enciende ni apaga a nadie');
    assert.match(predeploy(P8).salida, /Ya aplicada[\s\S]*2 negocio\(s\) con el módulo encendido/);
  });

  await t('P9. base inalcanzable: falla cerrado con código distinto de cero', async () => {
    const r = predeploy(null, 'postgresql://nadie:nada@127.0.0.1:1/ninguna');
    assert.notStrictEqual(r.codigo, 0, r.salida);
  });

  console.log('\n── D. Reversa');
  const D1 = await copia('d1');
  await comoProduccion(D1);
  assert.strictEqual(predeploy(D1).codigo, 0);
  const negD1 = await conEmpleado(D1);
  await q(D1, `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, 'personal', 'activo')
               ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [negD1]);
  const huellaD1 = await huella(D1);
  const intacta = async (base, h) => {
    assert.deepStrictEqual(await conteo(base), { empleados: 1, numeros: 1 }, 'empleado y número siguen');
    assert.strictEqual(await huella(base), h, 'módulos sin cambio');
    const e = await esquema(base);
    assert.deepStrictEqual([e.empleados, e.numeros, e.check_personal], [true, true, true], 'tablas y CHECK siguen');
  };

  await t('D1. con empleados, psql SIN -v ON_ERROR_STOP: falla con código distinto de cero y no toca nada', async () => {
    const r = psql(D1, REVERSA);
    assert.notStrictEqual(r.codigo, 0, `psql terminó con 0:\n${r.salida}`);
    assert.match(r.salida, /no corre con empleados registrados/);
    await intacta(D1, huellaD1);
  });

  await t('D2. con empleados, psql con -v ON_ERROR_STOP=1: igual', async () => {
    const r = psql(D1, REVERSA, ['-v', 'ON_ERROR_STOP=1']);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    await intacta(D1, huellaD1);
  });

  await t('D3. si alguien la manda por Node (pg) en vez de psql: se rechaza entera', async () => {
    await assert.rejects(q(D1, REVERSA));
    await intacta(D1, huellaD1);
  });

  const D4 = await copia('d4');
  await comoProduccion(D4);
  assert.strictEqual(predeploy(D4).codigo, 0);
  const [negD4] = await q(D4, `SELECT id FROM negocios ORDER BY created_at LIMIT 1`);
  await q(D4, `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, 'personal', 'no_configurado')
               ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'no_configurado'`, [negD4.id]);

  await t('D4. sin empleados pero con un paso posterior que falla: todo se revierte', async () => {
    // Una vista que depende del registro hace fallar el DROP TABLE del final,
    // después del DELETE de módulos y del cambio de CHECK.
    await q(D4, `CREATE VIEW vista_prueba_xecador AS SELECT numero FROM xecador_numeros_empleado`);
    const antes = await huella(D4);
    const r = psql(D4, REVERSA);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(await huella(D4), antes, 'la fila personal sigue (el DELETE se revirtió)');
    const e = await esquema(D4);
    assert.deepStrictEqual([e.empleados, e.numeros, e.check_personal], [true, true, true], 'nada a medias');
    await q(D4, `DROP VIEW vista_prueba_xecador`);
  });

  await t('D5. sin empleados: revierte limpio (código 0) y solo quita lo de personal', async () => {
    const otros = await huella(D4, { sinPersonal: true });
    const r = psql(D4, REVERSA);
    assert.strictEqual(r.codigo, 0, r.salida);
    const e = await esquema(D4);
    assert.deepStrictEqual([e.empleados, e.numeros, e.check_personal], [false, false, false]);
    assert.strictEqual((await q(D4, `SELECT COUNT(*)::int n FROM negocio_modulos WHERE modulo = 'personal'`))[0].n, 0);
    assert.strictEqual(await huella(D4, { sinPersonal: true }), otros, 'los demás módulos no cambiaron');
    assert.strictEqual((await q(D4, `SELECT COUNT(*)::int n FROM pg_proc WHERE proname = 'xecador_numeros_empleado_inmutable'`))[0].n, 0);
  });

  await t('D6. y se puede volver a aplicar', async () => {
    const r = predeploy(D4);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada/);
    const e = await esquema(D4);
    assert.deepStrictEqual([e.empleados, e.numeros, e.pk, e.trigger, e.check_personal], [true, true, true, 'O', true]);
  });

  await t('D7. la reversa documenta que primero se revierte el código', async () => {
    assert.match(REVERSA, /ANTES DE CORRERLA: revertir primero el código/);
    assert.match(REVERSA, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA, /^BEGIN;$/m);
    assert.match(REVERSA, /^COMMIT;$/m);
    assert.match(MIGRACION, /ON DELETE RESTRICT;/);
  });
} finally {
  for (const base of creadas) {
    await conAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`)).catch(() => {});
  }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
