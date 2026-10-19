// ─── El pedido de la tienda detrás de un token de seguimiento ──────────────
//
// Un pedido de la tienda vive en uno de dos sitios:
//   · pedidos_activos: el de hoy (y el programado durante su primer minuto);
//   · pedidos_programados (activado = FALSE): la RESERVA a la que el servidor
//     mueve todo pedido programado en menos de un minuto
//     (reconciliarConversionesProgramadasPendientes), con su estado en
//     datos.estado ('pendiente_pago', 'nuevo', 'cancelado'). A su hora vuelve
//     a pedidos_activos y la reserva queda activado = TRUE.
//
// Mirar solo pedidos_activos hacía que un programado pagado en línea pareciera,
// pasado ese minuto, un pedido "sin estado": el seguimiento lo daba por
// confirmado aunque nadie hubiera pagado, el botón de pagar dejaba de servir y
// la página de pago sacaba al cliente a mitad del cobro. Todas las lecturas de
// la tienda por token pasan por aquí.
import { pool } from './database.js';

const TOKEN_TRACKING = /^[a-f0-9]{48}$/;

/**
 * { negocio_id, pedido_folio, estado, datos, origen } o null si el token no
 * existe o aún no tiene pedido. `origen`: 'activo' | 'programado' | null.
 * No lanza por token inválido: devuelve null (cada llamador decide su 404).
 */
export async function pedidoDeTiendaPorToken(trackingToken) {
  const token = String(trackingToken || '').trim();
  if (!TOKEN_TRACKING.test(token)) return null;
  const { rows: [r] } = await pool.query(
    `SELECT tp.negocio_id, tp.pedido_folio,
            COALESCE(pa.estado, CASE WHEN pp.folio IS NOT NULL THEN COALESCE(NULLIF(pp.datos->>'estado', ''), 'nuevo') END) AS estado,
            COALESCE(pa.datos, pp.datos) AS datos,
            CASE WHEN pa.folio IS NOT NULL THEN 'activo' WHEN pp.folio IS NOT NULL THEN 'programado' END AS origen
       FROM tienda_pedidos tp
       LEFT JOIN pedidos_activos pa ON pa.folio = tp.pedido_folio AND pa.negocio_id = tp.negocio_id
       LEFT JOIN pedidos_programados pp ON pp.folio = tp.pedido_folio AND pp.negocio_id = tp.negocio_id
                                       AND pp.activado = FALSE AND pa.folio IS NULL
      WHERE tp.tracking_token = $1`, [token]);
  if (!r || !r.pedido_folio) return null;
  return { ...r, token };
}
