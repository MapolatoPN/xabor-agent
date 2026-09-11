import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crearContinuidad} from '../src/services/whatsappContinuidad.js';
import {getSession,restaurarSesion,desalojarDeMemoria,guardarPreviewPedido,verPreviewConfirmable} from '../src/agent/session.js';
if(!/^postgres(?:ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL||'')) throw Error('Solo base local de prueba');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const locks=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:3});
await pool.query(await readFile(new URL('../migrations/076_conversacion_durable.sql',import.meta.url),'utf8'));
await pool.query(await readFile(new URL('../migrations/077_webhook_entrante_durable.sql',import.meta.url),'utf8'));
await pool.query(await readFile(new URL('../migrations/078_whatsapp_continuidad.sql',import.meta.url),'utf8'));
const n=randomUUID(), otro=randomUUID(), tel='521000000001';
await pool.query("INSERT INTO negocios(id,nombre,slug) VALUES($1,'Continuidad test',$3),($2,'Continuidad otro',$4)",[n,otro,n,otro]);
let pasadas=0,fallidas=0;
async function t(nombre,fn){try{await fn();pasadas++;console.log('OK '+nombre);}catch(e){fallidas++;console.error('FALLO '+nombre+': '+e.stack);}}
const sid=(a,b)=>`meta-${a}-${b}`;
const entrada=(id,neg=n,telefono=tel)=>({negocioId:neg,telefono,wamid:id,payload:{message:{id,from:telefono,type:'text',text:{body:id}},value:{}}});
let ejecuciones=0,max=0,activos=0; const vistos=[];
const crear=(extra={})=>crearContinuidad({pool,locks,ventanaMs:0,
 cargarSesion:(a,b,s)=>restaurarSesion(sid(a,b),s),leerSesion:(a,b)=>getSession(sid(a,b)),
 procesar:async (lote,a,b)=>{ejecuciones++;activos++;max=Math.max(max,activos);vistos.push(lote.map(p=>p.message.id));
   const s=getSession(sid(a,b));s.mensajes.push({role:'user',content:lote.map(p=>p.message.id).join('\n')});
   await new Promise(r=>setTimeout(r,30));activos--;},...extra});
