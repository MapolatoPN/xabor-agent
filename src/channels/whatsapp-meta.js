// Canal WhatsApp via Meta Cloud API (sin Twilio)
// Twilio se conserva SOLO para llamadas de voz

import { Router } from 'express';
import { randomBytes } from 'crypto';
import twilio from 'twilio';
import { procesarMensaje } from '../agent/brain.js';
import { registrarPedido, emitirPedido, esPedidoElegibleParaRedRepartidores } from '../orders/orderManager.js';
import { obtenerCliente, upsertCliente, guardarPedido, obtenerUltimosPedidos, guardarMensaje, getBotPausado, getPagoPendiente, clearPagoPendiente, obtenerPedidoActivoPorFolio, obtenerPedidoPorFolioAmplio, obtenerPedidoParaPagoPorFolio, upsertClienteNombreEntrega, guardarPedidoProgramado, guardarPedidoActivo, guardarLinkPago, obtenerPedidosActivosPorTelefono, obtenerUltimoPedidoEntregadoPorTelefono, obtenerMetodosPagoDisponibles, obtenerRepartidores, obtenerRepartidorPorTelefono, registrarRepartidor, obtenerPedidosAsignadosARepartidor, marcarRespuestaCampana, obtenerIntegracionCanal, obtenerCredencialesWhatsappNegocio, obtenerConfiguracion, obtenerBotWhatsappActivoNegocio, moduloHabilitado, marcarDocumentoError, registrarNotificacionRepartidor, actualizarEstadoNotificacionPorWamid, consumirTokenAceptacionRepartidor, obtenerOfertaPorToken, obtenerNombreNegocio, asignarRepartidor, actualizarModoConversacionRepartidor, existeNotificacionRepartidor, esPedidoSinCoberturaAhora } from '../services/database.js';
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
import { normalizarTelefonoMX } from '../utils/telefono.js';
import { obtenerConfigRed, evaluarSolicitudRed } from '../services/redRepartidores.js';
import { formatearUbicacionRepartidor, formatearTarifaRepartidor, formatearEntregaOferta } from '../utils/direccionRepartidor.js';
import { detectarSolicitudEnlacePago } from '../utils/intencionEnlacePago.js';

// wsBroadcast ahora espera la misma firma que broadcastNegocio(negocioId,
// data) -- Incidente P0: antes se inyectaba el broadcast() global y CADA
// mensaje de WhatsApp de CUALQUIER negocio se emitía a todos los paneles
// conectados (fuga en vivo confirmada).
let wsBroadcast = null;
export function setWsBroadcastWA(fn) { wsBroadcast = fn; }

// Fase C (tiempo real): eventos globales de Red de Repartidores para
// Superadmin, inyectado por separado de wsBroadcast (que es por-negocio) --
// mismo patrón de inyección que el resto de este archivo, nunca un import
// estático de server.js para el broadcast en sí (solo getIntegracion ya
// se importa así, de forma segura -- ver nota de import circular en
// orderManager.js/database.js).
let wsBroadcastSuperadmin = null;
export function setWsBroadcastSuperadminWA(fn) { wsBroadcastSuperadmin = fn; }

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

// ─── Enviar plantilla xabor_nuevo_servicio_reparto (oferta, SIN datos sensibles) ──
// Diagnóstico repartidores (ver reporte): un mensaje de texto libre a un
// repartidor que no le ha escrito al bot en las últimas 24h queda sujeto a
// la ventana de servicio al cliente de WhatsApp -- Meta puede aceptar la
// petición HTTP (200) y aun así no entregarlo. Una plantilla aprobada por
// Meta es el único tipo de mensaje que puede iniciar conversación fuera de
// esa ventana.
//
// Requisito explícito del usuario: este PRIMER mensaje (la oferta) nunca
// debe llevar nombre/teléfono/dirección del cliente -- solo el negocio, el
// pago estimado, y un enlace de un solo uso para aceptar. Los datos
// completos se envían después, en enviarPlantillaXaborDetalleServicioReparto,
// y solo si el repartidor efectivamente acepta (ver procesarAceptacionTokenRepartidor).
//
// Devuelve el wamid (string) si Meta acepta el envío. Lanza si Meta
// rechaza (mismo criterio que enviarMensaje) -- el llamador decide qué
// registrar en notificaciones_repartidor según éxito/fallo.
export async function enviarPlantillaXaborNuevoServicioReparto(telefono, { nombreNegocio, pagoEstimado, enlaceAceptar }, credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarPlantillaXaborNuevoServicioReparto sin credenciales resueltas — envío omitido (fail closed)');
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
      type: 'template',
      template: {
        name: 'xabor_nuevo_servicio_reparto',
        language: { code: 'es_MX' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: nombreNegocio },
            { type: 'text', text: pagoEstimado },
            { type: 'text', text: enlaceAceptar }
          ]
        }]
      }
    })
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (plantilla xabor_nuevo_servicio_reparto): ${JSON.stringify(err)}`);
  }
  const data = await resp.json();
  return data?.messages?.[0]?.id || null;
}

// ─── Plantilla xabor_nuevo_servicio_reparto_v2 (oferta con calle/colonia/tarifa/folio) ──
// Fase C, Red de Repartidores: requisito nuevo del usuario -- desde el
// PRIMER mensaje el repartidor debe conocer negocio, folio, calle/colonia
// de entrega y tarifa, además del enlace. La plantilla v1 (arriba) ya está
// aprobada por Meta con exactamente 3 variables (negocio/pago/enlace) --
// agregar variables nuevas exige someter una plantilla NUEVA a revisión de
// Meta (no editar la ya aprobada). El usuario autorizó redactar y preparar
// esta plantilla v2 (ver docs/plantilla-nueva-servicio-reparto-v2-propuesta.md
// para el texto exacto a someter y los pasos) -- someterla y aprobarla en
// Meta Business Manager es un paso manual fuera de esta sesión de código.
//
// Por eso esta función existe YA, lista para usarse, pero
// notificarRepartidoresPorWA solo la invoca cuando
// configuracion.repartidor_notif_plantilla_v2_activo === 'true' (default:
// ausente/false -- sigue usando la v1 tal cual, sin ningún cambio de
// comportamiento en producción hasta que el negocio confirme que Meta
// aprobó la plantilla nueva y active la clave manualmente).
//
// ubicacion ya viene pre-formateada por formatearUbicacionRepartidor
// (incluye el fallback "Ubicación pendiente de confirmar") -- esta función
// nunca decide el texto de ubicación, solo lo transporta como parámetro
// de plantilla.
export async function enviarPlantillaXaborNuevoServicioRepartoV2(telefono, { nombreNegocio, folio, ubicacion, tarifa, enlaceAceptar }, credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarPlantillaXaborNuevoServicioRepartoV2 sin credenciales resueltas — envío omitido (fail closed)');
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
      type: 'template',
      template: {
        name: 'xabor_nuevo_servicio_reparto_v2',
        language: { code: 'es_MX' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: nombreNegocio },
            { type: 'text', text: folio },
            { type: 'text', text: ubicacion },
            { type: 'text', text: tarifa },
            { type: 'text', text: enlaceAceptar }
          ]
        }]
      }
    })
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (plantilla xabor_nuevo_servicio_reparto_v2): ${JSON.stringify(err)}`);
  }
  const data = await resp.json();
  return data?.messages?.[0]?.id || null;
}

