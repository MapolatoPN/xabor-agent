// Regresión del 29-sep: 04:30 -> 00:00 dejaba cerrado todo el lunes.
// Funciones productivas, reloj fijo, sin consultas, mensajes, pagos ni impresión.
import assert from 'node:assert/strict';
import { obtenerEstadoRestaurante } from '../src/agent/prompts.js';
import { estadoApertura } from '../src/services/tiendaOnline.js';
import { validarProgramacion } from '../src/services/tiendaCheckout.js';
import { validarProgramado } from '../src/mesero-agente/programadoDelAgente.js';
import { bloqueoPrevioDelAgente } from '../src/mesero-agente/canalDelAgente.js';
import { siguienteApertura } from '../src/mesero-agente/horarioDelAgente.js';

const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const reglasBase = () => ({
  timezone: 'UTC',
  horarios: Object.fromEntries(dias.map(d => [d, { abierto: false, apertura: null, cierre: null }])),
  cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { costo_envio: 0, pedido_minimo_entrega: 0 },
});
const lunes = (apertura, cierre) => {
  const r = reglasBase(); r.horarios.lunes = { abierto: true, apertura, cierre }; return r;
};
let casos = 0;
function comprobar(r, iso, abierto, descripcion) {
  const instante = new Date(iso);
  const estado = obtenerEstadoRestaurante(r, instante);
  assert.equal(estado.abierto, abierto, `Mesero: ${descripcion}`);
  assert.equal(estadoApertura(r, instante).abierto, abierto, `Tienda: ${descripcion}`);
  assert.equal(bloqueoPrevioDelAgente({ estadoRestaurante: estado, catalogo: [{}] }),
    abierto ? null : 'fuera_horario', `Canal: ${descripcion}`);
  casos++;
}

for (const cierre of ['00:00', '24:00']) {
  const r = lunes('04:30', cierre);
  for (const [hora, abierto] of [['04:29', false], ['04:30', true], ['10:00', true], ['23:59', true]]) {
    comprobar(r, `2026-09-28T${hora}:00Z`, abierto, `lunes 04:30-${cierre}, ${hora}`);
  }
  comprobar(r, '2026-09-29T00:00:00Z', false, `cierre exacto ${cierre}`);
  for (const hora_cierre of ['00:00', '01:00']) {
    const especial = structuredClone(r);
    especial.cierres_especiales = [{ fecha: '2026-09-28', hora_cierre }];
    comprobar(especial, '2026-09-28T23:59:00Z', true, `especial ${hora_cierre} no amplía ni borra jornada ${cierre}`);
    comprobar(especial, '2026-09-29T00:00:00Z', false, 'especial no extiende medianoche');
  }
}

const nocturno = lunes('18:00', '00:45');
for (const [iso, abierto] of [
  ['2026-09-28T00:20:00Z', false], // no heredar la noche del lunes al lunes de madrugada
  ['2026-09-28T17:59:00Z', false], ['2026-09-28T18:00:00Z', true],
  ['2026-09-28T23:59:00Z', true], ['2026-09-29T00:00:00Z', true],
  ['2026-09-29T00:44:59Z', true], ['2026-09-29T00:45:00Z', false],
  ['2026-09-29T18:00:00Z', false],
]) comprobar(nocturno, iso, abierto, `nocturno ${iso}`);

// El martes desmarcado impide abrir una jornada NUEVA, no corta el lunes.
assert.equal(estadoApertura(nocturno, new Date('2026-09-29T00:20:00Z')).cierraA, '00:45');
const reapertura = structuredClone(nocturno);
reapertura.horarios.martes = { abierto: true, apertura: '07:30', cierre: '14:45' };
const despues = obtenerEstadoRestaurante(reapertura, new Date('2026-09-29T00:45:00Z'));
assert.equal(despues.preApertura, true);
assert.equal(siguienteApertura(reapertura, despues).diasHasta, 0);
assert.deepEqual(estadoApertura(reapertura, new Date('2026-09-29T00:45:00Z')),
  { abierto: false, abreA: '07:30', cuando: 'hoy' });

