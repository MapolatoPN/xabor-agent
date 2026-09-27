// ─── EL ESTADO CANÓNICO DEL PEDIDO, SIN BASE NI RED ───────────────────────
//
// Las piezas puras de la consolidación: la fase deducida, la pregunta
// pendiente (su único escritor y su conteo de repreguntas), la actualización
// de filas viejas, la validación antes de persistir, las respuestas cortas
// contra el pendiente, la emisión segura, el sellado de la respuesta, la
// identidad del turno y el filtro de la carta publicada. Y dos del bucle: el
// modelo no puede llamar acciones de sistema, y la misma pregunta sin avance
// pasa a una persona a la tercera.
//
// El recorrido completo con Postgres está en fase-pedido-canonico-db.mjs.
import assert from 'node:assert/strict';
import {
  FASES, PENDIENTES, LIMITE_REPREGUNTAS, derivarFase, fijarPendiente, normalizarEstado,
  violacionesDelEstado, sellarEstado, pendienteDesdeFoco, ESQUEMA_ESTADO,
} from '../src/mesero-agente/estadoCanonico.js';
import { interpretarRespuestaCorta, numeroSolo } from '../src/mesero-agente/respuestaCorta.js';
import { revisarRedaccion, importesMencionados } from '../src/mesero-agente/emisionSegura.js';
import { sellarRespuesta, resumenConPromociones } from '../src/mesero-agente/canalDelAgente.js';
import { claveDeTurno, claveDeRespuesta, claveDeSesion } from '../src/mesero-agente/persistenciaDelTurno.js';
import { filtrarMenuPublicadoEnWhatsapp, nombresOcultosDe } from '../src/services/catalogoWhatsapp.js';
import { definicionesParaElModelo, esAccionDeSistema } from '../src/mesero-agente/contratoDeHerramientas.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnMemoria } from '../src/mesero-agente/libroDeOperaciones.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';

let pasadas = 0;
const fallos = [];
// CASOS=P2,B2 corre solo esos (para las pruebas de mordida).
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const nuevo = () => normalizarEstado(estadoNuevo({ negocioId: 'n1', conversacionId: 'agente:5281000000' }));
const linea = (lid, nombre = 'Waffle') => ({ lid, nombre, cantidad: 1, modificadores: [] });
const pedidoCon = (extra = {}) => ({ lineas: [{ linea_id: 'l1' }], falta: [], aclaraciones: [], huella: 'h1', ...extra });

// ═══ LA FASE SE DEDUCE, NO SE ESCRIBE A MANO ══════════════════════════════
await t('F1 cada fase sale del estado y de la vista del pedido real', async () => {
  const e = nuevo();
  assert.equal(derivarFase(e, { lineas: [] }), FASES.SELECCIONANDO_PRODUCTOS);
  assert.equal(derivarFase(e, pedidoCon({ aclaraciones: [{ lid: 'l1', grupo: 'Salsa' }] })), FASES.COMPLETANDO_OPCIONES);
  assert.equal(derivarFase(e, pedidoCon({ falta: ['grupo:Salsa'] })), FASES.COMPLETANDO_OPCIONES);
  assert.equal(derivarFase(e, pedidoCon({ falta: ['modalidad', 'pago'] })), FASES.DEFINIENDO_ENTREGA);
  assert.equal(derivarFase(e, pedidoCon({ falta: ['direccion'] })), FASES.DEFINIENDO_ENTREGA);
  assert.equal(derivarFase(e, pedidoCon({ falta: ['programacion'] })), FASES.DEFINIENDO_ENTREGA);
  assert.equal(derivarFase(e, pedidoCon({ falta: ['pago'] })), FASES.DEFINIENDO_PAGO);
  assert.equal(derivarFase(e, pedidoCon()), FASES.ESPERANDO_CONFIRMACION);
  assert.equal(derivarFase({ ...e, evento: { personas: 20 } }, { lineas: [] }), FASES.CAPTURANDO_EVENTO);
  for (const [hecho, fase] of [['confirmado', FASES.CONFIRMADO], ['cancelado', FASES.CANCELADO],
    ['escalado', FASES.REQUIERE_HUMANO], ['fallido', FASES.REQUIERE_HUMANO]]) {
    assert.equal(derivarFase({ ...e, hechos: { ...e.hechos, [hecho]: true } }, pedidoCon()), fase, hecho);
  }
  assert.equal(derivarFase({ ...e, confirmacionIncierta: true }, pedidoCon()), FASES.REQUIERE_HUMANO);
});

