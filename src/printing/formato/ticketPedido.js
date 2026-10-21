// ─── Ticket del cliente de un PEDIDO (cobro y botón 🧾), armado en el servidor ─
//
// Hasta el 21-oct-2026 este ticket lo imprimía el navegador del panel
// (ticketHTML), con su propio diseño, mientras el Edge imprimía el resto con
// el diseño de «Diseño de ticket y comanda». Mario: «no podemos tener un
// ticket automático de una forma y un ticket manual de otra». Este armado
// lleva lo MISMO que llevaba el del navegador (número de orden, canal,
// cliente, forma de pago, artículos, Gran Total con el monto en letra, pago,
// datos de entrega y QR de autofactura) y respeta las opciones del ticket:
// encabezado del negocio, desglose de opciones, total grande y pie.
//
// `d` lo arma datosDeTicketDePedido (abajo) con el pedido de pedidos_activos.
import { parrafo, filaColumnas, linea, espacio, corte, columnasDisponibles, envolver, estiloLimpio } from './maquetador.js';
import { FORMATO_POR_DEFECTO } from './opciones.js';
import { lineasDeModificadores, notaSinModificadores } from '../../../edge/renderers/modificadores.js';
import { textoTermico } from '../../../edge/renderers/escpos.js';
import { numeroDeOrden } from './comanda.js';

// ── Lo mismo que calculaba el panel (index.html) para su ticket ────────────

const UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE'];
const VEINTIS = { 21: 'VEINTIÚN', 22: 'VEINTIDÓS', 23: 'VEINTITRÉS', 24: 'VEINTICUATRO', 25: 'VEINTICINCO', 26: 'VEINTISÉIS', 27: 'VEINTISIETE', 28: 'VEINTIOCHO', 29: 'VEINTINUEVE' };
const DECENAS = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

export function enLetras(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'CERO';
  if (n === 100) return 'CIEN';
  let r = '';
  if (n >= 1000) { const m = Math.floor(n / 1000); r += (m === 1 ? 'MIL' : `${enLetras(m)} MIL`); n %= 1000; if (n > 0) r += ' '; }
  if (n === 100) return `${r}CIEN`;
  if (n >= 100) { r += CENTENAS[Math.floor(n / 100)]; n %= 100; if (n > 0) r += ' '; }
  if (n > 0) {
    if (n <= 20) r += UNIDADES[n];
    else if (VEINTIS[n]) r += VEINTIS[n];
    else { r += DECENAS[Math.floor(n / 10)]; const u = n % 10; if (u) r += ` Y ${UNIDADES[u]}`; }
  }
  return r.trim();
}

// «DOSCIENTOS VEINTICINCO PESOS 50/100 M.N.» (el navegador redondeaba y
// siempre ponía 00/100).
export function montoEnLetra(total) {
  const centavos = Math.round(Math.abs(Number(total) || 0) * 100);
  return `${enLetras(Math.floor(centavos / 100))} PESOS ${String(centavos % 100).padStart(2, '0')}/100 M.N.`;
}

const CANALES = { presencial: 'Presencial', rappi: 'Rappi', whatsapp: 'WhatsApp', tienda_online: 'Tienda en línea' };

function formaDePago(p) {
  const crudo = (p.forma_pago === 'por_cobrar' && p.pago_confirmado !== true) ? '' : (p.forma_pago || p.cliente?.forma_pago || p.pago || '');
  if (!crudo) return '';
  if (crudo === 'enlace_pago' || crudo.startsWith('enlace_pago ')) {
    return p.pago_confirmado === true ? 'Tarjeta en línea · Pagado' : 'Tarjeta en línea · Pendiente';
  }
  if (crudo.startsWith('efectivo')) return 'Efectivo';
  if (crudo.startsWith('terminal')) return 'Terminal';
  if (crudo.startsWith('transferencia')) return 'Transferencia';
  if (crudo === 'rappi') return 'Rappi';
  if (crudo === 'mixto') return 'Mixto';
  return crudo;
}

