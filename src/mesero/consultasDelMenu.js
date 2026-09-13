// ─── El mesero conoce la carta del negocio, no una carta ──────────────────
//
// Módulo puro. Recibe el catálogo tal como lo devuelve `obtenerMenuCompleto`
// —categorías con productos, productos con grupos de modificadores— y contesta
// preguntas sobre él. No consulta la base: quien llama la consulta y le pasa el
// resultado, que es lo que permite probar esto sin levantar Postgres y lo que
// impide que una consulta de menú se cuele en el camino de un pedido.
//
// ── Cero productos escritos aquí ─────────────────────────────────────────
//
// Es la regla que hace que esto sirva para los tres negocios que hay hoy y para
// el que se dé de alta mañana. Si en este archivo apareciera un nombre de
// platillo, sería el nombre del platillo de UN negocio.
//
// Lo único que se escribe aquí es GRAMÁTICA —cómo se pregunta— y ESTRUCTURA
// —qué es una categoría, qué es un grupo requerido—. Las dos son nuestras. Los
// nombres son del negocio.
//
// ── Lo que devuelve no es una frase ──────────────────────────────────────
//
// Devuelve datos. La redacción es del modelo, que sabe sonar como una persona;
// los hechos son de aquí, que es lo que el modelo no puede garantizar. Si esta
// capa devolviera texto ya hecho, el bot hablaría como un catálogo; si el
// modelo inventara los hechos, ofrecería lo que no hay.
import { palabrasQueLaSostienen } from '../orders/evidenciaDeEleccion.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** ¿Se puede vender hoy? Un producto agotado no se recomienda ni se ofrece. */
export const estaDisponible = (p) => p?.disponible !== false && p?.agotado !== true;

/** Todos los productos vendibles, con su categoría a cuestas. */
export function productosVendibles(catalogo = []) {
  const fuera = [];
  for (const cat of catalogo || []) {
    for (const p of (cat?.productos || [])) {
      if (!estaDisponible(p)) continue;
      fuera.push({ ...p, categoria: String(cat?.nombre || ''), categoriaId: cat?.id });
    }
  }
  return fuera;
}

/**
 * La ficha de un producto, con lo que hace falta para contestar cualquiera de
 * las preguntas de la fase J sobre él.
 */
export function fichaDeProducto(producto, categoria = '') {
  if (!producto) return null;
  return {
    id: producto.id,
    nombre: String(producto.nombre || ''),
    categoria: String(categoria || producto.categoria || ''),
    precio: producto.precio === null || producto.precio === undefined ? null : Number(producto.precio),
    descripcion: String(producto.descripcion || '').trim() || null,
    destacado: producto.destacado === true,
    disponible: estaDisponible(producto),
    grupos: (producto.modificadores || []).map((g) => ({
      nombre: String(g?.nombre || ''),
      requerido: g?.requerido === true,
      minimo: Number(g?.minimo) || 0,
      maximo: g?.maximo === null || g?.maximo === undefined ? null : Number(g.maximo),
      opciones: (g?.opciones || []).filter((o) => o?.disponible !== false).map((o) => ({
        nombre: String(o?.nombre || ''),
        precio_extra: Number(o?.precio_extra ?? o?.precio ?? 0) || 0,
      })),
    })),
  };
}

/**
 * Qué productos del catálogo sostiene esta frase.
 *
 * Se mide igual que en el resto del sistema: cuántas de las palabras propias
 * del producto aparecen en lo que dijo el cliente. Se devuelven ordenados por
 * fuerza, y con el empate visible — porque un empate es una pregunta, no un
 * desempate.
 */
export function buscarProductos(catalogo, texto, { limite = 8 } = {}) {
  const t = String(texto || '');
  if (!norm(t)) return [];
  const conPuntos = productosVendibles(catalogo).map((p) => ({
    producto: p,
    fuerza: palabrasQueLaSostienen(p.nombre, t).size,
  })).filter((x) => x.fuerza > 0);
  conPuntos.sort((a, b) => b.fuerza - a.fuerza);
  return conPuntos.slice(0, limite).map((x) => ({ ...fichaDeProducto(x.producto), fuerza: x.fuerza }));
}

/** Qué CATEGORÍAS sostiene la frase. «¿qué bebidas tienes?» las encuentra. */
export function buscarCategorias(catalogo, texto) {
  const t = String(texto || '');
  if (!norm(t)) return [];
  return (catalogo || [])
    .filter((c) => palabrasQueLaSostienen(c?.nombre, t).size > 0)
    .map((c) => ({
      id: c.id,
      nombre: String(c.nombre || ''),
      productos: (c.productos || []).filter(estaDisponible).map((p) => fichaDeProducto(p, c.nombre)),
    }));
}

