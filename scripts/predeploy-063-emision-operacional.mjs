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
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'requiere_revision')::int AS deudas_requiere_revision,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE origen = 'legacy_revisado_manual')::int AS deudas_legacy_resueltas_manualmente,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE origen = 'trigger' AND estado = 'pendiente')::int AS deudas_trigger_pendientes,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'pendiente')::int AS deudas_pendientes_totales,
      (SELECT COUNT(*) FROM pedido_emisiones WHERE estado = 'saldada')::int AS deudas_saldadas,
      (SELECT COUNT(*) FROM pedido_emisiones)::int AS deudas_totales,
      (SELECT COUNT(*) FROM pedido_emisiones
        WHERE origen NOT IN ('trigger', 'legacy_asumida_emitida', 'legacy_ambiguo_no_verificado', 'legacy_revisado_manual'))::int AS deudas_origen_desconocido`);

  console.log('[predeploy-063] Reporte del cutover:');
  console.log(`    pedidos_activos existentes:                  ${reporte.activos_existentes}`);
  console.log(`    de esos, pendiente_pago (sin deuda, normal):  ${reporte.pendientes_pago}`);
  console.log(`    de esos, programado sin activar (sin deuda):  ${reporte.programados_sin_activar_en_activos}`);
  console.log(`    deudas legacy asumidas emitidas (backfill A, terminal): ${reporte.deudas_legacy_asumidas}`);
  console.log(`    deudas legacy AMBIGUAS sin resolver (backfill B, P0-11D, BLOQUEAN el deploy): ${reporte.deudas_requiere_revision}`);
  console.log(`    de esas, ya resueltas a mano (legacy_revisado_manual):        ${reporte.deudas_legacy_resueltas_manualmente}`);
  console.log(`    de las pendientes EJECUTABLES, cuantas vinieron del TRIGGER (trafico concurrente durante el cutover): ${reporte.deudas_trigger_pendientes}`);
  console.log(`    pendientes totales (EJECUTABLES por el reconciliador de NEW): ${reporte.deudas_pendientes_totales}`);
  console.log(`    deudas ya saldadas:                           ${reporte.deudas_saldadas}`);
  console.log(`    deudas totales en el ledger:                  ${reporte.deudas_totales}`);

  // Semantica real (P0-11D corrige la semantica de P0-11C, que a su vez
  // corrigio un contrato roto: el comentario original decia "fail closed"
  // pero el codigo solo hacia console.warn y seguia a exit 0):
  //
  //   · deudas_trigger_pendientes > 0 -- ESPERADO y SANO durante un cutover
  //     con trafico concurrente (P0-15): el trigger protegio pedidos que
  //     OLD sigue aceptando mientras el binario nuevo arranca. El
  //     reconciliador de NEW las salda solo, sin intervencion. NO es una
  //     anomalia -- nunca se aborta por esto.
  //
  //   · deudas_requiere_revision > 0 -- ESTO SI bloquea el deploy (P0-11D).
  //     Un pedido legacy no terminal (nuevo/en_preparacion/listo) sin
  //     evidencia inequivoca de emision -- ver el comentario de la
  //     migracion 063 -- NUNCA se auto-ejecuta ni se asume saldado. La
  //     tabla y el trigger YA quedaron instalados arriba (protegiendo todo
  //     pedido NUEVO desde este instante), asi que reintentar este script
  //     mas tarde -- tras resolver cada fila con
  //     scripts/resolver-legacy-ambiguo-063.mjs -- es seguro y no vuelve a
  //     tocar lo que ya se resolvio (ON CONFLICT DO NOTHING). Esto NO es
  //     "esperar a que probablemente ya se resolviera solo": es un gate
  //     que exige una decision humana explicita y auditada por fila.
  //
  //   · deudas_origen_desconocido > 0 -- anomalia real: la migracion
  //     produjo una fila con un origen que ningun camino conocido del
  //     codigo genera. Aborta el deploy: algo en la logica de la 063
  //     cambio sin que este script se haya actualizado para reconocerlo.
  if (reporte.deudas_origen_desconocido > 0) {
    const { rows: sospechosas } = await pool.query(`
      SELECT pe.negocio_id, pe.folio, pe.pedido_creado_at, pe.origen, pe.estado
        FROM pedido_emisiones pe
       WHERE pe.origen NOT IN ('trigger', 'legacy_asumida_emitida', 'legacy_ambiguo_no_verificado', 'legacy_revisado_manual')
       ORDER BY pe.created_at
       LIMIT 20`);
    console.error('[predeploy-063] FALLO REAL -- deudas con origen desconocido (ningun camino conocido de la 063 las genera):');
    for (const s of sospechosas) console.error(`    ${s.folio} (negocio=${s.negocio_id}, creado=${s.pedido_creado_at}, origen=${s.origen}, estado=${s.estado})`);
    throw new Error(`${reporte.deudas_origen_desconocido} deuda(s) con origen desconocido -- se aborta el deploy`);
  }

  if (reporte.deudas_requiere_revision > 0) {
    const { rows: ambiguas } = await pool.query(`
      SELECT pe.negocio_id, pe.folio, pe.pedido_creado_at, pa.estado AS estado_actual_pedido
        FROM pedido_emisiones pe
        LEFT JOIN pedidos_activos pa ON pa.negocio_id = pe.negocio_id AND pa.folio = pe.folio
       WHERE pe.estado = 'requiere_revision'
       ORDER BY pe.created_at
       LIMIT 20`);
    console.error('[predeploy-063] FALLO REAL (P0-11D) -- pedidos legacy AMBIGUOS sin resolver, el deploy queda bloqueado:');
    for (const a of ambiguas) console.error(`    ${a.folio} (negocio=${a.negocio_id}, creado=${a.pedido_creado_at}, estado_actual=${a.estado_actual_pedido ?? '(ya no esta en pedidos_activos)'})`);
    console.error('[predeploy-063] La tabla y el trigger de la 063 YA quedaron instalados -- todo pedido NUEVO desde ahora esta protegido.');
    console.error('[predeploy-063] Resuelve cada fila con scripts/resolver-legacy-ambiguo-063.mjs y vuelve a correr este script.');
    throw new Error(`${reporte.deudas_requiere_revision} deuda(s) legacy ambigua(s) sin resolver -- se aborta el deploy`);
  }

  console.log('[predeploy-063] Verificacion OK.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-063] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
