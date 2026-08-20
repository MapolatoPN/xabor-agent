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
  ligarPaymentIdExclusivo, asentarPagoRealVerificado,
  actualizarEstadoPagoPorId, pagosReconciliablesDeProveedor,
  marcarAnomaliaPago, saldarDerivacionPago, pagosConDerivacionPendiente,
  consumirDeudaDeDerivacion, adoptarCheckoutClip, pagosConCandidatoClipSinVerificar,
  pagosConEsperaVencida, vencerEsperaDePago, anotarMetadataPago,
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
      // La anomalia se registra SIEMPRE; el cambio de estado solo prospera si la
      // fila todavia esta viva. Sobre una terminal el estado no se mueve -- una
      // fila superseded no vuelve a circulacion por un aviso tardio -- pero la
      // constancia queda igual.
      await marcarAnomaliaPago(pago.id, negocioId, 'monto_invalido',
        `webhook de ${proveedor} con dinero que no cuadra`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'monto_invalido', pagoId: pago.id } };
    }
    if (!mismoMonto(real.monto, pago.monto)) {
      console.error(`[Pagos] MONTO DISTINTO pago=${pago.id} esperado=${pago.monto} recibido=${real.monto}`);
      // La anomalia se registra SIEMPRE; el cambio de estado solo prospera si la
      // fila todavia esta viva. Sobre una terminal el estado no se mueve -- una
      // fila superseded no vuelve a circulacion por un aviso tardio -- pero la
      // constancia queda igual.
      await marcarAnomaliaPago(pago.id, negocioId, 'monto_distinto',
        `webhook de ${proveedor} con dinero que no cuadra`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'monto_distinto', pagoId: pago.id } };
    }
    if (!real.moneda) {
      console.error(`[Pagos] MONEDA AUSENTE pago=${pago.id}`);
      // La anomalia se registra SIEMPRE; el cambio de estado solo prospera si la
      // fila todavia esta viva. Sobre una terminal el estado no se mueve -- una
      // fila superseded no vuelve a circulacion por un aviso tardio -- pero la
      // constancia queda igual.
      await marcarAnomaliaPago(pago.id, negocioId, 'moneda_ausente',
        `webhook de ${proveedor} con dinero que no cuadra`);
      await actualizarEstadoPagoPorId(pago.id, negocioId, 'requiere_revision');
      return { http: 200, resultado: { razon: 'moneda_ausente', pagoId: pago.id } };
    }
    if (String(real.moneda).toUpperCase() !== String(pago.moneda).toUpperCase()) {
      console.error(`[Pagos] MONEDA DISTINTA pago=${pago.id} esperada=${pago.moneda} recibida=${real.moneda}`);
      // La anomalia se registra SIEMPRE; el cambio de estado solo prospera si la
      // fila todavia esta viva. Sobre una terminal el estado no se mueve -- una
      // fila superseded no vuelve a circulacion por un aviso tardio -- pero la
      // constancia queda igual.
      await marcarAnomaliaPago(pago.id, negocioId, 'moneda_distinta',
        `webhook de ${proveedor} con dinero que no cuadra`);
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
      await marcarAnomaliaPago(pago.id, negocioId, `conflicto_payment_id:${ligado.razon}`,
        `el payment_id ${paymentId} no pudo ligarse a este cobro`);
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

  // TRANSICION FINANCIERA UNICA -- la misma que usa el webhook de Clip y la
  // reconciliacion. Aqui vive todo lo que el dinero necesita: idempotencia,
  // cierre de los intentos hermanos y deteccion de doble cobro real.
  const transicion = await asentarPagoRealVerificado({
    pagoId: pago.id, negocioId, referenciaExterna: paymentId, paymentId,
  });

  // La derivacion del pedido SOLO ocurre si la transicion confirmo esta fila o
  // determino que ya estaba confirmada. Cualquier otro resultado -- incluida
  // una excepcion, que se propaga -- significa no liberar cocina.
  if (!transicion.ok) {
    console.error(`[Pagos] Transicion financiera no confirmo ${pago.id}: ${transicion.resultado} — NO se libera el pedido`);
    return {
      http: 200,
      resultado: { razon: `transicion_${transicion.resultado}`, pagoId: pago.id, folio: pago.pedido_folio,
                   pagosImplicados: transicion.pagosImplicados || undefined },
    };
  }

  await derivarPedidoPorPagoAsentado({ pagoId: pago.id, negocioId, folio: pago.pedido_folio });

  return {
    http: 200,
    resultado: {
      razon: 'confirmado', pagoId: pago.id, folio: pago.pedido_folio, paymentId,
      transicion: transicion.resultado,
      hermanosCerrados: transicion.hermanosCerrados,
    },
  };
}

