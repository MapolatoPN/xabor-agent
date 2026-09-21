// La conversación puede usar palabras distintas para la misma forma de pago,
// pero el pedido y la configuración del negocio usan tipos canónicos. Este
// módulo mantiene esa traducción fuera del modelo y aplica la lista real de
// métodos habilitados antes de que el dato llegue al carrito.

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/_/g, ' ').replace(/[^a-z0-9ñ ]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const ALIAS = Object.freeze({
  efectivo: /\b(efectivo|cash)\b/,
  terminal: /\b(tarjeta|terminal|credito|debito)\b/,
  enlace_pago: /\b(enlace|link|liga|pago en linea|tarjeta en linea)\b/,
  transferencia: /\b(transferencia|transferir|transfer)\b/,
  pago_en_sucursal: /\b(pago en sucursal|pagar en sucursal)\b/,
  otro_autorizado: /\botro autorizado\b/,
});

const ETIQUETAS = Object.freeze({
  efectivo: 'efectivo',
  terminal: 'tarjeta con terminal',
  enlace_pago: 'enlace de pago',
  transferencia: 'transferencia',
  pago_en_sucursal: 'pago en sucursal',
  otro_autorizado: 'otro método autorizado',
});

export function normalizarTipoPago(valor) {
  const texto = norm(valor);
  if (!texto) return null;
  for (const [tipo, patron] of Object.entries(ALIAS)) {
    if (texto === norm(tipo) || patron.test(texto)) return tipo;
  }
  return null;
}

export const etiquetaTipoPago = (tipo) => ETIQUETAS[tipo] || String(tipo || '').replace(/_/g, ' ');

export function tiposDePagoDisponibles(metodosPago) {
  if (!Array.isArray(metodosPago)) return null;
  return [...new Set(metodosPago.map((m) => normalizarTipoPago(m?.tipo ?? m)).filter(Boolean))];
}

const AFIRMACION = /^(si|sip|claro|va|sale|ok|okay|de acuerdo|esta bien|me funciona|acepto)\b/;

function tieneEvidencia(tipo, mensaje, ofrecido) {
  const texto = norm(mensaje);
  if (ALIAS[tipo]?.test(texto)) return true;
  return normalizarTipoPago(ofrecido) === tipo && AFIRMACION.test(texto);
}

/**
 * Decide si una forma de pago puede entrar al carrito.
 * `metodosPago === null` conserva compatibilidad con las pruebas y llamadores
 * puros antiguos; producción siempre entrega la lista leída de Postgres.
 */
export function evaluarFormaPago({ formaPago, metodosPago = null, mensaje = '', ofrecido = null } = {}) {
  const tipo = normalizarTipoPago(formaPago);
  const disponibles = tiposDePagoDisponibles(metodosPago);
  const etiquetas = (disponibles || []).map(etiquetaTipoPago);

  if (!tipo) {
    return { ok: false, codigo: 'forma_pago_no_reconocida', tipo: null,
      motivo: `No reconozco esa forma de pago. Disponibles: ${etiquetas.join(', ') || 'ninguna'}.`,
      disponibles: disponibles || [] };
  }
  if (disponibles && !disponibles.includes(tipo)) {
    const alternativa = tipo === 'transferencia' && disponibles.includes('enlace_pago')
      ? 'enlace_pago' : null;
    return { ok: false, codigo: 'forma_pago_no_disponible', tipo, alternativa,
      motivo: tipo === 'transferencia' && alternativa
        ? 'El negocio no acepta transferencias. Ofrece enlace de pago; es muy similar a pagar con transferencia.'
        : `El negocio no acepta ${etiquetaTipoPago(tipo)}. Disponibles: ${etiquetas.join(', ') || 'ninguna'}.`,
      disponibles };
  }
  if (disponibles && !tieneEvidencia(tipo, mensaje, ofrecido)) {
    return { ok: false, codigo: 'forma_pago_sin_respaldo', tipo,
      motivo: `El cliente no eligió ${etiquetaTipoPago(tipo)} en este mensaje.`, disponibles };
  }
  return { ok: true, tipo, disponibles: disponibles || null };
}

/** Quita de un estado durable una forma que la configuración ya no permite. */
export function depurarPagoNoDisponible(estado, metodosPago) {
  const datos = estado?.carrito?.datos;
  if (!datos || !datos.forma_pago || !Array.isArray(metodosPago)) return null;
  const actual = normalizarTipoPago(datos.forma_pago);
  const disponibles = tiposDePagoDisponibles(metodosPago) || [];
  if (actual && disponibles.includes(actual)) {
    datos.forma_pago = actual;
    return null;
  }
  const descartado = actual || String(datos.forma_pago);
  delete datos.forma_pago;
  return descartado;
}

export function textoMetodosPago(metodosPago) {
  const tipos = tiposDePagoDisponibles(metodosPago);
  if (!tipos) return null;
  return tipos.length ? tipos.map(etiquetaTipoPago).join(', ') : 'ninguno';
}
