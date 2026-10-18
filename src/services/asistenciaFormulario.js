import { barrerasDeBotones,interactivosActivos } from '../mesero-agente/interactivos.js';
import { flowsActivos } from '../mesero-agente/formularioAgrupado.js';
import { eleccionesActivas } from '../mesero-agente/eleccionesInteractivas.js';
import { telefonoTransporte } from './estadosMensajeWhatsapp.js';

const normalizar=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

// Solo saludos y ofrecimientos de ayuda inequívocos conservan el Flow
// automáticamente. Cotizar, cobrar o recibir una orden toma el chat.
export function esAyudaSobreFormulario(texto) {
  const t=normalizar(texto);
  return /^(?:hola )?(?:buen(?:os)? dias|buenas tardes|buen dia|hola)$/.test(t)
    || /^(?:(?:hola )?(?:buen(?:os)? dias|buen dia|buenas tardes) )?(?:pudo|pudiste|pudieron) (?:hacer|realizar|terminar|completar) (?:su|tu|el) pedido$/.test(t)
    || /^(?:necesita|necesitas|requiere|requieres) ayuda (?:con|para) (?:su |tu |el )?(?:pedido|formulario)$/.test(t);
}

export async function resolverIntervencionHumana({db,negocioId,telefono,texto,modo='auto'}) {
  if(!['auto','manual','ayuda_formulario'].includes(modo))return {ok:false,codigo:'MODO_INVALIDO'};
  if(modo==='manual' || modo==='auto' && !esAyudaSobreFormulario(texto))return {ok:true,modo:'manual'};
  try {
    const tel=telefonoTransporte(telefono);
    if(!/^\d{10,15}$/.test(tel))return {ok:modo!=='ayuda_formulario',modo:'manual',codigo:'SIN_FORMULARIO'};
    const b=await barrerasDeBotones(db,negocioId,tel);
    if(b.activo && flowsActivos(b.cfg,tel) && interactivosActivos(b.cfg) && eleccionesActivas(b.cfg)){
      const {rows:[q]}=await db.query({text:`SELECT q.id FROM agente_preguntas_interactivas q
        JOIN agente_outbox o ON o.evento_clave=q.outbox_clave
        JOIN conversacion_estado s ON s.negocio_id=q.negocio_id AND s.session_id=q.session_id
        WHERE q.negocio_id=$1 AND q.session_id=$2 AND q.estado='disponible'
          AND q.created_at>clock_timestamp()-interval '30 minutes'
          AND o.estado='entregado' AND o.wamid_salida IS NOT NULL
          AND q.ciclo=s.estado->>'conversacionId' AND q.dialogo_id=s.estado->'pendiente'->>'dialogo_id'
          AND COALESCE(s.estado->>'folio','')='' AND COALESCE(s.estado->>'evento','')=''
          AND NOT COALESCE((s.estado->>'confirmacionIncierta')::boolean,false)
          AND NOT EXISTS(SELECT 1 FROM jsonb_each(COALESCE(s.estado->'hechos','{}'::jsonb)) h WHERE h.value='true'::jsonb)
          AND EXISTS(SELECT 1 FROM agente_botones bt WHERE bt.pregunta_id=q.id
            AND bt.datos->>'version' IN ('tienda_v1','carrito_v1','repetible_v1'))
          AND NOT EXISTS(SELECT 1 FROM whatsapp_entradas e WHERE e.negocio_id=q.negocio_id AND e.telefono=$3
            AND e.recibido_at>q.created_at AND e.payload->'message'->>'type' IN ('text','image','document','order'))
        ORDER BY q.created_at DESC LIMIT 1`,values:[negocioId,`agente:${tel}`,tel],query_timeout:2000});
      if(q)return {ok:true,modo:'ayuda_formulario'};
    }
  } catch(error) {
    console.warn(`[ASISTENCIA_FORMULARIO] lectura_no_verificada codigo=${error?.code || 'sin_codigo'}`);
  }
  return modo==='ayuda_formulario'?{ok:false,codigo:'SIN_FORMULARIO'}:{ok:true,modo:'manual'};
}
