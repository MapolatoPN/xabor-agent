// Pre-Deploy Command de Railway para la 090 (fecha de cierre de un ciclo).
//
// Es la única migración de esta serie que toca el ESTADO DE CONVERSACIONES
// VIVAS. Antes de fotografiar toma el mismo lock que usa el worker de WhatsApp
// durante todo un turno. Así un turno que ya leyó una fotografía vieja termina
// primero y ninguno nuevo puede borrar el backfill después del COMMIT.
//
// La verificación es exacta: conserva una copia de cada fila agente y calcula,
// por (negocio, conversación), la fecha que puede salir del libro. Al terminar,
// cada fila debe ser idéntica a su copia salvo `terminadoEn` en ese conjunto
// preciso, con ese valor preciso. El hash adicional hace visible cualquier
// cambio en el resto del estado.
//
// Prerrequisito de rollout: el binario que escribe `terminadoEn` hacia delante
// debe estar ya desplegado y sus workers anteriores drenados. Los locks cubren
// todas las sesiones visibles y la fotografía rechaza cualquier fila visible
// que naciera fuera de ese conjunto; ningún snapshot puede bloquear una sesión
// que todavía no existe. En producción ese prerrequisito es el commit 873102c.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const huella = async () => (await db.query(
  `SELECT count(*)::int AS filas,
          COALESCE(md5(string_agg(negocio_id::text || '|' || session_id || '|'
                    || revision::text || '|' || creado_at::text || '|'
                    || actualizado_at::text || '|'
                    || (estado - 'terminadoEn')::text, E'\n'
                    ORDER BY negocio_id, session_id)), 'vacio') AS hash
     FROM conversacion_estado
    WHERE session_id LIKE 'agente:%'`)).rows[0];

const fechados = async () => (await db.query(
  `SELECT count(*) FILTER (WHERE estado->>'terminadoEn' IS NOT NULL)::int AS con,
          count(*) FILTER (WHERE estado->>'terminadoEn' IS NULL)::int     AS sin
     FROM conversacion_estado
    WHERE session_id LIKE 'agente:%'
      AND (estado->'hechos'->>'confirmado' = 'true'
        OR estado->'hechos'->>'cancelado'  = 'true'
        OR estado->'hechos'->>'fallido'    = 'true')`)).rows[0];

// Adquiere los locks en orden estable. Se vuelve a enumerar porque mientras se
// esperaba a un turno activo pudo nacer otra sesión. Si el tráfico no deja
// estabilizar el conjunto, se aborta: desplegar sin una fotografía coherente
// sería peor que conservar el build anterior.
async function bloquearConversaciones() {
  const bloqueadas = new Set();
  for (let vuelta = 0; vuelta < 5; vuelta += 1) {
    const { rows } = await db.query(
      `SELECT negocio_id::text AS negocio_id, session_id
         FROM conversacion_estado
        WHERE session_id LIKE 'agente:%'
        ORDER BY negocio_id, session_id`);
    let nuevas = 0;
    for (const fila of rows) {
      const identidad = `${fila.negocio_id}|${fila.session_id}`;
      if (bloqueadas.has(identidad)) continue;
      const telefono = fila.session_id.slice('agente:'.length);
      await db.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`wa:${fila.negocio_id}:${telefono}`]);
      bloqueadas.add(identidad);
      nuevas += 1;
    }
    if (nuevas === 0) return bloqueadas;
  }
  throw new Error('las conversaciones del agente no se estabilizaron mientras se adquirían sus locks');
}

