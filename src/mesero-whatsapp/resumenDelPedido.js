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
export function resumenDelPedido(carrito, { precios = null, requierePago = true } = {}) {
  const items = (carrito?.items || []).map((i) => ({
    nombre: String(i?.nombre || ''),
    cantidad: num(i?.cantidad) ?? 1,
    opciones: opcionesDe(i),
    notas: String(i?.notas || '').trim() || null,
    precio_unitario: precios && precios[String(i?.nombre || '')] !== undefined
      ? num(precios[String(i.nombre)]) : null,
  }));
  const datos = carrito?.datos || {};
  const conPrecio = items.filter((i) => i.precio_unitario !== null);
  return {
    items,
    modalidad: datos.modalidad ?? null,
    pago: datos.forma_pago ?? null,
    cliente: datos.cliente ?? null,
    // El total solo existe si TODOS los renglones tienen precio. Un total
    // parcial es peor que ninguno: parece completo.
    total: conPrecio.length === items.length && items.length
      ? items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0) : null,
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
export const huellaDelResumen = (resumen) => JSON.stringify({
  items: (resumen?.items || []).map((i) => [i.nombre, i.cantidad,
    i.opciones.map((o) => `${o.grupo}:${o.opcion}`).sort(), i.notas || '']),
  modalidad: resumen?.modalidad ?? null,
  pago: resumen?.pago ?? null,
});

export const resumenSigueVigente = (mostrado, ahora) =>
  huellaDelResumen(mostrado) === huellaDelResumen(ahora);
