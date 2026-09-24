import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { pedidoEnTexto } from '../src/mesero-agente/instrucciones.js';
import { vistaDelPedido } from '../src/mesero-agente/vistaDelPedido.js';

const opcion = (nombre, precio_extra = 0) => ({ nombre, precio_extra, disponible: true });
const grupo = (nombre, nombres, maximo = 1) => ({
  nombre, requerido: true, minimo: 1, maximo,
  opciones: nombres.map((n) => opcion(n)),
});

// Misma estructura y grupos que el producto real de Mapolato. Se añade otro
// producto con Guarniciones para reproducir el error: esa palabra existe en la
// carta, pero no pertenece al Desayuno Sorpresa.
const CATALOGO = [{ id: 1, nombre: 'Desayunos', productos: [
  {
    id: 125, nombre: 'Desayuno Sorpresa', precio: 345, disponible: true,
    modificadores: [
      grupo('Salsa', ['Suiza', 'Roja', 'Verde', 'Mole', 'Chipotle']),
      grupo('Proteína', ['Huevos estrellados', 'Huevos revueltos', 'Pechuga de pollo',
        'Chicharron Prensado', 'Bistec']),
      grupo('Topping Waffles', ['Miel y mantequilla', 'Nutella', 'Hersheys', 'Lechera',
        'Cajeta', 'Blueberries Cheesecake']),
      grupo('Bebida', ['Café Americano', 'Refresco', 'Agua piña mango', 'Agua betabel guayaba',
        'Agua horchata', 'Licuado plátano', 'Licuado fresa']),
      grupo('¿Agregar flores?', ['Si', 'No']),
    ],
  },
  {
    id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true,
    modificadores: [grupo('Guarniciones', ['Frijolitos naturales', 'Frijolitos con chorizo',
      'Papas a la mexicana', 'Papas con chorizo'], 2)],
  },
] }];

const PRECIOS = { 'Desayuno Sorpresa': 345, 'Chilaquiles Mixtos': 205 };
const NEGOCIO = '11111111-1111-4111-8111-111111111111';
const MODALIDADES = ['recoger en tienda', 'entrega a domicilio'];

async function turno(estado, mensaje, numero, llamarModelo = async () => {
  throw new Error(`el modelo no debía intervenir en la continuación: ${mensaje}`);
}) {
  return atenderTurnoConHerramientas({
    negocioId: NEGOCIO,
    conversacionId: estado.conversacionId,
    turnoId: `t-${numero}`,
    mensaje,
    estado,
    catalogo: CATALOGO,
    precios: PRECIOS,
    modalidades: MODALIDADES,
    metodosPago: ['efectivo', 'enlace_pago'],
    llamarModelo,
  });
}

// 1) La consulta deja una oferta durable aunque el canal no pase historial.
const estado = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'desayuno-sorpresa-raiz' });
let llamadasConsulta = 0;
const consulta = await turno(estado, 'Hola, ¿tienen desayuno sorpresa?', 1, async () => {
  llamadasConsulta += 1;
  if (llamadasConsulta === 1) {
    return { stop_reason: 'tool_use', content: [{
      type: 'tool_use', id: 'buscar-125', name: 'buscar_producto',
      input: { texto: 'desayuno sorpresa' },
    }] };
  }
  return { stop_reason: 'end_turn', content: [{ type: 'text',
    text: 'Sí, tenemos Desayuno Sorpresa en $345. ¿Deseas pedirlo?' }] };
});
assert.equal(consulta.llamadasAlModelo, 2);
assert.deepEqual(estado.ofrecidos, ['Desayuno Sorpresa']);
assert.equal(estado.carrito.items.length, 0);

// 2) «Sí por favor» agrega exactamente la oferta y pregunta el primer grupo.
let salida = await turno(estado, 'Sí por favor', 2);
assert.equal(salida.llamadasAlModelo, 0);
assert.equal(salida.continuidadDeterminista, true);
assert.equal(estado.carrito.items[0].nombre, 'Desayuno Sorpresa');
assert.match(salida.texto, /Salsa/);
assert.match(salida.texto, /Suiza/);

// 3) Cada respuesta inequívoca se guarda con el nombre canónico y avanza una
// sola pregunta. Ningún turno vuelve a depender de la memoria del modelo.
for (const [numero, mensaje, grupoEsperado, opcionEsperada, siguiente] of [
  [3, 'Suiza', 'Salsa', 'Suiza', 'Proteína'],
  [4, 'Pechuga pollo', 'Proteína', 'Pechuga de pollo', 'Topping Waffles'],
  [5, 'Nutella', 'Topping Waffles', 'Nutella', 'Bebida'],
  [6, 'Refresco', 'Bebida', 'Refresco', '¿Agregar flores?'],
]) {
  salida = await turno(estado, mensaje, numero);
  assert.equal(salida.llamadasAlModelo, 0, mensaje);
  const elegida = salida.pedido.lineas[0].opciones.find((o) => o.grupo === grupoEsperado);
  assert.equal(elegida?.opcion, opcionEsperada, mensaje);
  assert.match(salida.texto, new RegExp(siguiente.replace(/[?]/g, '\\?')));
}

// 4) La frase natural se traduce a «No» solo porque ese grupo binario exacto
// está en foco. Después continúa con la modalidad real del negocio.
salida = await turno(estado, 'Sin las flores', 7);
assert.equal(salida.llamadasAlModelo, 0);
assert.equal(salida.pedido.lineas[0].opciones.find((o) => o.grupo === '¿Agregar flores?')?.opcion, 'No');
assert.match(salida.texto, /recoger.*domicilio/i);
assert.equal(salida.pedido.aclaraciones.length, 0);