const a=crear(),b=crear();
try {
await t('reentrega duplicada se guarda y ejecuta una vez; lote conserva todos los mensajes',async()=>{
 await a.recibir([entrada('uno'),entrada('dos'),entrada('uno')]);await a.ejecutar(n,tel);
 assert.equal(ejecuciones,1);assert.deepEqual(vistos[0],['uno','dos']);
 await b.recibir([entrada('uno')]);await b.ejecutar(n,tel);assert.equal(ejecuciones,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM mensajes WHERE negocio_id=$1',[n])).rows[0].n,2);
});
await t('dos trabajadores no ejecutan simultáneamente la misma conversación',async()=>{
 await a.recibir([entrada('tres')]);await Promise.all([a.ejecutar(n,tel),b.ejecutar(n,tel)]);assert.equal(max,1);assert.equal(ejecuciones,2);
});
await t('reinicio del motor recupera historial y preview confirmable desde PostgreSQL',async()=>{
 const c=crear({procesar:async()=>guardarPreviewPedido(sid(n,tel),{total:149,fingerprint:'original',orden:{items:[{producto_id:78,cantidad:1}]}})});
 await c.recibir([entrada('preview')]);await c.ejecutar(n,tel);desalojarDeMemoria(sid(n,tel));
 const d=crear({procesar:async()=>{const s=getSession(sid(n,tel));assert.equal(s.mensajes.length,2);assert.equal(verPreviewConfirmable(sid(n,tel)).total,149);}});
 await d.recibir([entrada('confirmar')]);await d.ejecutar(n,tel);
 assert.equal((await pool.query('SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1',[n])).rows[0].requiere_revision,false);
});
await t('mismo teléfono en otro negocio tiene estado separado',async()=>{
 await a.recibir([entrada('uno',otro)]);await a.ejecutar(otro,tel);
 assert.equal(getSession(sid(otro,tel)).mensajes.length,1);assert.equal(verPreviewConfirmable(sid(otro,tel)),null);
});
await t('mensaje pendiente nunca iniciado se recupera con un coordinador nuevo',async()=>{
 await a.recibir([entrada('pendiente',n,'521000000002')]);const antes=ejecuciones;
 await crear().ejecutar(n,'521000000002');assert.equal(ejecuciones,antes+1);
});
await t('el worker utiliza el carrito 076 existente, sin iniciar una segunda copia',async()=>{
 const telefono='521000000008',foto=getSession(sid(n,telefono));foto.pedido.items=[{nombre:'Carrito anterior',cantidad:2}];
 await pool.query('INSERT INTO conversacion_estado(negocio_id,session_id,estado) VALUES($1,$2,$3)',[n,sid(n,telefono),JSON.stringify(foto)]);
 desalojarDeMemoria(sid(n,telefono));
 const c=crear({procesar:async()=>assert.equal(getSession(sid(n,telefono)).pedido.items[0].cantidad,2)});
 await c.recibir([entrada('continuar-version-anterior',n,telefono)]);await c.ejecutar(n,telefono);
 assert.equal((await pool.query('SELECT revision FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[n,sid(n,telefono)])).rows[0].revision,'2');
});
await t('reentrega de un mensaje previo a 078 pide revisión sin repetir efectos',async()=>{
 const telefono='521000000009',id='viejo-'+n;
 await pool.query("INSERT INTO mensajes(negocio_id,telefono,direccion,texto,message_id_externo) VALUES($1,$2,'entrante','viejo',$3)",[n,telefono,id]);
 const antes=ejecuciones;await a.recibir([entrada(id,n,telefono)]);await a.ejecutar(n,telefono);
 assert.equal(ejecuciones,antes);assert.equal((await pool.query('SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[n,telefono])).rows[0].requiere_revision,true);
});
await t('078 convierte sobres viejos incompletos en revisión y se puede repetir',async()=>{
 const telefono='521000000010',id='sobre-previo-'+n,pnid='previo-'+n;
 await pool.query("INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,true)",[n,pnid]);
 try {
  const payload={entry:[{changes:[{value:{metadata:{phone_number_id:pnid},messages:[{id,from:telefono,type:'text',text:{body:'pedido antes del cambio'}}]}}]}]};
  await pool.query('INSERT INTO webhook_entrante(referencia,payload) VALUES($1,$2)',[id,JSON.stringify(payload)]);
  const sql=await readFile(new URL('../migrations/078_whatsapp_continuidad.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
  const rows=(await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2',[n,id])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].estado,'revision');
  const antes=ejecuciones;await a.ejecutar(n,telefono);assert.equal(ejecuciones,antes);
 } finally {
  await pool.query('DELETE FROM integraciones_canal WHERE negocio_id=$1 AND identificador=$2',[n,pnid]);
  await pool.query('DELETE FROM webhook_entrante WHERE referencia=$1',[id]);
 }
});
await t('fallo tras empezar efectos queda para revisión sin reejecución',async()=>{
 let efectos=0,avisos=0;
 const c=crear({procesar:async()=>{efectos++;throw Error('efecto incierto simulado');},alRevision:async()=>{avisos++;}});
 await c.recibir([entrada('incierto',n,'521000000003')]);await c.ejecutar(n,'521000000003');await c.ejecutar(n,'521000000003');
 assert.equal(efectos,1);assert.equal(avisos,1);
 const r=(await pool.query("SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid='incierto'",[n])).rows[0];assert.equal(r.estado,'revision');
});
await t('checkpoint interrumpido se detecta sin repetir su efecto',async()=>{
 await a.recibir([entrada('interrumpido',n,'521000000004')]);
 await pool.query("UPDATE whatsapp_entradas SET estado='procesando' WHERE negocio_id=$1 AND wamid='interrumpido'",[n]);
 const antes=ejecuciones;await b.ejecutar(n,'521000000004');assert.equal(ejecuciones,antes);
 assert.equal((await pool.query("SELECT motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono='521000000004'",[n])).rows[0].motivo,'EJECUCION_INTERRUMPIDA');
});
await t('recepción inválida revierte también las filas anteriores del sobre',async()=>{
 await assert.rejects(a.recibir([entrada('revertir'),{...entrada('invalido'),wamid:null}]));
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid='revertir'",[n])).rows[0].n,0);
});
await t('la recepción espera el acuse humano sin incluir mensajes que aún no revisó',async()=>{
 const db=await pool.connect();let termino=false,ingreso;
 try {
  await db.query('BEGIN');
  await db.query('SELECT 1 FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE',[n,tel]);
  ingreso=a.recibir([entrada('durante-revision')]).then(()=>{termino=true;});
  await new Promise(r=>setTimeout(r,80));assert.equal(termino,false);
  await db.query('COMMIT');await ingreso;
  assert.equal((await pool.query("SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid='durante-revision'",[n])).rows[0].estado,'pendiente');
 } finally {await db.query('ROLLBACK').catch(()=>{});db.release();if(ingreso)await ingreso;}
});
await t('matar un proceso después del efecto no repite el efecto al recuperar',async()=>{
 const telefono='521000000005';await a.recibir([entrada('matar',n,telefono)]);
 const child=spawn(process.execPath,[fileURLToPath(new URL('child-continuidad-interrumpida.mjs',import.meta.url)),n,telefono],{env:process.env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',d=>{logs+=d;});
 const salida=new Promise(r=>child.once('exit',r));
 try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child no inició '+logs)),10000);child.stdout.on('data',d=>{if(String(d).includes('EFECTO_HECHO')){clearTimeout(timer);resolve();}});});
 } finally {child.kill();await salida;}
 for(let i=0;i<20;i++){
   await b.ejecutar(n,telefono);
   const c=(await pool.query('SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[n,telefono])).rows[0];
   if(c.requiere_revision)break;
   await new Promise(r=>setTimeout(r,50));
 }
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM mensajes WHERE negocio_id=$1 AND telefono=$2 AND texto='EFECTO-INTERRUMPIDO'",[n,telefono])).rows[0].n,1);
 assert.equal((await pool.query('SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[n,telefono])).rows[0].requiere_revision,true);
});
} finally {
 await a.detener();await b.detener();
 await pool.query('DELETE FROM mensajes WHERE negocio_id=ANY($1::uuid[])',[[n,otro]]);
 await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=ANY($1::uuid[])',[[n,otro]]);
 await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=ANY($1::uuid[])',[[n,otro]]);
 await pool.query('DELETE FROM negocios WHERE id=ANY($1::uuid[])',[[n,otro]]);
 await pool.end();await locks.end();
}
console.log(`${pasadas} pasadas, ${fallidas} fallidas`);process.exitCode=fallidas?1:0;
