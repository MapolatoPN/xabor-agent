// Regresión pura que también viaja en la imagen Railway (sin test/).
import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { fotoFormulario,datosPantalla,comandosFormulario,aplicarFormulario,formularioVigente,
  flowsActivos,entradaFormulario,construirFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { guardarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { abrirGrupoDePregunta,opcionesInteractivas,textoDeElecciones,respuestaDeEleccion } from '../src/mesero-agente/eleccionesInteractivas.js';
import { definicionPedidoContinuo } from './definicion-flows-pedido.mjs';
const grupo=(nombre,minimo,maximo,nombres)=>({nombre,minimo,maximo,requerido:minimo>0,
  opciones:nombres.map(nombre=>({nombre,precio_extra:0,disponible:true}))});
const catalogo=[{nombre:'Desayunos',productos:[{id:1,nombre:'Chilaquiles',precio:120,disponible:true,
  modificadores:[grupo('Salsa',1,2,['Roja','Verde']),grupo('Guarnición',2,2,['Frijoles','Papas'])]}]}];
const estado=estadoNuevo({negocioId:'flow-test',conversacionId:'flow-ciclo'});
const ctx={estado,catalogo,modalidades:['recoger en tienda'],metodosPago:[{tipo:'efectivo',habilitado:true,disponible_para_bot:true}],requierePago:true};
const foto=fotoFormulario(ctx,'flow_productos');assert.equal(foto.productos.length,1);
const tres={accion:'flow_productos',datos:foto,respuestaFlow:{producto0:'p0',producto1:'p0',producto2:'p0'}};
assert.equal((await aplicarFormulario(tres,ctx)).ok,true);assert.equal(estado.carrito.items.length,3);
assert.equal(new Set(estado.carrito.items.map(i=>i.lid)).size,3);
const config=fotoFormulario(ctx,'flow_configurar'),data=datosPantalla(config),respuesta={modalidad:'m0',pago:'p0'};
for(let l=0;l<3;l++){respuesta[`g${l*6}_m`]=['o0','o1'];respuesta[`g${l*6+1}_m`]=['o0','o1'];}
assert.equal(data.g0_min,1);assert.equal(data.g1_min,2);assert.equal(data.g12_max,2);
// Cada forma de pago se explica en su opción (prueba del dueño, 1-oct-2026).
// La explicación vive solo en la pantalla: la foto del formulario no cambia.
assert.equal(data.pagos[0].description,'Pagas en efectivo al recibir o al recoger.');
const conEnlace=datosPantalla({...config,pagos:[...config.pagos,{valor:'enlace_pago',titulo:'enlace de pago'},{valor:'transferencia',titulo:'transferencia'}]});
assert.equal(conEnlace.pagos[1].description,'Te enviamos un link para pagar con tarjeta desde tu celular.');
assert.equal(conEnlace.pagos[2].description,'','sin descripción antes que afirmar algo que el negocio no hace');
assert(!('description' in config.pagos[0]),'la foto del formulario no lleva la explicación');
const antes=structuredClone(estado);
for(const cambios of [{g12_m:['o0','o0']},{g13_m:['o0']},{g17_s:'o0'},{pago:'p99'},{total:1}]) {
  const mala={...respuesta,...cambios};assert.equal(comandosFormulario(config,mala),null);
  assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:config,respuestaFlow:mala},ctx)).ok,false);
  assert.deepEqual(estado,antes);
}
const reserva={accion:'flow_configurar',datos:config,respuestaFlow:respuesta};
assert(formularioVigente(reserva,ctx));catalogo[0].productos[0].precio=121;
assert(!formularioVigente(reserva,ctx));catalogo[0].productos[0].precio=120;
assert.equal((await aplicarFormulario(reserva,ctx)).ok,true);
assert.equal(crearEjecutor({...ctx,mensaje:''}).vista().total,360);assert.equal(estado.folio,null);
const cfg={whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',whatsapp_flows_telefonos:'5210000000001',
  whatsapp_flow_configurar_id:'2222222222',whatsapp_flow_productos_id:'1111111111'};
