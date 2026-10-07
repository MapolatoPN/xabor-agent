import { disponibilidadAsistente } from './politicaAsistente.js';

// Diagnóstico del mismo motor que atiende WhatsApp. No expone teléfonos.
export function resumirEstadoBotPanel(activo, cfg, procesoActivo) {
  const agente = disponibilidadAsistente(cfg, procesoActivo);
  const piloto = agente.alcance === 'lista' || agente.porcentaje < 100;
  return { botWhatsappActivo: activo === true, motor: agente.motor,
    agenteDisponible: agente.listo, puedeActivar: agente.listo, motivo: agente.motivo,
    soloPrueba: piloto, telefonosPrueba: agente.telefonosPrueba,
    alcance: !agente.listo ? 'sin_disponibilidad' : piloto ? 'piloto' : 'todos',
    titulo: !activo ? 'Atención automática pausada' : !agente.listo ? 'Atención humana: agente no disponible' : piloto ? 'Piloto del agente nuevo activo' : 'Agente nuevo habilitado',
    detalle: !agente.listo
      ? 'El agente nuevo no está disponible o no tiene alcance válido. El motor anterior no atiende; las conversaciones pasan a revisión humana.'
      : `Motor: agente nuevo de herramientas. ${agente.alcance === 'lista' ? `Alcance: ${agente.telefonosPrueba} números autorizados.` : `Alcance: ${agente.porcentaje}% de los números.`} ${!activo ? 'La atención está pausada.' : 'Fuera de ese alcance atiende el personal.'}` };
}
export async function leerEstadoBotPanel(db,negocioId) {
  const {rows:[r]}=await db.query(`SELECT bot_whatsapp_activo AS activo,
    COALESCE((SELECT jsonb_object_agg(clave,valor) FROM configuracion WHERE negocio_id=n.id
      AND clave IN ('bot_whatsapp_solo_prueba','mesero_agente_telefonos','mesero_agente_v1','mesero_agente_porcentaje')),'{}'::jsonb) AS cfg
    FROM negocios n WHERE id=$1`,[negocioId]);
  if(!r)throw Error('NEGOCIO_NO_DISPONIBLE');
  return resumirEstadoBotPanel(r.activo,r.cfg);
}
