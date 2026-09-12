// Regresión de la conversación real de Obispado, sin teléfonos ni mensajes privados.
// La carta se replica en un negocio desechable; nunca se llama al proveedor real.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
const mock=await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL=mock.baseUrl;
process.env.PORT='4297';
const { pool }=await import('../src/services/database.js');
assert(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname),'Solo base local de pruebas');
const { validarBorradorPedido: validar, mensajeBorradorParaCliente: mensaje, continuarAclaracionProducto: continuar }=await import('../src/orders/validadorOrden.js');
const { solicitaAtencionHumana }=await import('../src/utils/solicitudPersona.js');
const { procesarMensaje }=await import('../src/agent/brain.js');
const { getSession, desalojarDeMemoria, verPreviewConfirmable }=await import('../src/agent/session.js');
const q=async(s,p)=>(await pool.query(s,p)).rows[0];
const n=(await q('INSERT INTO negocios(nombre,slug) VALUES ($1,$2) RETURNING id',['Test contexto','contexto-'+randomUUID()])).id;
const fixture=JSON.parse(readFileSync(new URL('./fixtures/chilaquiles-obispado.json',import.meta.url)));
let ok=0,fail=0;
async function t(nombre,fn){try{await fn();ok++;console.log('OK '+nombre);}catch(e){fail++;console.error('FALLO '+nombre,e);}}
const mod=(grupo,...opciones)=>({grupo,opciones});
const texto='Quiero unos chilaquiles en salsa Suiza con huevos estrellados y le pones frijoles y papas a la mexicana';
const borrador={items:[{nombre:'Chilaquiles',cantidad:1,modificadores:[mod('Salsa','Suiza'),mod('Proteína','Huevos estrellados'),mod('Guarniciones','frijoles','papas a la mexicana')]}]};
const original='Si quiero unos chilaquiles suizos con pollo, bistec en salsa y queso panela Además una orden de hotcakes de sartén';
const doble={items:[{nombre:'Chilaquiles',cantidad:1,modificadores:[mod('Salsa','Suiza'),mod('Proteína','pollo'),mod('Guarniciones','bistec en salsa','queso panela')]},{nombre:'Hotcakes de Sarten',cantidad:1,modificadores:[]}]};
let pendiente;
try{
 const c=(await q('INSERT INTO menu_categorias(negocio_id,nombre) VALUES($1,$2) RETURNING id',[n,'Desayunos'])).id;
 const ids=new Map();
 for(const p of fixture.catalogo)ids.set(p.id,(await q('INSERT INTO menu_productos(negocio_id,categoria_id,nombre,descripcion,precio,disponible) VALUES($1,$2,$3,$4,$5,true) RETURNING id',[n,c,p.nombre,p.descripcion,p.precio])).id);
 for(const g of fixture.grupos){
  const id=(await q('INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[n,ids.get(g.producto_id),g.nombre,g.requerido,g.minimo,g.maximo])).id;
  for(const o of g.opciones)await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible) VALUES($1,$2,$3,$4,$5)',[n,id,o.nombre,o.precio_extra,o.disponible]);
 }
 await t('la familia existe: no niega ni elige una presentación',async()=>{
  const r=await validar({items:[{nombre:'Chilaquiles',cantidad:1}]},n,{textoCiclo:'Quiero chilaquiles'});
  assert.equal(r.ok,false);assert.equal(r.productosNoExisten[0].estado,'ambiguo');assert.equal(r.productosNoExisten[0].candidatos.length,4);assert.doesNotMatch(mensaje(r),/no manejamos/i);
 });
 await t('las guarniciones descartan Bowl y Combito; explica la elección pendiente',async()=>{
  const r=await validar(borrador,n,{textoCiclo:texto});
  assert.deepEqual([...r.productosNoExisten[0].candidatos].sort(),['Chilaquiles Mixtos','Chilaquiles Sencillos']);
  assert.match(mensaje(r),/195\.00/);assert.match(mensaje(r),/205\.00/);assert.match(mensaje(r),/papas a la mexicana/i);assert.doesNotMatch(mensaje(r),/Bowl|Combito/);
 });
 await t('una guarnición inventada por el modelo no descarta presentaciones',async()=>{
  const r=await validar(borrador,n,{textoCiclo:'Quiero chilaquiles'});
  assert.equal(r.productosNoExisten[0].candidatos.length,4);assert.doesNotMatch(mensaje(r),/papas|frijoles|Ya anoté/i);
 });
 await t('no pierde el segundo platillo al preguntar ni al elegir',async()=>{
  const r=await validar(doble,n,{textoCiclo:original});
  assert.deepEqual([...r.productosNoExisten[0].candidatos].sort(),['Chilaquiles Mixtos','Chilaquiles Sencillos']);
  pendiente={nombre:'Chilaquiles',candidatos:r.productosNoExisten[0].candidatos,borrador:doble};
  const b=continuar(pendiente,'Los sencillos');assert.equal(b.items.length,2);assert.deepEqual(b.items[1],doble.items[1]);assert.deepEqual(b.items[0].modificadores,doble.items[0].modificadores);assert.equal(doble.items[0].nombre,'Chilaquiles');
  const v=await validar(b,n,{textoCiclo:original+' Los sencillos'});assert.equal(v.productosNoExisten.length,0);
 });
 await t('una respuesta que cambia ingredientes no revive el pedido anterior',()=>{
  assert.equal(continuar(pendiente,'Sencillos sin pollo'),null);assert.equal(continuar(pendiente,'mejor cancela'),null);assert.equal(continuar(pendiente,'Chilaquiles'),null);
 });
 await t('las menciones del chilaquil pendiente no se niegan contra los hotcakes resueltos',async()=>{
  const r=await validar(doble,n,{textoCiclo:original,menciones:['pollo','bistec en salsa','queso panela']});
  assert.deepEqual(r.mencionesNoResueltas||[],[]);
  assert.doesNotMatch(mensaje(r),/no manejamos|no tenemos/i);
 });
 await t('el pedido completo se valida con precios de la carta',async()=>{
  const b=structuredClone(borrador);b.items[0].nombre='Chilaquiles Sencillos';b.items[0].modificadores[2]=mod('Guarniciones','Frijolitos naturales','Papas a la mexicana');
  const r=await validar(b,n,{textoCiclo:texto+' Sencillos, frijoles naturales'});assert.equal(r.ok,true,JSON.stringify(r));
 });
 await t('frijoles sin especificar conserva la aclaración entre naturales y chorizo',async()=>{
  const b=structuredClone(borrador);b.items[0].nombre='Chilaquiles Sencillos';
  const r=await validar(b,n,{textoCiclo:texto+' Sencillos'});
  assert.equal(r.ok,false);assert.match(mensaje(r),/naturales/i);assert.match(mensaje(r),/chorizo/i);
 });
 await t('otro negocio no recibe las opciones de Obispado',async()=>{
  const r=await validar(borrador,randomUUID(),{textoCiclo:texto});assert.equal(r.ok,false);assert.doesNotMatch(mensaje(r),/Sencillos|Mixtos/);
 });
 await t('la conversación conserva el borrador aunque el modelo olvide el segundo plato',async()=>{
  const sid='contexto-'+n;
  const completo={...doble,modalidad:'recoger',forma_pago:'efectivo',cliente:{nombre:'Ana'}};
  mock.encolarRespuesta('Claro. <PEDIDO_BORRADOR>'+JSON.stringify(completo)+'</PEDIDO_BORRADOR>');mock.encolarRespuesta('{"menciones":[]}');
  await procesarMensaje(sid,original+', para recoger, efectivo, a nombre de Ana',null,'whatsapp',n,'5210000000001');
  assert.equal(getSession(sid).aclaracionProducto?.borrador.items.length,2);
  const foto=(await q('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[n,sid])).estado;
  assert.equal(foto.aclaracionProducto.borrador.items.length,2);
  desalojarDeMemoria(sid);
  mock.drenar();mock.encolarRespuesta('Claro. <PEDIDO_BORRADOR>{"items":[{"nombre":"Chilaquiles Sencillos","cantidad":1}]}</PEDIDO_BORRADOR>');mock.encolarRespuesta('{"menciones":[]}');
  const r=await procesarMensaje(sid,'Los sencillos',null,'whatsapp',n,'5210000000001');
  assert.match(JSON.stringify(r),/Hotcakes/i);
  assert.match(JSON.stringify(verPreviewConfirmable(sid)),/Hotcakes/i);
 });
 await t('pedir una persona es explícito; hablar de una persona o negarlo no lo es',()=>{
  for(const s of ['Quiero hablar con una persona','Por favor, necesito hablar con el encargado','Me pasas con un asesor'])assert.equal(solicitaAtencionHumana(s),true,s);
  for(const s of ['No quiero hablar con una persona','Una persona quiere chilaquiles','Quiero un pedido para una persona'])assert.equal(solicitaAtencionHumana(s),false,s);
 });
}finally{
 mock.detener();
 for(const tabla of ['conversacion_estado','menu_modificadores_opciones','menu_modificadores_grupos','menu_productos','menu_categorias'])await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`,[n]);
 await pool.query('DELETE FROM negocios WHERE id=$1',[n]);await pool.end();
}
console.log(`${ok} pasadas, ${fail} fallidas`);process.exit(fail?1:0);
