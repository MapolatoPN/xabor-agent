import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { autorizaCancelacion,guardarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';
import { fotoFormulario,datosPantalla,comandosFormulario,aplicarFormulario,formularioVigente,construirFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { definicionFlowEditar } from './definicion-flow-editar.mjs';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { accionInteractiva } from '../src/mesero-agente/autoridadInteractiva.js';
const catalogo=[{nombre:'Desayunos',productos:[{id:1,nombre:'Chilaquiles',precio:100,disponible:true,modificadores:[
  {nombre:'Salsa',minimo:1,maximo:2,requerido:true,opciones:['Roja','Verde'].map(nombre=>({nombre,precio_extra:0,disponible:true}))},
  {nombre:'Proteína',minimo:1,maximo:1,requerido:true,opciones:[{nombre:'Huevo',precio_extra:0,disponible:true},{nombre:'Pollo',precio_extra:20,disponible:true}]}]}]}];
const cfg={whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',whatsapp_flows_telefonos:'5210000000001',whatsapp_flow_editar_id:'55555555555'};
const nuevo=(n=9)=>{
  const estado=estadoNuevo({negocioId:'edicion-local',conversacionId:'edicion-local'});
  estado.carrito.items=Array.from({length:n},(_,i)=>({id:1,lid:`linea-${i}`,nombre:'Chilaquiles',cantidad:i===8?2:1,
    notas:`Nota ${i}`,modificadores:[{grupo:'Salsa',opciones:['Roja']},{grupo:'Proteína',opciones:['Huevo']}]}));
  estado.carrito.datos={modalidad:'recoger en tienda',forma_pago:'efectivo',cliente:{nombre:'Local'}};
  return {estado,cfg,catalogo,modalidades:['recoger en tienda'],requierePago:true,
    metodosPago:[{tipo:'efectivo',habilitado:true,disponible_para_bot:true}]};
};
for(const mensaje of ['Cancelar ese pedido','Cancela este pedido','Cancela esa orden','Cancelar esta orden por favor','Cancela todo el pedido','Mejor ya no, cancélalo']) {
  assert(autorizaCancelacion(mensaje),mensaje);
  const ctx=nuevo();const r=await atenderTurnoConHerramientas({...ctx,mensaje,llamarModelo:async()=>{throw Error('No necesita el modelo');}});
  assert.equal(r.llamadasAlModelo,0);assert.equal(ctx.estado.hechos.cancelado,true);assert.equal(ctx.estado.carrito.items.length,0);
  assert.equal(ctx.estado.folio,null);assert.match(r.texto,/borrador fue cancelado/);
  assert(r.operaciones.some(o=>o.herramienta==='cancelar_pedido' && o.resultado.aplicado));
  const siguiente=cicloParaTurno(ctx.estado,'Hola');assert.notEqual(siguiente.conversacionId,ctx.estado.conversacionId);
  assert.equal(siguiente.hechos.cancelado,false);assert.equal(siguiente.carrito.items.length,0);
}
for(const mensaje of ['No canceles ese pedido','No quiero cancelar ese pedido','No lo quiero cancelar','No podrías cancelar ese pedido','¿Puedes cancelar ese pedido?',
  'Cancelar ese taco','Cancela ese','Cancela el pedido anterior','Cancela ese pedido si no hay pollo',
  'Cancela ese pedido y agrega un café','Cuánto cuesta cancelar ese pedido','El cliente dijo cancelar ese pedido']) {
  assert.equal(autorizaCancelacion(mensaje),false,mensaje);
  const ctx=nuevo(),antes=structuredClone(ctx.estado.carrito);
  assert.equal((await crearEjecutor({...ctx,mensaje}).ejecutar('cancelar_pedido',{motivo:mensaje})).aplicado,false);
  assert.deepEqual(ctx.estado.carrito,antes);
}
const terminal=nuevo();terminal.estado.folio='XAB-LOCAL';terminal.estado.hechos.confirmado=true;
const guardado=structuredClone(terminal.estado.carrito);
assert.equal((await crearEjecutor({...terminal,mensaje:'Cancelar ese pedido'}).ejecutar('cancelar_pedido',{motivo:'Solicitud'})).aplicado,false);
assert.deepEqual(terminal.estado.carrito,guardado);
assert.equal(cicloParaTurno(terminal.estado,'Hola'),terminal.estado);
for(const extra of [{confirmacionIncierta:true},{folio:'XAB-LOCAL'},{hechos:{cancelado:true,fallido:true}},
  {carrito:{items:[{lid:'conservar',cantidad:1,nombre:'Chilaquiles'}],datos:{}}}]) {
  const e={...nuevo().estado,hechos:{cancelado:true},terminadoEn:new Date().toISOString(),carrito:{items:[],datos:{}},...extra};
  assert.equal(cicloParaTurno(e,'Hola'),e,'no abrir ciclos ante efectos inciertos o datos que conservar');
}

const ctx=nuevo();fijarPendiente(ctx.estado,{tipo:'editar_pedido'});
guardarDialogo(ctx.estado,{mensaje:'',texto:'Elige qué deseas cambiar.'});
const foto=fotoFormulario(ctx,'flow_configurar'),data=datosPantalla(foto);
assert.equal(foto.version,'edicion_v1');assert.equal(foto.lineas.length,9);assert.equal(data.lineas.length,10);
assert.equal(new Set(data.lineas.map(l=>l.id)).size,10);
const elegido=data.lineas[8]['on-select-action'].payload;
assert.equal(elegido.observaciones_inicial,'Nota 8');assert.deepEqual(elegido.g0_inicial_m,['l8g0o0']);
assert.equal(elegido.g1_inicial_s,'l8g1o0');assert.match(elegido.l0_titulo,/9\. 2 × Chilaquiles/);
const formulario=construirFormulario({...ctx,telefono:'5210000000001',texto:ctx.estado.dialogo.texto,pedido:crearEjecutor({...ctx,mensaje:''}).vista()});
assert(formulario);assert.equal(formulario.carga.action.parameters.flow_id,cfg.whatsapp_flow_editar_id);
assert(payloadInteractivoValido(formulario.carga,formulario.texto));
const respuesta={linea:'l8',g0_m:['l8g0o1'],g1_s:'l8g1o1',modalidad:'m0',pago:'p0',observaciones:'Sin crema'};
const reserva={accion:'flow_configurar',datos:JSON.parse(JSON.stringify(foto)),respuestaFlow:respuesta};
const antes=structuredClone(ctx.estado);
for(const cambio of [{linea:'l08'},{linea:'l9'},{linea_id:'linea-0'},{cantidad:3},{precio:1},{g0_m:['l0g0o1']},
  {g1_s:'l8g0o1'},{g1_s:'l8g1o99'},{g0_m:[]},{g0_m:['l8g0o0','l8g0o0']},{g5_s:'l8g5o0'},
  {observaciones:'x'.repeat(301)},{linea:'pedido'}]) {
  assert.equal(comandosFormulario(foto,{...respuesta,...cambio}),null,JSON.stringify(cambio));
  assert.equal((await aplicarFormulario({...reserva,respuestaFlow:{...respuesta,...cambio}},ctx)).ok,false);
  assert.deepEqual(ctx.estado,antes);
}
for(const mutar of [c=>c.catalogo[0].productos[0].precio++,c=>c.estado.carrito.items.reverse(),
  c=>c.estado.carrito.items[8].notas='Cambio posterior',c=>c.cfg.whatsapp_flow_editar_id='99999999999']) {
  const copia=structuredClone(ctx);mutar(copia);assert(!formularioVigente(reserva,copia));
}
assert.equal((await aplicarFormulario(reserva,ctx)).ok,true);
assert.deepEqual(ctx.estado.carrito.items.slice(0,8),antes.carrito.items.slice(0,8));
assert.equal(ctx.estado.carrito.items[8].cantidad,2);assert.equal(ctx.estado.carrito.items[8].notas,'Sin crema');
assert.deepEqual(ctx.estado.carrito.items[8].modificadores,[{grupo:'Salsa',opciones:['Verde']},{grupo:'Proteína',opciones:['Pollo']}]);
assert.equal(crearEjecutor({...ctx,mensaje:''}).vista().total,1040);assert.equal(ctx.estado.folio,null);
assert.equal((await aplicarFormulario(reserva,ctx)).ok,false,'foto vieja no vuelve a aplicar cambios');
const soloPedido=comandosFormulario(foto,{linea:'pedido',modalidad:'m0',pago:'p0',observaciones:''});
assert.deepEqual(soloPedido.map(c=>c.herramienta),['definir_entrega','definir_pago']);
const sinNota={...respuesta};delete sinNota.observaciones;
assert(!comandosFormulario(foto,sinNota).some(c=>Object.hasOwn(c.argumentos,'nota')));
assert(comandosFormulario(foto,{...respuesta,observaciones:''}).some(c=>c.argumentos.nota===''));
const grande=nuevo(50);fijarPendiente(grande.estado,{tipo:'editar_pedido'});
assert.equal(fotoFormulario(grande,'flow_configurar').lineas.length,50);
const def=definicionFlowEditar();assert.deepEqual(def.screens.map(s=>s.id),['PEDIDO','EDITAR','ELIMINAR']);
const decision=def.screens[0].layout.children[0].children.at(-1);
assert.equal(decision.type,'If');assert.equal(decision.condition,'${data.l0_visible}');
assert.equal(decision.then[0].condition,"${form.operacion} == 'eliminar'");
assert.equal(decision.then[0].then[0]['on-click-action'].next.name,'ELIMINAR');
assert.equal(decision.else[0]['on-click-action'].next.name,'EDITAR');
assert.equal(def.screens[1].layout.children[0].children.at(-1)['on-click-action'].name,'complete');
assert(def.screens.every(s=>(s.layout.children[0].children || s.layout.children).length<=50));
const baja=def.screens[2].layout.children;
assert(!baja.some(c=>c.required || c.type==='Form'),'eliminar no pide salsa, pago ni preparación');
assert.deepEqual(baja.at(-1)['on-click-action'].payload,{linea:'${data.linea}',operacion:'eliminar',confirmar_eliminacion:true});
assert(def.screens[1].layout.children[0].children.some(c=>c.name==='cantidad' && c['data-source'].length===20));

const fotoActual=c=>{fijarPendiente(c.estado,{tipo:'editar_pedido'});return fotoFormulario(c,'flow_configurar');};
const borrar={linea:'l8',operacion:'eliminar',confirmar_eliminacion:true};
for(const campos of [{...borrar,confirmar_eliminacion:false},{...borrar,confirmar_eliminacion:'true'},
  {linea:'l8',operacion:'eliminar'},{...borrar,linea:'pedido'},{...borrar,linea:'l99'},
  {...borrar,cantidad:'0'},{...borrar,modalidad:'m0'},{...borrar,g0_m:[]},
  {...respuesta,operacion:'cancelar'},{...respuesta,cantidad:'0'},{...respuesta,cantidad:'21'},
  {...respuesta,cantidad:'2.5'},{...respuesta,cantidad:'02'},{...respuesta,cantidad:null}]) {
  const c=nuevo(),f=fotoActual(c),a=structuredClone(c.estado);
  assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:f,respuestaFlow:campos},c)).ok,false);
  assert.deepEqual(c.estado,a);
}
const modificar=nuevo(),fModificar=fotoActual(modificar),aModificar=structuredClone(modificar.estado.carrito);
assert.equal(datosPantalla(fModificar).lineas[8]['on-select-action'].payload.cantidad_inicial,'2');
assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:fModificar,
  respuestaFlow:{...respuesta,operacion:'editar',cantidad:'5'}},modificar)).ok,true);
