// Proyección de solo lectura para el panel. No concede permiso para responder
// ni modifica pausas, revisiones o el takeover de WhatsApp Business.
export async function obtenerEstadoAtencionConversacion(db, negocioId, telefono) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || typeof telefono !== 'string' || !telefono.trim()) {
    throw new Error('IDENTIDAD_CONVERSACION_REQUERIDA');
  }
  // Un único snapshot: no combinar el interruptor de un instante con una
  // pausa de otro. La excepción legacy NULL es SOLO de nonna-maye, igual
  // que getTakeoverHumanoActivo; jamás filtrar el takeover de otro negocio.
  const { rows: [r] } = await db.query(`
    SELECT n.bot_whatsapp_activo,
           COALESCE(c.bot_pausado, false) AS pausa_manual,
           COALESCE(w.requiere_revision, false) AS requiere_revision,
           w.motivo,
           cl.human_takeover_until AS takeover_hasta,
           COALESCE(cl.human_takeover_until > now(), false) AS takeover_vigente,
           now() AS consultado_en,
           (SELECT max(e.id)::text FROM whatsapp_entradas e
             WHERE e.negocio_id=n.id AND e.telefono=$2) AS ultima,
           (SELECT e.wamid FROM whatsapp_entradas e
             WHERE e.negocio_id=n.id AND e.telefono=$2 ORDER BY e.id DESC LIMIT 1) AS ultimo_wamid
      FROM negocios n
      LEFT JOIN conversaciones_control c ON c.negocio_id=n.id AND c.telefono=$2
      LEFT JOIN whatsapp_conversaciones w ON w.negocio_id=n.id AND w.telefono=$2
      LEFT JOIN clientes cl ON cl.telefono=$2
        AND (cl.negocio_id=n.id OR (n.slug='nonna-maye' AND cl.negocio_id IS NULL))
     WHERE n.id=$1`, [negocioId.trim(), telefono]);
  if (!r) throw new Error('NEGOCIO_NO_ENCONTRADO');
  return {
    // Compatibilidad: pausado sigue significando pausa manual/revisión.
    // No incluir takeover aquí: /reactivar NO quita el bloqueo temporal.
    pausado: r.pausa_manual || r.requiere_revision,
    pausaManual: r.pausa_manual,
    botWhatsappActivo: r.bot_whatsapp_activo === true,
    requiereRevision: r.requiere_revision,
    motivoRevision: r.motivo || null,
    hastaEntrada: r.ultima || null,
    ultimaEntradaWamid: r.ultimo_wamid || null,
    takeoverVigente: r.takeover_vigente,
    takeoverHasta: r.takeover_hasta || null,
    consultadoEn: r.consultado_en,
  };
}
