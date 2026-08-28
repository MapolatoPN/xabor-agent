import Anthropic from '@anthropic-ai/sdk';
import { getIntegracion, broadcastNegocio } from '../server.js';
import { construirSystemPrompt, construirBloqueModoComercial, BLOQUE_REGLAS_CONTEXTO_VISUAL, hayContextoVisual } from './prompts.js';
import { agregarMensaje, getSession } from './session.js';
import { obtenerPerfilCliente, construirContextoCliente, registrarEvento, actualizarOportunidad, EVENTOS } from '../services/memory.js';
import { obtenerEstadoModulo } from '../services/database.js';
import { detectarIntencionComercial, activaModoComercial } from './intentDetector.js';
import { obtenerSesionActiva, obtenerOCrearSesionActiva, actualizarCamposSesion, marcarSesionComoErrorRecuperable } from '../services/sesionComercial.js';
import { extraerCamposComerciales, tieneBorradorListo, limpiarBloqueComercial, fusionarCamposCapturados } from './comercialMarkers.js';
import { generarBorradorDesdeSesion } from '../services/draftBuilder.js';
import { notificarBorradorAlAdmin } from '../services/notificacionBorradorAdmin.js';
import { normalizarFormatoWhatsApp } from '../utils/formatoWhatsapp.js';

