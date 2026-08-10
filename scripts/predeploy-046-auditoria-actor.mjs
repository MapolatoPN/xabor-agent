// Pre-Deploy de la 046. Mismo patron que 032..045.
//
// Antes de relajar el NOT NULL comprueba que TODAS las filas existentes
// cumplen el CHECK nuevo: si alguna no lo cumpliera, el ALTER fallaria a
// mitad y el deploy quedaria a medias.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '046_auditoria_actor_negocio.sql');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  const { rows: [ya] } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'auditoria_plataforma' AND column_name = 'actor_usuario_id'`);

  if (ya.n === 1) {
    console.log('[predeploy-046] Ya aplicada -- no se ejecuta nada.');
  } else {
    const { rows: [antes] } = await pool.query(`SELECT count(*)::int AS filas FROM auditoria_plataforma`);
    const { rows: [malas] } = await pool.query(
      `SELECT count(*)::int AS n FROM auditoria_plataforma WHERE superadmin_id IS NULL`);
    if (malas.n > 0) {
      throw new Error(`${malas.n} filas historicas sin superadmin_id: el CHECK nuevo las rechazaria`);
    }

    console.log('[predeploy-046] Aplicando migrations/046_auditoria_actor_negocio.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const { rows: [despues] } = await pool.query(`SELECT count(*)::int AS filas FROM auditoria_plataforma`);
    if (antes.filas !== despues.filas) {
      throw new Error(`la migracion altero las filas (antes ${antes.filas}, despues ${despues.filas})`);
    }
    console.log(`[predeploy-046] OK. ${despues.filas} filas de auditoria intactas.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-046] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