// ═══ LA PREGUNTA PENDIENTE: UN SOLO ESCRITOR ══════════════════════════════
await t('P1 fijarPendiente valida el esquema y proyecta el foco', async () => {
  const e = nuevo();
  assert.throws(() => fijarPendiente(e, { tipo: 'confirmar_resumen' }), /pendiente_invalido/);
  assert.throws(() => fijarPendiente(e, { tipo: 'aceptar_promocion', promocion_id: '1', promocion: 'x',
    producto_id: '2', producto: 'y', cantidad: 0 }), /pendiente_invalido/, 'una promoción de 0 unidades');
  assert.throws(() => fijarPendiente(e, { tipo: 'inventado' }), /pendiente_invalido/);
  fijarPendiente(e, { tipo: PENDIENTES.ELEGIR_OPCION, linea_id: 'l1', grupo: 'Salsa', candidatos: ['Verde'] });
  assert.deepEqual(e.foco, { tipo: 'opcion', linea_id: 'l1', grupo: 'Salsa' });
  fijarPendiente(e, { tipo: PENDIENTES.PAGO, opciones: ['efectivo'] });
  assert.deepEqual(e.foco, { tipo: 'pago' });
  fijarPendiente(e, { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: 'h' });
  assert.equal(e.foco, null, 'un resumen no es una pregunta de opción');
  fijarPendiente(e, null);
  assert.equal(e.pendiente, null);
  assert.equal(e.foco, null);
});

await t('P2 la MISMA pregunta sin avance cuenta intentos; con avance o distinta, vuelve a 1', async () => {
  const e = nuevo();
  const opcion = { tipo: PENDIENTES.ELEGIR_OPCION, linea_id: 'l1', grupo: 'Salsa' };
  assert.equal(fijarPendiente(e, opcion).intentos, 1);
  assert.equal(fijarPendiente(e, opcion).intentos, 2);
  assert.equal(fijarPendiente(e, opcion, { avance: true }).intentos, 1, 'con avance no es ambigüedad');
  assert.equal(fijarPendiente(e, opcion).intentos, 2);
  assert.equal(fijarPendiente(e, { ...opcion, grupo: 'Proteína' }).intentos, 1, 'otra pregunta');
  assert.equal(fijarPendiente(e, { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: 'a' }).intentos, 1);
  assert.equal(fijarPendiente(e, { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: 'b' }).intentos, 1,
    'un resumen con otra huella es otra pregunta');
});

await t('P3 pendienteDesdeFoco arma la pregunta con lo que se ofreció', async () => {
  const pedido = { aclaraciones: [{ lid: 'l1', grupo: 'Salsa', producto: 'Chilaquiles', candidatos: ['Verde', 'Roja'],
    minimo: 1, maximo: 1 }] };
  assert.deepEqual(pendienteDesdeFoco({ tipo: 'opcion', linea_id: 'l1', grupo: 'salsa' }, pedido), {
    tipo: 'elegir_opcion', linea_id: 'l1', grupo: 'salsa', producto: 'Chilaquiles', candidatos: ['Verde', 'Roja'],
    minimo: 1, maximo: 1 });
  assert.deepEqual(pendienteDesdeFoco({ tipo: 'modalidad' }, null, { opcionesModalidad: ['recoger en tienda'] }),
    { tipo: 'modalidad', opciones: ['recoger en tienda'] });
  assert.deepEqual(pendienteDesdeFoco({ tipo: 'direccion' }, null), { tipo: 'direccion' });
  assert.equal(pendienteDesdeFoco(null, null), null);
});

