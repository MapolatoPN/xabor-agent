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
import {
  crearEjecutor, estadoNuevo, estadoSerializable,
} from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { construirInstrucciones } from '../src/mesero-agente/instrucciones.js';
import { almacenEnMemoria, libroDeOperaciones } from '../src/mesero-agente/libroDeOperaciones.js';
import { transicionLegal, CONFIRMADO, ARMANDO } from '../src/mesero-agente/maquinaDeEstados.js';
import { validarProgramado, diaDeLaSemana, diasQueAbre } from '../src/mesero-agente/programadoDelAgente.js';
import {
  aplicarRespuestaDeConfirmacion, confirmarYEmitir, marcarProgramacionRequerida,
  ordenDesdeElCarrito, puedeContinuarConLocalCerrado,
} from '../src/mesero-agente/canalDelAgente.js';
import {
  fechasExactasDePedido, horasExactasDePedido,
  pideQuitarProgramacion, referenciasTemporalesDePedido,
} from '../src/mesero-agente/seguridadConversacional.js';
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
const TIENDA = { estado: 'publicada', aceptaProgramados: true, anticipacionMinutos: 40 };

const CARTA = [{ id: 1, nombre: 'Desayunos', productos: [
  { id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, orden: 0, modificadores: [] },
] }];
const nuevo = () => estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
const ejecutorDe = (estado, mensaje) => crearEjecutor({
  estado, catalogo: CARTA, precios: { Hotcakes: 95 }, mensaje, textoCiclo: mensaje, reglas: REGLAS,
  configTienda: TIENDA, zonaDelNegocio: 'America/Matamoros',
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

const val = (fecha, hora, extra = {}) => validarProgramado({
  fecha, hora, reglas: REGLAS, configTienda: TIENDA, zona: 'America/Matamoros', ahora: AHORA, ...extra,
});

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

await t('B4 · una hora que ya pasó, y una a menos de una hora, se distinguen', () => {
  assert.equal(val('2026-09-23', '12:50').motivo, 'pasada');
  const pronto = val('2026-09-23', '13:10');
  assert.equal(pronto.motivo, 'muy_pronto');
  assert.match(pronto.mensaje, /60 minutos/);
  assert.equal(val('2026-09-23', '13:40').motivo, 'muy_pronto',
    'a 40 minutos se imprimiría ahora, no una hora antes');
  assert.equal(val('2026-09-23', '14:10').ok, true);
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

await t('B7 · respeta el interruptor y la anticipación de la tienda', () => {
  assert.equal(val('2026-09-24', '10:00', {
    configTienda: { ...TIENDA, aceptaProgramados: false },
  }).motivo, 'programados_no_disponibles');
  const estricta = val('2026-09-23', '14:10', {
    configTienda: { ...TIENDA, anticipacionMinutos: 90 },
  });
  assert.equal(estricta.motivo, 'muy_pronto');
  assert.match(estricta.mensaje, /90 minutos/);
});

await t('B8 · un cierre especial futuro manda sobre el horario semanal', () => {
  const cierreCompleto = val('2026-09-24', '10:00', {
    reglas: { ...REGLAS, cierres_especiales: [{ fecha: '2026-09-24', motivo: 'mantenimiento' }] },
  });
  assert.equal(cierreCompleto.motivo, 'cierre_especial');
  const cierreTemprano = val('2026-09-25', '14:00', {
    reglas: { ...REGLAS, cierres_especiales: [{ fecha: '2026-09-25', hora_cierre: '13:30' }] },
  });
  assert.equal(cierreTemprano.motivo, 'fuera_de_horario');
  assert.match(cierreTemprano.mensaje, /13:30/);
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

await t('C4 · el bucle real pasa zona y política hasta la herramienta', async () => {
  const estado = nuevo();
  let llamada = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: 'c-zona', turnoId: 't-zona',
    mensaje: 'para mañana a las 10', catalogo: CARTA, precios: { Hotcakes: 95 },
    reglas: { ...REGLAS, timezone: 'America/Mexico_City' },
    configTienda: TIENDA, zonaDelNegocio: 'America/Mexico_City', estado,
    libro: libroDeOperaciones(almacenEnMemoria()),
    llamarModelo: async () => {
      llamada += 1;
      return llamada === 1
        ? { stop_reason: 'tool_use', content: [{
          type: 'tool_use', id: 'programar-zona', name: 'programar_para',
          input: { fecha: '2026-09-24', hora: '10:00' },
        }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Queda para mañana a las 10.' }] };
    },
  });
  const op = salida.operaciones.find((o) => o.herramienta === 'programar_para');
  assert.equal(op?.resultado?.aplicado, true, op?.resultado?.motivo);
  assert.equal(op.resultado.programado_para, '2026-09-24T16:00:00.000Z',
    'el bucle perdió la zona del negocio y cayó a la zona por omisión');
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

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── E. El adaptador conserva la intención y cierra efectos ──');

await t('E1 · la intención futura sobrevive turnos y bloquea un sí sin fecha', async () => {
  const estado = nuevo();
  assert.equal(marcarProgramacionRequerida(estado, 'quiero pedir hotcakes para mañana'), true);
  assert.equal(estado.programacionRequerida, true);
  let registros = 0;
  const r = await confirmarYEmitir({
    negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
    textoDelCiclo: 'sí', registrar: async () => { registros += 1; return { id: 'NO' }; },
    emitir: async () => {}, guardar: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /falta_programar/);
  assert.equal(registros, 0, 'registró antes de exigir la fecha durable');
});

await t('E2 · cerrado solo deja continuar al pedido futuro autorizado', () => {
  const inmediato = nuevo();
  assert.equal(puedeContinuarConLocalCerrado(inmediato, TIENDA), false);
  marcarProgramacionRequerida(inmediato, 'quiero hacer un pedido para mañana a las 10');
  assert.equal(puedeContinuarConLocalCerrado(inmediato, TIENDA), true);
  assert.equal(puedeContinuarConLocalCerrado(inmediato, { ...TIENDA, aceptaProgramados: false }), false);
});

await t('E2b · cambiar A por B invalida A; omitir programar_para registra cero', async () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  estado.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
  estado.carrito.datos = {
    modalidad: 'recoger en tienda', forma_pago: 'efectivo',
    programado_para: '2026-09-25T15:00:00.000Z',
  };
  assert.equal(marcarProgramacionRequerida(estado, 'mejor el sábado a las 11'), true);
  assert.equal('programado_para' in estado.carrito.datos, false,
    'la fecha A sobrevivió a la corrección explícita B');
  let registros = 0;
  const r = await confirmarYEmitir({
    negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
    registrar: async () => { registros += 1; return { id: 'NO-DEBE' }; },
    emitir: async () => {}, guardar: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /falta_programar/);
  assert.equal(registros, 0);
});

await t('E2c · una corrección temporal corta también invalida la fecha A', () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  estado.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
  estado.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
  assert.equal(marcarProgramacionRequerida(estado, 'el sábado a las 11'), true);
  assert.equal('programado_para' in estado.carrito.datos, false,
    'una corrección sin «mejor/cámbialo» conservó la fecha anterior');
  assert.equal(estado.programacionRequerida, true);
});

await t('E2d · corregir solo la hora invalida A; omitir la herramienta registra cero', async () => {
  for (const mensaje of [
    'mejor a las 11', 'a las 11', 'mejor a las once', 'a las once',
    'a la una', 'mejor a las once y media de la noche',
  ]) {
    const estado = nuevo();
    estado.programacionRequerida = true;
    estado.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
    estado.carrito.datos = {
      modalidad: 'recoger en tienda', forma_pago: 'efectivo',
      programado_para: '2026-09-25T15:00:00.000Z',
    };
    assert.equal(marcarProgramacionRequerida(estado, mensaje), true, mensaje);
    assert.equal('programado_para' in estado.carrito.datos, false,
      `${mensaje}: conservó la hora anterior`);
    let registros = 0;
    const r = await confirmarYEmitir({
      negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
      registrar: async () => { registros += 1; return { id: 'NO-DEBE' }; },
      emitir: async () => {}, guardar: async () => {},
    });
    assert.equal(r.ok, false, mensaje);
    assert.match(r.motivo, /falta_programar/, mensaje);
    assert.equal(registros, 0, mensaje);
  }
});

await t('E2e · hoy/ahora solos desprograman únicamente si ya había fecha', () => {
  for (const mensaje of ['hoy', 'ahora', 'hoy.', 'ahora!']) {
    assert.equal(pideQuitarProgramacion(mensaje, { hayProgramacionPrevia: true }), true,
      `${mensaje}: no reconoció la corrección tersa sobre una fecha existente`);
    assert.equal(pideQuitarProgramacion(mensaje), false,
      `${mensaje}: se convirtió en señal global sin una fecha previa`);
  }
  // Las formas explícitas conservan el comportamiento anterior.
  assert.equal(pideQuitarProgramacion('mejor ahora'), true);
  assert.equal(pideQuitarProgramacion('para hoy'), true);

  for (const mensaje of [
    '¿Qué promociones hay para hoy?',
    '¿Qué horarios tienen para hoy?',
    'Quiero saber si tienen disponibilidad para hoy',
  ]) {
    const estado = nuevo();
    estado.programacionRequerida = true;
    estado.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
    estado.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
    assert.equal(marcarProgramacionRequerida(estado, mensaje), false, mensaje);
    assert.equal(estado.programacionRequerida, true,
      `${mensaje}: una consulta informativa canceló la programación`);
    assert.equal(estado.carrito.datos.programado_para, '2026-09-25T15:00:00.000Z',
      `${mensaje}: una consulta informativa borró la fecha`);
  }

  const cambioExplicito = nuevo();
  cambioExplicito.programacionRequerida = true;
  cambioExplicito.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
  cambioExplicito.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
  marcarProgramacionRequerida(cambioExplicito, '¿Mejor para hoy?');
  assert.equal(cambioExplicito.programacionRequerida, false);
  assert.equal('programado_para' in cambioExplicito.carrito.datos, false,
    'la guarda informativa bloqueó una corrección explícita');
});

await t('E3 · asegura la reserva antes de crear el pago, sin emitir ahora', async () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  estado.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
  estado.carrito.datos = {
    modalidad: 'recoger en tienda', forma_pago: 'enlace_pago',
    programado_para: '2026-09-24T15:00:00.000Z',
  };
  const eventos = [];
  const r = await confirmarYEmitir({
    negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
    registrar: async () => {
      eventos.push('registrar');
      return { id: 'XAB-PROG', negocioId: 'n1', total: 95, estado: 'pendiente_pago' };
    },
    crearPago: async () => {
      eventos.push('pago');
      return { url: 'https://pago.example/seguro', estado: 'pendiente' };
    },
    convertir: async () => { eventos.push('convertir'); return { ok: true }; },
    emitir: async () => { eventos.push('EMITIR_PROHIBIDO'); },
    guardar: async () => { eventos.push('guardar'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.programado_para, '2026-09-24T15:00:00.000Z');
  assert.equal(r.enlacePago.url, 'https://pago.example/seguro');
  assert.deepEqual(eventos, ['registrar', 'convertir', 'pago', 'guardar']);
});

await t('E3b · la etiqueta legacy de enlace también crea pago después de reservar', async () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  estado.carrito.items = [{ nombre: 'Hotcakes', cantidad: 1, modificadores: [] }];
  estado.carrito.datos = {
    modalidad: 'recoger en tienda', forma_pago: 'enlace de pago',
    programado_para: '2026-09-24T15:00:00.000Z',
  };
  const eventos = [];
  const r = await confirmarYEmitir({
    negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
    registrar: async () => ({
      id: 'XAB-LEGACY-LINK', negocioId: 'n1', total: 95,
      forma_pago_tipo: 'enlace_pago', estado: 'pendiente_pago',
    }),
    convertir: async () => { eventos.push('convertir'); return { ok: true }; },
    crearPago: async () => { eventos.push('pago'); return { url: 'https://pago.example/legacy' }; },
    emitir: async () => { eventos.push('EMITIR_PROHIBIDO'); },
    guardar: async () => {},
  });
  assert.equal(r.enlacePago?.url, 'https://pago.example/legacy');
  assert.deepEqual(eventos, ['convertir', 'pago']);
});

await t('E4 · si reservar falla, no emite ni deja la proyección en panel', async () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  estado.carrito.datos = {
    modalidad: 'recoger en tienda', forma_pago: 'efectivo',
    programado_para: '2026-09-24T15:00:00.000Z',
  };
  const eventos = [];
  await assert.rejects(() => confirmarYEmitir({
    negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
    registrar: async () => ({ id: 'XAB-FALLA', negocioId: 'n1', total: 95 }),
    convertir: async () => ({ ok: false, razon: 'db' }),
    resolverReserva: async () => null,
    retirarProyeccionFallida: (p) => { eventos.push(`retirar:${p.id}`); },
    emitir: async () => { eventos.push('EMITIR_PROHIBIDO'); },
    guardar: async () => { eventos.push('GUARDAR_PROHIBIDO'); },
  }), /programacion_incierta/);
  assert.deepEqual(eventos, ['retirar:XAB-FALLA']);
});

await t('E5 · adopta un COMMIT de reserva cuya respuesta se perdió', async () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  estado.carrito.datos = {
    modalidad: 'recoger en tienda', forma_pago: 'efectivo',
    programado_para: '2026-09-24T15:00:00.000Z',
  };
  const eventos = [];
  const r = await confirmarYEmitir({
    negocioId: 'n1', telefono: '52', canal: 'whatsapp', estado, pedido: { total: 95 },
    registrar: async () => ({ id: 'XAB-COMMIT', negocioId: 'n1', total: 95 }),
    convertir: async () => { eventos.push('convertir_commit_sin_respuesta'); throw new Error('ECONNRESET'); },
    resolverReserva: async () => ({
      folio: 'XAB-COMMIT', negocio_id: 'n1', activado: false,
      programado_para: '2026-09-24T15:00:00.000Z', programado_id: 'p1',
    }),
    emitir: async () => { eventos.push('EMITIR_PROHIBIDO'); },
    guardar: async () => { eventos.push('guardar'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.folio, 'XAB-COMMIT');
  assert.deepEqual(eventos, ['convertir_commit_sin_respuesta', 'guardar']);
});

await t('E6 · la confirmación controlada reitera fecha y hora locales', () => {
  const estado = nuevo();
  estado.carrito.datos.programado_para = '2026-09-24T15:00:00.000Z';
  const salida = aplicarRespuestaDeConfirmacion({
    estado, zonaDelNegocio: 'America/Matamoros',
    salida: { texto: 'listo', operaciones: [{ herramienta: 'confirmar_pedido', resultado: {
      aplicado: true, folio: 'XAB-PROG', total: 95,
      programado_para: '2026-09-24T15:00:00.000Z',
    } }] },
  });
  assert.match(salida.texto, /jueves,? 24 de septiembre de 2026/i);
  assert.match(salida.texto, /10:00/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── F. Memoria temporal segura entre turnos ──');

await t('F1 · mañana y luego a las 10 sobreviven un roundtrip sin carrito', () => {
  const estado = nuevo();
  assert.equal(marcarProgramacionRequerida(estado, 'quiero pedir mañana', {
    fechaHoy: '2026-09-23',
  }), true);
  const restaurado = JSON.parse(JSON.stringify(estadoSerializable(estado)));
  assert.equal((restaurado.carrito.items || []).length, 0);
  assert.equal(marcarProgramacionRequerida(restaurado, 'a las 10', {
    // El cliente contestó después de medianoche: «mañana» sigue anclado al 23.
    fechaHoy: '2026-09-24',
  }), true,
    'la hora tersa dejó de reconocerse porque aún no había artículos');
  assert.deepEqual(restaurado.referenciaProgramacion, {
    fechaCliente: 'manana',
    horaCliente: 'a las 10',
    fechaAncla: '2026-09-23',
    fechaValidada: null,
    horaValidada: null,
    isoValidado: null,
  });
  const pendiente = ejecutorDe(restaurado, 'a las 10').vista().programacion_pendiente;
  assert.equal(pendiente.fecha, 'manana');
  assert.equal(pendiente.hora, 'a las 10');
  assert.equal(pendiente.fuente_fecha, 'cliente');
  assert.equal(pendiente.fuente_hora, 'cliente');
});

await t('F2 · el prompt real ve ambos fragmentos y la herramienta los valida', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  marcarProgramacionRequerida(estado, 'quiero el pedido para mañana', {
    fechaHoy: '2026-09-23',
  });
  const restaurado = JSON.parse(JSON.stringify(estadoSerializable(estado)));
  marcarProgramacionRequerida(restaurado, 'a las 10', { fechaHoy: '2026-09-24' });

  const vistaAntes = ejecutorDe(restaurado, 'a las 10').vista();
  const promptDirecto = construirInstrucciones({
    pedido: vistaAntes,
    estadoRestaurante: {
      fechaHoy: '2026-09-24', diaActual: 'jueves', horaActual: '00:01', abierto: true,
    },
  });
  assert.match(promptDirecto, /PROGRAMACIÓN PENDIENTE/);
  assert.match(promptDirecto, /manana/);
  assert.match(promptDirecto, /a las 10/);
  assert.match(promptDirecto, /fecha local era: 2026-09-23/,
    'el prompt reinterpretaría mañana contra el día del segundo turno');
  assert.match(promptDirecto, /Xabor las validará/);

  let paso = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: 'c-memoria', turnoId: 't-memoria',
    mensaje: 'a las 10', catalogo: CARTA, precios: { Hotcakes: 95 },
    reglas: REGLAS, configTienda: TIENDA, zonaDelNegocio: 'America/Matamoros',
    estado: restaurado, libro: libroDeOperaciones(almacenEnMemoria()),
    contexto: { estadoRestaurante: {
      fechaHoy: '2026-09-24', diaActual: 'jueves', horaActual: '00:01', abierto: true,
    } },
    llamarModelo: async (payload) => {
      paso += 1;
      if (paso === 1) {
        assert.match(payload.system, /manana/);
        assert.match(payload.system, /a las 10/);
        return { stop_reason: 'tool_use', content: [{
          type: 'tool_use', id: 'programar-memoria', name: 'programar_para',
          input: { fecha: '2026-09-24', hora: '10:00' },
        }] };
      }
      assert.match(payload.system, /2026-09-24T15:00:00.000Z/);
      return { stop_reason: 'end_turn', content: [{
        type: 'text', text: 'Quedó programado para mañana a las 10.',
      }] };
    },
  });
  const op = salida.operaciones.find((o) => o.herramienta === 'programar_para');
  assert.equal(op?.resultado?.aplicado, true, op?.resultado?.motivo);
  assert.deepEqual(restaurado.referenciaProgramacion, {
    fechaCliente: null,
    horaCliente: null,
    fechaValidada: '2026-09-24',
    horaValidada: '10:00',
    isoValidado: '2026-09-24T15:00:00.000Z',
    fechaIntentada: '2026-09-24',
    horaIntentada: '10:00',
  });
});

await t('F3 · corregir solo la hora conserva la fecha validada y borra el ISO vigente', async () => {
  const estado = nuevo();
  marcarProgramacionRequerida(estado, 'quiero pedir mañana a las 10');
  const aplicado = await ejecutorDe(estado, 'quiero pedir mañana a las 10')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
  assert.equal(aplicado.aplicado, true, aplicado.motivo);

  assert.equal(marcarProgramacionRequerida(estado, 'mejor a las 11'), true);
  assert.equal(estado.carrito.datos.programado_para, undefined);
  assert.deepEqual(estado.referenciaProgramacion, {
    fechaCliente: null,
    horaCliente: 'a las 11',
    fechaValidada: '2026-09-24',
    horaValidada: null,
    isoValidado: null,
    fechaIntentada: '2026-09-24',
  });
  const pendiente = ejecutorDe(estado, 'mejor a las 11').vista().programacion_pendiente;
  assert.deepEqual({ fecha: pendiente.fecha, hora: pendiente.hora,
    fuenteFecha: pendiente.fuente_fecha, fuenteHora: pendiente.fuente_hora }, {
    fecha: '2026-09-24', hora: 'a las 11',
    fuenteFecha: 'validada_anterior', fuenteHora: 'cliente',
  });
  const fechaInventada = await ejecutorDe(estado, 'mejor a las 11')
    .ejecutar('programar_para', { fecha: '2026-09-25', hora: '11:00' });
  assert.equal(fechaInventada.aplicado, false);
  assert.match(fechaInventada.motivo,
    /fecha_no_coincide_con_programacion_validada|programacion_alternativa_sin_cliente/);
  const corregida = await ejecutorDe(estado, 'mejor a las 11')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '11:00' });
  assert.equal(corregida.aplicado, true, corregida.motivo);
});

await t('F4 · desprogramar y cancelar el pedido limpian toda referencia temporal', async () => {
  const estado = nuevo();
  marcarProgramacionRequerida(estado, 'quiero pedir mañana a las 10');
  await ejecutorDe(estado, 'quiero pedir mañana a las 10')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
  marcarProgramacionRequerida(estado, 'mejor para hoy');
  assert.equal(estado.programacionRequerida, false);
  assert.equal(estado.referenciaProgramacion, null);
  assert.equal(estado.carrito.datos.programado_para, undefined);

  marcarProgramacionRequerida(estado, 'quiero pedir mañana a las 10');
  const cancelado = await ejecutorDe(estado, 'cancela todo')
    .ejecutar('cancelar_pedido', { motivo: 'el cliente canceló' });
  assert.equal(cancelado.aplicado, true);
  assert.equal(estado.programacionRequerida, false);
  assert.equal(estado.referenciaProgramacion, null);
  assert.equal(estado.carrito.datos.programado_para, undefined);
});

await t('F5 · la memoria whitelist no conserva PII ni el resto del mensaje', () => {
  const mensaje = 'Soy Mario Pérez, 528787899919, calle Secreta 123; quiero hotcakes mañana a las 10';
  assert.deepEqual(referenciasTemporalesDePedido(mensaje), {
    fecha: 'manana', hora: 'a las 10',
  });
  assert.deepEqual(referenciasTemporalesDePedido('el sábado 10 am'), {
    fecha: 'el sabado', hora: '10 am',
  });
  const estado = nuevo();
  assert.equal(marcarProgramacionRequerida(estado, mensaje), true);
  const serializado = JSON.stringify(estado.referenciaProgramacion);
  assert.doesNotMatch(serializado, /Mario|Pérez|528787899919|Secreta|hotcakes/i);
  assert.deepEqual(estado.referenciaProgramacion, {
    fechaCliente: 'manana', horaCliente: 'a las 10',
    fechaValidada: null, horaValidada: null, isoValidado: null,
  });
});

await t('F6 · los args del modelo no fabrican evidencia ni hechos validados', async () => {
  const sinEvidencia = nuevo();
  const inventada = await ejecutorDe(sinEvidencia, 'sí, está bien')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
  assert.equal(inventada.aplicado, false);
  assert.match(inventada.motivo, /programacion_sin_intencion_cliente/);
  assert.equal(sinEvidencia.referenciaProgramacion, null);
  assert.equal(sinEvidencia.carrito.datos.programado_para, undefined);

  const incompleta = nuevo();
  marcarProgramacionRequerida(incompleta, 'quiero pedir el domingo', { fechaHoy: '2026-09-23' });
  const horaInventada = await ejecutorDe(incompleta, 'quiero pedir el domingo')
    .ejecutar('programar_para', { fecha: '2026-09-27', hora: '10:00' });
  assert.equal(horaInventada.aplicado, false);
  assert.match(horaInventada.motivo, /falta que el cliente indique la hora/);
  assert.equal(incompleta.referenciaProgramacion.fechaValidada, null);
  assert.equal(incompleta.referenciaProgramacion.horaValidada, null);

  marcarProgramacionRequerida(incompleta, 'a las 10', { fechaHoy: '2026-09-23' });
  const politicaRechaza = await ejecutorDe(incompleta, 'a las 10')
    .ejecutar('programar_para', { fecha: '2026-09-27', hora: '10:00' });
  assert.equal(politicaRechaza.aplicado, false);
  assert.match(politicaRechaza.motivo, /cerrado_ese_dia/);
  assert.equal(incompleta.referenciaProgramacion.fechaValidada, null,
    'promovió a validada una fecha que la política rechazó');
  assert.equal(incompleta.referenciaProgramacion.horaValidada, null,
    'promovió a validada una hora dentro de una programación rechazada');
});

await t('F7 · un estado legacy conserva la fecha LOCAL al corregir solo la hora', async () => {
  const estado = nuevo();
  estado.programacionRequerida = true;
  // En septiembre Matamoros está en UTC-5: este instante cae todavía en el
  // jueves 24 local, aunque en UTC ya sea viernes 25.
  estado.carrito.datos.programado_para = '2026-09-25T04:30:00.000Z';
  assert.equal(marcarProgramacionRequerida(estado, 'mejor a las 11'), true);
  assert.equal(estado.carrito.datos.programado_para, undefined);
  assert.equal(estado.referenciaProgramacion.fechaValidada, null,
    'el adaptador sin zona no debe adivinar el día local');

  const ejecutor = ejecutorDe(estado, 'mejor a las 11');
  const pendiente = ejecutor.vista().programacion_pendiente;
  assert.equal(pendiente.fecha, '2026-09-24');
  assert.equal(pendiente.fuente_fecha, 'validada_anterior');
  assert.equal(pendiente.hora, 'a las 11');
  assert.equal(pendiente.iso_validado_anterior, null,
    'el ISO completo viejo siguió apareciendo como si todavía fuera vigente');

  const cambioDeDiaInventado = await ejecutor.ejecutar('programar_para', {
    fecha: '2026-09-25', hora: '11:00',
  });
  assert.equal(cambioDeDiaInventado.aplicado, false);
  assert.match(cambioDeDiaInventado.motivo, /fecha_no_coincide_con_programacion_validada/);
  const correcto = await ejecutorDe(estado, 'mejor a las 11').ejecutar('programar_para', {
    fecha: '2026-09-24', hora: '11:00',
  });
  assert.equal(correcto.aplicado, true, correcto.motivo);
});

await t('F8 · solo una hora literal autoriza: una franja obliga a preguntar', async () => {
  assert.deepEqual(horasExactasDePedido('a las 10'), ['10:00', '22:00']);
  assert.deepEqual(horasExactasDePedido('mejor 11 am'), ['11:00']);
  assert.deepEqual(horasExactasDePedido('a las once y media de la noche'), ['23:30']);
  assert.deepEqual(horasExactasDePedido('por la tarde'), []);
  assert.deepEqual(horasExactasDePedido('de las 10 a las 12'), []);
  assert.deepEqual(horasExactasDePedido('entre las 10 y las 12'), []);

  const estado = nuevo();
  marcarProgramacionRequerida(estado, 'quiero pedir mañana por la mañana', {
    fechaHoy: '2026-09-23',
  });
  const vista = ejecutorDe(estado, 'quiero pedir mañana por la mañana').vista();
  assert.equal(vista.programacion_pendiente.hora, null);
  assert.equal(vista.programacion_pendiente.franja_horaria, 'por la manana');
  const arbitraria = await ejecutorDe(estado, 'quiero pedir mañana por la mañana')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
  assert.equal(arbitraria.aplicado, false);
  assert.match(arbitraria.motivo, /es una franja, no una hora exacta/);
  assert.equal(estado.carrito.datos.programado_para, undefined);
});

await t('F9 · la hora del modelo debe corresponder literalmente a la del cliente', async () => {
  const estado = nuevo();
  marcarProgramacionRequerida(estado, 'quiero pedir mañana a las 13:00', {
    fechaHoy: '2026-09-23',
  });
  const cambiada = await ejecutorDe(estado, 'quiero pedir mañana a las 13:00')
    .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
  assert.equal(cambiada.aplicado, false);
  assert.match(cambiada.motivo, /hora_no_coincide_con_cliente/);
  assert.equal(estado.carrito.datos.programado_para, undefined);
});

await t('F10 · una consulta temporal no autoriza programar_para', async () => {
  for (const mensaje of [
    '¿abren mañana a las 10?',
    '¿puedo pedir mañana a las 10?',
    '¿se puede pedir mañana a las 10?',
    'quisiera saber si puedo pedir mañana a las 10',
  ]) {
    const estado = nuevo();
    assert.equal(marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: '2026-09-23',
    }), false, mensaje);
    const indebida = await ejecutorDe(estado, mensaje)
      .ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
    assert.equal(indebida.aplicado, false, mensaje);
    assert.match(indebida.motivo, /programacion_sin_intencion_cliente/, mensaje);
    assert.equal(estado.programacionRequerida, false, mensaje);
    assert.equal(estado.carrito.datos.programado_para, undefined, mensaje);
  }

});

await t('F11 · tras un rechazo no elige otra fecha sin un mensaje nuevo', async () => {
  const estado = nuevo();
  marcarProgramacionRequerida(estado, 'quiero pedir el domingo a las 10', {
    fechaHoy: '2026-09-23',
  });
  const ejecutor = ejecutorDe(estado, 'quiero pedir el domingo a las 10');
  const domingo = await ejecutor.ejecutar('programar_para', {
    fecha: '2026-09-27', hora: '10:00',
  });
  assert.equal(domingo.aplicado, false);
  assert.match(domingo.motivo, /cerrado_ese_dia/);
  assert.equal(estado.referenciaProgramacion.fechaIntentada, '2026-09-27');

  const lunesSinPermiso = await ejecutor.ejecutar('programar_para', {
    fecha: '2026-09-28', hora: '10:00',
  });
  assert.equal(lunesSinPermiso.aplicado, false);
  assert.match(lunesSinPermiso.motivo, /fecha_no_coincide_con_cliente|programacion_alternativa_sin_cliente/);
  assert.equal(estado.carrito.datos.programado_para, undefined);

  marcarProgramacionRequerida(estado, 'mejor a las 11', { fechaHoy: '2026-09-23' });
  assert.equal(estado.referenciaProgramacion.fechaIntentada, '2026-09-27',
    'cambiar solo la hora liberó también la fecha que el cliente no cambió');
  assert.equal(estado.referenciaProgramacion.horaIntentada, undefined);
  const fechaCambiadaConSoloHora = await ejecutorDe(estado, 'mejor a las 11')
    .ejecutar('programar_para', { fecha: '2026-09-28', hora: '11:00' });
  assert.equal(fechaCambiadaConSoloHora.aplicado, false);
  assert.match(fechaCambiadaConSoloHora.motivo,
    /fecha_no_coincide_con_cliente|programacion_alternativa_sin_cliente/);
});

await t('F12 · correcciones tersas invalidan A y un reemplazo no se vuelve inmediato', () => {
  const programado = () => {
    const estado = nuevo();
    estado.programacionRequerida = true;
    estado.carrito.datos.programado_para = '2026-09-24T15:00:00.000Z';
    estado.referenciaProgramacion = {
      fechaCliente: null, horaCliente: null, fechaAncla: null,
      fechaValidada: '2026-09-24', horaValidada: '10:00',
      isoValidado: '2026-09-24T15:00:00.000Z',
      fechaIntentada: '2026-09-24', horaIntentada: '10:00',
    };
    return estado;
  };

  for (const mensaje of ['no, a las 11', 'mejor 11 am']) {
    const estado = programado();
    assert.equal(marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: '2026-09-23',
    }), true, mensaje);
    assert.equal(estado.carrito.datos.programado_para, undefined, mensaje);
    assert.equal(estado.referenciaProgramacion.horaCliente.includes('11'), true, mensaje);
    assert.equal(estado.referenciaProgramacion.fechaValidada, '2026-09-24', mensaje);
    assert.equal(estado.referenciaProgramacion.fechaIntentada, '2026-09-24', mensaje);
    assert.equal(estado.referenciaProgramacion.horaIntentada, undefined, mensaje);
  }

  const reemplazo = programado();
  assert.equal(marcarProgramacionRequerida(
    reemplazo, 'ya no para mañana, mejor el viernes a las 11',
    { fechaHoy: '2026-09-23' },
  ), true);
  assert.equal(reemplazo.programacionRequerida, true);
  assert.equal(reemplazo.carrito.datos.programado_para, undefined);
  assert.equal(reemplazo.referenciaProgramacion.fechaCliente, 'el viernes');
  assert.equal(reemplazo.referenciaProgramacion.horaCliente, 'a las 11');
  assert.equal(reemplazo.referenciaProgramacion.fechaAncla, '2026-09-23');
});

await t('F13 · una segunda llamada del mismo turno no borra ni reemplaza el primer éxito', async () => {
  const estado = nuevo();
  marcarProgramacionRequerida(estado, 'quiero pedir mañana a las 10', {
    fechaHoy: '2026-09-23',
  });
  const ejecutor = ejecutorDe(estado, 'quiero pedir mañana a las 10');
  const primera = await ejecutor.ejecutar('programar_para', {
    fecha: '2026-09-24', hora: '10:00',
  });
  assert.equal(primera.aplicado, true, primera.motivo);
  const isoPrimero = estado.carrito.datos.programado_para;

  const segunda = await ejecutor.ejecutar('programar_para', {
    fecha: '2026-09-25', hora: '10:00',
  });
  assert.equal(segunda.aplicado, false);
  assert.match(segunda.motivo, /fecha_no_coincide_con_cliente|programacion_alternativa_sin_cliente/);
  assert.equal(estado.carrito.datos.programado_para, isoPrimero,
    'la llamada rechazada borró la programación que ya había sido aceptada');
  assert.equal(estado.referenciaProgramacion.fechaValidada, '2026-09-24');
  assert.equal(estado.referenciaProgramacion.horaValidada, '10:00');
});

await t('F14 · la fecha literal y las relativas quedan ligadas al ancla del cliente', async () => {
  assert.deepEqual(fechasExactasDePedido('2026-09-25', { fechaAncla: '2026-09-23' }), ['2026-09-25']);
  assert.deepEqual(fechasExactasDePedido('mañana', { fechaAncla: '2026-09-23' }), ['2026-09-24']);
  assert.deepEqual(fechasExactasDePedido('pasado mañana', { fechaAncla: '2026-09-23' }), ['2026-09-25']);
  assert.deepEqual(fechasExactasDePedido('el viernes', { fechaAncla: '2026-09-23' }), ['2026-09-25']);
  assert.deepEqual(fechasExactasDePedido('25 de septiembre', { fechaAncla: '2026-09-23' }), ['2026-09-25']);
  assert.deepEqual(fechasExactasDePedido('25/09', { fechaAncla: '2026-09-23' }), ['2026-09-25']);

  const literal = nuevo();
  marcarProgramacionRequerida(literal, 'quiero el pedido el 2026-09-25 a las 10', {
    fechaHoy: '2026-09-23',
  });
  const otroDia = await ejecutorDe(literal, 'quiero el pedido el 2026-09-25 a las 10')
    .ejecutar('programar_para', { fecha: '2026-09-26', hora: '10:00' });
  assert.equal(otroDia.aplicado, false);
  assert.match(otroDia.motivo, /fecha_no_coincide_con_cliente/);
  assert.equal(literal.carrito.datos.programado_para, undefined);

  const relativa = nuevo();
  marcarProgramacionRequerida(relativa, 'quiero pedir mañana a las 10', {
    fechaHoy: '2026-09-23',
  });
  const reinterpretada = await ejecutorDe(relativa, 'quiero pedir mañana a las 10')
    .ejecutar('programar_para', { fecha: '2026-09-25', hora: '10:00' });
  assert.equal(reinterpretada.aplicado, false);
  assert.match(reinterpretada.motivo, /fecha_no_coincide_con_cliente/);
  assert.equal(relativa.referenciaProgramacion.fechaAncla, '2026-09-23',
    'el ejecutor volvió a anclar «mañana» después de medianoche');
});

await t('F15 · una semana no elige día y una hora con dos lecturas obliga a aclarar', async () => {
  const vaga = nuevo();
  marcarProgramacionRequerida(vaga, 'quiero pedir la próxima semana a las 10 am', {
    fechaHoy: '2026-09-23',
  });
  const inventada = await ejecutorDe(vaga, 'quiero pedir la próxima semana a las 10 am')
    .ejecutar('programar_para', { fecha: '2026-09-25', hora: '10:00' });
  assert.equal(inventada.aplicado, false);
  assert.match(inventada.motivo, /no identifica un día exacto/);

  assert.deepEqual(horasExactasDePedido('a las doce de la noche'), ['00:00']);
  const ambigua = nuevo();
  marcarProgramacionRequerida(ambigua, 'quiero pedir el viernes a las 8', {
    fechaHoy: '2026-09-23',
  });
  const nocheElegidaPorModelo = await ejecutorDe(ambigua, 'quiero pedir el viernes a las 8')
    .ejecutar('programar_para', { fecha: '2026-09-25', hora: '20:00' });
  assert.equal(nocheElegidaPorModelo.aplicado, false);
  assert.match(nocheElegidaPorModelo.motivo, /hora_ambigua_cliente/);
  assert.equal(ambigua.carrito.datos.programado_para, undefined);

  marcarProgramacionRequerida(ambigua, 'mejor a las 8 pm', { fechaHoy: '2026-09-23' });
  const aclarada = await ejecutorDe(ambigua, 'mejor a las 8 pm')
    .ejecutar('programar_para', { fecha: '2026-09-25', hora: '20:00' });
  assert.equal(aclarada.aplicado, true, aclarada.motivo);
});

await t('F16 · corregir una programación a hoy o ahora gana sobre la fecha negada', () => {
  const programado = () => {
    const estado = nuevo();
    estado.programacionRequerida = true;
    estado.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
    estado.referenciaProgramacion = {
      fechaCliente: null, horaCliente: null,
      fechaValidada: '2026-09-25', horaValidada: '10:00',
      isoValidado: '2026-09-25T15:00:00.000Z',
      fechaIntentada: '2026-09-25', horaIntentada: '10:00',
    };
    return estado;
  };
  for (const mensaje of [
    'ya no mañana, mejor hoy',
    'mañana no, mejor ahora',
    'ya no el viernes, mejor hoy',
  ]) {
    const estado = programado();
    assert.equal(marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: '2026-09-24',
    }), false, mensaje);
    assert.equal(estado.programacionRequerida, false, mensaje);
    assert.equal(estado.referenciaProgramacion, null, mensaje);
    assert.equal(estado.carrito.datos.programado_para, undefined, mensaje);
  }

  const correccionEnLaMismaFrase = nuevo();
  assert.equal(marcarProgramacionRequerida(
    correccionEnLaMismaFrase,
    'quiero pedir mañana, no, mejor hoy',
    { fechaHoy: '2026-09-24' },
  ), false);
  assert.equal(correccionEnLaMismaFrase.programacionRequerida, false);
  assert.equal(correccionEnLaMismaFrase.referenciaProgramacion, null);

  const ahoraEsElActoDePedir = nuevo();
  assert.equal(marcarProgramacionRequerida(
    ahoraEsElActoDePedir,
    'quiero ahora hacer un pedido para mañana a las 10',
    { fechaHoy: '2026-09-24' },
  ), true, '«ahora» describía cuándo pide, no cuándo se entrega');
  assert.equal(ahoraEsElActoDePedir.programacionRequerida, true);
  assert.equal(ahoraEsElActoDePedir.referenciaProgramacion.fechaCliente, 'manana');
});

await t('F17 · la última autocorrección temporal manda y lo negado nunca se programa', async () => {
  for (const mensaje of [
    'para hoy no, mejor mañana a las 10 am',
    'no para hoy, mejor mañana a las 10 am',
    'lo quería para hoy, pero mejor mañana a las 10 am',
    'mejor para hoy no, mañana a las 10 am',
  ]) {
    const estado = nuevo();
    assert.equal(marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: '2026-09-23',
    }), true, mensaje);
    assert.equal(estado.programacionRequerida, true, mensaje);
    assert.equal(estado.referenciaProgramacion?.fechaCliente, 'manana', mensaje);
  }

  for (const caso of [
    {
      mensaje: 'quiero para el viernes, no, el sábado a las 10 am',
      fechaRechazada: '2026-09-25', fechaFinal: '2026-09-26', horaRechazada: '10:00', horaFinal: '10:00',
    },
    {
      mensaje: 'quiero el 2026-09-25, no, el 2026-09-26 a las 10 am',
      fechaRechazada: '2026-09-25', fechaFinal: '2026-09-26', horaRechazada: '10:00', horaFinal: '10:00',
    },
    {
      mensaje: 'quiero el viernes a las 10 am, no, a las 11 am',
      fechaRechazada: '2026-09-25', fechaFinal: '2026-09-25', horaRechazada: '10:00', horaFinal: '11:00',
    },
  ]) {
    const estado = nuevo();
    assert.equal(marcarProgramacionRequerida(estado, caso.mensaje, {
      fechaHoy: '2026-09-23',
    }), true, caso.mensaje);
    const rechazada = await ejecutorDe(estado, caso.mensaje).ejecutar('programar_para', {
      fecha: caso.fechaRechazada, hora: caso.horaRechazada,
    });
    assert.equal(rechazada.aplicado, false, `aceptó lo descartado: ${caso.mensaje}`);
    const aplicada = await ejecutorDe(estado, caso.mensaje).ejecutar('programar_para', {
      fecha: caso.fechaFinal, hora: caso.horaFinal,
    });
    assert.equal(aplicada.aplicado, true, `${caso.mensaje}: ${aplicada.motivo}`);
  }
});

