import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { betaHibridaActiva,consultaInformativaHibrida,entradaRetomarPedido,textoConsultaConCarrito } from '../src/mesero-agente/experienciaHibrida.js';
import { resolverCarritoNativo,aplicarCarritoNativo } from '../src/mesero-agente/catalogoNativo.js';
import { fotoFormulario,aplicarFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { borradorCarrito,cambiarCarrito,respuestaCarrito } from '../src/mesero-agente/flowCarrito.js';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';
import { politicaDelTurno } from '../src/mesero-agente/politicaDelTurno.js';

const telefono='528700000001';
const cfg={whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:telefono,mesero_agente_telefonos:telefono,
  bot_whatsapp_solo_prueba:'true',whatsapp_catalogo_nativo_v1:'true',whatsapp_catalogo_meta_id:'1111111111',
  whatsapp_catalogo_meta_mapa:JSON.stringify([{retailer_id:'taco-harina',producto_id:'1',opciones:[{grupo:'Tortilla',opcion:'Harina'}]}]),
  whatsapp_flow_carrito_id:'2222222222',whatsapp_flow_categorias_id:'3333333333',whatsapp_flow_carrito_duplicar_v1:'true'};
const catalogo=[{id:1,nombre:'Tacos',productos:[{id:1,nombre:'Taco de papa',precio:25,disponible:true,
  modificadores:[{nombre:'Tortilla',requerido:true,minimo:1,maximo:1,opciones:[{nombre:'Maíz',precio_extra:0,disponible:true},
    {nombre:'Harina',precio_extra:5,disponible:true}]}]}]}];
const nuevo=()=>({cfg:structuredClone(cfg),telefono,catalogo:structuredClone(catalogo),estado:estadoNuevo({negocioId:'local',conversacionId:'beta'}),
  modalidades:['recoger en tienda'],metodosPago:[{tipo:'efectivo',habilitado:true,disponible_para_bot:true}],requierePago:true});
const mensaje=()=>({id:'wamid.local',from:telefono,type:'order',order:{catalog_id:cfg.whatsapp_catalogo_meta_id,
  product_items:[{product_retailer_id:'taco-harina',quantity:'4',item_price:'30.00',currency:'MXN'}]}});
let casos=0;
const caso=async(nombre,fn)=>{await fn();casos++;console.log(`OK beta ${casos}: ${nombre}`);};
await caso('apagada por defecto, dos listas cerradas y alias 52/521',()=>{
  assert.equal(betaHibridaActiva({},telefono),false);assert(betaHibridaActiva(cfg,telefono));
  assert(betaHibridaActiva(cfg,'5218700000001'));
  for(const parcial of [{whatsapp_beta_hibrido_v1:'false'},{bot_whatsapp_solo_prueba:'false'},
    {whatsapp_beta_telefonos:''},{mesero_agente_telefonos:''}])assert.equal(betaHibridaActiva({...cfg,...parcial},telefono),false);
  assert.equal(betaHibridaActiva(cfg,'528700000002'),false);
});
await caso('consultas no reemplazan decisiones mixtas, negativas ni cambios',()=>{
  for(const t of ['¿Cuánto cuesta el taco?','¿A qué hora cierran?','¿Dónde están?','¿Hacen entregas?'])assert(consultaInformativaHibrida(t),t);
  for(const t of ['Agrega 2 tacos y dime cuánto tarda','Quiero tacos sin crema','No canceles mi pedido','Confirmo','Sí'])assert.equal(consultaInformativaHibrida(t),false,t);
  assert.match(textoConsultaConCarrito('Abrimos por la mañana.'),/^Abrimos por la mañana/);
  assert.equal(textoConsultaConCarrito('x'.repeat(1025)),null);
});
await caso('consulta y cambio usan la misma barrera; cortesía no equivale a pedir',()=>{
  for(const t of ['Añádeme dos tacos y dime a qué hora cierran',
    'Ponle salsa verde y dime dónde están','Pago en efectivo, ¿a qué hora cierran?',
    'Para recoger, ¿cuánto tarda?','Elimina el taco y dime cuánto cuesta el envío',
    'Bórrame el café, ¿cuáles son las opciones?','Quiero saber cuánto cuesta y agrega dos tacos']) {
    assert.equal(consultaInformativaHibrida(t),false,t);
    assert.equal(politicaDelTurno(t).soloLectura,false,t);
  }
  for(const t of ['Quiero saber a qué hora cierran','Quisiera consultar dónde están',
    'Quiero preguntar cuánto cuesta el envío','¿Tienen tacos sin crema?']) {
    assert.equal(consultaInformativaHibrida(t),true,t);
  }
});
await caso('barrera del ejecutor de solo lectura, aunque el modelo solicite mutaciones',async()=>{
  const c=nuevo(),antes=structuredClone(c.estado);
  const e=crearEjecutor({...c,mensaje:'¿Dónde están?',soloConsulta:true});
  assert.equal((await e.ejecutar('agregar_producto',{producto_id:'1',cantidad:1})).aplicado,false);
  assert.deepEqual(c.estado.carrito,antes.carrito);
});
await caso('catálogo nativo: autoridad local, opciones concretas, atomicidad y sin efectos externos',async()=>{
  const c=nuevo();c.mensajes=[mensaje()];
  const r=await aplicarCarritoNativo(c);assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(c.estado.carrito.items.length,1);assert.equal(c.estado.carrito.items[0].cantidad,4);
  assert.equal(c.estado.carrito.items[0].modificadores[0].opciones[0],'Harina');
  assert.equal(c.estado.folio,null);assert.equal(c.estado.hechos.confirmado,false);
  const antes=structuredClone(c.estado);assert.equal((await aplicarCarritoNativo(c)).motivo,'carrito_existente');assert.deepEqual(c.estado,antes);
  const retomar=entradaRetomarPedido({...c,mensaje:'seguir pedido'});assert.equal(retomar.pendiente.tipo,'editar_pedido');
  assert.equal(entradaRetomarPedido({...c,mensaje:'sí'}),null);
});
await caso('no confiar en precios, monedas, cantidades, identidad, stock, notas o catálogos externos',async()=>{
  const cambios=[m=>m.from='528700000002',m=>m.order.catalog_id='9999999999',m=>m.order.product_items[0].currency='USD',
    m=>m.order.product_items[0].quantity='-1',m=>m.order.product_items[0].quantity='21',m=>m.order.product_items[0].quantity='1e1',
    m=>m.order.product_items[0].item_price='0',m=>m.order.product_items[0].item_price=null,
    m=>m.order.product_items[0].product_retailer_id='producto-otro-negocio',m=>m.order.text='Sin crema',
    m=>m.order.product_items.push({...m.order.product_items[0]}),m=>m.order.product_items.push({product_retailer_id:'no-existe',quantity:1,currency:'MXN',item_price:25})];
  for(const cambio of cambios){const c=nuevo(),m=mensaje();cambio(m);c.mensajes=[m];const antes=structuredClone(c.estado);assert.equal((await aplicarCarritoNativo(c)).ok,false);assert.deepEqual(c.estado,antes);}
  for(const cambio of [c=>c.catalogo[0].productos[0].precio++,c=>c.catalogo[0].productos[0].disponible=false,
    c=>c.cfg.whatsapp_catalogo_meta_mapa='no-json',c=>c.estado.folio='XAB-1',c=>c.estado.hechos.escalado=true]){
    const c=nuevo();cambio(c);assert.equal(resolverCarritoNativo({...c,mensajes:[mensaje()]}).ok,false);
  }
});
await caso('otro igual: una pieza, nota, edición separada, deshacer y duplicado de red',async()=>{
  const env=['WHATSAPP_FLOW_ENDPOINT','WHATSAPP_FLOW_PRIVATE_KEY','META_APP_SECRET'];
  const prev=Object.fromEntries(env.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
  try {
    const c=nuevo();await aplicarCarritoNativo({...c,mensajes:[mensaje()]});
    c.estado.carrito.items[0].notas='Sin cebolla';
    Object.assign(c.estado.carrito.datos,{modalidad:'recoger en tienda',forma_pago:'efectivo'});fijarPendiente(c.estado,{tipo:'editar_pedido'});
    const foto=fotoFormulario(c,'flow_configurar');assert(foto.duplicar);
    let b=borradorCarrito(foto);const s={action:'data_exchange',screen:'CARRITO',data:{revision:'0',operacion:'duplicar',duplicar:'e0'}};
    b=cambiarCarrito(foto,b,s).borrador;assert.equal(b.filas.length,2);assert.equal(b.filas[1].item.cantidad,'1');
    assert.equal(b.filas[1].item.observaciones,'Sin cebolla');assert.equal(b.filas[0].item.cantidad,'4');
    assert.deepEqual(cambiarCarrito(foto,b,s).borrador,b);
    assert.deepEqual(cambiarCarrito({...foto,duplicar:false},borradorCarrito(foto),s).borrador,borradorCarrito(foto));
    const def=definicionFlowCarrito({duplicar:true});
    assert.deepEqual(Object.keys(respuestaCarrito(foto,b,'token').data).sort(),Object.keys(def.screens[0].data).sort());
    assert(def.screens.every(x=>x.layout.children[0].children.length<=50));
    const revertido=cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:'1',operacion:'deshacer'}}).borrador;
    assert.equal(revertido.filas.length,1);
    const sinOrigen=cambiarCarrito(foto,borradorCarrito(foto),{action:'data_exchange',screen:'CARRITO',data:{revision:'0',operacion:'duplicar',duplicar:'e0',q0:'0'}});
    assert(sinOrigen.error);assert.deepEqual(sinOrigen.borrador,borradorCarrito(foto));
    const lleno=structuredClone(foto);lleno.lineas=Array.from({length:50},(_,i)=>({...structuredClone(foto.lineas[0]),linea_id:`lleno-${i}`}));
    const llenoAntes=borradorCarrito(lleno),limite=cambiarCarrito(lleno,llenoAntes,s);
    assert(limite.error);assert.deepEqual(limite.borrador,llenoAntes);assert.equal(respuestaCarrito(lleno,llenoAntes,'token').data.puede_duplicar,false);
    const ocho={...lleno,lineas:lleno.lineas.slice(0,8)},noveno=cambiarCarrito(ocho,borradorCarrito(ocho),s).borrador;
    assert.equal(noveno.pagina,1,'la copia debe quedar visible, no escondida en otra página');
    assert.equal(def.screens[0].layout.children[0]['init-values'].duplicar,'');
    const dos=cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:'1',operacion:'duplicar',duplicar:'n0'}}).borrador;
    assert.equal(new Set(dos.filas.map(f=>f.key)).size,3);assert.equal(dos.filas[2].item.observaciones,'Sin cebolla');
    const r=await aplicarFormulario({accion:'flow_configurar',datos:foto,respuestaFlow:{filas:b.filas,modalidad:'m0',pago:'p0'}},c);
    assert.equal(r.ok,true);assert.equal(c.estado.carrito.items.length,2);assert.notEqual(c.estado.carrito.items[0].lid,c.estado.carrito.items[1].lid);
    assert.equal(c.estado.folio,null);
  }finally{for(const k of env)prev[k]===undefined?delete process.env[k]:process.env[k]=prev[k];}
});
console.log(`OK beta híbrida: ${casos} grupos de invariantes.`);