// ═══ FILAS VIEJAS: SE ACTUALIZAN SIN INVENTAR AUTORIZACIONES ═════════════
await t('N1 una fila anterior se lleva al esquema 2; lo inferido se descarta', async () => {
  const vieja = {
    conversacionId: 'agente:1', carrito: { items: [linea('l1')], datos: {} }, hechos: { confirmado: false },
    dialogo: { id: 'd1', tipo: 'resumen', huella: 'h9', enviado: true },
    ofrecidos: [{ id: 5, nombre: 'Café' }], ofertaPromocionPendiente: { promocion_id: 3 }, pagoOfrecido: null,
  };
  normalizarEstado(vieja);
  assert.equal(vieja.esquema, ESQUEMA_ESTADO);
  assert.equal(vieja.pendiente.tipo, 'confirmar_resumen');
  assert.equal(vieja.pendiente.huella, 'h9');
  assert.equal(vieja.pendiente.dialogo_id, 'd1');
  assert.equal(vieja.ofrecidos, undefined, 'una búsqueda vieja no autoriza un «sí»');
  assert.equal(vieja.ofertaPromocionPendiente, undefined, 'una oferta sin cantidad por tipo no se hereda');
  const copia = JSON.stringify(vieja);
  normalizarEstado(vieja);
  assert.equal(JSON.stringify(vieja), copia, 'normalizar no es idempotente');
  const conPago = normalizarEstado({ carrito: { items: [linea('l1')], datos: {} }, pagoOfrecido: 'enlace_pago' });
  assert.deepEqual([conPago.pendiente.tipo, conPago.pendiente.forma_pago], ['aceptar_pago_ofrecido', 'enlace_pago']);
  assert.equal(conPago.pagoOfrecido, undefined);
});

// ═══ ANTES DE PERSISTIR ═══════════════════════════════════════════════════
await t('V1 las invariantes que no pueden llegar a la base', async () => {
  const e = nuevo();
  e.carrito.items = [linea('l1')];
  const pedido = pedidoCon({ huella: 'h1' });
  e.fase = derivarFase(e, pedido);
  assert.deepEqual(violacionesDelEstado(e, pedido), []);
  const confirmadoSinFolio = { ...structuredClone(e), hechos: { ...e.hechos, confirmado: true }, fase: FASES.CONFIRMADO };
  assert.ok(violacionesDelEstado(confirmadoSinFolio, pedido).includes('confirmado_sin_folio'));
  const resumenViejo = structuredClone(e);
  fijarPendiente(resumenViejo, { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: 'otra' });
  assert.ok(violacionesDelEstado(resumenViejo, pedido).includes('resumen_pendiente_no_vigente'));
  const opcionHuerfana = structuredClone(e);
  fijarPendiente(opcionHuerfana, { tipo: PENDIENTES.ELEGIR_OPCION, linea_id: 'l9', grupo: 'Salsa' });
  assert.ok(violacionesDelEstado(opcionHuerfana, pedido).includes('opcion_pendiente_sin_renglon'));
  const faseMentida = { ...structuredClone(e), fase: FASES.CONFIRMADO };
  assert.ok(violacionesDelEstado(faseMentida, pedido).some((f) => f.startsWith('fase:')));
});

await t('V2 sellarEstado cierra la pregunta de un terminal y rechaza lo inválido', async () => {
  const e = nuevo();
  e.carrito.items = [linea('l1')];
  fijarPendiente(e, { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: 'h1' });
  e.hechos.confirmado = true;
  e.folio = 'XAB-1';
  sellarEstado(e, pedidoCon());
  assert.equal(e.fase, FASES.CONFIRMADO);
  assert.equal(e.pendiente, null, 'un pedido confirmado dejó un «sí» abierto');
  const sinFolio = nuevo();
  sinFolio.carrito.items = [linea('l1')];
  sinFolio.hechos.confirmado = true;
  assert.throws(() => sellarEstado(sinFolio, pedidoCon()), /confirmado_sin_folio/);
});

// ═══ RESPUESTAS CORTAS CONTRA EL PENDIENTE ════════════════════════════════
const conPendiente = (p) => { const e = nuevo(); e.carrito.items = [linea('l1')]; fijarPendiente(e, p); return e; };
const MODALIDADES = ['recoger en tienda', 'entrega a domicilio'];
const PAGOS = [{ tipo: 'efectivo' }, { tipo: 'terminal' }];

