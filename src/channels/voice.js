// Canal de voz — Twilio Conversation Relay + ElevenLabs TTS
// Flujo: Cliente llama → /start → TwiML <ConversationRelay> → WebSocket /ws/voice
//        Twilio transcribe en tiempo real → nosotros procesamos → Claude → ElevenLabs TTS

import { Router } from 'express';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { setPagoPendiente } from '../services/database.js';

const router = Router();

const BASE_URL = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
const WS_URL   = BASE_URL.replace(/^https?:\/\//, 'wss://');

// Mapa de sesiones activas: callSid → { sessionId, fromNum }
const sesiones = new Map();

// ─── Inicio de llamada ───────────────────────────────────────────────────────
router.post('/start', (req, res) => {
  const callSid = req.body.CallSid;
  const fromNum = req.body.From;
  const sessionId = `call-${callSid}`;

  sesiones.set(callSid, { sessionId, fromNum });
  console.log(`[Voz] Nueva llamada: ${callSid} desde ${fromNum}`);

  // Saludo dinámico según hora (sin llamar a Claude)
  const h = new Date().toLocaleString('en-US', { timeZone: 'America/Monterrey', hour: 'numeric', hour12: false });
  const saludo = parseInt(h) < 12 ? 'Buenos días' : parseInt(h) < 19 ? 'Buenas tardes' : 'Buenas noches';
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
        // El saludo lo reproduce Twilio con welcomeGreeting
        return;
      }

      // ── Prompt ─────────────────────────────────────────────────────────────
      if (msg.type === 'prompt') {
        const texto = (msg.voicePrompt || msg.text || '').trim();
        console.log(`[Voz WS] Cliente: "${texto}"`);
        if (!texto || procesando) return;

        procesando = true;
        try {
          const resultado = await procesarMensaje(sessionId, texto, null, 'voz');

          let textoFinal = resultado.texto;

          // Orden confirmada — registrar y sustituir folio real en el texto
          if (resultado.orden) {
            resultado.orden.canal = 'voz';
            const pedido = registrarPedido(resultado.orden, 'voz');
            emitirPedido(pedido);

            const folioVoz = deletrearFolio(pedido.id);

            // Reemplazar placeholder [FOLIO] si Claude lo usó
            textoFinal = textoFinal.replace(/\[FOLIO\]/gi, folioVoz);

            // Fallback: si es enlace de pago y el folio no quedó en el texto, lo añadimos nosotros
            if (resultado.orden.forma_pago === 'enlace de pago') {
              if (!textoFinal.includes(folioVoz)) {
                textoFinal += ` Tu número de folio es ${folioVoz}. Te repito: ${folioVoz}. Mándanos ese número por WhatsApp y te enviamos el enlace de inmediato.`;
              }
              if (fromNum) {
                await setPagoPendiente(fromNum, pedido.id);
                console.log(`[Voz WS] Pago pendiente para ${fromNum} — pedido ${pedido.id}`);
              }
            }
          }

          enviarTexto(ws, limpiarParaVoz(textoFinal));

          if (resultado.orden) {
            // Pausa para que termine el audio antes de colgar
            setTimeout(() => {
              try { ws.send(JSON.stringify({ type: 'end' })); } catch (_) {}
            }, 8000);
          }

        } catch (e) {
          console.error('[Voz WS] Error procesando mensaje:', e.message);
          enviarTexto(ws, 'Perdón, tuve un problema. ¿Me puedes repetir?');
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

// Convierte "XAB-0012" → "equis - a - be - cero doce" para que TTS lo lea bien
function deletrearFolio(folio) {
  const letras = { X: 'equis', A: 'a', B: 'be' };
  const [prefijo, numero] = folio.split('-');
  const letrasDelPrefijo = prefijo.split('').map(l => letras[l] || l).join(' - ');
  const num = parseInt(numero, 10);
  return `${letrasDelPrefijo} - ${num}`;
}

// Limpia el texto para que TTS suene natural en español
function limpiarParaVoz(texto) {
  return texto
    .replace(/\$\s?(\d[\d,]*)/g, '$1 pesos')   // $179 → 179 pesos
    .replace(/\$/g, '')                           // cualquier $ restante
    .replace(/\*/g, '')                           // asteriscos de markdown
    .replace(/#/g, '')                            // hash de markdown
    .trim();
}

function enviarTexto(ws, texto) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'text', token: texto, last: true }));
}

export default router;
