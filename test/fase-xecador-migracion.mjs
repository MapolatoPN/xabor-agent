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
import { spawnSync, spawn } from 'node:child_process';
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
function predeployEnParalelo(base) {
  return new Promise((listo) => {
    const hijo = spawn(process.execPath, [PREDEPLOY], { env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' } });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('close', (codigo) => listo({ codigo, salida }));
  });
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
      (SELECT tgenabled FROM pg_trigger WHERE tgname = 'xecador_numeros_empleado_sin_truncate' AND NOT tgisinternal) AS trigger_truncate,
      to_regclass('public.xecador_empleado_eventos') IS NOT NULL AS eventos,
      (SELECT tgenabled FROM pg_trigger WHERE tgname = 'xecador_empleado_eventos_sin_cambios' AND NOT tgisinternal) AS trigger_eventos,
      (SELECT tgenabled FROM pg_trigger WHERE tgname = 'xecador_empleado_eventos_sin_truncate' AND NOT tgisinternal) AS trigger_eventos_truncate,
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
    assert.deepStrictEqual([e.empleados, e.numeros, e.pk, e.trigger, e.trigger_truncate, e.check_personal],
      [true, true, true, 'O', 'O', true]);
    assert.match(e.fk_autor, /ON DELETE RESTRICT/);
    assert.deepStrictEqual([e.eventos, e.trigger_eventos, e.trigger_eventos_truncate], [true, 'O', 'O'], 'bitácora con sus dos triggers');
    assert.strictEqual(await huella(P1), antes, 'negocio_modulos no cambió');
  });

  await t('P2. ya aplicada completa: no toca nada', async () => {
    const r = predeploy(P1);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Ya aplicada/);
  });

  await t('P3. esquema parcial (falta la tabla de empleados): la reconstruye', async () => {
    // La bitácora depende de los expedientes: un esquema a medias pierde las dos.
    await q(P1, `DROP TABLE xecador_empleado_eventos, xecador_empleados`);
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
    await q(P8, `DROP TABLE xecador_empleado_eventos, xecador_empleados`); // fuerza a que se vuelva a aplicar
    const antes = await huella(P8);
    const r = predeploy(P8);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada/);
    assert.match(r.salida, /2 negocio\(s\) con el módulo encendido \(activo\/configurado\), 1 con fila apagada/);
    assert.strictEqual(await huella(P8), antes, 'ni enciende ni apaga a nadie');
    assert.match(predeploy(P8).salida, /Ya aplicada[\s\S]*2 negocio\(s\) con el módulo encendido/);
  });

  const P10 = await copia('p10');
  await t('P10. 127 aplicada antes de la protección de TRUNCATE: el predeploy la crea y TRUNCATE ya no vacía nada', async () => {
    assert.strictEqual(predeploy(P10).codigo, 0);
    await conEmpleado(P10);
    // Así quedó una 127 aplicada con la versión anterior: sin este trigger.
    await q(P10, `DROP TRIGGER xecador_numeros_empleado_sin_truncate ON xecador_numeros_empleado`);
    const antes = await huella(P10);
    const r = predeploy(P10);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: trigger xecador_numeros_empleado_sin_truncate\)/);
    assert.strictEqual((await esquema(P10)).trigger_truncate, 'O');
    assert.strictEqual(await huella(P10), antes, 'módulos sin cambio');
    assert.match(predeploy(P10).salida, /Ya aplicada/);
    // Con CASCADE, el primero en frenar es el trigger recién creado del registro.
    await assert.rejects(q(P10, 'TRUNCATE xecador_numeros_empleado CASCADE'), /xecador_numeros_empleado es de solo inserción/);
    await assert.rejects(q(P10, 'TRUNCATE xecador_empleado_eventos, xecador_empleados, xecador_numeros_empleado'), /solo inserción/);
    assert.deepStrictEqual(await conteo(P10), { empleados: 1, numeros: 1 }, 'empleado y número siguen');
  });

  await t('P11. protección de TRUNCATE deshabilitada: lo detecta y la habilita', async () => {
    await q(P10, `ALTER TABLE xecador_numeros_empleado DISABLE TRIGGER xecador_numeros_empleado_sin_truncate`);
    const r = predeploy(P10);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_numeros_empleado_sin_truncate deshabilitado/);
    assert.strictEqual((await esquema(P10)).trigger_truncate, 'O');
    await assert.rejects(q(P10, 'TRUNCATE xecador_numeros_empleado CASCADE'), /solo inserción/);
    assert.deepStrictEqual(await conteo(P10), { empleados: 1, numeros: 1 });
  });

  await t('P12. la reparación es transaccional: si algo no se puede reparar, tampoco queda creado el trigger', async () => {
    await q(P10, `DROP TRIGGER xecador_numeros_empleado_sin_truncate ON xecador_numeros_empleado`);
    await q(P10, `ALTER TABLE xecador_numeros_empleado DROP CONSTRAINT xecador_numeros_empleado_pkey`);
    const r = predeploy(P10);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_numeros_empleado_sin_truncate/);
    assert.match(r.salida, /revisión manual/);
    const e = await esquema(P10);
    assert.strictEqual(e.trigger_truncate, null, 'nada a medias: el trigger no quedó creado');
    assert.strictEqual(e.pk, false);
    assert.deepStrictEqual(await conteo(P10), { empleados: 1, numeros: 1 });
  });

  const P13 = await copia('p13');
  await comoProduccion(P13);
  await t('P13. un cambio de módulos durante el despliegue no lo aborta en falso: el predeploy bloquea antes de leer', async () => {
    const [fila] = await q(P13, `SELECT negocio_id, modulo, estado FROM negocio_modulos ORDER BY negocio_id, modulo LIMIT 1`);
    assert.ok(fila, 'la plantilla necesita filas en negocio_modulos');
    const nuevo = fila.estado === 'activo' ? 'suspendido' : 'activo';
    // Otra sesión (como el binario viejo durante el despliegue) cambia un
    // módulo y todavía no confirma.
    const otra = new pg.Client({ connectionString: urlDe(P13), ssl });
    const vigia = new pg.Client({ connectionString: urlDe(P13), ssl });
    await otra.connect(); await vigia.connect();
    try {
      await otra.query('BEGIN');
      await otra.query(`UPDATE negocio_modulos SET estado = $3 WHERE negocio_id = $1 AND modulo = $2`, [fila.negocio_id, fila.modulo, nuevo]);
      const proceso = predeployEnParalelo(P13);
      // Se confirma el cambio cuando el predeploy ya está esperando un candado:
      // es el momento exacto en que, sin bloquear antes de leer, ya habría leído
      // las filas viejas y abortaría al compararlas.
      let esperando = false;
      for (let i = 0; i < 50 && !esperando; i++) {
        const { rows } = await vigia.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
        esperando = rows.length > 0;
        if (!esperando) await new Promise((ok) => setTimeout(ok, 50));
      }
      assert.ok(esperando, 'el predeploy nunca quedó esperando el candado');
      await otra.query('COMMIT');
      const r = await proceso;
      assert.strictEqual(r.codigo, 0, r.salida);
      assert.match(r.salida, /Aplicada/);
      assert.doesNotMatch(r.salida, /cambió módulos/);
      const [ahora] = await q(P13, `SELECT estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = $2`, [fila.negocio_id, fila.modulo]);
      assert.strictEqual(ahora.estado, nuevo, 'el cambio de la otra sesión se conservó');
    } finally {
      await otra.query('ROLLBACK').catch(() => {});
      await otra.end().catch(() => {}); await vigia.end().catch(() => {});
    }
  });

  await t('P14. 127 aplicada antes de la bitácora: el predeploy la crea y lo demás no cambia', async () => {
    const P14 = await copia('p14');
    await comoProduccion(P14);
    assert.strictEqual(predeploy(P14).codigo, 0);
    await conEmpleado(P14);
    await q(P14, `DROP TABLE xecador_empleado_eventos`);
    await q(P14, `DROP FUNCTION xecador_empleado_eventos_inmutable()`);
    const antes = await huella(P14);
    const r = predeploy(P14);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: tabla xecador_empleado_eventos\)/);
    const e = await esquema(P14);
    assert.deepStrictEqual([e.eventos, e.trigger_eventos, e.trigger_eventos_truncate], [true, 'O', 'O'], 'bitácora con sus dos triggers');
    assert.strictEqual(await huella(P14), antes, 'módulos sin cambio');
    assert.deepStrictEqual(await conteo(P14), { empleados: 1, numeros: 1 }, 'el empleado y su número siguen');
    assert.match(predeploy(P14).salida, /Ya aplicada/);
  });

  await t('P15. 127 aplicada antes del alta idempotente: el predeploy agrega la clave y lo demás no cambia', async () => {
    const P15 = await copia('p15');
    await comoProduccion(P15);
    assert.strictEqual(predeploy(P15).codigo, 0);
    await conEmpleado(P15);
    await q(P15, `ALTER TABLE xecador_empleados DROP COLUMN clave_alta`);
    const antes = await huella(P15);
    const r = predeploy(P15);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: columna xecador_empleados\.clave_alta; restricción xecador_empleados_clave_alta_unica\)/);
    const definicion = async () => (await q(P15,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'xecador_empleados_clave_alta_unica'`))[0]?.def;
    assert.strictEqual(await definicion(), 'UNIQUE (negocio_id, clave_alta)');
    assert.strictEqual(await huella(P15), antes, 'módulos sin cambio');
    assert.deepStrictEqual(await conteo(P15), { empleados: 1, numeros: 1 }, 'el empleado y su número siguen');
    // Con la columna pero sin la llave única, tampoco dice «Ya aplicada».
    await q(P15, `ALTER TABLE xecador_empleados DROP CONSTRAINT xecador_empleados_clave_alta_unica`);
    const r2 = predeploy(P15);
    assert.strictEqual(r2.codigo, 0, r2.salida);
    assert.match(r2.salida, /faltaba: restricción xecador_empleados_clave_alta_unica\)/);
    assert.strictEqual(await definicion(), 'UNIQUE (negocio_id, clave_alta)');
    assert.match(predeploy(P15).salida, /Ya aplicada/);
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
    assert.deepStrictEqual([e.empleados, e.numeros, e.eventos, e.check_personal], [false, false, false, false]);
    assert.strictEqual((await q(D4, `SELECT COUNT(*)::int n FROM negocio_modulos WHERE modulo = 'personal'`))[0].n, 0);
    assert.strictEqual(await huella(D4, { sinPersonal: true }), otros, 'los demás módulos no cambiaron');
    assert.strictEqual((await q(D4, `SELECT COUNT(*)::int n FROM pg_proc WHERE proname LIKE 'xecador%'`))[0].n, 0, 'sin funciones de Xecador');
  });

  await t('D6. y se puede volver a aplicar', async () => {
    const r = predeploy(D4);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada/);
    const e = await esquema(D4);
    assert.deepStrictEqual([e.empleados, e.numeros, e.pk, e.trigger, e.trigger_truncate, e.check_personal],
      [true, true, true, 'O', 'O', true]);
    assert.deepStrictEqual([e.eventos, e.trigger_eventos, e.trigger_eventos_truncate], [true, 'O', 'O'], 'bitácora con sus dos triggers');
  });

  await t('D7. la reversa documenta que primero se revierte el código', async () => {
    assert.match(REVERSA, /ANTES DE CORRERLA: revertir primero el código/);
    assert.match(REVERSA, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA, /^BEGIN;$/m);
    assert.match(REVERSA, /^COMMIT;$/m);
    assert.match(MIGRACION, /ON DELETE RESTRICT;/);
  });

  // ── Q. Predeploy-128 (Parte A: catálogo) y su reversa ───────────────────
  console.log('\n── Q. Predeploy-128 y su reversa');
  const PREDEPLOY_128 = join(RAIZ, 'scripts', 'predeploy-128-xecador-catalogo.mjs');
  const REVERSA_128 = readFileSync(join(RAIZ, 'migrations', '128_xecador_catalogo_down.sql'), 'utf8');
  const predeploy128 = (base) => {
    const r = spawnSync(process.execPath, [PREDEPLOY_128], {
      env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
    return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const esquema128 = async (base) => (await q(base, `SELECT
      (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xecador_empleados'
         AND column_name IN ('sucursal_id','puede_checar_otras_sucursales','fecha_ingreso','nss','baja_fecha','baja_tipo','pin_hash','pin_actualizado_at','version')) AS columnas,
      to_regclass('public.xecador_jornadas') IS NOT NULL AS jornadas,
      to_regclass('public.xecador_jornada_dias') IS NOT NULL AS dias,
      (SELECT string_agg(tgname::text || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE 'xecador_jornada%') AS triggers,
      (SELECT COUNT(*)::int FROM pg_constraint WHERE conname = 'xecador_empleados_nss_check') AS nss_check,
      (SELECT pg_get_constraintdef(oid) LIKE '%''pin''%' FROM pg_constraint WHERE conname = 'xecador_empleado_eventos_tipo_check') AS tipo_pin,
      (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'sucursales'::regclass) AS restricciones_sucursales`))[0];
  const TRIGGERS_128 = 'xecador_jornada_dias_sin_cambios:O,xecador_jornada_dias_sin_truncate:O,xecador_jornadas_sin_cambios:O,xecador_jornadas_sin_truncate:O';
  const empleado128 = async (base) => (await q(base, `SELECT nombre, numero_empleado, estatus, version, sucursal_id, fecha_ingreso, nss, pin_hash,
      baja_tipo, puede_checar_otras_sucursales FROM xecador_empleados ORDER BY id`));

  const Q1 = await copia('q1');
  await t('Q1. sin la 127: el predeploy-128 se detiene, no crea nada y sale con código distinto de cero', async () => {
    const r = predeploy128(Q1);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /necesita la 127/);
    const e = await esquema(Q1);
    assert.strictEqual(e.empleados, false);
  });

  const Q2 = await copia('q2');
  await comoProduccion(Q2);
  assert.strictEqual(predeploy(Q2).codigo, 0, 'precondición: la 127');
  await conEmpleado(Q2);
  const sucursalesAntes = (await esquema128(Q2)).restricciones_sucursales;
  await t('Q2. sobre producción con un empleado real: aplica todo, el expediente queda igual y sucursales no se toca', async () => {
    const r = predeploy128(Q2);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada: catálogo listo; 1 expediente\(s\)/);
    const e = await esquema128(Q2);
    assert.deepStrictEqual([e.columnas, e.jornadas, e.dias, e.triggers, e.nss_check, e.tipo_pin], [9, true, true, TRIGGERS_128, 1, true]);
    assert.strictEqual(e.restricciones_sucursales, sucursalesAntes, 'la 128 no agrega nada a sucursales');
    assert.deepStrictEqual(await empleado128(Q2), [{ nombre: 'Empleado real', numero_empleado: 5, estatus: 'activo', version: 1,
      sucursal_id: null, fecha_ingreso: null, nss: null, pin_hash: null, baja_tipo: null, puede_checar_otras_sucursales: false }]);
  });

  await t('Q3. ya aplicada completa: no toca nada', async () => {
    const r = predeploy128(Q2);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Ya aplicada/);
  });

  await t('Q4. a medias (sin el CHECK del NSS, un trigger deshabilitado y reglas que vivían dentro del CREATE TABLE): lo detecta y lo repara', async () => {
    await q(Q2, `ALTER TABLE xecador_empleados DROP CONSTRAINT xecador_empleados_nss_check`);
    await q(Q2, `ALTER TABLE xecador_jornadas DISABLE TRIGGER xecador_jornadas_sin_cambios`);
    // Reglas que antes vivían dentro del CREATE TABLE (y no se reponían).
    await q(Q2, `ALTER TABLE xecador_jornada_dias DROP CONSTRAINT xecador_jornada_dias_duracion`);
    await q(Q2, `ALTER TABLE xecador_jornadas DROP CONSTRAINT xecador_jornadas_empleado_fkey`);
    const r = predeploy128(Q2);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: .*xecador_empleados_nss_check/);
    assert.match(r.salida, /xecador_jornadas_sin_cambios deshabilitado/);
    const e = await esquema128(Q2);
    assert.deepStrictEqual([e.triggers, e.nss_check], [TRIGGERS_128, 1]);
    const reglas = async (base, nombres) => (await q(base,
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`, [nombres])).map((r) => r.conname);
    assert.deepStrictEqual(await reglas(Q2, ['xecador_jornada_dias_duracion', 'xecador_jornadas_empleado_fkey']),
      ['xecador_jornada_dias_duracion', 'xecador_jornadas_empleado_fkey'], 'repuestas');
    assert.match(predeploy128(Q2).salida, /Ya aplicada/);
    assert.strictEqual((await empleado128(Q2)).length, 1, 'el expediente sigue');
  });

  const Q5 = await copia('q5');
  await comoProduccion(Q5);
  assert.strictEqual(predeploy(Q5).codigo, 0, 'precondición: la 127');
  await t('Q5. sin el índice único (id, negocio_id) de sucursales: falla cerrado y no deja nada a medias', async () => {
    await q(Q5, `ALTER TABLE impresoras DROP CONSTRAINT IF EXISTS fk_impresoras_sucursal_negocio`);
    await q(Q5, `DROP INDEX idx_sucursales_id_negocio`);
    const r = predeploy128(Q5);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /idx_sucursales_id_negocio/);
    const e = await esquema128(Q5);
    assert.deepStrictEqual([e.columnas, e.jornadas], [0, false]);
  });

  await t('Q6. con la 128 aplicada, la reversa de la 127 falla cerrada (no borra a medias)', async () => {
    const D = await copia('q6');
    await comoProduccion(D);
    assert.strictEqual(predeploy(D).codigo, 0);
    assert.strictEqual(predeploy128(D).codigo, 0);
    const r = psql(D, REVERSA);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    const e = await esquema(D);
    assert.deepStrictEqual([e.empleados, e.numeros, e.eventos], [true, true, true]);
    assert.strictEqual((await esquema128(D)).jornadas, true);
  });

  await t('Q7. reversa de la 128 con datos que se perderían (una jornada o un PIN): no corre y no toca nada', async () => {
    const [emp] = await q(Q2, `SELECT id, negocio_id FROM xecador_empleados LIMIT 1`);
    await q(Q2, `UPDATE xecador_empleados SET pin_hash = 'scrypt$16384$8$1$c2Fs$aGFzaA==' WHERE id = $1`, [emp.id]);
    let r = psql(Q2, REVERSA_128);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /no corre: ya hay jornadas, PIN o datos del catálogo/);
    assert.strictEqual((await esquema128(Q2)).columnas, 9, 'nada cambió');
    // Sin el PIN pero con una jornada, tampoco.
    await q(Q2, `UPDATE xecador_empleados SET pin_hash = NULL WHERE id = $1`, [emp.id]);
    await q(Q2, `INSERT INTO xecador_jornadas (negocio_id, empleado_id, vigente_desde, tipo) VALUES ($1, $2, '2026-01-01', 'diurna')`, [emp.negocio_id, emp.id]);
    r = psql(Q2, REVERSA_128);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.strictEqual((await esquema128(Q2)).jornadas, true);
  });

  await t('Q8. reversa de la 128 sin datos nuevos: revierte limpio, el empleado sigue, y se puede volver a aplicar', async () => {
    const D = await copia('q8');
    await comoProduccion(D);
    assert.strictEqual(predeploy(D).codigo, 0);
    await conEmpleado(D);
    assert.strictEqual(predeploy128(D).codigo, 0);
    const r = psql(D, REVERSA_128);
    assert.strictEqual(r.codigo, 0, r.salida);
    const e = await esquema128(D);
    assert.deepStrictEqual([e.columnas, e.jornadas, e.dias, e.triggers, e.tipo_pin], [0, false, false, null, false]);
    assert.deepStrictEqual(await conteo(D), { empleados: 1, numeros: 1 }, 'el expediente y su número siguen');
    assert.strictEqual((await q(D, `SELECT COUNT(*)::int n FROM pg_proc WHERE proname = 'xecador_jornadas_inmutable'`))[0].n, 0);
    const again = predeploy128(D);
    assert.strictEqual(again.codigo, 0, again.salida);
    assert.match(again.salida, /Aplicada/);
    assert.match(REVERSA_128, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA_128, /ANTES DE CORRERLA: revertir primero el código/);
  });

  // ── R. Predeploy-129 (Parte B1: checadas y tablets) y su reversa ─────────
  console.log('\n── R. Predeploy-129 y su reversa');
  const PREDEPLOY_129 = join(RAIZ, 'scripts', 'predeploy-129-xecador-checadas.mjs');
  const REVERSA_129 = readFileSync(join(RAIZ, 'migrations', '129_xecador_checadas_down.sql'), 'utf8');
  const predeploy129 = (base) => {
    const r = spawnSync(process.execPath, [PREDEPLOY_129], {
      env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
    return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const esquema129 = async (base) => (await q(base, `SELECT
      to_regclass('public.xecador_checadas') IS NOT NULL AS checadas,
      to_regclass('public.xecador_dispositivos') IS NOT NULL AS dispositivos,
      to_regclass('public.xecador_avisos') IS NOT NULL AS avisos,
      (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xecador_empleados'
         AND column_name IN ('pin_fallos', 'pin_ultimo_fallo_at', 'pin_bloqueado_hasta')) AS columnas_pin,
      (SELECT string_agg(tgname::text || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE 'xecador_checada%') AS triggers`))[0];
  const TRIGGERS_129 = 'xecador_checada_fotos_sin_cambios:O,xecador_checada_fotos_sin_truncate:O,xecador_checadas_sin_cambios:O,xecador_checadas_sin_truncate:O';
  // Producción con la 127 y la 128 (y, si se pide, un empleado real).
  const con128 = async (nombre, { empleado = false } = {}) => {
    const b = await copia(nombre);
    await comoProduccion(b);
    assert.strictEqual(predeploy(b).codigo, 0, 'precondición: la 127');
    if (empleado) await conEmpleado(b);
    assert.strictEqual(predeploy128(b).codigo, 0, 'precondición: la 128');
    return b;
  };

  await t('R1. sin la 128: el predeploy-129 se detiene y no crea nada', async () => {
    const b = await copia('r1');
    await comoProduccion(b);
    assert.strictEqual(predeploy(b).codigo, 0);
    const r = predeploy129(b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /necesita la 128/);
    assert.strictEqual((await esquema129(b)).checadas, false);
  });

  const R2 = await con128('r2', { empleado: true });
  await t('R2. sobre producción con un empleado real: aplica todo y el expediente queda igual; luego «Ya aplicada»', async () => {
    const antes = await empleado128(R2);
    const r = predeploy129(R2);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada: checador listo; 1 expediente\(s\)/);
    const e = await esquema129(R2);
    assert.deepStrictEqual([e.checadas, e.dispositivos, e.avisos, e.columnas_pin, e.triggers], [true, true, true, 3, TRIGGERS_129]);
    assert.deepStrictEqual(await empleado128(R2), antes);
    assert.deepStrictEqual((await q(R2, `SELECT pin_fallos, pin_bloqueado_hasta FROM xecador_empleados`))[0], { pin_fallos: 0, pin_bloqueado_hasta: null });
    const otra = predeploy129(R2);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Ya aplicada/);
  });

  await t('R3. a medias (un trigger deshabilitado, sin CHECK, sin llaves y sin una llave primaria): lo detecta y lo repara', async () => {
    await q(R2, `ALTER TABLE xecador_checadas DISABLE TRIGGER xecador_checadas_sin_cambios`);
    await q(R2, `ALTER TABLE xecador_empleados DROP CONSTRAINT xecador_empleados_pin_fallos_check`);
    // Reglas que antes vivían dentro del CREATE TABLE, y una llave primaria.
    await q(R2, `ALTER TABLE xecador_checadas DROP CONSTRAINT xecador_checadas_dispositivo_fkey`);
    await q(R2, `ALTER TABLE xecador_checada_fotos DROP CONSTRAINT xecador_checada_fotos_mime_check`);
    await q(R2, `ALTER TABLE xecador_avisos DROP CONSTRAINT xecador_avisos_pkey`);
    const r = predeploy129(R2);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_checadas_sin_cambios deshabilitado/);
    assert.match(r.salida, /xecador_empleados_pin_fallos_check/);
    assert.strictEqual((await esquema129(R2)).triggers, TRIGGERS_129);
    const reglas = async (base, nombres) => (await q(base,
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`, [nombres])).map((r) => r.conname);
    assert.deepStrictEqual(await reglas(R2, ['xecador_checadas_dispositivo_fkey', 'xecador_checada_fotos_mime_check', 'xecador_avisos_pkey']),
      ['xecador_avisos_pkey', 'xecador_checada_fotos_mime_check', 'xecador_checadas_dispositivo_fkey'], 'repuestas');
    assert.match(predeploy129(R2).salida, /Ya aplicada/);
  });

  await t('R4. la reversa de la 129 con una checada (o una tablet) no corre y no toca nada', async () => {
    const [emp] = await q(R2, `SELECT id, negocio_id FROM xecador_empleados LIMIT 1`);
    const [suc] = await q(R2, `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, 'Sucursal R4') RETURNING id`, [emp.negocio_id]);
    const [disp] = await q(R2, `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre) VALUES ($1, $2, 'Tablet R4') RETURNING id`,
      [emp.negocio_id, suc.id]);
    let r = psql(R2, REVERSA_129);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /no corre: ya hay checadas, tablets/);
    await q(R2, `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, clave)
                 VALUES ($1, $2, $3, $4, 'entrada', gen_random_uuid())`, [emp.negocio_id, emp.id, suc.id, disp.id]);
    r = psql(R2, REVERSA_129);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    const e = await esquema129(R2);
    assert.deepStrictEqual([e.checadas, e.columnas_pin], [true, 3], 'nada cambió');
    assert.strictEqual((await q(R2, `SELECT COUNT(*)::int n FROM xecador_checadas`))[0].n, 1, 'la checada sigue');
  });

  await t('R5. la reversa de la 129 sin datos: revierte limpio, deja la 128 y el expediente, y se puede volver a aplicar', async () => {
    const b = await con128('r5', { empleado: true });
    assert.strictEqual(predeploy129(b).codigo, 0);
    const r = psql(b, REVERSA_129);
    assert.strictEqual(r.codigo, 0, r.salida);
    const e = await esquema129(b);
    assert.deepStrictEqual([e.checadas, e.dispositivos, e.avisos, e.columnas_pin, e.triggers], [false, false, false, 0, null]);
    assert.strictEqual((await esquema128(b)).columnas, 9, 'la 128 sigue');
    assert.deepStrictEqual(await conteo(b), { empleados: 1, numeros: 1 });
    assert.strictEqual((await q(b, `SELECT COUNT(*)::int n FROM pg_proc WHERE proname = 'xecador_checadas_inmutable'`))[0].n, 0);
    const otra = predeploy129(b);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Aplicada/);
    assert.match(REVERSA_129, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA_129, /ANTES DE CORRERLA: revertir primero el código/);
  });

  // ── S. Predeploy-130 (Parte B2: correcciones) y su reversa ───────────────
  console.log('\n── S. Predeploy-130 y su reversa');
  const PREDEPLOY_130 = join(RAIZ, 'scripts', 'predeploy-130-xecador-correcciones.mjs');
  const REVERSA_130 = readFileSync(join(RAIZ, 'migrations', '130_xecador_correcciones_down.sql'), 'utf8');
  const predeploy130 = (base) => {
    const r = spawnSync(process.execPath, [PREDEPLOY_130], {
      env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
    return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const esquema130 = async (base) => (await q(base, `SELECT
      to_regclass('public.xecador_correcciones') IS NOT NULL AS correcciones,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_checadas_empleado_id_key') AS llave_checadas,
      (SELECT string_agg(tgname::text || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE 'xecador_correcciones%') AS triggers`))[0];
  const TRIGGERS_130 = 'xecador_correcciones_objetivo:O,xecador_correcciones_sin_cambios:O,xecador_correcciones_sin_truncate:O';
  // Producción con la 127, 128 y 129 y una checada real.
  const con129 = async (nombre) => {
    const b = await con128(nombre, { empleado: true });
    assert.strictEqual(predeploy129(b).codigo, 0, 'precondición: la 129');
    const [emp] = await q(b, `SELECT id, negocio_id FROM xecador_empleados LIMIT 1`);
    const [suc] = await q(b, `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, 'Sucursal S') RETURNING id`, [emp.negocio_id]);
    const [disp] = await q(b, `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre) VALUES ($1, $2, 'Tablet S') RETURNING id`, [emp.negocio_id, suc.id]);
    const [c] = await q(b, `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, clave)
                            VALUES ($1, $2, $3, $4, 'entrada', gen_random_uuid()) RETURNING id`, [emp.negocio_id, emp.id, suc.id, disp.id]);
    return { b, emp, checada: c.id };
  };
  const checadasDe = async (base) => q(base, `SELECT id, tipo, hora_oficial, clave FROM xecador_checadas ORDER BY id`);

  await t('S1. sin la 129: el predeploy-130 se detiene y no crea nada', async () => {
    const b = await con128('s1');
    const r = predeploy130(b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /necesita la 129/);
    assert.strictEqual((await esquema130(b)).correcciones, false);
  });

  const S2 = await con129('s2');
  await t('S2. sobre producción con una checada real: aplica, la checada queda igual; luego «Ya aplicada»', async () => {
    const antes = await checadasDe(S2.b);
    const r = predeploy130(S2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada: correcciones listas; 1 checada\(s\) sin cambios/);
    assert.deepStrictEqual(await esquema130(S2.b), { correcciones: true, llave_checadas: true, triggers: TRIGGERS_130 });
    assert.deepStrictEqual(await checadasDe(S2.b), antes);
    const otra = predeploy130(S2.b);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Ya aplicada/);
  });

  await t('S3. a medias (trigger de objetivo deshabilitado, sin la forma, sin el motivo y sin la llave a la checada): lo detecta y lo repara', async () => {
    await q(S2.b, `ALTER TABLE xecador_correcciones DISABLE TRIGGER xecador_correcciones_objetivo`);
    await q(S2.b, `ALTER TABLE xecador_correcciones DROP CONSTRAINT xecador_correcciones_forma`);
    await q(S2.b, `ALTER TABLE xecador_correcciones DROP CONSTRAINT xecador_correcciones_checada_fkey`);
    await q(S2.b, `ALTER TABLE xecador_correcciones DROP CONSTRAINT xecador_correcciones_motivo_check`);
    const r = predeploy130(S2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_correcciones_objetivo deshabilitado/);
    assert.match(r.salida, /xecador_correcciones_forma/);
    assert.strictEqual((await esquema130(S2.b)).triggers, TRIGGERS_130);
    const reglas = async (base, nombres) => (await q(base,
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`, [nombres])).map((r) => r.conname);
    assert.deepStrictEqual(await reglas(S2.b, ['xecador_correcciones_checada_fkey', 'xecador_correcciones_forma', 'xecador_correcciones_motivo_check']),
      ['xecador_correcciones_checada_fkey', 'xecador_correcciones_forma', 'xecador_correcciones_motivo_check'], 'repuestas');
    assert.match(predeploy130(S2.b).salida, /Ya aplicada/);
  });

  await t('S4. con la 130 aplicada, la reversa de la 129 falla cerrada; la de la 130 con una corrección no corre', async () => {
    const r129 = psql(S2.b, REVERSA_129);
    assert.notStrictEqual(r129.codigo, 0, r129.salida);
    const [u] = await q(S2.b, `SELECT id FROM usuarios LIMIT 1`);
    await q(S2.b, `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_checada_id, motivo, creado_por)
                   VALUES ($1, $2, 'anular', $3, 'Prueba S4', $4)`, [S2.emp.negocio_id, S2.emp.id, S2.checada, u.id]);
    const r = psql(S2.b, REVERSA_130);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /no corre: ya hay correcciones/);
    assert.strictEqual((await esquema130(S2.b)).correcciones, true);
    assert.strictEqual((await q(S2.b, `SELECT COUNT(*)::int n FROM xecador_correcciones`))[0].n, 1, 'la corrección sigue');
  });

  await t('S5. la reversa de la 130 sin correcciones: revierte limpio, la checada sigue, y se puede volver a aplicar', async () => {
    const S5 = await con129('s5');
    assert.strictEqual(predeploy130(S5.b).codigo, 0);
    const antes = await checadasDe(S5.b);
    const r = psql(S5.b, REVERSA_130);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.deepStrictEqual(await esquema130(S5.b), { correcciones: false, llave_checadas: false, triggers: null });
    assert.deepStrictEqual(await checadasDe(S5.b), antes, 'la checada sigue igual');
    assert.strictEqual((await q(S5.b, `SELECT COUNT(*)::int n FROM pg_proc WHERE proname LIKE 'xecador_correcciones%'`))[0].n, 0);
    const otra = predeploy130(S5.b);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Aplicada/);
    assert.match(REVERSA_130, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA_130, /ANTES DE CORRERLA: revertir primero el código/);
  });

  // ── T. Predeploy-131 (Parte B3: sin conexión y «para revisar») ───────────
  console.log('\n── T. Predeploy-131 y su reversa');
  const PREDEPLOY_131 = join(RAIZ, 'scripts', 'predeploy-131-xecador-sin-conexion.mjs');
  const REVERSA_131 = readFileSync(join(RAIZ, 'migrations', '131_xecador_sin_conexion_down.sql'), 'utf8');
  const predeploy131 = (base) => {
    const r = spawnSync(process.execPath, [PREDEPLOY_131], {
      env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
    return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const esquema131 = async (base) => (await q(base, `SELECT
      (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xecador_checadas'
         AND column_name IN ('origen', 'revision', 'ip', 'sincronizada_at', 'ref_servidor', 'transcurrido_ms')) AS columnas,
      to_regclass('public.xecador_revisiones') IS NOT NULL AS revisiones,
      (SELECT string_agg(tgname::text || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE 'xecador_revisiones%') AS triggers,
      (SELECT COUNT(*)::int FROM pg_constraint WHERE conname = 'xecador_checadas_revision_check') AS regla_revision`))[0];
  const TRIGGERS_131 = 'xecador_revisiones_sin_cambios:O,xecador_revisiones_sin_truncate:O';
  const con130 = async (nombre) => {
    const x = await con129(nombre);
    assert.strictEqual(predeploy130(x.b).codigo, 0, 'precondición: la 130');
    return x;
  };

  await t('T1. sin la 130: el predeploy-131 se detiene y no crea nada', async () => {
    const x = await con129('t1');
    const r = predeploy131(x.b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /necesita la 130/);
    assert.deepStrictEqual([(await esquema131(x.b)).columnas, (await esquema131(x.b)).revisiones], [0, false]);
  });

  const T2 = await con130('t2');
  await t('T2. sobre producción con una checada real: aplica y la checada queda igual (en línea, sin marcas); luego «Ya aplicada»', async () => {
    const antes = await checadasDe(T2.b);
    const r = predeploy131(T2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /Aplicada: sin conexión lista; 1 checada\(s\) sin cambios/);
    assert.deepStrictEqual(await esquema131(T2.b), { columnas: 6, revisiones: true, triggers: TRIGGERS_131, regla_revision: 1 });
    assert.deepStrictEqual(await checadasDe(T2.b), antes);
    assert.deepStrictEqual(await q(T2.b, `SELECT origen, revision, ip FROM xecador_checadas`), [{ origen: 'en_linea', revision: [], ip: null }]);
    assert.match(predeploy131(T2.b).salida, /Ya aplicada/);
  });

  await t('T3. a medias (sin la regla de motivos y con un trigger de revisiones deshabilitado): lo detecta y lo repara', async () => {
    await q(T2.b, `ALTER TABLE xecador_checadas DROP CONSTRAINT xecador_checadas_revision_check`);
    await q(T2.b, `ALTER TABLE xecador_revisiones DISABLE TRIGGER xecador_revisiones_sin_cambios`);
    await q(T2.b, `ALTER TABLE xecador_revisiones DROP CONSTRAINT xecador_revisiones_checada_unica`);
    const r = predeploy131(T2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_checadas_revision_check/);
    assert.match(r.salida, /xecador_revisiones_sin_cambios deshabilitado/);
    assert.deepStrictEqual(await esquema131(T2.b), { columnas: 6, revisiones: true, triggers: TRIGGERS_131, regla_revision: 1 });
    assert.match(predeploy131(T2.b).salida, /Ya aplicada/);
  });

  await t('T4. la reversa de la 131 con una revisión (o una checada marcada) no corre y no toca nada', async () => {
    const [u] = await q(T2.b, `SELECT id FROM usuarios LIMIT 1`);
    await q(T2.b, `INSERT INTO xecador_revisiones (negocio_id, checada_id, revisada_por) VALUES ($1, $2, $3)`, [T2.emp.negocio_id, T2.checada, u.id]);
    const r = psql(T2.b, REVERSA_131);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /no corre: ya hay checadas sin conexión/);
    assert.deepStrictEqual([(await esquema131(T2.b)).columnas, (await esquema131(T2.b)).revisiones], [6, true]);
  });

  await t('T5. la reversa de la 131 sin datos nuevos: revierte limpio, la checada sigue, y se puede volver a aplicar', async () => {
    const x = await con130('t5');
    assert.strictEqual(predeploy131(x.b).codigo, 0);
    const antes = await checadasDe(x.b);
    const r = psql(x.b, REVERSA_131);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.deepStrictEqual(await esquema131(x.b), { columnas: 0, revisiones: false, triggers: null, regla_revision: 0 });
    assert.deepStrictEqual(await checadasDe(x.b), antes);
    const otra = predeploy131(x.b);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Aplicada/);
    assert.match(REVERSA_131, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA_131, /ANTES DE CORRERLA: revertir primero el código/);
  });

  await t('T6. el runner del Pre-Deploy aplica 127 → 128 → 129 → 130 → 131 → 132 → 134, en ese orden y una vez cada una', () => {
    const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const lista = runner.slice(runner.indexOf('const SCRIPTS = ['), runner.indexOf('];', runner.indexOf('const SCRIPTS = [')));
    const nombres = ['127-xecador-empleados', '128-xecador-catalogo', '129-xecador-checadas', '130-xecador-correcciones', '131-xecador-sin-conexion',
      '132-xecador-pin-indice', '134-xecador-cara'];
    const pos = nombres.map((n) => lista.indexOf(`'${n}'`));
    assert.ok(pos.every((p) => p > 0), `faltan en SCRIPTS: ${nombres.filter((_, i) => pos[i] < 0).join(', ')}`);
    assert.deepStrictEqual([...pos].sort((a, b) => a - b), pos, 'en orden');
    for (const n of nombres) assert.strictEqual(lista.split(`'${n}'`).length, 2, `${n} una sola vez`);
  });

  await t('T7. una 129 con la lista vieja de avisos (sin los de sin conexión) se detecta y se repone sin tocar los avisos que ya hay', async () => {
    const x = await con129('t7');
    await q(x.b, `INSERT INTO xecador_avisos (negocio_id, tipo, detalle) VALUES ($1, 'turno_sin_cerrar', '{}'::jsonb)`, [x.emp.negocio_id]);
    await q(x.b, `ALTER TABLE xecador_avisos DROP CONSTRAINT xecador_avisos_tipo_check,
                  ADD CONSTRAINT xecador_avisos_tipo_check CHECK (tipo IN ('pin_bloqueado', 'dispositivo_pausado', 'turno_sin_cerrar'))`);
    const r = predeploy129(x.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /xecador_avisos_tipo_check/);
    const [d] = await q(x.b, `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'xecador_avisos_tipo_check'`);
    assert.match(d.def, /'pin_no_valido'.*'checada_sin_empleado'/);
    assert.deepStrictEqual(await q(x.b, `SELECT tipo FROM xecador_avisos`), [{ tipo: 'turno_sin_cerrar' }]);
    assert.match(predeploy129(x.b).salida, /Ya aplicada/);
  });

  // ── U. Predeploy-132 (checar solo con el PIN: índice del PIN) ────────────
  console.log('\n── U. Predeploy-132 y su reversa');
  const PREDEPLOY_132 = join(RAIZ, 'scripts', 'predeploy-132-xecador-pin-indice.mjs');
  const REVERSA_132 = readFileSync(join(RAIZ, 'migrations', '132_xecador_pin_indice_down.sql'), 'utf8');
  const predeploy132 = (base) => {
    const r = spawnSync(process.execPath, [PREDEPLOY_132], {
      env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
    return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const esquema132 = async (base) => (await q(base, `SELECT
      (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xecador_empleados'
         AND column_name = 'pin_indice') AS columna,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'xecador_empleados_pin_indice_check') AS regla,
      (SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid = to_regclass('public.xecador_empleados_pin_indice_unico')) AS indice`))[0];
  const completa132 = (e) => {
    assert.strictEqual(e.columna, 'text');
    assert.match(e.regla || '', /pin_hash IS NOT NULL/);
    assert.match(e.regla || '', /\^\[0-9a-f\]\{8\}/);
    assert.strictEqual(e.indice,
      'CREATE UNIQUE INDEX xecador_empleados_pin_indice_unico ON public.xecador_empleados USING btree (negocio_id, pin_indice) WHERE (pin_indice IS NOT NULL)');
  };
  const NADA_132 = { columna: null, regla: null, indice: null };
  const INDICE_OK = `0123abcd.${'B'.repeat(43)}`;
  // Producción con la 127 → 131, una checada real y un PIN de antes de la 132.
  const con131 = async (nombre) => {
    const x = await con130(nombre);
    assert.strictEqual(predeploy130(x.b).codigo, 0, 'precondición: la 130');
    assert.strictEqual(predeploy131(x.b).codigo, 0, 'precondición: la 131');
    await q(x.b, `UPDATE xecador_empleados SET pin_hash = 'scrypt$16384$8$1$c2Fs$aGFzaA==', pin_actualizado_at = NOW() WHERE id = $1`, [x.emp.id]);
    return x;
  };
  const expedientes = async (base) => q(base, `SELECT id, numero_empleado, nombre, estatus, version, pin_hash, pin_actualizado_at FROM xecador_empleados ORDER BY id`);
  // Un segundo expediente del mismo negocio, copia del primero con otro número
  // (registrado, como exige la 127). Todo o nada.
  const copiarExpediente = (base, empId) => con(base, async (c) => {
    const id = randomUUID();
    const { rows: [{ cols }] } = await c.query(`SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS cols
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xecador_empleados' AND column_name NOT IN ('id', 'numero_empleado')`);
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO xecador_numeros_empleado (negocio_id, numero, empleado_id)
                     SELECT negocio_id, numero_empleado + 1000, $2 FROM xecador_empleados WHERE id = $1`, [empId, id]);
      await c.query(`INSERT INTO xecador_empleados (id, numero_empleado, ${cols})
                     SELECT $2, numero_empleado + 1000, ${cols} FROM xecador_empleados WHERE id = $1`, [empId, id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    return id;
  });

  await t('U1. sin la 131: el predeploy-132 se detiene y no crea nada', async () => {
    const x = await con130('u1');
    const r = predeploy132(x.b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /necesita la 131/);
    assert.deepStrictEqual(await esquema132(x.b), NADA_132);
  });

  const U2 = await con131('u2');
  await t('U2. sobre producción con un PIN de antes: aplica, el expediente y su PIN quedan igual (sin índice: se lo pone el primer acierto); luego «Ya aplicada»', async () => {
    const antes = await expedientes(U2.b);
    const checadas = await checadasDe(U2.b);
    const r = predeploy132(U2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: columna xecador_empleados\.pin_indice/);
    assert.match(r.salida, /Aplicada: índice del PIN listo; 1 expediente\(s\) y sus PIN sin cambios/);
    completa132(await esquema132(U2.b));
    assert.deepStrictEqual(await expedientes(U2.b), antes);
    assert.deepStrictEqual(await checadasDe(U2.b), checadas);
    assert.deepStrictEqual(await q(U2.b, `SELECT pin_indice FROM xecador_empleados`), [{ pin_indice: null }]);
    assert.match(predeploy132(U2.b).salida, /Ya aplicada/);
  });

  await t('U3. en la base: el índice lleva su formato y solo existe con PIN; no se repite en el negocio', async () => {
    await q(U2.b, `UPDATE xecador_empleados SET pin_indice = $2 WHERE id = $1`, [U2.emp.id, INDICE_OK]);
    for (const [sql, p] of [
      [`UPDATE xecador_empleados SET pin_indice = 'basura' WHERE id = $1`, [U2.emp.id]],
      [`UPDATE xecador_empleados SET pin_indice = $2 WHERE id = $1`, [U2.emp.id, `0123ABCD.${'B'.repeat(43)}`]],
      [`UPDATE xecador_empleados SET pin_hash = NULL WHERE id = $1`, [U2.emp.id]],
    ]) {
      await assert.rejects(q(U2.b, sql, p), (e) => e.code === '23514' && e.constraint === 'xecador_empleados_pin_indice_check', sql);
    }
    // Un segundo expediente del mismo negocio no puede tener el mismo índice.
    const antes = await expedientes(U2.b);
    await assert.rejects(copiarExpediente(U2.b, U2.emp.id),
      (e) => e.code === '23505' && e.constraint === 'xecador_empleados_pin_indice_unico');
    assert.deepStrictEqual(await expedientes(U2.b), antes, 'no entró');
    await q(U2.b, `UPDATE xecador_empleados SET pin_indice = NULL WHERE id = $1`, [U2.emp.id]);
  });

  await t('U4. a medias (un índice común en vez del único y una regla sin el formato): lo detecta y lo repara', async () => {
    await q(U2.b, `DROP INDEX xecador_empleados_pin_indice_unico`);
    await q(U2.b, `CREATE INDEX xecador_empleados_pin_indice_unico ON xecador_empleados (negocio_id, pin_indice)`);
    await q(U2.b, `ALTER TABLE xecador_empleados DROP CONSTRAINT xecador_empleados_pin_indice_check,
                   ADD CONSTRAINT xecador_empleados_pin_indice_check CHECK (pin_indice IS NULL OR pin_hash IS NOT NULL)`);
    const antes = await expedientes(U2.b);
    const r = predeploy132(U2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /restricción xecador_empleados_pin_indice_check/);
    assert.match(r.salida, /índice xecador_empleados_pin_indice_unico con otra definición/);
    completa132(await esquema132(U2.b));
    assert.deepStrictEqual(await expedientes(U2.b), antes);
    assert.match(predeploy132(U2.b).salida, /Ya aplicada/);
    // Sin el índice: también.
    await q(U2.b, `DROP INDEX xecador_empleados_pin_indice_unico`);
    assert.match(predeploy132(U2.b).salida, /faltaba: índice xecador_empleados_pin_indice_unico\)/);
    completa132(await esquema132(U2.b));
  });

  await t('U5. con la columna de otro tipo, o con índices repetidos: falla cerrado y no deja nada a medias', async () => {
    const x = await con131('u5');
    await q(x.b, `ALTER TABLE xecador_empleados ADD COLUMN pin_indice varchar(80)`);
    const r = predeploy132(x.b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-132\] FALLO: Tras aplicar la 132 sigue faltando: columna xecador_empleados\.pin_indice de tipo character varying/);
    assert.deepStrictEqual(await esquema132(x.b), { ...NADA_132, columna: 'character varying' }, 'ni la regla ni el índice quedan creados');
    // Dos expedientes con el mismo índice (a mano): el índice único no se puede crear; se revierte todo.
    await q(x.b, `ALTER TABLE xecador_empleados DROP COLUMN pin_indice`);
    await q(x.b, `ALTER TABLE xecador_empleados ADD COLUMN pin_indice text`);
    await q(x.b, `UPDATE xecador_empleados SET pin_indice = $2 WHERE id = $1`, [x.emp.id, INDICE_OK]);
    await copiarExpediente(x.b, x.emp.id);
    const dup = predeploy132(x.b);
    assert.notStrictEqual(dup.codigo, 0, dup.salida);
    assert.match(dup.salida, /\[predeploy-132\] FALLO: .*xecador_empleados_pin_indice_unico/);
    assert.deepStrictEqual(await esquema132(x.b), { ...NADA_132, columna: 'text' });
  });

  await t('U6. la reversa de la 132: revierte limpio (expedientes, PIN y checadas siguen) y se puede volver a aplicar', async () => {
    await q(U2.b, `UPDATE xecador_empleados SET pin_indice = $2 WHERE id = $1`, [U2.emp.id, INDICE_OK]);
    const antes = await expedientes(U2.b);
    const checadas = await checadasDe(U2.b);
    const r = psql(U2.b, REVERSA_132);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.deepStrictEqual(await esquema132(U2.b), NADA_132);
    assert.deepStrictEqual(await expedientes(U2.b), antes);
    assert.deepStrictEqual(await checadasDe(U2.b), checadas);
    const otra = predeploy132(U2.b);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Aplicada/);
    completa132(await esquema132(U2.b));
    assert.match(REVERSA_132, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA_132, /ANTES DE CORRERLA: revertir primero el código/);
  });

  // ── V. Predeploy-134 (PIN + cara) ────────────────────────────────────────
  console.log('\n── V. Predeploy-134 y su reversa');
  const PREDEPLOY_134 = join(RAIZ, 'scripts', 'predeploy-134-xecador-cara.mjs');
  const REVERSA_134 = readFileSync(join(RAIZ, 'migrations', '134_xecador_cara_down.sql'), 'utf8');
  const predeploy134 = (base) => {
    const r = spawnSync(process.execPath, [PREDEPLOY_134], {
      env: { ...process.env, DATABASE_URL: urlDe(base), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000 });
    return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const esquema134 = async (base) => (await q(base, `SELECT
      to_regclass('public.xecador_caras') IS NOT NULL AS tabla,
      (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema = 'public'
         AND ((table_name = 'xecador_empleados' AND column_name = 'consentimiento_cara_fecha')
           OR (table_name = 'xecador_config' AND column_name = 'cara_al_checar'))) AS columnas,
      (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xecador_checadas'
         AND column_name IN ('cara', 'cara_detalle', 'cara_similitud')) AS en_checadas,
      (SELECT COUNT(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('xecador_caras_consentimiento', 'xecador_empleados_cara')) AS triggers`))[0];
  const COMPLETA_134 = { tabla: true, columnas: 2, en_checadas: 3, triggers: 2 };
  const NADA_134 = { tabla: false, columnas: 0, en_checadas: 0, triggers: 0 };
  const con132 = async (nombre) => {
    const x = await con131(nombre);
    assert.strictEqual(predeploy132(x.b).codigo, 0, 'precondición: la 132');
    return x;
  };
  const cara = (base, empId) => q(base, `INSERT INTO xecador_caras (negocio_id, empleado_id, modelo, llave, vectores, muestras, foto, foto_mime)
    SELECT negocio_id, id, 'prueba-1', '0123abcd', '\\x01'::bytea, 1, '\\x01'::bytea, 'image/jpeg' FROM xecador_empleados WHERE id = $1`, [empId]);

  await t('V1. sin la 132: el predeploy-134 se detiene y no crea nada', async () => {
    const x = await con131('v1');
    const r = predeploy134(x.b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /necesita la 132/);
    assert.deepStrictEqual(await esquema134(x.b), NADA_134);
  });

  const V2 = await con132('v2');
  await t('V2. sobre producción: aplica apagada (expedientes, PIN y checadas igual; las checadas de antes, «no requerida»); luego «Ya aplicada»', async () => {
    const antes = await expedientes(V2.b);
    const checadas = await checadasDe(V2.b);
    assert.ok(checadas.length > 0, 'precondición: hay checadas');
    const r = predeploy134(V2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /faltaba: columna xecador_empleados\.consentimiento_cara_fecha/);
    assert.match(r.salida, /Aplicada: PIN \+ cara listo y apagado; 1 expediente\(s\) sin cambios/);
    assert.deepStrictEqual(await esquema134(V2.b), COMPLETA_134);
    assert.deepStrictEqual(await expedientes(V2.b), antes);
    assert.deepStrictEqual(await checadasDe(V2.b), checadas);
    assert.deepStrictEqual(await q(V2.b, `SELECT DISTINCT cara, cara_detalle, cara_similitud FROM xecador_checadas`),
      [{ cara: 'no_requerida', cara_detalle: null, cara_similitud: null }]);
    assert.deepStrictEqual(await q(V2.b, `SELECT consentimiento_cara_fecha FROM xecador_empleados`), [{ consentimiento_cara_fecha: null }]);
    assert.deepStrictEqual(await q(V2.b, `SELECT COUNT(*)::int AS n FROM xecador_config WHERE cara_al_checar <> 'apagado'`), [{ n: 0 }]);
    assert.match(predeploy134(V2.b).salida, /Ya aplicada/);
  });

  await t('V3. en la base: sin consentimiento no entra una cara; al retirarlo se borra y queda escrito', async () => {
    await assert.rejects(cara(V2.b, V2.emp.id), (e) => e.code === 'P0001');
    await q(V2.b, `UPDATE xecador_empleados SET consentimiento_cara_fecha = '2026-11-03' WHERE id = $1`, [V2.emp.id]);
    await cara(V2.b, V2.emp.id);
    await q(V2.b, `UPDATE xecador_empleados SET consentimiento_cara_fecha = NULL WHERE id = $1`, [V2.emp.id]);
    assert.deepStrictEqual(await q(V2.b, `SELECT COUNT(*)::int AS n FROM xecador_caras`), [{ n: 0 }]);
    assert.deepStrictEqual(await q(V2.b, `SELECT tipo, motivo FROM xecador_empleado_eventos WHERE empleado_id = $1 AND tipo = 'cara'`, [V2.emp.id]),
      [{ tipo: 'cara', motivo: 'Se borra al retirar el consentimiento' }]);
  });

  await t('V4. a medias (sin el trigger que borra, con la función de consentimiento vacía, sin una regla): lo detecta y lo repara', async () => {
    await q(V2.b, `DROP TRIGGER xecador_empleados_cara ON xecador_empleados`);
    await q(V2.b, `CREATE OR REPLACE FUNCTION xecador_caras_con_consentimiento() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await q(V2.b, `ALTER TABLE xecador_empleados DROP CONSTRAINT xecador_empleados_consentimiento_cara_check`);
    const antes = await expedientes(V2.b);
    const r = predeploy134(V2.b);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /restricción xecador_empleados_consentimiento_cara_check/);
    assert.match(r.salida, /función xecador_caras_con_consentimiento con otro cuerpo/);
    assert.match(r.salida, /trigger xecador_empleados_cara[;)]/);
    assert.deepStrictEqual(await esquema134(V2.b), COMPLETA_134);
    assert.deepStrictEqual(await expedientes(V2.b), antes);
    await assert.rejects(cara(V2.b, V2.emp.id), (e) => e.code === 'P0001', 'la función vuelve a exigir el consentimiento');
    assert.match(predeploy134(V2.b).salida, /Ya aplicada/);
    // Un trigger deshabilitado tampoco pasa por bueno.
    await q(V2.b, `ALTER TABLE xecador_empleados DISABLE TRIGGER xecador_empleados_cara`);
    assert.match(predeploy134(V2.b).salida, /trigger xecador_empleados_cara con otra definición/);
    assert.match(predeploy134(V2.b).salida, /Ya aplicada/);
  });

  await t('V5. con datos que la 134 no puede validar (una fecha de consentimiento imposible): falla cerrado y no deja nada a medias', async () => {
    const x = await con132('v5');
    await q(x.b, `ALTER TABLE xecador_empleados ADD COLUMN consentimiento_cara_fecha date`);
    await q(x.b, `UPDATE xecador_empleados SET consentimiento_cara_fecha = '2019-01-01' WHERE id = $1`, [x.emp.id]);
    const r = predeploy134(x.b);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-134\] FALLO: .*xecador_empleados_consentimiento_cara_check/);
    assert.deepStrictEqual(await esquema134(x.b), { ...NADA_134, columnas: 1 }, 'solo la columna que ya estaba');
  });

  await t('V6. la reversa de la 134: borra las caras y revierte limpio (expedientes, PIN y checadas siguen) y se puede volver a aplicar', async () => {
    await q(V2.b, `UPDATE xecador_empleados SET consentimiento_cara_fecha = '2026-11-03' WHERE id = $1`, [V2.emp.id]);
    await cara(V2.b, V2.emp.id);
    const antes = await expedientes(V2.b);
    const checadas = await checadasDe(V2.b);
    const r = psql(V2.b, REVERSA_134);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.deepStrictEqual(await esquema134(V2.b), { ...NADA_134, en_checadas: 3 }, 'en las checadas queda cómo salió la cara');
    assert.deepStrictEqual(await expedientes(V2.b), antes);
    assert.ok(antes[0].pin_hash, 'el PIN sigue');
    assert.deepStrictEqual(await checadasDe(V2.b), checadas);
    const otra = predeploy134(V2.b);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.match(otra.salida, /Aplicada/);
    assert.deepStrictEqual(await esquema134(V2.b), COMPLETA_134);
    assert.deepStrictEqual(await q(V2.b, `SELECT COUNT(*)::int AS n FROM xecador_caras`), [{ n: 0 }], 'la cara no vuelve');
    assert.match(REVERSA_134, /^\\set ON_ERROR_STOP on$/m);
    assert.match(REVERSA_134, /ANTES DE CORRERLA: revertir primero el código/);
  });
} finally {
  for (const base of creadas) {
    await conAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`)).catch(() => {});
  }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