await t('R1 «sí» confirma SOLO el resumen pendiente, con su huella; «no», «sí pero…» y preguntas no', async () => {
  const e = conPendiente({ tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: 'h7' });
  assert.deepEqual(interpretarRespuestaCorta({ estado: e, mensaje: 'sí' })?.accion?.argumentos, { huella_resumen: 'h7' });
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'no' })?.rechazo, 'resumen');
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'sí pero sin cebolla' }), null);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: '¿sí incluye bebida?' }), null);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'sí\nagrega un café' }), null);
  assert.equal(interpretarRespuestaCorta({ estado: nuevo(), mensaje: 'sí' }), null, 'sin pendiente no hay nada que aceptar');
});

await t('R2 producto ofrecido: «dos» son dos, «esa» es una, «no» lo rechaza', async () => {
  const e = conPendiente({ tipo: PENDIENTES.ACEPTAR_PRODUCTO, producto_id: '21', producto: 'Coca Cola' });
  const dos = interpretarRespuestaCorta({ estado: e, mensaje: 'dos' }).accion;
  assert.deepEqual([dos.herramienta, dos.argumentos.cantidad, dos.autorizacion.cantidad], ['agregar_producto', 2, 2]);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'esa' }).accion.argumentos.cantidad, 1);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'no gracias' })?.rechazo, 'producto');
  // Una pregunta nunca es una respuesta: «¿dos?» pregunta, no pide dos.
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: '¿dos?' }), null);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: '¿esa?' }), null);
  assert.equal(numeroSolo('dos'), 2);
  assert.equal(numeroSolo('dos cafés'), null, 'un número con producto no es una respuesta corta');
});

await t('R3 promoción: la cantidad la fija su tipo; otro número no la acepta', async () => {
  const e = conPendiente({ tipo: PENDIENTES.ACEPTAR_PROMOCION, promocion_id: '9', promocion: '2x1',
    producto_id: '85', producto: 'Chilaquiles', cantidad: 2 });
  const si = interpretarRespuestaCorta({ estado: e, mensaje: 'sí' }).accion;
  assert.deepEqual([si.argumentos.cantidad, si.autorizacion.tipo, si.autorizacion.promocion_id], [2, 'promocion', '9']);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'dos' }).accion.argumentos.cantidad, 2);
  assert.equal(interpretarRespuestaCorta({ estado: e, mensaje: 'tres' }), null);
});

await t('R4 modalidad, pago y opción por posición o por palabra de la lista ofrecida', async () => {
  const m = conPendiente({ tipo: PENDIENTES.MODALIDAD, opciones: MODALIDADES });
  assert.equal(interpretarRespuestaCorta({ estado: m, mensaje: 'la segunda', modalidades: MODALIDADES })
    .accion.argumentos.modalidad, 'entrega a domicilio');
  assert.equal(interpretarRespuestaCorta({ estado: m, mensaje: 'para recoger', modalidades: MODALIDADES })
    .accion.argumentos.modalidad, 'recoger en tienda');
  const p = conPendiente({ tipo: PENDIENTES.PAGO, opciones: ['efectivo', 'terminal'] });
  assert.equal(interpretarRespuestaCorta({ estado: p, mensaje: 'efectivo', metodosPago: PAGOS })
    .accion.argumentos.forma_pago, 'efectivo');
  assert.equal(interpretarRespuestaCorta({ estado: p, mensaje: 'la primera', metodosPago: PAGOS })
    .accion.argumentos.forma_pago, 'efectivo');
  assert.equal(interpretarRespuestaCorta({ estado: p, mensaje: 'efectivo y me traes cambio de 500', metodosPago: PAGOS }), null,
    'un mensaje con más que la respuesta lo interpreta el turno normal');
  const o = conPendiente({ tipo: PENDIENTES.ELEGIR_OPCION, linea_id: 'l1', grupo: 'Endulzante',
    candidatos: ['Azúcar', 'Miel', 'Sin endulzante'] });
  const segunda = interpretarRespuestaCorta({ estado: o, mensaje: 'la segunda' }).accion;
  assert.deepEqual(segunda.argumentos, { linea_id: 'l1', opciones: [{ grupo: 'Endulzante', opcion: 'Miel' }] });
  assert.equal(interpretarRespuestaCorta({ estado: o, mensaje: 'sin eso' }).accion.argumentos.opciones[0].opcion,
    'Sin endulzante');
});

// ═══ EMISIÓN SEGURA ═══════════════════════════════════════════════════════
const CARTA = [{ id: 1, nombre: 'Desayunos', productos: [
  { id: 10, nombre: 'Waffle', precio: 105 }, { id: 11, nombre: 'Café Americano', precio: 45 }] }];
