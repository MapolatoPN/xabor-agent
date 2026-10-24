import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-124-factura-global',0))");
  await db.query(await readFile(new URL('../migrations/124_factura_global.sql',import.meta.url),'utf8'));
  await db.query('SELECT 1 FROM facturacion_globales LIMIT 0');
  await db.query('SELECT 1 FROM facturacion_global_recibos LIMIT 0');
  await db.query('SELECT forma_pago FROM facturacion_recibos LIMIT 0');
  await db.query('SELECT global_incluir_rappi, forma_tarjeta, forma_mixto, forma_rappi FROM facturacion_configuracion LIMIT 0');
  await db.query('COMMIT');console.log('[predeploy-124] Facturación: tablas de la global listas y vacías; formas de pago por negocio con lo de siempre.');
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
