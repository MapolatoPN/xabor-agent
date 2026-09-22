// Pre-Deploy Command de Railway para la 088 exclusivamente.
//
// Agrega a cortes_caja tres columnas informativas (descuento_manual,
// descuento_promocional, rewards_canjeados). No toca pedidos_activos, no
// toca ventas ni caja_fondos, no cambia efectivo_esperado de ningún corte
// ya cerrado -- ALTER TABLE ... ADD COLUMN con DEFAULT 0 es seguro sobre
// una tabla con filas existentes.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '088_cortes_descuentos_promociones.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('[predeploy-088] Aplicando migrations/088_cortes_descuentos_promociones.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'cortes_caja' AND column_name = 'descuento_manual')::int      AS c_manual,
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'cortes_caja' AND column_name = 'descuento_promocional')::int AS c_promo,
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'cortes_caja' AND column_name = 'rewards_canjeados')::int     AS c_rewards`);
  if (e.c_manual < 1)  throw new Error('cortes_caja.descuento_manual no quedo creada');
  if (e.c_promo < 1)   throw new Error('cortes_caja.descuento_promocional no quedo creada');
  if (e.c_rewards < 1) throw new Error('cortes_caja.rewards_canjeados no quedo creada');

  const { rows: [r] } = await pool.query(`
    SELECT COUNT(*)::int AS cortes_existentes,
           COUNT(*) FILTER (WHERE descuento_manual > 0 OR descuento_promocional > 0 OR rewards_canjeados > 0)::int AS con_valor
      FROM cortes_caja`);
  console.log('[predeploy-088] Reporte:');
  console.log(`  cortes ya cerrados .............................. ${r.cortes_existentes}`);
  console.log(`  cortes con descuento/reward (siempre 0, backfill) ${r.con_valor}`);
  console.log('[predeploy-088] Verificacion OK.');
  process.exit(0);
} catch (err) {
  console.error('[predeploy-088] FALLO:', err.message);
  process.exit(1);
}
