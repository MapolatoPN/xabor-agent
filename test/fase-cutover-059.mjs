// ─── El cutover de la 059, probado sobre el runner REAL ─────────────────────
//
// P0-14: `scripts/predeploy-run-032-033.mjs` es lo que Railway ejecuta como
// Pre-Deploy Command, y su array SCRIPTS es la única fuente de verdad de qué
// migra. Terminaba en `058-compras-reales`, pero el código nuevo llama a
// `nextval('folio_pedido_seq')` en CADA pedido: un deploy normal habría dejado
// binario que exige una secuencia que nadie creó, y `registrarPedido` habría
// fallado en el primer pedido del día.
//
// Por eso esta suite NO prueba `predeploy-059` aislado: ejecuta el runner
// completo, tal cual está configurado, sobre una base DESECHABLE que se crea
// como copia del esquema real y se destruye al terminar.
//
// P0-15: el cutover mixto. Durante un deploy, la versión VIEJA sigue aceptando
// pedidos con su contador en memoria mientras el predeploy ya creó la
// secuencia. Aquí se reproduce ese solape con dos allocators vivos a la vez y
// se comprueba qué pasa de verdad, sin heurísticas de margen.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import assert from 'assert';
import pkg from 'pg';

const { Pool, Client } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const BASE = process.env.DATABASE_URL;
const DESECHABLE = 'xabor_cutover_059';
const urlDesechable = BASE.replace(/\/[^/?]+(\?|$)/, `/${DESECHABLE}$1`);
const nombreOrigen = (BASE.match(/\/([^/?]+)(\?|$)/) || [])[1];
const urlAdmin = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

