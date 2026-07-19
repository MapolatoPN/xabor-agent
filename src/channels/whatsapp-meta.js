// Canal WhatsApp via Meta Cloud API (sin Twilio)
// Twilio se conserva SOLO para llamadas de voz

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { obtenerCliente, upsertCliente, guardarPedido, obtenerUltimosPedidos, guardarMensaje, getBotPausado, getPagoPendiente, clearPagoPendiente, obtenerPedidoActivoPorFolio, obtenerPedidoPorFolioAmplio, guardarPedidoProgramado } from '../services/database.js';
import { procesarAprobacion } from '../services/learner.js';
import { crearLinkDePago } from '../services/clip-api.js';

let wsBroadcast = null;
export function setWsBroadcastWA(fn) { wsBroadcast = fn; }

// ─── Debounce de mensajes — espera 4s antes de procesar ──────────────────────
// Si el cliente manda varios mensajes seguidos, los combina en uno solo
const bufferMensajes = new Map(); // telefono → { textos: [], timer }

function encolarMensaje(telefono, texto, procesarFn) {
  if (bufferMensajes.has(telefono)) {
    const entry = bufferMensajes.get(telefono);
    clearTimeout(entry.timer);
    entry.textos.push(texto);
  } else {
    bufferMensajes.set(telefono, { textos: [texto] });
  }
  const entry = bufferMensajes.get(telefono);
  entry.timer = setTimeout(() => {
    const textosCombinados = bufferMensajes.get(telefono)?.textos.join('\n') || texto;
    bufferMensajes.delete(telefono);
    procesarFn(textosCombinados);
  }, 4000);
}

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

