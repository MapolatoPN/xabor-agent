// Meta y modelo simulados; dos servidores, DB desechable, cero órdenes reales.
import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
const f=await prepararNegocioMixtos(),{negocioId,telefono,marca}=f;
f.estado.carrito.items=Array.from({length:9},(_,i)=>({id:f.mixtosId,lid:`linea-${i}`,nombre:'Chilaquiles Mixtos',cantidad:1,
  notas:`Nota ${i}`,modificadores:[{grupo:'Salsa',opciones:['Roja']},{grupo:'Proteína',opciones:['Huevo']},
    {grupo:'Guarnición',opciones:['Frijoles','Arroz']}]}));
Object.assign(f.estado.carrito.datos,{modalidad:'recoger en tienda',forma_pago:'efectivo'});
await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`,JSON.stringify(f.estado)]);
await actualizarConfiguracion({whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',bot_whatsapp_telefonos_prueba:telefono,
  whatsapp_flows_telefonos:telefono,whatsapp_flow_editar_id:'55555555555',whatsapp_flow_productos_id:'11111111111'},negocioId);
const secreto='edicion-local',salidas=[];let s1,s2,meta,ia;
const leer=async()=>(await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`])).rows[0].estado;
const parar=async s=>{if(!s || s.proc.exitCode!==null || s.proc.signalCode!==null)return;const fin=new Promise(r=>s.proc.once('exit',r));s.detener();await fin;};
const identidad=()=>({id:`wamid.edit.${randomUUID()}`,from:telefono,timestamp:String(Math.floor(Date.now()/1000))});
const texto=body=>({...identidad(),type:'text',text:{body}});
const toque=(q,title)=>({...identidad(),type:'interactive',context:{id:q.id},interactive:{type:'button_reply',button_reply:{
  id:q.interactive.action.buttons.find(b=>b.reply.title===title).reply.id,title}}});
const respuesta=(q,campos)=>({...identidad(),type:'interactive',context:{id:q.id},interactive:{type:'nfm_reply',nfm_reply:{
  name:'flow',body:'Sent',response_json:JSON.stringify({flow_token:q.interactive.action.parameters.flow_token,...campos})}}});
const esperar=async fn=>{const fin=Date.now()+45000;while(Date.now()<fin){if(await fn())return;await new Promise(r=>setTimeout(r,100));}
  throw Error(`Timeout\n${s1?.obtenerSalida().slice(-3000)}\n${s2?.obtenerSalida().slice(-3000)}`);};
const post=async(base,messages)=>{
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
    metadata:{phone_number_id:marca},contacts:[{wa_id:telefono,profile:{name:'Cliente local'}}],messages}}]}]});
  const r=await fetch(`${base}/webhook/whatsapp`,{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':`sha256=${createHmac('sha256',secreto).update(body).digest('hex')}`}});assert.equal(r.status,200);
};
const procesar=async(m,n=1)=>{const antes=salidas.length;await Promise.all([post(s1.base,[m]),post(s2.base,[m])]);
  await esperar(async()=>(await pool.query("SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2 AND estado='completado'",[negocioId,m.id])).rows[0].n===1);
  assert.equal(salidas.length,antes+n);return salidas.at(-1);};
try {
  meta=createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    const p=JSON.parse(b);res.setHeader('Content-Type','application/json');
    if(p.status==='read'){res.end('{"success":true}');return;}
    assert.equal(p.to,telefono);const id=`wamid.edit.out.${salidas.length}`;salidas.push({...p,id});
    res.end(JSON.stringify({messages:[{id}]}));
  });});
  await new Promise(r=>meta.listen(0,'127.0.0.1',r));ia=await arrancarAnthropicMock();
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:ia.baseUrl,
    ANTHROPIC_API_KEY:'test-only',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'};
  s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
  let q=await procesar(texto('Hola'));assert.equal(q.interactive.type,'button');
  q=await procesar(toque(q,'Cambiar algo'));assert.equal(q.interactive.type,'flow');
  assert.equal(q.interactive.action.parameters.flow_id,'55555555555');
  const lista=q.interactive.action.parameters.flow_action_payload.data.lineas;assert.equal(lista.length,10);
  const seleccion=lista[8]['on-select-action'].payload;
  assert.equal(seleccion.observaciones_inicial,'Nota 8');
  const campos={linea:seleccion.linea,modalidad:seleccion.modalidad_inicial,pago:seleccion.pago_inicial,observaciones:'Sin crema'};
  for(let g=0;g<6;g++)for(const t of ['s','m'])campos[`g${g}_${t}`]=seleccion[`g${g}_inicial_${t}`];
  campos.g0_m=[seleccion.g0_opciones.find(o=>o.title==='Verde').id];
  const antes=(await leer()).carrito;
  await parar(s1);await parar(s2);s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
  const editor=q,m=respuesta(editor,campos);q=await procesar(m);
  const e=await leer();assert.equal(e.folio,null);assert.equal(e.carrito.items.length,9);
  assert.deepEqual(e.carrito.items.slice(0,8),antes.items.slice(0,8));
  assert.equal(e.carrito.items[8].notas,'Sin crema');assert.deepEqual(e.carrito.items[8].modificadores[0].opciones,['Verde']);
  await procesar(m,0);await procesar(respuesta(editor,campos),0);assert.deepEqual((await leer()).carrito,e.carrito);
  const abierto=await procesar(toque(q,'Cambiar algo'));
  const cancelar=texto('Cancelar ese pedido');const cancelado=await procesar(cancelar);
  assert.match(cancelado.text.body,/borrador fue cancelado/);assert.equal((await leer()).carrito.items.length,0);
  await procesar(cancelar,0);await procesar(respuesta(abierto,campos),0);
  q=await procesar(texto('Hola'));assert.equal(q.interactive.type,'flow');
  const nuevo=await leer();assert.equal(nuevo.carrito.items.length,0);assert.notEqual(nuevo.conversacionId,e.conversacionId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[negocioId])).rows[0].n,0);
  const trazas=(await pool.query('SELECT errores_proveedor,acciones FROM agente_turnos WHERE negocio_id=$1',[negocioId])).rows;
  assert(trazas.every(t=>!t.errores_proveedor?.length && !t.acciones.some(a=>a.origen==='modelo')));
  console.log('OK HTTP edición/cancelación: nueve platos, misma ventana, reinicios, dos procesos, reintentos, cancelación explícita, Flow viejo inerte, ciclo nuevo; cero pedidos y cero llamadas al modelo.');
}finally{await parar(s1);await parar(s2);ia?.detener();meta?.closeAllConnections();meta?.close();await pool.end();}