// ─── Enviar plantilla xabor_detalle_servicio_reparto (datos completos, post-aceptar) ──
// Se envía SOLO después de que procesarAceptacionTokenRepartidor consume el
// token con éxito y asigna el pedido -- nunca antes. Es una plantilla (no
// texto libre) por la misma razón que la de oferta: el repartidor pudo
// haber aceptado desde una página web (no le escribió nada al bot), así
// que su ventana de 24h puede seguir cerrada y un texto libre aquí podría
// fallar exactamente igual que el problema original que se está corrigiendo.
export async function enviarPlantillaXaborDetalleServicioReparto(telefono, { folio, nombreCliente, telefonoCliente, direccion, observaciones, monto }, credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarPlantillaXaborDetalleServicioReparto sin credenciales resueltas — envío omitido (fail closed)');
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
      type: 'template',
      template: {
        name: 'xabor_detalle_servicio_reparto',
        language: { code: 'es_MX' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: folio },
            { type: 'text', text: nombreCliente || 'No proporcionado' },
            { type: 'text', text: telefonoCliente || 'No proporcionado' },
            { type: 'text', text: direccion || 'No proporcionada' },
            { type: 'text', text: observaciones || 'Ninguna' },
            { type: 'text', text: monto }
          ]
        }]
      }
    })
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (plantilla xabor_detalle_servicio_reparto): ${JSON.stringify(err)}`);
  }
  const data = await resp.json();
  return data?.messages?.[0]?.id || null;
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
      // Incidente XAB-0114: la búsqueda amplia excluía pedidos 'entregado',
      // pero un pedido entregado SIN pagar es exactamente el que necesita
      // el enlace (el XAB-0114 real fue archivado en el panel 3 segundos
      // después del "Folio 114"). Primero la búsqueda para PAGO (incluye
      // entregado, solo negocio propio); los programados siguen por la vía
      // amplia de siempre.
      let pedidoDB = await obtenerPedidoParaPagoPorFolio(folio, negocioId);
      if (!pedidoDB) {
        // La vía amplia solo aporta los PROGRAMADOS (aún no activados).
        // Un activo que la búsqueda de pago rechazó está cancelado -- la
        // amplia lo devolvería y se cobraría un pedido cancelado.
        const amplio = await obtenerPedidoPorFolioAmplio(folio, negocioId);
        if (amplio?._origen === 'programado') pedidoDB = amplio;
      }
      console.log(`[Meta WA] Folio detectado: ${folio} — origen: ${pedidoDB?._origen || 'no encontrado'}`);
      if (pedidoDB && pedidoDB.pago_confirmado) {
        // Antes este caso caía a la IA sin respuesta útil: un folio ya
        // pagado se responde de frente y jamás genera otro cobro.
        const msgPagado = `Tu pedido ${folio} ya está pagado ✔. No necesitas hacer nada más.`;
        await enviarMensaje(telefono, msgPagado, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msgPagado, negocioId, 'bot');
        return;
      }
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

    // ── Solicitud de enlace de pago (hotfix bot-envio-enlace-pago) ────────────
    // Incidente real: una clienta con pedido activo pidió "pagar con enlace
    // de pago" y el bot no envió la URL -- la intención caía a la IA, que
    // no tiene ninguna herramienta para generarlo. Este atajo DETERMINISTA
    // corre antes de la IA (y antes de la consulta de estado, cuyo regex
    // "mi pedido" se comería frases como "el enlace de mi pedido").
    // Respeta el mismo gating que todo procesarConClaude: bot activo y sin
    // takeover (bot_pausado) -- ambos se validan antes de encolar.
    if (detectarSolicitudEnlacePago(texto)) {
      const activos = (await obtenerPedidosActivosPorTelefono(telefono, negocioId)) || [];
      const sinPagar = activos.filter(p => !(p.datos?.pago_confirmado === true || p.datos?.pago_confirmado === 'true'));
      if (activos.length > 0 && sinPagar.length === 0) {
        const msg = `Tu pedido ${activos[0].folio} ya está pagado ✔. No necesitas hacer nada más.`;
        await enviarMensaje(telefono, msg, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
        return;
      }
      if (sinPagar.length === 1) {
        const folioActivo = sinPagar[0].folio;
        // El método debe estar habilitado para ESTE negocio -- nunca se
        // ofrece un enlace que el negocio no maneja.
        const metodos = await obtenerMetodosPagoDisponibles(negocioId);
        const tieneEnlace = metodos.some(m => m.tipo === 'enlace_pago');
        if (!tieneEnlace) {
          const otras = metodos.map(m => m.tipo === 'terminal' ? 'terminal' : m.tipo).join(', ') || 'efectivo';
          const msg = `Por ahora no manejamos pago con enlace. Puedes pagar con: ${otras}.`;
          await enviarMensaje(telefono, msg, credenciales);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
          return;
        }
        try {
          // crearEnlacePago es idempotente: "mándame el enlace otra vez"
          // devuelve el MISMO enlace vigente, jamás un cobro duplicado. El
          // pedido queda pago pendiente hasta que el webhook de la pasarela
          // confirme -- pedir el enlace nunca marca pagado.
          const resultadoLink = await crearEnlacePago({ negocioId, pedidoId: folioActivo, descripcion: `Pedido Xabor #${folioActivo}` });
          const totalPedido = sinPagar[0].datos?.total;
          const msg = resultadoLink.url
            ? `Aquí está tu enlace de pago para el pedido ${folioActivo}:\n${resultadoLink.url}\n\nTotal: $${totalPedido} MXN`
            : `${resultadoLink.instrucciones || 'Te compartimos los datos de pago en un momento.'}\n\nPedido ${folioActivo} — Total: $${totalPedido} MXN`;
          await enviarMensaje(telefono, msg, credenciales);
          await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
          console.log(`[Meta WA] Enlace de pago enviado por solicitud del cliente — pedido ${folioActivo} (negocio ${negocioId})`);
        } catch (e) {
          if (e instanceof ClipNoConfiguradoError || e instanceof SinProveedorPrincipalError) {
            await manejarClipNoConfigurado(telefono, nombreMeta, negocioId, credenciales);
          } else {
            console.error('[Meta WA] Error generando enlace solicitado:', e.message);
            await enviarMensaje(telefono, `Tuvimos un problema generando tu enlace de pago. Escríbenos y te lo enviamos manualmente.`, credenciales);
          }
        }
        return;
      }
      if (sinPagar.length > 1) {
        const folios = sinPagar.map(p => p.folio).join(', ');
        const msg = `Tienes más de un pedido activo (${folios}). ¿De cuál quieres el enlace de pago? Mándame el folio, por ejemplo: ${sinPagar[0].folio}`;
        await enviarMensaje(telefono, msg, credenciales);
        await guardarMensaje(telefono, nombreMeta, 'saliente', msg, negocioId, 'bot');
        return;
      }
      // Sin pedidos activos: el cliente probablemente está eligiendo forma
      // de pago ANTES de confirmar un pedido -- ese flujo es de la IA y se
      // conserva tal cual (sin return).
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

    const resultado = await procesarMensaje(sessionId, texto, clienteCtx, null, negocioId, telefono);
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
      // Incidente XAB-0114: cliente.telefono puede ser el teléfono de
      // ENTREGA dictado en el chat (dato logístico) -- la identidad real de
      // la conversación es el remitente del webhook y se sella aparte para
      // que el cliente siempre pueda recuperar SU pedido ("mándame el
      // enlace") aunque haya dictado otro número o formato.
      resultado.orden.telefono_conversacion = telefono;
      let pedido;
      try {
        pedido = await registrarPedido(resultado.orden, 'whatsapp');
      } catch (e) {
        console.error(`[WA] Error registrando pedido, no se confirma al cliente:`, e.message);
        await enviarMensaje(telefono, 'Tuvimos un problema registrando tu pedido. Por favor intenta de nuevo en un momento.', credenciales);
        return;
      }

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
      // Incidente Alina/Mario: el nombre dictado para la ENTREGA no
      // sustituye al nombre ya conocido del interlocutor -- solo llena el
      // perfil si estaba vacío.
      if (resultado.orden.cliente?.nombre) await upsertClienteNombreEntrega(telefono, resultado.orden.cliente.nombre, negocioId);
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
            // registrarPedido() ya espera (await) su propia persistencia
            // inicial antes de devolver "pedido" -- esta re-invocación es
            // ahora un no-op idempotente y defensivo (ON CONFLICT DO
            // NOTHING contra una fila que ya existe), no una corrección de
            // carrera real como antes. Se conserva sin cambios de
            // comportamiento por si algún día vuelve a haber un camino que
            // llegue aquí sin pasar por registrarPedido.
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

