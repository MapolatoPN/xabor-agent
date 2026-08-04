// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/034_modo_conversacion_repartidor.sql (y su
// verificacion de solo lectura) contra DATABASE_URL -- nunca ninguna otra
// migracion. Mismo patron que predeploy-032/033.
//
// Idempotente: si las columnas ya existen, no hace nada y termina con
// exit 0.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '034_modo_conversacion_repartidor.sql');
const CHECK = join(__dirname, '..', 'migrations', '034_check_modo_conversacion_repartidor.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'repartidores'
      AND column_name IN ('modo_actual', 'modo_actualizado_at')
  `);
  return cols.rows.length === 2;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-034] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-034] Aplicando migrations/034_modo_conversacion_repartidor.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-034] Aplicada. Corriendo verificacion...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro las columnas esperadas');
    console.log('[predeploy-034] Verificacion OK.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-034] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
