// ─── Vencimiento de puntos de Rewards (saneamiento, fase 3, punto 15) ─────
//
// «Vencimiento de puntos configurable (meses sin compra), apagado de
// entrada.» Se configura en Rewards → Config; se guarda en
// rewards_config.vigencia_dias (meses × 30) y nace en NULL: apagado.
//
// LO QUE ESTE MÓDULO GARANTIZA:
//
//   · Apagado no vence nada. Sin vigencia_dias, con el programa en pausa o sin
//     el módulo contratado, no se toca ni un punto.
//   · El plazo nunca cuenta desde antes de encenderlo. «Meses sin compra» se
//     mide desde la fecha más reciente entre la última compra (acumulación o
//     canje), la inscripción y rewards_config.vigencia_desde (el día en que se
//     encendió el vencimiento o se reanudó el programa). Encender el
//     vencimiento con 6 meses NO vence a nadie hasta dentro de 6 meses.
//   · Solo cuentas INSCRITAS. Las «sin inscribir» (nacidas al comprar antes
//     de la fase 3) no se tocan: Mario decide qué hacer con ellas.
//   · Queda en el libro: un movimiento 'expiracion' por cuenta, con el saldo
//     anterior y el posterior. Idempotente: tras vencer, el saldo es 0 y la
//     siguiente pasada no encuentra nada.
//   · En segundo plano, nunca en el camino de una venta, y con su propio
//     catch: un fallo aquí no tumba nada.
import { pool, obtenerEstadoModulo } from './database.js';

const ESTADOS_DISPONIBLES = ['activo', 'configurado'];

// Las cuentas que vencen HOY en un negocio: inscritas, activas, con saldo y
// sin compra dentro del plazo.
const SQL_VENCIDAS = `
  SELECT a.id
    FROM rewards_accounts a
    JOIN rewards_config c ON c.tenant_id = a.tenant_id
   WHERE a.tenant_id = $1 AND a.activo AND a.inscrito_at IS NOT NULL AND a.puntos_balance > 0
     AND c.activo AND c.vigencia_dias > 0 AND c.vigencia_desde IS NOT NULL
     AND GREATEST(
           c.vigencia_desde,
           a.inscrito_at,
           COALESCE((SELECT max(m.created_at) FROM rewards_movements m
                      WHERE m.account_id = a.id AND m.tipo IN ('acumulacion', 'canje')), a.inscrito_at)
         ) < $2::timestamptz - make_interval(days => c.vigencia_dias)
   ORDER BY a.id
   LIMIT $3`;

async function vencerCuenta(tenantId, accountId, ahora) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Se vuelve a comprobar con la fila tomada: entre la lista y este
    // momento pudo entrar una compra.
    const { rows: [sigue] } = await client.query(
      `${SQL_VENCIDAS.replace('ORDER BY a.id', 'AND a.id = $4 ORDER BY a.id')} FOR UPDATE OF a`,
      [tenantId, ahora, 1, accountId]);
    if (!sigue) { await client.query('ROLLBACK'); return null; }
    const { rows: [cuenta] } = await client.query('SELECT * FROM rewards_accounts WHERE id = $1', [accountId]);
    const { rows: [cfg] } = await client.query('SELECT vigencia_dias, vigencia_desde FROM rewards_config WHERE tenant_id = $1', [tenantId]);
    const saldo = parseInt(cuenta.puntos_balance, 10) || 0;
    await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior, folio_venta, usuario, motivo, metadata)
       VALUES ($1, $2, 'expiracion', $3, $4, 0, NULL, 'sistema', $5, $6)`,
      [cuenta.id, tenantId, -saldo, saldo,
        `Vencimiento: ${Math.round(cfg.vigencia_dias / 30)} meses sin compra`,
        JSON.stringify({ vigencia_dias: cfg.vigencia_dias, vigencia_desde: cfg.vigencia_desde })]);
    await client.query(
      'UPDATE rewards_accounts SET puntos_balance = 0, updated_at = NOW() WHERE id = $1', [cuenta.id]);
    await client.query('COMMIT');
    return saldo;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Una pasada de vencimiento. `ahora` y `negocioId` (un solo negocio) existen
 * para las pruebas; el job pasa sin ellos. Devuelve { cuentas, puntos }
 * vencidos en total.
 */
export async function vencerPuntos({ ahora = new Date(), limite = 200, negocioId = null } = {}) {
  const fecha = ahora instanceof Date ? ahora.toISOString() : String(ahora);
  const { rows: negocios } = await pool.query(
    `SELECT tenant_id FROM rewards_config
      WHERE activo AND vigencia_dias > 0 AND vigencia_desde IS NOT NULL
        AND ($1::text IS NULL OR tenant_id = $1::text)`, [negocioId == null ? null : String(negocioId)]);
  let cuentas = 0, puntos = 0;
  for (const { tenant_id: tenantId } of negocios) {
    try {
      const estado = await obtenerEstadoModulo(tenantId, 'rewards');
      if (!ESTADOS_DISPONIBLES.includes(estado)) continue;
      const { rows } = await pool.query(SQL_VENCIDAS, [tenantId, fecha, limite]);
      for (const { id } of rows) {
        const vencidos = await vencerCuenta(tenantId, id, fecha);
        if (vencidos) { cuentas++; puntos += vencidos; }
      }
    } catch (e) {
      console.error(`[Rewards] Vencimiento falló en ${tenantId}: ${e.message}`);
    }
  }
  if (cuentas) console.log(`[Rewards] Vencimiento: ${puntos} pts de ${cuentas} cuenta(s) sin compra dentro del plazo`);
  return { cuentas, puntos };
}
