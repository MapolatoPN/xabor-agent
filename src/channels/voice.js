// Canal de voz — Twilio Conversation Relay + ElevenLabs TTS
// Flujo: Cliente llama → /start → TwiML <ConversationRelay> → WebSocket /ws/voice
//        Twilio transcribe en tiempo real → nosotros procesamos → ElevenLabs → play URL
//        El cliente puede interrumpir al bot en cualquier momento

import { Router } from 'express';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { sintetizarVoz } from '../services/elevenlabs.js';
import { setPagoPendiente } from '../services/database.js';

const router = Router();

const BASE_URL = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
const WS_URL   = BASE_URL.replace(/^https?:\/\//, 'wss://');

// Mapa de sesiones activas: callSid → { sessionId, fromNum }
const sesiones = new Map();

// ─── Inicio de llamada ───────────────────────────────────────────────────────
// Twilio llama aquí cuando alguien marca el número.
// Respondemos con TwiML que conecta a nuestro WebSocket.
router.post('/start', (req, res) => {
  const callSid = req.body.CallSid;
  const fromNum = req.body.From;
  const sessionId = `call-${callSid}`;

  sesiones.set(callSid, { sessionId, fromNum });
  console.log(`[Voz] Nueva llamada: ${callSid} desde ${fromNum}`);

  // TwiML raw — el SDK de Twilio puede no tener <ConversationRelay> según versión
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${WS_URL}/ws/voice"
      interruptible="true"
      dtmfDetection="false"
      ttsProvider="elevenlabs"
    />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// ─── WebSocket — Conversation Relay ─────────────────────────────────────────
// Llamado desde server.js al recibir conexión en /ws/voice
export function setupVoiceWebSocket(wssVoice) {
  wssVoice.on('connection', (ws) => {
    let callSid    = null;
    let sessionId  = null;
    let fromNum    = null;
    let procesando = false; // evitar peticiones paralelas

    console.log('[Voz WS] Conexión entrante');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // ── Setup: primera trama, Twilio nos da callSid y número ──────────────
      if (msg.type === 'setup') {
        callSid   = msg.callSid;
        const ses = sesiones.get(callSid);
        sessionId = ses?.sessionId || `call-${callSid}`;
        fromNum   = ses?.fromNum   || msg.from;
        sesiones.set(callSid, { ...ses, ws });

        console.log(`[Voz WS] Setup — ${callSid} desde ${fromNum}`);

        // Saludo inicial
        try {
          const resultado = await procesarMensaje(sessionId, 'Hola');
          const audioUrl  = await sintetizarVoz(resultado.texto, callSid, 'bienvenida');
          enviarAudio(ws, audioUrl);
        } catch (e) {
          console.error('[Voz WS] Error en saludo:', e.message);
          enviarTexto(ws, 'Bienvenido a Xabor, ¿en qué te podemos servir?');
        }
        return;
      }

      // ── Prompt: Twilio terminó de transcribir lo que dijo el cliente ──────
      if (msg.type === 'prompt') {
        const texto = (msg.text || '').trim();
        console.log(`[Voz WS] Cliente: "${texto}"`);
        if (!texto || procesando) return;

        procesando = true;
        try {
          const resultado = await procesarMensaje(sessionId, texto);

          // Orden confirmada
          if (resultado.orden) {
            resultado.orden.canal = 'voz';
            const pedido = registrarPedido(resultado.orden, 'voz');
            emitirPedido(pedido);

            if (resultado.orden.forma_pago === 'enlace de pago' && fromNum) {
              await setPagoPendiente(fromNum, pedido.id);
              console.log(`[Voz WS] Pago pendiente para ${fromNum} — pedido ${pedido.id}`);
            }
            sesiones.delete(callSid);
          }

          const audioUrl = await sintetizarVoz(resultado.texto, callSid, Date.now());
          enviarAudio(ws, audioUrl);

          if (resultado.orden) {
            // Pequeña pausa para que termine el audio antes de colgar
            setTimeout(() => {
              try { ws.send(JSON.stringify({ type: 'end' })); } catch (_) {}
            }, 4000);
          }

        } catch (e) {
          console.error('[Voz WS] Error procesando mensaje:', e.message);
          try {
            const audioErr = await sintetizarVoz(
              'Perdón, tuve un problema. ¿Me puedes repetir?',
              callSid,
              'error'
            );
            enviarAudio(ws, audioErr);
          } catch {
            enviarTexto(ws, 'Perdón, tuve un problema. ¿Me puedes repetir?');
          }
        } finally {
          procesando = false;
        }
        return;
      }

      // ── Interrupt: el cliente habló mientras el bot respondía ─────────────
      if (msg.type === 'interrupt') {
        console.log(`[Voz WS] Interrupción — ${callSid}`);
        // Twilio ya detuvo el audio automáticamente; el siguiente 'prompt' llegará pronto
      }
    });

    ws.on('close', () => {
      console.log(`[Voz WS] Conexión cerrada — ${callSid}`);
      if (callSid) sesiones.delete(callSid);
    });

    ws.on('error', (e) => console.error('[Voz WS] Error:', e.message));
  });
}

// ─── Helpers de envío ────────────────────────────────────────────────────────

function enviarAudio(ws, url) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'play', url }));
}

function enviarTexto(ws, texto) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'text', token: texto, last: true }));
}

export default router;
