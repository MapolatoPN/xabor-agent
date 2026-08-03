// Canal WhatsApp via Meta Cloud API (sin Twilio)
// Twilio se conserva SOLO para llamadas de voz

import { Router } from 'express';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { obtenerCliente, upsertCliente, guardarPedido, obtenerUltimosPedidos, guardarMensaje, getBotPausado, getPagoPendiente, clearPagoPendiente, obtenerPedidoActivoPorFolio, obtenerPedidoPorFolioAmplio, guardarPedidoProgramado, guardarPedidoActivo, guardarLinkPago, obtenerPedidosActivosPorTelefono, obtenerUltimoPedidoEntregadoPorTelefono, obtenerRepartidores, obtenerRepartidorPorTelefono, registrarRepartidor, obtenerPedidosAsignadosARepartidor, marcarRespuestaCampana, obtenerIntegracionCanal, obtenerCredencialesWhatsappNegocio, obtenerConfiguracion, obtenerBotWhatsappActivoNegocio, moduloHabilitado, marcarDocumentoError } from '../services/database.js';
import { generarFactura, enviarFacturaPorEmail } from '../services/facturapi.js';
import { procesarAprobacion } from '../services/learner.js';
import { recalcularPerfilCliente } from '../services/memory.js';
import { crearLinkDePago, ClipNoConfiguradoError } from '../services/clip-api.js';
// Arquitectura de pagos multiempresa (Fase 7/8): reemplaza las llamadas
// Clip-específicas de arriba para pedidos YA en pedidos_activos --
// crearLinkDePago/ClipNoConfiguradoError se conservan solo para pedidos
// programados aún no activados (ver comentarios en cada sitio de uso;
// pagosService.crearEnlacePago exige un pedido ya persistido en
// pedidos_activos, que un programado todavía no tiene).
import { crearEnlacePago, SinProveedorPrincipalError, PedidoInvalidoError } from '../services/pagosService.js';
import { crearRegistroDocumentoEntrante, procesarDocumentoEntranteDescargado } from '../services/documentos.js';
import { crearRegistroImagenEntrante, procesarImagenEntranteDescargada } from '../services/imagenes.js';
import { getIntegracion } from '../server.js';

// wsBroadcast ahora espera la misma firma que broadcastNegocio(negocioId,
// data) -- Incidente P0: antes se inyectaba el broadcast() global y CADA
// mensaje de WhatsApp de CUALQUIER negocio se emitía a todos los paneles
// conectados (fuga en vivo confirmada).
let wsBroadcast = null;
export function setWsBroadcastWA(fn) { wsBroadcast = fn; }

// ─── Monitor de errores críticos ─────────────────────────────────────────────
// Fase A (aislamiento de WhatsApp): antes era un único arreglo global —
// 3 errores de CUALQUIER negocio en 5 minutos alertaban a UN SOLO admin
// (wa_admin_numero global) usando el caché global para enviar. Ahora es
// un contador por negocio_id: cada negocio necesita sus propios 3
// errores en su propia ventana de 5 minutos para disparar su propia
// alerta, notificada con sus propias credenciales al admin configurado
// para ESE negocio -- nunca se suman errores entre negocios distintos,
// nunca se notifica con el número de otro.
const erroresPorNegocio = new Map(); // negocioId -> { timestamps: [], alertaEnviada: bool }
const VENTANA_MS   = 5 * 60 * 1000; // 5 minutos
const UMBRAL       = 3;              // 3 errores en 5 min → alerta

async function registrarError(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return; // sin negocio, no se puede alertar a nadie específico
  const id = negocioId.trim();
  if (!erroresPorNegocio.has(id)) erroresPorNegocio.set(id, { timestamps: [], alertaEnviada: false });
  const entry = erroresPorNegocio.get(id);

  const ahora = Date.now();
  entry.timestamps.push(ahora);
  while (entry.timestamps.length && entry.timestamps[0] < ahora - VENTANA_MS) entry.timestamps.shift();

  if (entry.timestamps.length >= UMBRAL && !entry.alertaEnviada) {
    entry.alertaEnviada = true;
    try {
      const cfg = await obtenerConfiguracion(id);
      const admin = cfg.wa_admin_numero;
      const credenciales = await obtenerCredencialesWhatsappNegocio(id);
      if (admin && credenciales) {
        enviarMensaje(admin, `🚨 *Xabor alerta*: el bot tuvo ${entry.timestamps.length} errores en los últimos 5 minutos. Revisar Railway logs.`, credenciales)
          .catch(() => {});
      } else {
        console.log(`[Meta WA] Alerta de errores omitida — sin admin/integración propia verificada para negocio ${id}`);
      }
    } catch (e) {
      console.error('[Meta WA] Error preparando alerta de errores críticos:', e.message);
    }
    setTimeout(() => { entry.alertaEnviada = false; }, 15 * 60 * 1000);
  }
}

// ─── Debounce de mensajes — espera 4s antes de procesar ──────────────────────
// Si el cliente manda varios mensajes seguidos, los combina en uno solo
// Clave compuesta `${negocioId}:${telefono}` (Incidente P0): si el mismo
// número de teléfono le escribe a DOS negocios distintos dentro de la
// ventana de debounce, cada negocio tiene su propio buffer -- nunca se
// combinan mensajes de conversaciones de negocios distintos en una sola
// respuesta del bot.
const bufferMensajes = new Map(); // clave → { textos: [], timer }

function encolarMensaje(clave, texto, procesarFn) {
  if (bufferMensajes.has(clave)) {
    const entry = bufferMensajes.get(clave);
    clearTimeout(entry.timer);
    entry.textos.push(texto);
  } else {
    bufferMensajes.set(clave, { textos: [texto] });
  }
  const entry = bufferMensajes.get(clave);
  entry.timer = setTimeout(() => {
    const textosCombinados = bufferMensajes.get(clave)?.textos.join('\n') || texto;
    bufferMensajes.delete(clave);
    procesarFn(textosCombinados);
  }, 6000);
}

const router = Router();