await t('F18 · alternativas y rangos quedan incompletos; nunca escogen el primer valor', async () => {
  for (const mensaje of [
    'quiero pedir entre el viernes y el sábado a las 10 am',
    'quiero pedir del viernes al sábado a las 10 am',
    'quiero pedir el viernes o el sábado a las 10 am',
    'quiero pedir hoy o mañana a las 10 am',
  ]) {
    const estado = nuevo();
    assert.equal(marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: '2026-09-23',
    }), true, mensaje);
    assert.equal(estado.programacionRequerida, true, mensaje);
    assert.equal(estado.referenciaProgramacion?.fechaCliente ?? null, null, mensaje);
    const elegidaPorModelo = await ejecutorDe(estado, mensaje).ejecutar('programar_para', {
      fecha: '2026-09-25', hora: '10:00',
    });
    assert.equal(elegidaPorModelo.aplicado, false, `eligió el primer día: ${mensaje}`);
    assert.equal(estado.carrito.datos.programado_para, undefined, mensaje);
  }

  const horas = nuevo();
  const mensajeHoras = 'quiero pedir el viernes a las 10 u 11';
  assert.equal(marcarProgramacionRequerida(horas, mensajeHoras, {
    fechaHoy: '2026-09-23',
  }), true);
  assert.equal(horas.referenciaProgramacion?.fechaCliente, 'el viernes');
  assert.equal(horas.referenciaProgramacion?.horaCliente ?? null, null);
  for (const hora of ['10:00', '11:00']) {
    const elegida = await ejecutorDe(horas, mensajeHoras).ejecutar('programar_para', {
      fecha: '2026-09-25', hora,
    });
    assert.equal(elegida.aplicado, false, `eligió ${hora} de una alternativa`);
  }
});

