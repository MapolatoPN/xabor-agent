import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { obtenerEstadoRestaurante } from '../src/agent/prompts.js';
import {
  construirAvisoFueraDeHorario, enlaceDeTienda, horaParaCliente, siguienteApertura,
} from '../src/mesero-agente/horarioDelAgente.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
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

t('el adaptador corta antes de programados y antes del modelo', () => {
  const fuente = readFileSync(`${RAIZ}/src/mesero-agente/canalDelAgente.js`, 'utf8');
  const funcion = fuente.indexOf('export async function atenderConAgente');
  const aviso = fuente.indexOf('construirAvisoFueraDeHorario({', funcion);
  const programado = fuente.indexOf('esSolicitudDePedidoProgramado(mensaje', funcion);
  const modelo = fuente.indexOf('salida = await atenderTurnoConHerramientas({', funcion);
  assert.ok(funcion >= 0 && aviso > funcion && programado > aviso && modelo > programado,
    'el aviso de cierre debe salir antes de entregar programados o llamar al modelo');
});

if (!process.exitCode) console.log(`RESULTADO: ${pasadas} verificaciones pasaron.`);