await t('E1 lo que la prosa del modelo no puede decirle al cliente', async () => {
  const base = { estado: nuevo(), catalogo: CARTA, nombresOcultos: ['Pieza de Hotcake'] };
  const motivo = (texto, extra = {}) => revisarRedaccion({ ...base, ...extra, texto }).motivo || 'ok';
  assert.match(motivo('Usa buscar_producto para verlo.'), /^salida_interna/);
  assert.match(motivo('{"items":[{"nombre":"Waffle"}]}'), /^salida_interna/);
  assert.equal(motivo('También tenemos Pieza de Hotcake.'), 'producto_no_publicado');
  assert.equal(motivo('El Waffle cuesta $99.'), 'precio_no_verificado');
  assert.equal(motivo('Tu pedido quedó confirmado.'), 'confirmacion_no_registrada');
  assert.equal(motivo('Tu folio es XAB-1234.'), 'confirmacion_no_registrada');
  assert.equal(motivo('El Waffle cuesta $105 y el Café Americano $45.'), 'ok');
  assert.equal(motivo('Hola, ¿qué se te antoja?'), 'ok');
  const confirmado = nuevo(); confirmado.hechos.confirmado = true;
  assert.equal(motivo('Tu pedido quedó confirmado.', { estado: confirmado }), 'ok');
  assert.deepEqual(importesMencionados('son $1,250.50 o 300 pesos'), [1250.5, 300]);
});

// ═══ EL SELLADO DE LA RESPUESTA ═══════════════════════════════════════════
await t('S1 un anexo informativo conserva la pregunta; otro texto la retira; pendienteFinal manda', async () => {
  const preparar = () => {
    const e = nuevo(); e.carrito.items = [linea('l1')];
    fijarPendiente(e, { tipo: PENDIENTES.DIRECCION });
    e.dialogo = { id: 'd1', texto: '¿Cuál es la dirección completa para la entrega?', tipo: 'pregunta', enviado: false };
    return e;
  };
  let e = preparar();
  let salida = { dialogoId: 'd1', texto: '¿Cuál es la dirección completa para la entrega? El costo de envío es $30 MXN.' };
  sellarRespuesta(e, salida);
  assert.equal(e.pendiente?.tipo, 'direccion', 'el anexo del envío borró la pregunta de dirección');
  assert.equal(e.dialogo.texto, salida.texto, 'el diálogo no guarda el texto que de verdad sale');
  e = preparar();
  sellarRespuesta(e, { dialogoId: 'd1', texto: 'Permíteme un momento, te paso con alguien del equipo.' });
  assert.equal(e.pendiente, null, 'un texto distinto dejó viva una pregunta que no se hizo');
  e = preparar();
  sellarRespuesta(e, { dialogoId: 'd1', texto: '¿Cuál es la dirección? ¿Y a qué hora?' });
  assert.equal(e.pendiente, null, 'un anexo con otra pregunta cambia lo que se preguntó');
  e = preparar();
  sellarRespuesta(e, { dialogoId: 'd1', texto: 'Oferta', pendienteFinal: { tipo: PENDIENTES.ACEPTAR_PAGO_OFRECIDO, forma_pago: 'enlace_pago' } });
  assert.equal(e.pendiente?.tipo, 'aceptar_pago_ofrecido');
  e = preparar();
  sellarRespuesta(e, { dialogoId: 'otro', texto: 'x' });
  assert.equal(e.pendiente?.tipo, 'direccion', 'una salida de otro diálogo no toca este estado');
});

await t('S2 el total del resumen sale del motor cuando hay promociones; si no, no se toca', async () => {
  const resumen = 'Tu borrador contiene:\n2 × Chilaquiles: $195 c/u\nModalidad: recoger en tienda.\nTotal: $390.\n¿Confirmas este pedido?';
  const conPromo = resumenConPromociones(resumen, { total: 195, promociones: [{ nombre: '2x1 Chilaquiles', descuento: 195 }] });
  assert.equal(conPromo, 'Tu borrador contiene:\n2 × Chilaquiles: $195 c/u\nModalidad: recoger en tienda.\n'
    + 'Promoción 2x1 Chilaquiles: -$195.\nTotal: $195.\n¿Confirmas este pedido?');
  assert.equal(resumenConPromociones(resumen, { total: 390, promociones: [] }), null);
  assert.equal(resumenConPromociones(resumen, { total: 390, promociones: [{ nombre: 'x', descuento: 0 }] }), null);
  assert.equal(resumenConPromociones('¿Qué te gustaría pedir?', { total: 1, promociones: [{ nombre: 'x', descuento: 5 }] }), null,
    'solo se reescribe un resumen');
});

