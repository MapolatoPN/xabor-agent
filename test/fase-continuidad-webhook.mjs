// Webhook firmado, dos servidores reales, proveedores simulados. Nunca producción.
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {arrancarServidor} from './lib-servidor.mjs';
import {arrancarMetaMock} from './lib-meta-mock.mjs';
import {arrancarAnthropicMock} from './lib-anthropic-mock.mjs';
import puppeteer from 'puppeteer';
import {crearTokenSesion} from '../src/services/session.js';
import {pool,actualizarConfiguracion,obtenerConfiguracion} from '../src/services/database.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const seed=JSON.parse(await readFile(new URL('.datos-prueba.json',import.meta.url)));
const n=seed.negocioA,b=seed.negocioB,phone='5287900'+Math.floor(Math.random()*10000).toString().padStart(4,'0');
const pnid='continuidad-'+randomUUID(), secret='firma-local-continuidad';
const cfg=await obtenerConfiguracion(n);
const bot=(await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1',[n])).rows[0].bot_whatsapp_activo;
await pool.query("INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,true)",[n,pnid]);
await actualizarConfiguracion({int_wa_phone_id:pnid,int_wa_token:'token-mock-continuidad'},n);
await pool.query('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1',[n]);
const meta=await arrancarMetaMock(),ia=await arrancarAnthropicMock();
const env={META_GRAPH_BASE_URL:meta.baseUrl,ANTHROPIC_BASE_URL:ia.baseUrl,ANTHROPIC_API_KEY:'test-only',META_APP_SECRET:secret};
let s1,s2,ok=0,fail=0;
let productoPrueba,categoriaPrueba;
const cookie=`xabor_sesion=${encodeURIComponent(crearTokenSesion({usuarioId:seed.adminNegocioAUsuarioId,negocioId:n,rol:'admin'}))}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function esperar(fn){const end=Date.now()+16000;while(Date.now()<end){if(await fn())return;await delay(80);}throw Error('Timeout: '+s1?.obtenerSalida().slice(-2200));}
async function detener(s){if(!s)return;const salida=new Promise(r=>s.proc.once('exit',r));s.detener();await salida;}
async function t(name,fn){try{await fn();console.log('OK '+name);ok++;}catch(e){console.error('FALLO '+name+': '+e.stack);fail++;}}
const msg=(id,text)=>({id,from:phone,type:'text',text:{body:text}});
async function post(messages,base=s1.base,adicionales=[]){
 const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:pnid},messages,contacts:[{profile:{name:'Cliente de prueba'}}]}}]},...adicionales]});
 return fetch(base+'/webhook/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')},body});
}
async function estado(){return (await pool.query('SELECT * FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[n,phone])).rows[0];}
try {
 s1=await arrancarServidor({...env,PORT:'4986'});s2=await arrancarServidor({...env,PORT:'4987'});
 await t('recepción confirma después de guardar todos los mensajes y dos servidores responden una sola vez',async()=>{
  ia.encolarRespuesta('Primer lote recibido.');
  const r=await post([msg('c1-'+phone,'hola'),msg('c2-'+phone,'buenas tardes')],s1.base,[{changes:[{field:'messages',value:{metadata:{phone_number_id:pnid},messages:[msg('c2b-'+phone,'qué tal')]}}]}]);assert.equal(r.status,200);
  const m=await pool.query('SELECT texto FROM mensajes WHERE negocio_id=$1 AND telefono=$2 ORDER BY id',[n,phone]);assert.equal(m.rows.length,3);
  await esperar(async()=>Number((await estado())?.revision)===1);
  const textos=meta.obtenerMensajesEnviados().filter(m=>m.type==='text'&&m.to===phone);assert.equal(textos.length,1);assert.equal(textos[0].text.body,'Primer lote recibido.');
  assert.equal((await estado()).sesion.mensajes[0].content,'hola\nbuenas tardes\nqué tal');
 });
 await t('recepción que no puede persistir devuelve 503 y no deja un lote parcial',async()=>{
  const r=await post([msg('rollback-'+phone,'mensaje válido'),msg(null,'sin identificador')]);assert.equal(r.status,503);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2',[n,'rollback-'+phone])).rows[0].n,0);
 });
 await t('reentrega a otra instancia no ejecuta la IA ni duplica respuesta',async()=>{
  await post([msg('c1-'+phone,'hola')],s2.base);await delay(900);
  assert.equal(Number((await estado()).revision),1);
  assert.equal(meta.obtenerMensajesEnviados().filter(m=>m.type==='text'&&m.to===phone).length,1);
 });
 await t('reiniciar ambos servidores conserva el historial usado en el siguiente turno',async()=>{
  await detener(s1);s1=null;await detener(s2);s2=null;
  let vioHistorial=false;
  ia.encolarRespuesta(payload=>{vioHistorial=payload.messages.some(m=>m.role==='assistant'&&m.content==='Primer lote recibido.');return 'Segundo lote recibido.';});
  s1=await arrancarServidor({...env,PORT:'4986'});
  await post([msg('c3-'+phone,'hola de nuevo')]);await esperar(async()=>Number((await estado()).revision)===2);
  assert.equal(vioHistorial,true);assert.equal((await estado()).requiere_revision,false);
 });
 await t('preview persistido confirma una sola venta tras reinicio y reentrega',async()=>{
  await detener(s1);s1=null;
  categoriaPrueba=(await pool.query("INSERT INTO menu_categorias(negocio_id,nombre,activa,orden) VALUES($1,'Continuidad E2E',true,990) RETURNING id",[n])).rows[0].id;
  productoPrueba=(await pool.query("INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) VALUES($1,$2,'Platillo Continuidad E2E',149,true) RETURNING id",[n,categoriaPrueba])).rows[0].id;
  const sesion=(await estado()).sesion;
  sesion.pedidoPreview={ordenCanonica:{cliente:{nombre:'Cliente de prueba',telefono:phone},modalidad:'recoger',forma_pago:'efectivo',canal:'whatsapp',items:[{producto_id:productoPrueba,nombre:'Platillo Continuidad E2E',cantidad:1}]},total:149,fingerprint:'preview-e2e',ts:Date.now(),consumido:false,confirmable:true};
  sesion.awaitingConfirmacion=true;
  await pool.query('UPDATE whatsapp_conversaciones SET sesion=$3 WHERE negocio_id=$1 AND telefono=$2',[n,phone,JSON.stringify(sesion)]);
  s1=await arrancarServidor({...env,PORT:'4986'});
  await post([msg('confirmacion-'+phone,'sí')]);await esperar(async()=>Number((await estado()).revision)===3);
  const pedidos=async()=>(await pool.query("SELECT datos FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2",[n,phone])).rows;
  assert.equal((await pedidos()).length,1);assert.equal(Number((await pedidos())[0].datos.total),149);
  await post([msg('confirmacion-'+phone,'sí')]);await delay(900);assert.equal((await pedidos()).length,1);
 });
 await t('turno interrumpido bloquea reejecución y queda visible después de recargar estado',async()=>{
  await detener(s1);s1=null;
  await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,'{}','procesando')",[n,phone,'c4-'+phone]);
  s1=await arrancarServidor({...env,PORT:'4986'});await esperar(async()=>(await estado()).requiere_revision);
  const r=await fetch(s1.base+`/api/conversacion/${phone}/estado-bot`,{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.equal((await r.json()).requiereRevision,true);
 });
 await t('el panel muestra revisión persistida y acción explícita después de recargar',async()=>{
  const browser=await puppeteer.launch({headless:true,protocolTimeout:15000});
  try {
   const page=await browser.newPage();await page.setViewport({width:1366,height:900});
   page.on('dialog',d=>d.dismiss());
   page.on('pageerror',e=>console.error('PANEL_ERROR '+e.message));
   page.setDefaultTimeout(15000);
   await page.setRequestInterception(true);
   page.on('request',r=>r.url().startsWith(s1.base)||r.url().startsWith('data:')?r.continue():r.abort());
   await page.setCookie({name:'xabor_sesion',value:cookie.slice('xabor_sesion='.length),url:s1.base,httpOnly:true});
   for(let i=0;i<2;i++){
    await page.goto(s1.base+'/app',{waitUntil:'domcontentloaded'});
    await page.waitForSelector('#tab-chats',{visible:true});await page.click('#tab-chats');
    await page.waitForSelector('#contacto-'+phone,{visible:true});await page.click('#contacto-'+phone);
    await page.waitForFunction(()=>document.querySelector('#chat-atencion-estado')?.textContent==='Conversación pendiente de revisión');
    assert.match(await page.$eval('#btn-toggle-bot',e=>e.textContent),/Revisé y atendí/);
   }
   await page.screenshot({path:'../whatsapp-continuidad-revision.png'});
   const cantidad=await page.evaluate(telefono=>{
    const m={id:'prueba-actualizacion',telefono,direccion:'entrante',texto:'Imagen recibida'};
    recibirMensajeWS(m);recibirMensajeWS({...m,texto:'Imagen descargada'});
    return [...document.querySelectorAll('[data-mensaje-id="prueba-actualizacion"]')].map(e=>e.textContent);
   },phone);
   assert.equal(cantidad.length,1);assert.match(cantidad[0],/Imagen descargada/);
  } finally {await browser.close();}
 });
 await t('reactivar exige revisión explícita y no reejecuta el turno pendiente',async()=>{
  const url=s1.base+`/api/conversacion/${phone}/reactivar`;
  let r=await fetch(url,{method:'POST',headers:{Cookie:cookie}});assert.equal(r.status,409);
  let id=(await pool.query('SELECT max(id)::text AS id FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2',[n,phone])).rows[0].id;
  await post([msg('nuevo-revision-'+phone,'también necesito ayuda')]);
  r=await fetch(url,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({revisionConfirmada:true,hastaEntrada:id})});assert.equal(r.status,409);
  assert.equal((await estado()).requiere_revision,true);
  id=(await pool.query('SELECT max(id)::text AS id FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2',[n,phone])).rows[0].id;
  r=await fetch(url,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({revisionConfirmada:true,hastaEntrada:id})});assert.equal(r.status,200,await r.text());
  assert.equal((await estado()).requiere_revision,false);assert.equal((await estado()).sesion,null);
  assert.equal((await pool.query("SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2",[n,'c4-'+phone])).rows[0].estado,'revisado');
 });
} finally {
 await detener(s1);await detener(s2);ia.detener();meta.detener();
 await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2',[n,phone]);
 await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[n,phone]);
 await pool.query('DELETE FROM mensajes WHERE negocio_id=$1 AND telefono=$2',[n,phone]);
 await pool.query("DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2",[n,phone]);
 await pool.query("DELETE FROM pedidos WHERE negocio_id=$1 AND telefono=$2",[n,phone]);
 if(productoPrueba)await pool.query('DELETE FROM menu_productos WHERE negocio_id=$1 AND id=$2',[n,productoPrueba]);
 if(categoriaPrueba)await pool.query('DELETE FROM menu_categorias WHERE negocio_id=$1 AND id=$2',[n,categoriaPrueba]);
 await pool.query('DELETE FROM integraciones_canal WHERE identificador=$1',[pnid]);
 await actualizarConfiguracion({int_wa_phone_id:cfg.int_wa_phone_id||'',int_wa_token:cfg.int_wa_token||''},n);
 await pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1',[n,bot]);await pool.end();
}
console.log(`${ok} pasadas, ${fail} fallidas`);process.exitCode=fail?1:0;
