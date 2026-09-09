import assert from 'node:assert/strict';
import { extraerTicketConIA, MODELO_TICKET, TICKET_TIMEOUT_MS } from '../src/services/ticketComprasIA.js';
import { verificarConfiguracion } from '../scripts/compras-verificar-config.mjs';

let ok=0;
const imagen=Buffer.from('imagen de prueba de contrato');
const respuesta={stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({proveedor:'Prueba',fecha:'2026-09-01',total:42,moneda:'MXN',items:[],advertencias:[]})}]};
const cliente=fn=>({messages:{create:fn}});
await extraerTicketConIA(imagen,'image/jpeg',{anthropic:cliente(async(body,opts)=>{
  assert.equal(body.model,MODELO_TICKET);assert.equal(body.output_config.format.type,'json_schema');
  assert.equal(body.messages[0].content[1].source.data,imagen.toString('base64'));
  assert.equal(opts.timeout,TICKET_TIMEOUT_MS);assert.equal(opts.maxRetries,0);return respuesta;
})});ok++;
let llamadas=0;
const datos=await extraerTicketConIA(imagen,'image/jpeg',{anthropic:cliente(async()=>{if(++llamadas===1)throw Object.assign(new Error('temporal'),{status:429});return respuesta;})});
assert.equal(llamadas,2);assert.equal(datos.total,42);ok++;
for(const status of [401,400,429]){
  llamadas=0;await assert.rejects(extraerTicketConIA(imagen,'image/jpeg',{anthropic:cliente(async()=>{llamadas++;throw Object.assign(new Error('rechazo'),{status});})}),e=>e.codigo==='TICKET_IA_ERROR');
  assert.equal(llamadas,status===429?2:1);ok++;
}
for(const [respuestaMala,codigo] of [[{stop_reason:'max_tokens'},'TICKET_IA_TRUNCADO'],[{content:[{type:'text',text:'no JSON'}]},'TICKET_IA_INVALIDO']]){
  llamadas=0;await assert.rejects(extraerTicketConIA(imagen,'image/jpeg',{anthropic:cliente(async()=>{llamadas++;return respuestaMala;})}),e=>e.codigo===codigo);assert.equal(llamadas,1);ok++;
}
assert(verificarConfiguracion({NODE_ENV:'production'}).problemas.length===2);
assert.deepEqual(verificarConfiguracion({STORAGE_DRIVER:'s3',ANTHROPIC_API_KEY:'test',S3_BUCKET:'test',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'test'}).problemas,[]);ok++;
console.log(`Compras contrato IA/configuración: ${ok}/${ok}. Proveedor simulado; no valida OCR real.`);
