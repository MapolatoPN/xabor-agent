/**
 * webhookPagos.js — Entrada de webhooks de proveedores de pago.
 *
 * Un webhook llega de internet y es hostil por definición. La regla que
 * gobierna todo este archivo: **el cuerpo del mensaje no decide nada**. No
 * decide de qué negocio es, ni qué pedido toca, ni cuánto, ni si está pagado.
 * Lo único que aporta es un identificador de pago que hay que ir a verificar.
 *
 * La autoridad son dos cosas, en este orden:
 *   1. el token de ruteo de la URL, que Xabor generó y ató a una integración;
 *   2. el pago RECONSULTADO al proveedor con las credenciales de ESE negocio,
 *      contrastado contra lo que Xabor ya tenía persistido.
 *
 * Todo camino dudoso termina en "no se hace nada": es preferible perder un
 * aviso y reconciliar después que confirmar un cobro que no ocurrió.
 */
import {
  resolverIntegracionPorRoutingToken, obtenerPagoPorExternalReference,
  ligarPaymentIdExclusivo, confirmarPagoIdempotentePorNegocio, confirmarPagoPedido,
  actualizarEstadoPagoPorId, pagosPendientesDeProveedor,
} from './database.js';
import { obtenerCredencialesPagoDescifradas } from './integracionesService.js';
import { obtenerAdaptador } from './paymentProviders.js';

// Proveedores cuyo webhook se acepta en esta fase. Uno desconocido no es un
// error a depurar: es una URL que no existe.
const PROVEEDORES_CON_WEBHOOK = new Set(['mercado_pago']);

// Comparación de dinero en centavos: 100.00 y 100.004 son el mismo cobro para
// un banco, pero `!==` los separaría y rechazaría un pago legítimo.
const mismoMonto = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);

/**
 * Devuelve { http, resultado } — `http` es lo que se responde al proveedor.
 * Se responde 200 en casi todo lo que no sea un error de ruteo: a un proveedor
 * no se le pide que reintente porque el pago no nos cuadre, se le confirma la
 * recepción y el problema se resuelve del lado de Xabor.
 */
export async function procesarWebhookPago({ proveedor, routingToken, req }) {
  if (!PROVEEDORES_CON_WEBHOOK.has(proveedor)) {
    return { http: 404, resultado: { razon: 'proveedor_sin_webhook' } };
  }

  // 1) Identidad: sólo el token de la URL. Nunca el cuerpo.
  const integracion = await resolverIntegracionPorRoutingToken(routingToken);
  if (!integracion) {
    return { http: 404, resultado: { razon: 'routing_token_invalido' } };
  }
  if (integracion.proveedor !== proveedor) {
    // Token de una integración de otro proveedor: no se atiende.
    return { http: 404, resultado: { razon: 'proveedor_no_coincide_con_token' } };
  }
  const negocioId = integracion.negocio_id;

  const adaptador = obtenerAdaptador(proveedor);
  if (!adaptador) return { http: 404, resultado: { razon: 'proveedor_sin_adaptador' } };

  // 2) Credenciales de ESE negocio, descifradas. Nunca una clave de plataforma.
  let credenciales;
  try {
    credenciales = await obtenerCredencialesPagoDescifradas(negocioId, proveedor);
  } catch (e) {
    console.error(`[WebhookPagos] No se pudieron leer credenciales de ${negocioId}: ${e.message}`);
    return { http: 200, resultado: { razon: 'sin_credenciales' } };
  }

  // 3) Firma. Fail closed: sin secreto, sin cabecera o con HMAC distinto, aquí
  //    se acaba. El token de ruteo por sí solo nunca basta.
  const firma = adaptador.verifyWebhook(req, credenciales);
  if (!firma?.verificado) {
    console.warn(`[WebhookPagos] Firma no verificada (${firma?.motivo}) negocio=${negocioId}`);
    return { http: 401, resultado: { razon: 'firma_invalida', detalle: firma?.motivo } };
  }

  // 4) El data.id es un PAYMENT id, no una preferencia. Se usa para consultar
  //    /v1/payments/:paymentId -- consultar ahí un preference_id pediría un
  //    recurso que no existe.
  const paymentId = String(req?.query?.['data.id'] || req?.body?.data?.id || '').trim();
  if (!paymentId) return { http: 200, resultado: { razon: 'sin_payment_id' } };

  // 5) Reconsulta al proveedor. Esto -- y no el cuerpo -- dice qué pasó.
  let real;
  try {
    real = await adaptador.getPaymentStatus(paymentId, credenciales);
  } catch (e) {
    console.error(`[WebhookPagos] Reconsulta fallida payment=${paymentId} negocio=${negocioId}: ${e.message}`);
    // Fallo TRANSITORIO: responder 200 aqui le diria a Mercado Pago que el
    // aviso quedo entregado y no volveria a mandarlo. Se responde 5xx para que
    // reintente, y ademas la reconciliacion periodica lo recoge si nunca
    // vuelve. Dos capas, porque perder un cobro no se arregla a mano.
    return { http: 503, resultado: { razon: 'reconsulta_fallida' } };
  }
  if (!real) return { http: 200, resultado: { razon: 'payment_inexistente' } };

  return aplicarPagoVerificadoDesde({ negocioId, proveedor, real, paymentId });
}

