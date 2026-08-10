// Pre-Deploy de la migracion 045. Mismo patron que 032..043.
//
// Dos columnas nuevas, nullable, sin default y sin backfill. Las filas
// existentes quedan con NULL, que es la verdad: hoy no sabemos el nombre
// visible de nadie porque nunca se guardo.
//
// Sin este script la 045 NUNCA se aplicaria en un deploy: railway.toml invoca
// a scripts/predeploy-run-032-033.mjs, y ese runner solo corre lo que este en
// su lista SCRIPTS.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '045_whatsapp_nombre_visible.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const COLUMNAS = ['verified_name', 'estado_nombre'];

try {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'integraciones_canal' AND column_name = ANY($1)`, [COLUMNAS]);

  if (rows[0].n === COLUMNAS.length) {
    console.log('[predeploy-045] Ya aplicada -- no se ejecuta nada.');
  } else {
    const { rows: [antes] } = await pool.query(
      `SELECT count(*)::int AS integraciones FROM integraciones_canal`);
    console.log('[predeploy-045] Aplicando migrations/045_whatsapp_nombre_visible.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const { rows: [despues] } = await pool.query(
      `SELECT count(*)::int AS integraciones FROM integraciones_canal`);
    if (antes.integraciones !== despues.integraciones) {
      throw new Error(`la migracion altero las filas (antes ${antes.integraciones}, despues ${despues.integraciones})`);
    }
    console.log(`[predeploy-045] OK. ${despues.integraciones} integraciones intactas, 2 columnas nuevas vacias.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-045] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
