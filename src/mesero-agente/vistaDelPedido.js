// ─── LA VISTA DEL PEDIDO: la única fuente de verdad ───────────────────────
//
// Todo lo que el modelo sabe del pedido sale de aquí, y esta función no sabe
// nada del modelo: lee el carrito real y el catálogo real y describe lo que
// hay. Se vuelve a llamar DESPUÉS de cada mutación, y lo que se le manda al
// modelo es el resultado de esa relectura — nunca lo que la mutación dijo que
// iba a pasar.
//
// ── Una simplificación que la arquitectura nueva regala ──────────────────
//
// Antes había cuatro tipos de aclaración abierta: producto ambiguo, producto
// inexistente, término ambiguo y grupo requerido. Las tres primeras existían
// porque el modelo metía al carrito un NOMBRE («chilaquiles») y había que
// averiguar después cuál de los cuatro chilaquiles de la carta era.
//
// Con `agregar_producto` exigiendo un `producto_id` REAL, un renglón ambiguo
// ya no puede nacer: la ambigüedad se resuelve ANTES, en `buscar_producto`,
// que devuelve los candidatos y obliga al modelo a preguntar. Lo que queda es
// el grupo obligatorio sin elegir, deducido del carrito y la carta. Además,
// una mención ambigua explícita se conserva como pendiente durable: cumplir
// el mínimo del grupo no demuestra que se atendieron todas las elecciones.
import { productosVendibles, fichaDeProducto } from '../mesero-whatsapp/consultasDelMenu.js';
import { resumenDelPedido, huellaDelResumen } from '../mesero-whatsapp/resumenDelPedido.js';
import { estadoDelPedido, queFaltaParaConfirmar } from './maquinaDeEstados.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** La ficha REAL de un producto, por id o por nombre canónico. */
export function fichaPorId(catalogo, productoId) {
  const p = productosVendibles(catalogo).find((x) => String(x.id) === String(productoId));
  return p ? fichaDeProducto(p) : null;
}

export function fichaPorNombre(catalogo, nombre) {
  const p = productosVendibles(catalogo).find((x) => norm(x.nombre) === norm(nombre));
  return p ? fichaDeProducto(p) : null;
}

/** Las opciones elegidas de un renglón, aplanadas a `{grupo, opcion}`. */
export function opcionesDeLinea(item) {
  const fuera = [];
  for (const g of (item?.modificadores || [])) {
    for (const o of (g?.opciones || [])) {
      fuera.push({ grupo: String(g?.grupo ?? g?.nombre ?? ''), opcion: String(typeof o === 'string' ? o : o?.nombre ?? '') });
    }
  }
  return fuera.filter((x) => x.opcion);
}

/**
 * Precio real del renglón: base del producto más las opciones seleccionadas.
 * Si una opción guardada ya no existe, no se muestra un total parcial.
 */
export function precioUnitarioDeLinea(item, catalogo, precios = null) {
  const ficha = fichaPorNombre(catalogo, item?.nombre);
  if (!ficha) return null;
  const hayMapa = precios && typeof precios === 'object';
  if (hayMapa && precios[String(item?.nombre || '')] === undefined) return null;
  const base = hayMapa ? Number(precios[String(item.nombre)]) : Number(ficha.precio);
  if (!Number.isFinite(base)) return null;

  let extras = 0;
  for (const elegida of opcionesDeLinea(item)) {
    const grupo = (ficha.grupos || []).find((g) => norm(g.nombre) === norm(elegida.grupo));
    if (!grupo) return null;
    const opcion = (grupo.opciones || []).find((o) => norm(o.nombre) === norm(elegida.opcion));
    if (!opcion) return null;
    extras += Number(opcion.precio_extra) || 0;
  }
  return Math.round((base + extras) * 100) / 100;
}

/**
 * LOS GRUPOS OBLIGATORIOS QUE ESTE RENGLÓN TODAVÍA NO HA ELEGIDO.
 *
 * Deducido, no recordado. Si el renglón no corresponde a ningún producto de la
 * carta se devuelve vacío: eso no debería poder pasar —`agregar_producto`
 * exige un id real— y si pasa, el sitio donde se detecta es la validación de
 * la mutación, no aquí.
 */
