// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/038_red_repartidores_config.sql (y su
// verificacion de solo lectura) contra DATABASE_URL -- nunca ninguna otra
// migracion, nunca el _down. Mismo patron que predeploy-032..037.
//
// La 038 NO tiene backfill a proposito: crear la tabla no activa ni
// desactiva la red de ningun negocio (sin fila = comportamiento legado
// exacto). Este script verifica ademas que la tabla quede VACIA tras una
// aplicacion limpia -- si apareciera una fila, algo esta mal y se aborta.
//
// Idempotente en dos capas: (1) CREATE TABLE IF NOT EXISTS, y (2) este
// script detecta la tabla ya presente y no ejecuta nada (exit 0).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '038_red_repartidores_config.sql');
const CHECK = join(__dirname, '..', 'migrations', '038_check_red_repartidores_config.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables WHERE table_name = 'red_repartidores_config'
  `);
  return rows.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-038] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-038] Aplicando migrations/038_red_repartidores_config.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-038] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró la tabla esperada');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM red_repartidores_config');
    if (rows[0].n !== 0) throw new Error(`la 038 no tiene backfill: la tabla debía quedar vacía y tiene ${rows[0].n} filas`);
    console.log('[predeploy-038] Verificación OK. Tabla creada vacía -- ningún negocio cambia de comportamiento hasta configurar su red.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-038] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
