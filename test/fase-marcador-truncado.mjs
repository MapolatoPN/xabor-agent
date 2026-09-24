// ─── UN BLOQUE SIN CERRAR SALE ENTERO AL CLIENTE ──────────────────────────
//
// Incidente real: Mapolato Obispado, 23-sep-2026 12:55. El modelo se quedó sin
// tokens a media JSON, el bloque quedó sin `</ORDEN_PREVIEW>`, la regex por
// pareja de `limpiarTexto` no casó, y el cliente —que estaba pidiendo
// chilaquiles— recibió 2807 caracteres acabados en `"total": 660,`.
// La conversación murió ahí y no hubo pedido.
//
// Suite pura: sin Postgres, sin puertos, sin modelo. Es a propósito —importar
// `brain.js` arrastra `server.js` entero— y por eso la regla vive en
// `marcadoresTruncados.js` y no dentro del componente protegido.
import assert from 'node:assert/strict';
import {
  BLOQUES_CON_CIERRE, marcadorSinCerrar, hayMarcadorSinCerrar, cortarMarcadorSinCerrar,
} from '../src/agent/marcadoresTruncados.js';

let pasadas = 0;
const fallos = [];
const t = (nombre, fn) => {
  try { fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

// El mensaje del incidente, recortado pero con su forma exacta: prosa, el
// marcador, y un JSON que se corta a mitad sin cerrar ni la llave ni la etiqueta.
const REAL = `Perfecto. Voy a confirmar tu pedido completo:

2 Chilaquiles Sencillos
1 Licuado Grande de Plátano

¿Confirmas tu pedido?

<ORDEN_PREVIEW>
{
  "cliente": { "nombre": "Mario" },
  "modalidad": "recoger en tienda",
  "subtotal": 660,
  "costo_envio": 0,
  "descuento": 0,
  "total": 660,`;

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El caso real ──');

t('A1 · el mensaje del 23-sep se detecta como truncado', () => {
  assert.equal(marcadorSinCerrar(REAL), 'ORDEN_PREVIEW');
  assert.equal(hayMarcadorSinCerrar(REAL), true);
});

t('A2 · y al cliente no le llega una sola llave del JSON', () => {
  const limpio = cortarMarcadorSinCerrar(REAL);
  assert.ok(!limpio.includes('<ORDEN_PREVIEW>'), 'quedó el marcador');
  assert.ok(!limpio.includes('"total"'), 'quedó el volcado');
  assert.ok(!limpio.includes('{'), 'quedó JSON suelto');
  assert.ok(limpio.includes('¿Confirmas tu pedido?'), 'se llevó por delante la prosa del cliente');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Lo que NO se puede romper por arreglar esto ──');

t('B1 · un bloque BIEN formado no hace que se corte nada', () => {
  const texto = 'Aquí tienes tu resumen.\n<ORDEN_PREVIEW>{"total":100}</ORDEN_PREVIEW>\nY dime si lo confirmo.';
  assert.equal(marcadorSinCerrar(texto), null);
  // `cortarMarcadorSinCerrar` corre DESPUÉS de quitar las parejas; aun así,
  // sobre el texto crudo no debe tocar nada.
  assert.equal(cortarMarcadorSinCerrar(texto), texto.trim());
});

t('B2 · un texto normal, sin marcadores, se queda igual', () => {
  const texto = 'Claro que sí, tenemos chilaquiles sencillos, mixtos y el bowl. ¿Cuál te sirvo?';
  assert.equal(marcadorSinCerrar(texto), null);
  assert.equal(cortarMarcadorSinCerrar(texto), texto);
});

t('B3 · los marcadores SUELTOS no cuentan como truncados', () => {
  // `<ENVIAR_MENU>` y `<ESCALAR_A_HUMANO>` no tienen cierre que echar en
  // falta. Si contaran, un `<ENVIAR_MENU>` al final se comería el mensaje
  // que lo acompaña — y ese marcador va justo ahí.
  for (const suelto of ['<ENVIAR_MENU>', '<ESCALAR_A_HUMANO>', '<CONSULTA_PENDIENTE:promos>']) {
    const texto = `Te mando la carta. ${suelto}`;
    assert.equal(marcadorSinCerrar(texto), null, `${suelto} se tomó por truncado`);
    assert.equal(cortarMarcadorSinCerrar(texto), texto, `${suelto} provocó un corte`);
  }
});

t('B4 · uno cerrado y otro truncado: se conserva el primero y se corta el segundo', () => {
  const texto = 'Resumen:\n<ORDEN_PREVIEW>{"a":1}</ORDEN_PREVIEW>\nConfirmado.\n<ORDEN_CONFIRMADA>\n{"b":';
  assert.equal(marcadorSinCerrar(texto), 'ORDEN_CONFIRMADA');
  const limpio = cortarMarcadorSinCerrar(texto);
  assert.ok(limpio.includes('<ORDEN_PREVIEW>{"a":1}</ORDEN_PREVIEW>'), 'se cargó el bloque bien formado');
  assert.ok(!limpio.includes('<ORDEN_CONFIRMADA>'), 'dejó el truncado');
  assert.ok(limpio.endsWith('Confirmado.'), `quedó: ${JSON.stringify(limpio.slice(-30))}`);
});

t('B5 · el corte va a la ÚLTIMA apertura, no a la primera', () => {
  // Dos previews: el primero cerrado, el segundo no. Cortar por la primera
  // apertura se llevaría también el bloque válido.
  const texto = '<ORDEN_PREVIEW>{"a":1}</ORDEN_PREVIEW> texto <ORDEN_PREVIEW>{"b":';
  const limpio = cortarMarcadorSinCerrar(texto);
  assert.ok(limpio.includes('{"a":1}'), 'cortó por la apertura equivocada');
  assert.ok(!limpio.includes('{"b":'), 'no cortó el truncado');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. Todos los bloques con pareja, no solo el del incidente ──');

t('C1 · cada bloque con cierre se detecta y se corta', () => {
  assert.deepEqual(BLOQUES_CON_CIERRE, [
    'ORDEN_CONFIRMADA', 'ORDEN_PREVIEW', 'CONSULTA_PROMOS',
    'PEDIDO_BORRADOR', 'SOLICITAR_FACTURA',
    'CAMPO_COMERCIAL_CAPTURADO', 'OBJECION_DETECTADA',
  ]);
  for (const tag of BLOQUES_CON_CIERRE) {
    const texto = `Hola.\n<${tag}>\n{"x":`;
    assert.equal(marcadorSinCerrar(texto), tag, `${tag} no se detectó`);
    assert.equal(cortarMarcadorSinCerrar(texto), 'Hola.', `${tag} no se cortó`);
  }
});

t('C2 · un cierre huérfano no dispara nada, ni con un bloque válido delante', () => {
  // Más cierres que aperturas es raro, pero NO es una fuga: no hay carga de
  // máquina colgando al final. Inventarse un corte aquí sería borrar texto
  // del cliente por un síntoma que no lo es.
  //
  // El caso lleva un bloque BIEN formado delante a propósito: sin él, el
  // texto no contiene ninguna apertura y la prueba pasa aunque la condición
  // sea `===` en vez de `<=` — no distingue nada. Lo encontró la prueba de
  // mordida nº 5, que no tumbaba este caso.
  const texto = '<ORDEN_PREVIEW>{"a":1}</ORDEN_PREVIEW> gracias </ORDEN_PREVIEW> fin';
  assert.equal(marcadorSinCerrar(texto), null, 'un cierre de más se tomó por un bloque truncado');
  assert.equal(cortarMarcadorSinCerrar(texto), texto, 'se cortó texto por un cierre huérfano');

  const suelto = 'Listo.</ORDEN_PREVIEW> Gracias.';
  assert.equal(marcadorSinCerrar(suelto), null);
  assert.equal(cortarMarcadorSinCerrar(suelto), suelto);
});

t('C3 · entradas vacías o raras no revientan', () => {
  for (const v of [null, undefined, '', 0, {}, []]) {
    assert.equal(marcadorSinCerrar(v), null);
    assert.equal(typeof cortarMarcadorSinCerrar(v), 'string');
  }
});

t('C4 · mayúsculas, minúsculas y espacio antes de > no evaden el corte', () => {
  const texto = 'Texto seguro.\n<orden_preview >{"total":';
  assert.equal(marcadorSinCerrar(texto), 'ORDEN_PREVIEW');
  assert.equal(cortarMarcadorSinCerrar(texto), 'Texto seguro.');
});

t('C5 · dos aperturas sin cierre cortan desde la primera, no dejan media carga', () => {
  const texto = 'Texto seguro.\n<ORDEN_PREVIEW>{"a":<ORDEN_PREVIEW>{"b":';
  assert.equal(marcadorSinCerrar(texto), 'ORDEN_PREVIEW');
  assert.equal(cortarMarcadorSinCerrar(texto), 'Texto seguro.');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
