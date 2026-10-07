import assert from 'node:assert/strict';
import { decidirRecepcion, modoIA, clasificarIntencion } from '../src/mesero-agente/recepcionista.js';
import { obtenerEstadoRestaurante } from '../src/agent/prompts.js';
import { siguienteApertura } from '../src/mesero-agente/horarioDelAgente.js';
import { buscarProductos } from '../src/mesero-whatsapp/consultasDelMenu.js';
import { esListaDeOrdenEscrita } from '../src/mesero-agente/listaDeOrdenEscrita.js';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';

Object.assign(process.env, { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true',
  WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: 'local', META_APP_SECRET: 'local' });
const ahora = Date.parse('2026-10-05T17:00:00Z');
const cfg = { ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true',
  whatsapp_interactivos_elecciones_v1: 'true', whatsapp_rescate_humano_v1: 'true',
  whatsapp_beta_hibrido_v1: 'true', whatsapp_eventos_formulario_v1: 'true', whatsapp_flow_evento_id: '77777777777',
  whatsapp_ia_modo_v1: 'formulario', whatsapp_ia_modo_alcance: 'todos' };
const reglas = { ...F.reglas, timezone: 'UTC', cierres_especiales: [],
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map(d => [d, { abierto: true, apertura: '07:30', cierre: '15:00' }])) };
const tienda = { estado: 'publicada', aceptaProgramados: true, slug: 'prueba-local' };
const orden = 'Voy a pedir:\n2 chilaquiles mixtos con pollo y salsa roja\n1 café americano\nPara recoger, pago en efectivo';
const vacio = () => F.estado({ pendiente: null });
const cerradoReciente = () => Object.assign(vacio(), {
  recepcion: { ultimo: 'cerrado', en: '2026-10-05T16:45:00Z' } });
async function decidir(mensaje, { estado = vacio(), abierto = false, configTienda = tienda, lectores = {}, entradas } = {}) {
  const antes = JSON.stringify(estado);
  const r = await decidirRecepcion({ ia: modoIA(cfg, F.TELEFONO), cfg, reglas, estado, mensaje,
    catalogo: F.carta(), modalidades: F.modalidades, metodosPago: F.metodosPago, configTienda,
    estadoRestaurante: obtenerEstadoRestaurante(reglas, new Date(abierto ? '2026-10-05T10:00:00Z' : ahora)),
    negocioId: 'local', telefono: F.TELEFONO, ahora, lectores, entradas });
  assert.equal(JSON.stringify(estado), antes, 'clasificar o contestar no cambia el pedido');
  assert.deepEqual(r.respuesta?.acciones ?? [], [], 'el texto no concede efectos comerciales');
  return r;
}
let pasadas = 0, fallidas = 0;
async function caso(nombre, fn) {
  try { await fn(); pasadas++; console.log(`OK ${nombre}`); }
  catch (e) { fallidas++; console.error(`FALLO ${nombre}: ${e.message}`); }
}