// ─── Enrutamiento repartidor/cliente — patrones de comandos de modo ─────────
// Declarados ANTES del webhook porque el regex de auto-registro de abajo
// ("... repartidor") también matchea por accidente frases como "modo
// repartidor" o "salir de modo repartidor" (ambas terminan en la palabra
// "repartidor") -- sin este guard, esas frases se interpretarían como un
// intento de registrar a alguien llamado "modo" o "salir de modo". Ver
// enrutarMensajeRepartidor más abajo para el resto de la máquina de estados.
const RE_SALIR_MODO_REPARTIDOR = /^sal(ir)?\s+(de\s+)?modo\s+repartidor[.,!]?$/i;
const RE_ENTRAR_MODO_REPARTIDOR = /^(modo\s+repartidor|disponible)[.,!]?$/i;
const RE_MIS_ENTREGAS = /^mis\s+entregas[.,!]?$/i;
const RE_INTENCION_CLIENTE = /quiero\s+(hacer\s+)?(un\s+)?pedido|quiero\s+ordenar|qu[eé]\s+venden|\bmen[uú]\b|quiero\s+(una\s+)?cotizaci[oó]n|quiero\s+comprar/i;

// ─── Webhook de mensajes entrantes (POST) ────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // Meta requiere 200 inmediato

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value   = body.entry?.[0]?.changes?.[0]?.value;

    // Estado de entrega (sent/delivered/read/failed) -- payload distinto
    // al de mensajes entrantes (ver diagnóstico repartidores: esto se
    // descartaba en silencio antes). Se procesa aparte y siempre, exista o
    // no un mensaje entrante en el mismo payload (Meta nunca manda ambos
    // juntos en la práctica, pero no se asume).
    if (value?.statuses?.length) {
      await procesarStatusesWebhook(value.statuses);
    }

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

    // Detectar auto-registro: "repartidor Nombre Apellido" -- nunca para
    // los comandos de modo (ver comentario en las constantes RE_* arriba),
    // que también contienen la palabra "repartidor" pero significan otra
    // cosa para un repartidor ya registrado.
    const textoTrim = texto.trim();
    const esComandoDeModo = RE_ENTRAR_MODO_REPARTIDOR.test(textoTrim) || RE_SALIR_MODO_REPARTIDOR.test(textoTrim);
    const matchRep = !esComandoDeModo && (texto.match(/^repartidor[ao]?\s+(.+)/i) || texto.match(/^(.+?)\s+repartidor[ao]?\s*$/i));
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
      const irAFlujoCliente = await enrutarMensajeRepartidor({ repartidor, texto, telefono, negocioId, credenciales });
      if (!irAFlujoCliente) return;
      // Intención de cliente detectada (o sin_modo/sin reparto activo/sin
      // comando) -- cae al mismo flujo de IA que cualquier cliente normal,
      // más abajo. No hay "return" aquí a propósito.
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

