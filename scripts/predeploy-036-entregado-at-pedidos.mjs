// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/036_entregado_at_pedidos.sql (y su
// verificacion de solo lectura) contra DATABASE_URL -- nunca ninguna otra
// migracion. Mismo patron que predeploy-032/033/034/035.
//
// Idempotente: si la columna ya existe, no hace nada y termina con exit 0.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '036_entregado_at_pedidos.sql');
const CHECK = join(__dirname, '..', 'migrations', '036_check_entregado_at_pedidos.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pedidos_activos' AND column_name = 'entregado_at'
  `);
  return cols.rows.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-036] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-036] Aplicando migrations/036_entregado_at_pedidos.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-036] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró la columna esperada');
    console.log('[predeploy-036] Verificación OK.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-036] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
