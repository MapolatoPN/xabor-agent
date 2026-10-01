// ¿El cliente escribió algo más mientras se atendía este lote?
//
// La continuidad deja esos mensajes pendientes para el siguiente turno, y ese
// turno publicará su propia pregunta: el formulario que este turno mandara
// nacería viejo. Incidente 1-oct-2026: la clienta abrió el carrito y a los
// 16 s el formulario le respondió «ya no está disponible», porque su dirección
// ya esperaba turno.
//
// Solo cuenta lo del MISMO cliente recibido después del inicio del lote. Sin
// lote identificable (simulaciones, replays) o sin lectura confiable no hay
// espera: se conserva el comportamiento anterior.
const TIPOS_QUE_ABREN_TURNO = ['text', 'interactive', 'button', 'image', 'document', 'order'];

export async function hayMensajesEnEspera(db, { negocioId, telefono, wamids } = {}) {
  if (!negocioId || !telefono || !Array.isArray(wamids) || !wamids.length) return false;
  try {
    const { rows: [r] } = await db.query(`SELECT EXISTS (
        SELECT 1 FROM whatsapp_entradas e
         WHERE e.negocio_id = $1 AND e.telefono = $2 AND e.estado = 'pendiente'
           AND NOT (e.wamid = ANY($3::text[]))
           AND e.payload->'message'->>'type' = ANY($4::text[])
           AND e.recibido_at >= (SELECT min(l.recibido_at) FROM whatsapp_entradas l
                                  WHERE l.negocio_id = $1 AND l.wamid = ANY($3::text[]))
      ) AS hay`, [negocioId, String(telefono), wamids.map(String), TIPOS_QUE_ABREN_TURNO]);
    return r?.hay === true;
  } catch (e) {
    console.error(`[AGENTE] no se pudo leer si hay mensajes en espera negocio=${negocioId}: ${e?.message}`);
    return false;
  }
}
