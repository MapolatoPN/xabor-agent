// Una reserva futura aún no pertenece al tablero de pedidos activos.
// Debe conservar identidad durable y seguir pendiente de su hora de activación.
const PROGRAMADO_FUTURO = `pp.programado_id IS NOT NULL AND pp.activado=FALSE
  AND pp.programado_para > now() AND pp.datos->>'estado' IN ('nuevo','pendiente_pago')`;

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
          AND ${PROGRAMADO_FUTURO}
     )
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

export async function pagosSinPedidoOperativo(db, negocioId) {
  return (await db.query(`
    SELECT p.pedido_folio, pa.estado
      FROM pagos p
      LEFT JOIN pedidos_activos pa ON pa.negocio_id=p.negocio_id AND pa.folio=p.pedido_folio
     WHERE p.negocio_id=$1 AND p.estado='pagado' AND p.created_at >= now()-interval '48 hours'
       AND (pa.folio IS NULL OR pa.estado='pendiente_pago'
         OR COALESCE((pa.datos->>'pago_confirmado')::boolean,FALSE)=FALSE)
       AND NOT EXISTS (
         SELECT 1 FROM pedidos_programados pp
          WHERE pa.folio IS NULL AND pp.negocio_id=p.negocio_id AND pp.folio=p.pedido_folio
            AND ${PROGRAMADO_FUTURO}
            AND COALESCE((pp.datos->>'pago_confirmado')::boolean,FALSE)=TRUE
       )
     LIMIT 10`, [negocioId])).rows;
}
