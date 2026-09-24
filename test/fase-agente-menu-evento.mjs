// ─── MENÚ, EVENTOS Y PEDIDOS PARA OTRO DÍA ────────────────────────────────
//
// Las tres decisiones del dueño del 23-sep-2026, cada una con su prueba:
//
//   1. el agente puede mandar la imagen del menú;
//   2. un pedido para otro día va a la TIENDA EN LÍNEA, no a una persona
//      (y solo a una persona si esa tienda no existe o no agenda);
//   3. catering: se toman cuatro mínimos y llama alguien del equipo. No se
//      propone menú, no se dan precios.
//
// Suite pura: sin Postgres, sin puertos, sin modelo.
import assert from 'node:assert/strict';
import { NOMBRES, CON_EFECTO, validarArgumentos } from '../src/mesero-agente/contratoDeHerramientas.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { transicionLegal, CONFIRMADO, ESCALADO, NAVEGANDO } from '../src/mesero-agente/maquinaDeEstados.js';
import { respuestaAPedidoProgramado, enlaceDeTienda } from '../src/mesero-agente/horarioDelAgente.js';
import { esSolicitudDePedidoProgramado } from '../src/mesero-agente/seguridadConversacional.js';
import {
  aplicarSalidaSeguraDeCatering, bloqueoPrevioDelAgente, consumirCancelacionCatering,
  prepararEstadoCatering, TEXTO_CATERING_CANCELADO,
} from '../src/mesero-agente/canalDelAgente.js';
import { MENSAJE_CATERING_ENTREGADO, MENSAJE_CATERING_REVISION } from '../src/agent/catering.js';
import {
  camposCateringVerificados, eventoCateringPublico, filtrarCapturasCatering,
  filtrarDatosEventoCatering, sellarCamposCatering, sellarEventoCatering,
} from '../src/agent/evidenciaCatering.js';