/** Corre el runner REAL con la base desechable, y devuelve {code, salida}. */
function correrRunnerReal(env = {}) {
  try {
    const salida = execFileSync(process.execPath,
      [join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs')],
      { cwd: RAIZ, encoding: 'utf8', timeout: 240000,
        env: { ...process.env, DATABASE_URL: urlDesechable, ...env } });
    return { code: 0, salida };
  } catch (e) {
    return { code: e.status ?? 1, salida: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

let admin = null, desechable = null;
try {
  // ── Base desechable: copia del esquema real, sin 058 ni 059 ──────────────
  admin = new Client({ connectionString: urlAdmin });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DESECHABLE}`);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [nombreOrigen]);
  await admin.query(`CREATE DATABASE ${DESECHABLE} TEMPLATE ${nombreOrigen}`);
  console.log(`[cutover-059] base desechable creada desde ${nombreOrigen}`);

  desechable = new Pool({ connectionString: urlDesechable });
  await desechable.query(`DROP TABLE IF EXISTS compras_reales CASCADE`);
  await desechable.query(`DROP SEQUENCE IF EXISTS folio_pedido_seq`);

  const hayTabla = async () => (await desechable.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_name='compras_reales'`)).rows[0].n === 1;
  const haySecuencia = async () => (await desechable.query(
    `SELECT COUNT(*)::int AS n FROM pg_class
      WHERE relkind='S' AND relname='folio_pedido_seq'`)).rows[0].n === 1;

  assert.strictEqual(await hayTabla(), false);
  assert.strictEqual(await haySecuencia(), false);

  // ═══ P0-14 — EL RUNNER REAL ══════════════════════════════════════════════
  await t('1. el runner REAL aplica 058 Y 059 y termina en exit 0', async () => {
    const r = correrRunnerReal();
    assert.strictEqual(r.code, 0,
      `el runner fallo (exit ${r.code}):\n${r.salida.slice(-1200)}`);
    assert.ok(await hayTabla(), 'el runner no dejo compras_reales');
    assert.ok(await haySecuencia(),
      'el runner NO creo folio_pedido_seq: el codigo exigiria una secuencia inexistente');
  });

  await t('2. tras el runner, reservar folio funciona contra esa base', async () => {
    // La prueba de que el deploy queda utilizable: lo mismo que hace
    // `reservarFolioPedido()` en produccion, ejecutado sobre la base migrada.
    const { rows: [r] } = await desechable.query(`SELECT nextval('folio_pedido_seq') AS n`);
    const n = Number(r.n);
    assert.ok(Number.isSafeInteger(n) && n > 0, `nextval devolvio ${r.n}`);

    const { rows: [h] } = await desechable.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)),0)::bigint AS m
         FROM pedidos WHERE folio ~ '^XAB-[0-9]+$'`);
    assert.ok(n > Number(h.m),
      `el primer folio tras el cutover (${n}) no supera el historico (${h.m})`);
  });

  await t('3. el runner es idempotente: correrlo dos veces no rompe nada', async () => {
    const r = correrRunnerReal();
    assert.strictEqual(r.code, 0, `la segunda pasada fallo:\n${r.salida.slice(-800)}`);
    assert.ok(await hayTabla());
    assert.ok(await haySecuencia());
  });

  await t('4. el array SCRIPTS del runner nombra 059 detras de 058', async () => {
    // Diente estructural contra la recaida exacta de P0-14.
    const src = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const lista = src.slice(src.indexOf('const SCRIPTS'), src.indexOf('];', src.indexOf('const SCRIPTS')));
    const i58 = lista.indexOf("'058-compras-reales'");
    const i59 = lista.indexOf("'059-folio-durable'");
    assert.ok(i58 > 0, 'el runner dejo de aplicar la 058');
    assert.ok(i59 > 0,
      'el runner NO incluye 059-folio-durable: el deploy dejaria codigo sin su secuencia');
    assert.ok(i59 > i58, '059 debe ir DESPUES de 058');
  });

  // ═══ P0-15 — CUTOVER MIXTO ═══════════════════════════════════════════════
  await t('5. OLD y NEW a la vez: el allocator viejo SÍ produce colisiones', async () => {
    // Se demuestra el riesgo real, sin suponerlo. OLD calcula su folio con
    // MAX(pedidos_activos)+1, que es exactamente lo que hacia el binario
    // anterior; NEW usa la secuencia. Si ambos escriben en la ventana del
    // deploy, OLD puede entregar un numero que NEW ya entrego, o repetir el
    // suyo mientras el tablero no cambie.
    const asignarOLD = async () => {
      const { rows: [r] } = await desechable.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)),0)+1 AS n
           FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$'`);
      return `XAB-${String(r.n).padStart(4, '0')}`;
    };
    const viejos = [await asignarOLD(), await asignarOLD(), await asignarOLD()];
    assert.strictEqual(new Set(viejos).size, 1,
      'el allocator viejo dejo de colisionar consigo mismo: revisar la premisa');
  });

  await t('6. LA BARRERA del cutover: `pedidos_activos.folio` es UNIQUE y ya existia', async () => {
    // Aqui esta la respuesta a P0-15, y no es aritmetica ni probabilistica: la
    // garantia vive en el esquema. `guardarPedidoActivo` (database.js:1859)
    // inserta con ON CONFLICT (folio) DO NOTHING ... RETURNING folio y
    // distingue insertado de conflicto; `registrarPedido` --el binario VIEJO y
    // el nuevo, porque ese codigo no cambio-- reintenta con otro candidato o
    // falla cerrado con FOLIO_NO_DISPONIBLE. Nunca adopta el pedido ajeno ni
    // devuelve exito sin fila propia.
    //
    // Por eso el solape OLD/NEW no puede producir dos pedidos con el mismo
    // folio: el segundo INSERT simplemente no crea fila.
    const { rows: [neg] } = await desechable.query(`SELECT id FROM negocios LIMIT 1`);
    const F = `XAB-C${String(Date.now()).slice(-9)}`;   // varchar(20)
    const insertar = () => desechable.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
       VALUES ($1,'nuevo','{}'::jsonb,$2)
       ON CONFLICT (folio) DO NOTHING RETURNING folio`, [F, neg.id]);

    assert.strictEqual((await insertar()).rowCount, 1, 'el fixture no creo el pedido');
    assert.strictEqual((await insertar()).rowCount, 0,
      'pedidos_activos acepto DOS filas con el mismo folio: NO hay barrera y el cutover mixto es inseguro');

    // Y el UNIQUE existe de verdad, no es solo el ON CONFLICT del INSERT.
    const { rows: [u] } = await desechable.query(
      `SELECT COUNT(*)::int AS n FROM pg_indexes
        WHERE tablename='pedidos_activos' AND indexdef LIKE '%UNIQUE%'
          AND indexdef LIKE '%(folio)%'`);
    assert.ok(u.n >= 1, 'no existe indice UNIQUE sobre pedidos_activos.folio');

    await desechable.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [F]);
  });

  await t('7. OLD durante el cutover falla CERRADO: nunca registra folio reciclado', async () => {
    // El escenario completo del solape. NEW toma folios de la secuencia; OLD
    // sigue con MAX(pedidos_activos)+1 y acaba proponiendo uno que NEW ya
    // escribio. El INSERT de OLD no crea fila -> conflicto -> su bucle pide
    // otro candidato. Lo que NO puede pasar, y es lo que se comprueba, es que
    // queden dos pedidos distintos compartiendo folio.
    const { rows: [neg] } = await desechable.query(`SELECT id FROM negocios LIMIT 1`);
    const marca = `CUT${Date.now()}`;

    const escribir = (folio, quien) => desechable.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
       VALUES ($1,'nuevo',$2::jsonb,$3)
       ON CONFLICT (folio) DO NOTHING RETURNING folio`,
      [folio, JSON.stringify({ id: folio, quien, marca }), neg.id]);

    // NEW escribe con la secuencia.
    const { rows: [s1] } = await desechable.query(`SELECT nextval('folio_pedido_seq') AS n`);
    const folioNEW = `XAB-${String(s1.n).padStart(4, '0')}`;
    assert.strictEqual((await escribir(folioNEW, 'NEW')).rowCount, 1);

    // OLD, con su allocator viejo, propone exactamente ese mismo numero.
    const { rows: [m] } = await desechable.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)),0) AS n
         FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$'`);
    const folioOLD = `XAB-${String(m.n).padStart(4, '0')}`;   // el maximo, ya tomado por NEW
    const intento = await escribir(folioOLD, 'OLD');

    if (folioOLD === folioNEW) {
      assert.strictEqual(intento.rowCount, 0,
        'OLD logro registrar un pedido sobre el folio que NEW acababa de usar');
    }

    // Sea cual sea el camino: cero folios compartidos por dos pedidos.
    const { rows: [dup] } = await desechable.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT folio FROM pedidos_activos WHERE datos->>'marca' = $1
          GROUP BY folio HAVING COUNT(*) > 1) d`, [marca]);
    assert.strictEqual(dup.n, 0, 'quedaron dos pedidos con el mismo folio tras el solape');

    await desechable.query(`DELETE FROM pedidos_activos WHERE datos->>'marca' = $1`, [marca]);
  });

  // ═══ ROLLBACK ════════════════════════════════════════════════════════════
  await t('8. el down de 059 NO dropea la secuencia por si solo', async () => {
    // La reversa anterior hacia `DROP SEQUENCE` a secas, y eso prometia algo
    // falso: con el codigo nuevo desplegado, dropear la secuencia deja al
    // generador SIN FUENTE y tumba la creacion de pedidos. No es "volver al
    // comportamiento anterior", es romperlo.
    const down = readFileSync(join(RAIZ, 'migrations', '059_folio_durable_down.sql'), 'utf8');
    const activas = down.split(String.fromCharCode(10))
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('--'));
    assert.ok(!activas.some(l => /DROP\s+SEQUENCE/i.test(l)),
      'el down vuelve a dropear la secuencia sin coordinar el codigo');

    // Y ejecutarlo es inocuo: la secuencia sigue viva.
    await desechable.query(down);
    assert.ok(await haySecuencia(),
      'ejecutar el down dejo al generador sin fuente');
  });

  await t('9. rollback real: el codigo VIEJO convive con la secuencia sin tocarla', async () => {
    // La 059 es ADITIVA: no cambia tablas, columnas ni datos. Por eso el
    // rollback soportado es revertir SOLO EL CODIGO y conservar la secuencia --
    // cero pasos de base, cero ventana de fallo. Se comprueba que el allocator
    // viejo sigue funcionando con la secuencia presente y que no la mueve.
    const { rows: [antes] } = await desechable.query(
      `SELECT last_value FROM folio_pedido_seq`);

    const { rows: [r] } = await desechable.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)),0)+1 AS n
         FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$'`);
    assert.ok(Number(r.n) > 0, 'el allocator viejo no funciona con la secuencia presente');

    const { rows: [despues] } = await desechable.query(
      `SELECT last_value FROM folio_pedido_seq`);
    assert.strictEqual(String(antes.last_value), String(despues.last_value),
      'el allocator viejo movio la secuencia: no son independientes');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  try { if (desechable) await desechable.end(); } catch { /* ya cerrado */ }
  try {
    if (admin) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`, [DESECHABLE]);
      await admin.query(`DROP DATABASE IF EXISTS ${DESECHABLE}`);
      await admin.end();
      console.log('[cutover-059] base desechable destruida');
    }
  } catch (e) { console.error('[cutover-059] no se pudo limpiar:', e.message); }
}

console.log(`\n═══ fase-cutover-059: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('Fallos: ' + fallos.join(' | ')); }
process.exit(fallidas ? 1 : 0);
