// Pre-Deploy Command de Railway para la 084 (libro de operaciones del agente).
//
// Crea una tabla NUEVA y vacía. No toca ninguna existente, y eso es justo lo
// que se verifica: se fotografían las tablas del camino crítico antes y
// después, y cualquier diferencia aborta. Fail-closed.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const aplicada = async () => (await db.query(
  `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name = 'agente_operaciones')::int
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'agente_operaciones'
            AND column_name IN ('operacion_clave','argumentos_hash','estado','aplicada','modo'))::int AS n`)).rows[0].n === 6;

const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM pedidos_activos)::int            AS pedidos_activos,
          (SELECT count(*) FROM mensajes)::int                   AS mensajes,
          (SELECT count(*) FROM configuracion)::int              AS configuracion,
          (SELECT count(*) FROM negocios)::int                   AS negocios`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('084-agente-operaciones',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/084_agente_operaciones.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('la tabla agente_operaciones no quedó completa tras aplicar la 084');
  const despues = await foto();
  for (const k of Object.keys(antes)) {
    if (String(antes[k]) !== String(despues[k])) {
      throw new Error(`la 084 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
    }
  }
  // La UNIQUE de operacion_clave es la idempotencia entera: si no existe, la
  // migración no sirve para lo que fue escrita.
  const { rows: [u] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE tablename = 'agente_operaciones' AND indexdef ILIKE '%UNIQUE%operacion_clave%'`);
  if (u.n < 1) throw new Error('falta el índice UNIQUE sobre operacion_clave -- sin él no hay idempotencia');
  const { rows: [c] } = await db.query('SELECT count(*)::int AS n FROM agente_operaciones');
  await db.query('COMMIT');
  console.log(`[predeploy-084] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. `
    + `Camino crítico intacto (${despues.pedidos_activos} pedidos activos, ${despues.mensajes} mensajes). `
    + `agente_operaciones: ${c.n} filas.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-084] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
