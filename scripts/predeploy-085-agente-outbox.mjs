// Pre-Deploy Command de Railway para la 085 (outbox transaccional del agente).
//
// Crea una tabla NUEVA y vacía. No toca ninguna existente, y eso es justo lo
// que se verifica: se fotografían las tablas del camino crítico antes y
// después, y cualquier diferencia aborta. Fail-closed.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const aplicada = async () => (await db.query(
  `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name = 'agente_outbox')::int
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'agente_outbox'
            AND column_name IN ('evento_clave','tipo','carga','estado','intentos'))::int AS n`)).rows[0].n === 6;

const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM pedidos_activos)::int            AS pedidos_activos,
          (SELECT count(*) FROM mensajes)::int                   AS mensajes,
          (SELECT count(*) FROM configuracion)::int              AS configuracion,
          (SELECT count(*) FROM negocios)::int                   AS negocios`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('085-agente-outbox',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/085_agente_outbox.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('la tabla agente_outbox no quedó completa tras aplicar la 085');
  const despues = await foto();
  for (const k of Object.keys(antes)) {
    if (String(antes[k]) !== String(despues[k])) {
      throw new Error(`la 085 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
    }
  }
  // La UNIQUE de operacion_clave es la idempotencia entera: si no existe, la
  // migración no sirve para lo que fue escrita.
  const { rows: [u] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE tablename = 'agente_outbox' AND indexdef ILIKE '%UNIQUE%evento_clave%'`);
  if (u.n < 1) throw new Error('falta el índice UNIQUE sobre evento_clave -- sin él el consumidor duplica efectos');
  const { rows: [c] } = await db.query('SELECT count(*)::int AS n FROM agente_outbox');
  await db.query('COMMIT');
  console.log(`[predeploy-085] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. `
    + `Camino crítico intacto (${despues.pedidos_activos} pedidos activos, ${despues.mensajes} mensajes). `
    + `agente_outbox: ${c.n} filas.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-085] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
