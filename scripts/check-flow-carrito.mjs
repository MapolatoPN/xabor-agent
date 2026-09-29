import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { fotoFormulario,aplicarFormulario,comandosFormulario,entradaFormulario,construirFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { borradorCarrito,cambiarCarrito,respuestaCarrito } from '../src/mesero-agente/flowCarrito.js';
import { guardarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
const keys=['WHATSAPP_FLOW_ENDPOINT','WHATSAPP_FLOW_PRIVATE_KEY','META_APP_SECRET'];
const previo=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
Object.assign(process.env,{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
const cfg={whatsapp_flow_categorias_id:'11111111111',whatsapp_flow_carrito_id:'22222222222',whatsapp_flow_editar_id:'33333333333',
  whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',whatsapp_flows_telefonos:'5210000000001'};
const catalogo=[{id:1,nombre:'Desayunos',productos:[{id:1,nombre:'Chilaquiles',precio:100,disponible:true,modificadores:[
  {nombre:'Salsa',minimo:1,maximo:2,requerido:true,opciones:[{nombre:'Roja',precio_extra:0},{nombre:'Verde',precio_extra:10}]}]},
  {id:2,nombre:'Café',precio:40,disponible:true,modificadores:[]}]}];
const nuevo=(n=8)=>{
  const estado=estadoNuevo({negocioId:'carrito-local',conversacionId:'carrito-local'});
  estado.carrito.items=Array.from({length:n},(_,i)=>({id:1,lid:`linea-${i}`,nombre:'Chilaquiles',cantidad:1,
    notas:`Nota ${i}`,modificadores:[{grupo:'Salsa',opciones:['Roja']}]}));
  estado.carrito.datos={modalidad:'recoger en tienda',forma_pago:'efectivo',cliente:{nombre:'Local'}};
  fijarPendiente(estado,{tipo:'editar_pedido'});guardarDialogo(estado,{mensaje:'',texto:'Edita tu pedido'});
  return {estado,cfg:{...cfg},catalogo:structuredClone(catalogo),modalidades:['recoger en tienda'],requierePago:true,
    metodosPago:[{tipo:'efectivo',habilitado:true,disponible_para_bot:true}]};
};
let cantidad=0;
try {
  for(const n of [3,8,50]) {
    const ctx=nuevo(n),foto=fotoFormulario(ctx,'flow_configurar'),antes=structuredClone(ctx.estado);
    assert.equal(foto.version,'carrito_v1');
    const formulario=construirFormulario({...ctx,telefono:'5210000000001',texto:ctx.estado.dialogo.texto,pedido:crearEjecutor({...ctx,mensaje:''}).vista()});
    assert.equal(formulario.carga.action.parameters.flow_action,'data_exchange');
    assert.equal(formulario.carga.action.parameters.flow_id,cfg.whatsapp_flow_carrito_id);
    let b=borradorCarrito(foto);
    const paso=(operacion,extra={})=>{
      const r=cambiarCarrito(foto,b,{action:'data_exchange',screen:b.etapa,data:{revision:String(b.revision),operacion,...extra}});
      assert.equal(r.error,undefined,JSON.stringify(r));b=r.borrador;return b;
    };
    const vista=()=>{
      const r=respuestaCarrito(foto,b,'token');
      const pantalla=definicionFlowCarrito().screens.find(s=>s.id===r.screen);
      assert(pantalla,r.screen);
      assert.deepEqual(Object.keys(r.data).sort(),Object.keys(pantalla.data).sort(),`contrato completo ${r.screen}`);
      return r;
    };
    assert.equal(vista().screen,'CARRITO');
    const llamada={action:'data_exchange',screen:'CARRITO',data:{revision:'0',operacion:'editar',editar:'e2',q0:'0',q1:'0',q2:'4'}};
    b=cambiarCarrito(foto,b,llamada).borrador;
    assert.equal(b.filas.length,n-2);assert.equal(b.filas[0].key,'e2');assert.equal(b.filas[0].item.cantidad,'4');
    const edit=vista();assert.equal(edit.screen,'EDITAR');assert.equal(edit.data.cantidad_inicial,'4');assert.equal(edit.data.observaciones_inicial,'Nota 2');
    assert.deepEqual(edit.data.g0_inicial_m,['l0g0o0']);
    assert.deepEqual(ctx.estado,antes,'navegar y eliminar en borrador no toca pedido');
    assert.deepEqual(cambiarCarrito(foto,b,llamada).borrador,b,'doble clic/revisión vieja no duplica');
    paso('aplicar_opciones',{cantidad:'4',g0_m:['l0g0o1'],observaciones:'Sin crema'});
    assert.equal(b.etapa,'CARRITO');assert.match(vista().data.importe,/Productos/);
    paso('deshacer');assert.equal(b.filas[0].item.observaciones,'Nota 2');
    paso('deshacer');assert.equal(b.filas.length,n);assert.equal(b.filas[0].key,'e0');
    if(n===50)assert(cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:String(b.revision),operacion:'agregar'}}).error);
    paso('agregar',{q0:'0',q1:'0',q2:'4'});assert.equal(b.etapa,'MENU');vista();
    paso('terminar');assert.equal(b.etapa,'CARRITO','ver carrito sin elegir un producto');
    paso('agregar');paso('categoria',{categoria:'c0'});
    assert.equal(b.etapa,'PLATILLO');vista();paso('terminar',{producto0:'p1',cantidad:'2',observaciones:'Muy caliente'});
    assert.equal(b.etapa,'CARRITO');assert.equal(b.filas.length,n-1);assert.equal(b.filas.at(-1).key,'n0');
    paso('guardar',{modalidad:'m0',pago:'p0'});assert.equal(b.etapa,'FINAL');
    const respuesta={filas:b.filas,modalidad:b.modalidad,pago:b.pago};
    const comandos=comandosFormulario(foto,respuesta);assert(comandos);
    assert.deepEqual(comandos.filter(c=>c.herramienta==='quitar_linea').map(c=>c.argumentos.linea_id),['linea-0','linea-1']);
    for(const mutar of [c=>c.catalogo[0].productos[0].precio++,c=>c.estado.carrito.items.reverse(),c=>c.estado.carrito.items[2].notas='Otro',c=>c.cfg.whatsapp_flow_carrito_id='99999999999']) {
      const c=structuredClone(ctx);mutar(c);assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:foto,respuestaFlow:respuesta},c)).ok,false);
    }
    assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:foto,respuestaFlow:respuesta},ctx)).ok,true);
    assert.equal(ctx.estado.carrito.items.length,n-1);
    assert.equal(ctx.estado.carrito.items[0].lid,'linea-2');assert.equal(ctx.estado.carrito.items[0].cantidad,4);
    assert.deepEqual(ctx.estado.carrito.items.slice(1,-1),antes.carrito.items.slice(3));
    assert.equal(ctx.estado.carrito.items.at(-1).notas,'Muy caliente');assert.equal(ctx.estado.folio,null);
    assert.equal(crearEjecutor({...ctx,mensaje:''}).vista().total,(n+1)*100+80);
    cantidad++;
  }
  const ctx=nuevo(3),foto=fotoFormulario(ctx,'flow_configurar'),b=borradorCarrito(foto),final={filas:b.filas,modalidad:'m0',pago:'p0'};
  const intento={revision:'0',operacion:'editar',editar:'e0',q0:'0',q1:'5'};
  const rechazo=cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:intento});
  assert(rechazo.error);assert.deepEqual(rechazo.borrador,b);
  const recuperada=respuestaCarrito(foto,b,'token',rechazo.error,intento);
  assert.equal(recuperada.data.q0_inicial,'0');assert.equal(recuperada.data.q1_inicial,'5');
  assert.equal(respuestaCarrito(foto,b,'token','Viejo',{...intento,revision:'9'}).data.q0_inicial,'1');
  const fotoGrande=fotoFormulario(nuevo(50),'flow_configurar');
  let paginas=borradorCarrito(fotoGrande);
  paginas=cambiarCarrito(fotoGrande,paginas,{action:'data_exchange',screen:'CARRITO',data:{revision:'0',operacion:'pagina',pagina:'p1',q0:'0'}}).borrador;
  assert.equal(paginas.filas[8].key,'e9');
  paginas=cambiarCarrito(fotoGrande,paginas,{action:'data_exchange',screen:'CARRITO',data:{revision:'1',operacion:'pagina',pagina:'p0',q0:'0',q1:'7'}}).borrador;
  assert(!paginas.filas.some(f=>f.key==='e9'));assert.equal(paginas.filas.find(f=>f.key==='e10').item.cantidad,'7');
  assert.equal(paginas.filas.find(f=>f.key==='e1').item.cantidad,'1','la segunda página no afecta la primera');
  for(const r of [{...final,total:1},{...final,filas:[...b.filas,b.filas[0]]},{...final,filas:[{...b.filas[0],key:'e9'}]},
    {...final,filas:[{key:'e0',item:{...b.filas[0].item,producto0:'p1'}}]},
    {...final,filas:[{key:'n0',item:{...b.filas[0].item,g0_m:[]}}]},
    {...final,filas:[{key:'e0',item:{...b.filas[0].item,cantidad:'-1'}}]}])assert.equal(comandosFormulario(foto,r),null,JSON.stringify(r));
  const vacio=cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:'0',operacion:'guardar',q0:'0',q1:'0',q2:'0'}});
  assert.equal(vacio.error,undefined);assert.equal(vacio.borrador.etapa,'FINAL');
  assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:foto,respuestaFlow:{filas:[],modalidad:'m0',pago:'p0'}},ctx)).ok,true);
  assert.equal(ctx.estado.carrito.items.length,0);assert.equal(ctx.estado.hechos.cancelado,false);
  const vacioCtx={...ctx,estado:estadoNuevo({negocioId:'vacio',conversacionId:'vacio'})};
  for(const mensaje of ['Hola','Buenos días','Buenas tardes','Menú','¿Me atiende una persona?','¿Cuánto cuesta el café?'])
    assert.equal(entradaFormulario({...vacioCtx,telefono:'5210000000001',mensaje}),null);
  assert(entradaFormulario({...vacioCtx,telefono:'5210000000001',mensaje:'Quiero ordenar'}));
  const def=definicionFlowCarrito();
  assert.equal(def.data_api_version,'3.0');assert.equal(def.screens.length,5);
  for(const s of def.screens)assert(s.layout.children[0].children.length<=50,s.id);
  const cart=def.screens[0].layout.children[0].children;
  assert.equal(cart.filter(c=>c.name?.match(/^q\d+$/)).length,8);
  assert(!JSON.stringify(def).includes('Revisar eliminación'));
  console.log(`OK carrito: ${cantidad} tamaños (3/8/50), bajas múltiples, cantidades, edición, alta, deshacer, vacío, huellas, identidad y saludo sin venta.`);
} finally {for(const k of keys)previo[k]===undefined?delete process.env[k]:process.env[k]=previo[k];}
