import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-120-sat-descarga-por-negocio',0))");
  await db.query(await readFile(new URL('../migrations/120_sat_descarga_por_negocio.sql',import.meta.url),'utf8'));
  const {rows:[t]}=await db.query("SELECT to_regclass('public.sat_download_requests') IS NOT NULL AS hay");
  if (t.hay) await db.query('SELECT cod_estatus, mensaje, estado_solicitud, numero_cfdis, intentos FROM sat_download_requests LIMIT 0');
  await db.query('COMMIT');console.log('[predeploy-120] Descarga SAT por negocio: columnas listas; lo de «default» pasa al negocio con e.firma.');
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
