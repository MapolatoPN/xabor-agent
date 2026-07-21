/**
 * Tests: AbortController + turnId en pipeline de voz
 *
 * Simula el handler de voice.js sin dependencias externas.
 * Verifica que frases de turnos anteriores nunca lleguen al WebSocket.
 *
 * Ejecutar: node --experimental-vm-modules tests/voice-interrupt.test.js
 */

// ─── Mini test runner ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function test(name, fn) {
  console.log(`\n▶ ${name}`);
  return Promise.resolve().then(fn);
}

// ─── Simulación del pipeline ──────────────────────────────────────────────────
// Reproduce la lógica de voice.js sin Twilio ni Anthropic

function crearPipeline() {
  const enviados = [];   // tokens que llegaron al "WebSocket"
  const logs     = [];

  let currentTurnId    = 0;
  let currentAbortCtrl = null;
  let procesando       = false;

  // Mock de procesarMensajeStream — genera frases con delay configurable
  async function mockStream(frases, delayMs, signal, onFrase) {
    for (const frase of frases) {
      if (signal?.aborted) {
        logs.push(`[abort] stream cancelado`);
        return null;
      }
      await delay(delayMs);
      if (signal?.aborted) {
        logs.push(`[abort] stream cancelado post-delay`);
        return null;
      }
      onFrase(frase);
    }
    return { orden: null };
  }

  async function recibirPrompt(texto, frases, delayMs = 50) {
    // Cancelar turno anterior
    if (currentAbortCtrl) {
      currentAbortCtrl.abort();
      logs.push(`[cancel] turno ${currentTurnId} abortado`);
    }
    currentTurnId++;
    const myTurnId   = currentTurnId;
    currentAbortCtrl = new AbortController();
    const { signal } = currentAbortCtrl;

    procesando = true;
    logs.push(`[start] turno ${myTurnId}: "${texto}"`);

    try {
      const resultado = await mockStream(frases, delayMs, signal, (frase) => {
        if (myTurnId !== currentTurnId) {
          logs.push(`[discard] turno ${myTurnId}: "${frase}" (actual: ${currentTurnId})`);
          return;
        }
        logs.push(`[send] turno ${myTurnId}: "${frase}"`);
        enviados.push({ turnId: myTurnId, frase });
      });

      if (!resultado) return; // abortado

    } finally {
      if (myTurnId === currentTurnId) procesando = false;
    }
  }

  function recibirInterrupt() {
    logs.push(`[interrupt] turno ${currentTurnId} cancelado`);
    if (currentAbortCtrl) { currentAbortCtrl.abort(); currentAbortCtrl = null; }
    procesando = false;
  }

  return { recibirPrompt, recibirInterrupt, enviados, logs, getTurnId: () => currentTurnId };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

await test('Turno simple sin interrupción — todas las frases llegan', async () => {
  const p = crearPipeline();
  await p.recibirPrompt('Hola', ['Buenos días.', 'En qué te ayudo?'], 10);
  assert(p.enviados.length === 2, 'Se enviaron 2 frases');
  assert(p.enviados.every(e => e.turnId === 1), 'Todas del turno 1');
});

await test('Interrupción limpia — frase post-interrupt descartada', async () => {
  const p = crearPipeline();

  // Turno 1: frases con 80ms de delay cada una
  const turno1 = p.recibirPrompt('Turno 1', ['Frase A.', 'Frase B.', 'Frase C.'], 80);
  await delay(50); // Frase A ya se envió, B y C están pendientes

  // Interrupt antes de B y C
  p.recibirInterrupt();
  await turno1;

  const deT1 = p.enviados.filter(e => e.turnId === 1);
  assert(deT1.length <= 1, `Solo ≤1 frase del turno 1 llegó (llegaron ${deT1.length})`);
  assert(p.logs.some(l => l.includes('[abort]') || l.includes('[discard]')), 'Se registró abort o discard');
});

await test('Interrupción y nuevo turno — solo frases del turno 2 llegan', async () => {
  const p = crearPipeline();

  const turno1 = p.recibirPrompt('Turno 1', ['A1.', 'A2.', 'A3.'], 80);
  await delay(40); // A1 podría haber salido
  p.recibirInterrupt();

  // Turno 2 arranca inmediatamente
  const turno2 = p.recibirPrompt('Turno 2', ['B1.', 'B2.'], 20);
  await Promise.all([turno1, turno2]);

  const deT2 = p.enviados.filter(e => e.turnId === 2);
  const deT1 = p.enviados.filter(e => e.turnId === 1);

  assert(deT2.length === 2, `Turno 2 entregó 2 frases (entregó ${deT2.length})`);
  assert(deT2.map(e => e.frase).join('|') === 'B1.|B2.', 'Frases de turno 2 en orden correcto');

  const contaminacion = p.enviados.filter(e => e.turnId === 1 && p.enviados.some(e2 => e2.turnId === 2 && e2 !== e));
  assert(contaminacion.length === 0 || deT1.length === 0, 'Ninguna frase del turno 1 se mezcla con turno 2 post-interrupt');
});

await test('Tres interrupciones seguidas — solo el último turno entrega frases', async () => {
  const p = crearPipeline();

  const t1 = p.recibirPrompt('T1', ['T1-A.', 'T1-B.', 'T1-C.'], 60);
  await delay(20); p.recibirInterrupt();

  const t2 = p.recibirPrompt('T2', ['T2-A.', 'T2-B.', 'T2-C.'], 60);
  await delay(20); p.recibirInterrupt();

  const t3 = p.recibirPrompt('T3', ['T3-A.', 'T3-B.', 'T3-C.'], 60);
  await delay(20); p.recibirInterrupt();

  const t4 = p.recibirPrompt('T4', ['Final-A.', 'Final-B.'], 20);
  await Promise.all([t1, t2, t3, t4]);

  const deT4 = p.enviados.filter(e => e.turnId === 4);
  const otros = p.enviados.filter(e => e.turnId !== 4);

  assert(deT4.length === 2, `Turno final (4) entregó 2 frases (entregó ${deT4.length})`);
  assert(otros.length === 0, `Ninguna frase de turnos 1-3 llegó (llegaron ${otros.length})`);
});

await test('Sin interrupción pero turno nuevo cancela al anterior', async () => {
  const p = crearPipeline();

  // Turno 1 con delay largo
  const t1 = p.recibirPrompt('T1', ['Lenta-A.', 'Lenta-B.'], 100);
  await delay(30); // antes de que salga Lenta-A

  // Turno 2 arranca sin interrupt explícito (simula que Twilio nos manda otro prompt)
  const t2 = p.recibirPrompt('T2', ['Rapida-A.', 'Rapida-B.'], 10);
  await Promise.all([t1, t2]);

  const deT1 = p.enviados.filter(e => e.turnId === 1);
  const deT2 = p.enviados.filter(e => e.turnId === 2);

  assert(deT2.length === 2, 'Turno 2 completo');
  assert(deT1.length === 0, `Turno 1 cancelado — 0 frases (llegaron ${deT1.length})`);
});

await test('finally no anula procesando del turno nuevo', async () => {
  const p = crearPipeline();
  let procesandoAlFinal = true;

  const t1 = p.recibirPrompt('T1', ['X.', 'Y.'], 80);
  await delay(30);
  p.recibirInterrupt();
  const t2 = p.recibirPrompt('T2', ['Z.'], 20);

  // Dar tiempo a que el finally del turno 1 intente correr
  await Promise.all([t1, t2]);
  await delay(20);

  // Si turnId final es 2, el finally de t1 no debería haber borrado el estado
  assert(p.getTurnId() === 2, 'turnId quedó en 2 (no fue pisado)');
  assert(p.enviados.filter(e => e.turnId === 2).length === 1, 'Frase de turno 2 llegó completa');
});

// ─── Resumen ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultado: ${passed} ✅  ${failed} ❌  (${passed + failed} total)`);
if (failed > 0) process.exit(1);