await t('F19 · autocorrecciones afirmadas y negación del segundo tienen semántica estable', async () => {
  for (const [mensaje, fecha] of [
    ['quiero el viernes, perdón, el sábado a las 10 am', 'sabado'],
    ['quiero el viernes, digo, el sábado a las 10 am', 'sabado'],
    ['quiero el viernes, quise decir el sábado a las 10 am', 'sabado'],
    ['quiero el viernes, más bien el sábado a las 10 am', 'sabado'],
    ['quiero el viernes no; el sábado sí a las 10 am', 'sabado'],
    ['quiero no el viernes sino el sábado a las 10 am', 'sabado'],
    ['quiero el viernes, no el sábado a las 10 am', 'viernes'],
  ]) {
    const estado = nuevo();
    assert.equal(marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: '2026-09-23',
    }), true, mensaje);
    assert.match(estado.referenciaProgramacion?.fechaCliente || '', new RegExp(fecha), mensaje);
  }

  const negacionDelSegundo = nuevo();
  const mensaje = 'quiero el viernes a las 10 am, no el sábado a las 11 am';
  marcarProgramacionRequerida(negacionDelSegundo, mensaje, { fechaHoy: '2026-09-23' });
  const descartada = await ejecutorDe(negacionDelSegundo, mensaje).ejecutar('programar_para', {
    fecha: '2026-09-26', hora: '11:00',
  });
  assert.equal(descartada.aplicado, false, 'la referencia negada quedó autorizada');
  const afirmada = await ejecutorDe(negacionDelSegundo, mensaje).ejecutar('programar_para', {
    fecha: '2026-09-25', hora: '10:00',
  });
  assert.equal(afirmada.aplicado, true, afirmada.motivo);
});

