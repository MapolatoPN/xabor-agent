import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('076-whatsapp-continuidad',0))");
  await db.query(await readFile(new URL('../migrations/076_whatsapp_continuidad.sql', import.meta.url), 'utf8'));
  await db.query('COMMIT'); console.log('[whatsapp] Continuidad 076 verificada');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error(e.message);
} finally { await db.end(); }