for (const [fecha, hora_cierre, iso, abierto] of [
  ['2026-09-28', null, '2026-09-29T00:20:00Z', false],
  ['2026-09-29', null, '2026-09-29T00:20:00Z', false],
  ['2026-09-28', '22:00', '2026-09-28T21:59:00Z', true],
  ['2026-09-28', '22:00', '2026-09-28T22:00:00Z', false],
  ['2026-09-28', '22:00', '2026-09-29T00:20:00Z', false],
  ['2026-09-28', '00:30', '2026-09-28T23:59:00Z', true],
  ['2026-09-28', '00:30', '2026-09-29T00:29:00Z', true],
  ['2026-09-28', '00:30', '2026-09-29T00:30:00Z', false],
  ['2026-09-28', '02:00', '2026-09-29T00:45:00Z', false], // especial nunca amplía
  ['2026-09-29', '00:15', '2026-09-29T00:14:00Z', true],
  ['2026-09-29', '00:15', '2026-09-29T00:15:00Z', false],
  ['2026-09-28', '25:00', '2026-09-28T20:00:00Z', false],
]) {
  const r = structuredClone(nocturno); r.cierres_especiales = [{ fecha, hora_cierre }];
  comprobar(r, iso, abierto, `especial ${fecha}/${hora_cierre}, ${iso}`);
  if (abierto && hora_cierre && hora_cierre !== '02:00') {
    assert.equal(estadoApertura(r, new Date(iso)).cierraA, hora_cierre, 'mostrar el cierre efectivo');
  }
}

for (const [abre, cierra] of [['07:30', '07:30'], ['00:00', '00:00'], ['24:00', '04:00'],
  ['07:60', '14:00'], ['07:30', '25:00'], ['07:30', '14:00 basura']]) {
  comprobar(lunes(abre, cierra), '2026-09-28T12:00:00Z', false, `horario vacío/inválido ${abre}/${cierra}`);
}
const completo = lunes('00:00', '24:00');
comprobar(completo, '2026-09-28T00:00:00Z', true, '24 horas explícitas');
comprobar(completo, '2026-09-28T23:59:00Z', true, '24 horas explícitas final');
const diurno = lunes('07:30', '14:45');
for (const [h, a] of [['07:29', false], ['07:30', true], ['14:44', true], ['14:45', false]]) {
  comprobar(diurno, `2026-09-28T${h}:00Z`, a, `diurno ${h}`);
}
const finSemana = reglasBase();
finSemana.horarios.domingo = { abierto: true, apertura: '20:00', cierre: '02:00' };
comprobar(finSemana, '2026-09-28T01:59:00Z', true, 'domingo -> lunes');
comprobar(finSemana, '2026-09-28T02:00:00Z', false, 'domingo -> lunes cierre');
const finAno = reglasBase();
finAno.horarios.jueves = { abierto: true, apertura: '20:00', cierre: '02:00' };
comprobar(finAno, '2027-01-01T01:59:00Z', true, 'cambio de año');

const real = lunes('04:30', '00:00'); real.timezone = 'America/Matamoros';
comprobar(real, '2026-09-29T03:20:43.922Z', true, 'Hola real 22:20 lunes');
comprobar(real, '2026-09-29T05:00:00Z', false, 'medianoche Matamoros');
for (const iso of ['2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z']) {
  const r = reglasBase(); r.timezone = 'America/Matamoros';
  r.horarios.sabado = { abierto: true, apertura: '20:00', cierre: '02:00' };
  comprobar(r, iso, true, 'ambas ocurrencias de 01:30 al cambiar horario');
}

// La validación final de programados conserva anticipación/política y evalúa
// la jornada de origen, aunque el día de entrega no abra una jornada propia.
for (const [r, fecha, hora, ok] of [
  [nocturno, '2026-09-28', '23:00', true],
  [nocturno, '2026-09-29', '00:20', true],
  [nocturno, '2026-09-29', '00:45', false],
  [real, '2026-09-28', '22:20', true],
]) {
  const ahora = new Date('2026-09-28T00:00:00Z');
  const tienda = { aceptaProgramados: true, anticipacionMinutos: 60 };
  const agente = validarProgramado({ fecha, hora, reglas: r, zona: r.timezone, configTienda: tienda, ahora });
  assert.equal(agente.ok, ok, `Programado Mesero ${fecha} ${hora}: ${agente.motivo}`);
  const ejecutar = () => validarProgramacion({ tienda, reglas: r, programadoPara: `${fecha}T${hora}`, ahora });
  if (ok) assert.equal(ejecutar().programado, true); else assert.throws(ejecutar);
  casos++;
}
console.log(`OK horarios medianoche: ${casos} escenarios; Mesero, canal, Tienda y programación.`);
