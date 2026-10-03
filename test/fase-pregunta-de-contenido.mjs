// «¿Qué trae X?» se contesta con la descripción de la carta y no se convierte
// en «¿Agregamos X a tu pedido?» (conversación real del 2-oct-2026 en
// Obispado). Suite pura: sin Postgres ni modelo.
import assert from 'node:assert/strict';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { politicaDelTurno, preguntaDeContenido, respuestaDeConsulta } from '../src/mesero-agente/politicaDelTurno.js';

let ok = 0;
const t = async (nombre, fn) => { await fn(); ok++; console.log('OK', nombre); };
const CARTA = [
  { id: 1, nombre: 'Desayunos', productos: [
    { id: 125, nombre: 'Desayuno Sorpresa', precio: 345, disponible: true, orden: 0, modificadores: [],
      descripcion: 'Caja de regalo, incluye chilaquiles, waffles y bebida. Adicional puedes agregar flores.' },
    { id: 90, nombre: 'Hotcakes', precio: 139, disponible: true, orden: 1, modificadores: [] },
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    { id: 21, nombre: 'Coca Cola', precio: 39, disponible: true, orden: 0, modificadores: [] },
  ] },
];
const PRECIOS = { 'Desayuno Sorpresa': 345, Hotcakes: 139, 'Coca Cola': 39 };
const nuevo = () => estadoNuevo({ negocioId: 'n', conversacionId: 'contenido' });
const busqueda = (texto, respuesta) => {
  let n = 0;
  return async () => (++n === 1
    ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b1', name: 'buscar_producto', input: { texto } }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: respuesta }] });
};

await t('C1 la frase real del 2-oct es pregunta de contenido y de solo lectura', () => {
  for (const m of ['El desayuno sorpresa q contiene?', '¿Qué trae el desayuno sorpresa?', 'que incluye la caja sorpresa',
    '¿de qué es el bowl?', 'con que viene el combito']) {
    assert.ok(preguntaDeContenido(m), m);
    assert.equal(politicaDelTurno(m).soloLectura, true, m);
  }
  assert.equal(preguntaDeContenido('quiero un desayuno sorpresa, que trae?'), false);
  assert.equal(preguntaDeContenido('tienen coca?'), false);
});

await t('C2 contestar qué trae no deja una oferta de agregarlo', async () => {
  const estado = nuevo();
  const r = await atenderTurnoConHerramientas({ estado, catalogo: CARTA, precios: PRECIOS,
    mensaje: 'El desayuno sorpresa q contiene?',
    llamarModelo: busqueda('desayuno sorpresa', 'El Desayuno Sorpresa es una caja de regalo con chilaquiles, waffles y bebida, a $345.') });
  assert.equal(estado.pendiente, null, 'nació una oferta de agregar a partir de una pregunta');
  assert.equal(estado.carrito.items.length, 0);
  assert.match(r.texto, /chilaquiles, waffles y bebida/);
  assert.doesNotMatch(r.texto, /Agregamos/);
});

await t('C3 «¿tienen coca?» sigue ofreciendo agregarla', async () => {
  const estado = nuevo();
  await atenderTurnoConHerramientas({ estado, catalogo: CARTA, precios: PRECIOS, mensaje: 'tienen coca?',
    llamarModelo: busqueda('coca', 'Sí, tenemos Coca Cola a $39. ¿Te la agrego?') });
  assert.equal(estado.pendiente?.tipo, 'aceptar_producto');
});

await t('C4 la respuesta de respaldo da la descripción tal cual y el precio, sin ofrecer', () => {
  const ops = [{ herramienta: 'buscar_producto', resultado: { aplicado: true, encontrados: [
    { producto_id: '125', nombre: 'Desayuno Sorpresa', precio: 345,
      descripcion: 'Caja de regalo, incluye chilaquiles, waffles y bebida. Adicional puedes agregar flores.' }] } }];
  assert.equal(respuestaDeConsulta(ops, 'El desayuno sorpresa q contiene?'),
    'Desayuno Sorpresa: Caja de regalo, incluye chilaquiles, waffles y bebida. Adicional puedes agregar flores. Precio base: $345.');
  const sinDescripcion = [{ herramienta: 'buscar_producto', resultado: { aplicado: true, encontrados: [
    { producto_id: '90', nombre: 'Hotcakes', precio: 139, descripcion: '' }] } }];
  assert.match(respuestaDeConsulta(sinDescripcion, '¿qué traen los hotcakes?'), /^No tengo una descripción de Hotcakes/);
  assert.match(respuestaDeConsulta(ops, 'tienen desayuno sorpresa?'), /¿Te gustaría agregar alguno a tu pedido\?$/);
});

await t('C5 lo que no está en la carta sugiere lo que sí hay', () => {
  const ops = [{ herramienta: 'buscar_producto', resultado: { aplicado: true, existe: false, encontrados: [],
    categorias: [{ nombre: 'Desayunos', productos: 2, ejemplos: ['Hotcakes', 'Waffles'] },
      { nombre: 'Bebidas', productos: 1, ejemplos: ['Coca Cola'] }] } }];
  assert.equal(respuestaDeConsulta(ops, 'tienen crepas'),
    'No encuentro ese producto en nuestra carta. Lo que sí tenemos: Desayunos (Hotcakes, Waffles); Bebidas (Coca Cola). ¿Te interesa alguno?');
  const sinCarta = [{ herramienta: 'buscar_producto', resultado: { aplicado: true, existe: false, encontrados: [] } }];
  assert.match(respuestaDeConsulta(sinCarta, 'tienen crepas'), /^No encuentro ese producto disponible/);
});

await t('C6 si la redacción del modelo se sustituye, el respaldo también contesta con la descripción', async () => {
  const estado = nuevo();
  const r = await atenderTurnoConHerramientas({ estado, catalogo: CARTA, precios: PRECIOS, nombresOcultos: ['Ramo de rosas'],
    mensaje: 'El desayuno sorpresa q contiene?',
    llamarModelo: busqueda('desayuno sorpresa', 'El Desayuno Sorpresa trae chilaquiles y le puedes sumar un Ramo de rosas.') });
  assert.ok(r.texto.endsWith('Desayuno Sorpresa: Caja de regalo, incluye chilaquiles, waffles y bebida. Adicional puedes agregar flores. Precio base: $345.'), r.texto);
  assert.doesNotMatch(r.texto, /Ramo de rosas|Agregamos/);
  assert.equal(estado.pendiente, null);
});

console.log(`fase-pregunta-de-contenido: ${ok}/6`);
