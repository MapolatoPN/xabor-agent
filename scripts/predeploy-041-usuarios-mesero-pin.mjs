// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/041_usuarios_mesero_pin.sql (y su verificacion
// de solo lectura) contra DATABASE_URL. Mismo patron que predeploy-032..040.
// Sin backfill: no crea ni modifica ningun usuario; solo permite email NULL,
// agrega pin_hash y la restriccion de identidad.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '041_usuarios_mesero_pin.sql');
const CHECK = join(__dirname, '..', 'migrations', '041_check_usuarios_mesero_pin.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'usuarios' AND column_name = 'pin_hash'
  `);
  return rows.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-041] Ya aplicada -- no se ejecuta nada.');
  } else {
    // Foto previa: la migracion no debe tocar ninguna fila existente.
    const { rows: [antes] } = await pool.query(
      'SELECT count(*)::int AS total, count(email)::int AS con_email FROM usuarios');
    console.log('[predeploy-041] Aplicando migrations/041_usuarios_mesero_pin.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-041] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró la columna pin_hash');
    const { rows: [despues] } = await pool.query(
      'SELECT count(*)::int AS total, count(email)::int AS con_email, count(pin_hash)::int AS con_pin FROM usuarios');
    if (despues.total !== antes.total || despues.con_email !== antes.con_email) {
      throw new Error(`la migración alteró usuarios existentes (antes ${antes.total}/${antes.con_email}, después ${despues.total}/${despues.con_email})`);
    }
    if (despues.con_pin !== 0) throw new Error(`sin backfill: no debe haber PINs al aplicar (hay ${despues.con_pin})`);
    console.log(`[predeploy-041] Verificación OK. ${despues.total} usuarios intactos, 0 con PIN.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-041] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
