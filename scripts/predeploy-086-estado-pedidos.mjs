// Pre-Deploy Command de Railway para la 086.
//
// La migración corrige exclusivamente datos.estado para que refleje la columna
// SQL autoritativa. La foto excluye esa llave y demuestra que no cambió ningún
// otro dato del pedido, ningún estado SQL ni el número de filas.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });

const foto = async () => (await db.query(`
  SELECT count(*)::int AS pedidos,
         count(*) FILTER (WHERE estado IS NULL)::int AS estados_nulos,
         md5(COALESCE(string_agg(
           md5(folio || ':' || COALESCE(negocio_id::text, '') || ':' ||
               COALESCE(estado, '') || ':' || (datos - 'estado')::text),
           '' ORDER BY negocio_id::text, folio), '')) AS contenido_sin_estado_json
    FROM pedidos_activos`)).rows[0];

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('086-estado-pedidos',0))");
  const antes = await foto();
  if (antes.estados_nulos !== 0) {
    throw new Error(`${antes.estados_nulos} pedidos tienen estado SQL NULL; no se puede inferir ni reparar automáticamente`);
  }
  const { rows: [pendientes] } = await db.query(`
    SELECT count(*)::int AS n FROM pedidos_activos
     WHERE datos->>'estado' IS DISTINCT FROM estado`);

  await db.query(await readFile(new URL('../migrations/086_estado_pedido_autoritativo.sql', import.meta.url), 'utf8'));

  const despues = await foto();
  for (const campo of ['pedidos', 'estados_nulos', 'contenido_sin_estado_json']) {
    if (String(antes[campo]) !== String(despues[campo])) {
      throw new Error(`la 086 alteró ${campo} (antes ${antes[campo]}, después ${despues[campo]})`);
    }
  }

  const { rows: [desalineados] } = await db.query(`
    SELECT count(*)::int AS n FROM pedidos_activos
     WHERE datos->>'estado' IS DISTINCT FROM estado`);
  if (desalineados.n !== 0) throw new Error(`quedaron ${desalineados.n} pedidos con estados desalineados`);

  const { rows: [trigger] } = await db.query(`
    SELECT count(*)::int AS n
      FROM pg_trigger
     WHERE tgrelid='pedidos_activos'::regclass
       AND tgname='trg_pedidos_activos_estado_json'
       AND NOT tgisinternal AND tgenabled <> 'D'`);
  if (trigger.n !== 1) throw new Error('el trigger autoritativo no quedó instalado y habilitado');

  await db.query('COMMIT');
  console.log(`[predeploy-086] Aplicada. ${pendientes.n} fotografías reparadas; `
    + `${despues.pedidos} pedidos verificados sin alterar su estado SQL ni su contenido.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  process.exitCode = 1;
  console.error('[predeploy-086] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