let pasadas = 0;
const fallos = [];
const t = async (nombre, fn) => {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [{ id: 1, nombre: 'Desayunos', productos: [
  { id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, orden: 0, modificadores: [] },
  { id: 85, nombre: 'Chilaquiles', precio: 195, disponible: true, orden: 1,
    modificadores: [g('Salsa', 1, 1, ['Roja', 'Verde'])] },
] }];

const nuevo = () => estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
const ejecutorDe = (estado, mensaje, efectos = null) => crearEjecutor({
  estado, catalogo: CARTA, precios: { Hotcakes: 95, Chilaquiles: 195 }, mensaje, textoCiclo: mensaje, efectos,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El menú ──');

await t('A1 · la herramienta existe, tiene efecto y no lleva argumentos', () => {
  assert.ok(NOMBRES.includes('enviar_menu'));
  assert.ok(CON_EFECTO.includes('enviar_menu'),
    'sin efecto no pasaría por el libro y el cliente podría recibir el menú dos veces en un turno');
  assert.equal(validarArgumentos('enviar_menu', {}).ok, true);
  assert.equal(validarArgumentos('enviar_menu', { paginas: 2 }).ok, false, 'aceptó un argumento inventado');
});

await t('A2 · lo manda el canal, y el resultado dice cuántas páginas', async () => {
  const llamadas = [];
  const r = await ejecutorDe(nuevo(), 'me pasas el menú?', {
    enviarMenu: async () => { llamadas.push(1); return { ok: true, paginas: 3 }; },
  }).ejecutar('enviar_menu', {});
  assert.equal(r.aplicado, true, r.motivo);
  assert.equal(r.paginas, 3);
  assert.equal(llamadas.length, 1);
  assert.match(r.nota, /NO repitas/i, 'no le dice al modelo que se calle: diría «aquí está tu menú» encima del texto real');
});

await t('A3 · si el envío falla, NO se da por mandado', async () => {
  const r = await ejecutorDe(nuevo(), 'el menú porfa', {
    enviarMenu: async () => ({ ok: false, motivo: 'meta no contesta' }),
  }).ejecutar('enviar_menu', {});
  assert.equal(r.aplicado, false, 'dio por enviado un menú que no salió');
  assert.match(r.motivo, /no_se_pudo_enviar_el_menu/);
  assert.match(r.motivo, /palabras/, 'no le ofrece al modelo una salida: el cliente se queda sin nada');
});

await t('A4 · sin canal de envío lo dice, no revienta', async () => {
  const r = await ejecutorDe(nuevo(), 'el menú', null).ejecutar('enviar_menu', {});
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /sin_canal_para_el_menu/);
});

await t('A5 · mandar la carta es legal incluso con el pedido confirmado', () => {
  assert.equal(transicionLegal('enviar_menu', CONFIRMADO).legal, true);
  assert.equal(transicionLegal('enviar_menu', NAVEGANDO).legal, true);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Un pedido para otro día ──');

const TIENDA_OK = { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato-obispado' };

await t('B1 · con tienda que agenda: enlace, y NO se escala', () => {
  const r = respuestaAPedidoProgramado({ configTienda: TIENDA_OK, baseUrl: 'https://xabor.mx' });
  assert.equal(r.escalar, false, 'mandó a una persona algo que el cliente puede hacer solo');
  assert.match(r.texto, /xabor\.mx\/t\/mapolato-obispado/, 'no pegó el enlace');
  assert.match(r.texto, /hoy/i, 'no le deja la puerta abierta a pedir para hoy');
});

await t('B2 · sin tienda, o con tienda que NO agenda: a una persona', () => {
  for (const cfg of [null,
    { estado: 'borrador', aceptaProgramados: true, slug: 'x' },
    { estado: 'publicada', aceptaProgramados: false, slug: 'x' },
    { estado: 'publicada', aceptaProgramados: true, slug: null }]) {
    const r = respuestaAPedidoProgramado({ configTienda: cfg });
    assert.equal(r.escalar, true, `deberia escalar con ${JSON.stringify(cfg)}`);
    assert.ok(!/http/.test(r.texto), 'prometió una tienda que no puede agendar');
  }
});

await t('B3 · el enlace solo sale si la tienda de verdad agenda', () => {
  assert.equal(enlaceDeTienda(TIENDA_OK, { baseUrl: 'https://xabor.mx' }), 'https://xabor.mx/t/mapolato-obispado');
  assert.equal(enlaceDeTienda({ ...TIENDA_OK, aceptaProgramados: false }), null);
});

await t('B4 · un pedido para HOY no se desvía a ningún lado', () => {
  for (const m of ['quiero unos hotcakes', 'me das chilaquiles para recoger', 'a domicilio porfa']) {
    assert.equal(esSolicitudDePedidoProgramado(m, {}), false, `"${m}" se tomó por programado`);
  }
  assert.equal(esSolicitudDePedidoProgramado('quiero pedir para mañana a las 10', {}), true);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. Catering: se anota, no se cotiza ──');

await t('C1 · la herramienta no admite precios ni menús', () => {
  assert.ok(NOMBRES.includes('registrar_solicitud_evento'));
  assert.equal(validarArgumentos('registrar_solicitud_evento', { precio: 5000 }).ok, false);
  assert.equal(validarArgumentos('registrar_solicitud_evento', { menu: 'tacos' }).ok, false);
  // Conserva lo que dijo el cliente: no lo fuerza a una taxonomía cerrada.
  for (const s of ['almuerzo', 'catering', 'taquiza', 'banquete', 'buffet', 'mesa de postres']) {
    assert.equal(validarArgumentos('registrar_solicitud_evento', { tipo_servicio: s }).ok, true, s);
  }
  assert.equal(validarArgumentos('registrar_solicitud_evento', { tipo_servicio: 'x'.repeat(121) }).ok, false);
});

await t('C2 · con datos a medias NO escala: dice qué falta', async () => {
  const estado = nuevo();
  let escalado = 0;
  const efectos = { registrarEvento: async () => { escalado += 1; return { ok: true }; } };
  const r = await ejecutorDe(estado, 'Quiero un catering. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  assert.equal(r.aplicado, true);
  assert.equal(r.registrado, false, 'lo dio por registrado con un solo dato');
  assert.deepEqual(r.faltan, ['personas', 'lugar', 'fecha_hora']);
  assert.equal(escalado, 0, 'escaló con el aviso vacío: quien conteste no tendría datos');
  assert.equal(estado.hechos.escalado, false);
});

await t('C2b · 30 desayunos para recoger sigue siendo pedido, no evento', async () => {
  const estado = nuevo();
  let avisos = 0;
  const r = await ejecutorDe(estado, 'quiero 30 desayunos para recoger', {
    registrarEvento: async () => { avisos += 1; return { ok: true }; },
  }).ejecutar('registrar_solicitud_evento', {
    nombre: 'Sol', lugar: 'Sucursal', fecha_hora: 'mañana a las 10', personas: 30,
  });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /sin_senal_explicita/);
  assert.equal(estado.evento, null, 'el modelo abrió una ficha de evento sin autorización del cliente');
  assert.equal(estado.hechos.escalado, false);
  assert.equal(avisos, 0);
});

await t('C3 · los datos se ACUMULAN entre llamadas', async () => {
  const estado = nuevo();
  const recibidos = [];
  const efectos = { registrarEvento: async ({ evento }) => { recibidos.push(evento); return { ok: true }; } };
  await ejecutorDe(estado, 'Quiero catering. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  await ejecutorDe(estado, 'El lugar es Salón Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Salón Las Palmas' });
  await ejecutorDe(estado, 'El tipo de servicio es banquete estilo familiar', efectos)
    .ejecutar('registrar_solicitud_evento', { tipo_servicio: 'banquete estilo familiar' });
  const r = await ejecutorDe(estado, 'Seremos 30 personas el sábado 5 a las 2', efectos)
    .ejecutar('registrar_solicitud_evento', {
    fecha_hora: 'el sábado 5 a las 2', personas: 30,
  });

  assert.equal(r.registrado, true, `no se registró: faltan=${JSON.stringify(r.faltan)}`);
  assert.equal(recibidos.length, 1, 'llamó al efecto más de una vez');
  assert.deepEqual(recibidos[0], {
    nombre: 'Sol', lugar: 'Salón Las Palmas', fecha_hora: 'el sábado 5 a las 2',
    tipo_servicio: 'banquete estilo familiar', personas: 30,
  }, 'se perdió por el camino algún dato que el cliente ya había dado');
  assert.match(r.nota, /No le des precios/i);
});

await t('C4 · registrar un evento deja la conversación en manos de una persona', async () => {
  const estado = nuevo();
  const efectos = { registrarEvento: async () => ({ ok: true }) };
  await ejecutorDe(estado, 'Quiero mesa de postres. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol', tipo_servicio: 'mesa de postres' });
  await ejecutorDe(estado, 'El lugar es Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Las Palmas' });
  await ejecutorDe(estado, 'Seremos 40 personas el sábado a las 2pm', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: 'sábado a las 2pm', personas: 40 });
  assert.equal(estado.hechos.escalado, true);
  assert.match(estado.motivoEscalado, /mesa de postres/);
});

await t('C4b · asistentes sí bloquean; tipo de servicio no', async () => {
  const incompleto = nuevo();
  let avisos = 0;
  const efectos = { registrarEvento: async () => { avisos += 1; return { ok: true }; } };
  await ejecutorDe(incompleto, 'Quiero una taquiza. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol', tipo_servicio: 'taquiza' });
  await ejecutorDe(incompleto, 'El lugar es Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Las Palmas' });
  const sinPersonas = await ejecutorDe(incompleto, 'Será el sábado a las 2pm', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: 'sábado a las 2pm' });
  assert.equal(sinPersonas.registrado, false);
  assert.deepEqual(sinPersonas.faltan, ['personas']);
  assert.equal(avisos, 0, 'entregó el caso sin saber cuántos asistentes habrá');

  const completo = nuevo();
  await ejecutorDe(completo, 'Quiero catering. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  await ejecutorDe(completo, 'El lugar es Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Las Palmas' });
  const sinTipo = await ejecutorDe(completo, 'Seremos 40 personas el sábado a las 2pm', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: 'sábado a las 2pm', personas: 40 });
  assert.equal(sinTipo.registrado, true);
  assert.equal(sinTipo.evento.tipo_servicio, null);
  assert.equal(avisos, 1, 'el tipo opcional bloqueó el handoff completo');
});

await t('C4c · una fecha sin hora o franja no entrega el evento', async () => {
  const estado = nuevo();
  let avisos = 0;
  const efectos = { registrarEvento: async () => { avisos += 1; return { ok: true }; } };
  await ejecutorDe(estado, 'Quiero catering. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  await ejecutorDe(estado, 'El lugar es Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Las Palmas' });
  const r = await ejecutorDe(estado, 'Seremos 25 personas el sábado', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: 'sábado', personas: 25 });
  assert.equal(r.registrado, false);
  assert.deepEqual(r.faltan, ['fecha_hora']);
  assert.equal(avisos, 0, 'entregó el caso sin hora ni franja');
  assert.equal(estado.hechos.escalado, false);
});

await t('C4d · fecha y hora en turnos separados conservan ambas y entregan', async () => {
  const estado = nuevo();
  const recibidos = [];
  const efectos = { registrarEvento: async ({ evento }) => { recibidos.push(evento); return { ok: true }; } };
  await ejecutorDe(estado, 'Quiero catering. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  await ejecutorDe(estado, 'El lugar es Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Las Palmas' });
  const soloFecha = await ejecutorDe(estado, 'Seremos 25 personas el 5 de octubre', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: '5 de octubre', personas: 25 });
  assert.equal(soloFecha.registrado, false);
  assert.deepEqual(soloFecha.faltan, ['fecha_hora']);
  const completo = await ejecutorDe(estado, 'A las 2 pm', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: 'a las 2 pm' });
  assert.equal(completo.registrado, true, JSON.stringify(completo));
  assert.equal(completo.evento.fecha_hora, '5 de octubre a las 2 pm');
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].fecha_hora, '5 de octubre a las 2 pm');
});

