import { tieneEfecto } from './contratoDeHerramientas.js';

const normalizar = (valor) => String(valor ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * El agente de herramientas todavía no guarda `programado_para`. Una petición
 * para otro día debe llegar a una persona antes de que el modelo pueda prometer
 * una hora que no quedó en ningún pedido.
 */
export function esSolicitudDePedidoProgramado(texto, { hayPedidoEnCurso = false } = {}) {
  const t = normalizar(texto);
  const futuro = /\b(?:manana|pasado manana|proxim[oa]s?\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana))\b/.test(t)
    || /\b(?:para|el)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t)
    || /\bpara\s+(?:el\s+)?\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(t);
  const pedido = /\b(?:pedir|pedido|orden|ordenar|prepar|enviar|entreg|recog|apartar|reserv|quisiera|quiero|seria para)\w*\b/.test(t);
  const continuacionTemporal = /\b(?:para\s+(?:manana|pasado manana|el\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))|manana\s+a\s+las)\b/.test(t)
    || /\bpara\s+(?:el\s+)?\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(t);
  return futuro && (pedido || (hayPedidoEnCurso && continuacionTemporal));
}

/** Frases afirmativas que aseguran que Xabor cambió o guardó algo. */
export function textoAfirmaCambioGuardado(texto) {
  const t = normalizar(texto);
  const verbo = '(?:anote|anoto|anotamos|apunte|apunto|apuntamos|agregue|agrego|agregamos|anadi|anado|anadimos|registre|registro|registramos|programe|programo|programamos|guarde|guardo|guardamos)';
  const participio = '(?:anotad[oa]s?|apuntad[oa]s?|agregad[oa]s?|anadid[oa]s?|registrad[oa]s?|programad[oa]s?|guardad[oa]s?)';
  const patrones = [
    new RegExp(`\\b(?:ya\\s+)?(?:te\\s+)?(?:lo\\s+|la\\s+|los\\s+|las\\s+)?${verbo}\\b`, 'g'),
    // «El pedido quedó registrado» también puede ser una consulta legítima
    // sobre un pedido previo. Aquí solo se persiguen afirmaciones de una
    // acción del turno: primera persona, «va anotado» o «listo/perfecto».
    new RegExp(`\\b(?:va|deje)\\s+(?:ya\\s+)?${participio}\\b`, 'g'),
    new RegExp(`\\b(?:listo|perfecto|hecho)\\b[^.!?\\n]{0,60}\\b${participio}\\b`, 'g'),
  ];
  for (const patron of patrones) {
    for (const coincidencia of t.matchAll(patron)) {
      const antes = t.slice(Math.max(0, coincidencia.index - 16), coincidencia.index);
      if (!/\bno(?:\s+\w+){0,2}\s*$/.test(antes)) return true;
    }
  }
  return false;
}

/**
 * Detecta la divergencia más peligrosa de un turno: texto que dice «anotado»
 * aunque ninguna herramienta de efecto haya quedado aplicada.
 */
export function respuestaAfirmaCambioSinAplicar(salida) {
  if (!textoAfirmaCambioGuardado(salida?.texto)) return false;
  return !(salida?.operaciones || []).some((op) =>
    tieneEfecto(op?.herramienta)
      && op?.herramienta !== 'pedir_humano'
      && op?.resultado?.aplicado === true);
}

export const TEXTO_PEDIDO_PROGRAMADO =
  'Para programar tu pedido para otro día necesito pasarte con alguien del equipo. '
  + 'Así confirmamos la fecha y la hora sin registrar algo incorrecto.';

export const TEXTO_CAMBIO_NO_GUARDADO =
  'Permíteme revisar este pedido con el equipo antes de confirmarte un cambio que no haya quedado guardado.';