// ─── Enrutamiento repartidor/cliente (incidencia real, piloto Nonna Maye) ───
// Antes de este cambio, la sola existencia de una fila en `repartidores`
// interceptaba TODOS los mensajes de ese teléfono salvo "entregué" -- un
// repartidor no podía escribir "quiero hacer un pedido" y llegar al bot de
// cliente, quedaba encerrado en el flujo de repartidor mientras la fila
// existiera. Esta función reemplaza esa intercepción incondicional por
// prioridades explícitas (acción de reparto activo > comando explícito de
// repartidor > intención de cliente > modo_actual persistido). Devuelve
// `true` si el mensaje debe continuar al flujo normal de cliente/IA (el
// llamador NO hace return en ese caso), o `false` si ya se atendió aquí.
// (RE_* declarados arriba, antes del webhook -- ver ahí el porqué.)
async function enrutarMensajeRepartidor({ repartidor, texto, telefono, negocioId, credenciales }) {
  const textoNorm = texto.trim();
  const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://xabor-agent-production.up.railway.app';

  async function responder(msg) {
    await enviarMensaje(telefono, msg, credenciales);
    await guardarMensaje(telefono, repartidor.nombre, 'entrante', texto, negocioId, 'cliente');
    await guardarMensaje(telefono, repartidor.nombre, 'saliente', msg, negocioId, 'bot');
  }

  // Prioridad A — acción de un reparto activo. Se mantiene EXACTAMENTE
  // igual que antes (no se toca el flujo de asignación/entrega ya
  // probado): si no hay pedido activo asignado, informa y no falla.
  if (/entregu[eé]|entregado|ya entregué|listo[.,!]?$/i.test(textoNorm)) {
    const misPedidos = await obtenerPedidosAsignadosARepartidor(repartidor.id);
    const activo = misPedidos.find(p => !['entregado', 'cancelado'].includes(p.estado));
    if (activo) {
      // negocioId ya viene resuelto y confiable del propio webhook (Meta
      // phone_number_id -> integraciones_canal), y `repartidor` ya se
      // encontró filtrando por ese mismo negocioId (obtenerRepartidorPorTelefono)
      // -- pasarlo aquí es la corrección correcta, no un bypass: hallazgo
      // real (no introducido por este cambio) de que esta llamada nunca
      // traía el tercer argumento que actualizarEstadoPedido exige desde
      // el endurecimiento P0, así que "ya entregué" por WhatsApp nunca
      // marcaba nada -- quedaba rechazado en silencio (ver warning en
      // orderManager.js). No se toca actualizarEstadoPedidoLegacySinNegocio
      // (reservada exclusivamente para /api/repartidor/pedido/:folio/entregado).
      const { actualizarEstadoPedido } = await import('../orders/orderManager.js');
      actualizarEstadoPedido(activo.folio, 'entregado', negocioId);
      await responder(`✅ Perfecto ${repartidor.nombre}, el pedido ${activo.folio} quedó marcado como entregado. ¡Buen trabajo!`);
      console.log(`[WA Repartidor] ${repartidor.nombre} confirmó entrega de ${activo.folio}`);
    } else {
      await responder('No tienes pedidos activos asignados en este momento.');
    }
    return false;
  }

  // Prioridad B — comandos explícitos de repartidor. Siempre se procesan,
  // sin importar el modo_actual previo.
  if (RE_SALIR_MODO_REPARTIDOR.test(textoNorm)) {
    await actualizarModoConversacionRepartidor(repartidor.id, 'cliente');
    await responder(`Listo ${repartidor.nombre}, saliste del modo repartidor. Ya puedes escribirme como cliente (por ejemplo, "quiero hacer un pedido").`);
    return false;
  }
  if (RE_ENTRAR_MODO_REPARTIDOR.test(textoNorm)) {
    await actualizarModoConversacionRepartidor(repartidor.id, 'repartidor');
    await responder(`Hola ${repartidor.nombre} 👋 Quedaste en modo repartidor.\nEntra aquí para ver los pedidos disponibles:\n${BASE_URL}/repartidor.html\n\nEscribe "salir de modo repartidor" cuando quieras volver a escribirme como cliente.`);
    return false;
  }
  if (RE_MIS_ENTREGAS.test(textoNorm)) {
    const misPedidos = await obtenerPedidosAsignadosARepartidor(repartidor.id);
    const msg = misPedidos.length
      ? `Tienes ${misPedidos.length} pedido(s) asignado(s):\n` + misPedidos.map(p => `• ${p.folio} — ${p.estado}`).join('\n')
      : 'No tienes pedidos asignados en este momento.';
    await responder(msg);
    return false;
  }

  // Prioridad C — intención de cliente: siempre gana, aunque haya un
  // reparto activo o el modo previo fuera 'repartidor' (requisito
  // explícito: nunca debe quedar encerrado en el rol de repartidor).
  if (RE_INTENCION_CLIENTE.test(textoNorm)) {
    await actualizarModoConversacionRepartidor(repartidor.id, 'cliente');
    return true;
  }

  // Sin comando ni intención clara -- resolver por modo_actual persistido.
  if (repartidor.modo_actual === 'cliente') return true;

  if (repartidor.modo_actual === 'repartidor') {
    await responder(`Hola ${repartidor.nombre} 👋\nEntra aquí para ver los pedidos disponibles:\n${BASE_URL}/repartidor.html`);
    console.log(`[Meta WA] Repartidor ${repartidor.nombre} en modo repartidor, se saltó el bot.`);
    return false;
  }

  // modo_actual === 'sin_modo': solo preguntamos si de verdad hay
  // ambigüedad real (un reparto activo pendiente). Sin reparto activo, un
  // mensaje neutro se trata como cliente por defecto -- nunca se encierra
  // en un rol por la sola existencia del registro.
  const misPedidosActivos = await obtenerPedidosAsignadosARepartidor(repartidor.id);
  if (misPedidosActivos.length > 0) {
    await responder('¿Quieres continuar como repartidor o realizar un pedido?');
    return false;
  }
  return true;
}