await t('C5 · si el aviso a la persona no sale, el evento NO se da por registrado', async () => {
  const estado = nuevo();
  const efectos = { registrarEvento: async () => ({ ok: false, motivo: 'sin destino' }) };
  await ejecutorDe(estado, 'Quiero catering. Me llamo Sol', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  await ejecutorDe(estado, 'El lugar es Las Palmas', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Las Palmas' });
  const r = await ejecutorDe(estado, 'Seremos 25 personas el sábado a las 2pm', efectos)
    .ejecutar('registrar_solicitud_evento', {
      fecha_hora: 'sábado a las 2pm', tipo_servicio: 'cena', personas: 25 });
  assert.equal(r.aplicado, false, 'le dijo al cliente que alguien le llamaría y nadie se enteró');
  assert.equal(estado.hechos.escalado, false);
});

await t('C6 · un evento NO toca el carrito ni el pedido', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const antes = JSON.stringify(estado.carrito);
  await ejecutorDe(estado, 'Y quiero catering. Me llamo Sol', { registrarEvento: async () => ({ ok: true }) })
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol', tipo_servicio: 'almuerzo' });
  assert.equal(JSON.stringify(estado.carrito), antes, 'el evento se coló en el carrito');
});

await t('C7 · con la conversación ya escalada, no se anota otro evento encima', () => {
  assert.equal(transicionLegal('registrar_solicitud_evento', ESCALADO).legal, false);
  assert.equal(transicionLegal('registrar_solicitud_evento', CONFIRMADO).legal, true,
    'después de cerrar un desayuno se tiene que poder pedir un evento');
});

await t('C8 · el texto final no puede cotizar ni prometer agenda', () => {
  const completa = { texto: 'Listo, quedó agendado por $500', operaciones: [{
    herramienta: 'registrar_solicitud_evento',
    resultado: { aplicado: true, registrado: true },
  }] };
  const d1 = aplicarSalidaSeguraDeCatering(completa, { eventoActivo: true });
  assert.equal(d1.salida.texto, MENSAJE_CATERING_ENTREGADO);
  assert.equal(d1.requiereHandoff, false);

  const parcial = { texto: 'El precio sería $500 y quedó reservado', operaciones: [{
    herramienta: 'registrar_solicitud_evento',
    resultado: { aplicado: true, registrado: false, faltan: ['personas'] },
  }] };
  const d2 = aplicarSalidaSeguraDeCatering(parcial, {
    eventoActivo: true, evento: { nombre: 'Sol' },
  });
  assert.match(d2.salida.texto, /cuántas personas/i);
  assert.equal(d2.requiereHandoff, false);

  const rechazadaFueraDeCatering = { texto: '¿Qué deseas ordenar?', operaciones: [{
    herramienta: 'registrar_solicitud_evento',
    resultado: { aplicado: false, motivo: 'solicitud_evento_sin_senal_explicita' },
  }] };
  const d3 = aplicarSalidaSeguraDeCatering(rechazadaFueraDeCatering);
  assert.equal(d3.salida.texto, '¿Qué deseas ordenar?');
  assert.equal(d3.requiereHandoff, false);
});

await t('C9 · la evidencia no confunde subcadenas, fechas, direcciones ni tipos', () => {
  for (const [mensaje, datos] of [
    ['Me llamo Mariana', { nombre: 'Ana' }],
    ['Será el 20/10/2026 a las 10', { personas: 20 }],
    ['Será en Calle 80', { personas: 80 }],
    ['Hace frío', { lugar: 'Río' }],
    ['40 personas', { nombre: ['40 personas'] }],
    ['Estoy interesada en catering', { lugar: 'catering' }],
    ['Trabajo en marketing', { lugar: 'marketing' }],
    ['Soy de Monterrey', { nombre: 'de Monterrey' }],
    ['Soy una empresa', { nombre: 'una empresa' }],
  ]) {
    const r = filtrarDatosEventoCatering(datos, { mensaje, eventoPrevio: {} });
    assert.deepEqual(r.aceptados, {}, `${mensaje} aceptó ${JSON.stringify(datos)}`);
  }
  const legacy = filtrarCapturasCatering([
    { campo: 'nombre', valor: 'Ana' }, { campo: 'numero_personas', valor: 20 },
  ], { mensaje: 'Me llamo Mariana; será el 20/10/2026', camposPrevios: {} });
  assert.deepEqual(legacy.aceptadas, []);
});

await t('C9b · respuestas naturales de asistentes se aceptan solo cuando se esperan', () => {
  for (const mensaje of [
    'Somos 40', 'Seríamos 40', 'Van a ser 40', 'Para 40', 'Unas 40',
    'Aproximadamente 40', '40 en total',
  ]) {
    const esperada = filtrarDatosEventoCatering(
      { personas: 40 }, { mensaje, eventoPrevio: { nombre: 'Ana' } });
    assert.equal(esperada.aceptados.personas, 40, mensaje);

    const fueraDeTurno = filtrarDatosEventoCatering(
      { personas: 40 }, { mensaje, eventoPrevio: {} });
    assert.deepEqual(fueraDeTurno.aceptados, {}, `${mensaje} autorizó asistentes fuera de turno`);
  }
  for (const mensaje of ['Calle 40', 'Será el 40/10/2026', 'A las 40', 'Mi presupuesto es 40']) {
    const r = filtrarDatosEventoCatering(
      { personas: 40 }, { mensaje, eventoPrevio: { nombre: 'Ana' } });
    assert.deepEqual(r.aceptados, {}, mensaje);
  }
  const escrita = filtrarDatosEventoCatering(
    { personas: 50 }, { mensaje: 'Seremos cincuenta personas', eventoPrevio: { nombre: 'Ana' } });
  assert.equal(escrita.aceptados.personas, 50);
  const calleEscrita = filtrarDatosEventoCatering(
    { personas: 50 }, { mensaje: 'Calle Cincuenta', eventoPrevio: { nombre: 'Ana' } });
  assert.deepEqual(calleEscrita.aceptados, {});
});

await t('C9c · datos negados no se aceptan y una corrección afirmativa sí', () => {
  const casosNegados = [
    [{ nombre: 'Ana' }, 'No me llamo Ana'],
    [{ personas: 20 }, 'No somos 20 personas'],
    [{ personas: 20 }, 'No somos veinte personas'],
    [{ fecha_hora: '5 de octubre a las 2 pm' }, 'El 5 de octubre a las 2 pm no puedo'],
  ];
  for (const [datos, mensaje] of casosNegados) {
    const r = filtrarDatosEventoCatering(datos, { mensaje, eventoPrevio: {} });
    assert.deepEqual(r.aceptados, {}, mensaje);
  }

  const corregida = filtrarDatosEventoCatering(
    { personas: 30 },
    { mensaje: 'No somos 20, sino 30 personas', eventoPrevio: { personas: 20 } },
  );
  assert.equal(corregida.aceptados.personas, 30);
  assert.deepEqual(corregida.invalidados, ['personas']);
  const corregidaConPunto = filtrarDatosEventoCatering(
    { personas: 30 },
    { mensaje: 'No somos 20. Somos 30 personas.', eventoPrevio: { personas: 20 } },
  );
  assert.equal(corregidaConPunto.aceptados.personas, 30);
  assert.deepEqual(corregidaConPunto.invalidados, ['personas']);
});

await t('C9d · negar un valor previo lo borra antes de evaluar completitud', async () => {
  const estado = nuevo();
  const efectos = { registrarEvento: async () => ({ ok: true }) };
  await ejecutorDe(estado, 'Quiero catering. Me llamo Ana', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Ana' });
  await ejecutorDe(estado, 'Somos 20 personas', efectos)
    .ejecutar('registrar_solicitud_evento', { personas: 20 });
  await ejecutorDe(estado, 'Será en Jardín', efectos)
    .ejecutar('registrar_solicitud_evento', { lugar: 'Jardín' });
  await ejecutorDe(estado, 'El 5 de octubre', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: '5 de octubre' });
  const r = await ejecutorDe(estado, 'El 5 de octubre no puedo', efectos)
    .ejecutar('registrar_solicitud_evento', { fecha_hora: '5 de octubre' });
  assert.equal(r.registrado, false);
  assert.equal(r.evento.fecha_hora, null);
  assert.ok(r.faltan.includes('fecha_hora'));

  const sinHerramienta = nuevo();
  sinHerramienta.evento = sellarEventoCatering({
    nombre: 'Ana', personas: 20, lugar: 'Jardín', fecha_hora: '5 de octubre a las 2 pm',
  }, ['nombre', 'personas', 'lugar', 'fecha_hora']);
  assert.equal(prepararEstadoCatering(
    sinHerramienta, 'El 5 de octubre a las 2 pm no puedo',
  ), true);
  assert.equal(eventoCateringPublico(sinHerramienta.evento).fecha_hora, undefined,
    'sin tool_use, la fecha negada siguió siendo un hecho durable');
});

await t('C10 · una ficha pre-fix sin firmas se purga y no completa el evento', () => {
  const estado = nuevo();
  estado.evento = {
    nombre: 'Inventado', personas: 50, lugar: 'Lugar falso', fecha_hora: 'sábado a las 2pm',
  };
  assert.equal(prepararEstadoCatering(estado, 'sí'), true);
  assert.deepEqual(eventoCateringPublico(estado.evento), {});

  const legacyVieja = camposCateringVerificados({
    nombre: 'Inventado', numero_personas: 50, lugar: 'Lugar falso',
    fecha_evento: 'sábado a las 2pm', __perfil_catering: true,
  });
  assert.deepEqual(Object.keys(legacyVieja).sort(),
    ['__evidencia_catering_v1', '__perfil_catering']);

  const firmado = sellarCamposCatering({ nombre: 'Ana', __perfil_catering: true }, ['nombre']);
  assert.equal(camposCateringVerificados(firmado, { nombreConfiable: 'Otro nombre' }).nombre,
    'Ana', 'el nombre confiable del perfil no debe pisar uno ya verificado del cliente');
});

await t('C11 · durante catering ninguna herramienta de pedido puede mutar', async () => {
  const estado = nuevo();
  prepararEstadoCatering(estado, 'Quiero catering', { nombreConfiable: 'Sol' });
  const r = await ejecutorDe(estado, 'quiero hotcakes')
    .ejecutar('agregar_producto', { producto_id: '90' });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /flujo_catering_activo/);
  assert.equal(estado.carrito.items.length, 0);
});

