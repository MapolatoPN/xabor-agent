import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {estadoMetaSeguro,vistaEstadoMensaje,telefonoTransporte} from '../src/services/estadosMensajeWhatsapp.js';
import {reglasDelAsistenteEnTexto} from '../src/mesero-agente/reglasDelAsistente.js';
import {sugerenciaPromocion} from '../src/mesero-agente/oportunidadPromocion.js';
import {vistaRespuestaFormulario} from '../src/services/seguimientoFormulario.js';
import {respuestaOperativaVerificada,leerEstadoOperativo} from '../src/mesero-agente/estadoOperativoDelPedido.js';
import {atenderTurnoConHerramientas} from '../src/mesero-agente/agenteDelMesero.js';
import {estadoNuevo} from '../src/mesero-agente/ejecutorDeHerramientas.js';
assert.equal(telefonoTransporte('5218781118093'),'528781118093');
for(const x of [{status:'unknown'},{status:'read',id:'w',recipient_id:'<script>',timestamp:'1'},
  {status:'read',id:'w',recipient_id:'528781118093',timestamp:'NaN'}])assert.equal(estadoMetaSeguro(x),null);
const e=estadoMetaSeguro({status:'failed',id:'w',recipient_id:'528781118093',timestamp:'1780000000',errors:[{code:131026,title:'SECRETO'}]});
assert.equal(e.errorCodigo,131026);assert(!JSON.stringify(e).includes('SECRETO'));
for(const estados of [['sent','read','delivered','failed'],['failed','delivered','read','sent']])assert.equal(vistaEstadoMensaje(estados.map(estado=>({estado}))).codigo,'read');
assert.equal(vistaEstadoMensaje([{estado:'sent'},{estado:'failed'}]).codigo,'failed');
assert.equal(vistaEstadoMensaje([]),null);
const reglas={pedidos:{zonas_entrega:[{nombre:'Coca Cola',costo:120}],costo_envio:60},
  bot:{informacion_importante:'Tenemos estacionamiento.\nCoca Cola $150.\nEnvío gratis.\nDesayuno $195.',
    faqs:[{pregunta:'¿Cuánto cuesta el envío?',respuesta:'Son $150.'}]}};
const prompt=reglasDelAsistenteEnTexto(reglas);
assert.doesNotMatch(prompt,/\$150|Envío gratis/);assert.match(prompt,/Coca Cola: \$120/);assert.match(prompt,/estacionamiento/);assert.match(prompt,/Desayuno \$195/);
const p={id:'promo',tipo:'2x1',nombre:'Chilaquiles',descripcion:'2x1 en base',participantesTexto:'Chilaquiles con salsa Roja o Verde.'};
const o={promo_oportunidades:[{codigo:'ADD_ONE_MORE_ELIGIBLE_ITEM',promocionId:'promo',unidadesFaltantes:1}]};
const estado={carrito:{items:[{cantidad:1}]},hechos:{}},antes=structuredClone(estado);
const sugerencia=sugerenciaPromocion(o,[p],estado,'h');assert.match(sugerencia.texto,/Roja o Verde/);assert.deepEqual(estado,antes);
assert.match(sugerencia.texto,/No agregamos nada/);
assert.equal(sugerenciaPromocion(o,[],estado,'h'),null);assert.equal(sugerenciaPromocion({},[p],estado,'h'),null);
assert.equal(sugerenciaPromocion(o,[p],{...estado,sugerenciasPromocion:[sugerencia.clave]},'h'),null);
assert.equal(sugerenciaPromocion(o,[p],{...estado,folio:'XAB-1'},'h'),null);
const foto={version:'carrito_v1',productos:[{nombre:'Chilaquiles',grupos:[{nombre:'Salsa',maximo:1,opciones:[{nombre:'Roja'}]}]}]};
const b={etapa:'FINAL',filas:[{item:{producto0:'p0',cantidad:'2',g0_s:'p0g0o0',observaciones:'Sin crema',flow_token:'SECRETO'}}]};
const r=vistaRespuestaFormulario(foto,b);assert.equal(r.lineas[0].cantidad,2);assert.deepEqual(r.lineas[0].opciones,['Salsa: Roja']);assert(!JSON.stringify(r).includes('SECRETO'));
assert.equal(vistaRespuestaFormulario(foto,{...b,etapa:'EDITAR'}),null);
const sandbox={Intl};vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../panel/formulariosChat.js',import.meta.url),'utf8'),sandbox);
const html=sandbox.FormulariosChat.respuesta({lineas:[{nombre:'<img src=x>',cantidad:1,opciones:[],nota:'<script>x</script>'}]});
assert(!html.includes('<script>'));assert(!html.includes('<img'));assert.match(html,/Ver respuesta recibida/);
const abiertos=new Set();sandbox.FormulariosChat.conservarAbiertos({querySelectorAll:()=>[{dataset:{formDetalle:'enviado'}},{dataset:{formDetalle:'producto-1'}}]},
  {querySelectorAll:()=>['enviado','producto-0','producto-1'].map(k=>({dataset:{formDetalle:k},set open(v){if(v)abiertos.add(k);}}))});
assert.deepEqual([...abiertos],['enviado','producto-1']);
const registrado=estadoNuevo({negocioId:'local',conversacionId:'cierre-local'});
registrado.hechos.confirmado=true;registrado.folio='XAB-LOCAL';
for(const actual of [null,{folio:'XAB-OTRO',estado:'en_camino'},
  ...['nuevo','en_preparacion','listo','entregado','cancelado','desconocido'].map(estado=>({folio:'XAB-LOCAL',estado}))]) {
  const result=await atenderTurnoConHerramientas({estado:structuredClone(registrado),mensaje:'Gracias, ¿ya viene?',catalogo:[],
    contexto:{resolverEstadoOperativo:async()=>actual},
    llamarModelo:async()=>({content:[{type:'text',text:'Ya va en camino, pagado y llega en 5 minutos.'}],stop_reason:'end_turn'})});
  assert.equal(result.texto,respuestaOperativaVerificada(registrado,actual));
  assert.doesNotMatch(result.texto,/ya va en camino|pagado|5 minutos/i);assert.equal(result.operaciones.length,0);
}
assert.doesNotMatch(respuestaOperativaVerificada(registrado,{folio:'XAB-LOCAL',estado:'listo',modalidad:'entrega a domicilio'}),/en camino|recoger/);
assert.equal(await leerEstadoOperativo({query:async()=>{throw Error('DB');}},{negocioId:'local',telefono:'528781118093',folio:'XAB-LOCAL'}),null);
console.log('OK cierre WhatsApp: transporte monotónico, tarifas estructuradas, promoción sin mutación, respuesta separada y detalles seguros.');
