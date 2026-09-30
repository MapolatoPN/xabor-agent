import pg from 'pg';
import { readFile } from 'node:fs/promises';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-109-promociones-vigencia-local',0))");
  const r=await db.query(await readFile(new URL('../migrations/109_promociones_vigencia_local.sql',import.meta.url),'utf8'));
  await db.query('COMMIT');console.log(`[predeploy-109] Vigencias de promociones pasadas al día local: ${r.rowCount||0} fila(s).`);
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