await t('C12 · el cliente puede abandonar catering sin quedar atrapado', async () => {
  const estado = nuevo();
  prepararEstadoCatering(estado, 'Quiero catering', { nombreConfiable: 'Sol' });
  assert.equal(prepararEstadoCatering(
    estado, 'Catering no, mejor quiero ordenar chilaquiles'), false);
  assert.equal(estado.evento, null);
  const r = await ejecutorDe(estado, 'quiero chilaquiles')
    .ejecutar('agregar_producto', { producto_id: '85' });
  assert.equal(r.aplicado, true, r.motivo);

  prepararEstadoCatering(estado, 'Quiero catering', { nombreConfiable: 'Sol' });
  assert.equal(prepararEstadoCatering(
    estado, 'No quiero catering, prefiero mesa de postres'), true,
  'eligió otro servicio de evento; no debía borrar la ficha');
  assert.ok(estado.evento);

  for (const mensaje of [
    'Ya no quiero catering', 'Cancela la solicitud', 'Olvida el evento',
    'Cancela mi solicitud de catering', 'Cancela el catering',
    'Quiero cancelar el servicio de catering',
  ]) {
    const otro = nuevo();
    prepararEstadoCatering(otro, 'Quiero catering', { nombreConfiable: 'Sol' });
    assert.equal(prepararEstadoCatering(otro, mensaje), false, mensaje);
    assert.equal(otro.evento, null, mensaje);
  }

  // Una ficha de evento puede convivir con un carrito iniciado antes. La
  // cancelación se consume como respuesta determinista antes del modelo: no
  // debe transformarse en `cancelar_pedido` ni borrar ese carrito.
  const conCarrito = nuevo();
  conCarrito.carrito.items.push({ lid: 'existente', productoId: '90', nombre: 'Hotcakes', cantidad: 2 });
  const carritoAntes = structuredClone(conCarrito.carrito);
  prepararEstadoCatering(conCarrito, 'Quiero catering', { nombreConfiable: 'Sol' });
  assert.equal(prepararEstadoCatering(conCarrito, 'Cancela el catering'), false);
  const cancelacion = consumirCancelacionCatering(conCarrito);
  assert.equal(cancelacion?.texto, TEXTO_CATERING_CANCELADO);
  assert.deepEqual(conCarrito.carrito, carritoAntes,
    'cancelar la ficha de evento borró o modificó el pedido existente');
  assert.equal(consumirCancelacionCatering(conCarrito), null,
    'la respuesta de cancelación debe consumirse una sola vez');
});