// ─── Piloto de notificaciones por plantilla: lista blanca de teléfonos ──────
// Mientras el piloto está en curso, repartidor_notif_plantilla_activo=true
// NUNCA notifica a todos por ausencia de lista -- solo a los teléfonos
// explícitamente listados en configuracion.repartidor_notif_piloto_telefonos
// (texto plano separado por comas, mismo formato que el resto de la tabla
// configuracion -- no hay precedente de JSON en esa tabla). Habilitar el
// envío a todos los repartidores en producción requerirá, más adelante, una
// configuración de "rollout completo" aparte y explícita -- no se implementa
// todavía, y la ausencia de lista NUNCA debe interpretarse como "enviar a
// todos".
//
// Lee configuracion.repartidor_notif_piloto_telefonos y devuelve el conjunto
// de teléfonos normalizados autorizados. Falla cerrado: si el valor está
// ausente, vacío, o cada elemento resulta ilegible como teléfono, devuelve
// un conjunto vacío -- nunca lanza, nunca autoriza "a todos" por defecto.
function parsearListaPilotoTelefonos(valorConfig) {
  if (typeof valorConfig !== 'string' || !valorConfig.trim()) {
    return { telefonos: new Set(), malformada: false };
  }
  const partes = valorConfig.split(',').map(s => s.trim()).filter(Boolean);
  if (partes.length === 0) return { telefonos: new Set(), malformada: false };

  const telefonos = new Set();
  let huboInvalido = false;
  for (const parte of partes) {
    const normalizado = normalizarTelefonoMX(parte);
    if (!normalizado) { huboInvalido = true; continue; }
    telefonos.add(normalizado);
  }
  // Si NINGÚN elemento pudo interpretarse como teléfono, la lista completa
  // se trata como mal formada (fail closed a 0, nunca a "todos").
  if (telefonos.size === 0 && huboInvalido) {
    return { telefonos: new Set(), malformada: true };
  }
  return { telefonos, malformada: false };
}

