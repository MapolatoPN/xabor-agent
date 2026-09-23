// Predeploy 087 — facturación por negocio: libreta fiscal (clientes_fiscales),
// configuración de facturación, recibos y estado de WhatsApp.
//
// Mismo patrón que 077/078: transacción con advisory lock, se aplica el SQL
// real de migrations/087_clientes_fiscales.sql y se verifica explícitamente el
// esquema antes de confirmar; cualquier falla hace ROLLBACK y sale con código
// distinto de cero para que Railway conserve el deployment anterior.
//
// La 087 crea un índice sobre facturas_pedido y reescribe su CHECK de fuente,
// así que exige la 065 (facturas_pedido) ya aplicada: se comprueba ANTES de
// tocar nada. Idempotente: el SQL es IF NOT EXISTS / DO $$ ... $$ y volver a
// correrlo no cambia nada.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const exigir = (cond, msg) => { if (!cond) throw new Error(msg); };
const existeTabla = async (t) => (await db.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r !== null;
const existeIndice = async (n) =>
  (await db.query("SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [n])).rowCount === 1;
const unicoSobre = async (tabla, columnas) =>
  (await db.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename=$1
       AND indexdef ILIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE $2`, [tabla, `%(${columnas})%`])).rowCount >= 1;
const defConstraint = async (tabla, nombre) => {
  const { rows: [r] } = await db.query(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2',
    [`public.${tabla}`, nombre]);
  return r?.def || null;
};

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-087-clientes-fiscales',0))");

  exigir(await existeTabla('negocios'), 'falta la tabla negocios (migración 003)');
  exigir(await existeTabla('facturas_pedido'),
    'la 087 requiere facturas_pedido (migración 065): aplicar 065_ajustes_cierre.sql antes');

  await db.query(await readFile(new URL('../migrations/087_clientes_fiscales.sql', import.meta.url), 'utf8'));

  // Tablas y columnas esenciales (SELECT ... LIMIT 0 falla si falta cualquiera).
  for (const t of ['clientes_fiscales', 'facturacion_configuracion', 'facturacion_recibos', 'facturacion_whatsapp_estado']) {
    exigir(await existeTabla(t), `${t} no quedó creada`);
  }
  await db.query('SELECT id, negocio_id, rfc, razon_social, regimen, uso_cfdi, cp, email, telefono, notas, created_at, updated_at '
    + 'FROM clientes_fiscales LIMIT 0');
  await db.query('SELECT negocio_id, iva_tasa, autoemitir_recibo, clave_producto_restaurante, clave_producto_para_llevar, serie, '
    + 'created_at, updated_at FROM facturacion_configuracion LIMIT 0');
  await db.query('SELECT id, negocio_id, folio, proveedor, recibo_id, clave, url_autofactura, expires_at, estado, factura_id, uuid, '
    + 'total, idempotency_key, error_codigo, error_detalle, created_at, updated_at FROM facturacion_recibos LIMIT 0');
  await db.query('SELECT negocio_id, telefono, estado, folio, expires_at, created_at, updated_at '
    + 'FROM facturacion_whatsapp_estado LIMIT 0');

  // regimen / uso_cfdi sin DEFAULT: la ficha nunca adivina datos fiscales.
  const { rows: defaults } = await db.query(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='clientes_fiscales' AND column_name IN ('regimen','uso_cfdi')`);
  exigir(defaults.length === 2 && defaults.every((d) => d.column_default === null),
    'clientes_fiscales.regimen / uso_cfdi deben quedar sin DEFAULT');

  // Constraints e índices que la 087 declara.
  exigir(await defConstraint('clientes_fiscales', 'clientes_fiscales_rfc_formato'), 'falta clientes_fiscales_rfc_formato');
  exigir(await unicoSobre('clientes_fiscales', 'negocio_id, rfc'), 'falta UNIQUE (negocio_id, rfc) en clientes_fiscales');
  exigir(await unicoSobre('facturacion_configuracion', 'negocio_id'), 'falta la PK negocio_id en facturacion_configuracion');
  exigir(await unicoSobre('facturacion_recibos', 'negocio_id, folio'), 'falta UNIQUE (negocio_id, folio) en facturacion_recibos');
  exigir(await unicoSobre('facturacion_recibos', 'proveedor, idempotency_key'), 'falta UNIQUE (proveedor, idempotency_key) en facturacion_recibos');
  exigir(await unicoSobre('facturacion_whatsapp_estado', 'negocio_id, telefono'), 'falta la PK (negocio_id, telefono) en facturacion_whatsapp_estado');
  for (const n of ['idx_clientes_fiscales_negocio_telefono', 'idx_clientes_fiscales_negocio_nombre',
    'uq_facturacion_recibos_remoto', 'idx_facturacion_recibos_reconciliar', 'uq_facturas_pedido_negocio_factura']) {
    exigir(await existeIndice(n), `falta el índice ${n}`);
  }

  // CHECK de estado de los recibos.
  const { rows: checksRecibo } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid='public.facturacion_recibos'::regclass AND contype='c'`);
  const chkEstado = checksRecibo.map((r) => r.def).find((d) => d.includes('estado'));
  exigir(chkEstado && ['creando', 'abierto', 'facturado', 'global', 'cancelado', 'error'].every((e) => chkEstado.includes(`'${e}'`)),
    'el CHECK de facturacion_recibos.estado no tiene los seis estados');

  // facturas_pedido acepta las fuentes que la 087 agrega.
  const fuente = await defConstraint('facturas_pedido', 'facturas_pedido_fuente_check');
  exigir(fuente && ['panel', 'whatsapp', 'restaurante', 'autofactura'].every((f) => fuente.includes(`'${f}'`)),
    'facturas_pedido_fuente_check no acepta panel/whatsapp/restaurante/autofactura');

  await db.query('COMMIT');
  console.log('[facturacion] Migración 087 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[facturacion] Falló la migración 087:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
