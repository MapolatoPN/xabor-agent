// ─── LA 090 LE DEVUELVE A UN CICLO VIEJO SU FECHA DE CIERRE ───────────────
//
// Prueba el SQL real contra Postgres local. Toda la suite vive dentro de una
// transacción que se revierte: ni el up ni el down pueden contaminar la base
// compartida. Se niega a arrancar contra un host remoto.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const conexion = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
const db = new pg.Client(conexion);
// Se valida lo que `pg` realmente interpretó, no solo el authority de URL:
// `?host=remoto` tiene prioridad y podía disfrazarse detrás de localhost.
const destino = db.connectionParameters;
const enRailway = ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'].some((k) => process.env[k]);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(destino.host)
    || Number(destino.port) !== 55453
    || !String(destino.database || '').startsWith('edged1')
    || process.env.NODE_ENV === 'production' || enRailway) {
  throw new Error('Esta prueba solo acepta el Postgres local desechable edged1 en :55453');
}

let pasadas = 0;
const fallos = [];
const t = async (nombre, fn) => {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

await db.connect();
const { rows: [servidor] } = await db.query(
  'SELECT current_database() AS base, inet_server_port()::int AS puerto');
if (!String(servidor.base).startsWith('edged1') || servidor.puerto !== 5432) {
  await db.end();
  throw new Error('El servidor efectivo no corresponde al Postgres local de pruebas');
}

const SQL = await readFile(new URL('../migrations/090_agente_terminado_en.sql', import.meta.url), 'utf8');
const SQL_DOWN = await readFile(new URL('../migrations/090_agente_terminado_en_down.sql', import.meta.url), 'utf8');
const hace = (h) => new Date(Date.now() - h * 3600 * 1000);
const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let NEG;
let NEG_OTRO;
let NEG_SIN_OPERACION;

/** Una conversación del agente con su estado y, si se pide, su huella en el libro. */
async function sembrar(tel, estado, cierre = null, {
  herramienta = 'confirmar_pedido', estadoOp = 'ok', aplicada = true,
  modo = 'productivo', negocioId = NEG, reserva = null,
} = {}) {
  const sessionId = `agente:${tel}`;
  const conversacionId = estado.conversacionId || sessionId;
  await db.query(
    `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
     VALUES ($1,$2,$3::jsonb,1)`,
    [negocioId, sessionId, JSON.stringify({ ...estado, conversacionId })]);
  if (cierre) {
    await db.query(
      `INSERT INTO agente_operaciones (negocio_id, conversacion_id, turno_id, operacion_clave,
         herramienta, argumentos_hash, estado, aplicada, modo, created_at, updated_at)
       VALUES ($1, $2, 't1', $3, $4, 'h', $5, $6, $7, $8, $9)`,
      [negocioId, conversacionId, `k-${negocioId}-${tel}-${Math.random()}`,
        herramienta, estadoOp, aplicada, modo, reserva || cierre, cierre]);
  }
  return sessionId;
}

const leer = async (sessionId, negocioId = NEG) => (await db.query(
  'SELECT estado FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2',
  [negocioId, sessionId])).rows[0].estado;
const leerFila = async (sessionId, negocioId = NEG) => (await db.query(
  `SELECT estado, revision, creado_at, actualizado_at
     FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2`,
  [negocioId, sessionId])).rows[0];

const HECHOS = (h) => ({
  hechos: { confirmado: false, cancelado: false, fallido: false, escalado: false, ...h },
});

const edadHoras = (iso) => (Date.now() - Date.parse(iso)) / 3600000;

try {
  await db.query('BEGIN');

  const { rows: negocios } = await db.query(
    `INSERT INTO negocios (nombre, slug)
     VALUES
       ('Relleno 090 A', 'relleno-090-a-' || substr(md5(random()::text),1,8)),
       ('Relleno 090 B', 'relleno-090-b-' || substr(md5(random()::text),1,8)),
       ('Relleno 090 C', 'relleno-090-c-' || substr(md5(random()::text),1,8))
     RETURNING id, nombre`);
  NEG = negocios.find((n) => n.nombre.endsWith('A')).id;
  NEG_OTRO = negocios.find((n) => n.nombre.endsWith('B')).id;
  NEG_SIN_OPERACION = negocios.find((n) => n.nombre.endsWith('C')).id;

  console.log('\n── A. Lo que la 090 tiene que arreglar ──');

  const cierreViejo = hace(48);
  const reservaVieja = hace(72);
  const cierreCancelado = hace(30);
  const cierreCicloPosterior = hace(18);
  const viejo = await sembrar('5210000000001',
    { ...HECHOS({ confirmado: true }), folio: 'XAB-0449',
      carrito: { items: [{ nombre: 'Chilaquiles Sencillos' }] } },
    cierreViejo, { reserva: reservaVieja });
  const cancelado = await sembrar('5210000000002', HECHOS({ cancelado: true }), cierreCancelado,
    { herramienta: 'cancelar_pedido', reserva: hace(36) });
  const telCicloPosterior = '5210000000018';
  const cicloPosterior = await sembrar(telCicloPosterior,
    { conversacionId: `agente:${telCicloPosterior}:c2`, ...HECHOS({ confirmado: true }) },
    cierreCicloPosterior);

  const primeraFoto = new Map();
  primeraFoto.set(viejo, await leerFila(viejo));
  primeraFoto.set(cancelado, await leerFila(cancelado));
  primeraFoto.set(cicloPosterior, await leerFila(cicloPosterior));

  await db.query(SQL);

  await t('A0 · la primera aplicación solo añade la fecha y no rejuvenece la fila', async () => {
    for (const [sessionId, antes] of primeraFoto) {
      const despues = await leerFila(sessionId);
      assert.equal(despues.revision, antes.revision);
      assert.equal(despues.creado_at.toISOString(), antes.creado_at.toISOString());
      assert.equal(despues.actualizado_at.toISOString(), antes.actualizado_at.toISOString());
      const sinFecha = { ...despues.estado };
      delete sinFecha.terminadoEn;
      assert.deepEqual(sinFecha, antes.estado);
    }
  });

  await t('A1 · el caso de producción: confirmado hace 2 días recupera su fecha', async () => {
    const e = await leer(viejo);
    assert.ok(e.terminadoEn, 'se quedó sin fecha: la conversación sigue muerta');
    assert.equal(e.terminadoEn, cierreViejo.toISOString(),
      'usó created_at (reserva) en vez de updated_at (cierre)');
    const horas = edadHoras(e.terminadoEn);
    assert.ok(horas > 47 && horas < 49, `la fecha no es la del cierre real (${horas.toFixed(1)} h)`);
  });

  await t('A2 · la fecha recuperada es la que hace reabrir el ciclo', async () => {
    const { cicloParaTurno } = await import('../src/mesero-agente/cicloDelAgente.js');
    const e = await leer(viejo);
    const r = cicloParaTurno({ ...e, negocioId: NEG, _actualizadoAt: new Date().toISOString() },
      'Quiero unos hotcakes para mañana a las 10');
    assert.equal(r.hechos.confirmado, false, 'el pedido del lunes sigue gobernando');
    assert.equal(r.folio, null, 'el folio viejo viajó al ciclo nuevo');
    assert.deepEqual(r.carrito.items, [], 'el carrito viejo viajó al ciclo nuevo');
  });

  await t('A3 · un cancelado también recupera la hora de cierre', async () => {
    const horas = edadHoras((await leer(cancelado)).terminadoEn);
    assert.ok(horas > 29 && horas < 31);
  });

  await t('A4 · los ciclos posteriores con sufijo :cN también se rellenan', async () => {
    assert.equal((await leer(cicloPosterior)).terminadoEn, cierreCicloPosterior.toISOString());
  });

  console.log('\n── B. Lo que NO debe tocar ──');

  const enCurso = await sembrar('5210000000003',
    { ...HECHOS({}), carrito: { items: [{ nombre: 'Café' }] } }, hace(50));
  const yaFechado = await sembrar('5210000000004',
    { ...HECHOS({ confirmado: true }), terminadoEn: '2020-01-01T00:00:00.000Z' }, hace(10));
  const sinLibro = await sembrar('5210000000005', HECHOS({ fallido: true }), null);
  const sombra = await sembrar('5210000000006', HECHOS({ confirmado: true }), hace(40),
    { modo: 'sombra' });
  const rechazada = await sembrar('5210000000007', HECHOS({ confirmado: true }), hace(40),
    { estadoOp: 'error', aplicada: false });
  const noAplicada = await sembrar('5210000000010', HECHOS({ confirmado: true }), hace(40),
    { estadoOp: 'ok', aplicada: false });
  const fallidoTrasConfirmar = await sembrar('5210000000012',
    HECHOS({ confirmado: true, fallido: true }), hace(40));
  const herramientaContraria = await sembrar('5210000000013',
    HECHOS({ confirmado: true }), hace(40), { herramienta: 'cancelar_pedido' });
  const hechosContradictorios = await sembrar('5210000000014',
    HECHOS({ confirmado: true, cancelado: true }), hace(40));
  const identidadAjena = await sembrar('5210000000015',
    { conversacionId: viejo, ...HECHOS({ confirmado: true }) }, null);

  const telCompartido = '5210000000008';
  const multiA = await sembrar(telCompartido, HECHOS({ confirmado: true }), hace(50),
    { negocioId: NEG });
  const multiB = await sembrar(telCompartido, HECHOS({ confirmado: true }), hace(2),
    { negocioId: NEG_OTRO });
  const multiSinOperacion = await sembrar(telCompartido, HECHOS({ confirmado: true }), null,
    { negocioId: NEG_SIN_OPERACION });

  await db.query(
    `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
     VALUES ($1,'comercial:5210000000009',$2::jsonb,1)`,
    [NEG, JSON.stringify({ conversacionId: `${viejo}:c1`, ...HECHOS({ confirmado: true }) })]);

  await db.query(SQL);

  await t('B1 · una conversación en curso no recibe fecha de cierre', async () => {
    const e = await leer(enCurso);
    assert.equal(e.terminadoEn, undefined, 'fechó como cerrada una conversación viva');
    assert.deepEqual(e.carrito.items, [{ nombre: 'Café' }], 'le tocó el carrito');
  });

  await t('B2 · una fecha ya escrita no se pisa', async () => {
    assert.equal((await leer(yaFechado)).terminadoEn, '2020-01-01T00:00:00.000Z');
  });

  await t('B3 · sin huella en el libro se queda como estaba', async () => {
    assert.equal((await leer(sinLibro)).terminadoEn, undefined);
  });

  await t('B4 · una operación en sombra no fecha un estado productivo', async () => {
    assert.equal((await leer(sombra)).terminadoEn, undefined);
  });

  await t('B5 · una confirmación que reventó no cuenta como cierre', async () => {
    assert.equal((await leer(rechazada)).terminadoEn, undefined);
  });

  await t('B6 · estado ok sin aplicada=true no es evidencia de cierre', async () => {
    assert.equal((await leer(noAplicada)).terminadoEn, undefined);
  });

  await t('B7 · las sesiones que no son del agente ni se miran', async () => {
    const { rows } = await db.query(
      `SELECT estado FROM conversacion_estado
        WHERE negocio_id = $1 AND session_id = 'comercial:5210000000009'`, [NEG]);
    assert.equal(rows[0].estado.terminadoEn, undefined,
      'tocó una sesión de otro namespace que casaba por conversacionId');
  });

  await t('B8 · el mismo teléfono/ciclo queda aislado por negocio', async () => {
    const a = await leer(multiA, NEG);
    const b = await leer(multiB, NEG_OTRO);
    const c = await leer(multiSinOperacion, NEG_SIN_OPERACION);
    assert.ok(edadHoras(a.terminadoEn) > 49, 'A tomó la hora reciente de B');
    assert.ok(edadHoras(b.terminadoEn) < 3, 'B tomó la hora antigua de A');
    assert.notEqual(a.terminadoEn, b.terminadoEn);
    assert.equal(c.terminadoEn, undefined, 'C recibió una fecha de otro tenant sin operación propia');
  });

  await t('B9 · fallido manda: una confirmación anterior no inventa la hora del fallo', async () => {
    assert.equal((await leer(fallidoTrasConfirmar)).terminadoEn, undefined);
  });

  await t('B10 · cada hecho exige su herramienta correspondiente', async () => {
    assert.equal((await leer(herramientaContraria)).terminadoEn, undefined);
  });

  await t('B11 · confirmado y cancelado a la vez es ambiguo y no se rellena', async () => {
    assert.equal((await leer(hechosContradictorios)).terminadoEn, undefined);
  });

  await t('B12 · una sesión no puede apropiarse del ciclo de otra del mismo negocio', async () => {
    assert.equal((await leer(identidadAjena)).terminadoEn, undefined);
  });

  console.log('\n── C. Propiedades de la migración y del rollback ──');

  await t('C1 · pasarla dos veces no cambia nada', async () => {
    const antes = (await db.query(
      `SELECT md5(string_agg(negocio_id::text || '|' || session_id || '|' || estado::text,
                            E'\n' ORDER BY negocio_id, session_id)) AS h
         FROM conversacion_estado`)).rows[0].h;
    await db.query(SQL);
    const despues = (await db.query(
      `SELECT md5(string_agg(negocio_id::text || '|' || session_id || '|' || estado::text,
                            E'\n' ORDER BY negocio_id, session_id)) AS h
         FROM conversacion_estado`)).rows[0].h;
    assert.equal(antes, despues, 'no es idempotente');
  });

  await t('C2 · no añade ni borra filas, y solo toca esa clave', async () => {
    const cierre = hace(22);
    const sessionId = await sembrar('5210000000016',
      { ...HECHOS({ confirmado: true }), carrito: { items: [{ nombre: 'Té' }] } }, cierre,
      { reserva: hace(28) });
    const [{ n: filasAntes }] = (await db.query(
      'SELECT count(*)::int AS n FROM conversacion_estado')).rows;
    const antes = await leerFila(sessionId);
    await db.query(SQL);
    const [{ n: filasDespues }] = (await db.query(
      'SELECT count(*)::int AS n FROM conversacion_estado')).rows;
    const despues = await leerFila(sessionId);
    assert.equal(filasDespues, filasAntes);
    assert.equal(despues.revision, antes.revision);
    assert.equal(despues.creado_at.toISOString(), antes.creado_at.toISOString());
    assert.equal(despues.actualizado_at.toISOString(), antes.actualizado_at.toISOString());
    assert.equal(despues.estado.terminadoEn, cierre.toISOString());
    const sinFecha = { ...despues.estado };
    delete sinFecha.terminadoEn;
    assert.deepEqual(sinFecha, antes.estado);
  });

  const esperaAdvisory = async (pid, observador) => {
    for (let intento = 0; intento < 40; intento += 1) {
      const { rows: [r] } = await observador.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
            WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
         ) AS esperando`, [pid]);
      if (r.esperando) return true;
      await espera(25);
    }
    return false;
  };

  await t('C3a · espera exactamente en el advisory lock del turno vivo', async () => {
    const tel = '5210000000011';
    const sessionId = await sembrar(tel, HECHOS({ confirmado: true }), hace(20));
    const bloqueador = new pg.Client(conexion);
    const observador = new pg.Client(conexion);
    await bloqueador.connect();
    await observador.connect();
    const { rows: [{ pid }] } = await db.query('SELECT pg_backend_pid()::int AS pid');
    const clave = `wa:${NEG}:${tel}`;
    let migracion;
    let errorMigracion;
    try {
      await bloqueador.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [clave]);
      migracion = db.query(SQL);
      assert.equal(await esperaAdvisory(pid, observador), true,
        'la 090 no esperó en el advisory lock que usa WhatsApp');
    } finally {
      await bloqueador.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [clave])
        .catch(() => {});
      await migracion?.catch((e) => { errorMigracion = e; });
      await bloqueador.end().catch(() => {});
      await observador.end().catch(() => {});
      if (errorMigracion) throw errorMigracion;
    }
    assert.ok((await leer(sessionId)).terminadoEn, 'la fecha no sobrevivió al turno serializado');
  });

  await t('C3b · también bloquea una conversación que aún no es candidata', async () => {
    const tel = '5210000000017';
    const sessionId = await sembrar(tel, HECHOS({}), null);
    const bloqueador = new pg.Client(conexion);
    const observador = new pg.Client(conexion);
    await bloqueador.connect();
    await observador.connect();
    const { rows: [{ pid }] } = await db.query('SELECT pg_backend_pid()::int AS pid');
    const clave = `wa:${NEG}:${tel}`;
    let migracion;
    let errorMigracion;
    try {
      await bloqueador.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [clave]);
      migracion = db.query(SQL);
      assert.equal(await esperaAdvisory(pid, observador), true,
        'la 090 enumeró solo terminales y dejó una transición viva sin lock');
    } finally {
      await bloqueador.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [clave])
        .catch(() => {});
      await migracion?.catch((e) => { errorMigracion = e; });
      await bloqueador.end().catch(() => {});
      await observador.end().catch(() => {});
      if (errorMigracion) throw errorMigracion;
    }
    assert.equal((await leer(sessionId)).terminadoEn, undefined);
  });

  await t('C4 · el down es no-op: nunca borra fechas que no puede atribuir', async () => {
    const huella = async () => (await db.query(
      `SELECT count(*)::int AS filas,
              md5(string_agg(negocio_id::text || '|' || session_id || '|' || estado::text,
                    E'\n' ORDER BY negocio_id, session_id)) AS h
         FROM conversacion_estado`)).rows[0];
    const antes = await huella();
    await db.query(SQL_DOWN);
    const despues = await huella();
    assert.deepEqual(despues, antes, 'el rollback destruyó estado conversacional');
    assert.equal((await leer(yaFechado)).terminadoEn, '2020-01-01T00:00:00.000Z');
  });

  await t('C5 · el runner ejecuta 090 después de sus dependencias', async () => {
    const runner = await readFile(new URL('../scripts/predeploy-run-032-033.mjs', import.meta.url), 'utf8');
    const i84 = runner.indexOf("'084-agente-operaciones'");
    const i89 = runner.indexOf("'089-configuracion-fechada'");
    const i90 = runner.indexOf("'090-agente-terminado-en'");
    assert.ok(i84 >= 0 && i89 > i84 && i90 > i89, '090 no está registrada al final del runner');
  });
} finally {
  await db.query('ROLLBACK').catch(() => {});
  if (NEG && NEG_OTRO && NEG_SIN_OPERACION) {
    const { rows: [r] } = await db.query(
      'SELECT count(*)::int AS n FROM negocios WHERE id = ANY($1::uuid[])',
      [[NEG, NEG_OTRO, NEG_SIN_OPERACION]]).catch(() => ({ rows: [{ n: -1 }] }));
    if (r.n !== 0) fallos.push('AISLAMIENTO: el ROLLBACK dejó negocios de la suite');
  }
  await db.end().catch(() => {});
}

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
