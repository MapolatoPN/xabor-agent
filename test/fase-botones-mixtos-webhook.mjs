// Recorrido HTTP firmado → inbox → dos procesos → carrito → outbox → Meta local.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { pool } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
const f=await prepararNegocioMixtos(),{negocioId,telefono,marca}=f;
const secreto='mixtos-solo-local',salidas=[];
let s1,s2,meta,ia,secuencia=0;
const parar=async s=>{if(!s||s.proc.exitCode!==null||s.proc.signalCode!==null)return;const fin=new Promise(r=>s.proc.once('exit',r));s.detener();await fin;};
const leer=async()=> (await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`])).rows[0].estado;
const esperar=async fn=>{const fin=Date.now()+45000;while(Date.now()<fin){if(await fn())return;await new Promise(r=>setTimeout(r,100));}
  throw Error(`Timeout\n${s1?.obtenerSalida().slice(-4000)}\n${s2?.obtenerSalida().slice(-4000)}`);};
const identidad=()=>({id:`wamid.MIX-${marca}-${++secuencia}`,from:telefono,timestamp:String(Math.floor(Date.now()/1000))});
const texto=body=>({...identidad(),type:'text',text:{body}});
const filas=s=>s.interactive?.type==='list'?s.interactive.action.sections[0].rows:s.interactive?.action.buttons.map(b=>b.reply)||[];
const toque=(s,titulo)=>{const r=filas(s).find(r=>r.title===titulo);assert(r,`Falta ${titulo}: ${JSON.stringify(s)}`);
  const type=s.interactive.type==='list'?'list_reply':'button_reply';
  return {...identidad(),type:'interactive',context:{id:s.id},interactive:{type,[type]:{id:r.id,title:'IGNORAR_TÍTULO'}}};};
const post=async(base,messages)=>{
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
    metadata:{phone_number_id:marca},contacts:[{wa_id:telefono,profile:{name:'Cliente local'}}],messages}}]}]});
  const r=await fetch(`${base}/webhook/whatsapp`,{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':`sha256=${createHmac('sha256',secreto).update(body).digest('hex')}`}});assert.equal(r.status,200);
};
const procesar=async(messages,n=1)=>{const antes=salidas.length;await post(s1.base,messages);await post(s2.base,messages);
  await esperar(async()=> (await pool.query("SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2::text[]) AND estado='completado'",[negocioId,messages.map(m=>m.id)])).rows[0].n===messages.length);
  assert.equal(salidas.length,antes+n,'una sola respuesta por pregunta');return salidas.at(-1);};
try {
  meta=createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    const p=JSON.parse(b);res.setHeader('Content-Type','application/json');
    if(p.status==='read'){res.end('{"success":true}');return;}
    assert.equal(p.to,telefono);const id=`wamid.MIX-SAL-${marca}-${salidas.length}`;
    salidas.push({...p,id});res.end(JSON.stringify({messages:[{id}]}));
  });});
  await new Promise(r=>meta.listen(0,'127.0.0.1',r));ia=await arrancarAnthropicMock();
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:ia.baseUrl,
    ANTHROPIC_API_KEY:'test-only',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'};
  s1=await arrancarServidor({...env,PORT:'55982'});s2=await arrancarServidor({...env,PORT:'55983'});
  const inicial=await procesar([texto('Hola')]);assert.equal(inicial.interactive.type,'list');
  assert.match(inicial.interactive.body.text,/Chipotle \(\+\$5\)/);
  let q=await procesar([toque(inicial,'Roja')]);
  assert.deepEqual((await leer()).carrito.items[0].modificadores[0].opciones,['Roja']);
  assert((await leer()).eleccionInteractiva);assert(filas(q).some(r=>r.title==='Listo con estas'));
  await procesar([toque(inicial,'Verde')],0); // mismo diálogo ya consumido, otro wamid
  await parar(s1);await parar(s2);
  s1=await arrancarServidor({...env,PORT:'55982'});s2=await arrancarServidor({...env,PORT:'55983'});
  q=await procesar([toque(q,'Verde')]);
  assert.deepEqual((await leer()).carrito.items[0].modificadores[0].opciones,['Roja','Verde']);
  assert.deepEqual(filas(q).map(r=>r.title),['Listo con estas']);
  console.log('OK reinicio entre salsas, roja + verde conservadas, doble toque sin efecto, máximo respetado.');
  // Un texto sustituye exactamente, sin cerrar por el mero hecho de escribir.
  q=await procesar([texto('cambia a chipotle')]);
  assert.deepEqual((await leer()).carrito.items[0].modificadores[0].opciones,['Chipotle']);assert((await leer()).eleccionInteractiva);
  q=await procesar([texto('agrega roja')]);
  assert.deepEqual((await leer()).carrito.items[0].modificadores[0].opciones,['Chipotle','Roja']);
  q=await procesar([toque(q,'Listo con estas')]);assert.equal((await leer()).pendiente.grupo,'Proteína');
  q=await procesar([toque(q,'Pollo')]);assert.equal((await leer()).pendiente.grupo,'Guarnición');
  q=await procesar([toque(q,'Frijoles')]);assert(!filas(q).some(r=>r.title==='Listo con estas'));
  q=await procesar([toque(q,'Papas a la mexicana')]);q=await procesar([toque(q,'Listo con estas')]);
  assert.equal((await leer()).pendiente.tipo,'modalidad');q=await procesar([toque(q,filas(q)[0].title)]);
  assert.equal((await leer()).pendiente.tipo,'pago');q=await procesar([toque(q,'efectivo')]);
  assert.equal((await leer()).pendiente.tipo,'confirmar_resumen');
  assert.match(q.interactive.body.text,/Chipotle, Roja/);assert.match(q.interactive.body.text,/Total: \$145/);
  await procesar([toque(q,'Confirmar')]);await procesar([toque(q,'Confirmar')],0);
  const e=await leer();assert(e.hechos.confirmado);assert.equal(e.carrito.items.length,1);
  const pedidos=(await pool.query('SELECT datos FROM pedidos_activos WHERE negocio_id=$1',[negocioId])).rows;
  assert.equal(pedidos.length,1);assert.equal(Number(pedidos[0].datos.total),145);
  const trazas=(await pool.query('SELECT errores_proveedor,acciones FROM agente_turnos WHERE negocio_id=$1',[negocioId])).rows;
  assert(trazas.every(t=>!t.errores_proveedor?.length&&!t.acciones.some(a=>a.origen==='modelo')));
  console.log('OK proteínas, dos guarniciones, entrega, pago, confirmación: un pedido de $145, cero llamadas al modelo, todo local.');
} finally {await parar(s1);await parar(s2);ia?.detener();meta?.closeAllConnections();meta?.close();await pool.end();}