// ─── Notificar repartidores activos por WhatsApp ─────────────────────────────
// opts.origen: 'auto' (disparado por emitirPedido, comportamiento original)
// o 'manual' (el negocio solicitó repartidor explícitamente para este
// pedido, vía POST /api/pedidos/:folio/solicitar-repartidor). La distinción
// existe SOLO para la configuración por negocio (red_repartidores_config,
// migración 038): con solicitud_automatica=false, 'auto' se bloquea y
// 'manual' pasa; el resto de la evaluación (red activa, horario, cobertura)
// aplica igual para ambos orígenes.
export async function notificarRepartidoresPorWA(pedido, opts = {}) {
  try {
    const origen = opts.origen === 'manual' ? 'manual' : 'auto';
    if (!pedido?.negocioId) {
      console.warn('[WA Repartidor] notificarRepartidoresPorWA: pedido sin negocioId — no se notifica a nadie (fail closed)');
      return;
    }
    // Defensa en profundidad: esPedidoElegibleParaRedRepartidores ya se
    // evalúa en emitirPedido antes de llamar aquí, pero esta función debe
    // ser segura de invocar directamente (reenvío manual futuro, etc.) --
    // un pedido de Rappi nunca debe llegar a notificar repartidores de Xabor.
    if (!esPedidoElegibleParaRedRepartidores(pedido)) {
      console.log(`[WA Repartidor] Pedido ${pedido.id} no elegible para la red de repartidores (canal=${pedido.canal}, modalidad=${pedido.modalidad}, estado=${pedido.estado}) — omitido`);
      return;
    }
    // Configuración de red POR NEGOCIO (migración 038): un negocio sin fila
    // conserva el comportamiento actual exacto (evaluarSolicitudRed devuelve
    // procede=true con razon 'sin_config_legado'). Con fila: red inactiva,
    // fuera de horario, fuera de cobertura o solicitud manual requerida
    // bloquean la oferta ANTES de tocar repartidores o credenciales.
    const configRed = await obtenerConfigRed(pedido.negocioId);
    const evaluacion = evaluarSolicitudRed(pedido, configRed, origen);
    if (!evaluacion.procede) {
      console.log(`[WA Repartidor] Pedido ${pedido.id} no ofrecido a la red (${evaluacion.razon}, origen=${origen}) — negocio ${pedido.negocioId}`);
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

    // Hotfix oferta-repartidor: el PRIMER mensaje jamás lleva nombre del
    // cliente, número exterior/interior, referencias, teléfono ni la
    // dirección completa -- solo negocio, colonia/calle y pago. La
    // dirección completa llega únicamente al repartidor que GANA la
    // asignación (plantilla de detalle / pantalla asignado_a_mi).
    const nombreNegocioOferta = (await obtenerNombreNegocio(pedido.negocioId)) || 'Xabor';
    const entregaEn = formatearEntregaOferta(pedido.cliente?.calle, pedido.cliente?.colonia);
    const lineaPago = Number.isFinite(Number(pedido.total)) ? `\nPago por entrega: $${Number(pedido.total).toFixed(2)} MXN` : '';
    const texto = `🛵 *NUEVO PEDIDO DISPONIBLE*\n\nRecoge en: ${nombreNegocioOferta}\nEntrega en: ${entregaEn}${lineaPago}\n\n¿Deseas cubrir este pedido?\nEntra aquí para consultar y aceptar:\n${BASE_URL}/repartidor.html\n\nLa asignación se confirma al primer repartidor que lo acepte.`;

    // Modo de notificación por negocio: 'apagado' | 'piloto' | 'completo'.
    // Retrocompatibilidad: si repartidor_notif_modo no está configurado
    // (negocios que nunca tocaron este piloto, o que lo activaron antes de
    // que existiera esta clave), se deriva del flag booleano anterior --
    // 'true' equivale a 'piloto' (que es exactamente lo que ese flag
    // activaba hasta ahora), ausente/'false' equivale a 'apagado'. La
    // ausencia de whitelist NUNCA activa 'completo' -- ese modo exige la
    // clave nueva explícita.
    const cfg = await obtenerConfiguracion(pedido.negocioId);
    const MODOS_VALIDOS = ['apagado', 'piloto', 'completo'];
    const modo = MODOS_VALIDOS.includes(cfg.repartidor_notif_modo)
      ? cfg.repartidor_notif_modo
      : (cfg.repartidor_notif_plantilla_activo === 'true' ? 'piloto' : 'apagado');
    const usarPlantilla = modo !== 'apagado';

    // Requisito explícito del usuario: el mensaje de oferta NUNCA lleva
    // nombre/teléfono/dirección del cliente -- solo negocio y pago
    // estimado. "Pago estimado" hoy es pedido.total (no existe todavía un
    // cálculo de comisión/pago propio del repartidor, separado del total
    // que paga el cliente -- fuera de alcance de este cambio).
    const nombreNegocio = usarPlantilla ? nombreNegocioOferta : null;
    const pagoEstimado = `$${pedido.total} MXN`;
    const TOKEN_EXPIRACION_MINUTOS = 30;

    // Fase C: plantilla v2 (negocio/folio/ubicación/tarifa/enlace) -- apagada
    // por defecto (ver enviarPlantillaXaborNuevoServicioRepartoV2 arriba,
    // requiere que Meta apruebe la plantilla nueva primero). Mientras el
    // negocio no active esta clave explícitamente, el comportamiento es
    // IDÉNTICO al actual (plantilla v1, 3 variables).
    const usarPlantillaV2 = usarPlantilla && cfg.repartidor_notif_plantilla_v2_activo === 'true';
    let ubicacionOferta = null;
    let tarifaOferta = null;
    if (usarPlantillaV2) {
      const { texto, ubicacionPendiente } = formatearUbicacionRepartidor(pedido.cliente?.calle, pedido.cliente?.colonia);
      ubicacionOferta = texto;
      tarifaOferta = formatearTarifaRepartidor(pedido.total);
      if (ubicacionPendiente) {
        console.warn(`[WA Repartidor][V2] Pedido ${pedido.id}: sin calle ni colonia -- se envía "Ubicación pendiente de confirmar" (registrado)`);
      }
    }

    // Comportamiento anterior EXACTO cuando el modo es 'apagado' -- ningún
    // filtro, ningún registro, texto libre a todos los repartidores del
    // negocio, tal como antes de este piloto.
    if (!usarPlantilla) {
      for (const r of repartidores) {
        try {
          await enviarMensaje(r.telefono, texto, credenciales);
          console.log(`[WA Repartidor] Notificación enviada a ${r.nombre} (${r.telefono})`);
        } catch (e) {
          console.error(`[WA Repartidor] Error al notificar a ${r.nombre}: ${e.message}`);
        }
      }
      return;
    }

    // 'piloto': SOLO se notifica a los teléfonos de la lista blanca --
    // nunca "a todos" por ausencia/lista vacía/lista ilegible (fail
    // closed). 'completo' reutiliza el mismo filtro de activo/válido/
    // duplicado, pero sin la condición de whitelist.
    let listaPiloto = new Set();
    if (modo === 'piloto') {
      const parseo = parsearListaPilotoTelefonos(cfg.repartidor_notif_piloto_telefonos);
      listaPiloto = parseo.telefonos;
      if (parseo.malformada) {
        console.warn(`[WA Repartidor][Piloto] configuracion.repartidor_notif_piloto_telefonos ilegible para negocio ${pedido.negocioId} -- 0 destinatarios (fail closed)`);
      } else if (listaPiloto.size === 0) {
        console.warn(`[WA Repartidor][Piloto] Sin lista de piloto (o vacía) para negocio ${pedido.negocioId} -- 0 destinatarios (fail closed). El envío a todos los repartidores requiere modo 'completo' explícito.`);
      }
    }

    const etiqueta = modo === 'completo' ? 'Completo' : 'Piloto';
    const telefonosNotificados = new Set();
    const repartidoresPermitidos = [];
    for (const r of repartidores) {
      const normalizado = normalizarTelefonoMX(r.telefono);
      if (!normalizado) {
        console.log(`[WA Repartidor][${etiqueta}] ${r.nombre} (id=${r.id}) excluido -- teléfono inválido`);
        continue;
      }
      if (!r.activo) {
        console.log(`[WA Repartidor][${etiqueta}] ${r.nombre} (id=${r.id}) excluido -- repartidor inactivo`);
        continue;
      }
      if (modo === 'piloto' && !listaPiloto.has(normalizado)) {
        console.log(`[WA Repartidor][Piloto] ${r.nombre} (id=${r.id}) excluido -- no está en la lista blanca del piloto`);
        continue;
      }
      if (telefonosNotificados.has(normalizado)) {
        console.log(`[WA Repartidor][${etiqueta}] ${r.nombre} (id=${r.id}) excluido -- teléfono duplicado, ya notificado en esta misma fila de otro repartidor`);
        continue;
      }
      telefonosNotificados.add(normalizado);
      repartidoresPermitidos.push(r);
    }

    for (const r of repartidoresPermitidos) {
      // Idempotencia: un mismo pedido nunca debe generar un segundo intento
      // para el mismo repartidor (p. ej. si notificarRepartidoresPorWA se
      // invocara dos veces por error para el mismo pedido).
      if (await existeNotificacionRepartidor(pedido.id, r.id)) {
        console.log(`[WA Repartidor][${etiqueta}] ${r.nombre} (id=${r.id}) excluido -- ya existe un intento de notificación para este pedido`);
        continue;
      }
      // Token de aceptación de un solo uso, propio de ESTE repartidor y
      // ESTE pedido -- ver migración 033 y consumirTokenAceptacionRepartidor.
      const token = randomBytes(24).toString('base64url');
      const tokenExpiraAt = new Date(Date.now() + TOKEN_EXPIRACION_MINUTOS * 60 * 1000);
      const enlaceAceptar = `${BASE_URL}/repartidor/aceptar/${token}`;

      try {
        const wamid = usarPlantillaV2
          ? await enviarPlantillaXaborNuevoServicioRepartoV2(
              r.telefono,
              { nombreNegocio, folio: pedido.id, ubicacion: ubicacionOferta, tarifa: tarifaOferta, enlaceAceptar },
              credenciales
            )
          : await enviarPlantillaXaborNuevoServicioReparto(
              r.telefono,
              { nombreNegocio, pagoEstimado, enlaceAceptar },
              credenciales
            );
        await registrarNotificacionRepartidor({
          negocioId: pedido.negocioId,
          pedidoFolio: pedido.id,
          repartidorId: r.id,
          canal: 'plantilla',
          wamid,
          estado: wamid ? 'aceptado_meta' : 'error_envio',
          tokenAceptacion: token,
          tokenExpiraAt
        });
        console.log(`[WA Repartidor] Plantilla aceptada por Meta para ${r.nombre} (${r.telefono}) wamid=${wamid}`);
      } catch (e) {
        await registrarNotificacionRepartidor({
          negocioId: pedido.negocioId,
          pedidoFolio: pedido.id,
          repartidorId: r.id,
          canal: 'plantilla',
          estado: 'error_envio',
          errorDetalle: e.message,
          tokenAceptacion: token,
          tokenExpiraAt
        });
        console.error(`[WA Repartidor] Error al notificar (plantilla) a ${r.nombre}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[WA Repartidor] Error general:', e.message);
  }
}

// ─── Consulta de oferta por token (pantalla del enlace, SIN consumir) ───────
// La pantalla que abre el repartidor desde el enlace ya NO consume el token
// al cargar: consulta este resolutor (recargable, multi-dispositivo) y solo
// el botón "Aceptar pedido" dispara la aceptación real. Estados
// estructurados para el frontend: disponible / asignado_a_mi /
// cubierto_por_otro / cancelado / expirado / completado / invalido.
// Regla de privacidad: antes de aceptar solo negocio+colonia/calle+pago;
// para cubierto_por_otro SOLO el nombre legible del asignado (jamás
// teléfono, vehículo, ids internos); la dirección completa solo la ve el
// repartidor asignado.
export async function consultarOfertaRepartidor(token) {
  const fila = await obtenerOfertaPorToken(token);
  if (!fila) return { estado: 'invalido' };

  const asignadoId = fila.asignado_id || null;
  const esMio = asignadoId !== null && String(asignadoId) === String(fila.repartidor_id);

  // La asignación manda sobre expiración/cancelación posteriores: un
  // repartidor que ya ganó conserva su pantalla aunque el token venza.
  if (esMio) {
    if (fila.pedido_estado === 'entregado') return { estado: 'completado' };
    const pedido = await obtenerPedidoActivoPorFolio(fila.pedido_folio, fila.negocio_id);
    const direccion = pedido ? [
      pedido.cliente?.calle, pedido.cliente?.colonia,
      pedido.cliente?.entre_calles ? `entre ${pedido.cliente.entre_calles}` : null,
    ].filter(Boolean).join(', ') : null;
    return {
      estado: 'asignado_a_mi',
      pedido: pedido ? {
        folio: fila.pedido_folio,
        negocio: fila.negocio_nombre || null,
        direccion: direccion || null,
        telefonoCliente: pedido.cliente?.telefono || null,
        nombreCliente: pedido.cliente?.nombre || null,
        observaciones: pedido.notas || null,
        pago: Number.isFinite(Number(pedido.total)) ? `$${Number(pedido.total).toFixed(2)} MXN` : null,
      } : null,
    };
  }

  if (asignadoId !== null) {
    // Nombre legible o texto neutro -- nunca null/UUID/datos de contacto.
    const nombre = (typeof fila.asignado_nombre === 'string' && fila.asignado_nombre.trim())
      ? fila.asignado_nombre.trim() : null;
    return { estado: 'cubierto_por_otro', repartidorAsignado: nombre ? { nombre } : null };
  }

  if (fila.pedido_estado === null) return { estado: 'invalido' };
  if (fila.pedido_estado === 'cancelado') return { estado: 'cancelado' };
  if (fila.pedido_estado === 'entregado') return { estado: 'completado' };
  if (fila.token_usado_at !== null) return { estado: 'expirado' };
  if (fila.token_expira_at && new Date(fila.token_expira_at).getTime() <= Date.now()) return { estado: 'expirado' };

  return {
    estado: 'disponible',
    oferta: {
      negocio: fila.negocio_nombre || 'Negocio',
      entregaEn: formatearEntregaOferta(fila.calle, fila.colonia),
      pago: Number.isFinite(Number(fila.total)) ? `$${Number(fila.total).toFixed(2)} MXN` : null,
      ofertadaAt: fila.created_at || null,
    },
  };
}

// ─── Procesar aceptación de un servicio de reparto vía token ────────────────
// Llamado por GET /repartidor/aceptar/:token (server.js, ruta pública -- el
// token en sí es la credencial de un solo uso, no requiere sesión de
// repartidor). Consumo atómico primero (nunca se reintenta ni se
// reutiliza), luego asignación atómica (ya existente, ver asignarRepartidor
// -- si otro repartidor ya se adelantó, esto falla aunque el token propio
// haya sido válido), y solo si ambas cosas tienen éxito se envía la
// plantilla con los datos completos.
export async function procesarAceptacionTokenRepartidor(token) {
  const fila = await consumirTokenAceptacionRepartidor(token);
  if (!fila) {
    return { ok: false, motivo: 'token_invalido', mensaje: 'Este enlace ya no es válido, ya fue usado, o expiró.' };
  }

  // El repartidor y su nombre real vienen de la propia fila/tabla, nunca
  // del token ni de un valor externo.
  const [repartidores, credenciales, pedido] = await Promise.all([
    obtenerRepartidores(fila.negocio_id),
    obtenerCredencialesWhatsappNegocio(fila.negocio_id),
    obtenerPedidoActivoPorFolio(fila.pedido_folio, fila.negocio_id),
  ]);
  const rep = repartidores.find(r => r.id === fila.repartidor_id);
  if (!rep) {
    return { ok: false, motivo: 'repartidor_no_encontrado', mensaje: 'No se encontró tu registro de repartidor.' };
  }

  const asignado = await asignarRepartidor(fila.pedido_folio, rep.id, rep.nombre, fila.negocio_id);
  if (!asignado) {
    return { ok: false, motivo: 'ya_tomado', mensaje: 'Este pedido ya fue tomado por otro repartidor.' };
  }

  // Fase C: evento de tiempo real -- payload mínimo (folio/negocio/
  // repartidorId), nunca teléfono/token/datos del cliente. Superadmin ve
  // todos los negocios; el negocio-admin del propio negocio lo recibe vía
  // broadcastNegocio con soloAdmin (staff no administra la red). Nunca
  // bloquea el flujo si el WS falla -- ambas llamadas son fire-and-forget.
  try {
    wsBroadcastSuperadmin?.({ tipo: 'red_repartidores_servicio_aceptado', folio: fila.pedido_folio, negocioId: fila.negocio_id, repartidorId: rep.id });
    wsBroadcast?.(fila.negocio_id, { tipo: 'red_repartidores_servicio_aceptado', folio: fila.pedido_folio, repartidorId: rep.id }, { soloAdmin: true });
  } catch (e) {
    console.error('[WS] Error emitiendo red_repartidores_servicio_aceptado:', e.message);
  }

  if (!pedido) {
    // Caso extremo: el pedido desapareció entre la asignación y esta
    // lectura. La asignación en sí ya tuvo éxito -- no se revierte -- pero
    // no hay datos que enviar en la plantilla de detalle.
    console.error(`[Repartidor Token] Pedido ${fila.pedido_folio} asignado pero no encontrado al leer detalle`);
    return { ok: true, motivo: 'asignado_sin_detalle', mensaje: '¡Listo! El pedido quedó asignado. Contacta al negocio para los detalles.' };
  }

  if (credenciales) {
    const direccion = [pedido.cliente?.calle, pedido.cliente?.colonia, pedido.cliente?.entre_calles ? `entre ${pedido.cliente.entre_calles}` : null]
      .filter(Boolean).join(', ');
    try {
      await enviarPlantillaXaborDetalleServicioReparto(rep.telefono, {
        folio: fila.pedido_folio,
        nombreCliente: pedido.cliente?.nombre,
        telefonoCliente: pedido.cliente?.telefono,
        direccion,
        observaciones: pedido.notas,
        monto: `$${pedido.total} MXN`,
      }, credenciales);
    } catch (e) {
      console.error(`[Repartidor Token] Error enviando plantilla de detalle a ${rep.nombre}: ${e.message}`);
    }
  } else {
    console.log(`[Repartidor Token] Notificación de detalle omitida — sin integración propia verificada para negocio ${fila.negocio_id}`);
  }

  return { ok: true, motivo: 'asignado', mensaje: '¡Listo! El pedido quedó asignado. Revisa tu WhatsApp para los detalles completos.' };
}

// ─── Procesar webhook de estado de mensaje (sent/delivered/read/failed) ─────
// Meta reporta el resultado REAL de un envío de forma asíncrona en
// value.statuses -- separado de value.messages. El webhook anterior
// descartaba estos payloads por completo (early-return por falta de
// `messages`), que es exactamente por qué Xabor nunca se enteraba de un
// envío aceptado-pero-no-entregado (ver diagnóstico repartidores). Esta
// función solo actualiza notificaciones_repartidor por wamid -- no toca
// nada del flujo de mensajes de cliente.
export async function procesarStatusesWebhook(statuses) {
  for (const s of statuses) {
    if (!s?.id || !s?.status) continue;
    const estado = s.status; // 'sent' | 'delivered' | 'read' | 'failed'
    const estadoMapeado = estado === 'sent' ? 'aceptado_meta'
      : estado === 'delivered' ? 'entregado'
      : estado === 'read' ? 'leido'
      : estado === 'failed' ? 'fallido'
      : null;
    if (!estadoMapeado) continue;
    const errorInfo = estado === 'failed' && s.errors?.[0]
      ? { errorCodigo: String(s.errors[0].code || ''), errorDetalle: s.errors[0].title || s.errors[0].message || '' }
      : {};
    try {
      const actualizado = await actualizarEstadoNotificacionPorWamid(s.id, estadoMapeado, errorInfo);
      if (actualizado) {
        console.log(`[WA Status] ${s.id} -> ${estadoMapeado}`);
        // Fase C: si este era el último intento pendiente y ahora TODOS
        // los intentos de este pedido fallaron (y sigue sin repartidor
        // asignado), el servicio pasa a "sin cobertura" -- se avisa en
        // tiempo real para que Superadmin/negocio-admin puedan reaccionar
        // (p. ej. reenvío manual futuro), sin esperar a que alguien
        // refresque la pantalla manualmente.
        if (estadoMapeado === 'fallido' && await esPedidoSinCoberturaAhora(actualizado.pedido_folio)) {
          try {
            wsBroadcastSuperadmin?.({ tipo: 'red_repartidores_sin_cobertura', folio: actualizado.pedido_folio, negocioId: actualizado.negocio_id });
            wsBroadcast?.(actualizado.negocio_id, { tipo: 'red_repartidores_sin_cobertura', folio: actualizado.pedido_folio }, { soloAdmin: true });
          } catch (e) {
            console.error('[WS] Error emitiendo red_repartidores_sin_cobertura:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[WA Status] Error procesando status:', e.message);
    }
  }
}

export default router;