async function fotografiar(bloqueadas) {
  await db.query(
    `CREATE TEMP TABLE predeploy_090_antes ON COMMIT DROP AS
       SELECT negocio_id, session_id, estado AS estado_antes,
              revision AS revision_antes, creado_at AS creado_at_antes,
              actualizado_at AS actualizado_at_antes
        FROM conversacion_estado
        WHERE session_id LIKE 'agente:%'`);

  const { rows: fotografiadas } = await db.query(
    'SELECT negocio_id::text AS negocio_id, session_id FROM predeploy_090_antes');
  const sinLock = fotografiadas.filter((fila) =>
    !bloqueadas.has(`${fila.negocio_id}|${fila.session_id}`));
  if (sinLock.length) {
    throw new Error(`${sinLock.length} conversación(es) nacieron fuera del conjunto bloqueado -- reintente`);
  }

  await db.query(
    `CREATE TEMP TABLE predeploy_090_esperados ON COMMIT DROP AS
       SELECT a.negocio_id, a.session_id,
              to_char(max(op.updated_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS terminado_en
         FROM predeploy_090_antes a
         JOIN agente_operaciones op
           ON op.negocio_id = a.negocio_id
          AND op.conversacion_id = a.estado_antes->>'conversacionId'
        WHERE a.estado_antes->>'terminadoEn' IS NULL
          AND COALESCE(a.estado_antes->'hechos'->>'fallido', 'false') <> 'true'
          AND (
            a.estado_antes->>'conversacionId' = a.session_id
            OR (
              left(a.estado_antes->>'conversacionId', length(a.session_id)) = a.session_id
              AND substring(a.estado_antes->>'conversacionId' FROM length(a.session_id) + 1)
                    ~ '^:c[0-9]+$'
            )
          )
          AND (
            (a.estado_antes->'hechos'->>'confirmado' = 'true'
             AND COALESCE(a.estado_antes->'hechos'->>'cancelado', 'false') <> 'true'
             AND op.herramienta = 'confirmar_pedido')
            OR
            (a.estado_antes->'hechos'->>'cancelado' = 'true'
             AND COALESCE(a.estado_antes->'hechos'->>'confirmado', 'false') <> 'true'
             AND op.herramienta = 'cancelar_pedido')
          )
          AND op.estado = 'ok'
          AND op.aplicada IS TRUE
          AND op.modo = 'productivo'
        GROUP BY a.negocio_id, a.session_id`);

  return (await db.query('SELECT count(*)::int AS n FROM predeploy_090_esperados')).rows[0].n;
}

async function diferenciasExactas() {
  const { rows: [r] } = await db.query(
    `WITH esperado AS (
       SELECT a.negocio_id, a.session_id,
              a.revision_antes, a.creado_at_antes, a.actualizado_at_antes,
              CASE WHEN e.session_id IS NULL THEN a.estado_antes
                   ELSE jsonb_set(a.estado_antes, '{terminadoEn}', to_jsonb(e.terminado_en), true)
               END AS estado_esperado
         FROM predeploy_090_antes a
         LEFT JOIN predeploy_090_esperados e
           ON e.negocio_id = a.negocio_id AND e.session_id = a.session_id
     ), actual AS (
       SELECT negocio_id, session_id, estado, revision, creado_at, actualizado_at
         FROM conversacion_estado
        WHERE session_id LIKE 'agente:%'
     )
     SELECT count(*)::int AS n
       FROM esperado e
       FULL OUTER JOIN actual a
         ON a.negocio_id = e.negocio_id AND a.session_id = e.session_id
      WHERE e.negocio_id IS NULL
         OR a.negocio_id IS NULL
         OR a.estado IS DISTINCT FROM e.estado_esperado
         OR a.revision IS DISTINCT FROM e.revision_antes
         OR a.creado_at IS DISTINCT FROM e.creado_at_antes
         OR a.actualizado_at IS DISTINCT FROM e.actualizado_at_antes`);
  return r.n;
}

