import Anthropic from '@anthropic-ai/sdk';
import { construirSystemPrompt } from './prompts.js';
import { agregarMensaje, getSession } from './session.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Modelo: haiku es rápido y barato, ideal para conversaciones
const MODELO = 'claude-haiku-4-5-20251001';

export async function procesarMensaje(sessionId, mensajeUsuario, clienteCtx = null) {
  // Registrar mensaje del usuario en la sesión
  agregarMensaje(sessionId, 'user', mensajeUsuario);

  const session = getSession(sessionId);

  try {
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: await construirSystemPrompt(clienteCtx),
      messages: session.mensajes
    });

    const textoRespuesta = respuesta.content[0].text;

    // Registrar respuesta del asistente
    agregarMensaje(sessionId, 'assistant', textoRespuesta);

    // Detectar si hay una orden confirmada en la respuesta
    const orden = extraerOrden(textoRespuesta);

    // Detectar si el agente está escalando a humano
    const escalar = textoRespuesta.includes('<ESCALAR_A_HUMANO>');

    return {
      texto: limpiarTexto(textoRespuesta),
      orden: orden,
      escalar: escalar,
      sessionId
    };

  } catch (error) {
    console.error('[brain] Error al llamar a Claude:', error.message);
    throw error;
  }
}

// Extrae el JSON de orden si está presente en la respuesta
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

// Elimina el bloque JSON y marcadores de la respuesta visible al cliente
function limpiarTexto(texto) {
  return texto
    .replace(/<ORDEN_CONFIRMADA>[\s\S]*?<\/ORDEN_CONFIRMADA>/g, '')
    .replace(/<ESCALAR_A_HUMANO>/g, '')
    .replace(/<CONSULTA_PENDIENTE:[^>]*>/g, '')
    .replace(/<ENVIAR_MENU>/g, '')
    .trim();
}
