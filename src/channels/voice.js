// Canal de voz — Twilio Conversation Relay + ElevenLabs TTS
// Flujo: Cliente llama → /start → TwiML <ConversationRelay> → WebSocket /ws/voice
//        Twilio transcribe → Claude streaming → frases a ElevenLabs en tiempo real

import { Router } from 'express';
import { procesarMensajeStream } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { setPagoPendiente } from '../services/database.js';

const router = Router();

const BASE_URL = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
const WS_URL   = BASE_URL.replace(/^https?:\/\//, 'wss://');

const sesiones = new Map();

// ─── Inicio de llamada ───────────────────────────────────────────────────────
router.post('/start', (req, res) => {
  const callSid  = req.body.CallSid;
  const fromNum  = req.body.From;
  const sessionId = `call-${callSid}`;

  sesiones.set(callSid, { sessionId, fromNum });
  console.log(`[Voz] Nueva llamada: ${callSid} desde ${fromNum}`);

  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Monterrey', hour: 'numeric', hour12: false }));
  const saludo  = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  const greeting = `${saludo}, bienvenido a Xabor. ¿En qué te puedo ayudar?`;

  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'iBGVhgcEZS6A5gTOjqSJ';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${WS_URL}/ws/voice"
      language="es-MX"
      ttsProvider="ElevenLabs"
      voice="${VOICE_ID}"
      transcriptionProvider="deepgram"
      speechModel="nova-2"
      welcomeGreeting="${greeting}"
      welcomeGreetingInterruptible="true"
    />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// ─── WebSocket — Conversation Relay ─────────────────────────────────────────
export function setupVoiceWebSocket(wssVoice) {
  wssVoice.on('connection', (ws) => {
    let callSid    = null;
    let sessionId  = null;
    let fromNum    = null;
    let procesando = false;

    console.log('[Voz WS] Conexión entrante');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // ── Setup ──────────────────────────────────────────────────────────────
      if (msg.type === 'setup') {
        callSid   = msg.callSid;
        const ses = sesiones.get(callSid);
        sessionId = ses?.sessionId || `call-${callSid}`;
        fromNum   = ses?.fromNum   || msg.from;
        sesiones.set(callSid, { ...ses, ws });
        console.log(`[Voz WS] Setup — ${callSid} desde ${fromNum}`);
        return;
      }

      // ── Prompt — streaming ─────────────────────────────────────────────────
      if (msg.type === 'prompt') {
        const texto = (msg.voicePrompt || msg.text || '').trim();
        console.log(`[Voz WS] Cliente: "${texto}"`);
        if (!texto || procesando) return;

        procesando = true;
        const frasesEnviadas = [];

        try {
          // Streaming: cada frase se envía a Twilio en cuanto Claude la genera
          const resultado = await procesarMensajeStream(
            sessionId, texto, null, 'voz',
            (frase) => {
              const limpia = limpiarParaVoz(frase);
              if (!limpia) return;
              frasesEnviadas.push(limpia);
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'text', token: limpia, last: false }));
              }
            }
          );

          // Procesar orden y folio DESPUÉS de que el stream terminó
          let textoExtra = '';
          if (resultado.orden) {
            resultado.orden.canal = 'voz';
            const pedido = registrarPedido(resultado.orden, 'voz');
            emitirPedido(pedido);

            if (resultado.orden.forma_pago === 'enlace de pago') {
              const folioVoz = deletrearFolio(pedido.id);
              const yaLoMenciono = frasesEnviadas.join(' ').includes(folioVoz);
              if (!yaLoMenciono) {
                textoExtra = `Tu número de folio es ${folioVoz}. Te repito: ${folioVoz}. Mándanos ese número por WhatsApp y te enviamos el enlace de inmediato.`;
              }
              if (fromNum) {
                await setPagoPendiente(fromNum, pedido.id);
                console.log(`[Voz WS] Pago pendiente para ${fromNum} — pedido ${pedido.id}`);
              }
            }
          }

          // Señal de fin con last:true (+ folio si aplica)
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'text',
              token: textoExtra ? limpiarParaVoz(textoExtra) : ' ',
              last: true
            }));
          }

          if (resultado.orden) {
            setTimeout(() => {
              try { ws.send(JSON.stringify({ type: 'end' })); } catch (_) {}
            }, 8000);
          }

        } catch (e) {
          console.error('[Voz WS] Error procesando mensaje:', e.message);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'text', token: 'Perdón, tuve un problema. ¿Me puedes repetir?', last: true }));
          }
        } finally {
          procesando = false;
        }
        return;
      }

      // ── Interrupt ──────────────────────────────────────────────────────────
      if (msg.type === 'interrupt') {
        console.log(`[Voz WS] Interrupción — ${callSid}`);
      }
    });

    ws.on('close', () => {
      console.log(`[Voz WS] Conexión cerrada — ${callSid}`);
      if (callSid) sesiones.delete(callSid);
    });

    ws.on('error', (e) => console.error('[Voz WS] Error:', e.message));
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deletrearFolio(folio) {
  const letras = { X: 'equis', A: 'a', B: 'be' };
  const [prefijo, numero] = folio.split('-');
  const letrasDelPrefijo = prefijo.split('').map(l => letras[l] || l).join(' - ');
  return `${letrasDelPrefijo} - ${parseInt(numero, 10)}`;
}

function limpiarParaVoz(texto) {
  return texto
    .replace(/\$\s?(\d[\d,]*)/g, '$1 pesos')
    .replace(/\$/g, '')
    .replace(/\*/g, '')
    .replace(/#/g, '')
    .trim();
}

export default router;
