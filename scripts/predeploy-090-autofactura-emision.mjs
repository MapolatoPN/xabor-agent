// Predeploy 090 — autofactura nativa, motor de emisión: columnas del intento
// fiscal idempotente y del snapshot cifrado en `autofacturas`.
//
// Mismo patrón que 087/089: transacción con advisory lock, se aplica el SQL
// real de migrations/090_autofactura_emision.sql y se verifica el esquema
// antes de confirmar; cualquier falla hace ROLLBACK y sale con código
// distinto de cero. Idempotente (ADD COLUMN / CREATE INDEX IF NOT EXISTS).
// Requiere la 089 (tabla autofacturas); se comprueba antes de tocar nada.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const exigir = (cond, msg) => { if (!cond) throw new Error(msg); };
const existeTabla = async (t) => (await db.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r !== null;
const existeIndice = async (n) =>
  (await db.query("SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [n])).rowCount === 1;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-090-autofactura-emision',0))");

  exigir(await existeTabla('autofacturas'), 'la 090 requiere la tabla autofacturas (migración 089): aplicar 089 antes');

  await db.query(await readFile(new URL('../migrations/090_autofactura_emision.sql', import.meta.url), 'utf8'));

  await db.query('SELECT intento_numero, intento_iniciado_at, intento_cerrado_at, snapshot_cifrado, snapshot_iv, snapshot_auth_tag, '
    + 'snapshot_formato_version, snapshot_sha256, proveedor_status, intento_key FROM autofacturas LIMIT 0');
  const { rows: cols } = await db.query(
    `SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='autofacturas' AND column_name IN ('intento_numero','snapshot_formato_version')`);
  const col = (n) => cols.find((c) => c.column_name === n);
  exigir(col('intento_numero')?.data_type === 'smallint' && col('intento_numero').is_nullable === 'NO' && String(col('intento_numero').column_default) === '0',
    'autofacturas.intento_numero debe ser smallint NOT NULL DEFAULT 0');
  exigir(col('snapshot_formato_version')?.data_type === 'smallint', 'autofacturas.snapshot_formato_version debe ser smallint');
  exigir((await db.query("SELECT 1 FROM pg_constraint WHERE conname='autofacturas_snapshot_sha256_formato'")).rowCount === 1,
    'falta el CHECK autofacturas_snapshot_sha256_formato');
  for (const n of ['uq_autofacturas_intento_key', 'idx_autofacturas_emitiendo']) {
    exigir(await existeIndice(n), `falta el índice ${n}`);
  }
  const { rows: [uq] } = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='uq_autofacturas_intento_key'");
  exigir(/CREATE UNIQUE INDEX/i.test(uq.indexdef), 'uq_autofacturas_intento_key debe ser UNIQUE');

  await db.query('COMMIT');
  console.log('[autofactura] Migración 090 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[autofactura] Falló la migración 090:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
