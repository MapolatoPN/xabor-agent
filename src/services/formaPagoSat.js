// Forma de pago SAT del recibo de una venta. La factura global se arma una por
// forma de pago, y el SAT no acepta «99 Por definir» en un pago de una sola
// exhibición: un recibo con 99 no puede entrar en una global.
//
// El negocio decide con su contador (Facturación → Configuración):
//   forma_tarjeta  terminal o tarjeta genérica: 28 débito (lo de siempre) o 04 crédito;
//   forma_mixto    'mayor' toma la forma del pago de mayor monto; si no, 99;
//   forma_rappi    pedidos de Rappi: 03 transferencia o 31 intermediario; si no, 99.
// Lo demás sigue la regla de siempre (mapFormaPago).
import { mapFormaPago } from './facturapi.js';

export const NOMBRES_FORMA_SAT = Object.freeze({
  '01': 'Efectivo', '03': 'Transferencia', '04': 'Tarjeta de crédito',
  '28': 'Tarjeta de débito', '31': 'Intermediario de pagos', '99': 'Por definir',
});

const texto = (v) => String(v || '').trim().toLowerCase().replace(/_/g, ' ');
const esMixto = (f) => ['mixto', 'multiple', 'múltiple'].includes(f);
// «terminal», «tarjeta», «terminal (tarjeta presente)»; no «tarjeta de crédito».
const esTarjeta = (f) => /\b(terminal|tarjeta)\b/.test(f) && !/cr[eé]dito|d[eé]bito|enlace/.test(f);

/** La forma con la que se crearon los recibos hasta la fase 3. */
export function formaPagoLegado(pedido) {
  return mapFormaPago(pedido?.forma_pago || pedido?.cliente?.forma_pago);
}

function formaSimple(f, cfg) {
  if (/^(01|03|04|28|31)$/.test(f)) return f;
  if (f === 'rappi') return cfg.forma_rappi || '99';
  if (esTarjeta(f)) return cfg.forma_tarjeta === '04' ? '04' : '28';
  return mapFormaPago(f);
}

/** Forma SAT para el recibo de `pedido` con la configuración `cfg` del negocio. */
export function formaPagoSatDeVenta(pedido, cfg = {}) {
  const f = texto(pedido?.forma_pago || pedido?.cliente?.forma_pago);
  if (!f && texto(pedido?.canal) === 'rappi') return cfg.forma_rappi || '99';
  if (esMixto(f)) {
    if (cfg.forma_mixto !== 'mayor') return '99';
    const pagos = (Array.isArray(pedido?.pagos) ? pedido.pagos : [])
      .filter((p) => Number(p?.monto) > 0 && !esMixto(texto(p?.metodo)));
    if (!pagos.length) return '99';
    const mayor = pagos.reduce((a, b) => (Number(b.monto) > Number(a.monto) ? b : a));
    return formaSimple(texto(mayor.metodo), cfg);
  }
  return formaSimple(f, cfg);
}
