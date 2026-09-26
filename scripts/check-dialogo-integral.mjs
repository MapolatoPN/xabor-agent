import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { acusarDialogo } from '../src/mesero-agente/contratoConversacional.js';
const g = (nombre, opciones, minimo=1, maximo=1) => ({ nombre, requerido:true,minimo,maximo,
  opciones:opciones.map(nombre=>({nombre,disponible:true})) });
const catalogo=[{nombre:'Prueba',productos:[
  {id:1,nombre:'Omelette Clásico',precio:100,disponible:true,modificadores:[g('Tortillas',['Maíz','Harina'])]},
  {id:2,nombre:'Licuado',precio:50,disponible:true,modificadores:[]},
  {id:3,nombre:'Desayuno',precio:100,disponible:true,modificadores:[g('Guarniciones',['Frijoles','Papas','Ensalada'],2,2)]},
]}];
const nuevo=(id=2)=>{const e=estadoNuevo({negocioId:'prueba',conversacionId:'integral'});const p=catalogo[0].productos.find(p=>p.id===id);
 e.carrito={items:[{id,lid:`l${id}`,nombre:p.nombre,cantidad:1,modificadores:[],notas:''}],datos:{modalidad:'recoger en tienda',forma_pago:'efectivo'}};return e;};
const texto=text=>({stop_reason:'end_turn',content:[{type:'text',text}]});
const tool=(name,input)=>({stop_reason:'tool_use',content:[{type:'tool_use',id:name,name,input}]});
let efectos=0;const confirmar=async()=>{efectos++;return{ok:true,folio:'SIMULADO'};};
let e=nuevo();let ex=crearEjecutor({estado:e,catalogo,mensaje:'Todavía no confirmes, espera',efectos:{confirmar}});
assert.equal((await ex.ejecutar('confirmar_pedido',{huella_resumen:ex.vista().huella})).aplicado,false);
assert.equal(efectos,0);
let r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Continuamos',llamarModelo:async()=>texto('¿Confirmas?')});
assert.equal(e.dialogo.tipo,'resumen');
assert.match(r.texto,/buenos días|buenas tardes|buenas noches/i,'El primer turno también saluda si comienza con un pedido');
ex=crearEjecutor({estado:e,catalogo,mensaje:'Sí',efectos:{confirmar}});
assert.equal((await ex.ejecutar('confirmar_pedido',{huella_resumen:ex.vista().huella})).aplicado,false,'Sin envío no hay autorización');
assert.equal(acusarDialogo(e,'otro',r.texto),false);
assert.equal(acusarDialogo(e,r.dialogoId,r.texto),true);
const longitudHistoria=e.historialDialogo.length;
assert.equal(acusarDialogo(e,r.dialogoId,r.texto),true);
assert.equal(e.historialDialogo.length,longitudHistoria,'Acuse repetido no duplica historial');
for(const mensaje of ['Todavía no confirmes','Sí, pero agrega otro licuado','¿Está bien?']) {
 ex=crearEjecutor({estado:e,catalogo,mensaje,efectos:{confirmar}});
 assert.equal((await ex.ejecutar('confirmar_pedido',{huella_resumen:ex.vista().huella})).aplicado,false,mensaje);
}
const cambiado=structuredClone(e);cambiado.carrito.items[0].cantidad=2;
ex=crearEjecutor({estado:cambiado,catalogo,mensaje:'Sí',efectos:{confirmar}});
assert.equal((await ex.ejecutar('confirmar_pedido',{huella_resumen:ex.vista().huella})).aplicado,false,'Huella nueva no aceptada');
ex=crearEjecutor({estado:e,catalogo,mensaje:'Sí, confirmo',efectos:{confirmar}});
assert.equal((await ex.ejecutar('confirmar_pedido',{huella_resumen:ex.vista().huella})).aplicado,true);
assert.equal(efectos,1);
// Un sí al resumen nunca agrega la última búsqueda otra vez.
e=nuevo();e.ofrecidos=['Licuado'];
r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Continuamos',llamarModelo:async()=>texto('Resumen')});
acusarDialogo(e,r.dialogoId,r.texto);
await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Sí',llamarModelo:async()=>texto('Resumen')});
assert.equal(e.carrito.items.length,1);
for(const mensaje of ['No canceles mi pedido','Quita el licuado','¿Puedes cancelar?']) {
 e=nuevo();ex=crearEjecutor({estado:e,catalogo,mensaje});
 assert.equal((await ex.ejecutar('cancelar_pedido',{motivo:'modelo'})).aplicado,false);
 assert.equal(e.carrito.items.length,1);
}
e=nuevo();assert.equal((await crearEjecutor({estado:e,catalogo,mensaje:'Cancela mi pedido por favor'}).ejecutar('cancelar_pedido',{motivo:'cliente'})).aplicado,true);
e=nuevo(1);e.carrito.datos={};e.foco={tipo:'opcion',linea_id:'l1',grupo:'Tortillas'};let llamadas=0;
r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Maíz y agrega un licuado',llamarModelo:async()=>++llamadas===1?tool('agregar_producto',{producto_id:'2',cantidad:1}):texto('Ya agregué tres tacos')});
assert.equal(e.carrito.items.length,2);assert.equal(llamadas,2);assert.doesNotMatch(r.texto,/tacos/);assert.match(r.texto,/Licuado/);
e=nuevo(3);e.carrito.items[0].modificadores=[{grupo:'Guarniciones',opciones:['Frijoles']}];
assert.equal(crearEjecutor({estado:e,catalogo}).vista().estado,'aclarando');
r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Papas',llamarModelo:async()=>texto('Perfecto')});
assert.equal(e.carrito.items[0].modificadores[0].opciones.length,2);
assert.equal(r.pedido.estado,'listo');
e=nuevo(1);e.carrito.items.push(nuevo(3).carrito.items[0]);
r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Seguimos',llamarModelo:async()=>texto('¿Frijoles o papas para el desayuno?')});
assert.match(r.texto,/Omelette Clásico.*Tortillas/);assert.equal(e.foco.linea_id,'l1');
acusarDialogo(e,r.dialogoId,r.texto);e=JSON.parse(JSON.stringify(e));
let vioHistoria=false;
await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Una pregunta sobre mi pedido',llamarModelo:async p=>{vioHistoria=p.messages.some(m=>m.role==='assistant'&&m.content===r.texto);return texto('Seguimos');}});
assert(vioHistoria,'Historial real solo de mensajes enviados, tras recarga');
e=nuevo();r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Agrega otro licuado',llamarModelo:async()=>{throw Object.assign(Error('Request timed out.'),{name:'APIConnectionTimeoutError'});}});
assert.equal(r.escalado,false);assert.equal(e.hechos.fallido,false);assert.equal(e.carrito.items.length,1);
assert.equal(e.turnoPendiente.mensaje,'Agrega otro licuado');assert.match(r.texto,/No pude completar/);
e=nuevo();r=await atenderTurnoConHerramientas({estado:e,catalogo,mensaje:'Agrega otro licuado',topeMs:-1,llamarModelo:async()=>{throw Error('No debe iniciar llamada fuera de presupuesto');}});
assert.equal(r.escalado,false);assert.equal(e.hechos.fallido,false);assert.equal(e.carrito.items.length,1);
// Vocabulario compartido entre grupos y productos del catálogo real.
const carta=[{nombre:'Desayunos',productos:[
  {id:107,nombre:'Chilaquiles Mixtos',precio:205,disponible:true,modificadores:[
    g('Salsa',['Suiza','Chipotle'],1,2),g('Proteína',['Huevos Estrellados','Chicharron Prensado','Chicharron Cuerito en Salsa'],1,2),
    g('Guarniciones',['Frijolitos naturales','Frijolitos con chorizo','Papas con chorizo','Bistec en salsa','Queso panela en salsa','Chicharron cuerito en salsa'],1,2)]},
  {id:96,nombre:'Tacos Chicharrón Prensado',precio:90,disponible:true,modificadores:[g('Tortilla',['Maíz','Harina'])]},
]}];
e=estadoNuevo({negocioId:'prueba',conversacionId:'catalogo-compartido'});
ex=crearEjecutor({estado:e,catalogo:carta,mensaje:'Quiero chilaquiles mixtos con salsa suiza y chipotle, huevos estrellados, frijolitos naturales y papas con chorizo'});
await ex.ejecutar('agregar_producto',{producto_id:'107',cantidad:1,opciones:[
  {grupo:'Salsa',opcion:'Suiza'},{grupo:'Salsa',opcion:'Chipotle'},{grupo:'Proteína',opcion:'Huevos Estrellados'},
  {grupo:'Guarniciones',opcion:'Frijolitos naturales'},{grupo:'Guarniciones',opcion:'Papas con chorizo'}]});
