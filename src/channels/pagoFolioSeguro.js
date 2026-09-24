// Contrato fail-closed del atajo de pago por folio. Se mantiene sin imports
// del canal Meta para poder probar una caída de base sin levantar el servidor
// ni entrar en el ciclo whatsapp-meta <-> server.

export const MENSAJE_FALLO_CONSULTA_PAGO =
  'No pude consultar tu pedido en este momento. La conversación quedó en revisión para que una persona te ayude con el pago.';

export const MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION =
  'No pude consultar tu pedido en este momento. No intentaré generar un cobro hasta poder verificarlo. Por favor, inténtalo de nuevo más tarde.';

export async function resolverPedidoCobrablePorFolio({
  folio, negocioId, buscarParaPago, buscarAmplio,
} = {}) {
  if (typeof buscarParaPago !== 'function' || typeof buscarAmplio !== 'function') {
    throw new TypeError('resolverPedidoCobrablePorFolio requiere ambos lookups');
  }
  const cobrable = await buscarParaPago(folio, negocioId);
  if (cobrable) return cobrable;
  const amplio = await buscarAmplio(folio, negocioId);
  // La búsqueda amplia solo puede aportar una RESERVA. Usar un activo desde
  // aquí reintroduciría pedidos cancelados que la consulta cobrable rechazó.
  return amplio?._origen === 'programado' ? amplio : null;
}

export async function responderFalloConsultaPago(
  { folio, error, telefono, nombreMeta, negocioId, credenciales },
  { marcarRevision, enviar, guardar } = {},
) {
  console.error(`[Meta WA] Error consultando folio de pago ${folio}:`, error?.message || error);
  let revisionMarcada = false;
  let errorRevision = null;
  try {
    revisionMarcada = await marcarRevision({
      negocioId, telefono, nombreMeta, credenciales,
      motivo: 'PAGO_CONSULTA_PEDIDO_FALLIDA', avisarCliente: false,
    });
  } catch (falloRevision) {
    console.error('[Meta WA] No se pudo marcar revisión tras fallo de consulta de pago:', falloRevision.message);
    errorRevision = falloRevision;
  }

  // No afirmar una entrega a revisión que la capa durable no confirmó. Se
  // avisa solamente que el cobro se detuvo y se propaga la excepción para que
  // la continuidad haga su propio fail-close (EJECUCION_NO_VERIFICADA).
  if (revisionMarcada !== true) {
    let avisado = false;
    try {
      await enviar(telefono, MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION, credenciales);
      // Meta pudo aceptar el mensaje aunque falle su espejo local. Desde ese
      // instante ya no se debe mandar una segunda disculpa desde el catch del
      // canal: `avisado` describe lo que vio el cliente, no si auditamos el
      // envío en Postgres.
      avisado = true;
      await guardar(telefono, nombreMeta, 'saliente', MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION, negocioId, 'bot');
    } catch (errorAviso) {
      console.error('[Meta WA] No se pudo avisar el fallo de consulta de pago:', errorAviso.message);
    }
    const fallo = new Error('PAGO_REVISION_NO_CONFIRMADA');
    fallo.codigo = 'PAGO_REVISION_NO_CONFIRMADA';
    fallo.cause = errorRevision || error;
    fallo.avisado = avisado;
    throw fallo;
  }

  let avisado = false;
  try {
    await enviar(telefono, MENSAJE_FALLO_CONSULTA_PAGO, credenciales);
    avisado = true;
    await guardar(telefono, nombreMeta, 'saliente', MENSAJE_FALLO_CONSULTA_PAGO, negocioId, 'bot');
  } catch (errorAviso) {
    console.error('[Meta WA] No se pudo avisar el fallo de consulta de pago:', errorAviso.message);
  }
  return { revisionMarcada, avisado };
}
