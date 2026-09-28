import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false} });
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-104-agente-elecciones',0))");
  // El runner repite todas las migraciones: nunca reinstalar una restricción
  // anterior sobre filas válidas creadas después de la 105.
  const {rows:[actual]}=await db.query("SELECT pg_get_constraintdef(oid) AS regla FROM pg_constraint WHERE conrelid=to_regclass('agente_botones') AND conname='agente_botones_accion_check'");
  if (!actual?.regla?.includes("'editar_grupo'"))
    await db.query(await readFile(new URL('../migrations/104_agente_elecciones.sql',import.meta.url),'utf8'));
  await db.query('SELECT token,datos FROM agente_botones LIMIT 0');
  await db.query('COMMIT'); console.log('[predeploy-104] Elecciones estructuradas verificadas; bandera apagada por omisión.');
} catch(e) { await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1; }
finally { await db.end().catch(()=>{}); }
