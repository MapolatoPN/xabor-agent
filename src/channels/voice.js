// Webhook para llamadas de voz via Twilio + Deepgram (STT) + ElevenLabs (TTS)
// Flujo: Cliente llama → Twilio → /webhook/voice/start
//        Cliente habla  → Twilio graba → /webhook/voice/transcribe
//        Deepgram transcribe → Claude responde → ElevenLabs sintetiza → Twilio reproduce

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { transcribirAudio } from '../services/deepgram.js';
import { sintetizarVoz } from '../services/elevenlabs.js';

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Inicio de llamada ───────────────────────────────────────────────────────
// Twilio llama aquí cuando alguien marca el número
router.post('/start', async (req, res) => {
  const callSid = req.body.CallSid;
  const sessionId = `call-${callSid}`;

  console.log(`[Voz] Nueva llamada: ${callSid}`);

  try {
    // Generamos la bienvenida del agente
    const resultado = await procesarMensaje(sessionId, 'Hola');
    const audioUrl = await sintetizarVoz(resultado.texto, callSid, 'bienvenida');

    const twiml = new VoiceResponse();

    // Reproducir bienvenida y luego capturar respuesta del cliente
    twiml.play(audioUrl);
    twiml.record({
      action: `/webhook/voice/transcribe?session=${sessionId}`,
      method: 'POST',
      maxLength: 30,           // máximo 30 seg de grabación por turno
      playBeep: false,
      trim: 'trim-silence',
      transcribe: false        // usamos Deepgram, no Twilio
    });

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
// Twilio llama aquí con la grabación del cliente
router.post('/transcribe', async (req, res) => {
  const sessionId = req.query.session;
  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;

  console.log(`[Voz] Grabación recibida para sesión ${sessionId}`);

  const twiml = new VoiceResponse();

  try {
    // 1. Transcribir audio con Deepgram
    const textoCliente = await transcribirAudio(recordingUrl);
    console.log(`[Voz] Cliente dijo: "${textoCliente}"`);

    if (!textoCliente || textoCliente.trim() === '') {
      // Cliente no dijo nada, pedir que repita
      const audioUrl = await sintetizarVoz(
        '¿Me puedes repetir eso? No te escuché bien.',
        callSid,
        'silencio'
      );
      twiml.play(audioUrl);
      twiml.record({
        action: `/webhook/voice/transcribe?session=${sessionId}`,
        method: 'POST',
        maxLength: 30,
        playBeep: false,
        trim: 'trim-silence',
        transcribe: false
      });
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // 2. Procesar con el cerebro del agente
    const resultado = await procesarMensaje(sessionId, textoCliente);

    // 3. Si hay orden confirmada, registrarla
    if (resultado.orden) {
      resultado.orden.canal = 'voz';
      const pedido = registrarPedido(resultado.orden, 'voz');
      emitirPedido(pedido);
    }

    // 4. Sintetizar respuesta con ElevenLabs
    const audioUrl = await sintetizarVoz(resultado.texto, callSid, Date.now());

    // 5. Si el pedido fue confirmado, colgar después de la despedida
    const esFinalizacion = resultado.orden !== null;

    twiml.play(audioUrl);

    if (esFinalizacion) {
      twiml.hangup();
    } else {
      // Continuar escuchando
      twiml.record({
        action: `/webhook/voice/transcribe?session=${sessionId}`,
        method: 'POST',
        maxLength: 30,
        playBeep: false,
        trim: 'trim-silence',
        transcribe: false
      });
    }

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (error) {
    console.error('[Voz] Error en transcripción:', error.message);
    twiml.say({ language: 'es-MX' }, 'Tuve un problema, por favor repite.');
    twiml.record({
      action: `/webhook/voice/transcribe?session=${sessionId}`,
      method: 'POST',
      maxLength: 30,
      playBeep: false,
      trim: 'trim-silence',
      transcribe: false
    });
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

export default router;
