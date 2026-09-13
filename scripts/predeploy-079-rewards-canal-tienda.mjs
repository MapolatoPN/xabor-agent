import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('079-rewards-canal-tienda',0))");
  await db.query(await readFile(new URL('../migrations/079_rewards_canal_tienda.sql', import.meta.url), 'utf8'));
  await db.query('COMMIT'); console.log('[rewards] Canal tienda 079 verificado');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error(e.message);
} finally { await db.end(); }