/** El índice de la carta: categorías con cuántos productos vendibles tiene cada una. */
export function indiceDeLaCarta(catalogo = []) {
  return (catalogo || []).map((c) => ({
    nombre: String(c?.nombre || ''),
    productos: (c?.productos || []).filter(estaDisponible).length,
    ejemplos: (c?.productos || []).filter(estaDisponible).slice(0, 3).map((p) => String(p.nombre)),
  })).filter((c) => c.productos > 0);
}

/**
 * LA RESPUESTA A UNA CONSULTA, EN DATOS.
 *
 * `intenciones` viene de `clasificarIntenciones`. Se contesta lo que se
 * preguntó y nada más: preguntar el precio no debe soltar la carta entera.
 *
 * Devuelve `{ tipo, ... }` o `null` si la consulta no es de menú. Nunca lanza
 * ni inventa: un producto que no está en el catálogo simplemente no aparece.
 */
export function responderConsulta({ catalogo = [], texto = '', intenciones = [], promociones = [] } = {}) {
  const tiene = (i) => intenciones.includes(i);
  const productos = buscarProductos(catalogo, texto);
  const categorias = buscarCategorias(catalogo, texto);

  if (tiene('CONSULTA_PROMOCION')) {
    return { tipo: 'promociones', promociones: promociones.map((p) => ({
      nombre: String(p?.nombre || ''), descripcion: String(p?.descripcion || '') || null,
    })) };
  }

  if (tiene('CONSULTA_PRECIO')) {
    if (productos.length === 1) return { tipo: 'precio', producto: productos[0] };
    if (productos.length > 1) return { tipo: 'precio_ambiguo', candidatos: productos };
    // Preguntó el precio de algo que no se pudo identificar. La carta con
    // precios es la respuesta honesta; inventar un producto no lo es.
    return { tipo: 'carta', categorias: indiceDeLaCarta(catalogo) };
  }

  if (tiene('CONSULTA_INGREDIENTES')) {
    if (productos.length === 1) return { tipo: 'ingredientes', producto: productos[0] };
    if (productos.length > 1) return { tipo: 'ingredientes_ambiguo', candidatos: productos };
    return { tipo: 'no_identificado', candidatos: [] };
  }

  // «¿qué bebidas tienes?» es una categoría; «¿tienes coca?» es un producto.
  // La categoría gana cuando la frase la nombra, porque contestar con un solo
  // producto cuando preguntan por la familia deja fuera el resto de la carta.
  if (categorias.length === 1) return { tipo: 'categoria', categoria: categorias[0] };
  if (categorias.length > 1) return { tipo: 'categorias', categorias };

  if (tiene('CONSULTA_MENU')) return { tipo: 'carta', categorias: indiceDeLaCarta(catalogo) };

  if (productos.length === 1) return { tipo: 'producto', producto: productos[0] };
  if (productos.length > 1) return { tipo: 'varios_productos', candidatos: productos };

  if (tiene('CONSULTA_PRODUCTO')) return { tipo: 'no_identificado', candidatos: [] };
  return null;
}

/**
 * ¿Este término del cliente cubre UNO o VARIOS productos?
 *
 * Es la misma regla que ya usa el reconciliador con `terminosDelCatalogo`, aquí
 * para poder preguntarlo antes de proponer nada: uno se resuelve, varios se
 * preguntan, ninguno no existe.
 */
export function resolverTermino(catalogo, termino) {
  const encontrados = buscarProductos(catalogo, termino);
  if (!encontrados.length) {
    const cats = buscarCategorias(catalogo, termino);
    if (cats.length === 1 && cats[0].productos.length) {
      return cats[0].productos.length === 1
        ? { resuelto: true, producto: cats[0].productos[0], candidatos: [] }
        : { resuelto: false, producto: null, candidatos: cats[0].productos };
    }
    return { resuelto: false, producto: null, candidatos: [] };
  }
  // Empate de fuerza: la palabra no separa a los candidatos.
  const top = encontrados[0].fuerza;
  const empatan = encontrados.filter((p) => p.fuerza === top);
  if (empatan.length === 1) return { resuelto: true, producto: empatan[0], candidatos: [] };
  return { resuelto: false, producto: null, candidatos: empatan };
}