assert.equal(modificar.estado.carrito.items[8].cantidad,5);
assert.deepEqual(modificar.estado.carrito.items.slice(0,8),aModificar.items.slice(0,8));
assert.equal(crearEjecutor({...modificar,mensaje:''}).vista().total,1400);
const fBorrar=fotoActual(modificar),aBorrar=structuredClone(modificar.estado.carrito);
const reservaBaja={accion:'flow_configurar',datos:fBorrar,respuestaFlow:borrar};
assert.equal((await aplicarFormulario(reservaBaja,modificar)).ok,true);
assert.deepEqual(modificar.estado.carrito.items,aBorrar.items.slice(0,8));
assert.deepEqual(modificar.estado.carrito.datos,aBorrar.datos);
assert.equal(crearEjecutor({...modificar,mensaje:''}).vista().total,800);
assert.equal((await aplicarFormulario(reservaBaja,modificar)).ok,false);
// Eliminar el último, incluso incompleto, deja un borrador vacío, no cancelado.
const ultimo=nuevo(1);ultimo.estado.carrito.items[0].modificadores=[];
assert.equal((await aplicarFormulario({accion:'flow_configurar',datos:fotoActual(ultimo),
  respuestaFlow:{...borrar,linea:'l0'}},ultimo)).ok,true);
