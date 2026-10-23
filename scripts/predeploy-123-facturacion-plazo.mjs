import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-123-facturacion-plazo',0))");
  await db.query(await readFile(new URL('../migrations/123_facturacion_plazo.sql',import.meta.url),'utf8'));
  await db.query('SELECT plazo_tipo, plazo_dias, global_desde FROM facturacion_configuracion LIMIT 0');
  await db.query('COMMIT');console.log('[predeploy-123] Facturación: plazo por negocio (fin de mes por omisión) y global de Xabor desde 2026-11-01.');
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
