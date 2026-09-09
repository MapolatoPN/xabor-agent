import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import pg from 'pg';
import express from 'express';
import sharp from 'sharp';

// Nunca lee DATABASE_URL del entorno ni permite un host remoto. Todo se crea
// en un schema aleatorio, sin borrar tablas preexistentes ni usar datos reales.
const url = new URL(process.env.COMPRAS_TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:55454/postgres');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'La prueba exige PostgreSQL local desechable');
const schema = 'compras_test_' + randomUUID().replaceAll('-','');
url.searchParams.set('options','-c search_path='+schema);
process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DRIVER = 'local';
const admin = new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:false}});
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.query(`CREATE TABLE negocios (id uuid PRIMARY KEY); CREATE TABLE configuracion (negocio_id uuid,clave text,valor text);`);
const A=randomUUID(),B=randomUUID();
await admin.query('INSERT INTO negocios VALUES ($1),($2)',[A,B]);
await admin.query("INSERT INTO configuracion VALUES ($1,'timezone','America/Matamoros'),($2,'timezone','America/Matamoros')",[A,B]);
const migration=n=>readFile(new URL('../migrations/'+n,import.meta.url),'utf8');
await admin.query(await migration('069_compras_operativas.sql'));
await admin.query(await migration('070_compras_pagos_fondos.sql'));
const C = await import('../src/services/comprasOperativas.js');
const F = await import('../src/services/comprasFinanzas.js');
const {pool} = await import('../src/services/database.js');
const {registrarRutasCompras} = await import('../src/services/comprasRutas.js');
const {eliminarArchivo} = await import('../src/services/almacenamiento.js');
let pass=0,fail=0;
async function t(name,fn){try{await fn();pass++;console.log('OK',name)}catch(e){fail++;console.error('FAIL',name,e.stack)}}
const rejects=(promise,code)=>assert.rejects(promise,e=>e.codigo===code);
const day='2026-09-01';
const fondoInput=(r,monto,extra={})=>({responsable_id:r.id,monto,fecha:day,tipo:'entrega',clave_operacion:randomUUID(),...extra});
const draft=(tenant=A,extra={})=>C.crearBorradorManual(tenant,{proveedor:'Proveedor de prueba',fecha:day,total:100,tipo_pago:'credito',...extra},'test');
const confirm=c=>C.confirmarCompra(c.negocio_id,c.id,{version:c.version});
const payment=(c,monto,extra={})=>F.registrarPagoCompra(c.negocio_id,c.id,{monto,fecha:day,origen:'otra_cuenta',cuenta:'Cuenta de prueba',clave_operacion:randomUUID(),...extra},'test');
const app=express();app.use(express.json({limit:'20mb'}));
let callsIA=0;
registrarRutasCompras(app,{
  requireAuthSeguro(req,res,next){const tenant=req.headers['x-test-tenant'];if(![A,B].includes(tenant))return res.sendStatus(401);req.negocioId=tenant;req.rol=req.headers['x-test-role']||'admin';req.usuarioId='test';next();},
  async extraerTicket(){callsIA++;return {proveedor:'Ticket de prueba',fecha:day,total:25,items:[{descripcion:'Leche',cantidad:2,unidad:'L',precio_unitario:12.5,importe:25,categoria_sugerida:'Lácteos',confianza:.9}],confianza:.9,advertencias:[]};}
});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
app.use(express.static(fileURLToPath(new URL('../panel',import.meta.url))));
const base='http://127.0.0.1:'+server.address().port;
const http=(path,{tenant=A,role='admin',method='GET',body}={})=>fetch(base+'/api/admin/compras'+path,{method,headers:{'x-test-tenant':tenant,'x-test-role':role,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});

try {
  const r=await F.crearResponsable(A,{nombre:'Papá'});
  const rb=await F.crearResponsable(B,{nombre:'Papá'});
  await t('migraciones idempotentes sin alterar datos',async()=>{
    await admin.query(await migration('069_compras_operativas.sql'));await admin.query(await migration('070_compras_pagos_fondos.sql'));
    assert.equal((await F.listarResponsables(A)).length,1);
  });
  await t('35,000 fondo; 8,000 pagados; 5,000 crédito => 27,000 fondo y 5,000 deuda',async()=>{
    await F.registrarFondo(A,fondoInput(r,35000));
    let c=await draft(A,{total:8000,tipo_pago:'contado'});
    c=await C.confirmarCompra(A,c.id,{version:c.version,pago_inicial:{origen:'fondo',responsable_id:r.id,clave_operacion:randomUUID()}});
    assert.equal(c.pagado,8000);assert.equal(c.pendiente,0);
    await confirm(await draft(A,{total:5000}));
    const s=await F.resumenCompras(A,{desde:day,hasta:day});
    assert.equal(s.comprobado,13000);assert.equal(s.saldo_fondo,27000);assert.equal(s.deuda_proveedores,5000);
    assert.equal((await F.resumenCompras(B,{desde:day,hasta:day})).saldo_fondo,0);
  });
  await t('pago desde otra cuenta no consume fondo; abonos no duplican compra',async()=>{
    const c=await confirm(await draft(A,{total:300}));
    await payment(c,100);await payment(c,200);
    assert.equal((await C.obtenerCompra(A,c.id)).pendiente,0);
    const s=await F.resumenCompras(A,{desde:day,hasta:day});assert.equal(s.comprobado,13300);assert.equal(s.saldo_fondo,27000);
  });
  await t('borradores no suman gasto ni deuda; entrega no suma gasto',async()=>{
    await draft(A,{total:999});const before=await F.resumenCompras(A,{desde:day,hasta:day});
    await F.registrarFondo(A,fondoInput(r,100));const after=await F.resumenCompras(A,{desde:day,hasta:day});
    assert.equal(before.comprobado,after.comprobado);assert.equal(before.deuda_proveedores,after.deuda_proveedores);assert.equal(after.saldo_fondo,before.saldo_fondo+100);
  });
  await t('guardado parcial conserva cabecera, conceptos, IDs y metadatos OCR; reordenar no mezcla',async()=>{
    let c=await draft(A,{items:[{descripcion:'Leche',unidad:'L',cantidad:2,precio_unitario:50,importe:100,categoria_sugerida:'Lácteos',confianza:.93},{descripcion:'Pan',unidad:'pz',precio_unitario:5,importe:5}]});
    const ids=c.items.map(i=>i.id);
    c=await C.actualizarBorrador(A,c.id,{version:c.version,notas:'Revisado'});assert.equal(c.items.length,2);assert.equal(c.proveedor,'Proveedor de prueba');
    c=await C.actualizarBorrador(A,c.id,{version:c.version,items:[{id:ids[1],descripcion:'Pan integral'},{id:ids[0],cantidad:3}]});
    assert.equal(c.items[0].id,ids[1]);assert.equal(c.items[0].unidad,'pz');assert.equal(c.items[1].unidad,'L');assert.equal(Number(c.items[1].confianza),.93);assert.equal(c.items[1].categoria_sugerida,'Lácteos');
    await rejects(C.actualizarBorrador(A,c.id,{version:c.version,items:[{descripcion:''}]}),'DESCRIPCION_REQUERIDA');
    const foreign=await draft(B,{items:[{descripcion:'Ajeno'}]});
    await rejects(C.actualizarBorrador(A,c.id,{version:c.version,items:[{id:foreign.items[0].id,descripcion:'X'}]}),'ITEM_ID_INVALIDO');
    assert.equal((await C.obtenerCompra(A,c.id)).items.length,2);
  });
  await t('dos ediciones de la misma versión: solo una persiste',async()=>{
    const c=await draft();const results=await Promise.allSettled([C.actualizarBorrador(A,c.id,{version:c.version,notas:'uno'}),C.actualizarBorrador(A,c.id,{version:c.version,notas:'dos'})]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.codigo,'VERSION_DESFASADA');
  });
  await t('confirmación contado atómica: fondo insuficiente no deja compra ni pago',async()=>{
    const c=await draft(B,{tipo_pago:'contado'});
    await rejects(C.confirmarCompra(B,c.id,{version:c.version,pago_inicial:{origen:'fondo',responsable_id:rb.id,clave_operacion:randomUUID()}}),'FONDO_INSUFICIENTE');
    const after=await C.obtenerCompra(B,c.id);assert.equal(after.estado,'borrador');assert.equal(after.pagos.length,0);
  });
  await t('confirmar contado sin origen se rechaza; repetir confirmación no paga doble',async()=>{
    const c=await draft(A,{tipo_pago:'contado'});await rejects(C.confirmarCompra(A,c.id,{version:c.version}),'PAGO_INICIAL_REQUERIDO');
    const input={version:c.version,pago_inicial:{origen:'otra_cuenta',cuenta:'Cuenta test',clave_operacion:randomUUID()}};
    await C.confirmarCompra(A,c.id,input);await C.confirmarCompra(A,c.id,input);
    assert.equal((await C.obtenerCompra(A,c.id)).pagos.length,1);
  });
  await t('concurrencia: abonos distintos nunca sobrepagan',async()=>{
    const c=await confirm(await draft());const rs=await Promise.allSettled([payment(c,70),payment(c,70)]);
    assert.equal(rs.filter(x=>x.status==='fulfilled').length,1);assert.equal(rs.find(x=>x.status==='rejected').reason.codigo,'SOBREPAGO');
    assert.equal((await C.obtenerCompra(A,c.id)).pagado,70);
  });
  await t('reintentos concurrentes de pago/fondo: exactamente una fila; clave diferente contenido 409',async()=>{
    const c=await confirm(await draft());const key=randomUUID();const rs=await Promise.all([payment(c,25,{clave_operacion:key}),payment(c,25,{clave_operacion:key})]);assert.equal(rs[0].id,rs[1].id);
    await rejects(payment(c,26,{clave_operacion:key}),'OPERACION_REUTILIZADA');
    const input=fondoInput(r,10);const fs=await Promise.all([F.registrarFondo(A,input),F.registrarFondo(A,input)]);assert.equal(fs[0].id,fs[1].id);
    await rejects(F.registrarFondo(A,{...input,monto:11}),'OPERACION_REUTILIZADA');
  });
  await t('aislamiento financiero: no compra/responsable/archivo del otro negocio',async()=>{
    const c=await confirm(await draft(B));assert.equal(await C.obtenerCompra(A,c.id),null);
    await rejects(F.registrarPagoCompra(A,c.id,{monto:1}),'COMPRA_NO_ENCONTRADA');
    await rejects(F.registrarFondo(A,fondoInput(rb,1)),'RESPONSABLE_NO_ENCONTRADO');
    assert.equal((await http('/'+c.id)).status,404);assert.equal((await http('/'+c.id+'/ticket')).status,404);
  });
  await t('cancelar compra pagada bloquea; reversión auditable y cancelación sin borrar',async()=>{
    let c=await confirm(await draft());const p=await payment(c,100);
    await rejects(C.cancelarCompra(A,c.id,{version:c.version,motivo:'Error'}),'COMPRA_CON_PAGOS');
    await F.revertirMovimiento(A,'pago',p.id,{motivo:'Captura duplicada'},'admin-test');
    c=await C.obtenerCompra(A,c.id);assert.equal(c.pendiente,100);assert(c.pagos[0].revertido_at);
    await C.cancelarCompra(A,c.id,{version:c.version,motivo:'Compra duplicada'},'admin-test');assert.equal((await C.obtenerCompra(A,c.id)).cancelacion_motivo,'Compra duplicada');
  });
  await t('arrastre entre semanas, devolución y reversión que agotaría fondo',async()=>{
    const other=await F.crearResponsable(A,{nombre:'Otro responsable'});const f=await F.registrarFondo(A,fondoInput(other,500,{fecha:'2026-08-25'}));
    const c=await confirm(await draft(A,{total:200}));await payment(c,200,{origen:'fondo',responsable_id:other.id});
    const s=await F.resumenCompras(A,{desde:day,hasta:day});const bal=s.responsables.find(x=>x.id===other.id);assert.equal(bal.saldo_anterior,500);assert.equal(bal.saldo,300);
    await rejects(F.revertirMovimiento(A,'fondo',f.id,{motivo:'Error'}),'FONDO_INSUFICIENTE');
    await F.registrarFondo(A,fondoInput(other,100,{tipo:'devolucion'}));assert.equal((await F.resumenCompras(A,{desde:day,hasta:day})).responsables.find(x=>x.id===other.id).saldo,200);
  });
  await t('retroactivo no usa dinero entregado después; fecha inválida/futura y monto inválido rechazados',async()=>{
    const other=await F.crearResponsable(A,{nombre:'Fondo tardío'});await F.registrarFondo(A,fondoInput(other,100,{fecha:'2026-09-02'}));
    const c=await confirm(await draft());await rejects(payment(c,10,{origen:'fondo',responsable_id:other.id}),'FONDO_INSUFICIENTE');
    await rejects(F.registrarFondo(A,fondoInput(r,5,{fecha:'2026-02-30'})),'FECHA_REQUERIDO'.replace('REQUERIDO','REQUERIDA'));
    await rejects(F.registrarFondo(A,fondoInput(r,5,{fecha:'2099-01-01'})),'FECHA_FUTURA');
    for(const monto of [true,NaN,-1,0,1.001,'1e2'])await rejects(payment(c,monto),'MONTO_INVALIDO');
  });
  await t('día local correcto cuando UTC ya es otro día; filtros inválidos no se ignoran',async()=>{
    assert.equal(await F.hoyNegocio(admin,A,new Date('2026-09-07T03:30:00Z')),'2026-09-06');
    await rejects(F.resumenCompras(A,{desde:'no-es-fecha'}),'PERIODO_INVALIDO');
  });
  await t('factura posterior es auditable sin alterar compra/pagos; errores no descartan cifras',async()=>{
    let c=await confirm(await draft());await payment(c,100);const total=c.total;
    c=await C.actualizarFacturaCompra(A,c.id,{version:c.version,estado_factura:'facturado',cfdi_uuid:randomUUID()},'admin-test');
    assert.equal(Number(c.total),Number(total));assert.equal(c.pagado,100);assert.equal(c.estado_factura,'facturado');
    assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM compras_factura_cambios WHERE compra_id=$1',[c.id])).rows[0].n,1);
    await rejects(C.actualizarFacturaCompra(A,c.id,{version:c.version,estado_factura:'pendiente',cfdi_uuid:randomUUID()}),'FACTURA_INVALIDA');
    await rejects(draft(A,{total:1.001}),'MONTO_INVALIDO');await rejects(draft(A,{fecha:'2026-02-30'}),'FECHA_REQUERIDA');
    for(const campo of ['importe','precio_unitario','cantidad'])for(const valor of [-1,true,'1e2',1.0001])
      await rejects(draft(A,{items:[{descripcion:'Valor inválido',[campo]:valor}]}),'MONTO_INVALIDO');
    const sinFecha=await draft(A,{fecha:null});assert((await C.listarCompras(A,{desde:day,hasta:day})).compras.some(x=>x.id===sinFecha.id));
  });
  await t('legacy no inventa pagos, responsables ni deuda conocida',async()=>{
    await admin.query("INSERT INTO compras_operativas(negocio_id,proveedor,fecha,total,tipo_pago,estado) VALUES($1,'Legacy',$2,123,'contado','confirmada')",[A,day]);
    await admin.query('INSERT INTO fondos_compras(negocio_id,fecha,monto,responsable) VALUES($1,$2,900,\'Legacy\')',[A,day]);
    const s=await F.resumenCompras(A,{desde:day,hasta:day});assert.equal(s.compras_sin_revisar,1);assert.equal(s.fondos_sin_responsable,1);assert(!s.pendientes.some(p=>p.proveedor==='Legacy'));
  });
  await t('HTTP roles y auth: staff captura, mesero no accede; solo admin fondos/pagos/cancelación',async()=>{
    assert.equal((await fetch(base+'/api/admin/compras')).status,401);
    assert.equal((await http('',{role:'mesero'})).status,403);
    assert.equal((await http('/manual',{role:'staff',method:'POST',body:{proveedor:'Staff'}})).status,201);
    for(const path of ['/fondos','/'+randomUUID()+'/pagos','/'+randomUUID()+'/cancelar']) assert.equal((await http(path,{role:'staff',method:'POST',body:{}})).status,403);
  });
  await t('foto real por HTTP: borrador, imagen privada sin EXIF, duplicado 409 antes de IA, cancelación permite reintentar',async()=>{
    const photo=await sharp({create:{width:100,height:100,channels:3,background:'#eee'}}).jpeg().withMetadata().toBuffer();
    const body={base64:photo.toString('base64'),filename:'ticket.jpg'};
    let response=await http('/analizar-ticket',{method:'POST',body});assert.equal(response.status,201);
    const {compra:c}=await response.json();assert.equal(c.estado,'borrador');assert.equal(c.items[0].unidad,'L');
    const file=await http('/'+c.id+'/ticket');assert.equal(file.status,200);const meta=await sharp(Buffer.from(await file.arrayBuffer())).metadata();assert.equal(meta.exif,undefined);
    assert.equal((await http('/'+c.id+'/ticket',{tenant:B})).status,404);
    const before=callsIA;response=await http('/analizar-ticket',{method:'POST',body});assert.equal(response.status,409);assert.equal(callsIA,before);
    await C.cancelarCompra(A,c.id,{version:c.version,motivo:'Reintento'});assert.equal((await http('/analizar-ticket',{method:'POST',body})).status,201);
    assert.equal((await http('/analizar-ticket',{method:'POST',body:{base64:Buffer.from('<svg>fake</svg>').toString('base64')}})).status,400);
  });
  await t('navegador móvil: responsable, fondo, compra, confirmación y abono completos; revisión escritorio',async()=>{
    const browser=await puppeteer.launch({executablePath:process.env.COMPRAS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    try {
      const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.setExtraHTTPHeaders({'x-test-tenant':B,'x-test-role':'admin'});
      await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await page.goto(base+'/compras.html');
      const idle=()=>page.waitForFunction(()=>!document.querySelector('#new-manual').disabled&&document.querySelector('#m-fondo').textContent!=='—');
      const fill=(selector,value)=>page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
      await idle();
      await page.click('[data-view="fondos"]');await page.click('#new-responsable');await fill('#responsable-form [name="nombre"]','Responsable UI');await page.click('#responsable-form button:not([type])');
      await page.waitForFunction(()=>!document.querySelector('#responsable-dialog').open);await idle();
      const responsible=(await F.listarResponsables(B)).find(r=>r.nombre==='Responsable UI');assert(responsible);
      await page.click('#new-fondo');await fill('#fund-form [name="responsable_id"]',responsible.id);await fill('#fund-form [name="monto"]',1000);await page.click('#fund-form [type="submit"]');
      await page.waitForFunction(()=>!document.querySelector('#fund-dialog').open);await idle();
      assert.equal(await page.$eval('#m-fondo',el=>el.textContent),moneyTest(1000));
      await page.click('#new-manual');await page.waitForSelector('#editor[open]');await idle();
      await fill('#editor-form [name="proveedor"]','Proveedor UI');await fill('#editor-form [name="total"]',200);await fill('#editor-form [name="tipo_pago"]','contado');await fill('#editor-form [name="origen"]','fondo');await fill('#editor-form [name="responsable_id"]',responsible.id);
      await page.click('#add-item');await fill('#items [data-field="descripcion"]','Producto UI');await fill('#items [data-field="unidad"]','kg');await fill('#items [data-field="precio_unitario"]',200);await fill('#items [data-field="importe"]',200);
      await page.click('#confirm-purchase');await page.waitForFunction(()=>!document.querySelector('#editor').open);await idle();
      assert.equal(await page.$eval('#m-fondo',el=>el.textContent),moneyTest(800));
      const c=(await C.listarCompras(B,{q:'Proveedor UI'})).compras[0];const detail=await C.obtenerCompra(B,c.id);assert.equal(detail.items[0].unidad,'kg');assert.equal(detail.pagado,200);
      await page.click('#new-manual');await page.waitForSelector('#editor[open]');await idle();await fill('#editor-form [name="proveedor"]','Crédito UI');await fill('#editor-form [name="total"]',300);await page.click('#confirm-purchase');await page.waitForFunction(()=>!document.querySelector('#editor').open);await idle();
      assert.equal(await page.$eval('#m-fondo',el=>el.textContent),moneyTest(800));
      await page.click('[data-view="proveedores"]');
      const credit=(await C.listarCompras(B,{q:'Crédito UI'})).compras[0];await page.click(`#deudas-list [data-open="${credit.id}"]`);await page.waitForSelector('#editor[open]');await idle();await page.click('#new-payment');
      await fill('#payment-form [name="monto"]',100);await fill('#payment-form [name="origen"]','otra_cuenta');await fill('#payment-form [name="cuenta"]','Cuenta UI');await page.click('#payment-form [type="submit"]');await page.waitForFunction(()=>!document.querySelector('#payment-dialog').open);await idle();
      assert.equal((await C.obtenerCompra(B,credit.id)).pendiente,200);assert.equal((await F.resumenCompras(B)).responsables.find(r=>r.id===responsible.id).saldo,800);
      const qa=resolve(process.env.COMPRAS_QA_DIR||'../compras-qa');await mkdir(qa,{recursive:true});await page.screenshot({path:resolve(qa,'mobile-editor.png'),fullPage:true});
      await page.click('[data-close="editor"]');await page.click('[data-view="fondos"]');await page.screenshot({path:resolve(qa,'mobile-fondos.png'),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Sin desborde horizontal de página');
      await page.setViewport({width:1440,height:1000});await page.click('[data-view="compras"]');await page.screenshot({path:resolve(qa,'desktop-compras.png'),fullPage:true});
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  });
} finally {
  const {rows}=await admin.query('SELECT ticket_storage_key FROM compras_operativas WHERE ticket_storage_key IS NOT NULL');
  for(const row of rows) await eliminarArchivo(row.ticket_storage_key);
  server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
}
console.log(`Compras integración: ${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
function moneyTest(n){return new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(n);}
