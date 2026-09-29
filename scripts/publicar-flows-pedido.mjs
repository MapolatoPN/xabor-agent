// Es una escritura explícita en Meta, NO un test. Nunca envía mensajes ni
// activa el canario. La BD únicamente se lee para resolver la cuenta propia.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
import { definicionProductos,definicionConfigurar } from './definicion-flows-pedido.mjs';
const [negocioId,modo]=process.argv.slice(2);
assert(['validar','publicar'].includes(modo),'Indica validar o publicar');
const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
const phones=await api(`${cred.wabaId}/phone_numbers?fields=id&limit=100`);
assert(phones.data.some(p=>p.id===cred.phoneId),'El número debe pertenecer a la WABA');
const existentes=await api(`${cred.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
for(const [tipo,definicion] of [['productos',definicionProductos()],['configurar',definicionConfigurar()]]) {
  const json=JSON.stringify(definicion),sha=createHash('sha256').update(json).digest('hex');
  const name=`xabor_${tipo}_agrupado_${sha.slice(0,12)}`;
  let f=existentes.data.find(x=>x.name===name);
  if(!f) {
    assert.equal(modo,'validar','Primero crear y validar el borrador');
    f=await api(`${cred.wabaId}/flows`,{method:'POST',body:new URLSearchParams({name,categories:'["OTHER"]'})});
    f.status='DRAFT';
  }
  if(modo==='validar' && f.status==='DRAFT') {
    const body=new FormData();body.set('name','flow.json');body.set('asset_type','FLOW_JSON');
    body.set('file',new Blob([json],{type:'application/json'}),'flow.json');
    const r=await api(`${f.id}/assets`,{method:'POST',body});
    console.log(JSON.stringify({tipo,id:f.id,sha,validacion:r}));
    assert(!r.validation_errors?.length,'Meta rechazó el JSON; no publicar');
  }
  const actual=await api(`${f.id}?fields=id,name,status,validation_errors,health_status`);
  console.log(JSON.stringify({tipo,...actual}));
  assert(!actual.validation_errors?.length,'Flow con errores');
  if(modo==='publicar' && actual.status==='DRAFT') {
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
