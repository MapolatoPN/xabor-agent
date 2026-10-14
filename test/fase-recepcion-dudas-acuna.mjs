// ─── DUDAS REALES DE ACUÑA (10–14 OCT 2026), SIN BASE ────────────────────
//
// Lo que los clientes de Acuña escribieron y recibió «Perdón, no te entendí»
// o pasó a una persona «para tomar tu pedido»: preguntas por un platillo
// (precio, qué trae, sinónimos como «combo» y «hot cakes»), respuestas
// aprobadas que no se reconocían (costo de envío, transferencia, «mitad de
// precio», «aún tiene servicio») y despedidas. Más lo que NO debe cambiar:
// un pedido escrito, la carta, un cambio con carrito y el silencio tras el
// personal.
//
// Filtrar casos para las mordidas: CASOS=A1,C3 node test/fase-recepcion-dudas-acuna.mjs
import assert from 'node:assert/strict';
import * as R from '../src/mesero-agente/recepcionista.js';
import * as RF from '../src/mesero-agente/respuestasFijas.js';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
import { FRASES, CLAVES_IA } from '../src/mesero-agente/recepcionista.js';

Object.assign(process.env, { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' });

let pasadas = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${String(e?.message || e).split('\n').slice(0, 4).join(' | ')}`); }
}

// La carta de Acuña, recortada a lo que estas dudas tocan (precios y textos reales).
const op = (...n) => n.map((nombre) => ({ nombre, precio_extra: 0, disponible: true }));
const grupo = (nombre, ...opciones) => ({ nombre, requerido: true, minimo: 1, maximo: 1, opciones: op(...opciones) });
const COMBITO = (de) => `Los combitos están hechos para disfrutar lo mejor 2 dos platillos, en este caso ${de}, el postre que puede ser hotcakes o waffles y un topping si lo deseas.`;
const CARTA = [
  { id: 'd', nombre: 'DESAYUNOS', productos: [
    { id: 290, nombre: 'Hotcakes', precio: 139, disponible: true, descripcion: 'La orden incluye 2 piezas acompañadas de fruta fresca de temporada.' },
    { id: 291, nombre: 'Waffles', precio: 149, disponible: true, descripcion: 'La orden incluye 1 waffle con fruta fresca de temporada.' },
  ] },
  { id: 'c', nombre: 'CHILAQUILES', productos: [
    { id: 296, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true,
      descripcion: 'Los chilaquiles van servidos con una salsa, una proteína y 2 guarniciones, además lleva cilantro, queso, crema y cebolla.',
      modificadores: [grupo('Salsa', 'Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'),
        grupo('Proteína', 'Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado')] },
    { id: 297, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true,
      descripcion: 'Los chilaquiles van servidos con dos salsas, hasta dos proteínas y 2 guarniciones.' },
  ] },
  { id: 'k', nombre: 'Combitos', productos: [
    { id: 299, nombre: 'Combito de Chilaquiles', precio: 195, disponible: true, descripcion: COMBITO('de chilaquiles, eliges una salsa, una proteína') },
    { id: 300, nombre: 'Combito de Cuernito', precio: 195, disponible: true, descripcion: COMBITO('puedes elegir uno de nuestros cuernitos') },
    { id: 301, nombre: 'Combito de Omelette', precio: 195, disponible: true, descripcion: COMBITO('puedes elegir uno de nuestros omelettes') },
  ] },
  { id: 'h', nombre: 'HUEVOS', productos: [
    { id: 310, nombre: 'Huevos con machacado en salsa', precio: 225, disponible: true },
  ] },
  { id: 'b', nombre: 'BEBIDAS', productos: [{ id: 320, nombre: 'Café Americano', precio: 39, disponible: true }] },
];

const T = F.TELEFONO;
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const REGLAS = {
  ...F.reglas, timezone: 'America/Matamoros',
  horarios: Object.fromEntries(DIAS.map((d) => [d, { abierto: d !== 'domingo', apertura: '07:30', cierre: '14:00' }])),
  cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { ...F.reglas.pedidos, tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, tiempo_preparacion_minutos: 25,
    pedido_minimo_entrega: 0 },
  bot: { palabras_criticas: [], faqs: [] },
};
const CFG = { ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true', whatsapp_interactivos_elecciones_v1: 'true',
  whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true', whatsapp_eventos_formulario_v1: 'true',
  whatsapp_flow_evento_id: '77777777777', direccion: 'Aquiles Serdán 735', ciudad: 'Acuña',
  [CLAVES_IA.MODO]: 'formulario', [CLAVES_IA.ALCANCE]: 'todos' };

const vacio = () => F.estado({ pendiente: null });
// El carrito con platillos de ESTA carta (el formulario se arma contra ella).
const conCarrito = () => F.estado({ pendiente: null, items: [
  { lid: 'L1', id: 296, nombre: 'Chilaquiles Sencillos', cantidad: 1, notas: '',
    modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteína', opciones: ['Pechuga de pollo'] }] },
  { lid: 'L2', id: 320, nombre: 'Café Americano', cantidad: 1, notas: '', modificadores: [] }] });
const confirmado = () => { const e = F.estado({ pendiente: null, items: 'dos' }); e.folio = 'XAB-1001'; e.hechos.confirmado = true; return e; };
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

async function decidir(mensaje, { estado = vacio(), abierto = true, lectores = {} } = {}) {
  const ia = R.modoIA(CFG, T);
  assert(ia?.completo, 'el modo no está completo en la configuración del caso');
  const estadoRestaurante = { abierto, diaActual: 'miercoles', fechaHoy: '2026-10-14', preApertura: false };
  const { entradas } = RF.catalogoDeRespuestas({ reglas: REGLAS, cfg: CFG, metodosPago: F.metodosPago, modalidades: F.modalidades, estadoRestaurante });
  const lect = {
    ultimoSaliente: async () => lectores.ultimoSaliente ?? null,
    pedidosActivos: async () => lectores.pedidosActivos ?? [],
    formularioReciente: async () => lectores.formularioReciente ?? false,
    formularioRescate: async () => false,
    estadoOperativo: async () => lectores.estadoOperativo ?? null,
    promocionesOficiales: async () => 'Miércoles de chilaquiles (texto oficial).',
  };
  return R.decidirRecepcion({ ia, cfg: CFG, reglas: REGLAS, estado, mensaje, catalogo: CARTA, metodosPago: F.metodosPago,
    modalidades: F.modalidades, estadoRestaurante, negocioId: 'neg', telefono: T, lectores: lect, entradas });
}
const ruta = (d) => `${d.recepcion?.paso}:${d.recepcion?.tipo}`;
const texto = (d) => String(d.respuesta?.texto || '');
function exigir(d, pasoTipo, donde) {
  assert.equal(ruta(d), pasoTipo, `${donde}: obtenido ${ruta(d)} «${texto(d).slice(0, 90)}»`);
  assert.deepEqual(d.respuesta?.acciones ?? [], [], `${donde}: una respuesta del router no lleva acciones`);
}

console.log('\n── A. Preguntas por un platillo: datos de la carta (R12), nunca «no te entendí» ni una persona');
await caso('A1 «Precio de los chilaquiles?» → los tres con su precio', async () => {
  const d = await decidir('Precio de los chilaquiles?');
  exigir(d, 'R12:producto', 'A1');
  assert.equal(texto(d), `Sí, en el menú tenemos: Chilaquiles Sencillos ($195), Chilaquiles Mixtos ($205), Combito de Chilaquiles ($195).\n\n${FRASES.PRODUCTO_PIE}`);
  assert.deepEqual(d.respuesta.pendiente, { tipo: 'agregar_otro' }, 'el menú va debajo de la respuesta');
});
await caso('A2 «precio de los chilaquiles» sin «?» → no es un pedido escrito (antes: persona «para tomar tu pedido»)', async () => {
  exigir(await decidir('precio de los chilaquiles'), 'R12:producto', 'A2');
  exigir(await decidir('Cuál es el costo de los chilaquiles en salsa verde'), 'R12:producto', 'A2 costo');
});
await caso('A3 «Precio del combo??» → los combitos («combo» es «combito»)', async () => {
  const d = await decidir('Precio del combo??');
  exigir(d, 'R12:producto', 'A3');
  assert.match(texto(d), /^Sí, en el menú tenemos: Combito de Chilaquiles \(\$195\), Combito de Cuernito \(\$195\), Combito de Omelette \(\$195\)\./);
});
await caso('A4 «El combo de chilaquiles con hot cakes es el combito?» → SOLO la ficha del Combito de Chilaquiles', async () => {
  const d = await decidir('El combo de chilaquiles con hot cakes es el combito?');
  exigir(d, 'R12:producto', 'A4');
  assert.ok(texto(d).startsWith(`Combito de Chilaquiles: ${COMBITO('de chilaquiles, eliges una salsa, una proteína').replace(/\.$/, '')}. Precio base: $195.`), texto(d));
  assert.doesNotMatch(texto(d), /Hotcakes:|Chilaquiles Sencillos/, 'solo la coincidencia más fuerte');
});
await caso('A5 «Los combitos llevan hot cakes?» → lo que trae cada uno', async () => {
  const d = await decidir('Los combitos llevan hot cakes?');
  exigir(d, 'R12:producto', 'A5');
  assert.match(texto(d), /Combito de Chilaquiles: Los combitos están hechos[^\n]*hotcakes o waffles[^\n]*Precio base: \$195\./);
});
await caso('A6 «Para pedir chilaquiles cuál es el meno de lo que le ponen ?» → la descripción, no un pedido', async () => {
  const d = await decidir('Para pedir chilaquiles cuál es el meno de lo que le ponen ?');
  exigir(d, 'R12:producto', 'A6');
  assert.match(texto(d), /Chilaquiles Sencillos: Los chilaquiles van servidos con una salsa, una proteína y 2 guarniciones/);
});
await caso('A7 «Precio del combito chilaquiles y hot cakes?» → la ficha con su precio', async () => {
  const d = await decidir('Precio del combito chilaquiles y hot cakes?');
  exigir(d, 'R12:producto', 'A7');
  assert.match(texto(d), /^Combito de Chilaquiles: .* Precio base: \$195\./);
});
await caso('A8 qué le ponen a UN platillo → lo que se elige, con las opciones reales', async () => {
  const d = await decidir('¿Qué le ponen a los chilaquiles sencillos?');
  exigir(d, 'R12:producto', 'A8');
  assert.match(texto(d), /\nAl pedirlo eliges: Salsa \(Roja, Suiza, Verde, Mole, Chipotle\) · Proteína \(Huevos Estrellados, Huevos Revueltos, Pechuga de pollo, Chicharron Prensado\)\./);
});
await caso('A9 con carrito → la respuesta y «Continuar pedido»', async () => {
  const d = await decidir('¿Cuánto cuestan los chilaquiles?', { estado: conCarrito() });
  exigir(d, 'R12:producto', 'A9');
  assert.equal(d.formulario?.cta, 'Continuar pedido');
});
await caso('A11 «hot cakes» en dos palabras es «Hotcakes»', async () => {
  const d = await decidir('¿Cuánto cuestan los hot cakes?');
  exigir(d, 'R12:producto', 'A11');
  assert.match(texto(d), /^Hotcakes: La orden incluye 2 piezas acompañadas de fruta fresca de temporada\. Precio base: \$139\./);
});
await caso('A12 «wafles» con una f es «Waffles»', async () => {
  const d = await decidir('¿Qué traen los wafles?');
  exigir(d, 'R12:producto', 'A12');
  assert.match(texto(d), /^Waffles: /);
});
await caso('A10 cerrado → el aviso de cerrado, sin «recibimos tu pedido»', async () => {
  const d = await decidir('precio de los chilaquiles', { abierto: false });
  assert.equal(d.recepcion.paso, 'R7');
  assert.ok(!texto(d).includes(FRASES.PEDIDO_ESCRITO_CERRADO.trim()), texto(d));
});

console.log('\n── B. Lo que NO cambia');
await caso('B1 una orden escrita sigue siendo pedido escrito', async () => {
  exigir(await decidir('quiero unos chilaquiles verdes'), 'R10:pedido_escrito', 'B1');
  exigir(await decidir('2 chilaquiles verdes'), 'R10:pedido_escrito', 'B1 lista');
  exigir(await decidir('quiero 2 chilaquiles verdes?'), 'R10:pedido_escrito', 'B1 decisión con «?»');
});
await caso('B2 pedir la carta sigue siendo la carta', async () => {
  exigir(await decidir('me puede dar los precios pliss'), 'R10:carta', 'B2');
  exigir(await decidir('¿me pasas el menú de chilaquiles?'), 'R10:carta', 'B2 con platillo');
});
await caso('B3 con carrito, un cambio en forma de pregunta abre la edición', async () => {
  exigir(await decidir('¿sin cebolla los chilaquiles?', { estado: conCarrito() }), 'R10:cambiar', 'B3');
});
await caso('B4 «¿Tienen chilaquiles?» → la lista (no una sola ficha)', async () => {
  const d = await decidir('¿Tienen chilaquiles?');
  exigir(d, 'R12:producto', 'B4');
  assert.match(texto(d), /^Sí, en el menú tenemos: /);
});
await caso('B5 «Quiero ordenar» → el formulario', async () => {
  exigir(await decidir('Quiero ordenar'), 'R10:pedir', 'B5');
});
await caso('B6 tras el personal (5 min) una pregunta de platillo NO la contesta el bot', async () => {
  const d = await decidir('Precio de los chilaquiles?', { lectores: { ultimoSaliente: { origen: 'humano', minutos: 5 } } });
  assert.equal(d.ruta, 'silencio'); assert.equal(d.recepcion.paso, 'R0');
});
await caso('B7 sin coincidencia en la carta → no es consulta de platillo', async () => {
  assert.equal(R.esConsultaDeProducto('¿tienen pizza?', CARTA), false);
  assert.equal(R.esConsultaDeProducto('precio de los chilaquiles', CARTA), true);
  assert.equal(R.esConsultaDeProducto('quiero chilaquiles', CARTA), false, 'una decisión no es consulta');
});

console.log('\n── C. Respuestas aprobadas que no se reconocían');
const fija = async (mensaje, tema, opts) => exigir(await decidir(mensaje, opts), `R11:fija:${tema}`, mensaje);
await caso('C1 «incluye el costo a domicilio» → envío', () => fija('incluye el costo a domicilio', 'envio'));
await caso('C2 «Tunes servicio a domicilio» → envío', () => fija('Tunes servicio a domicilio', 'envio'));
await caso('C3 «A q cuenta le transfiero» → formas de pago', () => fija('A q cuenta le transfiero', 'pagos'));
await caso('C4 «No es el segundo a mitad de precio?» → promociones', () => fija('No es el segundo a mitad de precio?', 'promociones'));
await caso('C5 «Hola aún tiene servicio?» → horario', () => fija('Hola aún tiene servicio?', 'horario'));
await caso('C6 «aún tienen servicio a domicilio?» → envío, no horario', () => fija('aún tienen servicio a domicilio?', 'envio'));
await caso('C7 «Dónde se ubican exactamente» → ubicación', () => fija('Dónde se ubican exactamente?', 'ubicacion'));
await caso('C8 «que cuenta con» no es la cuenta para pagar', async () => {
  const t = 'el combito que cuenta con hotcakes?';
  assert.equal(RF.TEMAS.pagos(t.replace('?', ''), t), false);
});
await caso('C9 promoción «2x1» → promociones', () => fija('¿Hoy es el 2x1?', 'promociones'));

console.log('\n── D. Despedidas y agradecimientos');
await caso('D1 «Gracias ya vi direcc . Al ratito paso» → cortesía', async () => {
  exigir(await decidir('Gracias ya vi direcc . Al ratito paso'), 'R-cortesia:cortesia', 'D1');
});
await caso('D2 «Muchas gracias por la información Muy amable Pronto nos vemos» → cortesía', async () => {
  exigir(await decidir('Muchas gracias por la información Muy amable Pronto nos vemos'), 'R-cortesia:cortesia', 'D2');
});
await caso('D3 «al ratito paso por mi pedido» NO es un acuse', () => {
  assert.equal(R.esAcuse('al ratito paso por mi pedido'), false);
  assert.equal(R.esAcuse('Hasta luego'), true);
  assert.equal(R.esAcuse('ya vi la dirección, gracias'), true);
});

console.log('\n── E. Estado y pedido');
await caso('E1 «Ya fue recogido?» con su pedido → el estado', async () => {
  const d = await decidir('Ya fue recogido?', { estado: confirmado(),
    lectores: { estadoOperativo: { estado: 'en_preparacion', modalidad: 'entrega a domicilio' } } });
  assert.equal(d.recepcion.paso, 'R8', `obtenido ${ruta(d)}`);
});
await caso('E2 «Muy bien ahorita realizo mi pedido» → el formulario', async () => {
  exigir(await decidir('Muy bien ahorita realizo mi pedido'), 'R10:pedir', 'E2');
});

console.log(`\nfase-recepcion-dudas-acuna: ${pasadas} ok, ${fallidas} fallas`);
if (fallidas) process.exitCode = 1;
