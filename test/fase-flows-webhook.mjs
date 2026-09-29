// Webhook firmado y dos procesos reales; Meta/modelo están SOLO en localhost.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos,prepararNegocioCombitoOmelette } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
const incidente=process.argv.includes('--combito-omelette');
const f=await (incidente?prepararNegocioCombitoOmelette():prepararNegocioMixtos()),{negocioId,telefono,marca}=f;
const combito=incidente?structuredClone(f.estado.carrito.items[0]):null;
const totalEsperado=incidente?325:425,numeroLineas=incidente?2:3;
await actualizarConfiguracion({whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',whatsapp_flows_telefonos:telefono,
  whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222'},negocioId);
if(!incidente)f.estado.carrito.items=[];
await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`,JSON.stringify(f.estado)]);
const secreto='flows-solo-local',salidas=[];
let s1,s2,meta,ia,secuencia=0;
const parar=async s=>{if(!s||s.proc.exitCode!==null||s.proc.signalCode!==null)return;const fin=new Promise(r=>s.proc.once('exit',r));s.detener();await fin;};
const leer=async()=> (await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`])).rows[0].estado;
const esperar=async fn=>{const fin=Date.now()+45000;while(Date.now()<fin){if(await fn())return;await new Promise(r=>setTimeout(r,100));}
  throw Error(`Timeout\n${s1?.obtenerSalida().slice(-5000)}\n${s2?.obtenerSalida().slice(-5000)}`);};
const identidad=()=>({id:`wamid.FLOW-${marca}-${++secuencia}`,from:telefono,timestamp:String(Math.floor(Date.now()/1000))});
const texto=body=>({...identidad(),type:'text',text:{body}});
const respuesta=(q,campos)=>({...identidad(),type:'interactive',context:{id:q.id},interactive:{type:'nfm_reply',nfm_reply:{
  name:'flow',body:'Sent',response_json:JSON.stringify({flow_token:q.interactive.action.parameters.flow_token,...campos})}}});
const toque=(q,title)=>({...identidad(),type:'interactive',context:{id:q.id},interactive:{type:'button_reply',button_reply:{
  id:q.interactive.action.buttons.find(b=>b.reply.title===title).reply.id,title}}});
const post=async(base,messages)=>{
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
    metadata:{phone_number_id:marca},contacts:[{wa_id:telefono,profile:{name:'Cliente local'}}],messages}}]}]});
  const r=await fetch(`${base}/webhook/whatsapp`,{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':`sha256=${createHmac('sha256',secreto).update(body).digest('hex')}`}});assert.equal(r.status,200);
};
const procesar=async(messages,n=1)=>{const antes=salidas.length;await Promise.all([post(s1.base,messages),post(s2.base,messages)]);
  await esperar(async()=> (await pool.query("SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2::text[]) AND estado='completado'",[negocioId,messages.map(m=>m.id)])).rows[0].n===messages.length);
  assert.equal(salidas.length,antes+n,'una sola respuesta por pregunta');return salidas.at(-1);};
try {
  meta=createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    const p=JSON.parse(b);res.setHeader('Content-Type','application/json');
    if(p.status==='read'){res.end('{"success":true}');return;}
    assert.equal(p.to,telefono);const id=`wamid.FLOW-OUT-${marca}-${salidas.length}`;
    salidas.push({...p,id});res.end(JSON.stringify({messages:[{id}]}));
  });});
  await new Promise(r=>meta.listen(0,'127.0.0.1',r));ia=await arrancarAnthropicMock();
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:ia.baseUrl,
    ANTHROPIC_API_KEY:'test-only',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'};
  s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
  let q=await procesar([texto('Hola')]);assert.equal(q.interactive.type,'flow');
  if(!incidente) {
    const opciones=q.interactive.action.parameters.flow_action_payload.data.productos;
    const mixtos=opciones.find(o=>o.title==='Chilaquiles Mixtos').id;
    q=await procesar([respuesta(q,{producto0:mixtos,producto1:mixtos,producto2:mixtos})]);
  }
  assert.equal((await leer()).carrito.items.length,numeroLineas);assert.equal(q.interactive.type,'flow');
  assert.doesNotMatch(q.interactive.body.text,/Infinity|null|undefined/);
  // El cliente deja abierto el formulario y los servidores reinician.
  await parar(s1);await parar(s2);
  s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
  const campos={modalidad:'m0',pago:'p0'};
  if(incidente) {
    const data=q.interactive.action.parameters.flow_action_payload.data;
    assert.equal(data.g7_max,4);assert.equal(data.g0_inicial_s,'o1');assert.equal(data.g3_inicial_s,'o1');
    for(let i=0;i<18;i++){campos[`g${i}_s`]=data[`g${i}_inicial_s`];campos[`g${i}_m`]=data[`g${i}_inicial_m`];}
    campos.g7_m=['o0','o1'];
  } else for(const [l,salsas] of [['0',['o0','o1']],['1',['o2']],['2',['o3']]]) {
    const base=Number(l)*6;campos[`g${base}_m`]=salsas;campos[`g${base+1}_s`]='o0';campos[`g${base+2}_m`]=['o0','o1'];
  }
  const formulario=q,m=respuesta(formulario,campos);
  q=await procesar([m]);assert(q.interactive.body.text.includes(`Total: $${totalEsperado}`));
  assert.equal((await leer()).folio,null);assert.equal((await leer()).carrito.items.length,numeroLineas);
  if(incidente) {
    assert.deepEqual((await leer()).carrito.items[0],combito);
    assert.deepEqual((await leer()).carrito.items[1].modificadores.find(g=>g.grupo==='Tortillas').opciones,['Tortillas de harina','Tortillas de maiz']);
  }
  await procesar([respuesta(formulario,campos)],0);
  console.log(`OK HTTP Flow: ${incidente?'combito + omelette sin límite':'tres platillos'}, reinicio, multiselección completa, dos procesos y duplicado sin efecto.`);
  const resumen=q;
  await procesar([toque(resumen,'Confirmar')]);await procesar([toque(resumen,'Confirmar')],0);
  const e=await leer();assert(e.hechos.confirmado);
  const pedidos=(await pool.query('SELECT datos FROM pedidos_activos WHERE negocio_id=$1',[negocioId])).rows;
  assert.equal(pedidos.length,1);assert.equal(Number(pedidos[0].datos.total),totalEsperado);
  const trazas=(await pool.query('SELECT errores_proveedor,acciones FROM agente_turnos WHERE negocio_id=$1',[negocioId])).rows;
  assert(trazas.every(t=>!t.errores_proveedor?.length&&!t.acciones.some(a=>a.origen==='modelo')));
  assert(salidas.every(s=>!JSON.stringify(s).includes('flow_token\\"')));
  console.log(`OK HTTP Flow: una confirmación final crea exactamente un pedido LOCAL de $${totalEsperado}; ninguna llamada al modelo.`);
} finally {await parar(s1);await parar(s2);ia?.detener();meta?.closeAllConnections();meta?.close();await pool.end();}
