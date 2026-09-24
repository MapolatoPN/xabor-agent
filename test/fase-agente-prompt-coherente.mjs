// ─── UNA HERRAMIENTA QUE EL PROMPT NO MENCIONA NO EXISTE ──────────────────
//
// El 23-sep, con el bot recién encendido y el primer mensaje real, pasó esto:
//
//   cliente   «puedo hacer un pedido para mañana?»
//   agente    pedir_humano → "no contamos con herramienta para programarlos"
//
// `programar_para` estaba en la lista de herramientas que ve el modelo. Lo que
// pasaba es que el prompt seguía diciendo, literal:
//
//     «No prometas pedidos para mañana, otro día o una fecha futura: no tienes
//      una herramienta para programarlos.»
//
// El modelo obedeció al prompt, que es lo que tiene que hacer. Se añadió la
// herramienta y se dejó la frase que decía que no existía.
//
// Y había un segundo agujero en el mismo sitio: el bloque HORARIO no decía qué
// día es HOY, así que el modelo no podía convertir «mañana» a una fecha sin
// inventársela de su entrenamiento.
//
// Ninguna de las dos cosas la puede ver el replay: ahí el modelo es un guion
// que llama a lo que la prueba quiera. Solo se ven con un modelo real — o con
// estas afirmaciones sobre el texto del prompt.
//
// Suite pura.
import assert from 'node:assert/strict';
import { NOMBRES } from '../src/mesero-agente/contratoDeHerramientas.js';
import { construirInstrucciones, hoyEnTexto, promocionesEnTexto } from '../src/mesero-agente/instrucciones.js';
import { esConsultaDePromociones, esAceptacionBreveDePromocion } from '../src/mesero-agente/canalDelAgente.js';

