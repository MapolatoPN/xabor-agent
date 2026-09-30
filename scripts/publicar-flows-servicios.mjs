// Escritura explícita en Meta, sin envíos ni activación del bot.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
import { definicionFlowServicio } from './definicion-flows-servicios.mjs';
const [negocioId,modo]=process.argv.slice(2);
assert(['validar','publicar'].includes(modo));
const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
const phones=await api(`${cred.wabaId}/phone_numbers?fields=id&limit=100`);
assert(phones.data.some(p=>p.id===cred.phoneId));
const existentes=await api(`${cred.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
for(const servicio of ['facturacion','evento']) {
  const json=JSON.stringify(definicionFlowServicio(servicio)),sha=createHash('sha256').update(json).digest('hex');
  const name=`xabor_${servicio}_${sha.slice(0,12)}`;
  let flow=existentes.data.find(f=>f.name===name);
  if(!flow) {
    assert.equal(modo,'validar','Primero validar el borrador');
    flow=await api(`${cred.wabaId}/flows`,{method:'POST',body:new URLSearchParams({name,categories:'["OTHER"]'})});
    flow.status='DRAFT';
  }
  if(modo==='validar' && flow.status==='DRAFT') {
    const body=new FormData();body.set('name','flow.json');body.set('asset_type','FLOW_JSON');
    body.set('file',new Blob([json],{type:'application/json'}),'flow.json');
    const r=await api(`${flow.id}/assets`,{method:'POST',body});
    console.log(JSON.stringify({servicio,id:flow.id,sha,validacion:r}));assert(!r.validation_errors?.length);
  }
  let actual=await api(`${flow.id}?fields=id,name,status,validation_errors,health_status`);
  assert(!actual.validation_errors?.length);
  if(modo==='publicar' && actual.status==='DRAFT') {
    const bloqueadas=actual.health_status?.entities?.filter(e=>e.can_send_message!=='AVAILABLE') || [];
    assert(actual.health_status?.can_send_message==='AVAILABLE' || (bloqueadas.length && bloqueadas.every(e=>
      e.entity_type==='WABA' && e.errors?.length && e.errors.every(x=>x.error_code===141006))));
    assert.equal((await api(`${flow.id}/publish`,{method:'POST'})).success,true);
    actual=await api(`${flow.id}?fields=id,name,status,validation_errors,health_status`);
    assert.equal(actual.status,'PUBLISHED');
  }
  console.log(JSON.stringify({servicio,...actual}));
}
