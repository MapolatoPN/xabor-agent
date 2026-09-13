// ─── Recomendar como un mesero, no como un banner ─────────────────────────
//
// Módulo puro. Decide QUÉ se puede recomendar y, sobre todo, CUÁNDO no.
//
// ── Todo sale de datos del negocio ───────────────────────────────────────
//
// Ninguna relación entre productos está escrita aquí. «Hotcakes van con café»
// puede ser cierto en un negocio y ridículo en otro, y en cuanto se escribe una
// vez hay que mantenerla para siempre y para todos. Las fuentes son:
//
//   destacado          la casilla que el negocio ya marca en su menú
//   promociones        `tienda_promociones`, vigentes
//   complementos       configuración del negocio: qué categoría acompaña a cuál
//   popularidad        lo más pedido, si alguien lo calcula y lo pasa
//
// Sin ninguna de las cuatro, se recomienda lo destacado y ya. Un mesero que no
// conoce la casa tampoco improvisa.
//
// ── Y NADA de lo que recomienda entra al pedido ──────────────────────────
//
// Cada recomendación se registra como PROPUESTA (`propuestasDelBot`). Entra al
// pedido cuando el cliente la acepta de forma inequívoca, y entonces entra por
// donde entra todo: el reconciliador, con la evidencia que ese sí produjo.
//
// ── La moderación es la mitad del trabajo (fase N) ───────────────────────
//
// Un mesero que ofrece postre cada vez que abres la boca es peor que uno que no
// ofrece nada. `puedeRecomendarAhora` es la lista de momentos en que se calla,
// y está antes que la lista de cosas que podría decir.
import { fueRechazada, fueConfirmada } from './propuestasDelBot.js';
import { estaDisponible, productosVendibles } from './consultasDelMenu.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Cuántas veces, como mucho, se recomienda algo en una misma atención. */
export const TOPE_POR_CONVERSACION = 3;

/** Cuántos turnos han de pasar entre una recomendación y la siguiente. */
export const DESCANSO_EN_TURNOS = 3;

/**
 * ¿ES MOMENTO DE OFRECER ALGO?
 *
 * Devuelve `{ puede, motivo }`. El motivo se guarda: es lo que permite mirar en
 * frío por qué el bot no recomendó, en vez de suponer que se le olvidó.
 *
 * Los momentos en que NO:
 *
 *   está corrigiendo      quitar, cambiar cantidad o modificador. Interrumpir a
 *                         quien corrige es la forma más rápida de que se
 *                         equivoque el pedido.
 *   dijo que es todo      «eso es todo», «así está bien». Insistir después de
 *                         eso ya no es servicio.
 *   está confirmando      la última pantalla no es un escaparate.
 *   está preguntando      todavía, si la pregunta es la primera del turno: se
 *                         contesta lo que preguntó. (Pedir recomendación es la
 *                         excepción evidente: ahí sí se recomienda.)
 *   ya se recomendó       hace menos de `DESCANSO_EN_TURNOS`.
 *   ya van tres           en toda la conversación.
 *   se escaló             a una persona.
 */
export function puedeRecomendarAhora(ctx, { intenciones = [] } = {}) {
  const no = (motivo) => ({ puede: false, motivo });
  if (!ctx) return no('sin_contexto');
  if (ctx.fase === 'escalado_humano') return no('escalado');
  if (['confirmando', 'confirmado'].includes(ctx.fase)) return no('confirmando');

  const pidioRecomendacion = intenciones.includes('PEDIR_RECOMENDACION');
  if (pidioRecomendacion) return { puede: true, motivo: 'la pidió' };

  if (intenciones.some((i) => ['QUITAR', 'CAMBIAR_CANTIDAD', 'CAMBIAR_MODIFICADOR', 'CANCELAR'].includes(i))) {
    return no('esta_corrigiendo');
  }
  if (intenciones.includes('CONFIRMAR')) return no('dijo_que_es_todo');
  if (intenciones.includes('PEDIR_HUMANO')) return no('pidio_humano');

  const hechas = (ctx.propuestas || []).filter((p) => p.clase === 'producto');
  if (hechas.length >= TOPE_POR_CONVERSACION) return no('tope_alcanzado');
  const ultima = hechas.at(-1);
  if (ultima && (ctx.contador - ultima.turno) < DESCANSO_EN_TURNOS) return no('demasiado_pronto');

  return { puede: true, motivo: 'ok' };
}

/** Los nombres de lo que ya está en el pedido, normalizados. */
const yaEnElPedido = (carrito) => new Set((carrito?.items || []).map((i) => norm(i?.nombre)));

/** Las categorías que ya tiene el pedido. */
function categoriasDelPedido(catalogo, carrito) {
  const nombres = yaEnElPedido(carrito);
  const fuera = new Set();
  for (const p of productosVendibles(catalogo)) {
    if (nombres.has(norm(p.nombre))) fuera.add(norm(p.categoria));
  }
  return fuera;
}

