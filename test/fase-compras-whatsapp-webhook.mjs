// Webhook firmado real, PostgreSQL local y servidor Meta simulado. Cero envíos reales.
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {arrancarServidor} from './lib-servidor.mjs';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const seed=JSON.parse(await readFile(new URL('./.datos-prueba.json',import.meta.url),'utf8'));
const {pool}=await import('../src/services/database.js');
const C=await import('../src/services/comprasOperativas.js'),F=await import('../src/services/comprasFinanzas.js');
const A=seed.negocioA,phone='528780000077',pnid='compras-pnid-'+randomUUID(),secret='test-compras-secret';
await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2',[A,phone]);
await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[A,phone]);
const r=await F.crearResponsable(A,{nombre:'Responsable webhook '+randomUUID()});
await pool.query('INSERT INTO compras_whatsapp_autorizados(negocio_id,telefono,responsable_id) VALUES($1,$2,$3)',[A,phone,r.id]);
const previous=(await pool.query("SELECT clave,valor FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')",[A])).rows;
for(const [clave,valor] of [['int_wa_phone_id',pnid],['int_wa_token','fake-test-token']])
  await pool.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3) ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=excluded.valor',[A,clave,valor]);
await pool.query("INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo,proveedor,estado) VALUES($1,'whatsapp',$2,true,'meta','activo')",[A,pnid]);
const sent=[],mock=express();mock.use(express.json());mock.post('/v20.0/:id/messages',(req,res)=>{
  if(req.body.status==='read') return res.json({success:true});
  assert.equal(req.params.id,pnid);assert.equal(req.body.to,phone);sent.push(req.body);
  res.json({messages:[{id:'wamid.mock.'+randomUUID()}]});
});
const http=mock.listen(0,'127.0.0.1');await new Promise(r=>http.once('listening',r));
const srv=await arrancarServidor({PORT:'4973',META_APP_SECRET:secret,META_GRAPH_BASE_URL:'http://127.0.0.1:'+http.address().port,
  ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',WHATSAPP_TOKEN:'',WHATSAPP_PHONE_ID:''},{timeoutMs:30000});
// La fecha UTC puede ser mañana en el negocio durante el turno nocturno.
const day=await F.hoyNegocio(pool,A),source='wamid.compra.'+randomUUID();
const compra=await C.crearBorradorManual(A,{proveedor:'Prueba webhook',fecha:day,total:50,tipo_pago:'credito'});
await pool.query('INSERT INTO compras_whatsapp_tickets(negocio_id,telefono,wamid,compra_id,version_mostrada) VALUES($1,$2,$3,$4,$5)',[A,phone,source,compra.id,compra.version]);
const codigo=compra.id.slice(0,8)+'-v'+compra.version;
async function post(message){
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:pnid},contacts:[{profile:{name:'Comprador prueba'}}],messages:[{from:phone,...message}]}}]}]});
  assert.equal((await fetch(srv.base+'/webhook/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')},body})).status,200);
}
// Incluye la ventana durable de agrupamiento (6 s), sin cambiar su duración.
async function waitFor(fn){const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('No llegó el resultado esperado. '+srv.obtenerSalida().slice(-1500))}
try {
  await post({id:source,type:'image',image:{id:'media-no-necesaria'}});
  await waitFor(()=>sent.length===1);assert(sent[0].text.body.includes(codigo));
  assert.equal((await C.obtenerCompra(A,compra.id)).estado,'borrador');
  console.log('OK foto autorizada llega a Compras y devuelve resumen por Meta');
  await post({id:randomUUID(),type:'text',text:{body:'CONFIRMAR '+codigo+' CREDITO'}});
  await waitFor(()=>sent.length===2);assert(sent[1].text.body.includes('registrada'),sent[1].text.body+'\n'+srv.obtenerSalida().slice(-1800));
  assert.equal((await C.obtenerCompra(A,compra.id)).pendiente,50);
  console.log('OK confirmación firmada registra deuda sin pago');
  await post({id:randomUUID(),type:'text',text:{body:'CONFIRMAR '+codigo+' FONDO'}});
  await waitFor(()=>sent.length===3);assert.equal((await C.obtenerCompra(A,compra.id)).pagos.length,0);
  await waitFor(async()=>Number((await pool.query("SELECT count(*) FROM mensajes WHERE negocio_id=$1 AND telefono=$2 AND direccion='saliente' AND message_id_externo LIKE 'wamid.mock.%'",[A,phone])).rows[0].count)===3);
  console.log('OK reintento no cambia el pago; wamids salientes se guardan para evitar ecos');
} finally {
  srv.detener();http.closeAllConnections();await new Promise(r=>http.close(r));
  await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2',[A,phone]);
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[A,phone]);
  await pool.query('DELETE FROM compras_whatsapp_tickets WHERE negocio_id=$1 AND telefono=$2',[A,phone]);
  await pool.query('DELETE FROM compras_whatsapp_autorizados WHERE negocio_id=$1 AND telefono=$2',[A,phone]);
  await pool.query('DELETE FROM compras_operativas_items WHERE compra_id=$1',[compra.id]);
  await pool.query('DELETE FROM compras_operativas WHERE negocio_id=$1 AND id=$2',[A,compra.id]);
  await pool.query('DELETE FROM compras_responsables WHERE negocio_id=$1 AND id=$2',[A,r.id]);
  await pool.query('DELETE FROM integraciones_canal WHERE negocio_id=$1 AND identificador=$2',[A,pnid]);
  await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')",[A]);
  for(const row of previous)await pool.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)',[A,row.clave,row.valor]);
  await pool.query('DELETE FROM mensajes WHERE negocio_id=$1 AND telefono=$2',[A,phone]);await pool.end();
}
