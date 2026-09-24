import { marcadorSinCerrar } from './marcadoresTruncados.js';

const STOP_REASONS_TRUNCADOS = new Set([
  'max_tokens',
  'model_context_window_exceeded',
]);

/**
 * Decide si una respuesta del modelo quedo incompleta antes de que cualquier
 * texto, herramienta o marcador pueda producir efectos.
 *
 * El `stop_reason` del proveedor es la autoridad. Tanto el límite de salida
 * (`max_tokens`) como el límite de contexto de la petición dejan una respuesta
 * incompleta. El marcador abierto es la defensa adicional para respuestas
 * históricas, dobles/stubs y caminos donde solo viaja el texto.
 */
export function diagnosticarRespuestaTruncada(respuesta, texto = '') {
  const stopReason = respuesta?.stop_reason;
  if (STOP_REASONS_TRUNCADOS.has(stopReason)) {
    return { truncada: true, motivo: stopReason, marcador: marcadorSinCerrar(texto) };
  }

  const marcador = marcadorSinCerrar(texto);
  if (marcador) return { truncada: true, motivo: 'marcador_sin_cerrar', marcador };

  return { truncada: false, motivo: null, marcador: null };
}

export const esRespuestaTruncada = (respuesta, texto = '') =>
  diagnosticarRespuestaTruncada(respuesta, texto).truncada;

export class RespuestaModeloTruncadaError extends Error {
  constructor(diagnostico) {
    super(`RESPUESTA_MODELO_TRUNCADA: ${diagnostico?.motivo || 'desconocido'}`);
    this.name = 'RespuestaModeloTruncadaError';
    this.codigo = 'RESPUESTA_MODELO_TRUNCADA';
    this.diagnostico = diagnostico || { truncada: true, motivo: 'desconocido', marcador: null };
  }
}

/** Falla cerrado para extractores internos que no pueden devolver un turno. */
export function exigirRespuestaCompleta(respuesta, texto = '') {
  const diagnostico = diagnosticarRespuestaTruncada(respuesta, texto);
  if (diagnostico.truncada) throw new RespuestaModeloTruncadaError(diagnostico);
  return diagnostico;
}

/**
 * Extrae el primer bloque textual solo después de validar la metadata del
 * proveedor. Centraliza el orden importante: diagnosticar -> luego parsear,
 * guardar o ejecutar efectos.
 */
export function textoCompletoDeRespuesta(respuesta) {
  const texto = respuesta?.content?.[0]?.text || '';
  exigirRespuestaCompleta(respuesta, texto);
  return texto;
}

/**
 * Consume un stream sin publicar un solo token hasta conocer su `stop_reason`.
 * La voz pierde la latencia de streaming a propósito: es la única manera de
 * garantizar que una respuesta truncada no alcance TTS antes de detectarla.
 *
 * Devuelve `null` si la señal fue abortada. `onTextoSeguro` solo se invoca
 * después de `finalMessage()` y de la validación fail-close.
 */
export async function consumirStreamCompleto(stream, { signal = null, onTextoSeguro = null } = {}) {
  let texto = '';
  for await (const event of stream) {
    if (signal?.aborted) return null;
    if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
      texto += event.delta.text || '';
    }
  }
  if (signal?.aborted) return null;

  const respuesta = await stream.finalMessage();
  exigirRespuestaCompleta(respuesta, texto);
  if (typeof onTextoSeguro === 'function') await onTextoSeguro(texto);
  return { texto, respuesta };
}
