import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-116-atencion',0))");
  await db.query(await readFile(new URL('../migrations/116_conversaciones_atencion_avisos.sql',import.meta.url),'utf8'));
  await db.query('COMMIT');
  console.log('[predeploy-116] Ledger de avisos creado; ninguna bandera activada.');
} catch (e) { await db.query('ROLLBACK').catch(()=>{}); console.error(e.message); process.exitCode=1; }
finally { await db.end().catch(()=>{}); }
