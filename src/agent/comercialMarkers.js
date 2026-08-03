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
 */
export function fusionarCamposCapturados(camposActuales = {}, capturas = []) {
  const resultado = { ...camposActuales };
  const items = Array.isArray(resultado.items) ? [...resultado.items] : [];
  for (const { campo, valor } of capturas) {
    if (campo === 'item_solicitado') {
      if (valor && typeof valor === 'object' && typeof valor.descripcion === 'string') {
        items.push({ descripcion: valor.descripcion, cantidad: Number(valor.cantidad) || 1 });
      }
    } else {
      resultado[campo] = valor;
    }
  }
  if (items.length > 0) resultado.items = items;
  return resultado;
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
    camposCapturados.fecha_evento &&
    Array.isArray(camposCapturados.items) && camposCapturados.items.length > 0
  );
}

/** Campos secundarios (nunca bloqueantes) que faltan -- para marcar "pendiente de revisión" en el panel. */
export function camposSecundariosFaltantes(camposCapturados = {}) {
  const secundarios = ['numero_personas', 'lugar', 'presupuesto'];
  return secundarios.filter((campo) => !camposCapturados[campo]);
}
