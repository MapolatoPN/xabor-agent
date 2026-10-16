// ─── Precuentas de una cuenta dividida por consumo ─────────────────────────
//
// Pedido de los meseros (15-oct-2026): una mesa de 8 que pide la cuenta
// dividida necesita 8 papeles, cada uno con lo que consumió esa persona, para
// enseñárselo antes de cobrar. La división por consumo ya existía (083); lo
// que no existía era imprimirla.
//
// Reglas:
//   · el importe de cada papel es el MISMO que cobraría la caja con esa
//     selección: importeDePorcion sobre el neto prorrateado
//     (divisionConsumo.js). Una precuenta con otra cifra que el cobro sería
//     peor que no tenerla;
//   · solo imprime: no cobra, no reserva y no toma el lock de la cuenta. La
//     selección sigue libre y otra caja puede cobrarla;
//   · con la selección por producto cerrada (remanente dividido o un pago
//     suelto) no se imprime por consumo: los renglones ya no dicen lo que
//     falta por pagar (REMANENTE_DIVIDIDO, el mismo motivo que da el cobro);
//   · el papel usa SOLO campos que el renderer del Edge instalado ya imprime
//     (precuenta, leyenda, items con modificadores, subtotal, descuento,
//     total). El Edge no se actualiza solo: un campo nuevo no saldría en
//     papel. Por eso la persona va en la leyenda y la fracción de un
//     platillo compartido, como modificador.
import { obtenerCuenta, estadoDivision } from './restauranteService.js';
import {
  UNO, fraccion, sumar, restar, comparar, esCero, aCentavos, aPesos, importeDePorcion,
} from './divisionConsumo.js';

function errorCodigo(mensaje, code, detalle = null) {
  return Object.assign(new Error(mensaje), { code, ...(detalle ? { detalle } : {}) });
}

const pendienteDe = (r) => fraccion(r.pendienteNum, r.pendienteDen);