export function lineasDeDireccion(c) {
  if (!c || typeof c !== 'object') return [];
  if (c.direccion) return [c.direccion, c.referencias ? `Referencias: ${c.referencias}` : null].filter(Boolean);
  return [
    c.calle, c.numero_exterior ? `#${c.numero_exterior}` : null, c.colonia ? `Col. ${c.colonia}` : null,
    c.entre_calles ? `Entre: ${c.entre_calles}` : null, c.referencia ? `Referencias: ${c.referencia}` : null,
  ].filter(Boolean);
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

export function datosDeTicketDePedido(p, { ahora = new Date(), autofactura = null } = {}) {
  const esPresencial = p.canal === 'presencial';
  const esEntrega = p.modalidad === 'entrega a domicilio';
  const nombre = typeof p.cliente === 'string' ? p.cliente : (p.cliente?.nombre || p.nombre || 'Sin nombre');
  const telefono = p.cliente?.telefono || p.telefono || null;
  const items = (Array.isArray(p.items) ? p.items : []).map((i) => {
    const cantidad = Number(i?.cantidad) || 1;
    return {
      cantidad,
      nombre: String(i?.nombre || i?.name || i?.producto || 'Producto'),
      importe: num(i?.precio_unitario || i?.precio) * cantidad,
      modificadores: Array.isArray(i?.modificadores) ? i.modificadores : [],
      notas: i?.notas || null,
    };
  });
  const total = num(p.total);
  return {
    orden: numeroDeOrden(p.id),
    canal: esPresencial ? 'Presencial' : (CANALES[p.canal] || p.canal || 'Sistema'),
    modalidad: esPresencial ? 'EN TIENDA · PRESENCIAL' : (esEntrega ? 'ENTREGA A DOMICILIO' : 'RECOGER EN TIENDA'),
    entradaAt: p.timestamp || null,
    impresoAt: ahora.toISOString(),
    cliente: {
      nombre,
      telefono: telefono && telefono !== '—' && !/^rappi-/i.test(String(telefono)) ? String(telefono) : null,
      direccion: esEntrega ? lineasDeDireccion(p.cliente) : [],
    },
    esEntrega,
    formaPago: formaDePago(p),
    items,
    envio: num(p.costo_envio),
    descuento: num(p.descuento),
    motivoDescuento: p.motivo_descuento || null,
    articulos: items.reduce((s, i) => s + i.cantidad, 0),
    total,
    totalEnLetra: montoEnLetra(total),
    billete: num(p.billete),
    cambio: num(p.cambio),
    mixtoEfectivo: num(p.mixto_efectivo),
    mixtoTerminal: num(p.mixto_terminal),
    autofacturaQr: autofactura?.qr || null,
    autofacturaUrl: autofactura?.url || null,
  };
}

// El trabajo lleva, además de `ticketDePedido` (el que usa el formato v1), los
// campos de siempre de una cuenta: si por algo lo imprimiera un Edge viejo,
// sale un ticket legible.
export function payloadDeTicketDePedido(d, { folio, negocio }) {
  return {
    negocio: negocio || null,
    folio,
    items: d.items.map((i) => ({
      cantidad: i.cantidad, producto: i.nombre, precioUnitario: i.cantidad ? i.importe / i.cantidad : i.importe,
      modificadores: i.modificadores, notas: i.notas,
    })),
    descuento: d.descuento, descuentoMotivo: d.motivoDescuento, total: d.total,
    efectivoRecibido: d.billete || null, cambio: d.cambio || null,
    ticketDePedido: d,
  };
}

const ZONA = 'America/Matamoros';
const dinero = (n) => `$${Number(n || 0).toFixed(2)}`;
const lleno = (v) => typeof v === 'string' ? v.trim() !== '' : v != null;

export function fechaDeTicket(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d);
}

// Un platillo con su importe: el nombre se envuelve (no se recorta, como en el
// navegador) y el importe va pegado a la derecha del primer renglón.
function platilloConImporte(izq, der, ancho) {
  const e = estiloLimpio({});
  const cols = columnasDisponibles(ancho, e);
  const importe = textoTermico(der).slice(0, cols);
  const lineas = envolver(textoTermico(izq), Math.max(8, cols - importe.length - 1), '  ');
  return lineas.map((t, i) => ({
    texto: i === 0 ? t + ' '.repeat(Math.max(1, cols - t.length - importe.length)) + importe : t,
    ...e,
  }));
}

