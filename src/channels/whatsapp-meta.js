// Canal WhatsApp via Meta Cloud API (sin Twilio)
// Twilio se conserva SOLO para llamadas de voz

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { obtenerCliente, upsertCliente, guardarPedido, obtenerUltimosPedidos, guardarMensaje, getBotPausado, getPagoPendiente, clearPagoPendiente, obtenerPedidoActivoPorFolio } from '../services/database.js';
import { procesarAprobacion } from '../services/learner.js';
import { crearLinkDePago } from '../services/clip-api.js';

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

// ─── Enviar imagen via Meta Graph API ────────────────────────────────────────
export async function enviarImagen(telefono, imageUrl, caption = '') {
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
      type: 'image',
      image: { link: imageUrl, caption }
    })
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (imagen): ${JSON.stringify(err)}`);
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

    // Comandos de Mario (APROBAR/RECHAZAR sugerencias del learner)
    const esMario = telefono === (process.env.MARIO_TELEFONO || '528781091115');
    if (esMario) {
      const esComando = await procesarAprobacion(texto);
      if (esComando) return;
    }

    // Si el bot está pausado para este cliente, no procesar — el equipo atiende manualmente
    const pausado = await getBotPausado(telefono);
    if (pausado) {
      console.log(`[Meta WA] Bot pausado para ${telefono} — mensaje ignorado por el bot`);
      return;
    }

    // Detectar si el cliente manda un folio para pagar ("folio 023", "XAB-0023", etc.)
    const matchFolio = texto.match(/(?:folio\s*(?:XAB-?)?|XAB-?)(\d{1,4})/i);
    if (matchFolio && process.env.CLIP_API_KEY) {
      const num   = matchFolio[1].padStart(4, '0');
      const folio = `XAB-${num}`;
      const pedidoDB = await obtenerPedidoActivoPorFolio(folio);
      if (pedidoDB && pedidoDB.forma_pago === 'enlace de pago' && !pedidoDB.pago_confirmado) {
        try {
          const clip = await crearLinkDePago({
            pedidoId:    folio,
            total:       pedidoDB.total,
            descripcion: `Pedido Xabor #${folio}`,
            cliente:     pedidoDB.cliente || {}
          });
          const msg = `Aquí está tu enlace de pago para el pedido ${folio}:\n${clip.url}\n\nTotal: $${pedidoDB.total} MXN`;
          await enviarMensaje(telefono, msg);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msg);
          console.log(`[Meta WA] Link de pago enviado por folio ${folio} a ${telefono}`);
        } catch (e) {
          console.error('[Meta WA] Error enviando link por folio:', e.message);
        }
        return;
      }
    }

    // Si tiene un enlace de pago pendiente de una llamada, enviarlo y terminar
    const pedidoPendiente = await getPagoPendiente(telefono);
    if (pedidoPendiente && process.env.CLIP_API_KEY) {
      try {
        const { obtenerPedidoPorId } = await import('../orders/orderManager.js');
        const pedido = obtenerPedidoPorId(pedidoPendiente);
        const total = pedido?.total || 0;
        const clip = await crearLinkDePago({
          pedidoId:    pedidoPendiente,
          total,
          descripcion: `Pedido Xabor #${pedidoPendiente}`,
          cliente:     pedido?.cliente || {}
        });
        await clearPagoPendiente(telefono);
        const mensajePago = `Aquí está tu enlace de pago para tu pedido Xabor:\n${clip.url}\n\nTotal: $${total} MXN`;
        await enviarMensaje(telefono, mensajePago);
        await guardarMensaje(telefono, null, 'saliente', mensajePago);
        console.log(`[Meta WA] Link de pago enviado a ${telefono} para pedido ${pedidoPendiente}`);
      } catch (e) {
        console.error('[Meta WA] Error enviando link pendiente:', e.message);
      }
      return;
    }

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
    let linkPago = null;
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
      // Generar link de pago Clip solo si el cliente eligió ese método
      if (resultado.orden.forma_pago === 'enlace de pago' && process.env.CLIP_API_KEY && process.env.CLIP_API_SECRET) {
        try {
          const clip = await crearLinkDePago({
            pedidoId:    pedido.id,
            total:       resultado.orden.total,
            descripcion: `Pedido Xabor #${pedido.id}`,
            cliente:     resultado.orden.cliente
          });
          linkPago = clip.url;
        } catch (e) {
          console.error('[Clip] Error al generar link de pago:', e.message);
        }
      }
    }

    // Si hay escalación, notificar a soporte por SMS
    if (resultado.escalar) {
      await notificarEscalacion(telefono);
    }

    // Si el bot quiere enviar el menú como imagen, enviarlo primero
    const baseUrl = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
    if (resultado.enviarMenu) {
      try {
        await enviarImagen(telefono, `${baseUrl}/public/menu.png`);
      } catch (e) {
        console.error('[Meta WA] Error enviando imagen de menú:', e.message);
      }
    }

    // Enviar respuesta al cliente
    await enviarMensaje(telefono, resultado.texto);
    console.log(`[Meta WA] Respuesta enviada a ${telefono}`);

    // Guardar mensaje saliente y emitir al panel
    const msgSaliente = await guardarMensaje(telefono, nombreMeta, 'saliente', resultado.texto);
    if (msgSaliente && wsBroadcast) {
      wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgSaliente });
    }

    // Enviar link de pago Clip como mensaje separado
    if (linkPago) {
      const mensajePago = `Para pagar con tarjeta, usa este enlace:\n${linkPago}`;
      await enviarMensaje(telefono, mensajePago);
      const msgPago = await guardarMensaje(telefono, nombreMeta, 'saliente', mensajePago);
      if (msgPago && wsBroadcast) {
        wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgPago });
      }
    }

  } catch (error) {
    console.error('[Meta WA] Error:', error.message);
  }
});

export default router;
