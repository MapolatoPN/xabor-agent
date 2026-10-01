import { isDeepStrictEqual } from 'node:util';

// El borrador anterior que un formulario nuevo puede retomar: misma
// conversación y ciclo, formulario entregado y sin terminar, de menos de un
// día, misma acción y versión, misma huella del carrito y la foto completa
// idéntica (líneas, opciones, precios, orden e identidad Flow). Solo lectura.
export async function borradorCompatible(db,{preparado,negocioId,sessionId}) {
  if(preparado?.botones?.length!==1)return null;
  const b=preparado.botones[0];
  if(!((b.accion==='flow_configurar' && b.datos?.version==='carrito_v1')
    || (b.accion==='flow_productos' && b.datos?.version==='repetible_v1')))return null;
  const {rows}=await db.query(`SELECT b.datos,d.contenido FROM agente_preguntas_interactivas q
    JOIN agente_botones b ON b.pregunta_id=q.id JOIN agente_flows_borradores d ON d.pregunta_id=q.id
    JOIN agente_outbox o ON o.evento_clave=q.outbox_clave AND o.negocio_id=q.negocio_id
    WHERE q.negocio_id=$1 AND q.session_id=$2 AND q.ciclo=$3 AND q.id<>$4
      AND q.estado='disponible' AND o.estado='entregado' AND o.wamid_salida IS NOT NULL
      AND q.created_at>clock_timestamp()-interval '1 day'
      AND b.accion=$5 AND b.datos->>'version'=$6 AND q.huella=$7
      AND d.contenido->>'etapa'<>'FINAL'
    ORDER BY q.created_at DESC LIMIT 1`,[negocioId,sessionId,preparado.ciclo,preparado.preguntaId,
      b.accion,b.datos.version,preparado.huella]);
  const anterior=rows[0];
  return anterior && isDeepStrictEqual(anterior.datos,b.datos) ? anterior : null;
}

// Se llama DENTRO del commit del nuevo turno. Recupera únicamente navegación
// que llegó al servidor; jamás datos no enviados por el dispositivo.
export async function recuperarBorradorCompatible(tx,{preparado,negocioId,sessionId}) {
  if(!preparado.retomarBorrador)return false;
  const anterior=await borradorCompatible(tx,{preparado,negocioId,sessionId});
  if(!anterior)return false;
  await tx.query('INSERT INTO agente_flows_borradores(pregunta_id,contenido) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [preparado.preguntaId,JSON.stringify(anterior.contenido)]);
  return true;
}
