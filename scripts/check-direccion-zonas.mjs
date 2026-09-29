// Regresiones puras: no base de datos, Meta, pedidos reales ni cobros.
import assert from 'node:assert/strict';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { aplicarRespuestaDeEntrega } from '../src/mesero-agente/canalDelAgente.js';
import { calcularCostoEnvio } from '../src/orders/costoEnvioDelPedido.js';
const reglas = { pedidos: { costo_envio: 60, zonas_entrega: [
  {nombre:'Cervecera',costo:150},
  {nombre:'Coca Cola',costo:120}, {nombre:'UTNC',costo:150},
  {nombre:'Cartonera',costo:120}, {nombre:'COMISION FEDERAL / CARBON 2',costo:200},
] } };
const modalidades = ['recoger en tienda','entrega a domicilio'];
const nuevo = () => {
  const estado = estadoNuevo({negocioId:'prueba',conversacionId:'direccion-zonas'});
  estado.carrito.datos = {modalidad:'entrega a domicilio',costo_envio:60};
  return estado;
};
const entregar = (estado,mensaje,args) => crearEjecutor({estado,reglas,modalidades,mensaje})
  .ejecutar('definir_entrega',args);
let pasadas = 0, fallidas = 0;
const t = async (nombre,fn) => {try {await fn();pasadas++;} catch(e) {fallidas++;console.error(`${nombre}: ${e.message}`);}};
await t('dirección con letras y número juntos',async()=>{
  const estado=nuevo();
  const r=await entregar(estado,'Boulevard cbtis34 208 Col Centro',
    {direccion:'Boulevard Cbtis 34 #208, Col Centro'});
  assert.equal(r.aplicado,true);
  assert.equal(estado.carrito.datos.cliente.direccion,'Boulevard Cbtis 34 #208, Col Centro');
});
for(const direccion of ['Boulevard Cbtis 35 #208 Col Centro','Boulevard Cbtis 34 #280 Col Centro',
  'Calle Nogal 900 Col Centro'])await t(`no inventa números: ${direccion}`,async()=>{
  assert.equal((await entregar(nuevo(),'Boulevard cbtis34 208 Col Centro',{direccion})).aplicado,false);
});
await t('conserva sufijos de domicilio',async()=>{
  assert.equal((await entregar(nuevo(),'Calle Nogal 208A Col Centro',
    {direccion:'Calle Nogal 208B Col Centro'})).aplicado,false);
});
for(const [direccion,costo] of [['Cervecera puerta 2',150],['UTNC edificio principal',150],
  ['Coca-Cola entrada 1',120],['Cocacola entrada 1',120],['Cartonera puerta 2',120],
  ['Comisión Federal acceso 1',200],['Carbón 2 caseta',200],
  ['Calle Centro 208',60],['Calle UTNCita 208',60]]) {
  await t(`tarifa desde dirección sin zona del modelo: ${direccion}`,async()=>{
    const estado=nuevo();
    const r=await entregar(estado,direccion,{direccion});
    assert.equal(r.aplicado,true);assert.equal(estado.carrito.datos.costo_envio,costo);
    assert.equal(calcularCostoEnvio({reglas,modalidad:'domicilio',subtotal:200,
      costoSolicitado:estado.carrito.datos.costo_envio}),costo);
  });
}
await t('dirección nueva elimina tarifa vieja y no depende del costo propuesto',async()=>{
  const estado=nuevo();
  await entregar(estado,'UTNC edificio 1',{direccion:'UTNC edificio 1'});
  assert.equal(estado.carrito.datos.costo_envio,150);
  await entregar(estado,'Ahora a Calle Centro 208',{direccion:'Calle Centro 208'});
  assert.equal(estado.carrito.datos.costo_envio,60);
  assert.equal(calcularCostoEnvio({reglas,modalidad:'domicilio',subtotal:200,
    costoSolicitado:estado.carrito.datos.costo_envio}),60);
});
await t('agregar otro en Flow conserva la tarifa del destino existente',async()=>{
  const estado=nuevo();
  await entregar(estado,'UTNC edificio 1',{direccion:'UTNC edificio 1'});
  await entregar(estado,'entrega a domicilio',{modalidad:'entrega a domicilio'});
  assert.equal(estado.carrito.datos.costo_envio,150);
});
await t('recoger no cobra y volver a domicilio recalcula',async()=>{
  const estado=nuevo();
  await entregar(estado,'UTNC edificio 1',{direccion:'UTNC edificio 1'});
  await entregar(estado,'mejor voy a recoger',{modalidad:'recoger en tienda'});
  assert.equal(estado.carrito.datos.costo_envio,0);
  await entregar(estado,'mejor entrega a domicilio',{modalidad:'entrega a domicilio'});
  assert.equal(estado.carrito.datos.costo_envio,150);
});
await t('negocios distintos no comparten tarifas',()=>{
  assert.equal(calcularCostoEnvio({reglas:{pedidos:{costo_envio:25,zonas_entrega:[]}},
    modalidad:'domicilio',subtotal:200,direccion:'UTNC edificio 1',costoSolicitado:150}),25);
});
await t('dos destinos con tarifas distintas exigen aclaración, sin cambiar el pedido',async()=>{
  const estado=nuevo(),antes=structuredClone(estado.carrito);
  const r=await entregar(estado,'UTNC o Coca Cola',{direccion:'UTNC o Coca Cola'});
  assert.equal(r.aplicado,false);assert.equal(r.codigo,'zona_ambigua');assert.deepEqual(estado.carrito,antes);
});
await t('zona explícita acepta un alias configurado, no uno inventado',async()=>{
  const estado=nuevo();
  const r=await entregar(estado,'Es a Carbón 2 caseta',
    {direccion:'Carbón 2 caseta',zona_entrega:'COMISION FEDERAL / CARBON 2'});
  assert.equal(r.aplicado,true);assert.equal(r.parcial,undefined);assert.equal(estado.carrito.datos.costo_envio,200);
});
await t('no anuncia envío antes de tener dirección',()=>{
  const salida={texto:'¿Cuál es la dirección completa para la entrega?',operaciones:[{
    herramienta:'definir_entrega',resultado:{aplicado:true,pedido:{modalidad:'entrega a domicilio',costo_envio:60}}}]};
  assert.doesNotMatch(aplicarRespuestaDeEntrega({salida}).texto,/\$60/);
});
await t('sí comunica el envío después de resolver la dirección',()=>{
  const salida={texto:'Anotado.',operaciones:[{herramienta:'definir_entrega',resultado:{aplicado:true,
    pedido:{modalidad:'entrega a domicilio',cliente:{direccion:'UTNC edificio 1'},costo_envio:150}}}]};
  assert.match(aplicarRespuestaDeEntrega({salida}).texto,/\$150/);
});
console.log(`dirección y zonas: ${pasadas} OK, ${fallidas} fallos`);
assert.equal(fallidas,0);