let pasadas = 0;
const fallos = [];
const t = (nombre, fn) => {
  try { fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

const ESTADO_ABIERTO = {
  abierto: true, diaActual: 'miércoles', horaActual: '10:30 a. m.',
  fechaHoy: '2026-09-23', detalle: 'Cerramos a las 14:45.',
};
const prompt = (extra = {}) => construirInstrucciones({
  nombreNegocio: 'Mapolato', pedido: null, estadoRestaurante: ESTADO_ABIERTO, ...extra });

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El prompt no puede contradecir a las herramientas ──');

t('A1 · las herramientas con POLÍTICA propia se nombran en el prompt', () => {
  const texto = prompt();
  // No todas hacen falta. `agregar_producto` o `confirmar_pedido` se disparan
  // solas: su descripción dice exactamente cuándo, y el flujo del prompt las
  // implica. Están probadas en producción sin aparecer por su nombre.
  //
  // Las de esta lista NO: su momento depende de una política que el modelo no
  // puede deducir de la descripción —cuándo es un evento y no un pedido grande,
  // cuándo mandar la carta en vez de contarla, qué hacer si una fecha se
  // rechaza—. Si el prompt calla, el modelo se inventa una política, y por
  // omisión la política que se inventa es «no puedo».
  const conPolitica = ['enviar_menu', 'programar_para', 'registrar_solicitud_evento',
    'cancelar_pedido', 'pedir_humano'];
  for (const h of conPolitica) {
    assert.ok(NOMBRES.includes(h), `la herramienta ${h} ya no existe: actualiza esta lista`);
    assert.ok(texto.includes(h), `el prompt no menciona \`${h}\`: el modelo no sabrá cuándo usarla`);
  }
});

t('A2 · el prompt NO dice que no se puedan programar pedidos', () => {
  const texto = prompt().toLowerCase();
  // La frase exacta del incidente, y sus parientes cercanos.
  for (const prohibida of [
    'no tienes una herramienta para programar',
    'no cuentas con herramienta para programar',
    'no prometas pedidos para mañana',
  ]) {
    assert.ok(!texto.includes(prohibida),
      `el prompt sigue diciendo «${prohibida}» y la herramienta existe`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. El modelo tiene que saber qué día es hoy ──');

t('B1 · el bloque HORARIO trae la fecha de hoy, en ISO y con su día', () => {
  const texto = prompt();
  assert.match(texto, /2026-09-23/, 'sin la fecha de hoy, «mañana» se lo inventa');
  assert.match(texto, /miércoles/);
  assert.match(texto, /Usa esta fecha para calcular cualquier otro día/);
});

t('B2 · la fecha sale también con el negocio cerrado', () => {
  const texto = prompt({ estadoRestaurante: { ...ESTADO_ABIERTO, abierto: false } });
  assert.match(texto, /2026-09-23/, 'cerrado es justo cuando más se agenda para otro día');
  assert.match(texto, /CERRADO/);
});

t('B3 · sin estado del restaurante no se inventa una fecha', () => {
  assert.equal(hoyEnTexto(null), '');
  assert.equal(hoyEnTexto({ diaActual: 'lunes' }), '');
  const texto = construirInstrucciones({ nombreNegocio: 'X', pedido: null });
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(texto), 'se coló una fecha que nadie le dio');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B.1. El agente recibe promociones verificadas ──');

t('B4 · las promociones actuales de Xabor llegan al prompt con sus requisitos', () => {
  const texto = construirInstrucciones({
    nombreNegocio: 'Mapolato', pedido: null,
    promocionesInformativas: [{
      nombre: 'Miércoles de chilaquiles',
      descripcion: '50% en chilaquiles participantes.',
      participantesTexto: 'Participan Chilaquiles Sencillos.',
      condiciones: [{ grupo: 'Salsa', operador: 'una_de', permitidas: ['Roja', 'Verde'] }],
    }],
  });
  assert.match(texto, /PROMOCIONES VIGENTES AHORA/);
  assert.match(texto, /Miércoles de chilaquiles/);
  assert.match(texto, /Chilaquiles Sencillos/);
  assert.match(texto, /salsa: Roja o Verde/i);
  assert.match(texto, /no inventes precios/i);
});

t('B5 · un fallo de consulta no se transforma en «no hay promociones»', () => {
  const texto = promocionesEnTexto(null);
  assert.match(texto, /No se pudo verificar/);
  assert.doesNotMatch(texto, /No hay promociones vigentes/);
});

t('B6 · la pregunta real «Tienen promociones hoy?» activa la ruta determinista', () => {
  assert.equal(esConsultaDePromociones('Tienen promociones hoy?'), true);
  assert.equal(esConsultaDePromociones('¿Qué promociones tienen vigentes?'), true);
  assert.equal(esConsultaDePromociones('Quiero una promoción'), true);
  assert.equal(esConsultaDePromociones('Quiero aplicar la promoción al pedido'), false);
  assert.equal(esConsultaDePromociones('Agrega la promoción al pedido'), false);
  assert.equal(esAceptacionBreveDePromocion('Sí'), true);
  assert.equal(esAceptacionBreveDePromocion('Sí, quiero dos'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. Lo que el prompt le dice sobre programar ──');

t('C1 · le dice que convierta él la fecha, y que use la de hoy', () => {
  const texto = prompt();
  assert.match(texto, /programar_para/);
  assert.match(texto, /fecha y\s+la hora exactas|fecha\s+y la hora exactas/,
    'no le pide fecha y hora exactas: mandará texto libre y el esquema lo rechazará');
  assert.match(texto, /bloque HORARIO/, 'no le dice de dónde sacar la fecha de hoy');
});

t('C2 · un rechazo NO es motivo para pasar a una persona', () => {
  // Es lo que hizo en el incidente: al no poder, escaló. Si el prompt no lo
  // dice, volverá a hacerlo en cuanto Xabor rechace una fecha.
  assert.match(prompt(), /no insistas con la misma hora ni lo pases a una\s+persona/);
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
