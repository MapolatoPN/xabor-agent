// ─── Un programado cuenta por el día PARA EL QUE se programó ──────────────
//
// Regla pura de orders/diaOperativoDelPedido.js, la que deciden el volcado
// del tablero al recargar y el `deHoy` de Domicilio. Sin base ni servidor: el
// cableado real (WebSocket y /api/pos/envios) lo prueba
// fase-programado-dia-operativo-tablero.mjs.
//
// Caso real (9-oct, Mapolato Acuña): XAB-1401 se registró el 8-oct a las
// 22:10 para el 9-oct a las 8:30. Activado a las 7:34, desapareció de «En
// curso» en el primer F5 porque el filtro miraba solo el día de registro.
import assert from 'assert';
import { esDelDiaOperativo } from '../src/orders/diaOperativoDelPedido.js';

const TZ = 'America/Matamoros';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fechaOperativa = (instante) => fmt.format(instante);
const HOY = '2026-10-09';

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const del = (p) => esDelDiaOperativo(p, HOY, fechaOperativa);

t('0. el formateador da el día local de Matamoros (precondición de la suite)', () => {
  assert.strictEqual(fechaOperativa(new Date('2026-10-09T03:10:28Z')), '2026-10-08');
  assert.strictEqual(fechaOperativa(new Date('2026-10-09T13:30:00Z')), '2026-10-09');
});

t('1. XAB-1401: registrado anoche 22:10, programado hoy 8:30 → del día', () => {
  assert.strictEqual(del({ timestamp: '2026-10-09T03:10:28.025Z', programado_para: '2026-10-09T13:30:00.000Z' }), true);
});

t('2. pedido normal registrado hoy → del día (sin cambio)', () => {
  assert.strictEqual(del({ timestamp: '2026-10-09T15:12:24Z' }), true);
});

t('3. pedido normal registrado ayer → de días anteriores (la guarda de aa99cba sigue)', () => {
  assert.strictEqual(del({ timestamp: '2026-10-08T20:42:43Z' }), false);
});

t('4. programado para AYER y registrado antes de ayer → de días anteriores', () => {
  assert.strictEqual(del({ timestamp: '2026-10-07T18:00:00Z', programado_para: '2026-10-08T17:00:00Z' }), false);
});

t('5. activado antes de medianoche para la madrugada siguiente → del día', () => {
  // Registrado el 8, programado para el 10 a las 00:30 local (05:30Z): el
  // scheduler lo activa el 9 a las 23:30, y ese F5 debe seguir viéndolo.
  assert.strictEqual(del({ timestamp: '2026-10-08T15:00:00Z', programado_para: '2026-10-10T05:30:00Z' }), true);
});

t('6. registrado hoy aunque su programación sea de un día que ya pasó → del día (nada que hoy se veía se oculta)', () => {
  assert.strictEqual(del({ timestamp: '2026-10-09T14:00:00Z', programado_para: '2026-10-08T17:00:00Z' }), true);
});

t('7. sin timestamp y sin programación → fuera (igual que antes)', () => {
  assert.strictEqual(del({}), false);
  assert.strictEqual(del({ timestamp: null, programado_para: null }), false);
});

t('8. programado_para ilegible → decide solo el día de registro', () => {
  assert.strictEqual(del({ timestamp: '2026-10-08T20:00:00Z', programado_para: 'mañana temprano' }), false);
  assert.strictEqual(del({ timestamp: '2026-10-09T15:00:00Z', programado_para: 'mañana temprano' }), true);
});

t('9. límite de medianoche local: 23:59 de ayer es ayer, 00:00 de hoy es hoy', () => {
  // CDT (UTC-5): 00:00 local del 9 = 05:00Z.
  assert.strictEqual(del({ timestamp: '2026-10-09T04:59:59Z' }), false);
  assert.strictEqual(del({ timestamp: '2026-10-09T05:00:00Z' }), true);
  assert.strictEqual(del({ timestamp: '2026-10-07T12:00:00Z', programado_para: '2026-10-09T04:59:59Z' }), false);
  assert.strictEqual(del({ timestamp: '2026-10-07T12:00:00Z', programado_para: '2026-10-09T05:00:00Z' }), true);
});

console.log(`\n═══ fase-programado-dia-operativo: ${pasadas} pasadas, ${fallidas} fallidas ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