// Fase A (aislamiento de WhatsApp): getPhoneNumberId()/getAccessToken()
// (el caché global de credenciales) se eliminaron -- ya ningún punto de
// envío de este archivo los usa, todos reciben `credenciales` resueltas
// por negocio vía obtenerCredencialesWhatsappNegocio. getVerifyToken()
// se conserva: la verificación del webhook (GET) es a nivel de App de
// Meta, no por negocio -- un solo webhook URL/verify token sirve para
// todos los negocios suscritos a esa App (comportamiento correcto, no
// es parte de este aislamiento).
const getVerifyToken   = () => getIntegracion('wa_verify_token')|| process.env.META_VERIFY_TOKEN;
const NUMERO_SOPORTE   = process.env.WHATSAPP_SOPORTE;

// ─── Verificación del webhook (GET) — Meta lo llama al configurar ────────────
// Fix: usaba un identificador VERIFY_TOKEN nunca definido en este archivo
// (solo existía la función getVerifyToken()) -- cualquier intento real de
// verificación de Meta habría lanzado un ReferenceError (500), nunca
// comparaba nada. Se corrige a getVerifyToken() (el mecanismo oficial ya
// existente: configuración por negocio con respaldo a la variable de
// entorno). Se exige además que el token configurado no esté vacío antes
// de comparar -- evita que una verificación mal configurada (ambos lados
// vacíos/undefined) pase por accidente. Nunca se loguea el valor del
// token, solo si la verificación tuvo éxito o no.
router.get('/', (req, res) => {
  const mode        = req.query['hub.mode'];
  const token       = req.query['hub.verify_token'];
  const challenge   = req.query['hub.challenge'];
  const verifyToken = getVerifyToken();

  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    console.log('[Meta WA] ✅ Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[Meta WA] ⚠️ Verificación fallida — token incorrecto o ausente');
  res.sendStatus(403);
});

// ─── Enviar mensaje de texto via Meta Graph API ──────────────────────────────
// Fase A (aislamiento de WhatsApp): `credenciales` ({ phoneNumberId,
// accessToken }) ahora es OBLIGATORIO -- ya no hay fallback al caché
// global/env vars. Sin credenciales, se registra un log controlado (sin
// exponer el teléfono completo) y no se envía nada -- nunca se asume
// ningún negocio por defecto.
export async function enviarMensaje(telefono, texto, credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarMensaje sin credenciales resueltas — envío omitido (fail closed)');
    return null;
  }
  const { phoneNumberId, accessToken } = credenciales;
  const url = `${META_GRAPH_BASE_URL}/v20.0/${phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
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
// Fase A: mismo criterio que enviarMensaje -- credenciales obligatorias.
export async function enviarImagen(telefono, imageUrl, caption = '', credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarImagen sin credenciales resueltas — envío omitido (fail closed)');
    return null;
  }
  const url = `${META_GRAPH_BASE_URL}/v20.0/${credenciales.phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credenciales.accessToken}`,
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

// ─── Enviar documento PDF via Meta Graph API ─────────────────────────────────
// A diferencia de enviarImagen (que envía por URL pública), el documento se
// sube primero como media privada a Meta (2 pasos, igual que la recepción es
// 2 pasos) -- nunca se expone una URL pública del archivo para que Meta lo
// "jale"; el archivo viaja directo del storage privado de Xabor a Meta.
//
// META_GRAPH_BASE_URL: solo para pruebas (permite apuntar a un servidor
// HTTP local que simula la Graph API en vez de la real). Ausente en
// producción -- el default es exactamente el mismo host de siempre. Se
// usa en todas las funciones de envío/recepción de esta capa
// (enviarMensaje/enviarImagen/marcarLeido incluidas, extendido para la
// prueba end-to-end del Asistente Comercial de Cotizaciones).
const META_GRAPH_BASE_URL = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com';

// enviarDocumento (y su helper subirMediaAMeta, reutilizado abajo por
// enviarImagenBuffer) viven en metaEnvioDocumentos.js -- extraídos sin
// cambio de comportamiento (ver ese archivo para la razón: permite que
// un servicio externo los importe sin arrastrar el resto de este
// archivo, que a su vez importa server.js). Se reexporta enviarDocumento
// aquí para que server.js (y cualquier otro import existente de
// whatsapp-meta.js) no necesite ningún cambio.
import { subirMediaAMeta } from '../services/metaEnvioDocumentos.js';
export { enviarDocumento } from '../services/metaEnvioDocumentos.js';

// ─── Enviar imagen ya comprimida (buffer privado) via Meta Graph API ────────
// A diferencia de enviarImagen() de arriba (URL pública, usada por el
// marcador <ENVIAR_MENU>), esta función sube el buffer como media privada
// (2 pasos, mismo patrón que enviarDocumento) -- nunca expone una URL
// pública de la foto real de un cliente/negocio.
export async function enviarImagenBuffer(telefono, buffer, filename, mimeType, caption = '', credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarImagenBuffer sin credenciales resueltas — envío omitido (fail closed)');
    return null;
  }
  const mediaId = await subirMediaAMeta(buffer, filename, credenciales, mimeType);
  const url = `${META_GRAPH_BASE_URL}/v20.0/${credenciales.phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credenciales.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'image',
      image: { id: mediaId, caption },
    }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (imagen buffer): ${JSON.stringify(err)}`);
  }
  return resp.json();
}

// ─── Descargar media entrante (2 pasos: resolver URL, luego descargar) ───────
// El token usado en AMBOS pasos es el del propio negocio (credenciales ya
// resueltas por phone_number_id del webhook) -- nunca un token de otro
// negocio ni una variable de entorno global.
export async function descargarMediaDeMeta(mediaId, credenciales) {
  if (!credenciales?.accessToken) throw new Error('descargarMediaDeMeta: credenciales requeridas');
  const metaResp = await fetch(`${META_GRAPH_BASE_URL}/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${credenciales.accessToken}` },
  });
  if (!metaResp.ok) throw new Error(`Meta API (resolver media): HTTP ${metaResp.status}`);
  const meta = await metaResp.json();
  const fileResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${credenciales.accessToken}` } });
  if (!fileResp.ok) throw new Error(`Meta API (descargar media): HTTP ${fileResp.status}`);
  const arrayBuffer = await fileResp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type, sizeBytes: meta.file_size };
}

