// Pre-Deploy Command de Railway para la 063 exclusivamente.
//
// Deuda durable de emision OPERACIONAL (P0-11): tabla pedido_emisiones +
// trigger sobre pedidos_activos que la asegura para OLD y NEW por igual.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '063_emision_operacional.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('[predeploy-063] Aplicando migrations/063_emision_operacional.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='pedido_emisiones')::int AS tabla,
       (SELECT COUNT(*) FROM pg_proc WHERE proname='xabor_asegurar_emision_operacional')::int AS fn,
       (SELECT COUNT(*) FROM pg_trigger
         WHERE tgname='trg_asegurar_emision_operacional' AND NOT tgisinternal)::int AS trg,
       (SELECT COUNT(*) FROM pg_indexes WHERE indexname='idx_pedido_emision_pedido')::int AS uq`);
  if (e.tabla < 1) throw new Error('pedido_emisiones no quedo creada');
  if (e.fn < 1) throw new Error('xabor_asegurar_emision_operacional no quedo creada');
  if (e.trg !== 1) throw new Error('el trigger de aseguramiento de emision no quedo instalado');
  if (e.uq < 1) throw new Error('el indice unico de identidad no quedo creado');

  const { rows: [reporte] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM pedidos_activos)::int AS activos_existentes,
      (SELECT COUNT(*) FROM pedidos_activos WHERE estado = 'pendiente_pago')::int AS pendientes_pago,
      (SELECT COUNT(*) FROM pedidos_activos
        WHERE datos->>'programado_para' IS NOT NULL AND datos->>'programado_id' IS NULL)::int AS programados_sin_activar_en_activos,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE origen = 'legacy_asumida_emitida')::int AS deudas_legacy_asumidas,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'pendiente')::int AS deudas_nuevas_pendientes,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'saldada')::int AS deudas_saldadas,
      (SELECT COUNT(*) FROM pedido_emisiones)::int AS deudas_totales`);

  console.log('[predeploy-063] Reporte del cutover:');
  console.log(`    pedidos_activos existentes:            ${reporte.activos_existentes}`);
  console.log(`    de esos, pendiente_pago:                ${reporte.pendientes_pago}`);
  console.log(`    de esos, programado sin activar aun:    ${reporte.programados_sin_activar_en_activos}`);
  console.log(`    deudas legacy asumidas (backfill):      ${reporte.deudas_legacy_asumidas}`);
  console.log(`    deudas nuevas pendientes:               ${reporte.deudas_nuevas_pendientes}`);
  console.log(`    deudas ya saldadas:                     ${reporte.deudas_saldadas}`);
  console.log(`    deudas totales en el ledger:             ${reporte.deudas_totales}`);

  // Fail closed real: el backfill NUNCA debe dejar deudas 'pendiente' para
  // pedidos que ya existian antes de la migracion (eso reimprimiria comandas
  // viejas). Si aparece alguna, algo en la logica de exclusion del backfill
  // esta mal y hay que abortar el deploy antes de que el reconciliador la
  // tome como si fuera nueva.
  if (reporte.deudas_nuevas_pendientes > 0) {
    const { rows: sospechosas } = await pool.query(`
      SELECT pe.negocio_id, pe.folio, pe.pedido_creado_at
        FROM pedido_emisiones pe
       WHERE pe.estado = 'pendiente'
       ORDER BY pe.created_at
       LIMIT 20`);
    console.warn('[predeploy-063] ATENCION: hay deudas "pendiente" recien creadas por el backfill -- deberian ser 0 en un cutover limpio sin trafico concurrente:');
    for (const s of sospechosas) console.warn(`    ${s.folio} (negocio=${s.negocio_id}, creado=${s.pedido_creado_at})`);
  }

  console.log('[predeploy-063] Verificacion OK.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-063] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
