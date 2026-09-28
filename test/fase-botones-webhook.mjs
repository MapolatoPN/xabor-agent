// Dos servidores reales y Postgres local. Meta/Anthropic no salen del equipo.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { pool } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const {negocioId,telefono,marca} = await prepararNegocioBotones();
const secreto = 'botones-solo-local', entregadas = [];
let s1,s2,ia,meta,secuencia=0;
const parar = async s => { if(!s || s.proc.exitCode!==null || s.proc.signalCode!==null)return; const fin=new Promise(r=>s.proc.once('exit',r)); s.detener(); await fin; };
const leer = async () => (await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`])).rows[0].estado;
const esperar = async (fn,etiqueta) => {
  const fin=Date.now()+40000;
  while(Date.now()<fin){if(await fn())return;await new Promise(r=>setTimeout(r,100));}
  throw Error(`Timeout ${etiqueta}\n${s1?.obtenerSalida().slice(-3000)}\n${s2?.obtenerSalida().slice(-3000)}`);
};
const publicar = async (base,mensajes) => {
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
    metadata:{phone_number_id:marca},contacts:[{wa_id:telefono,profile:{name:'Cliente local'}}],messages:mensajes}}]}]});
  const r=await fetch(`${base}/webhook/whatsapp`,{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':`sha256=${createHmac('sha256',secreto).update(body).digest('hex')}`}});
  assert.equal(r.status,200);
};
const identidad = () => ({id:`wamid.BTN-${marca}-${++secuencia}`,from:telefono,timestamp:String(Math.floor(Date.now()/1000))});
const texto = body => ({...identidad(),type:'text',text:{body}});
const toque = (salida,indice=0,title='Etiqueta ignorada') => ({...identidad(),type:'interactive',context:{id:salida.id},
  interactive:{type:'button_reply',button_reply:{id:salida.interactive.action.buttons[indice].reply.id,title}}});
const procesar = async (mensajes,{salidas=1,duplicar=true}={}) => {
  const antes=entregadas.length;
  await publicar(s2.base,mensajes);
  if(duplicar)await publicar(s1?.proc.exitCode===null&&s1?.proc.signalCode===null?s1.base:s2.base,mensajes);
  await esperar(async()=> (await pool.query("SELECT count(*)::int AS n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2::text[]) AND estado='completado'",
    [negocioId,mensajes.map(m=>m.id)])).rows[0].n===mensajes.length,'entradas completadas');
  assert.equal(entregadas.length,antes+salidas,'número exacto de respuestas');
  return entregadas.at(-1);
};
const comprobarBotones = s => { assert.equal(s.type,'interactive');assert.equal(s.interactive.type,'button');
  assert.deepEqual(s.interactive.action.buttons.map(b=>b.reply.title),['Confirmar','Cambiar algo','Agregar otro']);
  assert(s.interactive.action.buttons.every(b=>/^xb1:[\w-]{22}$/.test(b.reply.id))); };
try {
  meta=createServer((req,res)=>{
    if(req.method!=='POST'||!req.url.endsWith('/messages')){res.writeHead(404);res.end();return;}
    let body='';req.on('data',b=>body+=b);req.on('end',()=>{
      const p=JSON.parse(body);res.setHeader('Content-Type','application/json');
      if(p.status==='read'){res.end('{"success":true}');return;}
      assert.equal(p.to,telefono,'Meta simulado no permite destinatarios ajenos');
      const id=`wamid.BTN-SALIDA-${marca}-${entregadas.length}`;entregadas.push({...p,id});res.end(JSON.stringify({messages:[{id}]}));
    });
  });
  await new Promise(r=>meta.listen(0,'127.0.0.1',r));ia=await arrancarAnthropicMock();
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:ia.baseUrl,
    ANTHROPIC_API_KEY:'test-only',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'};
  s1=await arrancarServidor({...env,PORT:'55980'});s2=await arrancarServidor({...env,PORT:'55981'});
  const inicial=await procesar([texto('Hola')]);comprobarBotones(inicial);
  assert.equal((await leer()).dialogo.enviado,true);
  console.log('OK botón real en payload Meta, asociación persistida y acuse.');
  const ajeno=toque(inicial);ajeno.context.id='wamid.ajeno';
  await procesar([ajeno,{...identidad(),type:'interactive',interactive:{type:'list_reply',list_reply:{id:'Confirmar',title:'Confirmar'}}},
    {...identidad(),type:'button',button:{payload:'Confirmar',text:'Confirmar'}}],{salidas:0});
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[negocioId]);
  await procesar([toque(inicial)],{salidas:0});
  assert.equal((await leer()).folio,null);
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1',[negocioId]);
  console.log('OK tipos ajenos, contexto falso y bot apagado: ningún pedido ni respuesta.');

  const cambio=toque(inicial,1,'Confirmar'); // un título falsificado no confirma
  const cambiar=await procesar([cambio]);assert.match(cambiar.text.body,/Escribe qué deseas cambiar/);
  assert.equal((await leer()).folio,null);
  const avisoCambio=await procesar([toque(inicial,0)]);
  assert.match(avisoCambio.text.body,/no está vigente/);assert.equal((await leer()).folio,null);
  await procesar([toque(inicial,0)],{salidas:0});
  console.log('OK Cambiar algo no confirma; Confirmar anterior avisa una vez sin efectos.');

  const anterior=await procesar([texto('Hola')]);comprobarBotones(anterior);
  const actual=await procesar([texto('Hola')]);comprobarBotones(actual);
  const aviso=await procesar([toque(anterior)]);comprobarBotones(aviso);
  assert.match(aviso.interactive.body.text,/no está vigente/);
  await procesar([toque(anterior)],{salidas:0});
  console.log('OK pregunta vieja avisa una sola vez y presenta el resumen actual.');

  const mixto=await procesar([toque(aviso),texto('Hola')]);comprobarBotones(mixto);
  assert.equal((await leer()).folio,null);
  await procesar([toque(aviso)],{salidas:0});
  console.log('OK texto y botón en un lote: ningún toque ejecutado.');

  await parar(s1);await parar(s2);
  s2=await arrancarServidor({...env,PORT:'55981'});
  const confirmar=toque(mixto);
  const fin=await procesar([confirmar]);assert.equal(fin.type,'text');
  const estado=await leer();assert(estado.folio);assert.equal(estado.hechos.confirmado,true);
  await procesar([toque(mixto),toque(mixto,1)],{salidas:0});
  const pedidos=(await pool.query('SELECT folio,datos FROM pedidos_activos WHERE negocio_id=$1',[negocioId])).rows;
  assert.equal(pedidos.length,1);assert.equal(Number(pedidos[0].datos.total),45);
  const preguntas=(await pool.query('SELECT estado,resultado FROM agente_preguntas_interactivas WHERE negocio_id=$1 AND resultado->>\'folio\'=$2',[negocioId,estado.folio])).rows;
  assert.equal(preguntas.length,1);assert.equal(preguntas[0].estado,'terminada');
  assert.equal(estado.botonesReserva,undefined);
  const trazas=(await pool.query('SELECT errores_proveedor,acciones FROM agente_turnos WHERE negocio_id=$1',[negocioId])).rows;
  assert(trazas.every(t=>!t.errores_proveedor?.length&&!t.acciones.some(a=>a.origen==='modelo')),'los botones no llaman al modelo');
  const control=(await pool.query('SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[negocioId,telefono])).rows[0];
  assert.equal(control.requiere_revision,false);
  console.log(`OK reinicio completo, confirmar sin modelo, ${entregadas.length} respuestas y un solo pedido local de $45; cero efectos externos.`);
} finally {await parar(s1);await parar(s2);ia?.detener();meta?.closeAllConnections();meta?.close();await pool.end();}
