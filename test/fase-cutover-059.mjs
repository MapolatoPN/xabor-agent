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
import { randomUUID } from 'crypto';
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
let NEG = null;

/**
 * Reproduce el arranque del binario OLD tal cual esta en origin/main
 * (0f9e82b): `cargarPedidosDesdeDB()` llama a `obtenerMaxFolioNum()`, que hace
 * MAX sobre `pedidos_activos` Y NADA MAS, y fija `contadorPedidos = max + 1`.
 * A partir de ahi el contador vive en MEMORIA.
 */
async function arrancarOLD() {
  const { rows: [r] } = await desechable.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS INTEGER)),0) AS m
       FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$'`);
  let contador = Number(r.m) + 1;
  return {
    get contador() { return contador; },
    siguienteFolio() {
      const f = `XAB-${String(contador).padStart(4, '0')}`;
      contador++;                     // en memoria, sin volver a consultar
      return f;
    },
  };
}

/** El INSERT literal de `guardarPedidoActivo` (database.js:1859). */
async function guardarComoOLD(folio, extra = {}) {
  const r = await desechable.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
     VALUES ($1,'nuevo',$2::jsonb,$3)
     ON CONFLICT (folio) DO NOTHING
     RETURNING folio`,
    [folio, JSON.stringify({ id: folio, quien: 'OLD', ...extra }), NEG]);
  return { ok: true, insertado: r.rowCount === 1, conflicto: r.rowCount !== 1 };
}

/** Historico purgado del tablero: la condicion que hace posible el reciclaje. */
async function sembrarHistoricoPurgado() {
  await desechable.query(`DELETE FROM pedidos_activos`);
  await desechable.query(`DELETE FROM pedidos WHERE folio ~ '^XAB-00(9[0-9]|100)$'`);
  for (let n = 91; n <= 100; n++) {
    await desechable.query(
      `INSERT INTO pedidos (folio, telefono, nombre_cliente, items, total, modalidad,
                            canal, forma_pago, negocio_id, created_at)
       VALUES ($1,NULL,'X','[]'::jsonb,10,'recoger','test','efectivo',$2,NOW() - interval '30 days')`,
      [`XAB-${String(n).padStart(4, '0')}`, NEG]);
  }
  // El tablero solo llega a 90: es lo unico que OLD mira al arrancar.
  await desechable.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
     VALUES ('XAB-0090','nuevo','{}'::jsonb,$1)
     ON CONFLICT (folio) DO NOTHING`, [NEG]);
}
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
  // La barrera de la 060 tambien se retira: la base desechable se copia de la
  // local, que YA la tiene aplicada. Sin este DROP, la suite pasaria aunque el
  // runner dejara de aplicarla -- verde por la razon equivocada.
  await desechable.query(`DROP TRIGGER IF EXISTS trg_barrera_folio_historico ON pedidos_activos`);
  await desechable.query(`DROP FUNCTION IF EXISTS xabor_barrera_folio_historico()`);

  const hayTabla = async () => (await desechable.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_name='compras_reales'`)).rows[0].n === 1;
  const haySecuencia = async () => (await desechable.query(
    `SELECT COUNT(*)::int AS n FROM pg_class
      WHERE relkind='S' AND relname='folio_pedido_seq'`)).rows[0].n === 1;
  const hayBarrera = async () => (await desechable.query(
    `SELECT COUNT(*)::int AS n FROM pg_trigger
      WHERE tgname='trg_barrera_folio_historico' AND NOT tgisinternal`)).rows[0].n === 1;

  assert.strictEqual(await hayTabla(), false);
  assert.strictEqual(await haySecuencia(), false);
  assert.strictEqual(await hayBarrera(), false);

  NEG = (await desechable.query(`SELECT id FROM negocios LIMIT 1`)).rows[0].id;
  await sembrarHistoricoPurgado();

  // ═══ P0-14 — EL RUNNER REAL ══════════════════════════════════════════════
  await t('1. el runner REAL aplica 058 Y 059 y termina en exit 0', async () => {
    const r = correrRunnerReal();
    assert.strictEqual(r.code, 0,
      `el runner fallo (exit ${r.code}):\n${r.salida.slice(-1200)}`);
    assert.ok(await hayTabla(), 'el runner no dejo compras_reales');
    assert.ok(await haySecuencia(),
      'el runner NO creo folio_pedido_seq: el codigo exigiria una secuencia inexistente');
    assert.ok(await hayBarrera(),
      'el runner NO instalo la barrera de la 060: la ventana de cutover queda abierta');
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
    const i60 = lista.indexOf("'060-barrera-folio'");
    assert.ok(i58 > 0, 'el runner dejo de aplicar la 058');
    assert.ok(i59 > 0,
      'el runner NO incluye 059-folio-durable: el deploy dejaria codigo sin su secuencia');
    assert.ok(i60 > 0,
      'el runner NO incluye 060-barrera-folio: OLD podria reciclar durante el cutover');
    assert.ok(i59 > i58, '059 debe ir DESPUES de 058');
    assert.ok(i60 > i59, '060 debe ir DESPUES de 059');
  });

  // ═══ P0-15 — CUTOVER MIXTO ═══════════════════════════════════════════════
  await t('5. el allocator OLD REAL: contador capturado UNA vez al arrancar', async () => {
    // El binario de origin/main NO consulta MAX por request. Al arrancar hace
    // `obtenerMaxFolioNum()` --maximo de `pedidos_activos`-- y guarda
    // `contadorPedidos = max + 1`; despues cada pedido toma el contador y lo
    // incrementa EN MEMORIA. Modelarlo como MAX()+1 por request, como hacia la
    // version anterior de esta prueba, describe un OLD que nunca existio.
    const old = await arrancarOLD();
    assert.strictEqual(old.contador, 91,
      `OLD debia sembrarse en 91 (max activo 90) y quedo en ${old.contador}`);
    assert.strictEqual(old.siguienteFolio(), 'XAB-0091');
    assert.strictEqual(old.siguienteFolio(), 'XAB-0092',
      'el contador de OLD no avanza en memoria: no reproduce main');
  });

  await t('6. ROJO ESPERADO: OLD recicla un folio historico durante el overlap', async () => {
    // El escenario exacto del cutover:
    //   · historico: XAB-0091..0100 en `pedidos`, YA purgados del tablero;
    //   · tablero: maximo XAB-0090;
    //   · OLD arranco ANTES de la 059 -> su contador quedo en 91;
    //   · se aplica 059 -> NEW arranca por encima de todo el historico;
    //   · OLD, sin reiniciar, propone XAB-0091.
    //
    // UNIQUE(pedidos_activos.folio) NO lo bloquea: XAB-0091 no esta activo.
    // El INSERT entra y ese numero pasa a pertenecer a DOS pedidos distintos.
    const old = await arrancarOLD();

    // La 059 ya esta aplicada por los casos anteriores; se confirma el piso.
    const { rows: [s2] } = await desechable.query(
      `SELECT last_value, is_called FROM folio_pedido_seq`);
    const pisoNEW = s2.is_called ? Number(s2.last_value) + 1 : Number(s2.last_value);
    assert.ok(pisoNEW > 100, `el piso de la secuencia (${pisoNEW}) no supera el historico sembrado`);

    const folioOLD = old.siguienteFolio();          // XAB-0091
    assert.strictEqual(folioOLD, 'XAB-0091');

    // Ese folio YA existe en el historico.
    const { rows: [h] } = await desechable.query(
      `SELECT COUNT(*)::int AS n FROM pedidos WHERE folio = $1`, [folioOLD]);
    assert.strictEqual(h.n, 1, 'el fixture no dejo el folio en el historico');

    // ...y no esta en el tablero, asi que el UNIQUE no dice nada.
    const r = await guardarComoOLD(folioOLD);

    assert.strictEqual(r.insertado, false,
      `OLD registro ${folioOLD}, que ya pertenece a un pedido historico: reciclaje durante el overlap`);
    assert.strictEqual(r.conflicto, true,
      'la barrera debe presentarse como CONFLICTO para que registrarPedido reintente');
  });

  await t('7. OLD converge solo: reintenta hasta salir del rango historico', async () => {
    // La barrera no deja a OLD atascado: su bucle pide el siguiente candidato
    // igual que ante un conflicto normal. 91..100 estan tomados por el
    // historico; 101 en adelante, no. Con MAX_REINTENTOS_FOLIO = 20 le sobra.
    const old = await arrancarOLD();
    let insertado = null;
    for (let i = 0; i < 20 && !insertado; i++) {
      const f = old.siguienteFolio();
      const r = await guardarComoOLD(f);
      if (r.insertado) insertado = f;
    }
    assert.ok(insertado, 'OLD no logro ningun folio en 20 intentos: quedaria fail closed');
    assert.ok(Number(insertado.replace('XAB-', '')) > 100,
      `OLD escribio ${insertado}, dentro del rango historico`);

    // Y ningun folio historico quedo duplicado.
    const { rows: [d] } = await desechable.query(
      `SELECT COUNT(*)::int AS n FROM pedidos_activos a
        WHERE a.folio ~ '^XAB-[0-9]+$'
          AND EXISTS (SELECT 1 FROM pedidos h WHERE h.folio = a.folio)`);
    assert.strictEqual(d.n, 0, 'quedo un pedido activo sobre un folio historico');

    await desechable.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [insertado]);
  });

  await t('7b. un PROGRAMADO pre-059 legitimo SI puede activarse', async () => {
    // El riesgo de la barrera: un programado reserva su folio al crearse y lo
    // activa dias despues. Si la barrera mirara solo "ya existio este folio",
    // lo destruiria. La excepcion es explicita y esta es su prueba.
    // OJO: 'XAB-0095' esta dentro del rango historico sembrado por esta suite,
    // asi que YA pertenece a otro pedido. Ese folio NO es reutilizable ni
    // siquiera por un programado -- es el caso B de la clasificacion, y la 061
    // lo deja fail closed a proposito. Para probar la activacion LEGITIMA hace
    // falta un folio limpio y, sobre todo, la IDENTIDAD de la reserva.
    const F = `XAB-7${String(Date.now()).slice(-8)}`;
    const progId = randomUUID();
    await desechable.query(
      `INSERT INTO pedidos_programados
         (folio, datos, programado_para, negocio_id, activado, programado_id)
       VALUES ($1,$2::jsonb, NOW() - interval '1 hour', $3, FALSE, $4)
       ON CONFLICT (folio) DO NOTHING`,
      [F, JSON.stringify({ id: F, negocioId: NEG, programado_id: progId }), NEG, progId]);
    await desechable.query(
      `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, programado_id, origen)
       VALUES ($1,$2,'reserva_programado',$3,'test') ON CONFLICT (folio) DO NOTHING`,
      [F, NEG, progId]);

    // Su activacion pasa por el MISMO guardarPedidoActivo (server.js:7480), y
    // ahora tiene que PRESENTAR la identidad de su reserva.
    const r = await guardarComoOLD(F, { programado_id: progId });
    assert.strictEqual(r.insertado, true,
      'la barrera bloqueo la activacion de un pedido programado legitimo');

    // Y un pedido cualquiera con ese mismo folio NO entra.
    await desechable.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [F]);
    await desechable.query(
      `UPDATE folios_pedido_usados SET estado='reserva_programado' WHERE folio = $1`, [F]);
    const ajeno = await guardarComoOLD(F);
    assert.strictEqual(ajeno.insertado, false,
      'un pedido sin la identidad de la reserva entro por la puerta del programado');

    await desechable.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [F]);
    await desechable.query(`DELETE FROM pedidos_programados WHERE folio = $1`, [F]);
  });

  await t('7c. ...y una vez activado, ese folio deja de ser reutilizable', async () => {
    // La exencion es de un solo uso: en cuanto el programado se marca activado,
    // vuelve a regir la barrera.
    const F = `XAB-8${String(Date.now()).slice(-8)}`;
    const progId = randomUUID();
    await desechable.query(
      `INSERT INTO pedidos_programados
         (folio, datos, programado_para, negocio_id, activado, programado_id)
       VALUES ($1,'{}'::jsonb, NOW(), $2, TRUE, $3)
       ON CONFLICT (folio) DO UPDATE SET activado = TRUE`, [F, NEG, progId]);
    // El folio ya fue consumido: el ledger lo marca 'usado', no reserva.
    await desechable.query(
      `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
       VALUES ($1,$2,'usado','test') ON CONFLICT (folio) DO NOTHING`, [F, NEG]);

    const r = await guardarComoOLD(F, { programado_id: progId });
    assert.strictEqual(r.insertado, false,
      'un programado YA activado siguio exento de la barrera');

    await desechable.query(`DELETE FROM pedidos_programados WHERE folio = $1`, [F]);
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

  await t('9. ROLLBACK: el codigo VIEJO no puede reciclar mientras la barrera siga puesta', async () => {
    // El runbook anterior decia "revertir codigo y conservar la secuencia", y
    // eso NO protegia nada: OLD ignora la secuencia por completo. Lo que
    // protege el rollback es la BARRERA de la 060, que es independiente del
    // binario. Se reproduce el rollback entero: purgar el tablero alto,
    // rearrancar OLD --que vuelve a sembrarse bajo-- e intentar escribir.
    await desechable.query(`DELETE FROM pedidos_activos WHERE folio ~ '^XAB-0[1-9][0-9]{2}$'`);
    const old = await arrancarOLD();
    const f = old.siguienteFolio();
    const enHistorico = (await desechable.query(
      `SELECT COUNT(*)::int AS n FROM pedidos WHERE folio = $1`, [f])).rows[0].n;
    if (enHistorico > 0) {
      const r = await guardarComoOLD(f);
      assert.strictEqual(r.insertado, false,
        `tras el rollback, OLD reciclo ${f}: la barrera no protege el camino de vuelta`);
    }
  });

  await t('9b. la secuencia sobrevive al rollback sin que OLD la toque', async () => {
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

  await t('10. el down de 062 NO dropea sus funciones/trigger por si solo', async () => {
    // Mismo defecto que ya se cazo en la 059: un down que hace DROP a secas
    // promete "volver atras" pero en realidad rompe algo que el codigo sigue
    // necesitando. Aqui lo que se necesita es la conversion activo->programado
    // (P0-15C/E): sin ella, todo programado NUEVO -- de OLD o de NEW -- queda
    // bloqueado para siempre en su activacion.
    const down = readFileSync(
      join(RAIZ, 'migrations', '062_conversion_reserva_programada_down.sql'), 'utf8');
    const activas = down.split(String.fromCharCode(10))
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('--'));
    assert.ok(!activas.some(l => /DROP\s+(TRIGGER|FUNCTION)/i.test(l)),
      'el down vuelve a dropear la conversion sin coordinar el codigo');

    const hayFuncion = async (nombre) => (await desechable.query(
      `SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname = $1`, [nombre])).rows[0].n >= 1;
    const hayTrigger062 = async () => (await desechable.query(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgname='trg_reserva_al_retirar_activo' AND NOT tgisinternal`)).rows[0].n === 1;

    assert.ok(await hayFuncion('xabor_activo_a_programado'), 'fixture: la 062 no aplico');
    await desechable.query(down);
    assert.ok(await hayFuncion('xabor_activo_a_programado'),
      'ejecutar el down se llevo xabor_activo_a_programado');
    assert.ok(await hayFuncion('xabor_convertir_claim_a_reserva'),
      'ejecutar el down se llevo xabor_convertir_claim_a_reserva');
    assert.ok(await hayTrigger062(),
      'ejecutar el down se llevo trg_reserva_al_retirar_activo: OLD ya no puede reparar sus programados');
  });

  await t('11. ROLLBACK 062: un programado creado DESPUES del down sigue pudiendo activarse', async () => {
    // La prueba de fuego: correr el down (inocuo por el caso 10), y comprobar
    // que el flujo productivo completo -- activo -> programado -> activacion,
    // por el camino de OLD (INSERT + DELETE separados, sin conocer la 062) --
    // sigue convergiendo. Si esto fallara, el down "seguro" no lo seria.
    const F = `XAB-9${String(Date.now()).slice(-8)}`;
    await desechable.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
       VALUES ($1,'nuevo',$2::jsonb,$3)`,
      [F, JSON.stringify({ id: F, negocioId: NEG }), NEG]);

    // OLD: INSERT plano en pedidos_programados (programado_id sale del DEFAULT
    // de la columna, migracion 061) seguido de un DELETE crudo del activo --
    // exactamente `guardarPedidoProgramado` + `eliminarPedido` de origin/main.
    const { rows: [prog] } = await desechable.query(
      `INSERT INTO pedidos_programados (folio, datos, programado_para, negocio_id)
       VALUES ($1,$2::jsonb, NOW() - interval '1 hour', $3)
       RETURNING programado_id`,
      [F, JSON.stringify({ id: F, negocioId: NEG }), NEG]);
    await desechable.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [F]);

    // El trigger AFTER DELETE (que el caso 10 confirmo que sigue vivo) debio
    // mover el claim a 'reserva_programado' con la identidad del programado.
    const { rows: [claim] } = await desechable.query(
      `SELECT estado, programado_id FROM folios_pedido_usados WHERE folio = $1`, [F]);
    assert.strictEqual(claim?.estado, 'reserva_programado',
      'tras el rollback del down, OLD ya no logra reservar su programado: P0-15C reabierto');
    assert.strictEqual(claim.programado_id, prog.programado_id,
      'el claim reservado no lleva la identidad del programado correcto');

    // Y la activacion, dias despues, por el MISMO guardarPedidoActivo de OLD.
    const r = await guardarComoOLD(F, { programado_id: prog.programado_id });
    assert.strictEqual(r.insertado, true,
      'el programado creado despues del down no pudo activarse: la garantia no sobrevivio al rollback');

    await desechable.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [F]);
    await desechable.query(`DELETE FROM pedidos_programados WHERE folio = $1`, [F]);
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
