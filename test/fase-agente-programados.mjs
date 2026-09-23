// ─── UN PEDIDO PARA OTRO DÍA ──────────────────────────────────────────────
//
// Requisito del dueño (23-sep-2026): «lo toma, pero es necesario que lo
// imprima al día siguiente, 1 hora antes de la entrega».
//
// La segunda mitad ya existía: `obtenerPedidosPorActivar()` selecciona
// `programado_para <= NOW() + INTERVAL '1 hour'`, y activar un programado es
// meterlo en el panel y auto-imprimirlo. Lo que faltaba era que el agente
// supiera fijar la fecha — y que no pudiera registrar uno para mañana como si
// fuera de hoy.
//
// Suite pura: sin Postgres, sin puertos, sin modelo.
import assert from 'node:assert/strict';
import { NOMBRES, validarArgumentos } from '../src/mesero-agente/contratoDeHerramientas.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { transicionLegal, CONFIRMADO, ARMANDO } from '../src/mesero-agente/maquinaDeEstados.js';
import { validarProgramado, diaDeLaSemana, diasQueAbre } from '../src/mesero-agente/programadoDelAgente.js';
import { ordenDesdeElCarrito } from '../src/mesero-agente/canalDelAgente.js';
import { resumenDelPedido, huellaDelResumen } from '../src/mesero-whatsapp/resumenDelPedido.js';

