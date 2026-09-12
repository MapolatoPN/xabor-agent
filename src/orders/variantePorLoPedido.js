// ─── Usar lo que el cliente YA dijo para saber cuál variante quiere ───────
//
// Módulo puro: recibe las variantes con sus grupos y lo que el cliente nombró.
// No consulta nada.
//
// ── El incidente que lo justifica ────────────────────────────────────────
//
// 2026-09-11, 11:26 p.m., con la ambigüedad ya arreglada:
//
//   cliente  'Quiero unos chilaquiles'
//   bot      'De "Chilaquiles" tenemos Bowl, Combito, Sencillos o Mixtos.
//             ¿Cuál prefieres?'                                            ✔
//   cliente  'Quiero unos chilaquiles en salsa Suiza con huevos estrellados
//             y le pones frijoles y papas a la mexicana'
//   bot      'De "Chilaquiles" tenemos Bowl, Combito, Sencillos o Mixtos.
//             ¿Cuál prefieres?'                                            ✘
//
// El cliente contestó con TODO el detalle y recibió la misma pregunta, palabra
// por palabra. Técnicamente el sistema tenía razón —nunca dijo "Sencillos"—
// pero se lee como si no lo hubiera escuchado. Y para un cliente frecuente, que
// pide así justamente porque ya sabe lo que quiere, es peor que un error: es un
// trato de desconocido.
//
// Lo que el sistema no estaba usando estaba dentro de esa misma frase. Un Bowl
// de Chilaquiles NO TIENE grupo de guarniciones: los frijoles y las papas no
// caben ahí. Se puede descartar sin adivinar nada, solo mirando la estructura
// de la carta. Descartar no es elegir por el cliente: es dejar de ofrecerle lo
// que no puede pedir.

import { buscarOpcionPorMencion } from '../services/modificadores.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Cuántas opciones admite un grupo. `maximo` 0 o nulo = sin tope. */
function topeDe(grupo) {
  const max = Number(grupo?.maximo);
  return Number.isFinite(max) && max > 0 ? max : Infinity;
}

/**
 * ¿Cabe TODO lo que el cliente nombró dentro de los grupos de esta variante?
 *
 * Es una asignación, no una suma: una misma opción puede vivir en dos grupos
 * (en Obispado, "Bistec en Salsa" está en Proteína Y en Guarniciones), así que
 * hay que probar combinaciones. Son listas de cuatro o cinco elementos: el
 * recorrido exhaustivo es instantáneo y no hace falta nada más listo.
 */
export function cabeEnLaVariante(grupos, pedidas, conocidas = null) {
  const restantes = grupos.map((g) => ({ grupo:g, tope: topeDe(g), usadas: 0 }));
  const reconoce = (g, s) => buscarOpcionPorMencion([g],s).estado !== 'sin_coincidencia';
  const intentar = (i) => {
    if (i === pedidas.length) return true;
    const buscada = norm(pedidas[i]);
    if (!buscada) return intentar(i + 1);
    // RUIDO contra AUSENCIA, y la diferencia decide todo:
    //
    //   "con mucho amor"  -> no es opción de NINGUNA variante. El extractor la
    //                        recogió de más. Se ignora; descartar variantes por
    //                        una palabra suelta dejaría al cliente sin nada que
    //                        elegir por un desliz del modelo.
    //   "Frijolitos"      -> SÍ es opción de otra variante, pero no de ésta.
    //                        Entonces ésta no puede servirlo: se descarta.
    //
    // Sin esta distinción el filtro no filtraba nada: todo lo que no encajaba
    // se trataba como ruido y ninguna variante quedaba fuera nunca.
    const esConocida = conocidas ? conocidas.has(buscada) : true;
    let encaja = false;
    for (const g of restantes) {
      if (g.usadas >= g.tope) continue;
      if (!reconoce(g.grupo,pedidas[i])) continue;
      encaja = true;
      g.usadas++;
      if (intentar(i + 1)) return true;
      g.usadas--;
    }
    if (encaja) return false;            // pertenece aquí pero ya no cabe
    return esConocida ? false : intentar(i + 1);
  };
  return intentar(0);
}

/**
 * De las variantes posibles, las que de verdad pueden sostener lo pedido.
 *
 * Devuelve SIEMPRE algo utilizable:
 *   - Si el filtro deja una sola, esa es: no hay nada que preguntar.
 *   - Si deja varias, se pregunta solo entre esas (la lista se acorta).
 *   - Si no deja ninguna, se devuelven TODAS. Que el cliente haya pedido algo
 *     que no cabe en ninguna variante es problema suyo con la carta, no una
 *     razón para quedarse sin opciones que ofrecerle.
 *
 * `gruposPorProducto` es el Map que devuelve cargarGruposDeProductos.
 */
export function variantesCompatibles(candidatos, gruposPorProducto, opcionesPedidas = []) {
  const pedidas = (opcionesPedidas || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!pedidas.length || candidatos.length < 2) return candidatos;
  // Una entrada arbitrariamente larga no debe causar búsqueda exponencial.
  if (pedidas.length > 8) return candidatos;
  // Reconocer las palabras del cliente ("pollo", "frijoles") con el mismo
  // resolver que usa el pedido, sin elegir entre dos tipos de frijoles.
  const conocidas = new Set(pedidas.filter(s => candidatos.some(p =>
    buscarOpcionPorMencion(gruposPorProducto.get(p.id)||[],s).estado !== 'sin_coincidencia')).map(norm));
  const viables = candidatos.filter((p) => cabeEnLaVariante(gruposPorProducto.get(p.id) || [], pedidas, conocidas));
  return viables.length ? viables : candidatos;
}

/**
 * Los nombres de opción que el cliente nombró en un artículo del borrador.
 *
 * El borrador las trae agrupadas (`[{grupo, opciones:[...]}]`) o sueltas
 * (`["Suiza","Huevos Estrellados"]`), según cómo las haya emitido el modelo.
 * Las dos formas se aplanan igual.
 */
export function opcionesDelItem(item) {
  const mods = item?.modificadores;
  if (!Array.isArray(mods)) return [];
  const fuera = [];
  for (const m of mods) {
    if (typeof m === 'string') { fuera.push(m); continue; }
    if (Array.isArray(m?.opciones)) { for (const o of m.opciones) fuera.push(typeof o === 'string' ? o : o?.nombre); continue; }
    if (m?.opcion || m?.nombre) fuera.push(m.opcion || m.nombre);
  }
  return fuera.filter(Boolean);
}