// 5) El prompt de respaldo también muestra candidatos; nunca vuelve a enseñar
// únicamente el nombre del grupo sin las elecciones posibles.
const textoPedido = pedidoEnTexto(salida.pedido);
assert.doesNotMatch(textoPedido, /SIN ELEGIR/);
const estadoPrompt = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'prompt-candidatos' });
estadoPrompt.carrito.items.push({ lid: 'l-prompt', id: 125, nombre: 'Desayuno Sorpresa', cantidad: 1,
  modificadores: [], notas: '' });
const vistaPrompt = vistaDelPedido({ carrito: estadoPrompt.carrito, catalogo: CATALOGO, precios: PRECIOS });
assert.match(pedidoEnTexto(vistaPrompt), /Salsa \[Suiza \| Roja \| Verde/);

// 6) «Guarniciones» existe en la carta pero no en este producto. No debe
// buscar tacos, inventar un grupo ni modificar el pedido.
const estadoAjeno = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'grupo-ajeno' });
estadoAjeno.carrito.items.push({ lid: 'l-ajeno', id: 125, nombre: 'Desayuno Sorpresa', cantidad: 1,
  modificadores: [], notas: '' });
estadoAjeno.foco = { tipo: 'opcion', linea_id: 'l-ajeno', grupo: 'Salsa' };
const antes = JSON.stringify(estadoAjeno.carrito);
const ajeno = await turno(estadoAjeno, 'Guarniciones\nFrijoles naturales y papas', 8);
assert.equal(ajeno.llamadasAlModelo, 0);
assert.match(ajeno.texto, /no tiene Guarniciones como elección/i);
assert.match(ajeno.texto, /falta elegir Salsa/i);
assert.equal(JSON.stringify(estadoAjeno.carrito), antes);

// 7) Una respuesta que empata entre hermanas se vuelve a preguntar. El motor
// no elige uno de los dos licuados por su cuenta.
const estadoAmbiguo = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'opcion-ambigua' });
estadoAmbiguo.carrito.items.push({ lid: 'l-ambiguo', id: 125, nombre: 'Desayuno Sorpresa', cantidad: 1,
  modificadores: [
    { grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteína', opciones: ['Pechuga de pollo'] },
    { grupo: 'Topping Waffles', opciones: ['Nutella'] },
  ], notas: '' });
estadoAmbiguo.foco = { tipo: 'opcion', linea_id: 'l-ambiguo', grupo: 'Bebida' };
const ambigua = await turno(estadoAmbiguo, 'Licuado', 9);
assert.equal(ambigua.llamadasAlModelo, 0);
assert.equal(ambigua.opcionAmbigua, true);
assert.equal(ambigua.pedido.lineas[0].opciones.some((o) => o.grupo === 'Bebida'), false);
assert.match(ambigua.texto, /Licuado plátano/);
assert.match(ambigua.texto, /Licuado fresa/);

// 8) Mencionar una opción en una pregunta no la selecciona. La conversación
// puede continuar con el modelo, pero el carrito sigue intacto.
const estadoPregunta = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'pregunta-opcion' });
estadoPregunta.carrito.items.push({ lid: 'l-pregunta', id: 125, nombre: 'Desayuno Sorpresa', cantidad: 1,
  modificadores: [
    { grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteína', opciones: ['Pechuga de pollo'] },
    { grupo: 'Topping Waffles', opciones: ['Nutella'] },
  ], notas: '' });
estadoPregunta.foco = { tipo: 'opcion', linea_id: 'l-pregunta', grupo: 'Bebida' };
let modeloPregunta = 0;
const preguntaOpcion = await turno(estadoPregunta, '¿El refresco es light?', 10, async () => {
  modeloPregunta += 1;
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Déjame confirmarte esa información.' }] };
});
assert.equal(modeloPregunta, 1);
assert.equal(preguntaOpcion.pedido.lineas[0].opciones.some((o) => o.grupo === 'Bebida'), false);

// 9) Un grupo con máximo dos opciones acepta dos elecciones inequívocas en
// una sola respuesta. Antes ambas quedaban como «ambiguas» y se repetía la
// pregunta de guarniciones indefinidamente.
const estadoDosOpciones = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'dos-opciones' });
estadoDosOpciones.carrito.items.push({ lid: 'l-dos-opciones', id: 107,
  nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: [], notas: '' });
estadoDosOpciones.foco = { tipo: 'opcion', linea_id: 'l-dos-opciones', grupo: 'Guarniciones' };
const dosOpciones = await turno(estadoDosOpciones,
  'Frijolitos con chorizo y papas con chorizo', 11);
assert.equal(dosOpciones.llamadasAlModelo, 0);
assert.equal(dosOpciones.continuidadDeterminista, true);
assert.equal(dosOpciones.opcionAmbigua, undefined);
assert.deepEqual(dosOpciones.pedido.lineas[0].opciones, [
  { grupo: 'Guarniciones', opcion: 'Frijolitos con chorizo' },
  { grupo: 'Guarniciones', opcion: 'Papas con chorizo' },
]);

console.log('OK: continuidad determinista del Desayuno Sorpresa, opciones canónicas, preguntas, grupo ajeno y ambigüedad protegidos.');
