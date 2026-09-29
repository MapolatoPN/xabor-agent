// Proyección de evidencias del servidor. Nunca devuelve response_json, tokens,
// IDs de formularios o el borrador no enviado. No necesita migración.
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
  return mensajes.map(m=>info.has(m.message_id_externo)?{...m,interaccion:info.get(m.message_id_externo)}:m);
}
