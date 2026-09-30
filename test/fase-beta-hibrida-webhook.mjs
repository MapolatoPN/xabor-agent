// Webhook firmado -> inbox durable -> dos procesos -> ejecutor -> outbox ->
// HTTP Meta simulado. La red externa está bloqueada por el preload obligatorio.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac,randomUUID } from 'node:crypto';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
const secreto='beta-firma-local';
const salidas=[];
let s1,s2,meta;
const parar=async s=>{if(!s || s.proc.exitCode!==null || s.proc.signalCode!==null)return;const fin=new Promise(r=>s.proc.once('exit',r));s.detener();await fin;};
async function fixture({beta=true,maestro=true,pausa=false}={}) {
  const f=await prepararNegocioBotones();f.estado.carrito.items=[];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({bot_whatsapp_solo_prueba:'true',whatsapp_beta_hibrido_v1:String(beta),whatsapp_beta_telefonos:f.telefono,
    whatsapp_catalogo_nativo_v1:'true',whatsapp_catalogo_meta_id:'77777777777',
    whatsapp_catalogo_meta_mapa:JSON.stringify([{retailer_id:'cafe',producto_id:String(f.productoId),opciones:[]}])},f.negocioId);
  if(!maestro)await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
  if(pausa)await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
  return f;
}
const leer=async f=>(await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`])).rows[0].estado;
const identidad=f=>({id:'wamid.beta.http.'+randomUUID(),from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
const order=f=>({...identidad(f),type:'order',order:{catalog_id:'77777777777',product_items:[{product_retailer_id:'cafe',quantity:'4',item_price:'45',currency:'MXN'}]}});
async function post(base,f,messages,firmaValida=true) {
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:f.marca},
    contacts:[{wa_id:f.telefono,profile:{name:'Local'}}],messages}}]}]});
  return fetch(base+'/webhook/whatsapp',{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':'sha256='+createHmac('sha256',firmaValida?secreto:'incorrecta').update(body).digest('hex')}});
}
async function procesar(f,messages,salidasEsperadas=1) {
  const antes=salidas.length;
  for(const r of await Promise.all([post(s1.base,f,messages),post(s2.base,f,messages)]))assert.equal(r.status,200);
  const limite=Date.now()+45000;
  while(true) {
    const r=await pool.query("SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2::text[]) AND estado='completado'",[f.negocioId,messages.map(m=>m.id)]);
    if(r.rows[0].n===messages.length)break;
    if(Date.now()>limite)throw Error(`Timeout\n${s1.obtenerSalida().slice(-4500)}\n${s2.obtenerSalida().slice(-4500)}`);
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(salidas.length-antes,salidasEsperadas);return salidas.at(-1);
}
try {
  meta=createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    const p=JSON.parse(b);res.setHeader('Content-Type','application/json');
    if(p.status==='read')return res.end('{"success":true}');
    salidas.push(p);res.end(JSON.stringify({messages:[{id:'wamid.mock.'+randomUUID()}]}));
  });});
  await new Promise(r=>meta.listen(0,'127.0.0.1',r));
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:'http://127.0.0.1:1',
    ANTHROPIC_API_KEY:'solo-local',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'};
  s1=await arrancarServidor({...env,PORT:'55980'});s2=await arrancarServidor({...env,PORT:'55981'});
  const f=await fixture(),m=order(f);
  assert.equal((await post(s1.base,f,[m],false)).status,403);
  assert.equal((await pool.query('SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  await procesar(f,[m]);assert.equal((await leer(f)).carrito.items[0].cantidad,4);
  await procesar(f,[m],0);assert.equal((await leer(f)).carrito.items.length,1);
  const historial=(await pool.query('SELECT texto FROM mensajes WHERE negocio_id=$1 AND direccion=$2',[f.negocioId,'entrante'])).rows;
  assert.equal(historial.length,1);assert.match(historial[0].texto,/Carrito de catálogo recibido/);
  assert(!historial[0].texto.includes('retailer'));
  console.log('OK beta HTTP: firma, dos procesos, una aplicación, una respuesta y tarjeta de recepción legible.');
  await parar(s1);s1=await arrancarServidor({...env,PORT:'55980'});
  await procesar(f,[m],0);
  const segundo=await procesar(f,[order(f)]);assert.match(segundo.text?.body || segundo.interactive?.body?.text,/No sumé otro carrito/);
  assert.equal((await leer(f)).carrito.items[0].cantidad,4);
  console.log('OK beta HTTP: reinicio y reenvío con otro wamid no suman dos carritos.');
  for(const config of [{beta:false},{maestro:false},{pausa:true}]) {
    const bloqueada=await fixture(config);await procesar(bloqueada,[order(bloqueada)],0);assert.equal((await leer(bloqueada)).carrito.items.length,0);
  }
  const ajeno=await fixture();const mAjeno=order(ajeno);mAjeno.from='528700000009';
  await procesar(ajeno,[mAjeno],0);assert.equal((await leer(ajeno)).carrito.items.length,0);
  console.log('OK beta HTTP: apagado maestro, pausa humana, beta off y teléfono fuera del piloto nunca responden.');
  const mixto=await fixture();const saludo={...identidad(mixto),type:'text',text:{body:'Hola'}};
  await procesar(mixto,[order(mixto),saludo]);assert.equal((await leer(mixto)).carrito.items.length,0);
  console.log('OK beta HTTP: texto junto a carrito conserva prioridad del texto, no agrega el carrito.');
  const dbPedidos=await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=ANY($1::uuid[])',[[f.negocioId,mixto.negocioId]]);
  assert.equal(dbPedidos.rows[0].n,0);
  console.log('Beta HTTP completa. No se confirma, cobra ni imprime; Anthropic inaccesible y red externa bloqueada.');
}finally{await parar(s1);await parar(s2);meta?.closeAllConnections();meta?.close();await pool.end();}