await t('F20 · corrección inmediata/futura, estado previo y consultas son fail-closed', () => {
  const programado = () => {
    const estado = nuevo();
    estado.programacionRequerida = true;
    estado.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
    estado.referenciaProgramacion = {
      fechaCliente: null, horaCliente: null,
      fechaValidada: '2026-09-25', horaValidada: '10:00',
      isoValidado: '2026-09-25T15:00:00.000Z',
      fechaIntentada: '2026-09-25', horaIntentada: '10:00',
    };
    return estado;
  };

  const futura = programado();
  assert.equal(marcarProgramacionRequerida(futura, 'hoy no; mejor mañana a las 11 am', {
    fechaHoy: '2026-09-23',
  }), true);
  assert.equal(futura.programacionRequerida, true);
  assert.equal(futura.referenciaProgramacion.fechaCliente, 'manana');
  assert.equal(futura.carrito.datos.programado_para, undefined);

  const inmediata = programado();
  assert.equal(marcarProgramacionRequerida(inmediata, 'mañana no; mejor ahora', {
    fechaHoy: '2026-09-23',
  }), false);
  assert.equal(inmediata.programacionRequerida, false);
  assert.equal(inmediata.referenciaProgramacion, null);
  assert.equal(inmediata.carrito.datos.programado_para, undefined);

  for (const mensaje of ['viernes o sábado', 'entre el viernes y el sábado']) {
    const ambiguo = programado();
    assert.equal(marcarProgramacionRequerida(ambiguo, mensaje, {
      fechaHoy: '2026-09-23',
    }), true, mensaje);
    assert.equal(ambiguo.programacionRequerida, true, mensaje);
    assert.equal(ambiguo.referenciaProgramacion?.fechaValidada ?? null, null, mensaje);
    assert.equal(ambiguo.carrito.datos.programado_para, undefined, mensaje);
  }

  const consulta = programado();
  const antes = JSON.stringify(consulta);
  assert.equal(marcarProgramacionRequerida(consulta, '¿el viernes no abren?', {
    fechaHoy: '2026-09-23',
  }), false);
  assert.equal(JSON.stringify(consulta), antes, 'una consulta cambió la reserva durable');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