// ─── Documento entrante ───────────────────────────────────────────────────────
// Aditivo: no toca ni reordena el manejo de mensajes de texto. Se llama
// desde el webhook SOLO cuando message.type === 'document'.
//
// Orden (igual espíritu que el gate de atención automática: guardar
// primero, después evaluar/actuar):
//   1) resolver negocio + validar integración        (ya hecho por el caller)
//   2) validar chat_documentos_pdf habilitado para el negocio
//   3) leer media_id/filename/caption/mime_type
//   4) aceptar inicialmente solo application/pdf (mime declarado por Meta;
//      el MIME real se revalida por magic bytes en documentos.js tras la
//      descarga -- este primer filtro solo evita descargar basura obvia)
//   5) guardar mensaje + documento en estado 'pendiente'
//   6) broadcast inmediato (estado pendiente)
//   7) descargar de Meta con el token del propio negocio
//   8) validar MIME real + tamaño -> guardar en almacenamiento privado
//   9) estado 'listo' (o 'error') + segundo broadcast con la tarjeta final
async function manejarDocumentoEntrante(message, negocioId, nombreMeta) {
  const habilitado = await moduloHabilitado(negocioId, 'chat_documentos_pdf');
  if (!habilitado) {
    console.log(`[Meta WA] Documento recibido pero chat_documentos_pdf no está habilitado para el negocio ${negocioId} — descartado`);
    return;
  }

  const telefono   = message.from;
  const mediaId    = message.document?.id;
  const filename   = message.document?.filename || 'documento.pdf';
  const caption    = message.document?.caption || null;
  const mimeType   = message.document?.mime_type || '';
  const wamid      = message.id;

  if (!mediaId || mimeType !== 'application/pdf') {
    console.log(`[Meta WA] Documento de tipo no soportado (${mimeType || 'desconocido'}) para negocio ${negocioId} — descartado`);
    return;
  }

  if (nombreMeta) await upsertCliente(telefono, nombreMeta, negocioId);

  const documento = await crearRegistroDocumentoEntrante({ negocioId, telefono, filename, caption, wamid });
  const msg = await guardarMensaje(telefono, nombreMeta, 'entrante', `📄 ${filename}`, negocioId, 'cliente', wamid, 'documento', documento.id);
  if (msg && wsBroadcast) wsBroadcast(negocioId, { tipo: 'nuevo_mensaje', mensaje: msg, documento });

  try {
    const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);
    if (!credenciales?.accessToken) {
      await marcarDocumentoError(documento.id, 'sin_credenciales');
      if (wsBroadcast) wsBroadcast(negocioId, { tipo: 'documento_actualizado', documentoId: documento.id, ok: false, motivo: 'sin_credenciales' });
      return;
    }
    const { buffer } = await descargarMediaDeMeta(mediaId, credenciales);
    const resultado = await procesarDocumentoEntranteDescargado(documento.id, negocioId, buffer);
    if (wsBroadcast) wsBroadcast(negocioId, { tipo: 'documento_actualizado', documentoId: documento.id, ok: resultado.ok, motivo: resultado.motivo });
  } catch (e) {
    console.error(`[Meta WA] Error descargando documento del negocio ${negocioId}:`, e.message);
    await marcarDocumentoError(documento.id, 'error_descarga');
    if (wsBroadcast) wsBroadcast(negocioId, { tipo: 'documento_actualizado', documentoId: documento.id, ok: false, motivo: 'error_descarga' });
  }
}

// ─── Imagen entrante ──────────────────────────────────────────────────────────
// Mismo patrón exacto que manejarDocumentoEntrante -- guardar primero,
// descargar/validar después, dos broadcasts (pendiente, luego final).
// Gatea por 'chat_imagenes' (no 'chat_documentos_pdf') -- módulo ya
// sembrado 'activo' para todo negocio existente desde la migración 026,
// así que en la práctica nunca bloquea a un negocio real por esto, pero
// el chequeo se deja explícito por si algún negocio lo suspende.
async function manejarImagenEntrante(message, negocioId, nombreMeta) {
  const habilitado = await moduloHabilitado(negocioId, 'chat_imagenes');
  if (!habilitado) {
    console.log(`[Meta WA] Imagen recibida pero chat_imagenes no está habilitado para el negocio ${negocioId} — descartada`);
    return;
  }

  const telefono  = message.from;
  const mediaId   = message.image?.id;
  const caption   = message.image?.caption || null;
  const mimeType  = message.image?.mime_type || '';
  const wamid     = message.id;
  const filename  = `imagen-${wamid}`;

  if (!mediaId || !mimeType.startsWith('image/')) {
    console.log(`[Meta WA] Imagen de tipo no soportado (${mimeType || 'desconocido'}) para negocio ${negocioId} — descartada`);
    return;
  }

  if (nombreMeta) await upsertCliente(telefono, nombreMeta, negocioId);

  const documento = await crearRegistroImagenEntrante({ negocioId, telefono, filename, caption, wamid, mediaId });
  const msg = await guardarMensaje(telefono, nombreMeta, 'entrante', caption ? `📷 ${caption}` : '📷 Imagen', negocioId, 'cliente', wamid, 'imagen', documento.id);
  if (msg && wsBroadcast) wsBroadcast(negocioId, { tipo: 'nuevo_mensaje', mensaje: msg, documento });

  try {
    const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);
    if (!credenciales?.accessToken) {
      await marcarDocumentoError(documento.id, 'sin_credenciales');
      if (wsBroadcast) wsBroadcast(negocioId, { tipo: 'documento_actualizado', documentoId: documento.id, ok: false, motivo: 'sin_credenciales' });
      return;
    }
    const { buffer } = await descargarMediaDeMeta(mediaId, credenciales);
    const resultado = await procesarImagenEntranteDescargada(documento.id, negocioId, telefono, buffer);
    if (wsBroadcast) wsBroadcast(negocioId, { tipo: 'documento_actualizado', documentoId: documento.id, ok: resultado.ok, motivo: resultado.motivo });
  } catch (e) {
    console.error(`[Meta WA] Error descargando imagen del negocio ${negocioId}:`, e.message);
    await marcarDocumentoError(documento.id, 'error_descarga');
    if (wsBroadcast) wsBroadcast(negocioId, { tipo: 'documento_actualizado', documentoId: documento.id, ok: false, motivo: 'error_descarga' });
  }
}

