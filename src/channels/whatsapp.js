// Webhook para mensajes de WhatsApp via Twilio
// Twilio llama a POST /webhook/whatsapp cada vez que el cliente manda un mensaje

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';

const router = Router();
const NUMERO_SOPORTE = process.env.WHATSAPP_SOPORTE; // Número de Mario para recibir alertas

// Envía notificación de escalación a Mario por SMS
async function notificarEscalacion(numeroCliente, twilioClient) {
  if (!NUMERO_SOPORTE) return;
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_SMS_NUMBER, // Número de voz/SMS de Twilio
      to: NUMERO_SOPORTE,
      body: `XABOR - Cliente pide atención humana: ${numeroCliente.replace('whatsapp:', '')}\nEntra a business.facebook.com para atenderlo.`
    });
    console.log(`[WhatsApp] Escalación notificada por SMS a soporte`);
  } catch (e) {
    console.error('[WhatsApp] Error al notificar escalación:', e.message);
  }
}

router.post('/', async (req, res) => {
  const { Body: mensajeTexto, From: numeroCliente, WaId: waId } = req.body;

  if (!mensajeTexto || !numeroCliente) {
    return res.status(400).send('Parámetros faltantes');
  }

  const sessionId = `wa-${waId || numeroCliente.replace('whatsapp:', '')}`;
  console.log(`[WhatsApp] ${numeroCliente}: ${mensajeTexto}`);

  try {
    const resultado = await procesarMensaje(sessionId, mensajeTexto);

    // Si hay orden confirmada, registrarla y emitirla al panel
    if (resultado.orden) {
      resultado.orden.canal = 'whatsapp';
      resultado.orden.cliente.telefono = resultado.orden.cliente.telefono || waId;
      const pedido = registrarPedido(resultado.orden, 'whatsapp');
      emitirPedido(pedido);
    }

    // Si hay escalación, notificar a soporte
    if (resultado.escalar) {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      notificarEscalacion(numeroCliente, twilioClient);
    }

    // Responder con TwiML
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(resultado.texto);
    console.log(`[WhatsApp] Respuesta enviada a ${numeroCliente}`);

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (error) {
    console.error('[WhatsApp] Error:', error.message);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpe, tuve un problema. Por favor intente de nuevo en un momento.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

export default router;
