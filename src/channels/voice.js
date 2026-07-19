// Canal de voz — Twilio Conversation Relay + ElevenLabs TTS
// Flujo: Cliente llama → /start → TwiML <ConversationRelay> → WebSocket /ws/voice
//        Twilio transcribe → Claude streaming → frases a ElevenLabs en tiempo real

import { Router } from 'express';
import { procesarMensajeStream } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { setPagoPendiente, guardarPedidoActivo } from '../services/database.js';

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
    let callSid         = null;
    let sessionId       = null;
    let fromNum         = null;
    let procesando      = false;
    let folioInfo       = null; // { texto } — activo mientras esperamos confirmación del folio
    let timerCierre     = null; // timeout de cierre de llamada

    const programarCierre = (ms) => {
      if (timerCierre) clearTimeout(timerCierre);
      timerCierre = setTimeout(() => {
        try { ws.send(JSON.stringify({ type: 'end' })); } catch (_) {}
      }, ms);
    };

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

        // ── Confirmación de folio: el cliente responde "sí/no/repite" ─────────
        if (folioInfo) {
          const pidioRepetir = /repite|repita|de nuevo|no entend|no escuch|otra vez|no lo escuch|no|qu[eé]/i.test(texto);
          if (pidioRepetir) {
            // Repetir folio y volver a preguntar
            if (timerCierre) clearTimeout(timerCierre);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'text', token: folioInfo.texto, last: true }));
            }
            programarCierre(25000);
            return;
          }
          // El cliente confirmó (sí, gracias, etc.) — despedirse y colgar
          folioInfo = null;
          if (timerCierre) clearTimeout(timerCierre);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'text', token: '¡Perfecto! En un momento te llega el enlace. ¡Que lo disfrutes!', last: true }));
          }
          programarCierre(6000);
          return;
        }

        procesando = true;

        // Token inmediato para que Twilio no cierre la conexión mientras Anthropic arranca
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: 'Un momento...', last: false }));
        }

        try {
          const resultado = await procesarMensajeStream(
            sessionId, texto, null, 'voz',
            (frase) => {
              const limpia = limpiarParaVoz(frase);
              if (!limpia) return;
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'text', token: limpia, last: false }));
              }
            }
          );

          let textoExtra = '';
          if (resultado.orden) {
            resultado.orden.canal = 'voz';
            const pedido = registrarPedido(resultado.orden, 'voz');
            emitirPedido(pedido);
            // Guardar en DB con await — garantiza que el folio existe cuando llegue el WA
            try {
              await guardarPedidoActivo(pedido);
              console.log(`[Voz WS] Pedido ${pedido.id} guardado en DB ✅`);
            } catch (e) {
              console.error(`[Voz WS] Error guardando pedido ${pedido.id} en DB:`, e.message);
            }

            if (resultado.orden.forma_pago === 'enlace de pago') {
              const folioVoz = deletrearFolio(pedido.id);
              textoExtra = `Tu número de folio es ${folioVoz}. Repito: ${folioVoz}. Mándanos ese folio por WhatsApp al mismo número y te enviamos el enlace de pago. ¿Lo anotaste?`;
              folioInfo = { texto: `Tu folio es ${folioVoz}. ¿Lo tienes anotado?` };
              if (fromNum) {
                await setPagoPendiente(fromNum, pedido.id);
                console.log(`[Voz WS] Pago pendiente para ${fromNum} — pedido ${pedido.id}`);
              }
            }
          }

          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'text',
              token: textoExtra ? limpiarParaVoz(textoExtra) : ' ',
              last: true
            }));
          }

          if (resultado.orden) {
            // Si hay folio, esperar respuesta del cliente; si no, colgar pronto
            programarCierre(folioInfo ? 30000 : 8000);
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

// Convierte un número entero a palabras en español (rango 0–9999)
function numToWordsES(n) {
  n = Math.round(n);
  if (n === 0) return 'cero';
  if (n === 100) return 'cien';
  if (n === 1000) return 'mil';

  const unidades = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
  const veintiX   = { 21:'veintiuno',22:'veintidós',23:'veintitrés',24:'veinticuatro',
    25:'veinticinco',26:'veintiséis',27:'veintisiete',28:'veintiocho',29:'veintinueve' };
  const decenas   = ['','','veinte','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa'];
  const centenas  = ['','ciento','doscientos','trescientos','cuatrocientos','quinientos',
    'seiscientos','setecientos','ochocientos','novecientos'];

  let r = '';
  if (n >= 1000) {
    const m = Math.floor(n / 1000);
    r += (m === 1 ? 'mil' : numToWordsES(m) + ' mil');
    n %= 1000;
    if (n > 0) r += ' ';
  }
  if (n >= 100) {
    r += centenas[Math.floor(n / 100)];
    n %= 100;
    if (n > 0) r += ' ';
  }
  if (n > 0) {
    if (n <= 20) r += unidades[n];
    else if (veintiX[n]) r += veintiX[n];
    else {
      r += decenas[Math.floor(n / 10)];
      const u = n % 10;
      if (u) r += ' y ' + unidades[u];
    }
  }
  return r.trim();
}

// Limpia y adapta el texto para TTS — convierte números a palabras
function limpiarParaVoz(texto) {
  return texto
    // $180 → "ciento ochenta pesos"
    .replace(/\$\s?([\d,]+)/g, (_, num) => {
      const n = parseInt(num.replace(/,/g, ''), 10);
      return numToWordsES(n) + ' pesos';
    })
    // Números solos de 2+ dígitos que queden (ej. totales sin $)
    .replace(/\b(\d{2,5})\b/g, (_, num) => {
      const n = parseInt(num, 10);
      return n <= 9999 ? numToWordsES(n) : num;
    })
    .replace(/\$/g, '')
    .replace(/\*/g, '')
    .replace(/#/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default router;
