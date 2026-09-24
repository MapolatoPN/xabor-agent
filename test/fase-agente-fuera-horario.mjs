import assert from 'node:assert/strict';
import { obtenerEstadoRestaurante } from '../src/agent/prompts.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import {
  marcarProgramacionRequerida, puedeContinuarConLocalCerrado,
} from '../src/mesero-agente/canalDelAgente.js';
import {
  construirAvisoFueraDeHorario, enlaceDeTienda, horaParaCliente, siguienteApertura,
} from '../src/mesero-agente/horarioDelAgente.js';

const horarios = Object.fromEntries([
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
].map((dia) => [dia, { abierto: true, apertura: '07:30', cierre: '14:45' }]));
const reglas = { timezone: 'UTC', horarios, cierres_especiales: [], promociones: [] };

let pasadas = 0;
const t = (nombre, fn) => {
  try {
    fn();
    pasadas += 1;
    console.log(`OK ${nombre}`);
  } catch (e) {
    console.error(`FALLO ${nombre}: ${e.message}`);
    process.exitCode = 1;
  }
};

t('respeta los minutos de la apertura', () => {
  const antes = obtenerEstadoRestaurante(reglas, new Date('2026-09-21T07:29:00Z'));
  assert.equal(antes.abierto, false);
  assert.equal(antes.preApertura, true);
  const apertura = obtenerEstadoRestaurante(reglas, new Date('2026-09-21T07:30:00Z'));
  assert.equal(apertura.abierto, true);
});

t('respeta los minutos del cierre', () => {
  assert.equal(obtenerEstadoRestaurante(reglas, new Date('2026-09-21T14:44:00Z')).abierto, true);
  assert.equal(obtenerEstadoRestaurante(reglas, new Date('2026-09-21T14:45:00Z')).abierto, false);
});

t('formatea 07:30 como hora legible', () => {
  assert.equal(horaParaCliente('07:30'), '7:30 a. m.');
  assert.equal(horaParaCliente('14:45'), '2:45 p. m.');
});

t('después del cierre encuentra la apertura de mañana', () => {
  const estado = obtenerEstadoRestaurante(reglas, new Date('2026-09-21T15:00:00Z'));
  assert.deepEqual(siguienteApertura(reglas, estado), {
    diasHasta: 1, dia: 'martes', fecha: '2026-09-22', apertura: '07:30',
  });
});

t('antes de abrir informa la apertura de hoy', () => {
  const estado = obtenerEstadoRestaurante(reglas, new Date('2026-09-21T06:00:00Z'));
  assert.equal(siguienteApertura(reglas, estado)?.diasHasta, 0);
});

t('omite un día con cierre especial completo', () => {
  const reglasConCierre = {
    ...reglas,
    cierres_especiales: [{ fecha: '2026-09-22', motivo: 'mantenimiento' }],
  };
  const estado = obtenerEstadoRestaurante(reglasConCierre, new Date('2026-09-21T15:00:00Z'));
  assert.deepEqual(siguienteApertura(reglasConCierre, estado), {
    diasHasta: 2, dia: 'miércoles', fecha: '2026-09-23', apertura: '07:30',
  });
});

