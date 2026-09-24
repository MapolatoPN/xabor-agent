
// Predeploy 095 — autofactura nativa, emisión desde el portal: marca de correo
// enviado, candado temporal de reconciliación e historial de intentos
// fiscales (autofactura_intentos).
//
// Mismo patrón que 093/094: transacción con advisory lock, se aplica el SQL
// real de migrations/095_autofactura_portal.sql y se verifica el esquema
// antes de confirmar; cualquier falla hace ROLLBACK y sale con código distinto
// de cero. Idempotente. Requiere la 090.
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

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-095-autofactura-portal',0))");

  exigir(await existeTabla('autofacturas'), 'la 095 requiere autofacturas (migración 093/094)');
  const { rows: prev } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='autofacturas' AND column_name='snapshot_sha256'`);
  exigir(prev.length === 1, 'la 095 requiere las columnas de la 094 (snapshot_sha256)');

  await db.query(await readFile(new URL('../migrations/095_autofactura_portal.sql', import.meta.url), 'utf8'));

  await db.query('SELECT email_enviado_at, reconciliado_at FROM autofacturas LIMIT 0');
  exigir(await existeTabla('autofactura_intentos'), 'autofactura_intentos no quedó creada');
  await db.query('SELECT id, autofactura_id, negocio_id, folio, intento_numero, intento_key, snapshot_cifrado, snapshot_iv, '
    + 'snapshot_auth_tag, snapshot_formato_version, snapshot_sha256, proveedor_status, error_codigo, error_detalle, factura_id, '
    + 'intento_iniciado_at, intento_cerrado_at, motivo, archivado_at FROM autofactura_intentos LIMIT 0');
  exigir(await unicoSobre('autofactura_intentos', 'autofactura_id, intento_numero'), 'falta UNIQUE (autofactura_id, intento_numero)');
  exigir(await unicoSobre('autofactura_intentos', 'intento_key'), 'falta UNIQUE (intento_key) en autofactura_intentos');
  exigir(await existeIndice('idx_autofactura_intentos_negocio_folio'), 'falta idx_autofactura_intentos_negocio_folio');

  await db.query('COMMIT');
  console.log('[autofactura] Migración 095 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[autofactura] Falló la migración 095:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