await caso('orden completa con prefacio recibe acuse específico y formulario', async () => {
  const r = await decidir(orden, { abierto: true });
  assert.equal(r.ruta, 'formulario');
  assert.equal(r.tipo, 'pedido_escrito');
  assert.match(r.respuesta.texto, /recibimos.*pedido/i);
  assert.match(r.respuesta.texto, /no est[aá] registrado/i);
  assert.match(r.respuesta.texto, /confirmar/i);
});
for (const [nombre, mensaje] of [
  ['lista con nombres ajenos al catálogo', '2 bagels de salmón\n1 limonada de pepino'],
  ['lista con viñetas y multiplicación', 'Mi orden:\n• 2x bagels de salmón\n- 1 × limonada de pepino'],
  ['lista con cantidades escritas', 'dos bagels de salmón\nuna limonada de pepino'],
  ['un solo platillo fuera del catálogo', '2 bagels de salmón'],
  ['lista larga', `2 bagels de salmón con ${'ingredientes adicionales '.repeat(30)}\n1 limonada de pepino`],
  ['lista con petición de menú', 'Pásame el menú también\n2 bagels de salmón\n1 limonada de pepino'],
]) {
  await caso(`orden completa ${nombre} recibe acuse y formulario`, async () => {
    assert.equal(buscarProductos(F.carta(), mensaje).length, 0, 'la prueba requiere nombres fuera del catálogo');
    const r = await decidir(mensaje, { abierto: true });
    assert.equal(r.ruta, 'formulario');
    assert.equal(r.tipo, 'pedido_escrito');
    assert.match(r.respuesta.texto, /no está registrado/);
    assert.doesNotMatch(r.respuesta.texto, /no te entendí|ya agregué|no tenemos/i);
  });
}
await caso('orden sin nombres del catálogo también recibe acuse de cierre', async () => {
  const r = await decidir('2 bagels de salmón\n1 limonada de pepino', { estado: cerradoReciente() });
  assert.match(r.respuesta.texto, /no confirma/);
});
for (const mensaje of ['¿Tienen esto?\n2 bagels\n1 limonada', 'Esta fue mi orden ayer:\n2 bagels\n1 limonada',
  '2 transferencias\n1 comprobante', '2 calle Norte\n1 colonia Centro', 'No quiero pedir:\n2 bagels\n1 limonada',
  '2 días', '10 pesos', '1 minuto', 'una cosa más', 'una pregunta', '2 detalles', '2 bagels, cuánto cuesta?']) {
  await caso(`consulta, datos o historial no son orden nueva: ${mensaje.split('\n')[0]}`, () => {
    assert.equal(esListaDeOrdenEscrita(mensaje), false);
  });
}
await caso('duda de pago junto a orden abierta se contesta dentro del formulario', async () => {
  const r = await decidir(`${orden}\n¿Aceptan efectivo?`, { abierto: true });
  assert.equal(r.ruta, 'formulario');
  assert.match(r.formulario.aviso, /Formas de pago/);
  assert.match(r.formulario.aviso, /Efectivo/i);
  assert.match(r.formulario.aviso, /no está registrado/);
});
await caso('lista y duda con carrito conserva la respuesta y el borrador', async () => {
  const r = await decidir('2 bagels\n1 limonada\n¿Aceptan efectivo?', { abierto: true, estado: F.estado({ items: 'dos' }) });
  assert.equal(r.ruta, 'formulario');
  assert.equal(r.tipo, 'cambiar');
  assert.match(r.formulario.aviso, /Formas de pago/);
  assert.equal(r.respuesta.pendiente.tipo, 'editar_pedido');
});
await caso('información larga se conserva completa sin crear un formulario que exceda el límite', async () => {
  const informacion = '*Formas de pago*\n' + 'Instrucciones aprobadas para esta prueba. '.repeat(22);
  const r = await decidir(`${orden}\n¿Aceptan efectivo?`, { abierto: true,
    entradas: [{ id: 'pagos', origen: 'config', texto: informacion }] });
  assert.equal(r.ruta, 'respuesta');
  assert.equal(r.formulario, null);
  assert(r.respuesta.texto.includes(informacion));
  assert.equal(r.respuesta.pendiente.tipo, 'recepcion');
  assert.match(r.respuesta.texto, /hablar con alguien/);
  assert.doesNotMatch(r.respuesta.texto, /este formulario|elige tus platillos/i);
});
await caso('pregunta de disponibilidad sigue siendo una consulta', () => {
  assert.equal(clasificarIntencion({ mensaje: '¿Tienen chilaquiles sin pollo?', estado: vacio(), catalogo: F.carta() }), null);
  assert.equal(clasificarIntencion({ mensaje: '2 cafés, cuánto cuesta?', estado: vacio(), catalogo: F.carta() }), null);
});
await caso('orden escrita después del aviso de cierre no desaparece', async () => {
  const r = await decidir(orden, { estado: cerradoReciente() });
  assert.equal(r.ruta, 'cerrado');
  assert.match(r.respuesta.texto, /no (?:confirma|registra)/i);
  assert.match(r.respuesta.texto, /mañana.*7:30/);
  assert.match(r.respuesta.texto, /\/t\/prueba-local/);
  assert.equal(r.formulario, null);
});
await caso('nueva duda sin respuesta fija tampoco se silencia por haber avisado el cierre', async () => {
  const r = await decidir('¿Me pueden orientar sobre una entrega especial?', { estado: cerradoReciente() });
  assert.equal(r.ruta, 'cerrado');
  assert.match(r.respuesta.texto, /cerrados/);
});
await caso('saludo repetido conserva el silencio para evitar avisos duplicados', async () => {
  assert.equal((await decidir('hola', { estado: cerradoReciente() })).ruta, 'silencio');
});
await caso('cerrado no ofrece programación si la tienda no la admite', async () => {
  const r = await decidir(orden, { configTienda: { ...tienda, aceptaProgramados: false } });
  assert.doesNotMatch(r.respuesta.texto, /\/t\/|agend/);
  assert.match(r.respuesta.texto, /no (?:confirma|registra)/i);
});
await caso('cerrado no confirma un resumen anterior', async () => {
  const estado = F.estado({ pendiente: { tipo: 'confirmar_resumen', huella: 'local' }, items: 'dos' });
  const r = await decidir('sí', { estado });
  assert.equal(r.ruta, 'cerrado');
  assert.equal(r.formulario, null);
});
await caso('primera consulta de pago también informa cierre y próxima apertura', async () => {
  const r = await decidir('¿Cómo puedo pagar?');
  assert.equal(r.ruta, 'respuesta');
  assert.match(r.respuesta.texto, /cerrados.*mañana.*7:30/);
  assert.match(r.respuesta.texto, /efectivo/i);
  assert.equal(r.formulario, null);
});
await caso('orden completa con duda de pago no pierde el acuse al estar cerrado', async () => {
  const r = await decidir(`${orden}\n¿Qué es el enlace de pago?`, { estado: cerradoReciente() });
  assert.equal(r.ruta, 'cerrado');
  assert.match(r.respuesta.texto, /no confirma/);
  assert.match(r.respuesta.texto, /Formas de pago/);
});
await caso('pedido activo conserva su seguimiento aun con el negocio cerrado', async () => {
  const r = await decidir('¿Cómo va mi pedido?', { lectores: { pedidosActivos: async () => [
    { folio: 'XAB-1001', estado: 'en_preparacion', modalidad: 'recoger en tienda' } ] } });
  assert.equal(r.tipo, 'estado_telefono');
  assert.match(r.respuesta.texto, /XAB-1001/);
  assert.doesNotMatch(r.respuesta.texto, /ya va en camino/);
  assert.equal(r.formulario, null);
});
await caso('seguimiento tras aviso de cierre no se pierde', async () => {
  const r = await decidir('¿Cómo va mi pedido?', { estado: cerradoReciente(), lectores: { pedidosActivos: async () => [
    { folio: 'XAB-1002', estado: 'listo', modalidad: 'recoger en tienda' } ] } });
  assert.match(r.respuesta.texto, /XAB-1002/);
  assert.equal(r.ruta, 'respuesta');
});
await caso('fallo al consultar un pedido cerrado necesita revisión humana', async () => {
  const r = await decidir('Ya hice mi pedido en la página', { lectores: { pedidosActivos: async () => { throw Error('local'); } } });
  assert.equal(r.ruta, 'persona');
  assert.doesNotMatch(r.respuesta.texto, /no veo tu pedido|en un momento/i);
});
await caso('antes de abrir con cierre anticipado informa la apertura de hoy', () => {
  const r = { ...reglas, cierres_especiales: [{ fecha: '2026-10-05', hora_cierre: '12:00', motivo: 'local' }] };
  const e = obtenerEstadoRestaurante(r, new Date('2026-10-05T06:00:00Z'));
  assert.equal(siguienteApertura(r, e)?.diasHasta, 0);
});
await caso('un cierre especial que impide abrir no se anuncia como apertura', () => {
  const r = { ...reglas, cierres_especiales: [{ fecha: '2026-10-06', hora_cierre: '06:00', motivo: 'local' }] };
  const e = obtenerEstadoRestaurante(r, new Date(ahora));
  assert.equal(siguienteApertura(r, e)?.diasHasta, 2);
});
await caso('horarios inválidos no impiden encontrar una apertura válida posterior', () => {
  const r = { ...reglas, horarios: { ...reglas.horarios, martes: { abierto: true, apertura: '99:00', cierre: '15:00' } } };
  const e = obtenerEstadoRestaurante(r, new Date(ahora));
  assert.equal(siguienteApertura(r, e)?.diasHasta, 2);
});
console.log(`RECEPCION PRIORIDADES: ${pasadas} correctas, ${fallidas} fallidas`);
process.exitCode = fallidas ? 1 : 0;