// ═══ IDENTIDAD DEL TURNO ══════════════════════════════════════════════════
await t('I1 el lote de wamids es la identidad del turno: sin orden, sin repetidos', async () => {
  assert.equal(claveDeTurno({ wamids: ['b', 'a'] }), claveDeTurno({ wamids: ['a', 'b', 'a'] }));
  assert.notEqual(claveDeTurno({ wamids: ['a'] }), claveDeTurno({ wamids: ['a', 'b'] }));
  assert.match(claveDeTurno({ wamids: ['a'] }), /^wa:[0-9a-f]{32}$/);
  assert.equal(claveDeTurno({ wamids: [], turnoId: 't-1' }), 't-1');
  assert.notEqual(claveDeTurno({}), claveDeTurno({}), 'sin wamids no puede haber dos turnos con la misma identidad');
  const s = claveDeSesion('5281');
  assert.equal(s, 'agente:5281');
  assert.equal(claveDeSesion('5281', { sombra: true }), 'agente-sombra:5281');
  assert.equal(claveDeRespuesta({ negocioId: 'n', sessionId: s, turnoClave: 'k' }),
    claveDeRespuesta({ negocioId: 'n', sessionId: s, turnoClave: 'k' }));
  assert.notEqual(claveDeRespuesta({ negocioId: 'n', sessionId: s, turnoClave: 'k' }),
    claveDeRespuesta({ negocioId: 'otro', sessionId: s, turnoClave: 'k' }));
});

// ═══ LA CARTA PUBLICADA ═══════════════════════════════════════════════════
await t('C1 solo lo publicado; categorías vacías fuera; el menú de entrada no se toca', async () => {
  const menu = [
    { id: 1, nombre: 'Desayunos', productos: [{ id: 10, nombre: 'Waffle' }, { id: 12, nombre: 'Pieza de Hotcake' }] },
    { id: 2, nombre: 'EXTRAS', productos: [{ id: 20, nombre: 'Extra Huevo' }] },
  ];
  const copia = JSON.stringify(menu);
  const carta = filtrarMenuPublicadoEnWhatsapp(menu, new Set([10]));
  assert.deepEqual(carta.map((c) => [c.nombre, c.productos.map((p) => p.nombre)]), [['Desayunos', ['Waffle']]]);
  assert.equal(JSON.stringify(menu), copia);
  assert.deepEqual(nombresOcultosDe(menu, carta), ['Pieza de Hotcake', 'Extra Huevo']);
  assert.deepEqual(filtrarMenuPublicadoEnWhatsapp(menu, []), [], 'sin publicados no hay carta');
  assert.deepEqual(filtrarMenuPublicadoEnWhatsapp(menu, ['10']).length, 1, 'los ids se comparan como número');
});

// ═══ EL BUCLE ═════════════════════════════════════════════════════════════
const CARTA_BUCLE = [{ id: 1, nombre: 'Desayunos', productos: [
  { id: 85, nombre: 'Chilaquiles', precio: 195, disponible: true, modificadores: [
    { nombre: 'Salsa', requerido: true, minimo: 1, maximo: 1,
      opciones: ['Verde', 'Roja'].map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })) }] },
  { id: 90, nombre: 'Waffle', precio: 105, disponible: true, modificadores: [] },
] }];
const PRECIOS_BUCLE = { Chilaquiles: 195, Waffle: 105 };
let nTurno = 0;
const turnoPuro = (estado, mensaje, llamarModelo, extra = {}) => atenderTurnoConHerramientas({
  negocioId: 'n1', conversacionId: estado.conversacionId, turnoId: `t${++nTurno}`, mensaje,
  catalogo: CARTA_BUCLE, precios: PRECIOS_BUCLE, requierePago: false, modalidades: ['recoger en tienda'],
  estado, libro: libroDeOperaciones(almacenEnMemoria()), llamarModelo, ...extra,
});
const texto = (t) => async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

