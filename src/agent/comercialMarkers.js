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

/** Quita todos los marcadores del modo comercial del texto visible al cliente. */
export function limpiarBloqueComercial(texto) {
  if (typeof texto !== 'string') return texto;
  return texto
    .replace(/<CAMPO_COMERCIAL_CAPTURADO>[\s\S]*?<\/CAMPO_COMERCIAL_CAPTURADO>/g, '')
    .replace(/<BORRADOR_LISTO>/g, '')
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
export function camposParaPrompt(camposCapturados = {}) {
  const vista = { ...camposCapturados };
  delete vista.fecha_evento_iso;
  if (camposCapturados.fecha_evento_iso) {
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
export function camposObligatoriosCompletos(camposCapturados = {}) {
  return !!(
    camposCapturados.nombre &&
    camposCapturados.fecha_evento_iso &&
    Array.isArray(camposCapturados.items) && camposCapturados.items.length > 0
  );
}

/** Campos secundarios (nunca bloqueantes) que faltan -- para marcar "pendiente de revisión" en el panel. */
export function camposSecundariosFaltantes(camposCapturados = {}) {
  const secundarios = ['numero_personas', 'lugar', 'presupuesto'];
  return secundarios.filter((campo) => !camposCapturados[campo]);
}
