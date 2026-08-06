// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/039_restaurante_mesas.sql (y su verificacion
// de solo lectura) contra DATABASE_URL -- nunca ninguna otra migracion,
// nunca el _down. Mismo patron que predeploy-032..038.
//
// Sin backfill por diseno: crear las tablas no activa el modulo restaurante
// de ningun negocio (el modulo se activa por negocio_modulos, accion
// explicita del Superadmin) ni crea mesas/cuentas. Este script verifica que
// las tres tablas queden VACIAS tras una aplicacion limpia.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '039_restaurante_mesas.sql');
const CHECK = join(__dirname, '..', 'migrations', '039_check_restaurante_mesas.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TABLAS = ['restaurante_cuentas', 'restaurante_cuenta_items', 'restaurante_cuenta_pagos'];

async function yaAplicada() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ANY($1)`,
    [TABLAS]
  );
  return rows[0].n === TABLAS.length;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-039] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-039] Aplicando migrations/039_restaurante_mesas.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-039] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró las tablas esperadas');
    for (const t of TABLAS) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (rows[0].n !== 0) throw new Error(`sin backfill: ${t} debía quedar vacía y tiene ${rows[0].n} filas`);
    }
    const { rows: [chk] } = await pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_restaurante_mesa_abierta'`);
    if (chk.n !== 1) throw new Error('falta el índice único parcial de mesa abierta');
    console.log('[predeploy-039] Verificación OK. Tablas creadas vacías -- el módulo se activa por negocio, nunca por la migración.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-039] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
