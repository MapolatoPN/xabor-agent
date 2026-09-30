import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac,randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
const secreto='mapo-firma-local',salidas=[];
let s1,s2,meta;
const parar=async s=>{if(!s || s.proc.exitCode!==null || s.proc.signalCode!==null)return;const fin=new Promise(r=>s.proc.once('exit',r));s.detener();await fin;};
async function fixture() {
  const f=await prepararNegocioBotones();f.estado.carrito.items=[];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({bot_whatsapp_solo_prueba:'false',whatsapp_atencion_general_v1:'true',whatsapp_inicio_mapo_v1:'true',
    mesero_agente_porcentaje:'100',mesero_agente_telefonos:'',whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:'',
    whatsapp_interactivos_elecciones_v1:'true',whatsapp_flows_v1:'true',whatsapp_flows_telefonos:'',
    whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222',
    whatsapp_flow_facturacion_id:'44444444444',whatsapp_flow_evento_id:'55555555555'},f.negocioId);
  return f;
}
const id=f=>({id:'wamid.mapo.http.'+randomUUID(),from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
const texto=(f,body)=>({...id(f),type:'text',text:{body}});
const boton=(f,q,title)=>({...id(f),type:'interactive',context:{id:q.wamid},interactive:{type:'list_reply',list_reply:{
  id:q.interactive.action.sections[0].rows.find(x=>x.title===title).id,title}}});
async function post(base,f,messages) {
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:f.marca},
    contacts:[{wa_id:f.telefono,profile:{name:'Local'}}],messages}}]}]});
  return fetch(base+'/webhook/whatsapp',{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':'sha256='+createHmac('sha256',secreto).update(body).digest('hex')}});
}
async function procesar(f,messages,esperadas=1) {
  const antes=salidas.filter(s=>s.to===f.telefono).length;
  for(const r of await Promise.all([post(s1.base,f,messages),post(s2.base,f,messages)]))assert.equal(r.status,200);
  const limite=Date.now()+45000;
  while(true) {
    const r=await pool.query("SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2::text[]) AND estado IN ('completado','revision')",[f.negocioId,messages.map(m=>m.id)]);
    if(r.rows[0].n===messages.length && salidas.filter(s=>s.to===f.telefono).length-antes===esperadas)break;
    if(Date.now()>limite)throw Error(`Timeout ${esperadas}\n${s1.obtenerSalida().slice(-5000)}\n${s2.obtenerSalida().slice(-2000)}`);
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(salidas.filter(s=>s.to===f.telefono).length-antes,esperadas);
  return salidas.filter(s=>s.to===f.telefono).at(-1);
}
try {
  execFileSync(process.execPath,['scripts/predeploy-108-agente-servicios-mapo.mjs'],{stdio:'pipe'});
  meta=createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    const p=JSON.parse(b);res.setHeader('Content-Type','application/json');
    if(p.status==='read')return res.end('{"success":true}');
    const wamid='wamid.mock.'+randomUUID();salidas.push({...p,wamid});res.end(JSON.stringify({messages:[{id:wamid}]}));
  });});await new Promise(r=>meta.listen(0,'127.0.0.1',r));
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:'http://127.0.0.1:1',
    ANTHROPIC_API_KEY:'solo-local',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'};
  s1=await arrancarServidor({...env,PORT:'55982'});s2=await arrancarServidor({...env,PORT:'55983'});
  const f=await fixture(),hola=texto(f,'Hola');let q=await procesar(f,[hola]);
  assert.equal(q.interactive.type,'list');assert.equal(q.interactive.action.sections[0].rows.length,4);
  await procesar(f,[hola],0);
  q=await procesar(f,[boton(f,q,'Ordenar')]);assert.equal(q.interactive.type,'flow');
  console.log('OK Mapo HTTP: número fuera de listas, saludo, cuatro opciones y pedido; dos procesos sin duplicar.');
  const fact=await fixture();q=await procesar(fact,[texto(fact,'hola')]);q=await procesar(fact,[boton(fact,q,'Facturación')]);
  const fm={...id(fact),type:'interactive',context:{id:q.wamid},interactive:{type:'nfm_reply',nfm_reply:{name:'flow',body:'Sent',response_json:JSON.stringify({
    flow_token:q.interactive.action.parameters.flow_token,nombre:'Cliente local',rfc:'AAA010101AAA',codigo_postal:'26000',
    regimen:'612',uso_cfdi:'G03',correo:'local@example.invalid',referencia:'Ticket prueba'})}}};
  const recibo=await procesar(fact,[fm]);assert.match(recibo.text.body,/aún no se ha emitido/);
  const s=(await pool.query('SELECT * FROM agente_solicitudes_servicio WHERE negocio_id=$1',[fact.negocioId])).rows;
  assert.equal(s.length,1);await procesar(fact,[fm],0);
  // Continuidad conserva en pendiente las entradas que ya son del personal;
  // no deben ejecutarse ni marcarse artificialmente como turnos del bot.
  const saludoPausado=texto(fact,'Hola'),antesPausa=salidas.filter(s=>s.to===fact.telefono).length;
  assert.equal((await post(s1.base,fact,[saludoPausado])).status,200);
  await new Promise(r=>setTimeout(r,12000));
  assert.equal(salidas.filter(s=>s.to===fact.telefono).length,antesPausa);
  assert.equal((await pool.query('SELECT count(*)::int n FROM mensajes WHERE negocio_id=$1 AND telefono=$2 AND message_id_externo=$3',
    [fact.negocioId,fact.telefono,saludoPausado.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',
    [fact.negocioId,fact.telefono])).rows[0].bot_pausado,true);
  const humano=await fixture();q=await procesar(humano,[texto(humano,'hola')]);
  q=await procesar(humano,[boton(humano,q,'Otra duda')]);assert.match(q.text.body,/persona de Mapolato/);
  console.log('OK Mapo HTTP: captura visible, handoff durable, una respuesta final y silencio durante atención humana.');
} finally {await parar(s1);await parar(s2);meta?.closeAllConnections();meta?.close();await pool.end();}
