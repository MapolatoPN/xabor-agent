// Aplica la 092 y comprueba que sólo se agregue el ledger de devoluciones.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });

const foto = async () => (await db.query(`
  SELECT (SELECT count(*) FROM pedidos_activos)::int AS pedidos,
         (SELECT count(*) FROM ventas)::int AS ventas,
         (SELECT count(*) FROM negocios)::int AS negocios`)).rows[0];

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('092-devoluciones-venta',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/092_devoluciones_venta.sql', import.meta.url), 'utf8'));
  const despues = await foto();
  for (const campo of Object.keys(antes)) {
    if (String(antes[campo]) !== String(despues[campo])) {
      throw new Error(`la 092 alteró ${campo} (antes ${antes[campo]}, después ${despues[campo]})`);
    }
  }
  const { rows: [tabla] } = await db.query(`
    SELECT to_regclass('public.venta_devoluciones') IS NOT NULL AS existe`);
  if (!tabla.existe) throw new Error('no se creó venta_devoluciones');
  const { rows: [indice] } = await db.query(`
    SELECT count(*)::int AS n FROM pg_indexes
     WHERE tablename = 'venta_devoluciones'
       AND indexname = 'uq_venta_devoluciones_legacy'`);
  if (indice.n !== 1) throw new Error('falta unicidad del backfill de devoluciones');
  await db.query('COMMIT');
  const { rows: [ledger] } = await db.query(
    `SELECT count(*)::int AS n FROM venta_devoluciones`);
  console.log(`[predeploy-092] Aplicada. Camino crítico intacto (${despues.pedidos} pedidos, ${despues.ventas} ventas); ${ledger.n} devoluciones conservadas.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  process.exitCode = 1;
  console.error('[predeploy-092] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
