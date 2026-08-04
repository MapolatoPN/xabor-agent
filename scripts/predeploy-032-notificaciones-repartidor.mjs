// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/032_notificaciones_repartidor.sql (y su
// verificacion de solo lectura) contra DATABASE_URL -- nunca ninguna otra
// migracion. Mismo patron que predeploy-031.
//
// Idempotente: si la tabla ya existe, no hace nada y termina con exit 0.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '032_notificaciones_repartidor.sql');
const CHECK = join(__dirname, '..', 'migrations', '032_check_notificaciones_repartidor.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const r = await pool.query(`SELECT to_regclass('public.notificaciones_repartidor') AS existe`);
  return r.rows[0].existe !== null;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-032] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-032] Aplicando migrations/032_notificaciones_repartidor.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-032] Aplicada. Corriendo verificacion...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro la tabla esperada');
    console.log('[predeploy-032] Verificacion OK.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-032] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
