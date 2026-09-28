import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-104-agente-elecciones',0))");
  await db.query(await readFile(new URL('../migrations/105_agente_edicion_interactiva.sql',import.meta.url),'utf8'));
  await db.query('COMMIT');console.log('[predeploy-105] Acciones de edición verificadas; sin cambios de configuración.');
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