/**
 * VERIFICACION Y ASIENTO DE UN CHECKOUT DE CLIP.
 *
 * Un solo camino para las dos entradas -- el webhook y la reconciliacion de
 * candidatos --, porque dos copias serian dos sitios donde relajar una
 * validacion. El `checkoutId` que entra aqui es siempre un CANDIDATO: Clip no
 * firma sus webhooks, asi que nada se cree hasta reconsultarlo con las
 * credenciales del negocio dueño.
 *
 * Devuelve { ok, razon } y NO deriva: eso lo hace el llamador, que es quien
 * sabe si tiene con que avisar al panel.
 */
export async function verificarYAsentarClip({ pago, checkoutId }) {
  const negocioId = pago.negocio_id;
  const { getPaymentStatus } = await import('./providers/clipProvider.js');
  const real = await getPaymentStatus(checkoutId, negocioId);
  if (!real) return { ok: false, razon: 'sin_respuesta_del_proveedor' };
  if (!real.pagado) return { ok: false, razon: `estado_no_pagado:${real.estadoProveedor || 'desconocido'}` };

  // El checkout consultado tiene que ser el de ESTA fila.
  if (real.referenciaInterna !== pago.referencia_interna) {
    await marcarAnomaliaPago(pago.id, negocioId, 'referencia_no_coincide',
      'el checkout reconsultado en Clip lleva otra referencia interna');
    return { ok: false, razon: 'referencia_no_coincide' };
  }
  // Dinero: lo dice la API, no el aviso.
  const montoOk = typeof real.monto === 'number' && Number.isFinite(real.monto)
    && Math.abs(real.monto - Number(pago.monto)) < 0.005;
  if (!montoOk) {
    await marcarAnomaliaPago(pago.id, negocioId, 'monto_distinto',
      `Clip reporta ${real.monto} y la fila dice ${pago.monto}`);
    return { ok: false, razon: 'monto_distinto' };
  }
  if (real.moneda && String(real.moneda).toUpperCase() !== String(pago.moneda).toUpperCase()) {
    await marcarAnomaliaPago(pago.id, negocioId, 'moneda_distinta',
      `Clip reporta ${real.moneda} y la fila dice ${pago.moneda}`);
    return { ok: false, razon: 'moneda_distinta' };
  }

  // Identidad DURABLE antes de asentar: desde aqui la fila ya no puede volver
  // a mandar un POST de creacion.
  if (!pago.referencia_externa) {
    await adoptarCheckoutClip(pago.id, negocioId, checkoutId, real.url);
  }
  const transicion = await asentarPagoRealVerificado({
    pagoId: pago.id, negocioId, referenciaExterna: checkoutId });
  if (!transicion.ok) return { ok: false, razon: `transicion_${transicion.resultado}`, transicion };
  return { ok: true, razon: transicion.resultado, transicion };
}

/**
 * Reconciliacion de CANDIDATOS de Clip: filas cuya creacion quedo ambigua, a
 * las que un webhook les trajo un payment_request_id, y cuya verificacion no
 * llego a completarse -- reconsulta caida, o el proceso murio entre el 200 y el
 * trabajo real.
 *
 * Sin esto, ese id se perdia y ninguna otra reconciliacion podia encontrarlo:
 * la de Clip recorre filas CON referencia externa, y estas no la tienen. No
 * hace falta que Clip reenvie el webhook -- de hecho no se le pide.
 */
export async function reconciliarCandidatosClip(limite = 25) {
  const filas = await pagosConCandidatoClipSinVerificar(limite).catch(() => []);
  let resueltos = 0;
  for (const pago of filas) {
    const candidato = pago.metadata_sanitizada?.clip_checkout_candidato;
    if (!candidato) continue;
    try {
      const r = await verificarYAsentarClip({ pago, checkoutId: candidato });
      if (!r.ok) {
        console.warn(`[Clip Candidatos] ${pago.id}: ${r.razon}`);
        continue;
      }
      await derivarPedidoPorPagoAsentado({
        pagoId: pago.id, negocioId: pago.negocio_id, folio: pago.pedido_folio });
      resueltos++;
      console.log(`[Clip Candidatos] Cobro recuperado sin reenvio de webhook: pedido ${pago.pedido_folio}`);
    } catch (e) {
      console.error(`[Clip Candidatos] Error con ${pago.id}: ${e.message}`);
    }
  }
  return resueltos;
}

