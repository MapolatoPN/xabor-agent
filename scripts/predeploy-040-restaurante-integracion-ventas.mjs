// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/040_restaurante_integracion_ventas.sql (y su
// verificacion de solo lectura) contra DATABASE_URL. Mismo patron que
// predeploy-032..039. Sin backfill: verifica que NINGUNA cuenta quede
// contabilizada por la migracion misma.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '040_restaurante_integracion_ventas.sql');
const CHECK = join(__dirname, '..', 'migrations', '040_check_restaurante_integracion_ventas.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'restaurante_cuentas' AND column_name = 'venta_folio'
  `);
  return rows.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-040] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-040] Aplicando migrations/040_restaurante_integracion_ventas.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-040] Aplicada. Corriendo verificación...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificación post-migración no encontró la columna esperada');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM restaurante_cuentas WHERE venta_folio IS NOT NULL');
    if (rows[0].n !== 0) throw new Error(`sin backfill: no debe haber cuentas contabilizadas al aplicar (hay ${rows[0].n})`);
    console.log('[predeploy-040] Verificación OK. Columnas listas, cero cuentas contabilizadas por la migración.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-040] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
