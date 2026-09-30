import assert from 'node:assert/strict';
import { entradaMapo,validarServicio,construirInicioMapo,atencionGeneralActiva } from '../src/mesero-agente/inicioMapo.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { definicionFlowServicio } from './definicion-flows-servicios.mjs';
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
assert.equal(validarServicio('flow_evento',{personas:'50'}),null);
for(const servicio of ['facturacion','evento']) {
  const flow=definicionFlowServicio(servicio);assert.equal(flow.screens.length,1);
  assert.equal(flow.screens[0].layout.children[0].children.at(-1)['on-click-action'].name,'complete');
}
console.log('OK Mapo: cuatro opciones, saludo local, formularios de captura y apertura general explícita.');