/**
 * CLIP expires_at: expiracion declarada POR EL PROVEEDOR (webhook EXPIRED o
 * reconsulta que devuelve CHECKOUT_EXPIRED), verificada y aplicada por la
 * MISMA transicion comun que el vencimiento local -- vencerEsperaDePago --
 * nunca una segunda maquina de estados.
 *
 * Reglas:
 *   · El webhook de Clip NO viene firmado: el aviso jamas decide nada. Aqui
 *     se RECONSULTA el checkout con las credenciales del negocio y solo si el
 *     estado REAL es CHECKOUT_EXPIRED (y la referencia interna cuadra) se
 *     procede. Un EXPIRED falso sobre un checkout vivo no toca nada.
 *   · Si la reconsulta dice PAGADO, no se vence nada: se devuelve la señal
 *     para que el camino de settlement lo recoja -- EXPIRED jamas se mapea a
 *     pagado ni al reves.
 *   · vencerEsperaDePago ya es idempotente y money-aware (si el dinero llego
 *     primero, ve la fila pagada y no la toca; un segundo aviso devuelve
 *     `ya_no_vencible`). El proveedor venciendo ANTES que la frontera local
 *     es legitimo ("igual o mas estricta"); lo contrario -- ampliar la
 *     ventana local porque el proveedor durara mas -- no existe aqui ni en
 *     ningun otro lado.
 */
export async function procesarExpiracionProveedorClip({ pago, checkoutId }) {
  if (!pago || !checkoutId) return { ok: false, razon: 'sin_pago_o_checkout' };
  const negocioId = pago.negocio_id;
  const { getPaymentStatus } = await import('./providers/clipProvider.js');
  const real = await getPaymentStatus(checkoutId, negocioId);
  if (!real) return { ok: false, razon: 'sin_respuesta_del_proveedor' };
  if (real.referenciaInterna !== pago.referencia_interna) {
    await marcarAnomaliaPago(pago.id, negocioId, 'referencia_no_coincide',
      'un aviso de expiracion nombro un checkout con otra referencia interna');
    return { ok: false, razon: 'referencia_no_coincide' };
  }
  if (real.pagado) {
    // El dinero manda: esto NO es una expiracion, es un cobro que el camino
    // COMPLETED/reconciliacion debe asentar. Nunca se vence un pago real.
    return { ok: false, razon: 'en_realidad_pagado' };
  }
  if (real.estado !== 'vencido') {
    return { ok: false, razon: `no_vencido_en_proveedor:${real.estadoProveedor || 'desconocido'}` };
  }
  const r = await vencerEsperaDePago(pago.id, negocioId);
  if (r.ok) {
    // Rastro sanitizado de POR QUE vencio. CLIP-D: dos campos, dos
    // significados -- provider_expires_at es la frontera PROGRAMADA que el
    // GET autenticado declara (`expires_at`); provider_expired_at es el
    // instante en que YA expiro y SOLO se escribe si el contrato lo trajo
    // (`expired_at` del checkout ya vencido). Jamas se guarda una fecha
    // programada bajo un nombre en pasado. No toca dinero/estado/identidad.
    await anotarMetadataPago(pago.id, negocioId, {
      expirado_por_proveedor: true,
      expirado_por_proveedor_at: new Date().toISOString(),
      provider_expires_at: real.expiraAt || null,
      ...(real.expiradoAt ? { provider_expired_at: real.expiradoAt } : {}),
    }).catch(() => {});
  }
  return { ok: r.ok, razon: r.ok ? 'vencido_por_proveedor' : r.razon, transicion: r };
}

/**
 * Vence las esperas de pago que ya pasaron su ventana.
 *
 * El setInterval solo DISPARA trabajo: la exclusividad vive en la base, dentro
 * de vencerEsperaDePago, bajo la misma obligacion financiera que usan la
 * creacion y el settlement. Por eso dos instancias corriendo este job a la vez
 * producen UNA sola transicion por pedido, y reejecutarlo es inofensivo.
 */
