// Predeploy 098: catálogo publicado para WhatsApp (whatsapp_productos).
//
// Aplica la migración y comprueba lo que la hace segura: la FK compuesta
// negocio+producto (ningún negocio puede publicar el producto de otro), el
// índice de lectura, el CHECK de origen y que no haya filas cruzadas. Aditiva
// e idempotente; corre en cada despliegue.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-098-catalogo-whatsapp',0))");
  await db.query(await readFile(new URL('../migrations/098_catalogo_whatsapp.sql', import.meta.url), 'utf8'));
  await db.query(`SELECT negocio_id, producto_id, publicado, origen, actualizado_por, created_at, updated_at
                    FROM whatsapp_productos LIMIT 0`);
  const { rows: [fk] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'whatsapp_productos'::regclass
        AND conname = 'fk_whatsapp_producto_negocio' AND contype = 'f'`);
  exigir(Number(fk.n) === 1, 'falta la FK compuesta negocio+producto');
  const { rows: [chk] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'whatsapp_productos'::regclass AND conname = 'whatsapp_productos_origen_check'`);
  exigir(Number(chk.n) === 1, 'falta el CHECK de origen');
  const { rows: [idx] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_whatsapp_productos_publicados'`);
  exigir(Number(idx.n) === 1, 'falta el índice del catálogo publicado');
  const { rows: [cruzados] } = await db.query(
    `SELECT count(*)::int AS n FROM whatsapp_productos wp
       JOIN menu_productos p ON p.id = wp.producto_id
      WHERE p.negocio_id IS DISTINCT FROM wp.negocio_id`);
  exigir(Number(cruzados.n) === 0, 'hay productos de otro negocio en el catálogo de WhatsApp');
  await db.query('COMMIT');
  const { rows: [total] } = await db.query(
    `SELECT count(*) FILTER (WHERE publicado)::int AS publicados,
            count(*) FILTER (WHERE origen = 'siembra_tienda')::int AS sembrados
       FROM whatsapp_productos`);
  console.log(`[predeploy-098] Catálogo de WhatsApp verificado (${total.publicados} publicados, `
    + `${total.sembrados} sembrados desde Tienda).`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[predeploy-098] FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
