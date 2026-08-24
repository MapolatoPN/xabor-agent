// Pre-Deploy Command de Railway para la 064 exclusivamente.
//
// Cortes de caja como cierres históricos: tablas cortes_caja y
// movimientos_caja. No toca ni una fila de pedidos, pagos ni caja_fondos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '064_cortes_caja.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('[predeploy-064] Aplicando migrations/064_cortes_caja.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='cortes_caja')::int      AS t_cortes,
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='movimientos_caja')::int AS t_movs,
      (SELECT COUNT(*) FROM pg_indexes WHERE indexname='uq_cortes_caja_negocio_fecha')::int     AS uq_fecha,
      (SELECT COUNT(*) FROM pg_indexes WHERE indexname='uq_cortes_caja_negocio_folio')::int     AS uq_folio`);
  if (e.t_cortes < 1) throw new Error('cortes_caja no quedo creada');
  if (e.t_movs < 1) throw new Error('movimientos_caja no quedo creada');
  // El UNIQUE por (negocio, fecha) es lo que impide dos cortes del mismo dia
  // aunque dos peticiones lleguen a la vez: sin el, la idempotencia del
  // cierre seria solo una promesa de la aplicacion.
  if (e.uq_fecha < 1) throw new Error('falta el indice unico (negocio_id, fecha_operativa)');
  if (e.uq_folio < 1) throw new Error('falta el indice unico de folio por negocio');

  const { rows: [r] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM cortes_caja)::int       AS cortes_existentes,
      (SELECT COUNT(*) FROM movimientos_caja)::int  AS movimientos_existentes,
      (SELECT COUNT(*) FROM caja_fondos)::int       AS fondos_registrados`);
  console.log('[predeploy-064] Reporte:');
  console.log(`  cortes ya cerrados ......... ${r.cortes_existentes}`);
  console.log(`  movimientos de caja ........ ${r.movimientos_existentes}`);
  console.log(`  fondos iniciales (legacy) .. ${r.fondos_registrados}`);
  console.log('[predeploy-064] Verificacion OK.');
  process.exit(0);
} catch (err) {
  console.error('[predeploy-064] FALLO:', err.message);
  process.exit(1);
}
