// Predeploy 096: ledger aislado para servicios/catering sin folio POS.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-096-facturacion-servicios',0))");
  await db.query(await readFile(new URL('../migrations/096_facturacion_servicios.sql', import.meta.url), 'utf8'));
  await db.query(`SELECT id, negocio_id, referencia, descripcion, clave_sat, total, forma_pago,
                         estado, idempotency_key, snapshot_cifrado, snapshot_sha256
                    FROM facturacion_servicios LIMIT 0`);
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname='public' AND indexname='uq_facturacion_servicios_referencia'`);
  exigir(Number(r.n) === 1, 'falta unicidad negocio+referencia');
  await db.query('COMMIT');
  console.log('[predeploy-096] Ledger de servicios verificado.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[predeploy-096] FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
