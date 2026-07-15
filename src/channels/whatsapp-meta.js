// Canal WhatsApp via Meta Cloud API (sin Twilio)
// Twilio se conserva SOLO para llamadas de voz

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { obtenerCliente, upsertCliente, guardarPedido, obtenerUltimosPedidos, guardarMensaje } from '../services/database.js';

let wsBroadcast = null;
export function setWsBroadcastWA(fn) { wsBroadcast = fn; }

const router = Router();

const PHONE_NUMBER_ID  = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN     = process.env.META_WHATSAPP_TOKEN;
const VERIFY_TOKEN     = process.env.META_VERIFY_TOKEN;
const NUMERO_SOPORTE   = process.env.WHATSAPP_SOPORTE;

// ─── Verificación del webhook (GET) — Meta lo llama al configurar ────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Meta WA] ✅ Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[Meta WA] ⚠️ Verificación fallida — token incorrecto');
  res.sendStatus(403);
});

// ─── Enviar mensaje de texto via Meta Graph API ──────────────────────────────
export async function enviarMensaje(telefono, texto) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'text',
      text: { preview_url: false, body: texto }
    })
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API: ${JSON.stringify(err)}`);
  }
  return resp.json();
}

// ─── Marcar mensaje como leído (mejora UX) ───────────────────────────────────
async function marcarLeido(messageId) {
  try {
    await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      })
    });
  } catch (_) { /* no crítico */ }
}

// ─── Notificación de escalación por SMS (sigue usando Twilio SMS) ─────────────
async function notificarEscalacion(telefono) {
  if (!NUMERO_SOPORTE || !process.env.TWILIO_SMS_NUMBER) return;
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: process.env.TWILIO_SMS_NUMBER,
      to: NUMERO_SOPORTE,
      body: `XABOR - Cliente pide atención humana: ${telefono}\nEntra a business.facebook.com para atenderlo.`
    });
    console.log('[Meta WA] Escalación notificada por SMS');
  } catch (e) {
    console.error('[Meta WA] Error al notificar escalación:', e.message);
  }
}

// ─── Webhook de mensajes entrantes (POST) ────────────────────────────────────
router.post('/', async (req, res) => {
  // Meta requiere respuesta 200 inmediata, aunque tardemos en procesar
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value   = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    // Solo procesar mensajes de texto entrantes
    if (!message || message.type !== 'text') return;

    const telefono      = message.from;          // ej. "5218787899919"
    const texto         = message.text.body;
    const messageId     = message.id;
    const nombreMeta    = value.contacts?.[0]?.profile?.name || '';

    console.log(`[Meta WA] ${telefono} (${nombreMeta}): ${texto}`);

    // Guardar mensaje entrante y emitir al panel
    const msgGuardado = await guardarMensaje(telefono, nombreMeta, 'entrante', texto);
    if (msgGuardado && wsBroadcast) {
      wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgGuardado });
    }

    // Marcar como leído
    await marcarLeido(messageId);

    // Buscar cliente en BD y construir contexto
    const clienteDB = await obtenerCliente(telefono);
    const pedidosAnteriores = clienteDB ? await obtenerUltimosPedidos(telefono) : [];
    const clienteCtx = clienteDB
      ? { nombre: clienteDB.nombre || nombreMeta, pedidos: pedidosAnteriores }
      : null;

    // Registrar/actualizar cliente con nombre de WhatsApp
    if (nombreMeta) await upsertCliente(telefono, nombreMeta);

    const sessionId = `meta-${telefono}`;
    const resultado = await procesarMensaje(sessionId, texto, clienteCtx);

    // Si hay orden confirmada, registrar y emitir al panel
    if (resultado.orden) {
      resultado.orden.canal    = 'whatsapp';
      resultado.orden.cliente.telefono = resultado.orden.cliente.telefono || telefono;
      const pedido = registrarPedido(resultado.orden, 'whatsapp');
      emitirPedido(pedido);
      // Guardar en BD
      await guardarPedido(telefono, resultado.orden);
      // Actualizar nombre si lo capturó el agente
      if (resultado.orden.cliente?.nombre) {
        await upsertCliente(telefono, resultado.orden.cliente.nombre);
      }
    }

    // Si hay escalación, notificar a soporte por SMS
    if (resultado.escalar) {
      await notificarEscalacion(telefono);
    }

    // Enviar respuesta al cliente
    await enviarMensaje(telefono, resultado.texto);
    console.log(`[Meta WA] Respuesta enviada a ${telefono}`);

    // Guardar mensaje saliente y emitir al panel
    const msgSaliente = await guardarMensaje(telefono, nombreMeta, 'saliente', resultado.texto);
    if (msgSaliente && wsBroadcast) {
      wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgSaliente });
    }

  } catch (error) {
    console.error('[Meta WA] Error:', error.message);
  }
});

export default router;