let pasadas = 0;
const fallos = [];
const t = async (nombre, fn) => {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

// El horario real de Mapolato Obispado.
const REGLAS = {
  horarios: {
    lunes: { abierto: true, apertura: '07:30', cierre: '14:45' },
    martes: { abierto: true, apertura: '07:30', cierre: '14:45' },
    miercoles: { abierto: true, apertura: '07:30', cierre: '14:45' },
    jueves: { abierto: true, apertura: '07:00', cierre: '14:45' },
    viernes: { abierto: true, apertura: '07:30', cierre: '22:00' },
    sabado: { abierto: true, apertura: '07:30', cierre: '14:45' },
    domingo: { abierto: false, apertura: '07:30', cierre: '14:30' },
  },
  pedidos: { tiempo_preparacion_minutos: 25 },
};
// Miércoles 23-sep-2026, 13:00 hora local de Piedras Negras (UTC-5 en verano).
const AHORA = new Date('2026-09-23T18:00:00Z');

const CARTA = [{ id: 1, nombre: 'Desayunos', productos: [
  { id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, orden: 0, modificadores: [] },
] }];
const nuevo = () => estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
const ejecutorDe = (estado, mensaje) => crearEjecutor({
  estado, catalogo: CARTA, precios: { Hotcakes: 95 }, mensaje, textoCiclo: mensaje, reglas: REGLAS,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El modelo interpreta, Xabor valida ──');

await t('A1 · la herramienta exige formato estricto: nada de texto libre', () => {
  assert.ok(NOMBRES.includes('programar_para'));
  assert.equal(validarArgumentos('programar_para', { fecha: '2026-09-24', hora: '10:00' }).ok, true);
  for (const malo of [
    { fecha: 'mañana', hora: '10:00' },
    { fecha: '24/09/2026', hora: '10:00' },
    { fecha: '2026-09-24', hora: '10am' },
    { fecha: '2026-09-24', hora: '25:00' },
    { fecha: '2026-09-24' },
    { fecha: '2026-09-24', hora: '10:00', nota: 'porfa' },
  ]) {
    assert.equal(validarArgumentos('programar_para', malo).ok, false,
      `aceptó ${JSON.stringify(malo)}`);
  }
});

await t('A2 · el día de la semana no se mueve con la zona', () => {
  assert.equal(diaDeLaSemana('2026-09-24'), 'jueves');
  assert.equal(diaDeLaSemana('2026-09-27'), 'domingo');
  assert.equal(diaDeLaSemana('no-es-fecha'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Lo que Xabor NO delega: la decisión ──');

const val = (fecha, hora) => validarProgramado({ fecha, hora, reglas: REGLAS, ahora: AHORA });

await t('B1 · mañana jueves a las 10 se acepta', () => {
  const r = val('2026-09-24', '10:00');
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.dia, 'jueves');
  // 10:00 local (UTC-5) son las 15:00Z.
  assert.equal(r.iso, '2026-09-24T15:00:00.000Z');
});

await t('B2 · un día que el negocio no abre se rechaza, y se ofrecen los que sí', () => {
  const r = val('2026-09-27', '10:00');   // domingo
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'cerrado_ese_dia');
  assert.match(r.mensaje, /lunes/);
  assert.ok(!/domingo,/.test(diasQueAbre(REGLAS).join(', ')), 'ofreció el domingo, que está cerrado');
});

await t('B3 · fuera del horario de ESE día, con las horas de ese día', () => {
  const jueves = val('2026-09-24', '16:00');
  assert.equal(jueves.motivo, 'fuera_de_horario');
  assert.match(jueves.mensaje, /07:00 a 14:45/, 'dio el horario de otro día');
  // El viernes cierra a las 22:00, así que las 21:00 sí entran.
  assert.equal(val('2026-09-25', '21:00').ok, true, 'el viernes largo se rechazó');
});

await t('B4 · una hora que ya pasó, y una demasiado pronta, se distinguen', () => {
  assert.equal(val('2026-09-23', '12:50').motivo, 'pasada');
  const pronto = val('2026-09-23', '13:10');
  assert.equal(pronto.motivo, 'muy_pronto');
  assert.match(pronto.mensaje, /25 minutos/);
  assert.equal(val('2026-09-23', '13:40').ok, true);
});

await t('B5 · demasiado lejos, y una fecha que no existe', () => {
  assert.equal(val('2026-12-01', '10:00').motivo, 'muy_lejos');
  assert.equal(val('2026-02-31', '10:00').motivo, 'fecha_invalida');
});

await t('B6 · cada rechazo dice qué hacer, no solo que no', () => {
  for (const [f, h] of [['2026-09-27', '10:00'], ['2026-09-24', '16:00'],
    ['2026-09-23', '12:50'], ['2026-09-23', '13:10'], ['2026-12-01', '10:00']]) {
    const r = val(f, h);
    assert.equal(r.ok, false);
    assert.match(r.mensaje, /Ofrécele|Pregúntale|Dile|Pásalo/,
      `«${r.motivo}» no le dice al modelo qué hacer: ${r.mensaje}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. La herramienta sobre el pedido ──');

await t('C1 · fijar la fecha la deja en el pedido y la cuenta en palabras', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const r = await ejecutorDe(estado, 'para mañana a las 10')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
  assert.equal(r.aplicado, true, r.motivo);
  assert.equal(estado.carrito.datos.programado_para, '2026-09-24T15:00:00.000Z');
  assert.match(r.nota, /jueves a las 10:00/);
  assert.match(r.nota, /una hora antes, no ahora/i, 'no deja claro que la comanda no sale ya');
});

await t('C2 · un rechazo NO deja fecha a medias en el pedido', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const r = await ejecutorDe(estado, 'para el domingo')
    .ejecutar('programar_para', { fecha: '2026-09-27', hora: '10:00' });
  assert.equal(r.aplicado, false);
  assert.equal(estado.carrito.datos.programado_para, undefined,
    'guardó una fecha que había rechazado');
});

await t('C3 · con el pedido confirmado ya no se cambia el día', () => {
  assert.equal(transicionLegal('programar_para', ARMANDO).legal, true);
  assert.equal(transicionLegal('programar_para', CONFIRMADO).legal, false,
    'cocina ya lo tiene apuntado: cambiarlo aquí lo movería a espaldas de nadie');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── D. La fecha viaja hasta el pedido, y hasta la huella ──');

await t('D1 · el mismo pedido para hoy y para mañana NO tiene la misma huella', () => {
  const carrito = (extra) => ({
    items: [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [], notas: '' }],
    datos: { modalidad: 'recoger', forma_pago: 'efectivo', ...extra },
  });
  const hoy = resumenDelPedido(carrito({}), { precios: { Hotcakes: 95 } });
  const manana = resumenDelPedido(carrito({ programado_para: '2026-09-24T15:00:00.000Z' }),
    { precios: { Hotcakes: 95 } });
  assert.equal(manana.programado_para, '2026-09-24T15:00:00.000Z');
  assert.notEqual(huellaDelResumen(hoy), huellaDelResumen(manana),
    'el cliente podría confirmar «para hoy» y acabar con un pedido de mañana, o al revés');
});

await t('D2 · la orden que se registra lleva la fecha', () => {
  const orden = ordenDesdeElCarrito({
    negocioId: 'n1', telefono: '5218787899919', nombre: 'Mario',
    carrito: { items: [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }],
      datos: { modalidad: 'recoger', forma_pago: 'efectivo',
        programado_para: '2026-09-24T15:00:00.000Z' } },
  });
  assert.equal(orden.programado_para, '2026-09-24T15:00:00.000Z');
  // Y sin fecha, la clave ni siquiera aparece: un pedido normal no debe
  // llevar `programado_para: null` y arriesgarse a que algo lo interprete.
  const normal = ordenDesdeElCarrito({
    negocioId: 'n1', telefono: '52', carrito: { items: [], datos: {} } });
  assert.ok(!('programado_para' in normal));
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