await t('C13 · catering recopila datos aun cerrado y sin catálogo', () => {
  const estado = nuevo();
  assert.equal(bloqueoPrevioDelAgente({
    eventoActivo: true, estadoRestaurante: { abierto: false }, catalogo: [], estado,
  }), null);
  assert.equal(bloqueoPrevioDelAgente({
    eventoActivo: false, estadoRestaurante: { abierto: false }, catalogo: [], estado,
  }), 'fuera_horario');
  assert.equal(bloqueoPrevioDelAgente({
    eventoActivo: false, estadoRestaurante: { abierto: true }, catalogo: [], estado,
  }), 'sin_catalogo');
});

await t('C14 · el modelo no entrega una ficha incompleta salvo petición humana explícita', async () => {
  const estado = nuevo();
  prepararEstadoCatering(estado, 'Quiero catering', { nombreConfiable: 'Sol' });
  let avisos = 0;
  const prematuro = await ejecutorDe(estado, 'gracias', {
    escalar: async () => { avisos += 1; return { ok: true }; },
  }).ejecutar('pedir_humano', { motivo: 'evento' });
  assert.equal(prematuro.aplicado, false);
  assert.match(prematuro.motivo, /catering_datos_incompletos/);
  assert.equal(avisos, 0);

  const pedido = await ejecutorDe(estado, 'Quiero hablar con una persona', {
    escalar: async () => { avisos += 1; return { ok: true }; },
  }).ejecutar('pedir_humano', { motivo: 'lo pidió el cliente' });
  assert.equal(pedido.aplicado, true, pedido.motivo);
  assert.equal(avisos, 1);
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
