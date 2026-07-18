// Webhook para llamadas de voz via Twilio + ElevenLabs (TTS)
// STT: Twilio Gather input="speech" (más rápido que Record+Deepgram)
// Flujo: Cliente llama → /start → bienvenida + Gather
//        Cliente habla  → Twilio STT → /transcribe → Claude → ElevenLabs → reproduce

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { sintetizarVoz } from '../services/elevenlabs.js';
import { setPagoPendiente } from '../services/database.js';

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

// Mapa para guardar el número de origen de cada llamada
const llamadasActivas = new Map(); // sessionId → telefonoFrom

// ─── Helper: responder con audio + Gather ────────────────────────────────────
function responderYEscuchar(twiml, audioUrl, sessionId) {
  twiml.play(audioUrl);
  const gather = twiml.gather({
    input:        'speech',
    action:       `/webhook/voice/transcribe?session=${sessionId}`,
    method:       'POST',
    language:     'es-MX',
    speechTimeout: 'auto',
    speechModel:  'phone_call',
  });
  // Fallback silencio: redirigir de vuelta para que el cliente vuelva a hablar
  twiml.redirect({
    method: 'POST'
  }, `/webhook/voice/transcribe?session=${sessionId}&silencio=true`);
}

// ─── Inicio de llamada ───────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
  const callSid   = req.body.CallSid;
  const fromNum   = req.body.From;
  const sessionId = `call-${callSid}`;

  llamadasActivas.set(sessionId, fromNum);
  console.log(`[Voz] Nueva llamada: ${callSid} desde ${fromNum}`);

  try {
    const resultado = await procesarMensaje(sessionId, 'Hola');
    const audioUrl  = await sintetizarVoz(resultado.texto, callSid, 'bienvenida');

    const twiml = new VoiceResponse();
    responderYEscuchar(twiml, audioUrl, sessionId);

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (error) {
    console.error('[Voz] Error en inicio:', error.message);
    const twiml = new VoiceResponse();
    twiml.say({ language: 'es-MX' }, 'Lo sentimos, hay un problema técnico. Por favor llame más tarde.');
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// ─── Transcripción y respuesta ───────────────────────────────────────────────
// Twilio llama aquí con SpeechResult ya transcrito (sin pasar por Deepgram)
router.post('/transcribe', async (req, res) => {
  const sessionId   = req.query.session;
  const callSid     = req.body.CallSid;
  const silencio    = req.query.silencio === 'true';
  const textoCliente = (req.body.SpeechResult || '').trim();

  console.log(`[Voz] Sesión ${sessionId} — "${textoCliente || '(silencio)'}"`);

  const twiml = new VoiceResponse();

  // Sin voz detectada → pedir que repita
  if (silencio || !textoCliente) {
    try {
      const audioUrl = await sintetizarVoz(
        '¿Sigues ahí? Puedes hablar cuando quieras.',
        callSid,
        'silencio'
      );
      responderYEscuchar(twiml, audioUrl, sessionId);
    } catch (_) {
      twiml.say({ language: 'es-MX' }, '¿Sigues ahí? Puedes hablar cuando quieras.');
      twiml.redirect({ method: 'POST' }, `/webhook/voice/transcribe?session=${sessionId}&silencio=true`);
    }
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    // 1. Procesar con el cerebro del agente
    const resultado = await procesarMensaje(sessionId, textoCliente);

    // 2. Si hay orden confirmada, registrarla
    if (resultado.orden) {
      resultado.orden.canal = 'voz';
      const pedido = registrarPedido(resultado.orden, 'voz');
      emitirPedido(pedido);

      // Si eligió enlace de pago, guardar pendiente para cuando mande WhatsApp
      if (resultado.orden.forma_pago === 'enlace de pago') {
        const telefonoCliente = llamadasActivas.get(sessionId)
          || resultado.orden.cliente?.telefono;
        if (telefonoCliente) {
          await setPagoPendiente(telefonoCliente, pedido.id);
          console.log(`[Voz] Pago pendiente guardado para ${telefonoCliente} — pedido ${pedido.id}`);
        }
      }

      llamadasActivas.delete(sessionId);
    }

    // 3. Sintetizar respuesta con ElevenLabs
    const audioUrl = await sintetizarVoz(resultado.texto, callSid, Date.now());

    // 4. Reproducir y colgar o seguir escuchando
    if (resultado.orden) {
      twiml.play(audioUrl);
      twiml.hangup();
    } else {
      responderYEscuchar(twiml, audioUrl, sessionId);
    }

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (error) {
    console.error('[Voz] Error en transcripción:', error.message);
    try {
      const audioUrl = await sintetizarVoz(
        'Perdón, tuve un problema. ¿Me puedes repetir?',
        callSid,
        'error'
      );
      responderYEscuchar(twiml, audioUrl, sessionId);
    } catch (_) {
      twiml.say({ language: 'es-MX' }, 'Perdón, tuve un problema. ¿Me puedes repetir?');
      twiml.redirect({ method: 'POST' }, `/webhook/voice/transcribe?session=${sessionId}`);
    }
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

export default router;