assert(flowsActivos(cfg,'5210000000001'));assert(!flowsActivos(cfg,'5210000000002'));
assert(!flowsActivos({...cfg,bot_whatsapp_solo_prueba:'false'},'5210000000001'));
fijarPendiente(estado,{tipo:'configurar_pedido'});guardarDialogo(estado,{mensaje:'',texto:'Configurar'});
const formulario=construirFormulario({...ctx,cfg,telefono:'5210000000001',pedido:crearEjecutor({...ctx,mensaje:''}).vista(),texto:'Configurar'});
assert(formulario);assert(payloadInteractivoValido(formulario.carga,formulario.texto));
assert.equal(formulario.botones[0].accion,'flow_configurar');
assert.equal(entradaFormulario({...ctx,cfg,telefono:'5210000000001',mensaje:'Hola'}),null);
// Incidente 9919: 0/null = sin límite en catálogo, pero Infinity se perdía
// al guardar JSONB y el botón rechazaba incluso la primera tortilla elegida.
for (const maximo of [0,null,undefined,1,2,99]) {
  const nombres=['Harina','Maíz','Mixtas','Sin tortillas'];
  const cat=[{nombre:'Desayunos',productos:[{id:87,nombre:'Omelette',precio:100,
    modificadores:[grupo('Tortillas',1,maximo,nombres)]}]}];
  const e=estadoNuevo({negocioId:'test-limites',conversacionId:'ciclo-limites'});
  e.carrito.items=[{id:87,lid:'omelette',nombre:'Omelette',cantidad:1,modificadores:[],notas:''}];
  fijarPendiente(e,{tipo:'elegir_opcion',linea_id:'omelette',grupo:'Tortillas',producto:'Omelette',candidatos:nombres});
  const c={...ctx,estado:e,catalogo:cat};
  abrirGrupoDePregunta(e,cat);
  const opciones=opcionesInteractivas(c),limite=maximo>0?Math.min(maximo,4):4;
  assert.equal(opciones[0].datos.maximo,limite,'el límite persistible debe ser finito');
  const persistida=JSON.parse(JSON.stringify(opciones[0]));
  assert.deepEqual(persistida,opciones[0]);
  assert.doesNotMatch(textoDeElecciones(e,cat,opciones,'',{compacto:true}),/Infinity|null|undefined|NaN/);
  assert.equal(respuestaDeEleccion(persistida,c).acciones.length,1,'la primera elección debe aplicarse tras persistir');
  const antigua={...persistida,datos:{...persistida.datos,maximo:null}};
  assert.equal(respuestaDeEleccion(antigua,c).acciones.length,0,'un token antiguo corrupto nunca se reinterpreta');
  const f=fotoFormulario(c,'flow_configurar');assert(f,'sin límite no excluye el producto del formulario');
  assert.equal(f.lineas[0].ficha.grupos[0].maximo,limite);
  assert.equal(datosPantalla(f).g0_max,limite);assert.deepEqual(JSON.parse(JSON.stringify(f)),f);
  assert(formularioVigente({accion:'flow_configurar',datos:JSON.parse(JSON.stringify(f))},c));
  assert(fotoFormulario(c,'flow_productos').productos.some(p=>p.id==='87'));
}
console.log('OK Flows: tres renglones, selección agrupada atómica, precios, cardinalidad, campos falsos, canario y contrato de envío.');

const cfgContinuo={...cfg,whatsapp_flow_pedido_id:'3333333333'};
const ec=estadoNuevo({negocioId:'flow-test',conversacionId:'continuo'}),cc={...ctx,estado:ec,cfg:cfgContinuo};
const fc=fotoFormulario(cc,'flow_productos'),dc=datosPantalla(fc);
assert.equal(fc.version,'continuo_v1');
const rc={modalidad:'m0',pago:'p0'};
for(let i=0;i<3;i++) {
  rc[`producto${i}`]='p0';rc[`g${i*6}_m`]=['p0g0o0','p0g0o1'];rc[`g${i*6+1}_m`]=['p0g1o0','p0g1o1'];
  const p=dc[`productos${i}`].find(p=>p.id==='p0');
  assert.equal(p['on-select-action'].name,'update_data');
  assert.equal(p['on-select-action'].payload[`g${i*6}_multiple`],true);
  assert.deepEqual(p['on-select-action'].payload[`g${i*6}_opciones`].map(o=>o.id),['p0g0o0','p0g0o1']);
}
for(const cambio of [{g12_m:['p1g0o0']},{g12_m:['p0g1o0']},{g13_m:['p0g1o0']},
  {producto2:'ninguno'},{g17_s:'p0g5o0'},{producto0:'p00'},{precio:1}]) {
  assert.equal(comandosFormulario(fc,{...rc,...cambio}),null,JSON.stringify(cambio));
  assert.equal((await aplicarFormulario({accion:'flow_productos',datos:fc,respuestaFlow:{...rc,...cambio}},cc)).ok,false);
  assert.equal(ec.carrito.items.length,0);
}
assert.equal((await aplicarFormulario({accion:'flow_productos',datos:fc,respuestaFlow:rc},cc)).ok,true);
assert.equal(ec.carrito.items.length,3);assert.equal(ec.folio,null);
assert.equal(crearEjecutor({...cc,mensaje:''}).vista().total,360);
const primeros=structuredClone(ec.carrito.items);
assert.equal(fotoFormulario(cc,'flow_productos').espacio,3,'tres no es el límite del carrito');
const cuatro={producto0:'p0',producto1:'ninguno',producto2:'ninguno',g0_m:['p0g0o1'],g1_m:['p0g1o0','p0g1o1'],modalidad:'m0',pago:'p0'};
assert.equal((await aplicarFormulario({accion:'flow_productos',datos:fotoFormulario(cc,'flow_productos'),respuestaFlow:cuatro},cc)).ok,true);
assert.equal(ec.carrito.items.length,4);assert.deepEqual(ec.carrito.items.slice(0,3),primeros);
assert.deepEqual(ec.carrito.items[3].modificadores.find(g=>g.grupo==='Salsa').opciones,['Verde']);
const def=definicionPedidoContinuo(),controles=def.screens[0].layout.children[0].children;
assert.equal(def.screens.length,1);assert(controles.length<=50);
assert.equal(controles.filter(c=>c.type==='Footer').length,1);
assert.deepEqual(controles.filter(c=>c.type==='Dropdown' && c.name.startsWith('producto')).map(c=>c.name),['producto0','producto1','producto2']);
assert.equal(controles.at(-1)['on-click-action'].name,'complete');
assert(!formularioVigente({accion:'flow_productos',datos:fc},{...cc,cfg}),'apagar la versión invalida la foto');
console.log('OK Flow continuo: selector y opciones en una ventana, tres platos independientes, cuarto sin listas, todo o nada y códigos ligados al producto/grupo.');
