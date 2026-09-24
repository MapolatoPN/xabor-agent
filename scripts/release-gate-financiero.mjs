// Barrera de solo lectura para el corte financiero, promociones y facturación.
// Se ejecuta DESPUÉS de las migraciones del predeploy y antes de atender
// tráfico. No crea ventas, no cambia cortes y no consulta precios actuales.
import pg from 'pg';

const databaseUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[gate-financiero] FALLO: falta DATABASE_URL o DATABASE_PUBLIC_URL');
  process.exit(1);
}

const host = new URL(databaseUrl).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host)
  ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: databaseUrl, ssl });
const fallos = [];

try {
  await db.connect();
  await db.query('BEGIN READ ONLY');

  const { rows: tablas } = await db.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'clientes_fiscales', 'facturacion_configuracion',
         'facturacion_recibos', 'facturacion_whatsapp_estado',
         'facturas_pedido', 'ajustes_cierre', 'venta_devoluciones'
       )`);
  const presentes = new Set(tablas.map((r) => r.table_name));
  for (const tabla of [
    'clientes_fiscales', 'facturacion_configuracion', 'facturacion_recibos',
    'facturacion_whatsapp_estado', 'facturas_pedido', 'ajustes_cierre',
    'venta_devoluciones',
  ]) {
    if (!presentes.has(tabla)) fallos.push(`falta tabla ${tabla}`);
  }

  const { rows: columnas } = await db.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'cortes_caja' AND column_name IN
             ('descuento_manual', 'descuento_promocional', 'rewards_canjeados'))
         OR (table_name = 'tienda_promocion_usos' AND column_name = 'canal'))`);
  const columnasPresentes = new Set(columnas.map((r) => `${r.table_name}.${r.column_name}`));
  for (const columna of [
    'cortes_caja.descuento_manual', 'cortes_caja.descuento_promocional',
    'cortes_caja.rewards_canjeados', 'tienda_promocion_usos.canal',
  ]) {
    if (!columnasPresentes.has(columna)) fallos.push(`falta columna ${columna}`);
  }

  const { rows: [indices] } = await db.query(`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'facturacion_recibos'
           AND indexdef ILIKE '%UNIQUE%'
           AND indexdef ILIKE '%(negocio_id, folio)%'
      ) AS recibo_unico,
      EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'uq_facturas_pedido_negocio_factura'
      ) AS factura_remota_unica,
      EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'uq_venta_devoluciones_legacy'
      ) AS devolucion_legacy_unica`);
  if (!indices.recibo_unico) fallos.push('falta unicidad de recibo por negocio y folio');
  if (!indices.factura_remota_unica) fallos.push('falta unicidad de factura remota por negocio');
  if (!indices.devolucion_legacy_unica) fallos.push('falta unicidad del backfill de devoluciones');

  if (columnasPresentes.has('tienda_promocion_usos.canal')) {
    const { rows: [nulos] } = await db.query(
      `SELECT count(*)::int AS n FROM tienda_promocion_usos WHERE canal IS NULL`);
    if (nulos.n !== 0) fallos.push(`usos de promoción sin canal: ${nulos.n}`);
  }

  await db.query('ROLLBACK');
} catch (e) {
  fallos.push(`consulta de gate: ${e.message}`);
  await db.query('ROLLBACK').catch(() => {});
} finally {
  await db.end().catch(() => {});
}

if (fallos.length) {
  for (const fallo of fallos) console.error(`[gate-financiero] FALLO: ${fallo}`);
  process.exit(1);
}
console.log('[gate-financiero] OK: esquema financiero, recibos, devoluciones y canales verificados en READ ONLY.');
