// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/031_sesiones_comerciales_error_recuperable.sql
// (y corre su verificacion de solo lectura) contra DATABASE_URL -- nunca
// ninguna otra migracion. Mismo patron que predeploy-030 (nombre de
// archivo escrito literalmente, no recorre migrations/).
//
// Idempotente: si las columnas ya existen, no hace nada y termina con
// exit 0.
//
// Uso (Railway → Settings → Deploy → Pre-Deploy Command):
//   node scripts/predeploy-031-sesiones-comerciales-error-recuperable.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '031_sesiones_comerciales_error_recuperable.sql');
const CHECK = join(__dirname, '..', 'migrations', '031_check_sesiones_comerciales_error_recuperable.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'sesiones_comerciales'
      AND column_name IN ('ultimo_error_codigo', 'ultimo_error_at', 'intentos_fallidos')
  `);
  if (cols.rows.length < 3) return false;
  const check = await pool.query(`
    SELECT pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'sesiones_comerciales' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%estado%'
  `);
  return check.rows.some((r) => r.def.includes('error_recuperable'));
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-031] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-031] Aplicando migrations/031_sesiones_comerciales_error_recuperable.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-031] Aplicada. Corriendo verificacion...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro las columnas/constraint esperadas');
    console.log('[predeploy-031] Verificacion OK.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-031] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
