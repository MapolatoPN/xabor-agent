// La configuración del negocio decide cómo puede recibir su pedido el cliente.
// Este módulo traduce expresiones comunes a tipos estables y evita que el
// modelo agregue al carrito una modalidad que el negocio no ofrece.

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/_/g, ' ').replace(/[^a-z0-9ñ ]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const ALIAS = Object.freeze({
  recoger: /\b(recoger|recojo|recoleccion|pickup|paso por|yo paso|para llevar|me lo llevo)\b/,
  domicilio: /\b(domicilio|entrega|envio|delivery|me lo mandan|mandamelo|mandenlo)\b/,
  consumo_sitio: /\b(comer aqui|consumo en sitio|en el local|en el restaurante|en sucursal|para aca|mesa)\b/,
});

const ETIQUETAS = Object.freeze({
  recoger: 'recoger',
  domicilio: 'domicilio',
  consumo_sitio: 'comer aquí',
});

export function normalizarTipoModalidad(valor) {
  const texto = norm(valor);
  if (!texto) return null;
  for (const [tipo, patron] of Object.entries(ALIAS)) {
    if (patron.test(texto)) return tipo;
  }
  return null;
}

export const etiquetaTipoModalidad = (tipo) => ETIQUETAS[tipo]
  || String(tipo || '').replace(/^personalizada:/, '').replace(/_/g, ' ');

/**
 * Conserva el texto exacto configurado, pero lo acompaña de un tipo estable.
 * Una modalidad personalizada también funciona si el cliente la nombra tal
 * cual; las tres modalidades conocidas admiten sus expresiones habituales.
 */
export function modalidadesDisponibles(modalidades) {
  if (!Array.isArray(modalidades)) return null;
  const vistas = [];
  const vistos = new Set();
  for (const crudo of modalidades) {
    const valor = String(crudo || '').trim();
    const limpio = norm(valor);
    if (!limpio) continue;
    const tipo = normalizarTipoModalidad(valor) || `personalizada:${limpio}`;
    if (vistos.has(tipo)) continue;
    vistos.add(tipo);
    vistas.push({ tipo, valor });
  }
  return vistas;
}

function tipoSolicitado(modalidad, disponibles) {
  const conocido = normalizarTipoModalidad(modalidad);
  if (conocido) return conocido;
  const limpio = norm(modalidad);
  return disponibles?.find((m) => norm(m.valor) === limpio)?.tipo || null;
}

function tieneEvidencia(tipo, mensaje, configurada) {
  const texto = norm(mensaje);
  if (!texto) return false;
  if (ALIAS[tipo]?.test(texto)) return true;
  const literal = norm(configurada);
  return !!literal && (` ${texto} `).includes(` ${literal} `);
}

/**
 * `modalidades === null` mantiene compatibles los llamadores puros antiguos.
 * Producción siempre entrega la lista de reglas_atencion del negocio.
 */
export function evaluarModalidad({
  modalidad, modalidades = null, mensaje = '', exigirEvidencia = true,
} = {}) {
  const disponibles = modalidadesDisponibles(modalidades);
  const tipo = tipoSolicitado(modalidad, disponibles);
  const etiquetas = (disponibles || []).map((m) => etiquetaTipoModalidad(m.tipo));

  if (!tipo) {
    return {
      ok: false, codigo: 'modalidad_no_reconocida', tipo: null,
      motivo: `No reconozco esa forma de entrega. Disponibles: ${etiquetas.join(', ') || 'ninguna'}.`,
      disponibles: disponibles || [],
    };
  }

  const configurada = disponibles?.find((m) => m.tipo === tipo) || null;
  if (disponibles && !configurada) {
    return {
      ok: false, codigo: 'modalidad_no_disponible', tipo,
      motivo: `El negocio no ofrece ${etiquetaTipoModalidad(tipo)}. Disponibles: ${etiquetas.join(', ') || 'ninguna'}.`,
      disponibles,
    };
  }

  if (disponibles && exigirEvidencia && !tieneEvidencia(tipo, mensaje, configurada?.valor || modalidad)) {
    return {
      ok: false, codigo: 'modalidad_sin_respaldo', tipo,
      motivo: `El cliente no eligió ${etiquetaTipoModalidad(tipo)} en este mensaje.`,
      disponibles,
    };
  }

  return {
    ok: true, tipo, valor: configurada?.valor || String(modalidad || '').trim(),
    disponibles: disponibles || null,
  };
}

/** Quita o canoniza una modalidad guardada antes de leer la configuración actual. */
export function depurarModalidadNoDisponible(estado, modalidades) {
  const datos = estado?.carrito?.datos;
  if (!datos?.modalidad || !Array.isArray(modalidades)) return null;
  const evaluacion = evaluarModalidad({
    modalidad: datos.modalidad, modalidades, exigirEvidencia: false,
  });
  if (evaluacion.ok) {
    datos.modalidad = evaluacion.valor;
    return null;
  }
  const descartada = evaluacion.tipo || String(datos.modalidad);
  delete datos.modalidad;
  return descartada;
}

export function textoModalidades(modalidades) {
  const disponibles = modalidadesDisponibles(modalidades);
  if (!disponibles) return null;
  return disponibles.length
    ? disponibles.map((m) => m.valor).join(', ')
    : 'ninguna';
}
