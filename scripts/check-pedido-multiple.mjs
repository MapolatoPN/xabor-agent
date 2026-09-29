import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { respuestaDesdePedido } from '../src/mesero-agente/recuperacionDelTurno.js';
import { respuestaTextoGrupo, abrirGrupoDePregunta } from '../src/mesero-agente/eleccionesInteractivas.js';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';

const grupo=(nombre,nombres,maximo=1)=>({nombre,requerido:true,minimo:1,maximo,
  opciones:nombres.map(nombre=>({nombre,precio_extra:0,disponible:true}))});
export const catalogoMultiple=[{nombre:'Desayunos',productos:[
  {id:301,nombre:'Chilaquiles Rojos',precio:100,disponible:true},
  {id:302,nombre:'Chilaquiles Verdes',precio:100,disponible:true},
  {id:303,nombre:'Chilaquiles Mixtos',precio:120,disponible:true},
].map(p=>({...p,modificadores:[...(p.id===303?[grupo('Salsa',['Roja','Verde','Chipotle'],2)]:[]),
  grupo('Proteína',['Pollo','Huevo']),grupo('Guarniciones',['Frijoles naturales','Papas a la mexicana'],2)]}))}];
const nuevo=()=>estadoNuevo({negocioId:'local',conversacionId:'multiple'});
const opciones=(proteina,salsas=[])=>[...salsas.map(opcion=>({grupo:'Salsa',opcion})),
  ...(proteina?[{grupo:'Proteína',opcion:proteina}]:[]),
  ...['Frijoles naturales','Papas a la mexicana'].map(opcion=>({grupo:'Guarniciones',opcion}))];
const mensaje='Quiero unos chilaquiles rojos con pollo, unos chilaquiles verdes con huevo y unos chilaquiles mixtos rojos y verdes. Todos con frijoles naturales y papas a la mexicana. Para recoger, pago en efectivo.';
let turno=0;
const herramientas=xs=>({stop_reason:'tool_use',content:xs.map(([name,input],i)=>({type:'tool_use',id:`multi-${turno}-${i}`,name,input}))});
const ctx={catalogo:catalogoMultiple,modalidades:['recoger en tienda'],metodosPago:['efectivo']};
const estado=nuevo();
let vueltas=0;
const r=await atenderTurnoConHerramientas({...ctx,estado,mensaje,turnoId:`multi-${++turno}`,
  llamarModelo:async()=>++vueltas===1?herramientas([
    ['agregar_producto',{producto_id:'301',cantidad:1,opciones:opciones('Pollo')}],
    ['agregar_producto',{producto_id:'302',cantidad:1,opciones:opciones('Huevo')}],
    ['agregar_producto',{producto_id:'303',cantidad:1,opciones:opciones(null,['Roja','Verde'])}],
    ['definir_entrega',{modalidad:'recoger en tienda'}],['definir_pago',{forma_pago:'efectivo'}],
  ]):{stop_reason:'end_turn',content:[{type:'text',text:'¿Qué proteína deseas para los mixtos?'}]}});
assert.equal(r.escalado,false,JSON.stringify(r));
assert.equal(r.pedido.lineas.length,3,JSON.stringify(r.operaciones));
assert.deepEqual(r.pedido.lineas.map(l=>l.opciones.filter(o=>o.grupo==='Proteína').map(o=>o.opcion)),[['Pollo'],['Huevo'],[]]);
assert.equal(r.pedido.aclaraciones.length,1,JSON.stringify(r.pedido));
assert.equal(r.pedido.aclaraciones[0].grupo,'Proteína');
assert.equal(r.pedido.modalidad,'recoger en tienda');assert.equal(r.pedido.forma_pago,'efectivo');
assert.doesNotMatch(r.texto,/falta elegir (Salsa|Guarniciones)/);
console.log('OK pedido múltiple: tres platillos, preferencias separadas, entrega y pago una vez; solo falta proteína de mixtos.');

// Un texto con varios datos no debe quedar atrapado en el grupo abierto.
const abierto=nuevo();
abierto.carrito.items=[{lid:'mixtos',id:303,nombre:'Chilaquiles Mixtos',cantidad:1,modificadores:[]}];
fijarPendiente(abierto,{tipo:'elegir_opcion',linea_id:'mixtos',grupo:'Salsa',candidatos:['Roja','Verde','Chipotle']});
abrirGrupoDePregunta(abierto,catalogoMultiple);
assert.equal(respuestaTextoGrupo({estado:abierto,catalogo:catalogoMultiple,
  mensaje:'Roja y verde con pollo, frijoles naturales y papas a la mexicana, para recoger, pago en efectivo'}),null);
