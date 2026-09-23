// ─── El resumen se construye con datos, no con memoria del modelo ─────────
//
// Módulo puro. Toma el carrito YA validado y produce la estructura del resumen.
// El modelo puede estilizarla; no puede aportar un solo dato.
//
// ── Por qué no se le pide al modelo que resuma ───────────────────────────
//
// Porque lo haría bien casi siempre, y el «casi» es el problema. Un resumen es
// lo último que el cliente lee antes de decir que sí: si ahí se cuela una
// cantidad de más o falta un «sin cebolla», el cliente confirma algo que no
// pidió y el error entra a cocina con su bendición.
//
// El resumen es la ÚLTIMA oportunidad de detectar una divergencia, y por eso
// tiene que salir del mismo sitio del que sale el pedido. Cualquier otra cosa
// convierte la confirmación en teatro.
//
// ── Y por qué igual lo puede redactar el modelo ──────────────────────────
//
// Porque estilizar no es aportar. Se le entrega esta estructura y se le pide
// que la diga como una persona; los números, los nombres y las opciones vienen
// de aquí. Si el modelo falla, `resumenEnTexto` da una versión legible.

import { calcularCostoEnvio } from '../orders/costoEnvioDelPedido.js';

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

/** Las opciones de un renglón, aplanadas y en orden estable. */
function opcionesDe(item) {
  const fuera = [];
  for (const m of (Array.isArray(item?.modificadores) ? item.modificadores : [])) {
    if (typeof m === 'string') { fuera.push({ grupo: '', opcion: m }); continue; }
    const grupo = String(m?.grupo ?? '');
    if (Array.isArray(m?.opciones)) {
      for (const o of m.opciones) fuera.push({ grupo, opcion: String(typeof o === 'string' ? o : o?.nombre || '') });
      continue;
    }
    if (m?.opcion || m?.nombre) fuera.push({ grupo, opcion: String(m.opcion || m.nombre) });
  }
  return fuera.filter((x) => x.opcion);
}

/**
 * La estructura del resumen.
 *
 * `precios` es opcional: se pasa `{ [nombre]: precio }` o se dejan fuera. El
 * resumen sin precios sigue siendo correcto; un resumen con precios inventados
 * no lo sería.
 */
export function resumenDelPedido(carrito, {
  precios = null, precioUnitario = null, requierePago = true, reglas = null, promocionesActivas = [],
} = {}) {
  const precioResuelto = (item) => {
    const valor = precioUnitario(item);
    return valor === null || valor === undefined ? null : num(valor);
  };
  const items = (carrito?.items || []).map((i) => ({
    nombre: String(i?.nombre || ''),
    cantidad: num(i?.cantidad) ?? 1,
    opciones: opcionesDe(i),
    notas: String(i?.notas || '').trim() || null,
    precio_unitario: typeof precioUnitario === 'function'
      ? precioResuelto(i)
      : precios && precios[String(i?.nombre || '')] !== undefined
        ? num(precios[String(i.nombre)]) : null,
  }));
  const datos = carrito?.datos || {};
  const conPrecio = items.filter((i) => i.precio_unitario !== null);
  const subtotal = conPrecio.length === items.length && items.length
    ? items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0) : null;
  const costo_envio = subtotal === null ? null : calcularCostoEnvio({
    reglas, modalidad: datos.modalidad, subtotal,
    costoSolicitado: datos.costo_envio, promocionesActivas,
  });
  return {
    items,
    modalidad: datos.modalidad ?? null,
    pago: datos.forma_pago ?? null,
    programado_para: datos.programado_para ?? null,
    cliente: datos.cliente ?? null,
    // El total solo existe si TODOS los renglones tienen precio. Un total
    // parcial es peor que ninguno: parece completo.
    subtotal,
    costo_envio,
    total: subtotal === null ? null : subtotal + costo_envio,
    completo: items.length > 0 && !!datos.modalidad && (!requierePago || !!datos.forma_pago),
  };
}

