// Predeploy 089 — autofactura nativa de Xabor: tabla `autofacturas` (una liga
// pública por venta pagada).
//
// Mismo patrón que 077/078/087: transacción con advisory lock, se aplica el
// SQL real de migrations/089_autofactura_xabor.sql y se verifica el esquema
// antes de confirmar; cualquier falla hace ROLLBACK y sale con código distinto
// de cero para que Railway conserve el deployment anterior. Idempotente.
//
// Requiere la 003 (negocios y la función set_updated_at()); se comprueba
// antes de tocar nada.
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
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-089-autofactura-xabor',0))");

  exigir(await existeTabla('negocios'), 'falta la tabla negocios (migración 003)');
  exigir((await db.query("SELECT 1 FROM pg_proc WHERE proname='set_updated_at'")).rowCount >= 1,
    'falta la función set_updated_at() (migración 003)');

  await db.query(await readFile(new URL('../migrations/089_autofactura_xabor.sql', import.meta.url), 'utf8'));

  exigir(await existeTabla('autofacturas'), 'autofacturas no quedó creada');
  await db.query('SELECT id, negocio_id, folio, token_hash, token_cifrado, token_iv, token_auth_tag, token_formato_version, '
    + 'total, estado, expires_at, intento_key, factura_id, uuid, emitida_at, fuente_emision, error_codigo, error_detalle, '
    + 'created_at, updated_at FROM autofacturas LIMIT 0');

  // Token cifrado: las tres columnas del material cifrado son NOT NULL y la
  // versión de formato es smallint con default 1 (mismo contrato que
  // integraciones_canal_credenciales).
  const { rows: cols } = await db.query(
    `SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='autofacturas'
        AND column_name IN ('token_hash','token_cifrado','token_iv','token_auth_tag','token_formato_version','total','expires_at')`);
  const col = (n) => cols.find((c) => c.column_name === n);
  for (const n of ['token_hash', 'token_cifrado', 'token_iv', 'token_auth_tag', 'total', 'expires_at']) {
    exigir(col(n)?.is_nullable === 'NO', `autofacturas.${n} debe ser NOT NULL`);
  }
  exigir(col('token_formato_version')?.data_type === 'smallint' && String(col('token_formato_version').column_default) === '1',
    'autofacturas.token_formato_version debe ser smallint DEFAULT 1');

  // Candados: una venta = una liga; un token = una fila.
  exigir(await unicoSobre('autofacturas', 'negocio_id, folio'), 'falta UNIQUE (negocio_id, folio) en autofacturas');
  exigir(await unicoSobre('autofacturas', 'token_hash'), 'falta UNIQUE (token_hash) en autofacturas');
  for (const n of ['uq_autofacturas_negocio_factura', 'idx_autofacturas_estado_expira']) {
    exigir(await existeIndice(n), `falta el índice ${n}`);
  }

  // CHECKs: estados, total > 0, formato del hash, fuentes de emisión.
  const { rows: checks } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid='public.autofacturas'::regclass AND contype='c'`);
  const defs = checks.map((r) => r.def);
  const chkEstado = defs.find((d) => d.includes('estado'));
  exigir(chkEstado && ['vigente', 'emitiendo', 'facturada', 'expirada', 'revocada', 'error'].every((e) => chkEstado.includes(`'${e}'`)),
    'el CHECK de autofacturas.estado no tiene los seis estados');
  // Postgres imprime el CHECK como `(total > (0)::numeric)`.
  exigir(defs.some((d) => /\btotal\s*>\s*\(?0\)?/.test(d)), 'falta el CHECK total > 0');
  exigir(defs.some((d) => d.includes('token_hash') && d.includes('[a-f0-9]{64}')), 'falta el CHECK de formato de token_hash');
  const chkFuente = defs.find((d) => d.includes('fuente_emision'));
  exigir(chkFuente && ['portal', 'panel', 'restaurante', 'whatsapp'].every((f) => chkFuente.includes(`'${f}'`)),
    'el CHECK de fuente_emision no tiene las cuatro fuentes');

  // updated_at automático.
  exigir((await db.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid='public.autofacturas'::regclass AND tgname='set_updated_at' AND NOT tgisinternal")).rowCount === 1,
    'falta el trigger set_updated_at en autofacturas');

  await db.query('COMMIT');
  console.log('[autofactura] Migración 089 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[autofactura] Falló la migración 089:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
