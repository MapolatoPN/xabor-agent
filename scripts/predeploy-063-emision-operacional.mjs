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
      (SELECT COUNT(*) FROM pedido_emisiones WHERE origen = 'legacy_nuevo_no_verificado')::int AS deudas_legacy_nuevo_pendientes,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE origen = 'trigger' AND estado = 'pendiente')::int AS deudas_trigger_pendientes,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'pendiente')::int AS deudas_pendientes_totales,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'saldada')::int AS deudas_saldadas,
      (SELECT COUNT(*) FROM pedido_emisiones)::int AS deudas_totales,
      (SELECT COUNT(*) FROM pedido_emisiones
        WHERE origen NOT IN ('trigger', 'legacy_asumida_emitida', 'legacy_nuevo_no_verificado'))::int AS deudas_origen_desconocido`);

  console.log('[predeploy-063] Reporte del cutover:');
  console.log(`    pedidos_activos existentes:                  ${reporte.activos_existentes}`);
  console.log(`    de esos, pendiente_pago (sin deuda, normal):  ${reporte.pendientes_pago}`);
  console.log(`    de esos, programado sin activar (sin deuda):  ${reporte.programados_sin_activar_en_activos}`);
  console.log(`    deudas legacy asumidas emitidas (backfill A): ${reporte.deudas_legacy_asumidas}`);
  console.log(`    deudas legacy 'nuevo' no verificado (backfill B, P0-11C): ${reporte.deudas_legacy_nuevo_pendientes}`);
  console.log(`    de esas, pendientes creadas por el TRIGGER (trafico concurrente durante el cutover): ${reporte.deudas_trigger_pendientes}`);
  console.log(`    pendientes totales (ambos origenes, EJECUTABLES por el reconciliador de NEW): ${reporte.deudas_pendientes_totales}`);
  console.log(`    deudas ya saldadas:                           ${reporte.deudas_saldadas}`);
  console.log(`    deudas totales en el ledger:                  ${reporte.deudas_totales}`);

  // Semantica real (P0-11C, auditoria independiente corrigio el contrato
  // anterior -- el comentario decia "fail closed" pero el codigo solo
  // hacia console.warn y seguia a exit 0, una discrepancia real entre lo
  // documentado y lo que de verdad pasaba):
  //
  //   · deudas_trigger_pendientes > 0 -- ESPERADO y SANO durante un cutover
  //     con trafico concurrente (P0-15): el trigger protegio pedidos que
  //     OLD sigue aceptando mientras el binario nuevo arranca. El
  //     reconciliador de NEW las salda solo, sin intervencion. NO es una
  //     anomalia -- nunca se aborta por esto.
  //
  //   · deudas_legacy_nuevo_pendientes > 0 -- ESPERADO (P0-11C): pedidos
  //     preexistentes que se quedaron en 'nuevo' sin avanzar, backfill los
  //     marca pendientes A PROPOSITO para que el reconciliador de NEW los
  //     revise -- ver el comentario de la migracion 063. Tampoco es una
  //     anomalia.
  //
  //   · deudas_origen_desconocido > 0 -- ESTO SI es una anomalia real: la
  //     migracion produjo una fila con un origen que ningun camino conocido
  //     del codigo genera. Aborta el deploy: algo en la logica de la 063
  //     cambio sin que este script se haya actualizado para reconocerlo.
  if (reporte.deudas_origen_desconocido > 0) {
    const { rows: sospechosas } = await pool.query(`
      SELECT pe.negocio_id, pe.folio, pe.pedido_creado_at, pe.origen, pe.estado
        FROM pedido_emisiones pe
       WHERE pe.origen NOT IN ('trigger', 'legacy_asumida_emitida', 'legacy_nuevo_no_verificado')
       ORDER BY pe.created_at
       LIMIT 20`);
    console.error('[predeploy-063] FALLO REAL -- deudas con origen desconocido (ni trigger, ni ninguno de los dos backfills):');
    for (const s of sospechosas) console.error(`    ${s.folio} (negocio=${s.negocio_id}, creado=${s.pedido_creado_at}, origen=${s.origen}, estado=${s.estado})`);
    throw new Error(`${reporte.deudas_origen_desconocido} deuda(s) con origen desconocido -- se aborta el deploy`);
  }

  console.log('[predeploy-063] Verificacion OK.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-063] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
