// Es una escritura explícita en Meta, NO un test. Nunca envía mensajes ni
// activa el canario. La BD únicamente se lee para resolver la cuenta propia.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
import { definicionProductos,definicionConfigurar,definicionPedidoContinuo } from './definicion-flows-pedido.mjs';
import { definicionFlowRepetible } from './definicion-flow-repetible.mjs';
const [negocioId,modo,alcance]=process.argv.slice(2);
assert(!alcance || ['pedido','repetible'].includes(alcance),'Alcance inválido');
const endpoint='https://xabor.mx/webhook/flows/pedido';
assert(['validar','publicar'].includes(modo),'Indica validar o publicar');
const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
const phones=await api(`${cred.wabaId}/phone_numbers?fields=id&limit=100`);
assert(phones.data.some(p=>p.id===cred.phoneId),'El número debe pertenecer a la WABA');
const existentes=await api(`${cred.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
for(const [tipo,definicion] of alcance==='repetible' ? [['repetible',definicionFlowRepetible()]] : alcance==='pedido' ? [['pedido',definicionPedidoContinuo()]]
  : [['productos',definicionProductos()],['configurar',definicionConfigurar()]]) {
  const json=JSON.stringify(definicion),sha=createHash('sha256').update(json).digest('hex');
  const name=`xabor_${tipo}_agrupado_${sha.slice(0,12)}`;
  let f=existentes.data.find(x=>x.name===name);
  if(!f) {
    assert.equal(modo,'validar','Primero crear y validar el borrador');
    f=await api(`${cred.wabaId}/flows`,{method:'POST',body:new URLSearchParams({name,categories:'["OTHER"]',
      ...(tipo==='repetible'?{endpoint_uri:endpoint}:{})})});
    f.status='DRAFT';
  }
  if(modo==='validar' && f.status==='DRAFT') {
    const body=new FormData();body.set('name','flow.json');body.set('asset_type','FLOW_JSON');
    body.set('file',new Blob([json],{type:'application/json'}),'flow.json');
    const r=await api(`${f.id}/assets`,{method:'POST',body});
    console.log(JSON.stringify({tipo,id:f.id,sha,validacion:r}));
    assert(!r.validation_errors?.length,'Meta rechazó el JSON; no publicar');
  }
  const actual=await api(`${f.id}?fields=id,name,status,validation_errors,health_status,endpoint_uri`);
  console.log(JSON.stringify({tipo,...actual}));
  assert(!actual.validation_errors?.length,'Flow con errores');
  if(tipo==='repetible')assert.equal(actual.endpoint_uri,endpoint,'No publicar un endpoint distinto');
  if(modo==='publicar' && actual.status==='DRAFT') {
    if(tipo==='repetible') {
      const keys=await api(`${cred.phoneId}/whatsapp_business_encryption`);
      assert(keys.data?.length===1 && keys.data[0].business_public_key_signature_status==='VALID','Clave de cifrado no verificada en Meta');
    }
    // 141006 solo describe conversaciones iniciadas por la empresa. Este
    // piloto responde al cliente dentro de 24h; NO envía plantillas. Cualquier
    // otra restricción de Meta detiene la publicación, sin cambiar facturación.
    const bloqueadas=actual.health_status?.entities?.filter(e=>e.can_send_message!=='AVAILABLE') || [];
    assert(actual.health_status?.can_send_message==='AVAILABLE'
      || (bloqueadas.length>0 && bloqueadas.every(e=>e.entity_type==='WABA' && e.errors?.length
        && e.errors.every(x=>x.error_code===141006))), 'Meta reporta una restricción distinta a facturación de conversaciones salientes');
    const r=await api(`${f.id}/publish`,{method:'POST'});assert.equal(r.success,true);
    const publicado=await api(`${f.id}?fields=id,name,status,health_status`);
    assert.equal(publicado.status,'PUBLISHED');
    console.log(JSON.stringify({tipo,publicado}));
  }
}
