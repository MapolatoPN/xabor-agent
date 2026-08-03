// Suite persistida: normalizarFecha.js (hotfix migración 031). Pruebas
// puras -- sin DB, sin servidor -- de la validación determinista de
// fechas en lenguaje natural que el Asistente Comercial ya no puede
// escribir directamente en una columna DATE.
import assert from 'assert';
import { normalizarFechaEvento } from '../src/agent/normalizarFecha.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Lunes 2026-08-03T12:00:00Z -- mediodía UTC cae de tarde en
// America/Matamoros (UTC-5/-6), mismo día calendario en ambas zonas, para
// no depender de la hora exacta del corte de medianoche en este ancla.
const AHORA = new Date('2026-08-03T12:00:00Z');
const OPTS = { ahora: AHORA };

t('"20 de septiembre" (sin año) -> año actual, formato ISO', () => {
  const r = normalizarFechaEvento('20 de septiembre', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-09-20');
});

t('"20 de septiembre de 2026" (con año explícito)', () => {
  const r = normalizarFechaEvento('20 de septiembre de 2026', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-09-20');
});

t('"20 de septiembre" sin año, si ya pasó este año, rueda al año siguiente', () => {
  const ahoraTarde = new Date('2026-10-01T12:00:00Z'); // ya pasamos el 20 de septiembre de 2026
  const r = normalizarFechaEvento('20 de septiembre', { ahora: ahoraTarde });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2027-09-20');
});

t('fecha relativa: "mañana"', () => {
  const r = normalizarFechaEvento('mañana', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-04');
});

t('fecha relativa: "pasado mañana"', () => {
  const r = normalizarFechaEvento('pasado mañana', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-05');
});

t('fecha relativa: "hoy"', () => {
  const r = normalizarFechaEvento('hoy', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-03');
});

t('"este viernes" -> próxima ocurrencia incluyendo hoy (2026-08-03 es lunes)', () => {
  const r = normalizarFechaEvento('este viernes', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-07');
});

t('"el próximo sábado" -> excluye hoy, 1-7 días adelante', () => {
  const r = normalizarFechaEvento('el próximo sábado', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-08');
});

t('"este lunes" dicho un lunes -> hoy mismo (regla documentada: "este" incluye hoy)', () => {
  const r = normalizarFechaEvento('este lunes', OPTS); // 2026-08-03 es lunes
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-03');
});

t('"el próximo lunes" dicho un lunes -> el lunes siguiente, no hoy (regla documentada: "próximo" excluye hoy)', () => {
  const r = normalizarFechaEvento('el próximo lunes', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-10');
});

t('formato explícito DD/MM/YYYY', () => {
  const r = normalizarFechaEvento('20/09/2026', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-09-20');
});

t('formato ISO ya completo pasa sin cambios', () => {
  const r = normalizarFechaEvento('2026-09-20', OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-09-20');
});

t('fecha imposible: 31 de febrero (texto natural)', () => {
  const r = normalizarFechaEvento('31 de febrero', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'imposible');
});

t('fecha imposible: 31/02/2026 (DD/MM/YYYY)', () => {
  const r = normalizarFechaEvento('31/02/2026', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'imposible');
});

t('fecha imposible: mes fuera de rango en ISO', () => {
  const r = normalizarFechaEvento('2026-13-01', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'imposible');
});

t('fecha pasada: año explícito ya pasado nunca rueda de año', () => {
  const r = normalizarFechaEvento('20 de septiembre de 2020', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'pasada');
});

t('fecha pasada: ISO explícito anterior a hoy', () => {
  const r = normalizarFechaEvento('2026-01-01', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'pasada');
});

t('fecha ambigua: "en septiembre" (mes sin día)', () => {
  const r = normalizarFechaEvento('en septiembre', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'ambigua');
});

t('fecha ambigua: "la próxima semana" (sin día concreto)', () => {
  const r = normalizarFechaEvento('la próxima semana', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'ambigua');
});

t('fecha ambigua: día de la semana solo, sin "este"/"próximo"', () => {
  const r = normalizarFechaEvento('viernes', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'ambigua');
});

t('texto no reconocido: gibberish', () => {
  const r = normalizarFechaEvento('asdkjaslkdj', OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'no_reconocida');
});

t('texto no reconocido: vacío/null/undefined', () => {
  assert.strictEqual(normalizarFechaEvento('', OPTS).motivo, 'no_reconocida');
  assert.strictEqual(normalizarFechaEvento(null, OPTS).motivo, 'no_reconocida');
  assert.strictEqual(normalizarFechaEvento(undefined, OPTS).motivo, 'no_reconocida');
});

t('zona horaria del negocio (America/Matamoros): "hoy" cerca de medianoche UTC no se corre de día', () => {
  // 2026-08-04T04:00:00Z = 2026-08-03 22:00 o 23:00 en Matamoros (UTC-5/-6)
  // -- todavía el día 3 en la zona del negocio, aunque en UTC ya sea el día 4.
  const ahoraCercaMedianocheUTC = new Date('2026-08-04T04:00:00Z');
  const r = normalizarFechaEvento('hoy', { ahora: ahoraCercaMedianocheUTC });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.iso, '2026-08-03', 'debe seguir siendo 3 de agosto en America/Matamoros, no ya el 4 como en UTC');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas > 0) {
  console.log('\nFallos:');
  fallos.forEach(f => console.log(' - ' + f));
  process.exitCode = 1;
}
