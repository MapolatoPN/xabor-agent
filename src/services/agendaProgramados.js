// Agenda de consulta: incluye la reserva y su representación activa sin crear
// pedidos, trabajos de impresión ni efectos de pago.
export async function consultarAgendaProgramados(db, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await db.query(`
    WITH agenda AS (
      SELECT r.folio, r.negocio_id, r.programado_id, r.datos,
             r.programado_para AT TIME ZONE 'UTC' AS programado_para,
             false AS activado, false AS preferir_activo, COALESCE(r.datos->>'estado','nuevo') AS estado
        FROM pedidos_programados r
       WHERE r.negocio_id=$1 AND r.activado=false
         AND COALESCE(r.datos->>'estado','nuevo') NOT IN ('cancelado','entregado')
      UNION ALL
      SELECT p.folio, p.negocio_id, r.programado_id, p.datos,
             r.programado_para AT TIME ZONE 'UTC' AS programado_para,
             COALESCE(r.activado,false) AS activado, true AS preferir_activo, p.estado
        FROM pedidos_activos p
        LEFT JOIN pedidos_programados r ON r.negocio_id=p.negocio_id AND r.folio=p.folio
       WHERE p.negocio_id=$1 AND p.estado IN ('pendiente_pago','nuevo','en_preparacion','listo')
         AND NULLIF(p.datos->>'programado_para','') IS NOT NULL
    )
    SELECT DISTINCT ON (folio) * FROM agenda ORDER BY folio, preferir_activo DESC`, [negocioId.trim()]);
  return rows.sort((a,b) => {
    const fecha = r => Date.parse(r.datos?.programado_para || r.programado_para) || Number.MAX_SAFE_INTEGER;
    return fecha(a)-fecha(b) || a.folio.localeCompare(b.folio);
  });
}