/** La versión legible, de respaldo. El modelo lo dirá mejor; esto no falla. */
export function resumenEnTexto(resumen) {
  if (!resumen?.items?.length) return 'Todavía no tengo nada anotado.';
  const lineas = ['Tu pedido:', ''];
  for (const i of resumen.items) {
    lineas.push(`${i.cantidad}× ${i.nombre}`);
    for (const o of i.opciones) lineas.push(`- ${o.opcion}`);
    if (i.notas) lineas.push(`- nota: ${i.notas}`);
    lineas.push('');
  }
  if (resumen.modalidad) lineas.push(String(resumen.modalidad));
  if (resumen.pago) lineas.push(`Pago: ${resumen.pago}`);
  if (resumen.subtotal !== null && resumen.costo_envio) lineas.push(`Subtotal: $${resumen.subtotal}`);
  if (resumen.costo_envio) lineas.push(`Envío: $${resumen.costo_envio}`);
  if (resumen.total !== null) lineas.push(`Total: $${resumen.total}`);
  return lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * ¿El resumen que se le enseñó al cliente sigue describiendo el pedido?
 *
 * Se compara la huella de lo que se mostró contra la del carrito de ahora. Es
 * la protección que ya existe en `session.previewPedido` para el borrador,
 * traída al resumen del mesero: si entre el resumen y el «sí» cambió algo, ese
 * sí no vale para lo que hay ahora.
 */
/**
 * ─── LOS CAMPOS DEL CLIENTE QUE SON PARTE DEL PEDIDO ────────────────────
 *
 * La huella nació mirando items, modalidad y pago. El cliente se quedó fuera,
 * y con él la dirección: se le enseñaba el resumen, cambiaba de calle, decía
 * «sí», y la huella seguía coincidiendo. Confirmaba un pedido que ya no iba
 * a donde él creía.
 *
 * La lista es CERRADA y sale de contar lo que produccion guarda de verdad, no
 * de imaginar qué podría llevar una dirección:
 *
 *   nombre 319 · telefono 295 · calle 167 · colonia 167 · entre_calles 167
 *   numero_interior 49 · referencia 49 · numero_exterior 49 · direccion 1
 *
 * Los nueve son operativos —los lee la comanda o el repartidor—, así que los
 * nueve invalidan. Y es una lista y no el objeto entero a propósito: con un
 * `JSON.stringify(cliente)`, el día que alguien cuelgue ahí un identificador
 * interno o una marca de origen, se caerían todas las confirmaciones en vuelo
 * sin que nada del pedido hubiera cambiado. La huella representa el pedido,
 * no el objeto que lo transporta.
 */
const CAMPOS_DEL_CLIENTE = ['nombre', 'telefono', 'calle', 'numero_exterior',
  'numero_interior', 'colonia', 'entre_calles', 'referencia', 'direccion'];

// Para comparar, no para guardar: mayúsculas, acentos y puntuación no son un
// cambio de pedido. «Av. Reforma 200» y «av reforma #200» son la misma
// esquina; «Reforma 200» y «Reforma 2000» no lo son, y por eso los dígitos se
// conservan enteros en vez de tocarlos.
const enForma = (v) => String(v ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const huellaDelResumen = (resumen) => JSON.stringify({
  items: (resumen?.items || []).map((i) => [i.nombre, i.cantidad,
    i.opciones.map((o) => `${o.grupo}:${o.opcion}`).sort(), i.notas || '', i.precio_unitario]),
  modalidad: resumen?.modalidad ?? null,
  pago: resumen?.pago ?? null,
  // Un pedido para manana y el mismo pedido para hoy NO son el mismo
  // pedido. Sin esto, el cliente podria confirmar un resumen y que la
  // fecha cambiara despues sin que la huella se enterara.
  programado_para: resumen?.programado_para ?? null,
  cliente: CAMPOS_DEL_CLIENTE.map((c) => enForma(resumen?.cliente?.[c])),
  subtotal: resumen?.subtotal ?? null,
  costo_envio: resumen?.costo_envio ?? null,
  total: resumen?.total ?? null,
});

export const resumenSigueVigente = (mostrado, ahora) =>
  huellaDelResumen(mostrado) === huellaDelResumen(ahora);