console.log('OK pedido múltiple: texto compuesto pasa al intérprete sin perder datos ni quedar atrapado en salsa.');

// Cuando hay varios platillos pendientes, preguntar juntos solo los faltantes.
const incompleto=nuevo();
incompleto.carrito.items=catalogoMultiple[0].productos.slice(0,2).map((p,i)=>({lid:`l${i}`,id:p.id,nombre:p.nombre,cantidad:1,modificadores:[]}));
const pedido=crearEjecutor({...ctx,estado:incompleto}).vista();
const texto=respuestaDesdePedido({...ctx,estado:incompleto,pedido});
assert.match(texto,/Chilaquiles Rojos/);assert.match(texto,/Chilaquiles Verdes/);
assert.match(texto,/Proteína/);assert.match(texto,/Guarniciones/);
console.log('OK pedido múltiple: faltantes de ambos platillos en una sola pregunta.');

// El modelo propone equivocadamente llevar el huevo del verde al rojo.
const adverso=nuevo();
const rechazado=await crearEjecutor({...ctx,estado:adverso,mensaje}).ejecutar('agregar_producto',{
  producto_id:'301',cantidad:1,opciones:opciones('Huevo')});
assert.equal(rechazado.aplicado,false,JSON.stringify(rechazado));assert.equal(adverso.carrito.items.length,0);
const antes=structuredClone(estado.carrito);
const ordinal=await crearEjecutor({...ctx,estado,mensaje:'Al segundo cámbiale la proteína por pollo'}).ejecutar('modificar_linea',{
  linea_id:estado.carrito.items[2].lid,opciones:[{grupo:'Proteína',opcion:'Pollo'}]});
assert.equal(ordinal.aplicado,false);assert.deepEqual(estado.carrito,antes);
console.log('OK pedido múltiple: rechaza preferencias cruzadas y un ordinal aplicado al renglón incorrecto.');

let compuestoVueltas=0;
const compuesto=await atenderTurnoConHerramientas({...ctx,estado:abierto,
  mensaje:'Roja y verde con pollo, frijoles naturales y papas a la mexicana, para recoger, pago en efectivo',turnoId:`multi-${++turno}`,
  llamarModelo:async()=>++compuestoVueltas===1?herramientas([
    ['modificar_linea',{linea_id:'mixtos',opciones:opciones('Pollo',['Roja','Verde'])}],
    ['definir_entrega',{modalidad:'recoger en tienda'}],['definir_pago',{forma_pago:'efectivo'}],
  ]):{stop_reason:'end_turn',content:[{type:'text',text:'¿Confirmas tu pedido?'}]}});
assert.equal(compuesto.escalado,false,JSON.stringify(compuesto));
assert.equal(abierto.eleccionInteractiva,undefined);assert.equal(abierto.pendiente.tipo,'confirmar_resumen');
assert.match(compuesto.texto,/Total: \$120/);assert.equal(compuesto.pedido.lineas[0].opciones.length,5);
console.log('OK pedido múltiple: texto completa cinco elecciones, entrega y pago; va al resumen sin Continuar redundante.');

let terminacion=0;
const ultimo=await atenderTurnoConHerramientas({...ctx,estado,mensaje:'Los mixtos con pollo',turnoId:`multi-${++turno}`,
  llamarModelo:async()=>++terminacion===1?herramientas([
    ['modificar_linea',{linea_id:estado.carrito.items[2].lid,opciones:[{grupo:'Proteína',opcion:'Pollo'}]}],
  ]):{stop_reason:'end_turn',content:[{type:'text',text:'¿Confirmas tu pedido?'}]}});
assert.equal(ultimo.escalado,false);assert.equal(estado.pendiente.tipo,'confirmar_resumen');
assert.match(ultimo.texto,/Total: \$320/);assert.equal(ultimo.pedido.lineas.length,3);
assert.deepEqual(estado.carrito.items.slice(0,2),antes.items.slice(0,2));
console.log('OK pedido múltiple: completar solo el tercero produce un resumen de tres platillos; conserva los otros dos.');
