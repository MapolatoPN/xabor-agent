// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/035_perfil_repartidor.sql (y su
// verificacion de solo lectura) contra DATABASE_URL -- nunca ninguna otra
// migracion. Mismo patron que predeploy-032/033/034.
//
// Idempotente: si las columnas ya existen, no hace nada y termina con
// exit 0.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '035_perfil_repartidor.sql');
const CHECK = join(__dirname, '..', 'migrations', '035_check_perfil_repartidor.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'repartidores'
      AND column_name IN ('estado', 'ciudad', 'zona', 'vehiculo')
  `);
  return cols.rows.length === 4;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-035] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-035] Aplicando migrations/035_perfil_repartidor.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-035] Aplicada. Corriendo verificacion...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro las columnas esperadas');
    console.log('[predeploy-035] Verificacion OK.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-035] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
