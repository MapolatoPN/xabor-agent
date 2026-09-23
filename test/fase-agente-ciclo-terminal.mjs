// ─── UN CICLO TERMINADO NO PUEDE MATAR LA CONVERSACIÓN PARA SIEMPRE ──────
//
// Incidente real, 23-sep-2026, con el bot recién encendido:
//
//   22:11  cliente  «puedo hacer un pedido para mañana?»
//          agente    pedir_humano  → estado escalado = true
//   22:19  (una persona reanuda el bot desde el panel: bot_pausado = false)
//   22:19  cliente  «Quiero unos hotcakes para mañana a las 10»
//          agente    «Te paso con alguien del equipo…»  — CERO herramientas
//
// Dos causas, las dos del mismo tipo:
//
//   1. `escalado` se guardaba como hecho terminal del agente, y el agente no
//      tenía forma de abrirlo. Reanudar el bot quitaba la pausa del canal y el
//      agente seguía mudo porque su propio estado decía «escalado».
//   2. La única salida de un estado terminal era que el cliente dijera una
//      frase de una lista. «Quiero unos hotcakes» no está en la lista —después
//      de «quiero» viene «unos hotcakes», no «pedido»—, así que un pedido
//      confirmado el día 21 seguía gobernando la conversación el día 23.
//
// Suite pura.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cicloParaTurno, HORAS_PARA_REABRIR } from '../src/mesero-agente/cicloDelAgente.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

let pasadas = 0;
const fallos = [];
const t = (nombre, fn) => {
  try { fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

const AHORA = new Date('2026-09-23T22:19:00Z');
const haceHoras = (h) => new Date(AHORA.getTime() - h * 3600 * 1000).toISOString();

const estadoCon = (hechos, { minutos = 5, extra = {} } = {}) => ({
  ...estadoNuevo({ negocioId: 'n1', conversacionId: 'agente:52187' }),
  hechos: { confirmado: false, escalado: false, cancelado: false, fallido: false, ...hechos },
  _actualizadoAt: new Date(AHORA.getTime() - minutos * 60000).toISOString(),
  ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El escalado lo gobierna el CANAL, no el agente ──');

t('A1 · el caso exacto del 23-sep: escalado hace 8 minutos, mensaje normal', () => {
  const estado = estadoCon({ escalado: true, confirmado: true }, { minutos: 8 });
  const r = cicloParaTurno(estado, 'Quiero unos hotcakes para mañana a las 10', { ahora: AHORA });
  assert.equal(r.hechos.escalado, false,
    'el agente sigue mudo aunque una persona ya devolvió la conversación al bot');
});

t('A2 · escalado solo, sin nada más, deja de bloquear', () => {
  const r = cicloParaTurno(estadoCon({ escalado: true }), 'hola', { ahora: AHORA });
  assert.equal(r.hechos.escalado, false);
  assert.equal(r.motivoEscalado, null, 'quedó el motivo de un escalado que ya no está');
  // No es un ciclo NUEVO: el carrito que llevaba sigue ahí.
  assert.ok(r.hechos, 'se perdió el estado entero por quitar una bandera');
});

t('A3 · un turno solo llega aquí si el canal lo dejó pasar', () => {
  // Es la premisa de A1 y A2, y conviene dejarla escrita: si la conversación
  // sigue pausada, `whatsapp-meta.js` ni llama al agente. Por eso el agente
  // puede confiar en que, si le llega un turno, el handoff terminó.
  const fuente = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  assert.match(fuente, /getBotPausado\(telefono, negocioId\)/,
    'el canal ya no comprueba la pausa antes de atender');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Un pedido terminado caduca ──');

t('B1 · confirmado hace días NO gobierna el pedido de hoy', () => {
  const estado = estadoCon({ confirmado: true }, { minutos: 60 * 48 });
  const r = cicloParaTurno(estado, 'Quiero unos hotcakes para mañana a las 10', { ahora: AHORA });
  assert.equal(r.hechos.confirmado, false, 'un pedido de anteayer sigue mandando');
  assert.equal(r.ciclo, 1, 'no abrió un ciclo nuevo');
  assert.match(r.conversacionId, /:c1$/, 'el libro de operaciones reutilizaría la identidad vieja');
});

t('B2 · justo por debajo del corte, NO se reabre sola', () => {
  const estado = estadoCon({ confirmado: true }, { minutos: (HORAS_PARA_REABRIR * 60) - 30 });
  const r = cicloParaTurno(estado, 'gracias', { ahora: AHORA });
  assert.equal(r.hechos.confirmado, true,
    'reabrir demasiado pronto deja al cliente pidiendo dos veces el mismo pedido');
});

t('B3 · la frase sigue funcionando, sin esperar las horas', () => {
  const estado = estadoCon({ confirmado: true }, { minutos: 10 });
  const r = cicloParaTurno(estado, 'quiero hacer otro pedido', { ahora: AHORA });
  assert.equal(r.hechos.confirmado, false);
  assert.equal(r.ciclo, 1);
});

t('B4 · cancelado se comporta igual que confirmado', () => {
  const viejo = cicloParaTurno(estadoCon({ cancelado: true }, { minutos: 60 * 10 }), 'unos hotcakes',
    { ahora: AHORA });
  assert.equal(viejo.hechos.cancelado, false);
  const reciente = cicloParaTurno(estadoCon({ cancelado: true }, { minutos: 10 }), 'unos hotcakes',
    { ahora: AHORA });
  assert.equal(reciente.hechos.cancelado, true);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. Lo que NO se puede reabrir ──');

t('C1 · una confirmación de resultado incierto sigue intacta', () => {
  // Es el único caso en que reabrir sería peligroso: no se sabe si el pedido
  // se registró, así que abrir otro ciclo puede duplicarlo.
  const estado = { ...estadoCon({ confirmado: true }, { minutos: 60 * 48 }), confirmacionIncierta: true };
  const r = cicloParaTurno(estado, 'quiero hacer otro pedido', { ahora: AHORA });
  assert.equal(r.confirmacionIncierta, true);
  assert.equal(r.hechos.confirmado, true, 'reabrió una confirmación que nadie ha conciliado');
});

t('C2 · sin fecha de escritura no se reabre por tiempo', () => {
  // Un estado viejo sin `_actualizadoAt` no autoriza a suponer que es antiguo.
  const estado = { ...estadoCon({ confirmado: true }), _actualizadoAt: null };
  const r = cicloParaTurno(estado, 'unos hotcakes', { ahora: AHORA });
  assert.equal(r.hechos.confirmado, true);
});

t('C3 · un estado sin terminar se devuelve tal cual', () => {
  const estado = estadoCon({});
  assert.strictEqual(cicloParaTurno(estado, 'unos hotcakes', { ahora: AHORA }), estado,
    'tocó un estado que no había terminado');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
