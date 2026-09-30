import assert from 'node:assert/strict';
import { entradaMapo,validarServicio,construirInicioMapo,atencionGeneralActiva } from '../src/mesero-agente/inicioMapo.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { definicionFlowServicio } from './definicion-flows-servicios.mjs';
import { entradaFormulario } from '../src/mesero-agente/formularioAgrupado.js';
const cfg={whatsapp_inicio_mapo_v1:'true'},estado={conversacionId:'local',carrito:{items:[]},hechos:{}};
for(const [iso,franja] of [['2026-09-30T14:00Z','buenos días'],['2026-09-30T19:00Z','buenas tardes'],['2026-10-01T01:00Z','buenas noches']]) {
  const entrada=entradaMapo({cfg,estado,mensaje:'Hola',ahora:new Date(iso)});
  assert(entrada.texto.includes(franja));estado.pendiente=entrada.pendiente;
  estado.dialogo={id:'local',ciclo:'local',texto:entrada.texto};
  const menu=construirInicioMapo({estado,cfg,pedido:{huella:'local',total:0},texto:entrada.texto});
  assert(payloadInteractivoValido(menu.carga,menu.texto));assert.equal(menu.botones.length,4);
}
for(const mensaje of ['¿Tienen promociones?','quiero dos tacos','cancela todo','necesito una persona'])
  assert.equal(entradaMapo({cfg,estado,mensaje}),null);
assert(!atencionGeneralActiva({}));assert(!atencionGeneralActiva({whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'true'}));
assert(atencionGeneralActiva({whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false'}));
const configEntrada={...cfg,whatsapp_flows_v1:'true',whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false'};
const vacio={conversacionId:'entrada',carrito:{items:[]},hechos:{}};
const saludos=['Buenos díasss','Holaaa','¡¡BUENOS DÍAS!!','Hola, buenos días',
  'Hola\nBuen día','Muy buenas tardesss 😊','Buenas noches!','👋 Hola','Buenas'];
const pedidos=['Me gustaría realizar una orden','Ya sé que ordenar','Quiero ordenar','Ordenar',
  'Quisiera hacer un pedido, por favor','Me puedes tomar un pedido?', '¿Puedo pedir?',
  'Hola, buenos díasss. Me gustaría realizar una orden','Buenos días\nQuiero hacer un pedido',
  'Deseo pedir','Queremos realizar un pedido','Quiero una orden','Hacer un pedido',
  'Por favor, quiero ordenar. Gracias','Ya sé qué quiero pedir','Me gustaría ordenar'];
const ajenos=['No quiero ordenar','No, me gustaría realizar una orden','Quiero cancelar una orden',
  'Quiero saber si puedo ordenar','Me gustaría realizar una orden mañana','Ya hice una orden',
  'Hola, quiero dos tacos sin crema','Me gustaría pedir dos chilaquiles','Hola, ¿tienen promociones?',
  'Hola, quiero una factura','Me gustaría hablar con una persona','¿Cómo cancelo mi pedido?',
  'Quiero ordenar pero antes tengo una duda','Si','Gracias','Menú','Buenos días sin crema',
  'Quiero ordenar para un evento','Quiero ordenar\nNo, mejor no','Si puedo ordenar mañana te aviso'];
for(const mensaje of saludos) {
  assert(entradaMapo({cfg:configEntrada,estado:vacio,mensaje}),`saludo: ${mensaje}`);
  assert.equal(entradaFormulario({cfg:configEntrada,estado:vacio,mensaje}),null);
}
for(const mensaje of pedidos) {
  assert(entradaFormulario({cfg:configEntrada,estado:vacio,mensaje}),`pedido: ${mensaje}`);
  assert.equal(entradaMapo({cfg:configEntrada,estado:vacio,mensaje}),null,`no perder intención: ${mensaje}`);
}
for(const mensaje of ajenos) {
  assert.equal(entradaFormulario({cfg:configEntrada,estado:vacio,mensaje}),null,`no secuestrar: ${mensaje}`);
  assert.equal(entradaMapo({cfg:configEntrada,estado:vacio,mensaje}),null);
}
for(const protegido of [{carrito:{items:[{lid:'existente'}]}},{folio:'XAB-1'},{confirmacionIncierta:true},
  {evento:{tipo:'catering'}},{programacionRequerida:true},{hechos:{escalado:true}},{hechos:{confirmado:true}}]) {
  const estado={...vacio,...protegido};
  assert.equal(entradaMapo({cfg:configEntrada,estado,mensaje:'Buenos díasss'}),null);
  assert.equal(entradaFormulario({cfg:configEntrada,estado,mensaje:'Me gustaría realizar una orden'}),null);
}
assert.equal(entradaMapo({cfg:{...configEntrada,whatsapp_inicio_mapo_v1:'false'},estado:vacio,mensaje:'Buenos díasss'}),null);
assert.equal(entradaFormulario({cfg:{...configEntrada,whatsapp_flows_v1:'false'},estado:vacio,mensaje:pedidos[0]}),null);
assert.equal(entradaFormulario({cfg:{...configEntrada,whatsapp_atencion_general_v1:'false'},estado:vacio,mensaje:pedidos[0]}),null);
console.log(`OK entradas Mapo: ${saludos.length} saludos, ${pedidos.length} solicitudes, ${ajenos.length} exclusiones y estados protegidos.`);
assert.equal(validarServicio('flow_evento',{personas:'50'}),null);
for(const servicio of ['facturacion','evento']) {
  const flow=definicionFlowServicio(servicio);assert.equal(flow.screens.length,1);
  assert.equal(flow.screens[0].layout.children[0].children.at(-1)['on-click-action'].name,'complete');
}
console.log('OK Mapo: cuatro opciones, saludo local, formularios de captura y apertura general explícita.');
