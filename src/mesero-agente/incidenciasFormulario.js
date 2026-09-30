import { createHash } from 'node:crypto';
import { TOKEN_BOTON } from './interactivos.js';
// Solo requests autenticados y descifrados. Un fallo de barrera NO se registra
// como apertura. Nunca persistimos el token, payload ni detalle de excepción.
export async function registrarIncidenciaFormulario(db,solicitud,tipo) {
  if(!TOKEN_BOTON.test(solicitud?.flow_token || '') || !['no_disponible','error_servidor'].includes(tipo))return;
  const clave=createHash('sha256').update(tipo+JSON.stringify(solicitud)).digest('hex');
  try {
    await db.query({text:`INSERT INTO agente_actividad_formulario(pregunta_id,clave,tipo,revision)
      SELECT q.id,$2,$3,0 FROM agente_botones b JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id
      JOIN configuracion c ON c.negocio_id=q.negocio_id AND c.clave='whatsapp_trazabilidad_formularios_v1' AND c.valor='true'
      WHERE b.token=$1 AND q.created_at>now()-interval '1 day'
        AND (SELECT count(*) FROM agente_actividad_formulario a WHERE a.pregunta_id=q.id)<512
      ON CONFLICT DO NOTHING`,values:[solicitud.flow_token,clave,tipo],query_timeout:1000});
  } catch {console.warn('[FLOW] Incidencia sin evidencia durable');}
}

export async function purgarTelemetriaFormularios(db) {
  // Solo estas dos tablas nuevas, lotes pequeños. No toca mensajes, borradores,
  // capacidades, pedidos ni auditorías. La lectura del chat jamás borra datos.
  for(const tabla of ['agente_actividad_formulario','whatsapp_estados_mensaje']) {
    await db.query(`DELETE FROM ${tabla} WHERE ctid IN
      (SELECT ctid FROM ${tabla} WHERE observado_at<clock_timestamp()-interval '30 days' LIMIT 1000)`);
  }
}
export function iniciarRetencionTelemetria(db) {
  let ejecutando=false;
  const timer=setInterval(async()=>{
    if(ejecutando)return;ejecutando=true;
    try {await purgarTelemetriaFormularios(db);} catch {console.warn('[FLOW] Retención de telemetría pendiente');}
    finally {ejecutando=false;}
  },60*60_000);timer.unref();return ()=>clearInterval(timer);
}
