// Regresión pura que también viaja en la imagen Railway (sin test/).
import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { fotoFormulario,datosPantalla,comandosFormulario,aplicarFormulario,formularioVigente,
  flowsActivos,entradaFormulario,construirFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { guardarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
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
console.log('OK Flows: tres renglones, selección agrupada atómica, precios, cardinalidad, campos falsos, canario y contrato de envío.');
