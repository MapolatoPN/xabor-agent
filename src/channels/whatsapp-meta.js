// Canal WhatsApp via Meta Cloud API (sin Twilio)
// Twilio se conserva SOLO para llamadas de voz

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { obtenerCliente, upsertCliente, guardarPedido, obtenerUltimosPedidos, guardarMensaje, getBotPausado, getPagoPendiente, clearPagoPendiente, obtenerPedidoActivoPorFolio, obtenerPedidoPorFolioAmplio, guardarPedidoProgramado, guardarLinkPago, obtenerPedidosActivosPorTelefono, obtenerUltimoPedidoEntregadoPorTelefono, obtenerRepartidores, obtenerRepartidorPorTelefono, registrarRepartidor } from '../services/database.js';
import { generarFactura, enviarFacturaPorEmail } from '../services/facturapi.js';
import { procesarAprobacion } from '../services/learner.js';
import { crearLinkDePago } from '../services/clip-api.js';
import { getIntegracion } from '../server.js';

let wsBroadcast = null;
export function setWsBroadcastWA(fn) { wsBroadcast = fn; }

// ─── Monitor de errores críticos ─────────────────────────────────────────────
const errores = []; // timestamps de errores recientes
const VENTANA_MS   = 5 * 60 * 1000; // 5 minutos
const UMBRAL       = 3;              // 3 errores en 5 min → alerta
let alertaEnviada  = false;

function registrarError() {
  const ahora = Date.now();
  errores.push(ahora);
  // Limpiar errores fuera de la ventana
  while (errores.length && errores[0] < ahora - VENTANA_MS) errores.shift();
  if (errores.length >= UMBRAL && !alertaEnviada) {
    alertaEnviada = true;
    const admin = getIntegracion('wa_admin_numero') || process.env.WHATSAPP_ADMIN_NUMERO;
    if (admin) {
      enviarMensaje(admin, `🚨 *Xabor alerta*: el bot tuvo ${errores.length} errores en los últimos 5 minutos. Revisar Railway logs.`)
        .catch(() => {});
    }
    // Reset alerta tras 15 minutos
    setTimeout(() => { alertaEnviada = false; }, 15 * 60 * 1000);
  }
}

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
  }, 6000);
}

const router = Router();