// Cliente lazy — se crea en runtime para respetar config desde panel
let _anthropic = null;
function getAnthropic() {
  const key = getIntegracion('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
  if (!_anthropic || _anthropic.apiKey !== key) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

// Modelo: haiku es rápido y barato, ideal para conversaciones
const MODELO = 'claude-haiku-4-5-20251001';

// ─── Versión normal (WhatsApp, Rappi, panel) ─────────────────────────────────
// negocioId: pasado tal cual por el llamador (ya resuelto de forma segura --
// integraciones_canal para WhatsApp, sesión autenticada para el panel).
// Nunca se resuelve aquí, nunca cae a un negocio por defecto -- ver
// construirSystemPrompt para el detalle de fail-closed en Rewards.
//
// telefonoExplicito (P1, hotfix): el número real del remitente, pasado
// SIEMPRE que el llamador lo tenga disponible -- independiente de
// clienteCtx, que solo existe cuando el cliente YA tenía un registro
// previo (clienteCtx null es la señal intencional de "cliente nuevo" para
// el bloque "cliente recurrente" de construirSystemPrompt, y eso NO
// cambia aquí). Antes, tanto la memoria de cliente como el Asistente
// Comercial derivaban `telefono` únicamente de `clienteCtx?.telefono`, así
// que el primer mensaje de un cliente genuinamente nuevo (clienteCtx aún
// null en ese instante) nunca podía activar ninguna de las dos, sin
// importar lo que dijera -- ver whatsapp-meta.js, que ahora sí pasa el
// teléfono real del webhook en todos los casos.
export async function procesarMensaje(sessionId, mensajeUsuario, clienteCtx = null, canal = null, negocioId = null, telefonoExplicito = null) {
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);

  // Enriquecer contexto con memoria del cliente (no bloquea si falla)
  const telefono = telefonoExplicito || clienteCtx?.telefono;
  let memoriaCtx = '';
  if (telefono && telefono !== '—' && typeof negocioId === 'string' && negocioId.trim()) {
    const perfil = await obtenerPerfilCliente(telefono, negocioId);
    memoriaCtx = construirContextoCliente(perfil);
  }

  // Asistente Comercial de Cotizaciones (Fase 1-2): IntentDetector decide
  // si este mensaje activa/continúa el modo comercial. Nunca se activa
  // sin negocioId+telefono válidos, ni si el negocio no tiene el módulo
  // dedicado 'asistente_comercial_cotizaciones' habilitado (migración 028
  // -- separado de 'generador_cotizaciones', que solo gatea el generador
  // MANUAL del panel; el asistente por WhatsApp es una capacidad
  // independiente, activable/desactivable por negocio sin afectar al
  // generador manual). Ante cualquier error de clasificación, la
  // categoría cae a 'ambiguo' y nunca se activa -- fail-closed, el flujo
  // normal de pedidos nunca se ve interrumpido por esta pieza.
  let sesionComercial = null;
  let bloqueComercial = '';
  if (telefono && telefono !== '—' && typeof negocioId === 'string' && negocioId.trim()) {
    try {
      const moduloHabilitado = (await obtenerEstadoModulo(negocioId, 'asistente_comercial_cotizaciones')) === 'activo';
      const sesionExistente = await obtenerSesionActiva(negocioId, telefono);
      const categoria = await detectarIntencionComercial({
        mensaje: mensajeUsuario,
        moduloHabilitado,
        estadoComercialActual: sesionExistente?.estado || null,
        apiKey: getIntegracion('anthropic_api_key'),
      });
      if (activaModoComercial(categoria)) {
        sesionComercial = sesionExistente || await obtenerOCrearSesionActiva(negocioId, telefono);
        bloqueComercial = construirBloqueModoComercial(sesionComercial.campos_capturados);
      }
    } catch (e) {
      console.error('[brain] Error evaluando modo comercial (se continúa sin activarlo):', e.message);
    }
  }

  // Registrar evento (asíncrono, no bloquea respuesta)
  if (telefono) {
    registrarEvento({
      tipo: EVENTOS.MENSAJE_RECIBIDO,
      entidad_tipo: 'cliente',
      entidad_id: telefono,
      payload: { texto: mensajeUsuario.slice(0, 200) },
      canal: canal || 'whatsapp',
      sesion_id: sessionId
    });
  }

  try {
    const respuesta = await getAnthropic().messages.create({
      model: MODELO,
      max_tokens: 1024,
      // Las reglas del contexto visual solo se pagan cuando la sesión trae
      // una foto analizada (Vision V2); el resto de turnos no cambia.
      system: await construirSystemPrompt(clienteCtx, canal, negocioId) + memoriaCtx + bloqueComercial
        + (hayContextoVisual(session.mensajes) ? BLOQUE_REGLAS_CONTEXTO_VISUAL : ''),
      messages: session.mensajes
    });

    const textoRespuesta = respuesta.content[0].text;
    agregarMensaje(sessionId, 'assistant', textoRespuesta);

    const orden = extraerOrden(textoRespuesta);

    // Registrar intents y actualizar oportunidad (background, no bloquea)
    registrarIntents(telefono, sessionId, canal || 'whatsapp', mensajeUsuario, textoRespuesta, orden)
      .catch(e => console.error('[brain] registrarIntents:', e.message));

    // Extracción de campos comerciales + disparo del borrador. Fase 3
    // (DraftBuilder) es quien valida que haya información suficiente antes
    // de crear la cotización -- <BORRADOR_LISTO> es solo una señal del
    // modelo, nunca una autorización de escritura por sí sola.
    //
    // ESTO SE ESPERA (await), a propósito -- ya NO es fire-and-forget.
    // Antes, la respuesta al cliente (que el propio modelo ya redactaba
    // como "Listo, ya preparé tu cotización...") se enviaba ANTES de que
    // esto siquiera empezara a correr, así que un fallo de guardado dejaba
    // al cliente con una promesa falsa y a la sesión atorada en silencio.
    // Ahora la confirmación real (éxito o aviso honesto de error) la
    // agrega este código DESPUÉS de confirmar qué pasó de verdad, nunca el
    // modelo por su cuenta (ver prompts.js).
    let textoFinal = limpiarBloqueComercial(limpiarTexto(textoRespuesta));
    if (sesionComercial) {
      try {
        const resultadoComercial = await procesarCapturaComercial(sesionComercial, negocioId, textoRespuesta);
        if (resultadoComercial?.mensajeCliente) {
          textoFinal = `${textoFinal}\n\n${resultadoComercial.mensajeCliente}`.trim();
        }
      } catch (e) {
        console.error('[brain] Error inesperado procesando captura comercial:', e.message);
      }
    }

    return {
      texto: textoFinal,
      orden,
      factura: extraerFactura(textoRespuesta),
      escalar: textoRespuesta.includes('<ESCALAR_A_HUMANO>'),
      enviarMenu: textoRespuesta.includes('<ENVIAR_MENU>'),
      sessionId
    };

  } catch (error) {
    console.error('[brain] Error al llamar a Claude:', error.message);
    throw error;
  }
}

// ─── Simulador del bot (Fase 4 -- centro de entrenamiento) ───────────────────
// Usa EXACTAMENTE la misma construcción de prompt que procesarMensaje (mismo
// menú, mismas reglas_atencion, mismo entrenamiento configurado) para que la
// respuesta simulada sea representativa de lo que el bot real diría -- pero
// deliberadamente NUNCA llama a registrarPedido/enviarMensaje/memoria/
// facturación/Rewards ni persiste nada en `mensajes`. Cualquier marcador que
// el modelo emita (<ORDEN_CONFIRMADA>, <ESCALAR_A_HUMANO>, etc.) se detecta
// solo para mostrarlo como aviso informativo en el simulador -- nunca se
// actúa sobre él. sessionId vive en el mismo Map en memoria de session.js
// pero bajo el prefijo 'sim-' (nunca colisiona con sesiones reales de
// WhatsApp/voz, que usan teléfono o 'call-').
export async function simularMensaje(sessionId, mensajeUsuario, negocioId) {
  if (!sessionId || !sessionId.startsWith('sim-')) throw new Error('sessionId de simulador inválido');
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);
  try {
    const respuesta = await getAnthropic().messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: await construirSystemPrompt(null, 'simulador', negocioId),
      messages: session.mensajes,
    });
    const textoRespuesta = respuesta.content[0].text;
    agregarMensaje(sessionId, 'assistant', textoRespuesta);
    return {
      texto: limpiarTexto(textoRespuesta),
      ordenDetectada: !!extraerOrden(textoRespuesta),
      escalar: textoRespuesta.includes('<ESCALAR_A_HUMANO>'),
      sessionId,
    };
  } catch (error) {
    console.error('[brain] Error en simulador:', error.message);
    throw error;
  }
}

