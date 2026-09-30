import assert from 'node:assert/strict';
import { cortesiaPostPedido } from '../src/mesero-agente/cortesiaPostPedido.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
const estado=estadoNuevo({negocioId:'local',conversacionId:'local-c1'});
estado.folio='XAB-LOCAL';estado.hechos.confirmado=true;
for(const mensaje of ['Gracias','Muchas gracias 😊','Perfecto, gracias!','Ok','Gracias por la atención','Mil gracias']) {
  const e=structuredClone(estado);
  const r=await atenderTurnoConHerramientas({estado:e,mensaje,catalogo:[],
    llamarModelo:async()=>{throw Error('La cortesía no requiere modelo');}});
  assert.equal(r.llamadasAlModelo,0,mensaje);assert.match(r.texto,/Gracias a ti/);
  assert.doesNotMatch(r.texto,/camino|prepar|listo|repart|pagado|cobrado|entregado/i);
  assert.equal(r.operaciones.length,0);assert.equal(e.folio,estado.folio);
}
for(const mensaje of ['Gracias, ¿ya viene?','Ok agrega un café','Gracias pero cancela','No gracias',
  'Perfecto sin crema','Gracias, no ha llegado','¿Gracias?','Gracias ya pagué']) {
  assert.equal(cortesiaPostPedido({estado,mensaje}),null,mensaje);
}
for(const cambio of [{folio:null},{confirmacionIncierta:true},{hechos:{confirmado:false}},
  {hechos:{confirmado:true,escalado:true}},{hechos:{confirmado:true,cancelado:true}}]) {
  assert.equal(cortesiaPostPedido({estado:{...estado,...cambio},mensaje:'gracias'}),null);
}
console.log('OK cortesía posterior: 6 turnos sin modelo/efectos, 8 mensajes mixtos intactos y 5 barreras.');