// El Edge escribe el texto en latin1 byte a byte: un carácter fuera de
// latin1 sale como su byte bajo, y una raya «—» (U+2014) llega a la
// impresora como 0x14, un código de control. Se cambia la raya por guion y
// se quita lo demás que no cabe en latin1.
export function textoTermico(s, max = 48) {
  return String(s ?? '')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function etiquetaPersona(persona) {
  if (!persona) return 'Sin asignar';
  const nombre = textoTermico(persona.nombre, 40);
  return `Orden ${persona.numero}${nombre ? ` - ${nombre}` : ''}`;
}

/**
 * La selección del cuerpo, validada contra lo pendiente de la división.
 * Mismo formato que acepta el cobro por consumo: 'resto', o una lista de
 * {itemId, numerador, denominador} | {itemId, cantidad}. Devuelve
 * Map(itemId → fracción).
 */
export function seleccionDesdeCuerpo(division, seleccion) {
  const porId = new Map(division.renglones.map(r => [r.id, r]));
  const pedidas = new Map();
  if (seleccion === 'resto') {
    for (const r of division.renglones) {
      const p = pendienteDe(r);
      if (!esCero(p)) pedidas.set(r.id, p);
    }
  } else {
    for (const s of (Array.isArray(seleccion) ? seleccion : [])) {
      const r = porId.get(String(s?.itemId || ''));
      if (!r) throw errorCodigo('Un producto de la selección no está en la cuenta', 'ITEM_INVALIDO');
      let f;
      if (s.cantidad !== undefined && s.cantidad !== null) {
        const n = Number(s.cantidad);
        if (!Number.isInteger(n) || n < 1 || n > r.cantidad) throw errorCodigo(`Cantidad inválida para ${r.producto}`, 'FRACCION_INVALIDA');
        f = fraccion(n, r.cantidad);
      } else {
        f = fraccion(s.numerador, s.denominador);
      }
      if (esCero(f)) continue;
      pedidas.set(r.id, pedidas.has(r.id) ? sumar(pedidas.get(r.id), f) : f);
    }
  }
  for (const [id, f] of pedidas) {
    const r = porId.get(id);
    if (comparar(f, pendienteDe(r)) > 0) {
      throw errorCodigo(`${r.producto}: ya se cobró ${r.fraccionCobrada} y solo queda ${r.fraccionPendiente}`, 'CONSUMO_YA_PAGADO',
        { itemId: r.id, producto: r.producto, pendiente: r.fraccionPendiente });
    }
  }
  if (!pedidas.size) throw errorCodigo('La selección está vacía', 'SELECCION_VACIA');
  return pedidas;
}

// Una porción en el papel. Unidades enteras (2 de 3 tacos) salen como
// cantidad × precio de lista; una fracción que no es un número entero de
// unidades (media orden compartida) sale como un renglón con su importe y la
// fracción como modificador. El neto es SIEMPRE importeDePorcion: lo que
// cobra la caja. El bruto es neto + su parte del descuento, para que
// subtotal - descuento = total cierre al centavo en el papel.
function lineaDePorcion(r, f) {
  const pendiente = pendienteDe(r);
  const netoCentavos = importeDePorcion({ netoCentavos: r.netoCentavos, cobradoCentavos: r.cobradoCentavos, pendiente, fraccion: f });
  const modificadores = Array.isArray(r.modificadores) ? r.modificadores : [];
  const base = { producto: r.producto, modificadores, notas: r.notas || null };
  const unidades = (f.num * r.cantidad) % f.den === 0 ? (f.num * r.cantidad) / f.den : null;
  if (unidades !== null) {
    const brutoCentavos = unidades * aCentavos(r.precioUnitario);
    // Con porciones previas de fracciones sueltas, la que completa el
    // renglón puede llevarse un centavo más que su precio de lista; entonces
    // no se puede mostrar como «cantidad × precio» sin mentir en un centavo.
    if (brutoCentavos >= netoCentavos) {
      return { item: { ...base, cantidad: unidades, precioUnitario: r.precioUnitario }, brutoCentavos, netoCentavos };
    }
  }
  const descuentoRenglon = Math.max(0, r.brutoCentavos - r.netoCentavos);
  const cobrada = restar(UNO, pendiente);
  const descuentoPorcion = comparar(f, pendiente) === 0
    ? descuentoRenglon - Math.floor(descuentoRenglon * cobrada.num / cobrada.den)
    : Math.floor(descuentoRenglon * f.num / f.den);
  const brutoCentavos = netoCentavos + descuentoPorcion;
  const parte = `Compartido: ${f.num}/${f.den}${r.cantidad > 1 ? ` de ${r.cantidad}` : ''}`;
  return {
    item: { ...base, cantidad: 1, precioUnitario: aPesos(brutoCentavos), modificadores: [parte, ...modificadores] },
    brutoCentavos, netoCentavos,
  };
}

/**
 * El documento 'cuenta' de UNA persona: precuenta con solo su selección.
 * Puro: recibe la división ya leída y la cuenta (mesa, mesero).
 */
export function precuentaDeSeleccion(division, pedidas, { cuenta, negocio = null, etiqueta = null } = {}) {
  const lineas = division.renglones.filter(r => pedidas.has(r.id)).map(r => lineaDePorcion(r, pedidas.get(r.id)));
  const subtotal = lineas.reduce((s, l) => s + l.brutoCentavos, 0);
  const total = lineas.reduce((s, l) => s + l.netoCentavos, 0);
  const descuento = subtotal - total;
  const motivo = descuento > 0 ? (division.descuento?.motivo || null) : null;
  const titulo = textoTermico(etiqueta, 48) || 'Cuenta dividida';
  return {
    precuenta: true,
    leyenda: `${titulo.toUpperCase()} - NO ES COMPROBANTE DE PAGO`,
    negocio,
    mesa: cuenta.mesa,
    personas: cuenta.personas,
    mesero: cuenta.mesero?.nombre || null,
    items: lineas.map(l => l.item),
    subtotal: aPesos(subtotal),
    descuento: aPesos(descuento),
    descuentoMotivo: motivo,
    promocion: motivo,
    pagado: 0,
    saldo: aPesos(total),
    propina: 0,
    total: aPesos(total),
    pagos: [],
    // Lo lee la pantalla; el renderer del Edge lo ignora.
    division: { etiqueta: titulo, totalCuenta: division.total, saldoCuenta: division.saldo },
  };
}

/**
 * Lo pendiente agrupado por la «Orden N» con que se capturó cada renglón;
 * lo que no tiene persona va al final como «Sin asignar». Lo ya pagado no
 * sale.
 */
export function gruposPorPersona(division) {
  const grupos = new Map();
  for (const r of division.renglones) {
    const p = pendienteDe(r);
    if (esCero(p)) continue;
    const numero = r.persona?.numero || 0;
    if (!grupos.has(numero)) grupos.set(numero, { persona: null, pedidas: new Map() });
    const g = grupos.get(numero);
    // El nombre puede venir solo en algunos renglones de la misma orden.
    if (r.persona && (!g.persona || (!g.persona.nombre && r.persona.nombre))) g.persona = r.persona;
    g.pedidas.set(r.id, p);
  }
  return [...grupos.entries()]
    .sort(([a], [b]) => (a || 1000) - (b || 1000))
    .map(([, g]) => g);
}

/**
 * Lee la cuenta y su división y arma las precuentas pedidas:
 *   · modo 'seleccion': una, con `seleccion` (lo que consumió una persona);
 *   · modo 'personas': una por cada «Orden N» con algo pendiente, más una de
 *     lo que no se asignó a nadie.
 * Devuelve la lista de payloads del documento 'cuenta'.
 */
export async function precuentasDeDivision(cuentaId, negocioId, { modo, seleccion, etiqueta = null, negocio = null } = {}) {
  if (modo !== 'seleccion' && modo !== 'personas') throw errorCodigo('Modo de impresión no válido', 'MODO_INVALIDO');
  const cuenta = await obtenerCuenta(cuentaId, negocioId);
  if (!cuenta) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
  if (cuenta.estado !== 'abierta') throw errorCodigo('La cuenta ya no está abierta', 'CUENTA_NO_ABIERTA');
  const division = await estadoDivision(cuentaId, negocioId);
  if (division.consumoBloqueado) throw errorCodigo(division.motivoBloqueo, 'REMANENTE_DIVIDIDO');

  if (modo === 'seleccion') {
    const pedidas = seleccionDesdeCuerpo(division, seleccion);
    return [precuentaDeSeleccion(division, pedidas, { cuenta, negocio, etiqueta })];
  }
  const grupos = gruposPorPersona(division);
  if (!grupos.some(g => g.persona)) {
    throw errorCodigo('Los productos no se capturaron por persona: usa «Imprimir selección»', 'SIN_PERSONAS');
  }
  return grupos.map(g => precuentaDeSeleccion(division, g.pedidas, { cuenta, negocio, etiqueta: etiquetaPersona(g.persona) }));
}
