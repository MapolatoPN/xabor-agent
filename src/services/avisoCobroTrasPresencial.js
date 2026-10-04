// ─── Aviso: entró dinero en línea de un pedido que el equipo pasó a efectivo ──
//
// XAB-1130 (2-oct): un pedido de WhatsApp que esperaba el pago con enlace se
// «pasó a efectivo» con ✏️ y se canceló solo a los 30 min. Con la bandera
// `pago_presencial_libera_pendiente`, ese cambio ahora LIBERA el pedido a
// cocina (orders/liberarPagoPresencial.js) y vence el intento del enlace. Pero
// Clip no permite cancelar un checkout: el enlace sigue cobrable hasta que
// vence en Clip. Si la clienta lo paga de todos modos, ese dinero es real y se
// asienta como `pago_tardio` (sin segunda comanda, sin marcar pagado un pedido
// que el repartidor va a cobrar en la puerta). Lo que faltaba era que alguien
// se enterara: `pago_tardio` solo dejaba un console.error.
//
// La señal vive en UN solo sitio: asentarPagoRealVerificado (database.js), por
// donde pasan los seis caminos que asientan dinero (webhook y reconciliación
// de Clip, candidatos de Clip, Mercado Pago, confirmación manual). Ese sitio
// llama aquí; ningún llamador repite el aviso en su rama.
//
// OJO (revisión del 3-oct): el panel de hoy NO tiene manejador de
// `pago_anomalia` (panel/index.html es archivo protegido: fase 2). Lo que el
// administrador SÍ ve es la Caja: cortesCaja.alertasDePagosEnLinea lee las
// marcas durables que deja asentarPagoRealVerificado y las lista en el corte
// del día. Este evento queda para la fase 2 y para los logs.
//
// Sin imports a propósito: database.js lo importa, y este módulo no puede
// arrastrar de vuelta a database.js (ciclo) ni al servidor. El envío al panel
// se inyecta desde server.js (mismo patrón que setWsBroadcast).

export const ANOMALIA_COBRO_TRAS_PRESENCIAL = 'cobro_en_linea_tras_efectivo';

let broadcastNegocio = null;

/** server.js inyecta su broadcastNegocio una sola vez al arrancar. */
export function setBroadcastAvisoCobroTrasPresencial(fn) {
  broadcastNegocio = typeof fn === 'function' ? fn : null;
}

const dinero = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
};

/**
 * El texto que ve el equipo. Dice qué hacer, no qué pasó por dentro: el
 * repartidor o la caja no deben cobrar otra vez, o hay que reembolsar.
 */
export function textoAvisoCobroTrasPresencial({ folio, monto, formaPresencial } = {}) {
  const cuanto = dinero(monto) != null ? ` de $${dinero(monto).toFixed(2)}` : '';
  const como = formaPresencial === 'terminal' ? 'con terminal' : 'en efectivo';
  return `El pedido ${folio} ya se había pasado a cobro ${como}, pero el cliente pagó el enlace${cuanto}. `
    + 'No le cobren otra vez al entregar; si ya se cobró, hay que reembolsar el pago en línea.';
}

/**
 * Nunca lanza: el dinero ya quedó asentado (COMMIT) antes de llamar aquí, y un
 * fallo del aviso no puede convertirse en un error del webhook que haga al
 * proveedor reintentar un cobro que ya está dentro.
 */
export function avisarCobroTrasPresencial({ negocioId, folio, pagoId, monto, proveedor, liberacion } = {}) {
  try {
    const formaPresencial = liberacion?.forma_pago_tipo || null;
    const mensaje = textoAvisoCobroTrasPresencial({ folio, monto, formaPresencial });
    console.error(`[Pagos] COBRO EN LINEA TRAS PASAR A ${String(formaPresencial || 'presencial').toUpperCase()} `
      + `pedido=${folio} negocio=${negocioId} pago=${pagoId} proveedor=${proveedor || '-'} monto=${monto} `
      + `liberado_por=${liberacion?.por || '-'} liberado_at=${liberacion?.at || '-'}: no cobrar otra vez o reembolsar`);
    if (!broadcastNegocio || typeof negocioId !== 'string' || !negocioId.trim()) return false;
    broadcastNegocio(negocioId.trim(), {
      tipo: 'pago_anomalia',
      anomalia: ANOMALIA_COBRO_TRAS_PRESENCIAL,
      pedidoId: folio,
      pagoId,
      monto: dinero(monto),
      proveedor: proveedor || null,
      mensaje,
    });
    return true;
  } catch (e) {
    console.error(`[Pagos] No se pudo avisar el cobro en línea tras pasar a presencial (${folio}): ${e.message}`);
    return false;
  }
}