/**
 * Verificacion y aplicacion de un pago ya CONSULTADO al proveedor. La usan por
 * igual el webhook y la reconciliacion: una sola ruta de validacion y una sola
 * transicion, para que no puedan divergir.
 */
export async function aplicarPagoVerificadoDesde({ negocioId, proveedor, real, paymentId }) {
  // external_reference: la referencia que Xabor puso al crear el cobro.
  const referencia = real.referenciaInterna;
  if (!referencia) return { http: 200, resultado: { razon: 'sin_external_reference' } };

  // El pago se busca SIEMPRE acotado al negocio del token. Una referencia del
  // negocio A que llegue por el token de B no encuentra nada: no hay forma de
  // que un webhook toque el pedido de otro.
  const pago = await obtenerPagoPorExternalReference(negocioId, referencia);
  if (!pago) {
    console.warn(`[WebhookPagos] external_reference sin pago propio negocio=${negocioId} — se ignora (fail closed)`);
    return { http: 200, resultado: { razon: 'referencia_ajena_o_inexistente' } };
  }
  if (pago.proveedor !== proveedor) {
    return { http: 200, resultado: { razon: 'proveedor_del_pago_no_coincide' } };
  }

  const estadoInterno = real.estado || 'requiere_revision';

  // Dinero: monto y moneda son OBLIGATORIOS y tienen que ser los que Xabor
  // registro. Antes se comparaban solo "si venian", asi que una respuesta
  // incompleta se saltaba las dos comprobaciones y podia confirmar igual. Un
  // dato de dinero ausente no es un dato neutro: es una razon para no cobrar.
  if (estadoInterno === 'pagado') {
    const montoValido = typeof real.monto === 'number' && Number.isFinite(real.monto) && real.monto > 0;
    if (!montoValido) {
      console.error(`[Pagos] MONTO AUSENTE O INVALIDO pago=${pago.id} recibido=${JSON.stringify(real.monto)}`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'monto_invalido', pagoId: pago.id } };
    }
    if (!mismoMonto(real.monto, pago.monto)) {
      console.error(`[Pagos] MONTO DISTINTO pago=${pago.id} esperado=${pago.monto} recibido=${real.monto}`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'monto_distinto', pagoId: pago.id } };
    }
    if (!real.moneda) {
      console.error(`[Pagos] MONEDA AUSENTE pago=${pago.id}`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'moneda_ausente', pagoId: pago.id } };
    }
    if (String(real.moneda).toUpperCase() !== String(pago.moneda).toUpperCase()) {
      console.error(`[Pagos] MONEDA DISTINTA pago=${pago.id} esperada=${pago.moneda} recibida=${real.moneda}`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'moneda_distinta', pagoId: pago.id } };
    }
  }

  // El payment_id queda ligado a ESTA fila y a ninguna otra. Si ya pertenece a
  // otro cobro, aqui se ACABA: confirmar seria cobrar dos veces lo mismo. Antes
  // esto era un log y se seguia adelante.
  if (paymentId) {
    const ligado = await ligarPaymentIdExclusivo(pago.id, negocioId, proveedor, paymentId);
    if (!ligado.ok) {
      console.error(`[Pagos] NO SE PUDO LIGAR payment_id=${paymentId} a pago=${pago.id}: ${ligado.razon}`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: `conflicto_payment_id:${ligado.razon}`, pagoId: pago.id } };
    }
  }

  // Solo 'pagado' libera cocina. Un rechazo, un pendiente o un estado que MP
  // invente maniana no pueden sacar una comanda.
  if (estadoInterno !== 'pagado') {
    await actualizarEstadoPagoPorId(pago.id, negocioId, estadoInterno);
    return { http: 200, resultado: { razon: 'estado_no_pagado', estado: estadoInterno, pagoId: pago.id } };
  }

  // Confirmacion idempotente ACOTADA AL NEGOCIO, y liberacion del pedido por el
  // unico mecanismo autorizado -- el mismo que ya es exclusivo y recuperable
  // ante crash. Cincuenta avisos iguales pasan por aqui y solo uno emite.
  await confirmarPagoIdempotentePorNegocio(pago.id, negocioId, { referenciaExterna: paymentId });
  await confirmarPagoPedido(pago.pedido_folio, negocioId);
  const { confirmarPedidoPendientePago } = await import('../orders/orderManager.js');
  await confirmarPedidoPendientePago(pago.pedido_folio, negocioId);

  return {
    http: 200,
    resultado: { razon: 'confirmado', pagoId: pago.id, folio: pago.pedido_folio, paymentId },
  };
}

