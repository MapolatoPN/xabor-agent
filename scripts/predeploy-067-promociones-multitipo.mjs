// Pre-Deploy Command de Railway para la 067 exclusivamente.
//
// Extiende `tienda_promociones` con los tipos per-unit '2x1' y
// 'segundo_descuento' + su cardinalidad. Idempotente y NO destructivo: solo
// amplía CHECKs y agrega columnas nullable. No toca ninguna fila de
// promociones ni de pedidos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '067_promociones_multitipo.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promociones`)).rows[0].n;

  console.log('[predeploy-067] Aplicando migrations/067_promociones_multitipo.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  // Verificación: las 3 columnas nuevas existen y el CHECK admite los tipos.
  const { rows: [e] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name='tienda_promociones'
          AND column_name IN ('cantidad_requerida','cantidad_beneficiada','max_aplicaciones'))::int AS cols,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='chk_promo_tipo') AS tipo_check`);
  if (e.cols < 3) throw new Error('faltan columnas de cardinalidad (cantidad_requerida/beneficiada/max_aplicaciones)');
  if (!/2x1/.test(e.tipo_check || '') || !/segundo_descuento/.test(e.tipo_check || '')) {
    throw new Error("chk_promo_tipo no admite '2x1'/'segundo_descuento'");
  }

  const despues = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promociones`)).rows[0].n;
  if (despues !== antes) throw new Error(`el conteo de promociones cambio (${antes} -> ${despues}): la migracion NO debe tocar datos`);

  console.log(`[predeploy-067] Verificacion OK. ${despues} promociones intactas, 3 columnas nuevas, tipos ampliados.`);
  process.exit(0);
} catch (err) {
  console.error('[predeploy-067] FALLO:', err.message);
  process.exit(1);
}
