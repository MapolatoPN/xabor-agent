import Anthropic from '@anthropic-ai/sdk';
import { construirSystemPrompt } from './prompts.js';
import { agregarMensaje, getSession } from './session.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Modelo: haiku es rápido y barato, ideal para conversaciones
const MODELO = 'claude-haiku-4-5-20251001';

// ─── Versión normal (WhatsApp, Rappi, panel) ─────────────────────────────────
export async function procesarMensaje(sessionId, mensajeUsuario, clienteCtx = null, canal = null) {
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);

  try {
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: await construirSystemPrompt(clienteCtx, canal),
      messages: session.mensajes
    });

    const textoRespuesta = respuesta.content[0].text;
    agregarMensaje(sessionId, 'assistant', textoRespuesta);

    return {
      texto: limpiarTexto(textoRespuesta),
      orden: extraerOrden(textoRespuesta),
      escalar: textoRespuesta.includes('<ESCALAR_A_HUMANO>'),
      enviarMenu: textoRespuesta.includes('<ENVIAR_MENU>'),
      sessionId
    };

  } catch (error) {
    console.error('[brain] Error al llamar a Claude:', error.message);
    throw error;
  }
}

// ─── Versión streaming (voz) ──────────────────────────────────────────────────
// onFrase(texto, esUltima) se llama por cada oración completa mientras Claude genera.
// Retorna el mismo objeto que procesarMensaje una vez que el stream termina.
export async function procesarMensajeStream(sessionId, mensajeUsuario, clienteCtx = null, canal = null, onFrase) {
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);

  let textoCompleto = '';
  let buffer        = '';
  let bloqueado     = false; // true cuando entramos en <ORDEN_CONFIRMADA> u otro marcador

  const stream = anthropic.messages.stream({
    model: MODELO,
    max_tokens: 1024,
    system: await construirSystemPrompt(clienteCtx, canal),
    messages: session.mensajes
  });

  for await (const event of stream) {
    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;

    const token = event.delta.text;
    textoCompleto += token;

    if (bloqueado) continue;

    // Detectar inicio de bloque especial — flush buffer y bloquear
    if (textoCompleto.includes('<ORDEN_CONFIRMADA>') ||
        textoCompleto.includes('<ESCALAR_A_HUMANO>') ||
        textoCompleto.includes('<ENVIAR_MENU>') ||
        textoCompleto.includes('<CONSULTA_PENDIENTE')) {
      bloqueado = true;
      if (buffer.trim()) {
        onFrase(buffer.trim(), false);
        buffer = '';
      }
      continue;
    }

    // Si el token contiene '<' o '{' (inicio de JSON), dejar de acumular para TTS
    if (token.includes('<') || token.includes('{')) {
      bloqueado = true;
      // Flush solo del texto antes del marcador
      const antes = buffer.split(/[<{]/)[0];
      if (antes.trim()) onFrase(antes.trim(), false);
      buffer = '';
      continue;
    }

    buffer += token;

    // Enviar frases completas al llegar a límite de oración
    const match = buffer.match(/^(.*?[.!?,])\s+/s);
    if (match) {
      const frase = match[1].trim();
      if (frase) onFrase(frase, false);
      buffer = buffer.slice(match[0].length);
    }
  }

  // Flush del buffer restante
  if (buffer.trim() && !bloqueado) {
    onFrase(buffer.trim(), false);
  }

  agregarMensaje(sessionId, 'assistant', textoCompleto);

  return {
    texto: limpiarTexto(textoCompleto),
    orden: extraerOrden(textoCompleto),
    escalar: textoCompleto.includes('<ESCALAR_A_HUMANO>'),
    enviarMenu: textoCompleto.includes('<ENVIAR_MENU>'),
    sessionId
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extraerOrden(texto) {
  const match = texto.match(/<ORDEN_CONFIRMADA>([\s\S]*?)<\/ORDEN_CONFIRMADA>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (e) {
    console.error('[brain] Error al parsear orden:', e.message);
    return null;
  }
}

function limpiarTexto(texto) {
  return texto
    .replace(/<ORDEN_CONFIRMADA>[\s\S]*?<\/ORDEN_CONFIRMADA>/g, '')
    .replace(/<ESCALAR_A_HUMANO>/g, '')
    .replace(/<CONSULTA_PENDIENTE:[^>]*>/g, '')
    .replace(/<ENVIAR_MENU>/g, '')
    .trim();
}
