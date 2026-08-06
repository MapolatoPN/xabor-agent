// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/037_central_operaciones_onboarding.sql (y su
// verificacion de solo lectura) contra DATABASE_URL -- nunca ninguna otra
// migracion, nunca el _down. Mismo patron que predeploy-032..036.
//
// Idempotente en dos capas: (1) la migracion misma es reejecutable (ADD
// COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / backfills que solo
// tocan filas en el default), y (2) este script detecta si ya esta aplicada
// (columna onboarding_estado + tabla sesiones_soporte presentes) y en ese
// caso no ejecuta nada, terminando con exit 0.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '037_central_operaciones_onboarding.sql');
const CHECK = join(__dirname, '..', 'migrations', '037_check_central_operaciones_onboarding.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const [col, tabla] = await Promise.all([
    pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'negocios' AND column_name = 'onboarding_estado'
    `),
    pool.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'sesiones_soporte'
    `),
  ]);
  return col.rows.length === 1 && tabla.rows.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-037] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-037] Aplicando migrations/037_central_operaciones_onboarding.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-037] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró columna/tabla esperadas');
    const { rows } = await pool.query(`SELECT onboarding_estado, count(*)::int AS n FROM negocios GROUP BY onboarding_estado ORDER BY n DESC`);
    console.log('[predeploy-037] Verificación OK. Distribución de onboarding:', rows.map(r => `${r.onboarding_estado}=${r.n}`).join(', ') || '(sin negocios)');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-037] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