// ─── Procesamiento con Claude (se llama tras el debounce) ────────────────────
async function procesarConClaude(telefono, texto, nombreMeta) {
  try {
    // Folio para pago
    // Acepta: xab21, XAB-21, XAB-0021, folio 21, folio xab21, etc.
    const matchFolio = texto.match(/(?:xab[-\s]?(\d{1,4}))|(?:folio[\s:]*(?:xab[-\s]?)?(\d{1,4}))/i);
    const folioNum   = matchFolio?.[1] ?? matchFolio?.[2];
    if (folioNum && process.env.CLIP_API_KEY) {
      const folio    = `XAB-${folioNum.padStart(4, '0')}`;
      const pedidoDB = await obtenerPedidoPorFolioAmplio(folio);
      console.log(`[Meta WA] Folio detectado: ${folio} — origen: ${pedidoDB?._origen || 'no encontrado'}`);
      if (pedidoDB && !pedidoDB.pago_confirmado) {
        try {
          const clip = await crearLinkDePago({ pedidoId: folio, total: pedidoDB.total, descripcion: `Pedido Xabor #${folio}`, cliente: pedidoDB.cliente || {} });
          let msg = `Aquí está tu enlace de pago para el pedido ${folio}:\n${clip.url}\n\nTotal: $${pedidoDB.total} MXN`;
          if (pedidoDB._origen === 'programado' && pedidoDB.programado_para) {
            const horaStr = new Date(pedidoDB.programado_para).toLocaleString('es-MX', { timeZone: 'America/Matamoros', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true });
            msg += `\n\nTu pedido está programado para el ${horaStr}. Paga ahora y estará listo a esa hora.`;
          }
          await enviarMensaje(telefono, msg);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msg);
        } catch (e) {
          console.error('[Meta WA] Error enviando link por folio:', e.message);
          await enviarMensaje(telefono, `Encontramos tu pedido ${folio}, pero hubo un problema generando el enlace. Escríbenos y te lo enviamos manualmente.`);
        }
        return;
      }
      if (!pedidoDB) {
        await enviarMensaje(telefono, `No encontramos un pedido con el folio ${folio}. Verifica el número o escríbenos para ayudarte.`);
        await guardarMensaje(telefono, nombreMeta, 'saliente', `No encontramos pedido con folio ${folio}.`);
        return;
      }
    }

    // Pago pendiente de llamada
    const pedidoPendiente = await getPagoPendiente(telefono);
    if (pedidoPendiente && process.env.CLIP_API_KEY) {
      try {
        const { obtenerPedidoPorId } = await import('../orders/orderManager.js');
        const pedido = obtenerPedidoPorId(pedidoPendiente);
        const total  = pedido?.total || 0;
        const clip   = await crearLinkDePago({ pedidoId: pedidoPendiente, total, descripcion: `Pedido Xabor #${pedidoPendiente}`, cliente: pedido?.cliente || {} });
        await clearPagoPendiente(telefono);
        const mensajePago = `Aquí está tu enlace de pago para tu pedido Xabor:\n${clip.url}\n\nTotal: $${total} MXN`;
        await enviarMensaje(telefono, mensajePago);
        await guardarMensaje(telefono, null, 'saliente', mensajePago);
        console.log(`[Meta WA] Link de pago enviado a ${telefono}`);
      } catch (e) {
        console.error('[Meta WA] Error enviando link pendiente:', e.message);
      }
      return;
    }

    // Contexto del cliente
    const clienteDB = await obtenerCliente(telefono);
    const pedidosAnteriores = clienteDB ? await obtenerUltimosPedidos(telefono) : [];
    const clienteCtx = clienteDB ? { nombre: clienteDB.nombre || nombreMeta, pedidos: pedidosAnteriores } : null;
    if (nombreMeta) await upsertCliente(telefono, nombreMeta);

    const sessionId = `meta-${telefono}`;
    const resultado = await procesarMensaje(sessionId, texto, clienteCtx);

    // Orden confirmada
    let linkPago = null;
    if (resultado.orden) {
      resultado.orden.canal = 'whatsapp';
      resultado.orden.cliente.telefono = resultado.orden.cliente.telefono || telefono;
      const pedido = registrarPedido(resultado.orden, 'whatsapp');

      // Si es pedido programado, guardarlo aparte y NO enviarlo al panel todavía
      if (resultado.orden.programado_para) {
        await guardarPedidoProgramado(pedido.id, pedido, resultado.orden.programado_para);
        // Quitar del panel activo — se activará automáticamente 1h antes
        const { eliminarPedido } = await import('../orders/orderManager.js');
        await eliminarPedido(pedido.id);
        console.log(`[WA] Pedido programado ${pedido.id} para ${resultado.orden.programado_para}`);
      } else {
        emitirPedido(pedido);
      }
      await guardarPedido(telefono, resultado.orden);
      if (resultado.orden.cliente?.nombre) await upsertCliente(telefono, resultado.orden.cliente.nombre);
      if (resultado.orden.forma_pago === 'enlace de pago' && process.env.CLIP_API_KEY && process.env.CLIP_API_SECRET) {
        try {
          const clip = await crearLinkDePago({ pedidoId: pedido.id, total: resultado.orden.total, descripcion: `Pedido Xabor #${pedido.id}`, cliente: resultado.orden.cliente });
          linkPago = clip.url;
        } catch (e) { console.error('[Clip] Error al generar link de pago:', e.message); }
      }
    }

    if (resultado.escalar) await notificarEscalacion(telefono);

    const baseUrl = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
    if (resultado.enviarMenu) {
      try { await enviarImagen(telefono, `${baseUrl}/public/menu.png`); } catch (e) { console.error('[Meta WA] Error enviando menú:', e.message); }
    }

    await enviarMensaje(telefono, resultado.texto);
    console.log(`[Meta WA] Respuesta enviada a ${telefono}`);
    const msgSaliente = await guardarMensaje(telefono, nombreMeta, 'saliente', resultado.texto);
    if (msgSaliente && wsBroadcast) wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgSaliente });

    if (linkPago) {
      const mensajePago = `Para pagar con tarjeta, usa este enlace:\n${linkPago}`;
      await enviarMensaje(telefono, mensajePago);
      const msgPago = await guardarMensaje(telefono, nombreMeta, 'saliente', mensajePago);
      if (msgPago && wsBroadcast) wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgPago });
    }
  } catch (error) {
    console.error('[Meta WA] Error en procesarConClaude:', error.message);
  }
}

// ─── Webhook de mensajes entrantes (POST) ────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // Meta requiere 200 inmediato

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value   = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const telefono   = message.from;
    const texto      = message.text.body;
    const messageId  = message.id;
    const nombreMeta = value.contacts?.[0]?.profile?.name || '';

    console.log(`[Meta WA] ${telefono} (${nombreMeta}): ${texto}`);

    // Acciones inmediatas (no debounced)
    const msgGuardado = await guardarMensaje(telefono, nombreMeta, 'entrante', texto);
    if (msgGuardado && wsBroadcast) wsBroadcast({ tipo: 'nuevo_mensaje', mensaje: msgGuardado });
    await marcarLeido(messageId);

    // Comandos de Mario — sin debounce
    const ultimosDiez = t => t.slice(-10);
    const esMario = ultimosDiez(telefono) === ultimosDiez(process.env.MARIO_TELEFONO || '528781091115');
    if (esMario) {
      const esComando = await procesarAprobacion(texto);
      if (esComando) return;
    }

    // Bot pausado — sin debounce
    const pausado = await getBotPausado(telefono);
    if (pausado) {
      console.log(`[Meta WA] Bot pausado para ${telefono}`);
      return;
    }

    // Procesamiento con Claude — debounced 4 segundos
    // Si el cliente manda varios mensajes seguidos, se combinan en uno
    encolarMensaje(telefono, texto, (textoCombinado) => {
      procesarConClaude(telefono, textoCombinado, nombreMeta);
    });

  } catch (error) {
    console.error('[Meta WA] Error:', error.message);
  }
});

export default router;
