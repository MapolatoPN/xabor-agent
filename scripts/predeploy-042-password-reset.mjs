// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/042_password_reset_tokens.sql (y su
// verificacion de solo lectura) contra DATABASE_URL. Mismo patron que
// predeploy-032..041. Sin backfill: no crea tokens, no invalida la sesion de
// nadie y no toca ninguna contrasena existente.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '042_password_reset_tokens.sql');
const CHECK = join(__dirname, '..', 'migrations', '042_check_password_reset_tokens.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables WHERE table_name = 'password_reset_tokens'
  `);
  const { rows: col } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'usuarios' AND column_name = 'sesiones_invalidas_antes'
  `);
  return rows.length === 1 && col.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-042] Ya aplicada -- no se ejecuta nada.');
  } else {
    // Foto previa: la migracion no debe tocar ninguna fila existente.
    const { rows: [antes] } = await pool.query(
      'SELECT count(*)::int AS total, count(email)::int AS con_email, count(password_hash)::int AS con_password FROM usuarios');
    console.log('[predeploy-042] Aplicando migrations/042_password_reset_tokens.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-042] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró la tabla o la columna esperadas');
    const { rows: [despues] } = await pool.query(
      `SELECT count(*)::int AS total, count(email)::int AS con_email, count(password_hash)::int AS con_password,
              count(sesiones_invalidas_antes)::int AS con_sesiones_invalidadas FROM usuarios`);
    if (despues.total !== antes.total || despues.con_email !== antes.con_email || despues.con_password !== antes.con_password) {
      throw new Error(`la migración alteró usuarios existentes (antes ${antes.total}/${antes.con_email}/${antes.con_password}, después ${despues.total}/${despues.con_email}/${despues.con_password})`);
    }
    if (despues.con_sesiones_invalidadas !== 0) {
      throw new Error(`sin backfill: no debe invalidarse ninguna sesión al migrar (hay ${despues.con_sesiones_invalidadas})`);
    }
    const { rows: [tokens] } = await pool.query('SELECT count(*)::int AS total FROM password_reset_tokens');
    if (tokens.total !== 0) throw new Error(`la tabla debe nacer vacía (hay ${tokens.total} tokens)`);
    console.log(`[predeploy-042] Verificación OK. ${despues.total} usuarios intactos, 0 sesiones invalidadas, 0 tokens.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-042] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