assert.equal(e.opcionesPendientes.length,0,'Salsa nombra su grupo, no otra guarnición');
const antesChila=JSON.stringify(e.carrito.items[0]);
ex=crearEjecutor({estado:e,catalogo:carta,mensaje:'Agrega tacos de chicharrón prensado con tortilla de maíz'});
const buscado=await ex.ejecutar('buscar_producto',{texto:'tacos de chicharrón prensado'});
assert(buscado.encontrados.some(p=>p.producto_id==='96'),'Producto explícito gana a la coincidencia parcial de opción');
llamadas=0;
r=await atenderTurnoConHerramientas({estado:e,catalogo:carta,mensaje:'Agrega tacos de chicharrón prensado con tortilla de maíz',
 llamarModelo:async()=>++llamadas===1?tool('agregar_producto',{producto_id:'96',cantidad:1,opciones:[{grupo:'Tortilla',opcion:'Maíz'}]}):texto('Listo')});
assert.equal(e.carrito.items.length,2);assert.equal(JSON.stringify(e.carrito.items[0]),antesChila,'El taco no cambia proteína ni guarniciones');
assert.equal(e.opcionesPendientes.length,0);
console.log('OK integral: consentimiento y envío, cancelación, mensaje compuesto, mínimo dos, foco, veracidad, historial durable y timeout recuperable.');