t('usa la tienda publicada que acepta programados', () => {
  const configTienda = { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato-obispado' };
  assert.equal(enlaceDeTienda(configTienda, { baseUrl: 'https://xabor.mx/' }),
    'https://xabor.mx/t/mapolato-obispado');
  const estado = obtenerEstadoRestaurante(reglas, new Date('2026-09-21T15:00:00Z'));
  assert.equal(construirAvisoFueraDeHorario({
    estadoRestaurante: estado, reglas, configTienda, baseUrl: 'https://xabor.mx/',
  }), 'Hola, por el momento ya cerramos. Si deseas agendar un pedido, puedes hacerlo en nuestra tienda en línea: '
    + 'https://xabor.mx/t/mapolato-obispado. Si tienes alguna otra duda, nuestro personal entra mañana a las 7:30 a. m.');
});

t('no ofrece una tienda que no puede agendar', () => {
  const estado = obtenerEstadoRestaurante(reglas, new Date('2026-09-21T15:00:00Z'));
  const texto = construirAvisoFueraDeHorario({
    estadoRestaurante: estado,
    reglas,
    configTienda: { estado: 'publicada', aceptaProgramados: false, slug: 'sin-programados' },
  });
  assert.doesNotMatch(texto, /\/t\//);
  assert.doesNotMatch(texto, /agendar un pedido/);
  assert.match(texto, /mañana a las 7:30 a\. m\./);
});

t('cerrado corta pedidos inmediatos, pero deja armar uno futuro autorizado', () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
  const tienda = { aceptaProgramados: true, anticipacionMinutos: 40 };
  assert.equal(puedeContinuarConLocalCerrado(estado, tienda), false,
    'un pedido inmediato podría entrar con cocina cerrada');
  marcarProgramacionRequerida(estado, 'quiero hacer un pedido para mañana a las 10');
  assert.equal(puedeContinuarConLocalCerrado(estado, tienda), true,
    'el canario sigue desviando a tienda un pedido que ya puede programar');
});

t('cerrado reconoce fechas naturales sin secuestrar preguntas', () => {
  const tienda = { aceptaProgramados: true, anticipacionMinutos: 40 };
  for (const mensaje of [
    'quiero pedir para el 25 de septiembre',
    'quiero pedir para el 25 sep',
    'quiero pedir para 2026-09-25',
    'dos waffles el 25',
    'dos waffles el 25 a las 10',
    'dos waffles 25/09',
    'dos waffles el 25 de septiembre',
  ]) {
    const estado = estadoNuevo({ negocioId: 'n1', conversacionId: mensaje });
    assert.equal(marcarProgramacionRequerida(estado, mensaje), true, mensaje);
    assert.equal(puedeContinuarConLocalCerrado(estado, tienda), true, mensaje);
  }
  for (const mensaje of [
    '¿Abren el 25 de septiembre?', '¿Qué promociones hay el 25 sep?',
    '¿Tienen pedidos para el 25 de septiembre?', 'No quiero pedir mañana',
    'Quiero 2-3 tacos', '¿Dónde entregan el 25 sep?',
    'Quiero que me avisen el viernes',
    'Quiero cancelar mi pedido del viernes',
    'Necesito facturar el pedido del viernes',
    'Quiero reservar una mesa para el viernes a las 8',
  ]) {
    const estado = estadoNuevo({ negocioId: 'n1', conversacionId: mensaje });
    assert.equal(marcarProgramacionRequerida(estado, mensaje), false, mensaje);
    assert.equal(puedeContinuarConLocalCerrado(estado, tienda), false, mensaje);
  }
});

t('una corrección a hoy limpia la programación durable', () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'c-hoy' });
  marcarProgramacionRequerida(estado, 'quiero pedir para mañana');
  estado.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
  assert.equal(estado.programacionRequerida, true);
  marcarProgramacionRequerida(estado, 'mejor para hoy');
  assert.equal(estado.programacionRequerida, false);
  assert.equal('programado_para' in estado.carrito.datos, false);

  estado.programacionRequerida = true;
  estado.carrito.datos.programado_para = '2026-09-26T15:00:00.000Z';
  marcarProgramacionRequerida(estado, 'ya no mañana');
  assert.equal(estado.programacionRequerida, false);
  assert.equal('programado_para' in estado.carrito.datos, false);

  estado.programacionRequerida = true;
  estado.carrito.datos.programado_para = '2026-09-26T15:00:00.000Z';
  marcarProgramacionRequerida(estado, 'no mañana, hoy');
  assert.equal(estado.programacionRequerida, false);
  assert.equal('programado_para' in estado.carrito.datos, false);
});

t('acepta_programados=false mantiene el corte aun con intención futura', () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'c2' });
  marcarProgramacionRequerida(estado, 'quiero hacer un pedido para mañana a las 10');
  assert.equal(puedeContinuarConLocalCerrado(estado, { aceptaProgramados: false }), false);
});

if (!process.exitCode) console.log(`RESULTADO: ${pasadas} verificaciones pasaron.`);