export function renglonesDeTicketDePedido(d, { ancho = 42, formato = null, negocio = {} } = {}) {
  const o = (formato && formato.ticket) || FORMATO_POR_DEFECTO.ticket;
  const R = [];
  const add = (...xs) => { for (const x of xs) Array.isArray(x) ? R.push(...x) : R.push(x); };
  const centro = { alinear: 'centro' };

  // Encabezado del negocio, como en Configuración.
  const nombre = negocio.nombreCorto || negocio.nombre || d.negocio;
  if (o.negocio && lleno(nombre)) add(parrafo(String(nombre).toUpperCase(), { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
  add(parrafo(`TICKET DE CLIENTE · ${d.canal || 'Sistema'}`, { negrita: true, alinear: 'centro' }, ancho));
  if (o.negocio && lleno(negocio.nombre) && negocio.nombre !== nombre) add(parrafo(String(negocio.nombre).toUpperCase(), centro, ancho));
  if (o.direccion && lleno(negocio.direccion)) add(parrafo([negocio.direccion, negocio.ciudad].filter(lleno).join(', '), centro, ancho));
  if (o.rfc && lleno(negocio.rfc)) add(parrafo(`RFC: ${negocio.rfc}`, centro, ancho));
  if (o.telefono && lleno(negocio.telefono)) add(parrafo(`Tel: ${negocio.telefono}`, centro, ancho));
  add(linea('='));

  // La orden, grande, y cuándo.
  if (lleno(d.orden)) add(parrafo(`ORDEN ${d.orden}`, { tam: 'doble', negrita: true }, ancho));
  add(filaColumnas('Hora de entrada:', fechaDeTicket(d.entradaAt), {}, ancho));
  add(filaColumnas('Impreso:', fechaDeTicket(d.impresoAt), {}, ancho));
  if (lleno(d.modalidad)) add(parrafo(d.modalidad, { negrita: true, invertido: true, alinear: 'centro' }, ancho));
  add(filaColumnas('Cliente:', d.cliente?.nombre || 'Sin nombre', { negrita: true }, ancho));
  add(filaColumnas('Forma de pago:', d.formaPago || '-', {}, ancho));
  add(linea('-'));

  // Lo pedido.
  add(filaColumnas('CANT DESCRIPCIÓN', 'IMPORTE', { negrita: true }, ancho));
  for (const item of Array.isArray(d.items) ? d.items : []) {
    add(platilloConImporte(`${item.cantidad} ${item.nombre}`, Number(item.importe) > 0 ? dinero(item.importe) : '-', ancho));
    if (o.modificadores) for (const m of lineasDeModificadores(item.modificadores)) add(parrafo(m, {}, ancho, { sangria: '    ' }));
    const nota = o.modificadores ? notaSinModificadores(item.notas, item.modificadores) : (lleno(item.notas) ? item.notas : null);
    if (nota) add(parrafo(nota, {}, ancho, { sangria: '    ' }));
  }
  if (Number(d.envio) > 0) add(filaColumnas('Costo de envío', dinero(d.envio), {}, ancho));
  if (Number(d.descuento) > 0) add(filaColumnas(d.motivoDescuento ? `Descuento (${d.motivoDescuento})` : 'Descuento', `-${dinero(d.descuento)}`, {}, ancho));
  add(parrafo(`Artículos: ${d.articulos ?? 0}`, {}, ancho));
  add(linea('-'));

  // Total, en número y en letra.
  add(filaColumnas('GRAN TOTAL', dinero(d.total), { tam: o.totalGrande ? 'doble' : 'alto', negrita: true }, ancho));
  if (lleno(d.totalEnLetra)) add(parrafo(d.totalEnLetra, centro, ancho));

  // Cómo se pagó.
  if (Number(d.mixtoEfectivo) > 0 || Number(d.mixtoTerminal) > 0) {
    add(espacio(1), parrafo('TOTAL POR FORMA DE PAGO', { negrita: true }, ancho),
      filaColumnas('Efectivo', dinero(d.mixtoEfectivo), {}, ancho), filaColumnas('Terminal', dinero(d.mixtoTerminal), {}, ancho));
    if (Number(d.cambio) > 0) add(filaColumnas('Cambio', dinero(d.cambio), {}, ancho));
  } else if (Number(d.billete) > 0) {
    add(espacio(1), filaColumnas('Billete', dinero(d.billete), {}, ancho), filaColumnas('Cambio', dinero(d.cambio), {}, ancho));
  }

  // A quién se entrega.
  if (d.esEntrega && d.cliente) {
    add(linea('-'), parrafo('DATOS DEL CLIENTE', { negrita: true }, ancho));
    add(parrafo(`Nombre: ${d.cliente.nombre || 'Sin nombre'}`, {}, ancho));
    for (const l of Array.isArray(d.cliente.direccion) ? d.cliente.direccion : []) add(parrafo(l, {}, ancho, { sangria: '  ' }));
    if (lleno(d.cliente.telefono)) add(parrafo(`Teléfono: ${d.cliente.telefono}`, {}, ancho));
  } else if (lleno(d.cliente?.telefono)) {
    add(parrafo(`Teléfono: ${d.cliente.telefono}`, {}, ancho));
  }

  if (d.autofacturaQr && d.autofacturaUrl) {
    add(espacio(1), parrafo('ESCANEA PARA FACTURAR', { negrita: true, alinear: 'centro' }, ancho),
      { qr: d.autofacturaQr }, parrafo('Autofactura Xabor', centro, ancho));
  }
  if (lleno(o.pie)) add(espacio(1), parrafo(o.pie, centro, ancho));
  if (o.whatsapp && lleno(negocio.whatsapp)) add(parrafo(`WhatsApp: ${negocio.whatsapp}`, centro, ancho));
  add(linea('='), espacio(3), corte());
  return R;
}