export function gruposSinElegir(item, catalogo) {
  const ficha = fichaPorNombre(catalogo, item?.nombre);
  if (!ficha) return [];
  const puestas = opcionesDeLinea(item);
  return (ficha.grupos || [])
    .filter((g) => g.requerido || (Number(g.minimo) || 0) > 0)
    .filter((g) => !puestas.some((p) => norm(p.grupo) === norm(g.nombre)))
    .map((g) => ({
      grupo: g.nombre,
      minimo: Number(g.minimo) || 1,
      maximo: g.maximo,
      opciones: (g.opciones || []).map((o) => o.nombre),
    }));
}

/**
 * LA VISTA COMPLETA. Es lo que devuelve `ver_pedido` y lo que se recalcula
 * después de cada mutación.
 */
export function vistaDelPedido({ carrito = null, catalogo = [], precios = null,
  requierePago = true, hechos = {}, reglas = null, promocionesActivas = [], opcionesPendientes = [] } = {}) {
  const items = Array.isArray(carrito?.items) ? carrito.items : [];
  const precioUnitario = (item) => precioUnitarioDeLinea(item, catalogo, precios);

  const lineas = items.map((i) => {
    const falta = gruposSinElegir(i, catalogo);
    return {
      linea_id: i.lid,
      producto: String(i.nombre || ''),
      cantidad: Number(i.cantidad) || 1,
      opciones: opcionesDeLinea(i),
      nota: String(i.notas || '').trim() || null,
      precio_unitario: precioUnitario(i),
      falta_elegir: falta,
    };
  });

  const aclaraciones = lineas.flatMap((l) => l.falta_elegir.map((g) => ({
    tipo: 'grupo_requerido',
    lid: l.linea_id,
    producto: l.producto,
    grupo: g.grupo,
    maximo: g.maximo,
    candidatos: g.opciones,
  })));

  // El mínimo del catálogo no borra una segunda elección que el cliente pidió.
  for (const pendiente of opcionesPendientes) {
    const linea = lineas.find((l) => l.linea_id === pendiente.lid);
    if (!linea || linea.opciones.some((o) => norm(o.grupo) === norm(pendiente.grupo)
      && pendiente.candidatos.some((c) => norm(c) === norm(o.opcion)))) continue;
    const indice = aclaraciones.findIndex((a) => a.tipo === 'grupo_requerido' && a.lid === pendiente.lid
      && norm(a.grupo) === norm(pendiente.grupo));
    if (indice >= 0) aclaraciones.splice(indice, 1, { ...pendiente, tipo: 'eleccion_ambigua' });
    else aclaraciones.unshift({ ...pendiente, tipo: 'eleccion_ambigua' });
  }

  const resumen = resumenDelPedido(carrito, {
    precios, precioUnitario, requierePago, reglas, promocionesActivas,
  });
  if (aclaraciones.length) resumen.completo = false;
  const estado = estadoDelPedido({ carrito, aclaraciones, requierePago, hechos });
  const falta = queFaltaParaConfirmar({ carrito, aclaraciones, requierePago });

  const datos = carrito?.datos || {};
  return {
    estado,
    lineas,
    aclaraciones,
    falta,
    modalidad: datos.modalidad ?? null,
    forma_pago: datos.forma_pago ?? null,
    programado_para: datos.programado_para ?? null,
    cliente: datos.cliente ?? null,
    subtotal: resumen.subtotal,
    costo_envio: resumen.costo_envio,
    // El total solo existe si TODOS los renglones tienen precio. Un total
    // parcial parece completo, y es la clase de dato con el que se cobra de
    // menos. La regla vive en `resumenDelPedido` y aquí solo se repite el
    // valor, no el criterio.
    total: resumen.total,
    // La huella es de lo que el cliente LEE. `confirmar_pedido` la exige, así
    // que si algo del pedido cambia entre el resumen y el «sí», ese sí ya no
    // vale para lo que hay ahora — sin que nadie tenga que acordarse.
    huella: huellaDelResumen(resumen),
    resumen,
  };
}
