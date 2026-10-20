// ─── Ticket del cliente (cuenta, precuenta, pagado), armado en el servidor ──
//
// Lo mismo que imprimía el Edge (edge/renderers/index.js renderCuenta), más
// el encabezado con los datos del negocio que ya se capturan en
// Configuración, y sin repetir las opciones de cada platillo en la nota. Un
// dato vacío no deja su etiqueta: sin WhatsApp no sale «WhatsApp:».
import { parrafo, filaColumnas, linea, espacio, corte } from './maquetador.js';
import { FORMATO_POR_DEFECTO } from './opciones.js';
import { horaDe } from './comanda.js';
import { lineasDeModificadores, notaSinModificadores } from '../../../edge/renderers/modificadores.js';

const dinero = (n) => `$${Number(n || 0).toFixed(2)}`;
const lleno = (v) => typeof v === 'string' ? v.trim() !== '' : v != null;

// `negocio`: { nombre, direccion, ciudad, rfc, telefono, whatsapp } de la
// configuración del negocio. `d`: el payload que ya arman las rutas de caja.
export function renglonesDeTicket(d, { ancho = 42, formato = null, negocio = {} } = {}) {
  const o = (formato && formato.ticket) || FORMATO_POR_DEFECTO.ticket;
  const R = [];
  const add = (...xs) => { for (const x of xs) Array.isArray(x) ? R.push(...x) : R.push(x); };
  const centro = { alinear: 'centro' };

  const nombre = negocio.nombre || d.negocio;
  if (o.negocio && lleno(nombre)) add(parrafo(String(nombre).toUpperCase(), { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
  if (o.direccion && lleno(negocio.direccion)) add(parrafo([negocio.direccion, negocio.ciudad].filter(lleno).join(', '), centro, ancho));
  if (o.rfc && lleno(negocio.rfc)) add(parrafo(`RFC: ${negocio.rfc}`, centro, ancho));
  if (o.telefono && lleno(negocio.telefono)) add(parrafo(`Tel: ${negocio.telefono}`, centro, ancho));
  if (o.whatsapp && lleno(negocio.whatsapp)) add(parrafo(`WhatsApp: ${negocio.whatsapp}`, centro, ancho));
  add(linea('='));

  if (d.precuenta) {
    add(parrafo('PRECUENTA', { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
    add(parrafo(String(d.leyenda || 'NO ES COMPROBANTE DE PAGO'), { negrita: true, alinear: 'centro' }, ancho), espacio(1));
  } else if (d.ticketPagado) {
    add(parrafo('PAGADO', { tam: 'alto', negrita: true, alinear: 'centro' }, ancho), espacio(1));
  }

  if (d.mesa != null) add(parrafo(`Mesa ${d.mesa}`, {}, ancho));
  if (lleno(d.mesero)) add(parrafo(`Le atendió: ${d.mesero}`, {}, ancho));
  if (lleno(d.folio)) add(parrafo(`Folio: ${d.folio}`, {}, ancho));
  add(parrafo(horaDe(d.emitidoAt), {}, ancho), linea('-'));

  for (const item of Array.isArray(d.items) ? d.items : []) {
    const importe = Number(item.cantidad || 0) * Number(item.precioUnitario ?? item.precio_unitario ?? 0);
    add(filaColumnas(`${item.cantidad} ${item.producto ?? item.nombre ?? ''}`, dinero(importe), {}, ancho));
    if (o.modificadores) for (const m of lineasDeModificadores(item.modificadores)) add(parrafo(m, {}, ancho, { sangria: '    ' }));
    const nota = notaSinModificadores(item.notas, item.modificadores);
    if (nota) add(parrafo(`NOTA: ${nota}`, {}, ancho, { sangria: '    ' }));
  }

  add(linea('-'));
  if (d.subtotal != null) add(filaColumnas('Subtotal', dinero(d.subtotal), {}, ancho));
  if (Number(d.descuento) > 0) {
    const motivo = d.descuentoMotivo || d.promocion;
    add(filaColumnas(motivo ? `Descuento (${motivo})` : 'Descuento', `-${dinero(d.descuento)}`, {}, ancho));
  }
  if (Number(d.propina) > 0) add(filaColumnas('Propina', dinero(d.propina), {}, ancho));
  if (d.precuenta && Number(d.pagado) > 0) {
    add(filaColumnas('Pagado', dinero(d.pagado), {}, ancho), filaColumnas('Saldo', dinero(d.saldo), {}, ancho));
  }
  add(filaColumnas('TOTAL', dinero(d.total), { tam: o.totalGrande ? 'doble' : 'alto', negrita: true }, ancho));
  for (const pago of Array.isArray(d.pagos) ? d.pagos : []) add(filaColumnas(`  ${pago.metodo}`, dinero(pago.monto), {}, ancho));
  if (Number(d.efectivoRecibido) > 0) {
    add(filaColumnas('Efectivo recibido', dinero(d.efectivoRecibido), {}, ancho), filaColumnas('Cambio', dinero(d.cambio || 0), {}, ancho));
  }

  if (d.autofacturaQr && d.autofacturaUrl) {
    add(espacio(1), parrafo('ESCANEA PARA FACTURAR', { negrita: true, alinear: 'centro' }, ancho),
      { qr: d.autofacturaQr }, parrafo('Autofactura Xabor', centro, ancho));
  }
  if (d.reimpresion) add(espacio(1), parrafo('*** REIMPRESION ***', { negrita: true, alinear: 'centro' }, ancho));
  if (lleno(o.pie)) add(espacio(1), parrafo(o.pie, centro, ancho));
  add(linea('='), espacio(3), corte());
  return R;
}
