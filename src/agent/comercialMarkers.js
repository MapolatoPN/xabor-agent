/**
 * comercialMarkers.js — Parsing puro de los marcadores del Modo Asistente
 * Comercial (ver prompts.js construirBloqueModoComercial). Sin
 * dependencias de server.js/database.js a propósito -- se puede probar de
 * forma totalmente aislada, sin servidor ni base de datos, igual que
 * extraerOrden/extraerFactura/limpiarTexto en brain.js (que si viven en
 * brain.js porque ese archivo ya tiene el resto de esa lógica).
 *
 * Ningún marcador de este módulo tiene permiso de escritura directa a
 * cotizaciones.estado='enviada' -- esa transición SIEMPRE pasa por
 * POST /api/cotizaciones/:id/enviar (requireAdminSeguro, Fase 5), nunca
 * por código disparado desde aquí.
 */

import { normalizarFechaEvento } from './normalizarFecha.js';

const CAMPOS_VALIDOS = ['nombre', 'fecha_evento', 'lugar', 'numero_personas', 'presupuesto', 'observaciones', 'item_solicitado'];

/**
 * Extrae TODAS las ocurrencias de <CAMPO_COMERCIAL_CAPTURADO>{...}</...>
 * en el texto (el modelo puede emitir varias en un mismo turno). Marcadores
 * mal formados (JSON inválido, campo fuera de CAMPOS_VALIDOS) se ignoran
 * individualmente sin descartar los demás.
 */
export function extraerCamposComerciales(texto) {
  if (typeof texto !== 'string') return [];
  const resultados = [];
  const regex = /<CAMPO_COMERCIAL_CAPTURADO>([\s\S]*?)<\/CAMPO_COMERCIAL_CAPTURADO>/g;
  let match;
  while ((match = regex.exec(texto)) !== null) {
    try {
      const obj = JSON.parse(match[1].trim());
      if (obj && typeof obj.campo === 'string' && CAMPOS_VALIDOS.includes(obj.campo) && obj.valor !== undefined) {
        resultados.push({ campo: obj.campo, valor: obj.valor });
      } else {
        console.error('[comercialMarkers] CAMPO_COMERCIAL_CAPTURADO con campo inválido, ignorado:', match[1].trim().slice(0, 200));
      }
    } catch (e) {
      console.error('[comercialMarkers] CAMPO_COMERCIAL_CAPTURADO con JSON inválido, ignorado:', e.message);
    }
  }
  return resultados;
}

export function tieneBorradorListo(texto) {
  return typeof texto === 'string' && texto.includes('<BORRADOR_LISTO>');
}

export function tieneCateringListo(texto) {
  return typeof texto === 'string' && texto.includes('<CATERING_DATOS_LISTOS>');
}

/** Quita todos los marcadores del modo comercial del texto visible al cliente. */
export function limpiarBloqueComercial(texto) {
  if (typeof texto !== 'string') return texto;
  return texto
    .replace(/<CAMPO_COMERCIAL_CAPTURADO>[\s\S]*?<\/CAMPO_COMERCIAL_CAPTURADO>/g, '')
    .replace(/<BORRADOR_LISTO>/g, '')
    .replace(/<CATERING_DATOS_LISTOS>/g, '')
    .replace(/<OBJECION_DETECTADA>[\s\S]*?<\/OBJECION_DETECTADA>/g, '')
    .trim();
}

/**
 * Fusiona una lista de {campo, valor} (ver extraerCamposComerciales) sobre
 * un objeto campos_capturados existente. `item_solicitado` es especial:
 * se ACUMULA en un array `items` en vez de sobreescribir -- cada mención
 * de un producto/servicio distinto se agrega, nunca reemplaza las
 * anteriores.
 *
 * `fecha_evento` es especial también: el texto original SIEMPRE se
 * conserva tal cual (para auditoría/mostrarlo en el panel), pero nunca se
 * confía en él para escribir en una columna DATE -- se valida aquí mismo
 * con normalizarFechaEvento() y, solo si resulta inequívoco, se agrega
 * `fecha_evento_iso` (el único campo que draftBuilder.js tiene permitido
 * usar para la fecha real de la cotización). Si el texto nuevo no se pudo
 * interpretar, se BORRA cualquier `fecha_evento_iso` previo -- una fecha
 * nueva ambigua invalida la anterior en vez de dejar una fecha vieja
 * "atada" a un texto que el cliente ya cambió.
 */
export function fusionarCamposCapturados(camposActuales = {}, capturas = [], opciones = {}) {
  const resultado = { ...camposActuales };
  const items = Array.isArray(resultado.items) ? [...resultado.items] : [];
  for (const { campo, valor } of capturas) {
    if (campo === 'item_solicitado') {
      if (valor && typeof valor === 'object' && typeof valor.descripcion === 'string') {
        items.push({ descripcion: valor.descripcion, cantidad: Number(valor.cantidad) || 1 });
      }
    } else if (campo === 'fecha_evento') {
      resultado.fecha_evento = valor;
      const texto = typeof valor === 'string' ? valor : String(valor ?? '');
      const normalizada = normalizarFechaEvento(texto, opciones);
      if (normalizada.ok) {
        resultado.fecha_evento_iso = normalizada.iso;
      } else {
        delete resultado.fecha_evento_iso;
      }
    } else {
      resultado[campo] = valor;
    }
  }
  if (items.length > 0) resultado.items = items;
  return resultado;
}