/**
 * Qué se le podría ofrecer a este cliente, ahora, por orden de pertinencia.
 *
 * `opciones`:
 *   catalogo      el del negocio
 *   carrito       para no ofrecer lo que ya pidió
 *   contexto      para no ofrecer lo que ya rechazó
 *   promociones   vigentes, del negocio
 *   complementos  `{ "categoria que tiene": ["categoria que acompaña"] }`, de la
 *                 configuración del negocio. Sin esto no se inventa ninguna
 *                 relación entre productos.
 *   popularidad   `[{ nombre, veces }]`, si alguien la calculó
 *   limite        cuántas devolver
 *
 * Devuelve `[{ nombre, motivo, categoria, precio }]`. `motivo` no es adorno: es
 * lo que se registra y lo que permite saber si las recomendaciones sirven de
 * algo o solo hacen ruido.
 */
export function recomendar({
  catalogo = [], carrito = null, contexto = null, promociones = [],
  complementos = {}, popularidad = [], limite = 2,
} = {}) {
  const ya = yaEnElPedido(carrito);
  const puestos = new Set();
  const fuera = [];
  const mete = (producto, motivo) => {
    if (!producto || fuera.length >= limite) return;
    const n = norm(producto.nombre);
    if (!n || ya.has(n) || puestos.has(n)) return;
    if (!estaDisponible(producto)) return;
    // Lo que el cliente ya rechazó no vuelve, y lo que ya aceptó tampoco: eso
    // último ya está en el pedido o en camino.
    if (contexto && (fueRechazada(contexto, producto.nombre) || fueConfirmada(contexto, producto.nombre))) return;
    puestos.add(n);
    fuera.push({
      nombre: String(producto.nombre),
      categoria: String(producto.categoria || ''),
      precio: producto.precio === null || producto.precio === undefined ? null : Number(producto.precio),
      motivo,
    });
  };

  const vendibles = productosVendibles(catalogo);
  const porNombre = new Map(vendibles.map((p) => [norm(p.nombre), p]));

  // 1) Promociones vigentes que apunten a un producto que existe.
  for (const promo of promociones || []) {
    const p = porNombre.get(norm(promo?.producto || promo?.nombre));
    if (p) mete(p, 'promocion');
  }

  // 2) Complemento por categoría, según lo que el negocio configuró.
  const tiene = categoriasDelPedido(catalogo, carrito);
  for (const [categoriaQueTiene, acompanan] of Object.entries(complementos || {})) {
    if (!tiene.has(norm(categoriaQueTiene))) continue;
    for (const catAcompana of (Array.isArray(acompanan) ? acompanan : [acompanan])) {
      if (tiene.has(norm(catAcompana))) continue;   // ya lleva algo de esa familia
      const candidatos = vendibles.filter((p) => norm(p.categoria) === norm(catAcompana));
      const destacado = candidatos.find((p) => p.destacado === true);
      mete(destacado || candidatos[0], 'complemento');
    }
  }

  // 3) Lo más pedido, si alguien lo calculó.
  for (const pop of popularidad || []) {
    mete(porNombre.get(norm(pop?.nombre)), 'popular');
  }

  // 4) Lo que el negocio marcó como destacado.
  for (const p of vendibles) if (p.destacado === true) mete(p, 'destacado');

  return fuera;
}

/**
 * Recomendar cuando el cliente lo PIDE, con la pista que dio.
 *
 * «algo llenador», «algo ligero», «algo barato». La pista se resuelve contra
 * datos del catálogo —el precio, y las palabras del propio producto y de su
 * descripción— nunca contra una tabla de adjetivos con productos dentro.
 */
export function recomendarPorPista({ catalogo = [], pista = '', carrito = null, contexto = null, limite = 2 } = {}) {
  const p = norm(pista);
  const vendibles = productosVendibles(catalogo);
  if (!vendibles.length) return [];

  const barato = /\b(barato|economico|accesible|no muy caro|algo simple)\b/.test(p);
  const caro = /\b(lo mejor|premium|especial|lo mas rico)\b/.test(p);
  const conPrecio = vendibles.filter((x) => Number.isFinite(Number(x.precio)));

  let orden = vendibles;
  if (barato && conPrecio.length) orden = conPrecio.slice().sort((a, b) => Number(a.precio) - Number(b.precio));
  else if (caro && conPrecio.length) orden = conPrecio.slice().sort((a, b) => Number(b.precio) - Number(a.precio));
  else {
    // Sin señal de precio, la pista se busca en el texto que el propio negocio
    // escribió: el nombre y la descripción del producto. Si el negocio no
    // describe sus platillos, no hay nada que emparejar y se cae a destacados.
    const palabras = p.split(' ').filter((w) => w.length >= 4);
    const puntua = (x) => {
      const texto = norm(`${x.nombre} ${x.descripcion || ''}`);
      return palabras.reduce((s, w) => s + (texto.includes(w) ? 1 : 0), 0) + (x.destacado ? 0.5 : 0);
    };
    orden = vendibles.slice().sort((a, b) => puntua(b) - puntua(a));
  }

  const ya = yaEnElPedido(carrito);
  const fuera = [];
  for (const x of orden) {
    if (fuera.length >= limite) break;
    if (ya.has(norm(x.nombre))) continue;
    if (contexto && fueRechazada(contexto, x.nombre)) continue;
    fuera.push({
      nombre: String(x.nombre), categoria: String(x.categoria || ''),
      precio: x.precio === null || x.precio === undefined ? null : Number(x.precio),
      motivo: barato ? 'pista_precio_bajo' : (caro ? 'pista_precio_alto' : 'pista_texto'),
    });
  }
  return fuera;
}