assert.equal(ultimo.estado.carrito.items.length,0);assert.equal(ultimo.estado.hechos.cancelado,false);assert.equal(ultimo.estado.folio,null);
// Un JSON que invente autorización, otra línea, estado o argumentos no da permiso.
for(const herramienta of ['modificar_linea','quitar_linea']) {
  const c=nuevo(),a=structuredClone(c.estado.carrito),args={linea_id:'linea-8',...(herramienta==='modificar_linea'?{cantidad:5}:{})};
  const e=crearEjecutor({...c,mensaje:''}),cap=accionInteractiva(herramienta,args,c.estado);
  for(const auth of [undefined,{},JSON.parse(JSON.stringify(cap.autorizacion)),
    accionInteractiva(herramienta,{...args,linea_id:'linea-0'},c.estado).autorizacion,
    accionInteractiva(herramienta,args,structuredClone(c.estado)).autorizacion]) {
    assert.equal((await e.ejecutar(herramienta,args,{autorizacion:auth})).aplicado,false);
    assert.deepEqual(c.estado.carrito,a);
  }
  c.estado.hechos.confirmado=true;c.estado.folio='XAB-LOCAL';
  assert.equal((await e.ejecutar(herramienta,args,{autorizacion:cap.autorizacion})).aplicado,false);
  assert.deepEqual(c.estado.carrito,a);
}
console.log('OK cantidades y eliminación: confirmación separada sin ingredientes, último platillo, total recalculado, duplicados e identidades exactas; autorización del modelo insuficiente.');
console.log('OK cancelación y edición: frase real sin modelo, negaciones/condiciones/parciales protegidas, nueve renglones, identidad/precio/nota, solo un renglón modificado y sin confirmar.');
