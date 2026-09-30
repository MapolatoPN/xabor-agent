import assert from 'node:assert/strict';
import { intencionDeEntrada } from '../src/mesero-agente/intencionDeEntrada.js';
import { consultaFotografiaAmbigua } from '../src/mesero-agente/consultaFotografia.js';
import { revisarRedaccion } from '../src/mesero-agente/emisionSegura.js';
import { cortesiaPostPedido } from '../src/mesero-agente/cortesiaPostPedido.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

for(const mensaje of ['buentas tardes\npara hacer un pedido','para hacer un pedido',
  'Quiero ordenar a domicilio','Buenos días, para realizar una orden','Hola quiero pedir para recoger']) {
  assert.equal(intencionDeEntrada(mensaje),'ordenar',mensaje);
}
for(const mensaje of ['No quiero ordenar','para hacer un pedido mañana','Quiero ordenar dos tacos',
  'Quiero ordenar pero tengo una duda','para cancelar un pedido','para hacer un pedido no se si alcance']) {
  assert.equal(intencionDeEntrada(mensaje),null,mensaje);
}
assert(consultaFotografiaAmbigua('Un favor tu crees que me puedas apoyar con una foto xfis'));
assert(consultaFotografiaAmbigua('Me puedes mandar una foto por favor'));
for(const texto of ['Mándame el menú','Me puedes mandar una foto del menú','Quiero tacos y una foto',
  'No quiero una foto','Te mando una foto','Foto de mis chilaquiles'])assert(!consultaFotografiaAmbigua(texto),texto);
for(const texto of ['El folio aparece en tu ticket.','¿Dónde está el folio?','Envía el folio de la compra.']) {
  assert(revisarRedaccion({texto,estado:{hechos:{confirmado:false}}}).ok,texto);
}
for(const texto of ['Tu pedido quedó confirmado','Tu folio es 123','Folio XAB-1234','Registré tu pedido',
  'Tu folio: 123','Ya tienes un folio']) {
  assert(!revisarRedaccion({texto,estado:{hechos:{confirmado:false}}}).ok,texto);
}
const base=()=>estadoNuevo({negocioId:'local',conversacionId:'local-c1'});
const confirmado=base();confirmado.folio='XAB-LOCAL';confirmado.hechos.confirmado=true;
for(const mensaje of ['Gracias','Muchas gracias 😊','Perfecto, gracias!','Ok','Gracias por la atención','Mil gracias']) {
  const estado=structuredClone(confirmado);
  const r=await atenderTurnoConHerramientas({estado,mensaje,catalogo:[],
    llamarModelo:async()=>{throw Error('La cortesía no requiere modelo');}});
  assert.equal(r.llamadasAlModelo,0,mensaje);assert.match(r.texto,/Gracias a ti/);
  assert.doesNotMatch(r.texto,/camino|prepar|listo|repart|pagado|cobrado|entregado/i);
  assert.equal(r.operaciones.length,0);assert.equal(estado.folio,confirmado.folio);
}
for(const mensaje of ['Gracias, ¿ya viene?','Ok agrega un café','Gracias pero cancela','No gracias',
  'Perfecto sin crema','Gracias, no ha llegado','¿Gracias?','Gracias ya pagué']) {
  assert.equal(cortesiaPostPedido({estado:confirmado,mensaje}),null,mensaje);
}
const saludo='¡Hola, muy buen día! Con gusto te ayudo. ¿Qué necesitas?';
const r=await atenderTurnoConHerramientas({estado:base(),mensaje:'una consulta',catalogo:[],
  llamarModelo:async()=>({content:[{type:'text',text:saludo}],stop_reason:'end_turn'})});
assert.equal(r.texto,saludo,'no anteponer un segundo saludo');
console.log('OK incidentes: entrada natural, foto ambigua, folio informativo, cortesía sin promesas y saludo único.');