/**
 * Vista de campos_capturados construida específicamente para mostrarle al
 * modelo qué ya se sabe (ver prompts.js construirBloqueModoComercial).
 * `fecha_evento` solo aparece aquí cuando ya se validó de forma
 * determinista (fecha_evento_iso presente) -- si el cliente dio una fecha
 * que no se pudo interpretar con confianza, el campo se OMITE por
 * completo, para que el modelo la trate como "todavía no capturada" y
 * pregunte de nuevo con naturalidad, en vez de asumir que ya quedó
 * resuelta con un texto ambiguo.
 */
export function camposParaPrompt(camposCapturados = {}, opciones = {}) {
  const vista = { ...camposCapturados };
  // Las claves `__*` son metadatos de Xabor, no datos que el modelo deba
  // repetir, corregir ni mostrarle al cliente.
  for (const clave of Object.keys(vista)) {
    if (clave.startsWith('__')) delete vista[clave];
  }
  delete vista.fecha_evento_iso;
  if (opciones.perfil === 'catering') {
    // Aquí no se escribe una DATE ni se agenda nada: la expresión original
    // (p. ej. «el sábado 5 a las 2») es justamente lo que necesita la
    // persona que recibirá el lead. Ocultarla por no pasar el parser de
    // cotizaciones provocaba que el bot la preguntara en bucle.
    if (!String(camposCapturados.fecha_evento || '').trim()) delete vista.fecha_evento;
  } else if (camposCapturados.fecha_evento_iso) {
    vista.fecha_evento = camposCapturados.fecha_evento_iso;
  } else {
    delete vista.fecha_evento;
  }
  return vista;
}

/**
 * Criterio de "información suficiente" para pasar a construir el
 * borrador. Deliberadamente mínimo -- solo lo que un negocio como Alora
 * (florería/eventos) necesita para que un administrador pueda revisar
 * una propuesta con sentido: quién es, qué quiere, y cuándo. Todo lo
 * demás (número de personas, lugar, presupuesto) es información valiosa
 * pero secundaria -- se captura si la conversación fluye ahí de forma
 * natural, nunca bloquea la creación del borrador (ver
 * camposSecundariosFaltantes(), que el panel usa para marcar pendientes
 * en vez de exigirlos antes de avanzar).
 */
export function camposObligatoriosCompletos(camposCapturados = {}, opciones = {}) {
  if (opciones.perfil === 'catering') {
    return !!(
      camposCapturados.nombre &&
      fechaHoraCateringSuficiente(camposCapturados) &&
      camposCapturados.lugar &&
      Number.isFinite(Number(camposCapturados.numero_personas)) &&
      Number(camposCapturados.numero_personas) > 0
    );
  }
  return !!(
    camposCapturados.nombre &&
    camposCapturados.fecha_evento_iso &&
    Array.isArray(camposCapturados.items) && camposCapturados.items.length > 0
  );
}

/**
 * Catering no agenda ni convierte la fecha a una columna DATE. Solo exige que
 * el texto conservado para la persona tenga una referencia de fecha y otra de
 * hora; no intenta decidir qué instante quiso decir el cliente.
 */
export function fechaHoraCateringSuficiente(camposCapturados = {}) {
  const original = String(camposCapturados.fecha_evento || '').trim();
  if (!original) return false;
  const { tieneFecha, tieneHora } = partesFechaHoraCatering(camposCapturados);
  return tieneFecha && tieneHora;
}

/** Separa suficiencia de fecha y hora sin interpretar ni agendar el instante. */
export function partesFechaHoraCatering(camposCapturados = {}) {
  const original = String(camposCapturados.fecha_evento || '').trim();
  if (!original) return { tieneFecha: false, tieneHora: false };
  const t = original.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tieneFecha = /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(t)
    || /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(t)
    || /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(t)
    || /\b(?:hoy|manana|pasado\s+manana)\b/.test(t)
    || /\b(?:este|esta|proximo|proxima)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t)
    || /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t)
    || /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+\d{1,2}\b/.test(t);
  const tieneHora = /\b\d{1,2}:\d{2}\b/.test(t)
    || /\b(?:a\s+las?|desde\s+las?)\s+\d{1,2}(?::\d{2})?\b/.test(t)
    || /\b\d{1,2}(?::\d{2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/.test(t)
    || /\b(?:mediodia|medianoche)\b/.test(t)
    || /\b(?:por\s+la|en\s+la)\s+(?:manana|tarde|noche)\b/.test(t);
  return { tieneFecha, tieneHora };
}

/** Campos secundarios (nunca bloqueantes) que faltan -- para marcar "pendiente de revisión" en el panel. */
export function camposSecundariosFaltantes(camposCapturados = {}, opciones = {}) {
  if (opciones.perfil === 'catering') return [];
  const secundarios = ['numero_personas', 'lugar', 'presupuesto'];
  return secundarios.filter((campo) => !camposCapturados[campo]);
}
