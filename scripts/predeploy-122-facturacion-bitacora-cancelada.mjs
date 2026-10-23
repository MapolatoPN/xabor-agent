import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-122-facturacion-bitacora-cancelada',0))");
  await db.query(await readFile(new URL('../migrations/122_facturacion_bitacora_cancelada.sql',import.meta.url),'utf8'));
  await db.query('SELECT cancelada_at FROM facturas_pedido LIMIT 0');
  await db.query('SELECT negocio_id, usuario_id, accion, folio, factura_id, detalle FROM facturacion_bitacora LIMIT 0');
  const {rows:[n]}=await db.query('SELECT count(*)::int AS n FROM facturas_pedido WHERE cancelada_at IS NOT NULL');
  await db.query('COMMIT');console.log(`[predeploy-122] Facturación: bitácora lista; ${n.n} CFDI de venta marcados como cancelados.`);
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
