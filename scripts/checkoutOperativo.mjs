// Una reserva cerrada por vencimiento no debe volver a cocina ni al tablero.
// Se exige evidencia durable del cierre y ausencia de pago; el resto sigue bloqueando.
export const CHECKOUTS_SIN_PEDIDO_SQL = `
  SELECT tp.pedido_folio
    FROM tienda_pedidos tp
    LEFT JOIN pedidos_activos pa ON pa.negocio_id=tp.negocio_id AND pa.folio=tp.pedido_folio
   WHERE tp.negocio_id=$1 AND tp.pedido_folio IS NOT NULL
     AND tp.created_at >= now() - interval '48 hours' AND pa.folio IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM pedidos_programados pp
        WHERE pp.negocio_id=tp.negocio_id AND pp.folio=tp.pedido_folio
          AND pp.programado_id IS NOT NULL AND pp.activado=TRUE
          AND pp.datos->>'estado'='cancelado' AND pp.datos->>'expirado_por_pago'='true'
          AND NOT EXISTS (
            SELECT 1 FROM pagos p WHERE p.negocio_id=tp.negocio_id
              AND p.pedido_folio=tp.pedido_folio AND p.estado='pagado'
          )
     )
   LIMIT 10`;

export async function checkoutsSinPedidoOperativo(db, negocioId) {
  return (await db.query(CHECKOUTS_SIN_PEDIDO_SQL, [negocioId])).rows;
}