export async function expirarPagosVencidos(limite = 25) {
  const filas = await pagosConEsperaVencida(limite).catch(() => []);
  let vencidos = 0;
  for (const pago of filas) {
    try {
      const r = await vencerEsperaDePago(pago.id, pago.negocio_id);
      if (r.ok) {
        vencidos++;
        console.log(`[Pagos] Espera vencida: pedido ${r.folio} deja de esperar el pago`);
      }
    } catch (e) {
      console.error(`[Pagos] No se pudo vencer ${pago.id}: ${e.message}`);
    }
  }
  return vencidos;
}

/**
 * Descarga la DEUDA DE DERIVACION que dejo la transicion financiera: liberar el
 * pedido y sacar la comanda. Una sola implementacion para todos los origenes --
 * webhook de Mercado Pago, webhook de Clip, reconciliacion y confirmacion
 * manual --, porque cuatro copias serian cuatro sitios donde volver a olvidar
 * el saldo.
 *
 * El orden importa: primero derivar, DESPUES saldar. Al reves cambiaria
 * "comanda repetida" -- que la exclusividad de emision ya absorbe -- por
 * "pedido cobrado sin comanda", que no se arregla solo.
 */
export async function derivarPedidoPorPagoAsentado({ pagoId, negocioId, folio }) {
  // Punto de muerte inyectable: EXACTAMENTE despues del commit financiero y
  // antes de tocar el pedido. Es la ventana que la 055 vino a cerrar.
  if (process.env.NODE_ENV !== 'production'
      && process.env.XABOR_PAGOS_FALLA_EN === 'despues_de_asentar') {
    const e = new Error("Fallo inyectado en 'despues_de_asentar'");
    e.inyectado = true;
    throw e;
  }

  // LA DEUDA ES LA ÚNICA AUTORIZACIÓN. No basta con que la transición haya
  // devuelto ok: 'ya_confirmado' se resuelve antes de comparar versión, así que
  // un segundo aviso del mismo webhook sobre un cobro de la v1 llegaba hasta
  // aquí y liberaba la v2 -- justo lo que el primer aviso había impedido.
  //
  // consumirDeudaDeDerivacion vuelve a comparar la versión y marca el pedido
  // como pagado en la misma transacción, con la fila del pedido bloqueada.
  const deuda = await consumirDeudaDeDerivacion(pagoId, negocioId);
  if (!deuda.ok) {
    // No-op idempotente. Jamás se fabrica una deuda para poder derivar.
    if (deuda.resultado !== 'sin_deuda') {
      console.error(`[Pagos] Derivacion no autorizada para pago=${pagoId}: ${deuda.resultado}`);
    }
    return { derivado: false, razon: deuda.resultado };
  }

  const { confirmarPedidoPendientePago } = await import('../orders/orderManager.js');
  await confirmarPedidoPendientePago(folio, negocioId);
  await saldarDerivacionPago(pagoId, negocioId);
  return { derivado: true };
}

/**
 * Recupera las derivaciones que quedaron a deber: pagos con el dinero asentado
 * cuyo pedido nunca se libero porque el proceso murio en esa ventana. En
 * operacion normal no encuentra nada.
 *
 * No necesita que el proveedor reenvie el webhook -- de hecho no puede
 * esperarlo: para el proveedor el aviso ya se entrego, y para la reconciliacion
 * de dinero ese pago ya esta 'pagado'. La deuda es la unica pista, y por eso se
 * escribe en la misma transaccion que el dinero.
 */
export async function reconciliarDerivacionesPendientes(limite = 25) {
  const deudas = await pagosConDerivacionPendiente(limite).catch(() => []);
  let saldadas = 0;
  for (const pago of deudas) {
    try {
      const r = await derivarPedidoPorPagoAsentado({
        pagoId: pago.id, negocioId: pago.negocio_id, folio: pago.pedido_folio,
      });
      if (!r.derivado) continue;      // la deuda se cerró sola con su anomalía
      saldadas++;
      console.log(`[Pagos] Derivacion recuperada tras crash: pedido ${pago.pedido_folio} (pago ${pago.id})`);
    } catch (e) {
      // La deuda sigue escrita: la proxima vuelta lo intenta otra vez.
      console.error(`[Pagos] No se pudo saldar la derivacion del pago ${pago.id}: ${e.message}`);
    }
  }
  return saldadas;
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

  const pendientes = await pagosReconciliablesDeProveedor(proveedor, limite).catch(() => []);
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