/**
 * Reconciliacion de Mercado Pago.
 *
 * El webhook puede perderse, o la reconsulta puede fallar justo cuando llega.
 * Sin esta red, un cliente que pago se quedaria con el pedido en pendiente_pago
 * para siempre. Recorre los pagos que siguen esperando y busca el cobro real
 * POR LA REFERENCIA de Xabor -- nunca consultando /v1/payments/:preferenceId,
 * que pediria un recurso inexistente.
 *
 * Reutiliza exactamente la misma verificacion y la misma transicion que el
 * webhook: no hay una segunda ruta que pudiera divergir. Dos instancias
 * corriendola a la vez terminan en una sola confirmacion, porque la transicion
 * de emision ya es exclusiva y la confirmacion del pago es idempotente.
 */
export async function reconciliarPagosMercadoPago(limite = 25) {
  const proveedor = 'mercado_pago';
  const adaptador = obtenerAdaptador(proveedor);
  if (!adaptador?.buscarPagoPorReferencia) return 0;

  const pendientes = await pagosPendientesDeProveedor(proveedor, limite).catch(() => []);
  let confirmados = 0;
  for (const pago of pendientes) {
    try {
      const credenciales = await obtenerCredencialesPagoDescifradas(pago.negocio_id, proveedor);
      const real = await adaptador.buscarPagoPorReferencia(pago.referencia_interna, credenciales);
      if (!real) continue;                       // todavia no hay cobro: nada que hacer
      const r = await aplicarPagoVerificadoDesde({
        negocioId: pago.negocio_id, proveedor, real, paymentId: real.paymentId,
      });
      if (r?.resultado?.razon === 'confirmado') confirmados++;
    } catch (e) {
      // Un fallo aqui no pierde nada: el pago sigue pendiente y la proxima
      // vuelta lo intenta otra vez.
      console.error(`[Pagos] Reconciliacion MP fallida pago=${pago.id}: ${e.message}`);
    }
  }
  if (confirmados) console.log(`[Pagos] Reconciliacion MP: ${confirmados} pago(s) confirmados sin webhook`);
  return confirmados;
}
