import express from 'express';
import { createHmac,timingSafeEqual,privateDecrypt,constants,createDecipheriv,createCipheriv } from 'node:crypto';
import { atenderFlowRepetible,FlowNoDisponible } from './flowRepetibleSql.js';
import { registrarIncidenciaFormulario,iniciarRetencionTelemetria } from './incidenciasFormulario.js';
export { FlowNoDisponible };

export function firmaFlowValida(raw,firma,secreto) {
  if(!secreto || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(firma || ''))return false;
  return timingSafeEqual(createHmac('sha256',secreto).update(raw).digest(),Buffer.from(firma.slice(7),'hex'));
}
export function descifrarFlow(body,key) {
  const {encrypted_aes_key,encrypted_flow_data,initial_vector}=body || {};
  for(const v of [encrypted_aes_key,encrypted_flow_data,initial_vector])
    if(typeof v!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v))throw Error('FLOW_CIFRADO_INVALIDO');
  const aes=privateDecrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(encrypted_aes_key,'base64'));
  const iv=Buffer.from(initial_vector,'base64'),datos=Buffer.from(encrypted_flow_data,'base64');
  if(aes.length!==16 || iv.length!==16 || datos.length<17)throw Error('FLOW_CIFRADO_INVALIDO');
  const decipher=createDecipheriv('aes-128-gcm',aes,iv);decipher.setAuthTag(datos.subarray(-16));
  const solicitud=JSON.parse(Buffer.concat([decipher.update(datos.subarray(0,-16)),decipher.final()]).toString('utf8'));
  return {solicitud,aes,iv};
}
export function cifrarFlow(respuesta,aes,iv) {
  const cipher=createCipheriv('aes-128-gcm',aes,Buffer.from(iv.map(b=>b^255)));
  return Buffer.concat([cipher.update(JSON.stringify(respuesta),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
}

/**
 * Aviso de error del teléfono: cuando WhatsApp no puede usar una respuesta del
 * endpoint, el teléfono muestra «Se produjo un error» y manda {data:{error,
 * error_message}}. No es un paso del cliente: se registra y se contesta
 * {acknowledged:true}. Antes caía en el 400 de la versión y su motivo se perdía
 * (4-oct, «Agregar» de la tienda). Del texto solo queda lo que describe el
 * error: sin cifras largas (teléfonos, tokens) y acotado.
 */
export function avisoDelCliente(solicitud) {
  const d=solicitud?.data;
  if(!d || typeof d!=='object' || Array.isArray(d) || typeof d.error!=='string' || !d.error)return null;
  const limpiar=(t,max)=>String(t).replace(/[^\p{L}\p{N} .,:;()'"_\-/<>=[\]{}#]/gu,' ').replace(/\d{6,}/g,'…').replace(/\s+/g,' ').trim().slice(0,max);
  return {error:limpiar(d.error,80),mensaje:typeof d.error_message==='string'?limpiar(d.error_message,300):'',
    accion:['INIT','BACK','data_exchange'].includes(solicitud.action)?solicitud.action:'?',pantalla:/^[A-Z_]{1,20}$/.test(solicitud.screen || '')?solicitud.screen:'?'};
}

export function registrarEndpointFlow(app,{db,env=process.env,atender=atenderFlowRepetible}={}) {
  if(env.NODE_ENV!=='test' && db)iniciarRetencionTelemetria(db);
  // Fallo cerrado. Este montaje no afecta al webhook WhatsApp existente.
  app.post('/webhook/flows/pedido',express.raw({type:'application/json',limit:'64kb'}),async(req,res)=>{
    if(env.WHATSAPP_FLOW_ENDPOINT!=='true' || !env.WHATSAPP_FLOW_PRIVATE_KEY || !env.META_APP_SECRET)return res.sendStatus(503);
    if(!firmaFlowValida(req.body,req.get('x-hub-signature-256'),env.META_APP_SECRET))return res.sendStatus(432);
    let plano;
    try {plano=descifrarFlow(JSON.parse(req.body.toString('utf8')),env.WHATSAPP_FLOW_PRIVATE_KEY);}
    catch {return res.sendStatus(421);}
    try {
      const aviso=avisoDelCliente(plano.solicitud);
      if(aviso) {
        console.warn(`[FLOW] Aviso de error del teléfono (${aviso.accion} ${aviso.pantalla}): ${aviso.error}${aviso.mensaje?` — ${aviso.mensaje}`:''}`);
        await registrarIncidenciaFormulario(db,plano.solicitud,'error_cliente');
        return res.type('text/plain').send(cifrarFlow({data:{acknowledged:true}},plano.aes,plano.iv));
      }
      if(!plano.solicitud || plano.solicitud.version!=='3.0')return res.sendStatus(400);
      const r=plano.solicitud.action==='ping' ? {data:{status:'active'}} : await atender(db,plano.solicitud);
      return res.type('text/plain').send(cifrarFlow(r,plano.aes,plano.iv));
    } catch(e) {
      await registrarIncidenciaFormulario(db,plano.solicitud,e instanceof FlowNoDisponible?'no_disponible':'error_servidor');
      if(e instanceof FlowNoDisponible)return res.status(427).type('text/plain').send(cifrarFlow({error_msg:e.message},plano.aes,plano.iv));
      // No registrar tokens, contenido de la conversación ni material cifrado.
      console.error('[FLOW] No se pudo procesar el borrador');return res.sendStatus(500);
    }
  });
}