// ─── Marcar mensaje como leído (mejora UX) ───────────────────────────────────
// Fase A: mismo criterio -- credenciales obligatorias.
async function marcarLeido(messageId, credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) return;
  try {
    await fetch(`${META_GRAPH_BASE_URL}/v20.0/${credenciales.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credenciales.accessToken}`,
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
// Fase A: el número admin y las credenciales se resuelven para EL MISMO
// negocio que escaló -- nunca el admin/caché global. El SMS de respaldo
// (Twilio, NUMERO_SOPORTE) es una alerta de plataforma para Mario, no un
// dato del negocio -- se deja como estaba.
async function notificarEscalacion(telefono, negocioId, credenciales) {
  if (typeof negocioId === 'string' && negocioId.trim()) {
    try {
      const cfg = await obtenerConfiguracion(negocioId);
      const adminWA = cfg.wa_admin_numero;
      if (adminWA && credenciales) {
        await enviarMensaje(adminWA, `⚠️ Cliente solicita atención humana: ${telefono}\nEntra a business.facebook.com para atenderlo.`, credenciales);
        console.log(`[Meta WA] Escalación notificada por WhatsApp al admin del negocio ${negocioId}`);
      } else {
        console.log(`[Meta WA] Escalación no notificada por WhatsApp — sin admin/integración propia para negocio ${negocioId}`);
      }
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

// ─── Clip no configurado para este negocio (Incidente P0, Fase 7) ───────────
// Nunca genera ni envía un enlace de otro negocio -- en vez de eso,
// conserva el pedido, transfiere a atención humana y avisa al cliente sin
// revelar el error técnico. Nunca lanza -- un fallo notificando la
// escalación no debe tumbar el flujo del mensaje entrante.
async function manejarClipNoConfigurado(telefono, nombreMeta, negocioId, credenciales) {
  console.error(`[Meta WA] pago_sin_integracion_configurada — negocio=${negocioId} telefono=${telefono}`);
  const msg = 'Permítenos un momento, por favor. Enseguida te ayudamos con el pago.';
  try {
    await enviarMensaje(telefono, msg, credenciales);
    await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
  } catch (e) {
    console.error('[Meta WA] Error enviando aviso de Clip no configurado:', e.message);
  }
  await notificarEscalacion(telefono, negocioId, credenciales).catch(() => {});
}

// ─── Procesamiento con Claude (se llama tras el debounce) ────────────────────
// negocioId (Incidente P0): resuelto UNA vez en el webhook (integraciones_canal
// por phone_number_id) y pasado explícitamente -- nunca se vuelve a adivinar
// ni se usa un fallback aquí adentro.
async function procesarConClaude(telefono, texto, nombreMeta, negocioId) {
  // Fase A (aislamiento de WhatsApp): credenciales resueltas UNA sola vez
  // aquí, para ESTE negocio, y pasadas explícitamente a cada envío de
  // esta función -- nunca se vuelve a resolver por punto de envío, nunca
  // cae al caché global. Sin integración propia verificada, el bot no
  // puede responder -- se omite todo el procesamiento (no tiene sentido
  // llamar a Claude si no hay forma de contestarle al cliente), nunca se
  // usan las credenciales de otro negocio como respaldo.
  const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);
  if (!credenciales) {
    console.log(`[Meta WA] Mensaje entrante ignorado — sin integración de WhatsApp propia verificada para negocio ${negocioId}`);
    return;
  }
  try {
    // Folio para pago
    // Acepta: xab21, XAB-21, XAB-0021, folio 21, folio xab21, etc.
    const matchFolio = texto.match(/(?:xab[-\s]?(\d{1,4}))|(?:folio[\s:]*(?:xab[-\s]?)?(\d{1,4}))/i);
    const folioNum   = matchFolio?.[1] ?? matchFolio?.[2];
    if (folioNum) {
      const folio    = `XAB-${folioNum.padStart(4, '0')}`;
      const pedidoDB = await obtenerPedidoPorFolioAmplio(folio, negocioId);
      console.log(`[Meta WA] Folio detectado: ${folio} — origen: ${pedidoDB?._origen || 'no encontrado'}`);
      if (pedidoDB && !pedidoDB.pago_confirmado) {
        try {
          let url;
          if (pedidoDB._origen === 'programado') {
            // Pedido programado (aún no activado): todavía no existe en
            // pedidos_activos, así que pagosService.crearEnlacePago (que
            // exige un pedido ya persistido ahí) no aplica -- se conserva
            // el flujo legacy Clip-específico como excepción documentada.
            const clip = await crearLinkDePago({ negocioId, pedidoId: folio, total: pedidoDB.total, descripcion: `Pedido Xabor #${folio}`, cliente: pedidoDB.cliente || {} });
            url = clip.url;
          } else {
            // Arquitectura de pagos multiempresa (Fase 7/8/10): resuelve el
            // proveedor PRINCIPAL del negocio (nunca asume Clip) y es
            // idempotente -- reenviar el mismo folio nunca duplica el cobro.
            const resultadoLink = await crearEnlacePago({ negocioId, pedidoId: folio, descripcion: `Pedido Xabor #${folio}` });
            url = resultadoLink.url;
          }
          let msg = `Aquí está tu enlace de pago para el pedido ${folio}:\n${url}\n\nTotal: $${pedidoDB.total} MXN`;
          if (pedidoDB._origen === 'programado' && pedidoDB.programado_para) {
            const horaStr = new Date(pedidoDB.programado_para).toLocaleString('es-MX', { timeZone: 'America/Matamoros', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true });
            msg += `\n\nTu pedido está programado para el ${horaStr}. Paga ahora y estará listo a esa hora.`;
          }
          await enviarMensaje(telefono, msg, credenciales);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
        } catch (e) {
          if (e instanceof ClipNoConfiguradoError || e instanceof SinProveedorPrincipalError) {
            await manejarClipNoConfigurado(telefono, nombreMeta, negocioId, credenciales);
          } else {
            console.error('[Meta WA] Error enviando link por folio:', e.message);
            await enviarMensaje(telefono, `Encontramos tu pedido ${folio}, pero hubo un problema generando el enlace. Escríbenos y te lo enviamos manualmente.`, credenciales);
          }
        }
        return;
      }
      if (!pedidoDB) {
        await enviarMensaje(telefono, `No encontramos un pedido con el folio ${folio}. Verifica el número o escríbenos para ayudarte.`, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', `No encontramos pedido con folio ${folio}.`, negocioId, 'bot');
        return;
      }
    }

    // Pago pendiente de llamada
    const pedidoPendiente = await getPagoPendiente(telefono, negocioId);
    if (pedidoPendiente) {
      try {
        // Arquitectura de pagos multiempresa (Fase 7/8): se lee directo de
        // pedidos_activos (fuente de verdad) en vez del caché en memoria de
        // orderManager -- un pedido de llamada ya debe estar persistido
        // para este punto (la llamada terminó hace rato), así que ya no
        // hace falta el import perezoso ni el riesgo de un caché vacío tras
        // un reinicio del proceso.
        const pedidoDBPendiente = await obtenerPedidoActivoPorFolio(pedidoPendiente, negocioId);
        const total = pedidoDBPendiente?.total || 0;
        const resultadoLink = await crearEnlacePago({ negocioId, pedidoId: pedidoPendiente, descripcion: `Pedido Xabor #${pedidoPendiente}` });
        await clearPagoPendiente(telefono, negocioId);
        const mensajePago = `Aquí está tu enlace de pago para tu pedido Xabor:\n${resultadoLink.url}\n\nTotal: $${total} MXN`;
        await enviarMensaje(telefono, mensajePago, credenciales);
        await guardarMensaje(telefono, null, 'saliente', mensajePago, negocioId, 'bot');
        console.log(`[Meta WA] Link de pago enviado a ${telefono}`);
      } catch (e) {
        if (e instanceof ClipNoConfiguradoError || e instanceof SinProveedorPrincipalError) {
          await clearPagoPendiente(telefono, negocioId);
          await manejarClipNoConfigurado(telefono, nombreMeta, negocioId, credenciales);
        } else if (e instanceof PedidoInvalidoError) {
          await clearPagoPendiente(telefono, negocioId);
          console.error('[Meta WA] Pago pendiente sin pedido válido en pedidos_activos:', e.message);
        } else {
          console.error('[Meta WA] Error enviando link pendiente:', e.message);
        }
      }
      return;
    }

    // ── Consulta de estado de pedido ──────────────────────────────────────────
    // Si el cliente pregunta por su pedido, respondemos directamente sin Claude
    const esConsultaEstado = /en\s*qu[eé]\s*va|estado.*pedido|cu[aá]nto\s*falta|ya\s*est[aá]\s*list|mi\s*pedido|est[aá]\s*list[oa]|lista\s*mi|list[oa]\s*mi|salió.*pedido|pedido.*salió|preparando|me\s*avis[ae]n/i.test(texto);
    if (esConsultaEstado) {
      const pedidosActivos = await obtenerPedidosActivosPorTelefono(telefono, negocioId);
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
        await enviarMensaje(telefono, msg, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
        console.log(`[Meta WA] Estado de pedido enviado a ${telefono}: ${p.folio} → ${p.estado}`);
        return;
      }
      // Si no hay pedidos activos, Claude responderá de forma natural
    }

    // ── Consulta de puntos Rewards ─────────────────────────────────────────────
    const esConsultaPuntos = /mis puntos|cu[aá]ntos puntos|tengo.*puntos|puntos.*tengo|saldo.*reward|reward.*saldo|nivel.*reward|reward.*nivel|puntos.*xabor|xabor.*puntos/i.test(texto);
    if (esConsultaPuntos) {
      try {
        const { obtenerCuentaPorTelefono, calcularNivel } = await import('../services/rewardsService.js');
        const cuenta = await obtenerCuentaPorTelefono(telefono, negocioId);
        let msg;
        if (cuenta && cuenta.puntos_balance >= 0) {
          const nivel = calcularNivel(cuenta.puntos_acumulados_total);
          const msgNivel = nivel.siguiente
            ? `Faltan ${nivel.falta} pts para llegar a ${nivel.siguiente} ${nivel.nombre === 'Bronze' ? '🥈' : '🥇'}`
            : '¡Eres miembro Gold! 🏆';
          msg = `🏆 Tu saldo Xabor Rewards:\n\n*${cuenta.puntos_balance} puntos* ${nivel.emoji} ${nivel.nombre}\n${msgNivel}\n\nAcumulados en total: ${cuenta.puntos_acumulados_total} pts`;
        } else {
          msg = `Aún no tienes puntos Rewards acumulados. ¡Tu próximo pedido los genera automáticamente! 🎁`;
        }
        await enviarMensaje(telefono, msg, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
        console.log(`[Meta WA] Puntos Rewards enviados a ${telefono}`);
        return;
      } catch(e) {
        console.error('[Rewards] Error consultando puntos por WA:', e.message);
        // Si falla, Claude responderá de forma natural
      }
    }

    // Contexto del cliente
    const clienteDB = await obtenerCliente(telefono, negocioId);
    const pedidosAnteriores = clienteDB ? await obtenerUltimosPedidos(telefono, negocioId) : [];
    // Bug preexistente corregido: clienteCtx nunca incluía `telefono`, así
    // que procesarMensaje's `clienteCtx?.telefono` (usado tanto por la
    // memoria de cliente existente como por el Asistente Comercial nuevo)
    // siempre era undefined viniendo del canal de WhatsApp -- ninguna de
    // las dos funciones podía activarse nunca desde un mensaje real. Se
    // agrega solo dentro de la rama con clienteDB ya existente -- se
    // preserva clienteCtx=null cuando el cliente es nuevo, para no alterar
    // el bloque "cliente recurrente" de construirSystemPrompt (que usa
    // `if (clienteCtx)` como señal de "ya lo conocemos").
    const clienteCtx = clienteDB ? { telefono, nombre: clienteDB.nombre || nombreMeta, pedidos: pedidosAnteriores } : null;
    if (nombreMeta) await upsertCliente(telefono, nombreMeta, negocioId);

    // Fase A: sessionId incluye negocioId -- antes era solo `meta-${telefono}`,
    // un Map global en session.js compartía el mismo historial de
    // conversación de Claude entre negocios distintos si el mismo
    // teléfono le escribía a ambos.
    const sessionId = `meta-${negocioId}-${telefono}`;

    // Si Claude tarda más de 8s, avisamos al cliente para que no piense que el bot falló
    let waitMessageSent = false;
    const waitTimer = setTimeout(async () => {
      waitMessageSent = true;
      const msgEspera = 'Dame un momento, estoy procesando tu solicitud... 🕐';
      try {
        await enviarMensaje(telefono, msgEspera, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msgEspera, negocioId, 'bot');
      } catch (error) {
        // Fallo de Meta (token inválido/expirado, rate limit, caída de la API, etc.)
        // no debe tumbar el proceso — nunca se propaga como unhandled rejection.
        console.error(`[WhatsApp] No se pudo enviar mensaje de espera: ${error.message}`);
      }
    }, 8000);

    const resultado = await procesarMensaje(sessionId, texto, clienteCtx, null, negocioId);
    clearTimeout(waitTimer);

    // Detección de confirmación verbal sin JSON — alerta al admin
    // Si el bot dice "confirmado/registrado" pero no emitió <ORDEN_CONFIRMADA>, algo falló
    if (!resultado.orden) {
      const textoBot = resultado.texto || '';
      const pareceConfirmacion = /pedido\s+(confirmado|registrado|listo|anotado|quedó)|quedó\s+registrado|queda\s+registrado/i.test(textoBot);
      if (pareceConfirmacion) {
        console.error(`[WA] ⚠️ ALERTA: bot confirmó verbalmente a ${telefono} pero no generó <ORDEN_CONFIRMADA>. Texto: ${textoBot.slice(0, 200)}`);
        // Fase A: admin propio de este negocio, credenciales propias --
        // nunca el admin/caché global.
        obtenerConfiguracion(negocioId).then(cfg => {
          if (cfg.wa_admin_numero) {
            enviarMensaje(cfg.wa_admin_numero, `⚠️ *Pedido perdido posible*: el bot le dijo a un cliente que su pedido quedó registrado, pero no generó la orden. Teléfono: ${telefono}. Revisar chat ahora.`, credenciales).catch(() => {});
          }
        }).catch(() => {});
      }
    }

    // Orden confirmada
    let linkPago = null;
    if (resultado.orden) {
      resultado.orden.canal = 'whatsapp';
      resultado.orden.cliente.telefono = resultado.orden.cliente.telefono || telefono;
      // negocioId (Incidente P0, causa raíz confirmada): este era el punto
      // exacto donde se perdía el negocio. negocioId ya está resuelto en
      // el scope de esta función (procesarConClaude), pero nunca se
      // copiaba a resultado.orden antes de llamar a registrarPedido() --
      // el pedido/comanda terminaba atribuido a Nonna Maye vía el
      // respaldo que registrarPedido tenía antes (ya eliminado). Ahora se
      // fija explícitamente, igual que Rappi siempre lo hizo.
      resultado.orden.negocioId = negocioId;
      const pedido = registrarPedido(resultado.orden, 'whatsapp');

      // Si es pedido programado, guardarlo aparte y NO enviarlo al panel todavía
      if (resultado.orden.programado_para) {
        await guardarPedidoProgramado(pedido.id, pedido, resultado.orden.programado_para);
        // Quitar del panel activo — se activará automáticamente 1h antes
        const { eliminarPedido } = await import('../orders/orderManager.js');
        await eliminarPedido(pedido.id, pedido.negocioId);
        console.log(`[WA] Pedido programado ${pedido.id} para ${resultado.orden.programado_para}`);
        // Confirmación al cliente con folio y hora — operación crítica
        try {
          const horaLocal = new Date(resultado.orden.programado_para).toLocaleTimeString('es-MX', {
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Matamoros'
          });
          const confirmMsg = `✅ Tu pedido *${pedido.id}* quedó registrado para las *${horaLocal}*. Te avisaremos en cuanto salga el repartidor.`;
          await enviarMensaje(telefono, confirmMsg, credenciales);
          await guardarMensaje(telefono, nombreMeta, 'saliente', confirmMsg, negocioId, 'bot');
        } catch (e) {
          console.error(`[WA] Error enviando confirmación de pedido programado ${pedido.id}:`, e.message);
        }
      } else {
        emitirPedido(pedido);
      }
      await guardarPedido(telefono, resultado.orden, pedido.negocioId);
      if (resultado.orden.cliente?.nombre) await upsertCliente(telefono, resultado.orden.cliente.nombre, negocioId);
      // Actualizar perfil del cliente en background
      recalcularPerfilCliente(telefono).catch(e => console.error('[WA] recalcularPerfil:', e.message));
      if (resultado.orden.forma_pago === 'enlace de pago') {
        try {
          if (resultado.orden.programado_para) {
            // Pedido programado: ya se removió de pedidos_activos arriba
            // (eliminarPedido) y vive solo en pedidos_programados hasta que
            // se active -- pagosService.crearEnlacePago exige un pedido ya
            // en pedidos_activos, así que aquí se conserva el flujo legacy
            // Clip-específico (misma excepción documentada que en el bloque
            // de "Folio para pago" arriba).
            const clip = await crearLinkDePago({ negocioId, pedidoId: pedido.id, total: resultado.orden.total, descripcion: `Pedido Xabor #${pedido.id}`, cliente: resultado.orden.cliente });
            linkPago = clip.url;
            await guardarLinkPago(pedido.id, negocioId, clip.linkId);
          } else {
            // registrarPedido() dispara guardarPedidoActivo() sin await
            // (fire-and-forget, para no bloquear el registro del pedido) --
            // se re-invoca aquí con await antes de leer de vuelta (es un
            // UPSERT idempotente, ON CONFLICT DO UPDATE) para cerrar la
            // carrera real que existiría si crearEnlacePago leyera
            // pedidos_activos antes de que esa escritura terminara.
            await guardarPedidoActivo(pedido, negocioId);
            const resultadoLink = await crearEnlacePago({ negocioId, pedidoId: pedido.id, descripcion: `Pedido Xabor #${pedido.id}` });
            linkPago = resultadoLink.url;
          }
        } catch (e) {
          if (e instanceof ClipNoConfiguradoError || e instanceof SinProveedorPrincipalError) {
            await manejarClipNoConfigurado(telefono, nombreMeta, negocioId, credenciales);
          } else {
            console.error('[Pagos] Error al generar link de pago:', e.message);
          }
        }
      }
    }

    if (resultado.escalar) await notificarEscalacion(telefono, negocioId, credenciales);

    const baseUrl = process.env.PUBLIC_URL || 'https://xabor-agent-production.up.railway.app';
    if (resultado.enviarMenu) {
      try { await enviarImagen(telefono, `${baseUrl}/public/menu.png`, '', credenciales); } catch (e) { console.error('[Meta WA] Error enviando menú:', e.message); }
    }

    // ── Factura CFDI solicitada por WhatsApp ──────────────────────────────────
    if (resultado.factura && process.env.FACTURAPI_KEY) {
      try {
        const datosFactura = resultado.factura;
        // Si no viene el folio en el marcador, usar el último pedido entregado del cliente
        let pedido = null;
        if (datosFactura.folio) {
          const { obtenerPedidoActivoPorFolio: _paf } = await import('../services/database.js');
          pedido = await _paf(datosFactura.folio, negocioId) || await obtenerUltimoPedidoEntregadoPorTelefono(telefono, negocioId);
          if (pedido && !pedido.id) pedido.id = datosFactura.folio;
        } else {
          pedido = await obtenerUltimoPedidoEntregadoPorTelefono(telefono, negocioId);
        }

        if (!pedido) {
          await enviarMensaje(telefono, 'No encontré un pedido reciente para facturar. Si tienes el folio (ej. XAB-0042) escríbemelo y lo buscamos.', credenciales);
        } else {
          const factura = await generarFactura(pedido, datosFactura);
          if (datosFactura.email) await enviarFacturaPorEmail(factura.id, datosFactura.email).catch(() => {});
          const msgFactura = datosFactura.email
            ? `Tu factura (${factura.uuid || factura.id}) fue generada y enviada a ${datosFactura.email}. ¡Gracias!`
            : `Tu factura fue generada exitosamente. UUID: ${factura.uuid || factura.id}. Si quieres recibirla por email, compárteme tu correo.`;
          await enviarMensaje(telefono, msgFactura, credenciales);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msgFactura, negocioId, 'bot');
          console.log(`[Meta WA] Factura generada para ${telefono}: ${factura.id}`);
        }
      } catch (e) {
        console.error('[Meta WA] Error generando factura:', e.message);
        await enviarMensaje(telefono, 'Hubo un problema generando tu factura. Comunícate con nosotros directamente para ayudarte.', credenciales);
      }
    }

    await enviarMensaje(telefono, resultado.texto, credenciales);
    console.log(`[Meta WA] Respuesta enviada a ${telefono}`);
    const msgSaliente = await guardarMensaje(telefono, nombreMeta, 'saliente', resultado.texto, negocioId, 'bot');
    if (msgSaliente && wsBroadcast) wsBroadcast(negocioId, { tipo: 'nuevo_mensaje', mensaje: msgSaliente });

    if (linkPago) {
      const mensajePago = `Para pagar con tarjeta, usa este enlace:\n${linkPago}`;
      await enviarMensaje(telefono, mensajePago, credenciales);
      const msgPago = await guardarMensaje(telefono, nombreMeta, 'saliente', mensajePago, negocioId, 'bot');
      if (msgPago && wsBroadcast) wsBroadcast(negocioId, { tipo: 'nuevo_mensaje', mensaje: msgPago });
    }
  } catch (error) {
    console.error('[Meta WA] Error en procesarConClaude:', error.message);
    registrarError(negocioId);
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
    // 'document'/'image' se aceptan además de 'text' (aditivo -- cualquier
    // otro tipo sigue descartándose exactamente igual que antes).
    if (!message || (message.type !== 'text' && message.type !== 'document' && message.type !== 'image')) return;

    // negocioId (Incidente P0): se resuelve EXCLUSIVAMENTE contra
    // integraciones_canal usando el phone_number_id que manda Meta en el
    // propio payload del webhook -- nunca de un valor que el cliente HTTP
    // pudiera controlar, nunca adivinado. Si el phone_number_id no está
    // mapeado a ningún negocio, el mensaje se descarta (fail closed): no
    // se guarda, no se procesa con el bot, no se usa Nonna Maye como
    // relleno. Esto requiere que integraciones_canal tenga una fila para
    // 'whatsapp' antes de desplegar este cambio (ver plan de deploy).
    const phoneNumberId = value?.metadata?.phone_number_id;
    const integracion = phoneNumberId ? await obtenerIntegracionCanal('whatsapp', phoneNumberId) : null;
    if (!integracion) {
      console.error(`[Meta WA] Webhook sin negocio mapeado para phone_number_id=${phoneNumberId || '(vacío)'} — mensaje descartado (fail closed)`);
      return;
    }
    const negocioId = integracion.negocioId;

    if (message.type === 'document') {
      await manejarDocumentoEntrante(message, negocioId, value.contacts?.[0]?.profile?.name || '');
      return;
    }
    if (message.type === 'image') {
      await manejarImagenEntrante(message, negocioId, value.contacts?.[0]?.profile?.name || '');
      return;
    }

    const telefono   = message.from;
    const texto      = message.text.body;
    const messageId  = message.id;
    const nombreMeta = value.contacts?.[0]?.profile?.name || '';

    console.log(`[Meta WA] ${telefono} (${nombreMeta}): ${texto}`);

    // Fase A: credenciales resueltas una vez para todo el manejo de este
    // webhook (repartidores, marcar leído) -- mismo criterio que
    // procesarConClaude. Puede ser null (negocio sin integración propia
    // verificada); cada punto de envío de abajo ya maneja ese caso.
    const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);

    // Acciones inmediatas (no debounced) -- ocurren SIEMPRE, sin importar
    // el interruptor global del bot ni la pausa por cliente: guardar el
    // mensaje, actualizar el cliente y emitir el evento para que
    // aparezca en el chat de Xabor y se pueda atender manualmente.
    const msgGuardado = await guardarMensaje(telefono, nombreMeta, 'entrante', texto, negocioId, 'cliente', messageId);
    if (msgGuardado && wsBroadcast) wsBroadcast(negocioId, { tipo: 'nuevo_mensaje', mensaje: msgGuardado });
    if (nombreMeta) await upsertCliente(telefono, nombreMeta, negocioId);
    await marcarLeido(messageId, credenciales);
    // Tracking de respuesta a campañas (background, no bloquea)
    marcarRespuestaCampana(telefono).catch(() => {});

    // Comandos de Mario — sin debounce
    const ultimosDiez = t => t.slice(-10);
    const esMario = ultimosDiez(telefono) === ultimosDiez(process.env.MARIO_TELEFONO || '528781091115');
    if (esMario) {
      const esComando = await procesarAprobacion(texto, negocioId, credenciales);
      if (esComando) return;
    }

    // Interruptor global de bot por negocio (migración 019) + pausa por
    // cliente (ya existente) — el bot solo llama a brain.js si AMBOS lo
    // permiten: bot_whatsapp_activo = TRUE Y bot_pausado_cliente =
    // FALSE. El mensaje ya se guardó, se transmitió y el cliente ya se
    // actualizó arriba (sigue apareciendo en el chat de Xabor para
    // atención manual) -- aquí solo se decide si se invoca a la IA.
    // Nunca se modifica bot_pausado desde aquí.
    const botGlobalActivo = await obtenerBotWhatsappActivoNegocio(negocioId);
    if (!botGlobalActivo) {
      console.log(`[Meta WA] Bot de WhatsApp desactivado para el negocio ${negocioId} — mensaje guardado, sin respuesta automática`);
      return;
    }
    const pausado = await getBotPausado(telefono, negocioId);
    if (pausado) {
      console.log(`[Meta WA] Bot pausado para ${telefono}`);
      return;
    }

    // Detectar auto-registro: "repartidor Nombre Apellido"
    const matchRep = texto.match(/^repartidor[ao]?\s+(.+)/i) || texto.match(/^(.+?)\s+repartidor[ao]?\s*$/i);
    if (matchRep) {
      const nombreRep = matchRep[1].trim();
      const rep = await registrarRepartidor(nombreRep, telefono, negocioId);
      const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://xabor-agent-production.up.railway.app';
      const msgReg = `¡Listo ${rep?.nombre || nombreRep}! ✅ Ya quedaste registrado como repartidor en Xabor.\nEntra aquí para ver y aceptar pedidos cuando lleguen:\n${BASE_URL}/repartidor.html`;
      await enviarMensaje(telefono, msgReg, credenciales);
      await guardarMensaje(telefono, rep?.nombre || nombreRep, 'entrante', texto, negocioId, 'cliente');
      await guardarMensaje(telefono, rep?.nombre || nombreRep, 'saliente', msgReg, negocioId, 'bot');
      console.log(`[Meta WA] Repartidor auto-registrado: ${nombreRep} (${telefono})`);
      return;
    }

    // Si el número ya es un repartidor registrado (de ESTE negocio)
    const repartidor = await obtenerRepartidorPorTelefono(telefono, negocioId);
    if (repartidor) {
      // Detectar confirmación de entrega
      if (/entregu[eé]|entregado|ya entregué|listo[.,!]?$/i.test(texto.trim())) {
        const misPedidos = await obtenerPedidosAsignadosARepartidor(repartidor.id);
        const activo = misPedidos.find(p => !['entregado','cancelado'].includes(p.estado));
        let msgEntrega;
        if (activo) {
          const { actualizarEstadoPedido } = await import('../orders/orderManager.js');
          actualizarEstadoPedido(activo.folio, 'entregado');
          msgEntrega = `✅ Perfecto ${repartidor.nombre}, el pedido ${activo.folio} quedó marcado como entregado. ¡Buen trabajo!`;
          console.log(`[WA Repartidor] ${repartidor.nombre} confirmó entrega de ${activo.folio}`);
        } else {
          msgEntrega = `No tienes pedidos activos asignados en este momento.`;
        }
        await enviarMensaje(telefono, msgEntrega, credenciales);
        await guardarMensaje(telefono, repartidor.nombre, 'entrante', texto, negocioId, 'cliente');
        await guardarMensaje(telefono, repartidor.nombre, 'saliente', msgEntrega, negocioId, 'bot');
        return;
      }
      // Cualquier otro mensaje — mandar link
      const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://xabor-agent-production.up.railway.app';
      const msgLink = `Hola ${repartidor.nombre} 👋\nEntra aquí para ver los pedidos disponibles:\n${BASE_URL}/repartidor.html`;
      await enviarMensaje(telefono, msgLink, credenciales);
      await guardarMensaje(telefono, repartidor.nombre, 'entrante', texto, negocioId, 'cliente');
      await guardarMensaje(telefono, repartidor.nombre, 'saliente', msgLink, negocioId, 'bot');
      console.log(`[Meta WA] Repartidor ${repartidor.nombre} detectado, se saltó el bot.`);
      return;
    }

    // Procesamiento con Claude — debounced 6 segundos
    // Si el cliente manda varios mensajes seguidos, se combinan en uno
    console.log(`[Meta WA] Bot de WhatsApp activo para el negocio ${negocioId} — encolando para procesar con IA`);
    encolarMensaje(`${negocioId}:${telefono}`, texto, (textoCombinado) => {
      procesarConClaude(telefono, textoCombinado, nombreMeta, negocioId);
    });

  } catch (error) {
    console.error('[Meta WA] Error:', error.message);
  }
});

// ─── Notificar repartidores activos por WhatsApp ─────────────────────────────
export async function notificarRepartidoresPorWA(pedido) {
  try {
    if (!pedido?.negocioId) {
      console.warn('[WA Repartidor] notificarRepartidoresPorWA: pedido sin negocioId — no se notifica a nadie (fail closed)');
      return;
    }
    const repartidores = await obtenerRepartidores(pedido.negocioId);
    if (!repartidores.length) return;

    // Fase A: credenciales propias del mismo negocio del pedido -- nunca
    // el caché global. Sin integración propia, se omite en silencio
    // (misma decisión que el resto del motor: no hay forma de notificar,
    // pero eso nunca bloquea nada del flujo de pedidos).
    const credenciales = await obtenerCredencialesWhatsappNegocio(pedido.negocioId);
    if (!credenciales) {
      console.log(`[WA Repartidor] Notificación omitida — sin integración propia verificada para negocio ${pedido.negocioId}`);
      return;
    }

    const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://xabor-agent-production.up.railway.app';

    const resumen = `${pedido.id} — ${pedido.cliente?.nombre || 'Cliente'} — $${pedido.total} MXN`;
    const direccion = pedido.direccion ? `\n📍 ${pedido.direccion}` : '';
    const texto = `🛵 *Nuevo pedido de domicilio disponible*\n${resumen}${direccion}\n\n⏱ El pedido estará listo para recoger en *15-20 minutos*.\n\nEntra aquí para tomarlo:\n${BASE_URL}/repartidor.html`;

    for (const r of repartidores) {
      try {
        await enviarMensaje(r.telefono, texto, credenciales);
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