await t('B1 el modelo no ve ni puede llamar una acción de sistema', async () => {
  assert.ok(!definicionesParaElModelo().some((h) => h.name === 'ofrecer_promocion'));
  assert.equal(esAccionDeSistema('ofrecer_promocion'), true);
  const e = nuevo();
  let n = 0;
  const modelo = async () => (n++ === 0
    ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x1', name: 'ofrecer_promocion', input: { promocion_id: '1' } }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: '¿Qué te gustaría pedir?' }] });
  const salida = await turnoPuro(e, 'hay promos?', modelo);
  const op = salida.operaciones.find((o) => o.herramienta === 'ofrecer_promocion');
  assert.equal(op?.resultado?.aplicado, false);
  assert.match(String(op?.resultado?.motivo), /herramienta_desconocida/);
  assert.notEqual(e.pendiente?.tipo, 'aceptar_promocion', 'el modelo se fabricó una oferta');
});

await t('B2 la misma pregunta sin avance pasa a una persona a la tercera, sin inventar nada', async () => {
  const e = nuevo();
  e.carrito.items = [{ lid: 'l1', id: 85, nombre: 'Chilaquiles', cantidad: 1, modificadores: [] }];
  const escalados = [];
  const efectos = { escalar: async () => { escalados.push(1); return { ok: true }; } };
  const salidas = [];
  for (let i = 0; i < LIMITE_REPREGUNTAS; i += 1) {
    salidas.push(await turnoPuro(e, 'mmm no sé', texto('Claro, te ayudo.'), { efectos }));
  }
  assert.equal(salidas[0].escalado ?? false, false);
  assert.equal(e.hechos.escalado, true, `no se escaló tras ${LIMITE_REPREGUNTAS} repreguntas`);
  assert.equal(escalados.length, 1);
  assert.match(String(salidas.at(-1).motivoHandoff || ''), /ambiguedad_persistente/);
  assert.equal(e.carrito.items.length, 1, 'escalar no toca el pedido');
});

await t('P19 un «sí» escrito ANTES del acuse del resumen no lo autoriza; uno de después, sí', async () => {
  const { autorizaConfirmacion, escritoAntesDelAcuse, fijarRecepcionDelTurno, guardarDialogo, acusarDialogo } =
    await import('../src/mesero-agente/contratoConversacional.js');
  const e = nuevo();
  const id = guardarDialogo(e, { mensaje: 'efectivo', texto: 'Resumen… ¿Confirmas este pedido?', tipo: 'resumen', huella: 'h9' });
  assert.equal(acusarDialogo(e, id, 'Resumen… ¿Confirmas este pedido?', { acusadoAt: '2026-09-27T10:00:05.000Z' }), true);
  assert.equal(e.dialogo.acusadoAt, '2026-09-27T10:00:05.000Z');
  fijarRecepcionDelTurno(e, '2026-09-27T10:00:02.000Z');
  assert.equal(escritoAntesDelAcuse(e), true);
  assert.equal(autorizaConfirmacion({ estado: e, mensaje: 'ok', huella: 'h9' }), false, 'un «ok» previo al acuse confirmó');
  fijarRecepcionDelTurno(e, '2026-09-27T10:00:09.000Z');
  assert.equal(autorizaConfirmacion({ estado: e, mensaje: 'ok', huella: 'h9' }), true, 'un «ok» posterior al acuse no confirmó');
  // La recepción del turno no viaja al estado persistido.
  assert.ok(!JSON.stringify(e).includes('recibidoTurno'));
  // Sin alguna de las dos horas no se afirma nada (transporte simulado, replays).
  const sinHora = nuevo();
  const id2 = guardarDialogo(sinHora, { mensaje: 'x', texto: 'R ¿Confirmas este pedido?', tipo: 'resumen', huella: 'h1' });
  acusarDialogo(sinHora, id2, 'R ¿Confirmas este pedido?');
  fijarRecepcionDelTurno(sinHora, '2026-09-27T10:00:02.000Z');
  assert.equal(escritoAntesDelAcuse(sinHora), false);
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`${pasadas} pasadas, ${fallos.length} fallidas de ${pasadas + fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
