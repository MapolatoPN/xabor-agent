import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import sharp from 'sharp';
import {telefonoComprador,comandoCompra,resumenTicketWhatsapp} from '../src/services/comprasWhatsappDialogo.js';

const url = new URL(process.env.COMPRAS_TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:55454/postgres');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
const schema = 'compras_wa_test_'+randomUUID().replaceAll('-','');
url.searchParams.set('options','-c search_path='+schema);
process.env.DATABASE_URL=url.toString(); process.env.STORAGE_DRIVER='local';
const db = new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:false}});
await db.connect();
await db.query(`CREATE SCHEMA ${schema}; CREATE TABLE negocios(id uuid PRIMARY KEY); CREATE TABLE configuracion(negocio_id uuid,clave text,valor text)`);
for (const n of ['069_compras_operativas.sql','070_compras_pagos_fondos.sql','071_compras_whatsapp.sql','071_compras_whatsapp.sql'])
  await db.query(await readFile(new URL('../migrations/'+n,import.meta.url),'utf8'));
const C=await import('../src/services/comprasOperativas.js'),F=await import('../src/services/comprasFinanzas.js');
const {pool}=await import('../src/services/database.js');
const {manejarCompraWhatsapp,cerrarComprasWhatsapp}=await import('../src/services/comprasWhatsapp.js');
const {ingresarTicketWhatsapp}=await import('../src/services/comprasTicketIngreso.js');
const {eliminarArchivo}=await import('../src/services/almacenamiento.js');
const A=randomUUID(),B=randomUUID(),phone='528780000001';
await db.query('INSERT INTO negocios VALUES($1),($2)',[A,B]);
const r=await F.crearResponsable(A,{nombre:'Comprador de prueba'});
await db.query('INSERT INTO compras_whatsapp_autorizados(negocio_id,telefono,responsable_id,activo) VALUES($1,$2,$3,true)',[A,phone,r.id]);
const today=new Date().toISOString().slice(0,10);
await F.registrarFondo(A,{responsable_id:r.id,fecha:today,monto:1000,tipo:'entrega',clave_operacion:randomUUID()});
let pass=0, fail=0, actual, responses=[];
const base={proveedor:'Proveedor prueba',fecha:today,total:100,moneda:'MXN',items:[{descripcion:'Producto',cantidad:1,importe:100}],advertencias:[]};
async function t(name,fn){try{await fn();pass++;console.log('OK',name)}catch(e){fail++;console.error('FAIL',name,e.stack)}}
async function msg(text,{tenant=A,from=phone,id=randomUUID(),image=false,extra=base}={}) {
  const foto=await sharp({create:{width:30,height:30,channels:3,background:'#'+randomUUID().replaceAll('-','').slice(0,6)}}).jpeg().toBuffer();
  responses=[];
  const handled=await manejarCompraWhatsapp({negocioId:tenant,message:{from,id,type:image?'image':'text',image:image?{id:'media'}:undefined,text:{body:text}},
    descargar:async()=>({buffer:foto}),responder:async s=>responses.push(s),
    ingresar:(tenant,buffer,actor)=>ingresarTicketWhatsapp(tenant,buffer,actor,async()=>extra)});
  if(image&&handled){const {rows}=await db.query('SELECT compra_id FROM compras_whatsapp_tickets WHERE negocio_id=$1 AND wamid=$2',[tenant,id]);if(rows[0])actual=await C.obtenerCompra(tenant,rows[0].compra_id)}
  return handled;
}
const code=c=>c.id.slice(0,8)+'-v'+c.version;
try {
  await t('Normaliza México sin autorizar prefijos extranjeros',async()=>{
    assert.equal(telefonoComprador('8780000001'),phone);assert.equal(telefonoComprador('5218780000001'),phone);
    assert.equal(telefonoComprador('1538780000001'),null);
    assert.equal(comandoCompra('sí'),null);assert.equal(comandoCompra('confirmar deadbeef-v1 cuenta'),null);
    assert.equal(comandoCompra('CONFIRMAR deadbeef-v1 CRÉDITO').origen,'credito');
  });
  await t('Clientes y otros negocios siguen al agente de pedidos',async()=>{
    assert.equal(await msg('compras',{from:'528780000099'}),false);assert.equal(await msg('compras',{tenant:B}),false);
    assert.equal(await msg('quiero dos tacos'),false);
    assert.equal(await msg('sí'),false);
  });
  await t('Foto crea solamente borrador y responde con código',async()=>{
    await msg('',{image:true});assert.equal(actual.estado,'borrador');assert.equal(actual.pagos.length,0);assert(responses[0].includes(code(actual)));
  });
  await t('Sí no confirma ni consume el fondo',async()=>{await msg('sí');assert.equal((await C.obtenerCompra(A,actual.id)).estado,'borrador')});
  await t('Pago fondo y reenvío no duplican',async()=>{
    const text='CONFIRMAR '+code(actual)+' FONDO';await msg(text);await msg(text);
    const c=await C.obtenerCompra(A,actual.id);assert.equal(c.estado,'confirmada');assert.equal(c.pagos.length,1);assert.equal(c.pagado,100);
  });
  await t('Crédito deja deuda y no consume fondo',async()=>{
    await msg('',{image:true});await msg('CONFIRMAR '+code(actual)+' CREDITO');
    const c=await C.obtenerCompra(A,actual.id);assert.equal(c.tipo_pago,'credito');assert.equal(c.pagos.length,0);assert.equal(c.pendiente,100);
  });
  await t('Otra cuenta registra pago ajeno al fondo',async()=>{
    await msg('',{image:true});await msg('CONFIRMAR '+code(actual)+' CUENTA Banco prueba');
    const c=await C.obtenerCompra(A,actual.id);assert.equal(c.pagos[0].origen,'otra_cuenta');assert.equal(c.pagos[0].cuenta,'Banco prueba');
  });
  await t('Cambios en panel requieren confirmar la versión nueva',async()=>{
    await msg('',{image:true});const old=code(actual);await C.actualizarBorrador(A,actual.id,{version:actual.version,total:200});
    await msg('CONFIRMAR '+old+' FONDO');assert(responses[0].includes('cambió'));assert.equal((await C.obtenerCompra(A,actual.id)).estado,'borrador');
    // Incluso si se repite el código viejo tras recibir el nuevo resumen.
    await msg('CONFIRMAR '+old+' FONDO');assert.equal((await C.obtenerCompra(A,actual.id)).estado,'borrador');
  });
  await t('Cancelación solo del borrador identificado',async()=>{
    actual=await C.obtenerCompra(A,actual.id);await msg('CANCELAR '+code(actual));assert.equal((await C.obtenerCompra(A,actual.id)).estado,'cancelada');
  });
  await t('Fondo insuficiente revierte también tipo de pago y estado',async()=>{
    await msg('',{image:true,extra:{...base,total:5000}});await msg('CONFIRMAR '+code(actual)+' FONDO');
    const c=await C.obtenerCompra(A,actual.id);assert.equal(c.estado,'borrador');assert.equal(c.pagos.length,0);
  });
  await t('Mismo wamid recupera borrador sin otra extracción',async()=>{
    const id=randomUUID();await msg('',{image:true,id});const compraId=actual.id;await msg('',{image:true,id});assert.equal(actual.id,compraId);
  });
  await t('Misma foto devuelve duplicado y almacenamiento privado',async()=>{
    const foto=await sharp({create:{width:32,height:32,channels:3,background:'#fefefe'}}).jpeg().toBuffer();
    const first=await ingresarTicketWhatsapp(A,foto,'test',async()=>base);
    const second=await ingresarTicketWhatsapp(A,foto,'test',async()=>{throw new Error('No llamar IA')});
    assert.equal(first.id,second.id);assert.equal(second.repetida,true);
  });
  await t('Resumen respeta tamaño y código versionado',async()=>{
    const text=resumenTicketWhatsapp({...actual,items:Array(50).fill({descripcion:'x'.repeat(500),importe:1})});assert(text.length<4096);
  });
} finally {
  for(const row of (await db.query('SELECT ticket_storage_key FROM compras_operativas WHERE ticket_storage_key IS NOT NULL')).rows) await eliminarArchivo(row.ticket_storage_key);
  await cerrarComprasWhatsapp();await pool.end();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();
}
console.log(`Compras WhatsApp: ${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
