/**
 * intentDetector.js — Fase 1 del Asistente Comercial de Cotizaciones por
 * WhatsApp. Clasifica un mensaje entrante en una de 5 categorías con una
 * llamada barata a Claude Haiku (mismo modelo que brain.js), ANTES de la
 * llamada principal de generación de respuesta.
 *
 * Reglas de decisión aplicadas en código, nunca delegadas al modelo (ver
 * docs/asistente-comercial-detalle-tecnico.md §2 en el repo de
 * consolidación):
 *   - 'ambiguo' NUNCA activa el modo comercial -- se trata como
 *     pedido_normal. Ante duda, no activar.
 *   - 'solicitud_comercial'/'continuacion_comercial' solo activan el modo
 *     si el negocio tiene el módulo dedicado 'asistente_comercial_cotizaciones'
 *     habilitado (migración 028, separado de 'generador_cotizaciones' --
 *     ese solo gatea el generador manual del panel) -- nunca se activa un
 *     flujo comercial para un negocio que no lo contrató. Esta condición
 *     se evalúa ANTES de llamar al modelo (si el módulo no está
 *     habilitado, ni siquiera vale la pena clasificar).
 *   - Cualquier error de la llamada al modelo -> 'ambiguo' (fail-closed:
 *     ante un fallo, nunca activar el modo comercial).
 */
import Anthropic from '@anthropic-ai/sdk';

// Deliberadamente NO importa de '../server.js' (a diferencia de brain.js) --
// ese módulo ejecuta efectos secundarios de arranque completo al ser
// importado (setInterval de jobs en background, listeners, etc.), lo que
// vuelve intentDetector.js imposible de probar de forma aislada. En
// producción, brain.js (que sí importa server.js) le pasa `apiKey` ya
// resuelta (incluye el override de superadmin vía getIntegracion) a
// detectarIntencionComercial -- aquí solo se usa process.env como último
// fallback.
let _anthropic = null;
function getAnthropic(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!_anthropic || _anthropic.apiKey !== key) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

const MODELO = 'claude-haiku-4-5-20251001';

export const CATEGORIAS_INTENCION = [
  'pedido_normal',
  'consulta_general',
  'solicitud_comercial',
  'continuacion_comercial',
  'ambiguo',
];

function construirPromptClasificacion(moduloHabilitado, estadoComercialActual) {
  return `Clasifica el siguiente mensaje de un cliente de WhatsApp en una de estas categorías. Responde ÚNICAMENTE con la categoría, en minúsculas, sin explicación ni puntuación.

- pedido_normal: quiere ordenar comida/servicio del catálogo estándar
- consulta_general: pregunta sobre horarios, ubicación, menú, sin intención de compra inmediata
- solicitud_comercial: pide una cotización, menciona un evento, una cantidad de personas, una fecha específica, o dice explícitamente "cotización"/"presupuesto"
- continuacion_comercial: está respondiendo dentro de una conversación comercial ya en curso
- ambiguo: no se puede determinar con confianza

[CONTEXTO]
Módulo asistente_comercial_cotizaciones habilitado: ${moduloHabilitado ? 'si' : 'no'}
Estado comercial actual de esta conversación: ${estadoComercialActual || 'ninguno'}`;
}

/**
 * Devuelve una de CATEGORIAS_INTENCION. `moduloHabilitado` debe resolverse
 * por el llamador (brain.js) vía obtenerEstadoModulo -- este módulo no
 * toca la base de datos.
 */
export async function detectarIntencionComercial({ mensaje, moduloHabilitado, estadoComercialActual = null, apiKey = null }) {
  if (!moduloHabilitado) return 'pedido_normal';
  if (typeof mensaje !== 'string' || !mensaje.trim()) return 'ambiguo';

  try {
    const respuesta = await getAnthropic(apiKey).messages.create({
      model: MODELO,
      max_tokens: 20,
      system: construirPromptClasificacion(moduloHabilitado, estadoComercialActual),
      messages: [{ role: 'user', content: mensaje }],
    });
    const categoria = (respuesta.content[0]?.text || '').trim().toLowerCase();
    return CATEGORIAS_INTENCION.includes(categoria) ? categoria : 'ambiguo';
  } catch (e) {
    console.error('[intentDetector] Error clasificando intención (fail-closed -> ambiguo):', e.message);
    return 'ambiguo';
  }
}

/** 'ambiguo' y 'pedido_normal'/'consulta_general' nunca activan el modo. */
export function activaModoComercial(categoria) {
  return categoria === 'solicitud_comercial' || categoria === 'continuacion_comercial';
}
