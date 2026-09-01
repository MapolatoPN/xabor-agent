// Pre-Deploy Command de Railway para la 068 exclusivamente.
//
// Agrega la columna jsonb `condiciones_modificadores` a `tienda_promociones`
// (promociones condicionadas por modificadores). Idempotente y NO destructivo:
// solo agrega una columna nullable; no toca ninguna fila.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '068_promo_condiciones_modificadores.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promociones`)).rows[0].n;

  console.log('[predeploy-068] Aplicando migrations/068_promo_condiciones_modificadores.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(`
    SELECT COUNT(*)::int AS col
      FROM information_schema.columns
     WHERE table_name='tienda_promociones' AND column_name='condiciones_modificadores'`);
  if (e.col !== 1) throw new Error('la columna condiciones_modificadores no quedó creada');

  const despues = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promociones`)).rows[0].n;
  if (antes !== despues) throw new Error(`la 068 alteró filas de promociones (${antes} → ${despues})`);

  console.log(`[predeploy-068] OK — columna condiciones_modificadores presente; ${despues} promociones intactas.`);
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-068] FALLÓ:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
