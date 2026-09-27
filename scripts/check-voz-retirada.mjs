// Barrera de predeploy: el canal de voz NO vuelve.
//
// Se retiró el 27-sep-2026 por decisión del dueño. No se usaba, y por él se
// podía llegar sin autenticar al modelo (clave global, prompt del negocio por
// defecto), a registrarPedido + emitirPedido (comanda impresa), a pagos
// pendientes, a transcripciones y a sesiones en memoria sin tope; además un
// mensaje «null» por /ws/voice terminaba el proceso. Esta barrera falla si
// regresa cualquiera de sus piezas:
//
//  1. los archivos del canal (voice.js y los servicios de ElevenLabs y Deepgram);
//  2. /webhook/voice, voiceRouter, setupVoiceWebSocket, wssVoice, un import del
//     canal, el TwiML de Conversation Relay o el montaje /audio;
//  3. un llamador de las dos funciones por las que la voz llegaba al modelo y a
//     las transcripciones (procesarMensajeStream, guardarTranscripcionVoz);
//  4. /ws/voice en cualquier código: el upgrade es una lista cerrada (la exige
//     check-websocket-lista-cerrada.mjs) y toda ruta fuera de ella da 404.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');
// Solo cuentan las líneas de código: los comentarios pueden explicar la historia.
const sinComentarios = (fuente) => fuente.split('\n')
  .filter((l) => { const s = l.trim(); return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')); })
  .join('\n');

function archivos(dir) {
  const out = [];
  for (const n of readdirSync(join(RAIZ, dir))) {
    const ruta = `${dir}/${n}`;
    if (statSync(join(RAIZ, ruta)).isDirectory()) out.push(...archivos(ruta));
    else if (/\.(m?js|cjs)$/.test(n)) out.push(ruta);
  }
  return out;
}

// 1 · los archivos del canal
for (const ruta of ['src/channels/voice.js', 'src/services/elevenlabs.js', 'src/services/deepgram.js']) {
  assert.ok(!existsSync(join(RAIZ, ruta)), `${ruta} reapareció: el canal de voz está retirado`);
}

// 2 y 3 · ninguna pieza del canal en el código de src/
const PROHIBIDOS = [
  [/\/webhook\/voice\b/i, '/webhook/voice'],
  [/\bvoiceRouter\b/, 'voiceRouter'],
  [/\bsetupVoiceWebSocket\b/, 'setupVoiceWebSocket'],
  [/\bwssVoice\b/, 'wssVoice'],
  [/(import|require)\s*\(?[^;\n]*['"`][^'"`]*channels\/voice(\.js)?['"`]/, 'un import del canal de voz'],
  [/<ConversationRelay\b/i, 'el TwiML de Conversation Relay'],
  [/api\.elevenlabs\.io|api\.deepgram\.com/i, 'una llamada a ElevenLabs o Deepgram'],
  [/\bapp\.use\(\s*['"`]\/audio['"`]/, 'el montaje /audio de los audios de ElevenLabs'],
];
// La única función por la que la voz llegaba al modelo, y la que escribía sus
// transcripciones: se quedan definidas (brain.js y database.js son compartidos),
// pero nadie más puede llamarlas.
const SOLO_EN = [
  ['procesarMensajeStream', 'src/agent/brain.js'],
  ['guardarTranscripcionVoz', 'src/services/database.js'],
];
const hallazgos = [];
for (const ruta of archivos('src')) {
  const codigo = sinComentarios(leer(ruta));
  for (const [re, nombre] of PROHIBIDOS) if (re.test(codigo)) hallazgos.push(`${ruta}: ${nombre}`);
  for (const [nombre, dueno] of SOLO_EN) {
    if (ruta !== dueno && new RegExp(`\\b${nombre}\\b`).test(codigo)) hallazgos.push(`${ruta}: llama a ${nombre}`);
  }
  // /ws/voice no aparece en ningún código: fuera de la lista cerrada del
  // upgrade, cualquier ruta recibe 404 por defecto.
  if (/\/ws\/voice/i.test(codigo)) hallazgos.push(`${ruta}: /ws/voice`);
}
assert.deepEqual(hallazgos, [], `el canal de voz volvió:\n  ${hallazgos.join('\n  ')}`);

// Dentro de brain.js, procesarMensajeStream solo puede estar definida: una
// llamada nueva desde ahí sería otra puerta de streaming al modelo.
const brain = sinComentarios(leer('src/agent/brain.js'));
assert.ok((brain.match(/\bprocesarMensajeStream\b/g) || []).length <= 1,
  'brain.js llama a procesarMensajeStream: la única ruta que la usaba era la voz');

// 4 · /ws/voice no está en la lista cerrada del upgrade, así que cae en su
// rechazo por defecto; la forma de esa lista la exige check-websocket-lista-cerrada.mjs.

console.log('OK: canal de voz retirado — sin /webhook/voice ni /ws/voice, sin voiceRouter, setupVoiceWebSocket ni llamadas al canal.');