// ─── Versión streaming (voz) ──────────────────────────────────────────────────
// onFrase(texto) se llama por cada oración completa mientras Claude genera.
// signal: AbortSignal — cuando se aborta, el stream se cancela limpiamente.
// Retorna null si fue abortado antes de terminar; de lo contrario el mismo objeto
// que procesarMensaje.
export async function procesarMensajeStream(sessionId, mensajeUsuario, clienteCtx = null, canal = null, negocioId = null, onFrase, signal = null) {
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);

  // Enriquecer contexto con memoria del cliente
  const telefono = clienteCtx?.telefono;
  let memoriaCtx = '';
  if (telefono && telefono !== '—' && typeof negocioId === 'string' && negocioId.trim()) {
    const perfil = await obtenerPerfilCliente(telefono, negocioId);
    memoriaCtx = construirContextoCliente(perfil);
  }

  let textoCompleto = '';
  let buffer        = '';
  let bloqueado     = false;

  const stream = getAnthropic().messages.stream({
    model: MODELO,
    max_tokens: 1024,
    system: await construirSystemPrompt(clienteCtx, canal, negocioId) + memoriaCtx,
    messages: session.mensajes
  }, { signal });

  try {
    for await (const event of stream) {
      // Turno cancelado — salir inmediatamente sin procesar más tokens
      if (signal?.aborted) break;

      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;

      const token = event.delta.text;
      textoCompleto += token;

      if (bloqueado) continue;

      // Detectar inicio de bloque especial — flush buffer y bloquear
      if (textoCompleto.includes('<ORDEN_CONFIRMADA>') ||
          textoCompleto.includes('<ESCALAR_A_HUMANO>') ||
          textoCompleto.includes('<ENVIAR_MENU>') ||
          textoCompleto.includes('<SOLICITAR_FACTURA>') ||
          textoCompleto.includes('<CONSULTA_PENDIENTE')) {
        bloqueado = true;
        if (buffer.trim()) { onFrase(buffer.trim()); buffer = ''; }
        continue;
      }

      // Si el token contiene '<' o '{', dejar de acumular para TTS
      if (token.includes('<') || token.includes('{')) {
        bloqueado = true;
        const antes = buffer.split(/[<{]/)[0];
        if (antes.trim()) onFrase(antes.trim());
        buffer = '';
        continue;
      }

      buffer += token;

      // Enviar frases completas al llegar a límite de oración
      const match = buffer.match(/^(.*?[.!?,])\s+/s);
      if (match) {
        const frase = match[1].trim();
        if (frase) onFrase(frase);
        buffer = buffer.slice(match[0].length);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) {
      console.log('[brain] Stream abortado — turno cancelado');
      return null;
    }
    throw e;
  }

  // Si fue abortado en el loop (break), no guardar respuesta parcial
  if (signal?.aborted) {
    console.log('[brain] Stream abortado (mid-loop) — descartando respuesta parcial');
    return null;
  }

  // Flush del buffer restante
  if (buffer.trim() && !bloqueado) onFrase(buffer.trim());

  agregarMensaje(sessionId, 'assistant', textoCompleto);

  return {
    texto: limpiarTexto(textoCompleto),
    orden: extraerOrden(textoCompleto),
    factura: extraerFactura(textoCompleto),
    escalar: textoCompleto.includes('<ESCALAR_A_HUMANO>'),
    enviarMenu: textoCompleto.includes('<ENVIAR_MENU>'),
    sessionId
  };
}

// ─── Detección de intents + oportunidades ────────────────────────────────────

/**
 * Detecta señales comerciales en el mensaje del usuario y la respuesta del bot.
 * Retorna array de EVENTOS detectados para registrar.
 */
function detectarIntents(mensajeUsuario, textoRespuesta) {
  const intents = [];
  const msg = mensajeUsuario.toLowerCase();

  if (/men[uú]|carta|qu[eé] (tienen|hay|venden|ofrecen)/i.test(msg))
    intents.push(EVENTOS.MENU_SOLICITADO);

  if (/cu[aá]nto|precio|costo|valor|\$[0-9]/i.test(msg))
    intents.push(EVENTOS.PRECIO_CONSULTADO);

  if (/quiero|me das|me pones|me mandas|me llevas|pedir|ordenar|hacer un pedido/i.test(msg))
    intents.push(EVENTOS.PEDIDO_INICIADO);

  if (textoRespuesta.includes('<ORDEN_CONFIRMADA>'))
    intents.push(EVENTOS.PEDIDO_CONFIRMADO);

  return intents;
}

/**
 * Registrar intents detectados y actualizar oportunidad en background.
 * Nunca lanza excepción.
 */
async function registrarIntents(telefono, sessionId, canal, mensajeUsuario, textoRespuesta, orden) {
  if (!telefono) return;
  const intents = detectarIntents(mensajeUsuario, textoRespuesta);

  for (const tipo of intents) {
    registrarEvento({ tipo, entidad_tipo: 'cliente', entidad_id: telefono, canal, sesion_id: sessionId });
  }

  if (intents.length > 0) {
    const intent = intents[intents.length - 1]; // el más relevante
    const esCierre = intents.includes(EVENTOS.PEDIDO_CONFIRMADO);
    await actualizarOportunidad(telefono, sessionId, {
      estado: esCierre ? 'cerrada_con_venta' : 'activa',
      intent,
      valor_estimado: orden?.total || null,
      folio_pedido: orden?.folio || null
    });
  }
}

// Mensajes de cara al cliente controlados por CÓDIGO, nunca por el modelo
// (ver prompts.js -- el modelo tiene prohibido afirmar esto por su
// cuenta). El de éxito es el texto exacto exigido por el encargo; el de
// error nunca promete un PDF ni miente sobre el estado, y dirige al
// cliente a esperar seguimiento humano en vez de reintentar él mismo.
const MENSAJE_BORRADOR_LISTO = 'Listo, ya preparé tu cotización y la envié a revisión. En cuanto sea aprobada, recibirás el PDF aquí mismo.';
const MENSAJE_BORRADOR_ERROR = 'Tuvimos un problema para terminar de preparar tu cotización en este momento, pero ya guardamos la información que nos diste. En breve alguien de nuestro equipo la revisa contigo -- no hace falta que la repitas.';

/**
 * Fase 2-3 del Asistente Comercial: aplica los campos capturados en este
 * turno a la sesión (nunca pierde los de turnos anteriores -- ver
 * fusionarCamposCapturados) y, si el modelo emitió <BORRADOR_LISTO>,
 * intenta crear el borrador. generarBorradorDesdeSesion (Fase 3) es quien
 * valida "información suficiente" (incluida una fecha ya normalizada, ver
 * comercialMarkers.js/normalizarFecha.js) antes de escribir nada --
 * <BORRADOR_LISTO> es solo una señal, no una autorización.
 *
 * Devuelve `null` si no hubo intento de borrador este turno (conversación
 * sigue normal), o `{ ok, mensajeCliente, cotizacion? }` cuando SÍ hubo
 * intento -- `mensajeCliente` es el único texto autorizado a confirmar (o
 * desmentir) la creación del borrador, y brain.js lo agrega a la
 * respuesta SOLO después de que esta función ya terminó (nunca antes).
 *
 * Nunca lanza fuera de esta función: cualquier error real (fallo de DB,
 * catálogo, etc.) se captura aquí mismo y transiciona la sesión a
 * 'error_recuperable' (ver sesionComercial.js) en vez de dejarla atorada
 * en 'construyendo_borrador' sin salida.
 */
async function procesarCapturaComercial(sesionComercial, negocioId, textoRespuesta) {
  const capturas = extraerCamposComerciales(textoRespuesta);
  let camposActualizados = sesionComercial.campos_capturados;

  if (capturas.length > 0) {
    // Se persiste el objeto fusionado completo (no solo los campos nuevos
    // de este turno) -- fusionarCamposCapturados ya deriva fecha_evento_iso
    // a partir de fecha_evento, y ese campo derivado solo llega a la BD si
    // viaja dentro del objeto completo, nunca reconstruyendo un delta a
    // mano campo por campo (ese delta manual era exactamente el bug que
    // hacía que fecha_evento_iso nunca se guardara).
    const fusionados = fusionarCamposCapturados(sesionComercial.campos_capturados, capturas);
    await actualizarCamposSesion(sesionComercial.id, negocioId, fusionados);
    camposActualizados = fusionados;
  }

  if (!tieneBorradorListo(textoRespuesta)) return null; // sin intento de borrador este turno

  try {
    const resultado = await generarBorradorDesdeSesion(sesionComercial.id, negocioId, camposActualizados);
    if (!resultado) {
      // Información aún insuficiente (p.ej. la fecha no se pudo
      // interpretar con confianza) -- NO es un error: la conversación
      // sigue con naturalidad, el modelo verá en el siguiente turno que
      // ese campo sigue faltando (camposParaPrompt) y volverá a
      // preguntarlo. Ningún mensaje de "listo" ni de error aquí.
      return null;
    }

    // Solo se notifica (panel + admin) cuando el borrador es NUEVO -- si
    // ya existía (llamada idempotente de un reintento, ver
    // draftBuilder.js) no se repite en cada turno subsecuente.
    if (!resultado.yaExistia) {
      broadcastNegocio(negocioId, { tipo: 'cotizacion_borrador_ia', cotizacion: resultado });
      // El PDF/aviso al administrador SÍ se espera aquí (a diferencia de
      // antes) para que el orden "crear -> avisar admin -> confirmar al
      // cliente" sea real y no solo aparente -- pero que Meta/WhatsApp
      // fallen en avisarle al admin NUNCA hace que le neguemos al cliente
      // la confirmación: el borrador ya existe de verdad en la base y
      // siempre es revisable/aprobable desde el panel aunque esta
      // notificación puntual no llegue.
      const notif = await notificarBorradorAlAdmin({ cotizacion: resultado, negocioId, camposCapturados: camposActualizados })
        .catch((e) => ({ ok: false, motivo: e.message }));
      if (!notif?.ok) {
        console.warn(`[brain] Borrador ${resultado.folio} creado OK pero no se pudo confirmar el aviso al admin (motivo=${notif?.motivo || 'desconocido'}) -- sigue siendo revisable desde el panel.`);
      }
    }

    return { ok: true, cotizacion: resultado, mensajeCliente: MENSAJE_BORRADOR_LISTO };
  } catch (e) {
    await marcarSesionComoErrorRecuperable(sesionComercial.id, negocioId, e)
      .catch((err) => console.error('[brain] Error marcando sesión como error_recuperable:', err.message));
    console.error(`[brain] Error creando borrador para sesión ${sesionComercial.id}:`, e.message);
    return { ok: false, motivo: e.message, mensajeCliente: MENSAJE_BORRADOR_ERROR };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extraerOrden(texto) {
  const match = texto.match(/<ORDEN_CONFIRMADA>([\s\S]*?)<\/ORDEN_CONFIRMADA>/);
  if (!match) return null;
  try {
    const orden = JSON.parse(match[1].trim());
    console.log(`[brain] Orden extraída OK — total: $${orden.total} | programado_para: ${orden.programado_para || 'inmediato'}`);
    return orden;
  } catch (e) {
    // Error crítico: el bloque JSON existe pero no es parseable.
    // Loguear el contenido completo para diagnóstico.
    console.error('[brain] ⚠️ ORDEN_CONFIRMADA presente pero JSON inválido:', e.message);
    console.error('[brain] Contenido del bloque:', match[1].trim().slice(0, 500));
    return null;
  }
}

function extraerFactura(texto) {
  const match = texto.match(/<SOLICITAR_FACTURA>([\s\S]*?)<\/SOLICITAR_FACTURA>/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

function limpiarTexto(texto) {
  const sinTags = texto
    .replace(/<ORDEN_CONFIRMADA>[\s\S]*?<\/ORDEN_CONFIRMADA>/g, '')
    .replace(/<SOLICITAR_FACTURA>[\s\S]*?<\/SOLICITAR_FACTURA>/g, '')
    .replace(/<ESCALAR_A_HUMANO>/g, '')
    .replace(/<CONSULTA_PENDIENTE:[^>]*>/g, '')
    .replace(/<ENVIAR_MENU>/g, '')
    .trim();
  // Última capa antes de guardar/enviar: WhatsApp no entiende Markdown.
  // Convierte **negrita**→*negrita* y des-escapa \* para que el cliente y el
  // panel no vean los símbolos literales. Ver src/utils/formatoWhatsapp.js.
  return normalizarFormatoWhatsApp(sinTags);
}