async function recuperablesPendientes() {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n
       FROM conversacion_estado ce
      WHERE ce.session_id LIKE 'agente:%'
        AND ce.estado->>'terminadoEn' IS NULL
        AND COALESCE(ce.estado->'hechos'->>'fallido', 'false') <> 'true'
        AND (
          ce.estado->>'conversacionId' = ce.session_id
          OR (
            left(ce.estado->>'conversacionId', length(ce.session_id)) = ce.session_id
            AND substring(ce.estado->>'conversacionId' FROM length(ce.session_id) + 1)
                  ~ '^:c[0-9]+$'
          )
        )
        AND EXISTS (
          SELECT 1
            FROM agente_operaciones op
           WHERE op.negocio_id = ce.negocio_id
             AND op.conversacion_id = ce.estado->>'conversacionId'
             AND (
               (ce.estado->'hechos'->>'confirmado' = 'true'
                AND COALESCE(ce.estado->'hechos'->>'cancelado', 'false') <> 'true'
                AND op.herramienta = 'confirmar_pedido')
               OR
               (ce.estado->'hechos'->>'cancelado' = 'true'
                AND COALESCE(ce.estado->'hechos'->>'confirmado', 'false') <> 'true'
                AND op.herramienta = 'cancelar_pedido')
             )
             AND op.estado = 'ok'
             AND op.aplicada IS TRUE
             AND op.modo = 'productivo'
        )`);
  return r.n;
}

async function validarPrecondiciones() {
  const { rows: [r] } = await db.query(
    `SELECT
       count(*) FILTER (
         WHERE estado->>'terminadoEn' IS NULL
           AND COALESCE(estado->'hechos'->>'fallido', 'false') <> 'true'
           AND estado->'hechos'->>'confirmado' = 'true'
           AND estado->'hechos'->>'cancelado' = 'true')::int AS hechos_ambiguos,
       count(*) FILTER (
         WHERE estado->>'terminadoEn' IS NOT NULL
           AND estado->>'terminadoEn' !~
             '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$')::int
         AS fechas_invalidas,
       count(*) FILTER (
         WHERE estado->>'terminadoEn' IS NULL
           AND COALESCE(estado->'hechos'->>'fallido', 'false') <> 'true'
           AND (estado->'hechos'->>'confirmado' = 'true'
             OR estado->'hechos'->>'cancelado' = 'true')
           AND NOT COALESCE((
             estado->>'conversacionId' = session_id
             OR (
               left(estado->>'conversacionId', length(session_id)) = session_id
               AND substring(estado->>'conversacionId' FROM length(session_id) + 1)
                     ~ '^:c[0-9]+$'
             )), false))::int AS identidades_invalidas,
       count(*) FILTER (
         WHERE estado->>'terminadoEn' IS NULL
           AND estado->'hechos'->>'fallido' = 'true')::int AS fallidos_legacy
       FROM conversacion_estado
      WHERE session_id LIKE 'agente:%'`);

  if (r.hechos_ambiguos) {
    throw new Error(`${r.hechos_ambiguos} estado(s) tienen confirmado y cancelado a la vez -- se aborta`);
  }
  if (r.fechas_invalidas) {
    throw new Error(`${r.fechas_invalidas} estado(s) tienen terminadoEn no canónico -- se aborta`);
  }
  if (r.identidades_invalidas) {
    throw new Error(`${r.identidades_invalidas} estado(s) no pertenecen al ciclo declarado -- se aborta`);
  }
  return r.fallidos_legacy;
}

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout = '5min'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('090-agente-terminado-en',0))");

  const bloqueadas = await bloquearConversaciones();
  const fallidosLegacy = await validarPrecondiciones();
  const antes = await huella();
  const esperados = await fotografiar(bloqueadas);

  await db.query(await readFile(
    new URL('../migrations/090_agente_terminado_en.sql', import.meta.url), 'utf8'));

  const despues = await huella();
  if (antes.filas !== despues.filas) {
    throw new Error(`la 090 cambió el número de conversaciones (${antes.filas} -> ${despues.filas}) -- se aborta`);
  }
  if (antes.hash !== despues.hash) {
    throw new Error('la 090 alteró algo más que `terminadoEn` en el estado de las conversaciones -- se aborta');
  }

  const diferencias = await diferenciasExactas();
  if (diferencias !== 0) {
    throw new Error(`la 090 no produjo exactamente el backfill autorizado en ${diferencias} conversación(es) -- se aborta`);
  }

  const pendientes = await recuperablesPendientes();
  if (pendientes !== 0) {
    throw new Error(`la 090 dejó ${pendientes} ciclo(s) con evidencia válida sin fecha de cierre -- se aborta`);
  }

  const despuesFechados = await fechados();
  await db.query('COMMIT');

  console.log(`[predeploy-090] Aplicada. ${antes.filas} conversaciones del agente intactas; `
    + `${esperados} ciclo(s) terminado(s) recuperaron su fecha exacta desde el libro; `
    + `${despuesFechados.sin} terminal(es) sin evidencia utilizable conservaron el respaldo; `
    + `${fallidosLegacy} fallido(s) legacy quedaron explícitamente fuera; `
    + `${bloqueadas.size} conversación(es) se serializaron con WhatsApp.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  process.exitCode = 1;
  console.error('[predeploy-090] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