// Leídos en runtime para respetar configuración desde panel
const getPhoneNumberId = () => getIntegracion('wa_phone_id')  || process.env.META_PHONE_NUMBER_ID;
const getAccessToken   = () => getIntegracion('wa_token')      || process.env.META_WHATSAPP_TOKEN;
const getVerifyToken   = () => getIntegracion('wa_verify_token')|| process.env.META_VERIFY_TOKEN;
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
  const url = `https://graph.facebook.com/v20.0/${getPhoneNumberId()}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getAccessToken()}`,
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
  const url = `https://graph.facebook.com/v20.0/${getPhoneNumberId()}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getAccessToken()}`,
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
    await fetch(`https://graph.facebook.com/v20.0/${getPhoneNumberId()}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getAccessToken()}`,
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

// ─── Notificación de escalación — WhatsApp al admin + SMS fallback ───────────
const getAdminWA = () => getIntegracion('wa_admin_numero') || process.env.WHATSAPP_ADMIN_NUMERO;
async function notificarEscalacion(telefono) {
  // Notificación por WhatsApp al número admin
  if (getAdminWA()) {
    try {
      await enviarMensaje(getAdminWA(), `⚠️ Cliente solicita atención humana: ${telefono}\nEntra a business.facebook.com para atenderlo.`);
      console.log('[Meta WA] Escalación notificada por WhatsApp al admin');
    } catch (e) {
      console.error('[Meta WA] Error notificando escalación por WA:', e.message);
    }
  }
  // SMS fallback (Twilio) si está configurado
  if (NUMERO_SOPORTE && process.env.TWILIO_SMS_NUMBER) {
    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        from: process.env.TWILIO_SMS_NUMBER,
        to: NUMERO_SOPORTE,
        body: `XABOR - Cliente pide atención humana: ${telefono}\nEntra a business.facebook.com para atenderlo.`
      });
      console.log('[Meta WA] Escalación notificada por SMS');
    } catch (e) {
      console.error('[Meta WA] Error al notificar escalación SMS:', e.message);
    }
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
        // Guardar link_id para reconciliación automática
        await guardarLinkPago(pedidoPendiente, clip.linkId);
        const mensajePago = `Aquí está tu enlace de pago para tu pedido Xabor:\n${clip.url}\n\nTotal: $${total} MXN`;
        await enviarMensaje(telefono, mensajePago);
        await guardarMensaje(telefono, null, 'saliente', mensajePago);
        console.log(`[Meta WA] Link de pago enviado a ${telefono}`);
      } catch (e) {
        console.error('[Meta WA] Error enviando link pendiente:', e.message);
      }
      return;
    }

    // ── Consulta de estado de pedido ──────────────────────────────────────────
    // Si el cliente pregunta por su pedido, respondemos directamente sin Claude
    const esConsultaEstado = /en\s*qu[eé]\s*va|estado.*pedido|cu[aá]nto\s*falta|ya\s*est[aá]\s*list|mi\s*pedido|est[aá]\s*list[oa]|lista\s*mi|list[oa]\s*mi|salió.*pedido|pedido.*salió|preparando|me\s*avis[ae]n/i.test(texto);
    if (esConsultaEstado) {
      const pedidosActivos = await obtenerPedidosActivosPorTelefono(telefono);
      if (pedidosActivos.length > 0) {
        const etiquetas = {
          'nuevo':          'fue recibido y está en espera de preparación',
          'en_preparacion': 'está siendo preparado en cocina',
          'listo':          'está listo. Puedes venir a recogerlo o ya está en camino',
          'entregado':      'ya fue entregado'
        };
        const p = pedidosActivos[0];
        const desc = etiquetas[p.estado] || p.estado;
        const items = (p.datos?.items || []).map(i => `${i.cantidad > 1 ? i.cantidad + 'x ' : ''}${i.nombre}`).join(', ');
        const extra = p.estado === 'listo' ? ' ¡Gracias por tu preferencia!' : '';
        const msg = `Tu pedido ${p.folio}${items ? ` (${items})` : ''} ${desc}.${extra}`;
        await enviarMensaje(telefono, msg);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msg);
        console.log(`[Meta WA] Estado de pedido enviado a ${telefono}: ${p.folio} → ${p.estado}`);
        return;
      }
      // Si no hay pedidos activos, Claude responderá de forma natural
    }

    // Contexto del cliente
    const clienteDB = await obtenerCliente(telefono);
    const pedidosAnteriores = clienteDB ? await obtenerUltimosPedidos(telefono) : [];
    const clienteCtx = clienteDB ? { nombre: clienteDB.nombre || nombreMeta, pedidos: pedidosAnteriores } : null;
    if (nombreMeta) await upsertCliente(telefono, nombreMeta);

    const sessionId = `meta-${telefono}`;

    // Si Claude tarda más de 8s, avisamos al cliente para que no piense que el bot falló
    let waitMessageSent = false;
    const waitTimer = setTimeout(async () => {
      waitMessageSent = true;
      const msgEspera = 'Dame un momento, estoy procesando tu solicitud... 🕐';
      await enviarMensaje(telefono, msgEspera);
      await guardarMensaje(telefono, nombreMeta, 'saliente', msgEspera);
    }, 8000);

    const resultado = await procesarMensaje(sessionId, texto, clienteCtx);
    clearTimeout(waitTimer);

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
          await guardarLinkPago(pedido.id, clip.linkId);
        } catch (e) { console.error('[Clip] Error al generar link de pago:', e.message); }
      }
    }

    if (resultado.escalar) await notificarEscalacion(telefono);

    const baseUrl = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
    if (resultado.enviarMenu) {
      try { await enviarImagen(telefono, `${baseUrl}/public/menu.png`); } catch (e) { console.error('[Meta WA] Error enviando menú:', e.message); }
    }

    // ── Factura CFDI solicitada por WhatsApp ──────────────────────────────────
    if (resultado.factura && process.env.FACTURAPI_KEY) {
      try {
        const datosFactura = resultado.factura;
        // Si no viene el folio en el marcador, usar el último pedido entregado del cliente
        let pedido = null;
        if (datosFactura.folio) {
          const { obtenerPedidoActivoPorFolio: _paf } = await import('../services/database.js');
          pedido = await _paf(datosFactura.folio) || await obtenerUltimoPedidoEntregadoPorTelefono(telefono);
          if (pedido && !pedido.id) pedido.id = datosFactura.folio;
        } else {
          pedido = await obtenerUltimoPedidoEntregadoPorTelefono(telefono);
        }

        if (!pedido) {
          await enviarMensaje(telefono, 'No encontré un pedido reciente para facturar. Si tienes el folio (ej. XAB-0042) escríbemelo y lo buscamos.');
        } else {
          const factura = await generarFactura(pedido, datosFactura);
          if (datosFactura.email) await enviarFacturaPorEmail(factura.id, datosFactura.email).catch(() => {});
          const msgFactura = datosFactura.email
            ? `Tu factura (${factura.uuid || factura.id}) fue generada y enviada a ${datosFactura.email}. ¡Gracias!`
            : `Tu factura fue generada exitosamente. UUID: ${factura.uuid || factura.id}. Si quieres recibirla por email, compárteme tu correo.`;
          await enviarMensaje(telefono, msgFactura);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msgFactura);
          console.log(`[Meta WA] Factura generada para ${telefono}: ${factura.id}`);
        }
      } catch (e) {
        console.error('[Meta WA] Error generando factura:', e.message);
        await enviarMensaje(telefono, 'Hubo un problema generando tu factura. Comunícate con nosotros directamente para ayudarte.');
      }
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
    registrarError();
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

    // Detectar auto-registro: "repartidor Nombre Apellido"
    const matchRep = texto.match(/^repartidor\s+(.+)/i);
    if (matchRep) {
      const nombreRep = matchRep[1].trim();
      const rep = await registrarRepartidor(nombreRep, telefono);
      const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://xabor-agent-production.up.railway.app';
      await enviarMensaje(telefono,
        `¡Listo ${rep?.nombre || nombreRep}! ✅ Ya quedaste registrado como repartidor en Xabor.\nEntra aquí para ver y aceptar pedidos cuando lleguen:\n${BASE_URL}/repartidor.html`
      );
      console.log(`[Meta WA] Repartidor auto-registrado: ${nombreRep} (${telefono})`);
      return;
    }

    // Si el número ya es un repartidor registrado — responder con link y salir
    const repartidor = await obtenerRepartidorPorTelefono(telefono);
    if (repartidor) {
      const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://xabor-agent-production.up.railway.app';
      await enviarMensaje(telefono,
        `Hola ${repartidor.nombre} 👋\nEntra aquí para ver los pedidos disponibles:\n${BASE_URL}/repartidor.html`
      );
      console.log(`[Meta WA] Repartidor ${repartidor.nombre} detectado, se saltó el bot.`);
      return;
    }

    // Procesamiento con Claude — debounced 6 segundos
    // Si el cliente manda varios mensajes seguidos, se combinan en uno
    encolarMensaje(telefono, texto, (textoCombinado) => {
      procesarConClaude(telefono, textoCombinado, nombreMeta);
    });

  } catch (error) {
    console.error('[Meta WA] Error:', error.message);
  }
});

// ─── Notificar repartidores activos por WhatsApp ─────────────────────────────
export async function notificarRepartidoresPorWA(pedido) {
  try {
    const repartidores = await obtenerRepartidores();
    if (!repartidores.length) return;

    const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://xabor-agent-production.up.railway.app';

    const resumen = `${pedido.id} — ${pedido.cliente?.nombre || 'Cliente'} — $${pedido.total} MXN`;
    const direccion = pedido.direccion ? `\n📍 ${pedido.direccion}` : '';
    const texto = `🛵 *Nuevo pedido de domicilio disponible*\n${resumen}${direccion}\n\nEntra aquí para tomarlo:\n${BASE_URL}/repartidor.html`;

    for (const r of repartidores) {
      try {
        await enviarMensaje(r.telefono, texto);
        console.log(`[WA Repartidor] Notificación enviada a ${r.nombre} (${r.telefono})`);
      } catch (e) {
        console.error(`[WA Repartidor] Error al notificar a ${r.nombre}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[WA Repartidor] Error general:', e.message);
  }
}

export default router;
