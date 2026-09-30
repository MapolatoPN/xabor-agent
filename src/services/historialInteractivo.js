// Proyección de evidencias del servidor. Nunca devuelve response_json, tokens,
// IDs de formularios o el borrador no enviado. Las fichas de servicios usan la 108.
import { resumenServicio } from '../mesero-agente/inicioMapo.js';
import { seguimientoFormulario,vistaFormularioEnviado } from './seguimientoFormulario.js';
export async function enriquecerHistorialInteractivo(db,negocioId,telefono,mensajes) {
  const ids=mensajes.filter(m=>m.negocio_id===negocioId && m.telefono===telefono && m.message_id_externo).map(m=>m.message_id_externo);
  if(!ids.length)return mensajes;
  const {rows:salidas}=await db.query(`SELECT wamid_salida AS wamid,carga->'interactivo'->'action'->'parameters'->>'flow_cta' AS titulo
    FROM agente_outbox WHERE negocio_id=$1 AND carga->>'telefono'=$2 AND wamid_salida=ANY($3::text[])
      AND estado='entregado' AND carga->'interactivo'->>'type'='flow' AND NOT carga ? 'texto_enviado'`,[negocioId,telefono,ids]);
  const {rows:entradas}=await db.query(`SELECT e.wamid,e.estado AS entrada_estado,q.estado,q.resultado,q.comando->>'accion' AS accion,
      o.carga->>'texto' AS resumen
    FROM whatsapp_entradas e LEFT JOIN agente_preguntas_interactivas q
      ON q.negocio_id=e.negocio_id AND q.session_id='agente:' || e.telefono AND q.comando->>'wamid'=e.wamid
    LEFT JOIN agente_outbox o ON o.negocio_id=e.negocio_id AND o.evento_clave=q.respuesta_clave AND o.carga->>'telefono'=e.telefono
    WHERE e.negocio_id=$1 AND e.telefono=$2 AND e.wamid=ANY($3::text[])
      AND e.payload->'message'->'interactive'->>'type'='nfm_reply'`,[negocioId,telefono,ids]);
  const info=new Map(salidas.map(r=>[r.wamid,{tipo:'formulario',titulo:'Formulario enviado',detalle:String(r.titulo || 'Abrir formulario').slice(0,100)}]));
  if(salidas.length) {
    // El teléfono/negocio vienen de la ruta autenticada, nunca del token de
    // un formulario. Solo snapshots ligados a mensajes de este historial.
    const {rows:fotos}=await db.query(`SELECT o.wamid_salida AS wamid,q.estado,q.resultado,q.created_at,
        q.comando->>'wamid' AS respuesta_recibida,b.datos,
        f.contenido->>'etapa' AS etapa,f.contenido->>'revision' AS revision,f.actualizado_at,
        COALESCE(q.ciclo=c.estado->>'conversacionId' AND q.dialogo_id=c.estado->'pendiente'->>'dialogo_id',false) AS vigente_dialogo,
        clock_timestamp() AS ahora
      FROM agente_outbox o JOIN agente_preguntas_interactivas q
        ON q.negocio_id=o.negocio_id AND q.outbox_clave=o.evento_clave
      JOIN agente_botones b ON b.pregunta_id=q.id
      LEFT JOIN agente_flows_borradores f ON f.pregunta_id=q.id
      LEFT JOIN conversacion_estado c ON c.negocio_id=q.negocio_id AND c.session_id=q.session_id
      WHERE o.negocio_id=$1 AND o.carga->>'telefono'=$2 AND q.session_id='agente:' || $2
        AND o.wamid_salida=ANY($3::text[]) AND b.accion IN ('flow_productos','flow_configurar')`,
      [negocioId,telefono,salidas.map(s=>s.wamid)]);
    // Compatible con reversión previa a la 110: se conserva evidencia del
    // borrador, sin inventar una hora de apertura. Nunca se persiste al leer.
    let actividad=[];
    if(fotos.length)try {
      actividad=(await db.query(`SELECT o.wamid_salida AS wamid,a.tipo,a.paso,a.revision,a.observado_at
        FROM agente_actividad_formulario a JOIN agente_preguntas_interactivas q ON q.id=a.pregunta_id
        JOIN agente_outbox o ON o.negocio_id=q.negocio_id AND o.evento_clave=q.outbox_clave
        WHERE q.negocio_id=$1 AND q.session_id='agente:' || $2 AND o.carga->>'telefono'=$2
          AND o.wamid_salida=ANY($3::text[]) AND a.observado_at>now()-interval '30 days'
        ORDER BY a.observado_at`,[negocioId,telefono,salidas.map(s=>s.wamid)])).rows;
    } catch(e) {if(e.code!=='42P01')throw e;}
    for(const f of fotos)if(info.has(f.wamid))Object.assign(info.get(f.wamid),{
      seguimiento:seguimientoFormulario({...f,eventos:actividad.filter(a=>a.wamid===f.wamid)},
        {ahora:new Date(f.ahora).getTime()}),vistaEnviada:vistaFormularioEnviado(f.datos)});
  }
  for(const r of entradas) {
    const aplicada=r.estado==='terminada' && r.resultado?.formulario_aplicado===true && !r.resultado?.avisada;
    const rechazada=r.resultado?.formulario_aplicado===false || r.resultado?.avisada || ['aviso','texto'].includes(r.accion);
    info.set(r.wamid,{tipo:'formulario',titulo:aplicada?'Cambios guardados':rechazada?'Formulario no aplicado'
      :r.estado==='incierta' || r.entrada_estado==='revision'?'Requiere revisión':r.estado==='terminada'?'Formulario procesado'
        :r.entrada_estado==='completado'?'Respuesta sin cambio verificado':'Formulario recibido',
      detalle:aplicada?'Xabor validó y guardó la respuesta. Esto no confirma ni cobra el pedido.':rechazada?'La respuesta no modificó el pedido.'
        :r.estado==='terminada'?'Consulta la respuesta del bot para conocer el resultado.':r.entrada_estado==='completado'
          ?'No hay evidencia de una nueva modificación asociada a esta respuesta; puede ser un reenvío o un formulario antiguo.'
          :'Pendiente de comprobar el resultado; recibirlo no significa que se aplicó.',
      ...(aplicada && r.resumen?{resumen:String(r.resumen).slice(0,12000)}:{})});
  }
  const solicitudes=entradas.some(r=>['flow_facturacion','flow_evento'].includes(r.accion)) ? (await db.query(`SELECT e.wamid,s.servicio,s.datos FROM agente_solicitudes_servicio s
    JOIN agente_preguntas_interactivas q ON q.id=s.pregunta_id AND q.negocio_id=s.negocio_id
    JOIN whatsapp_entradas e ON e.negocio_id=s.negocio_id AND e.telefono=s.telefono AND e.wamid=q.comando->>'wamid'
    WHERE s.negocio_id=$1 AND s.telefono=$2 AND e.wamid=ANY($3::text[])`,[negocioId,telefono,ids])).rows : [];
  for(const s of solicitudes)info.set(s.wamid,{tipo:'formulario',titulo:'Solicitud recibida',
    detalle:'Datos guardados para atención del personal. No confirma pedidos, reservas ni facturas.',resumen:resumenServicio(s)});
  return mensajes.map(m=>m.negocio_id===negocioId && m.telefono===telefono && info.has(m.message_id_externo)
    ?{...m,interaccion:info.get(m.message_id_externo)}:m);
}
