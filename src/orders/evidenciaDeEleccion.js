// ─── ¿Lo que dijo el cliente distingue ESTA opción de sus hermanas? ───────
//
// Módulo puro: recibe la opción, las opciones del mismo grupo y el texto real
// del cliente. No consulta nada.
//
// ── Por qué no bastaba `tieneRespaldo` ───────────────────────────────────
//
// Auditoría de Codex, 2026-09-12. El cliente escribe «frijoles». El catálogo
// tiene "Frijolitos naturales" y "Frijolitos con chorizo". El modelo devuelve
// una de las dos y el respaldo la aprueba, porque "frijolitos" sí aparece en lo
// que dijo el cliente.
//
// El comentario de `tieneRespaldo` explicaba su propia tolerancia así: «NO
// estamos eligiendo por el cliente, estamos comprobando si respaldó una opción
// que el modelo ya interpretó». Ese razonamiento es correcto cuando la opción no
// tiene hermanas que la palabra sostenga igual de bien. Cuando las tiene, el que
// eligió fue el modelo — y el respaldo lo confirma sin mirar a las otras.
//
// Peor aún: la protección dependía de CÓMO redactara el modelo. Si dejaba
// escrito «frijoles», la ambigüedad se detectaba y se preguntaba; si resolvía
// por su cuenta «naturales», pasaba. Las dos formas son igual de plausibles y
// una garantía no puede depender de cuál salga.
//
// ── La regla ─────────────────────────────────────────────────────────────
//
// Se mide CUÁNTAS de sus propias palabras significativas encuentra cada opción
// del grupo en el texto del cliente. La elegida solo vale si encuentra
// ESTRICTAMENTE más que cualquier hermana:
//
//   «...y le pones frijoles y papas»
//        Frijolitos naturales   → {frijolitos}            = 1
//        Frijolitos con chorizo → {frijolitos}            = 1   empate → AMBIGUO
//
//   «...con pollo karaage»
//        Pollo karaage          → {pollo, karaage}        = 2
//        Pollo asado            → {pollo}                 = 1   gana → ELEGIDA
//
// El empate deja la selección pendiente y el flujo pregunta, que es lo que ya
// hace bien con las opciones que el modelo no resolvió. Contar palabras propias
// —y no parecido global— es lo que hace que «karaage» baste sin que «pollo»
// alcance.
import { mismaPalabraFlexible, spanEnTexto } from '../agent/mencionesComerciales.js';

const palabrasDe = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(Boolean);

// Palabras que no distinguen nada por sí solas: aparecen en media carta o son
// de relleno. Si fueran las únicas que casan, la opción no está respaldada.
const VACIAS = new Set(['de', 'con', 'sin', 'en', 'la', 'el', 'los', 'las', 'y', 'a', 'al', 'del', 'para']);

/** QUÉ palabras propias de `opcion` aparecen en lo que dijo el cliente. */
export function palabrasQueLaSostienen(opcion, texto) {
  const propias = palabrasDe(opcion).filter((w) => w.length >= 3 && !VACIAS.has(w));
  const dichas = palabrasDe(texto).filter((w) => w.length >= 3);
  const halladas = new Set();
  for (const w of propias) {
    // Misma tolerancia que usa el resolvedor para emparejar: diminutivos,
    // género y número. Si aquí se midiera más estricto que allá, una opción
    // podría resolverse y luego descartarse por falta de evidencia -- que es
    // justo el bucle sin salida que costó un pedido real el 12 de septiembre.
    if (spanEnTexto(w, texto) || dichas.some((c) => mismaPalabraFlexible(w, c))) halladas.add(w);
  }
  return halladas;
}

/** Cuántas. Se conserva por comodidad de las pruebas y del diagnóstico. */
export const fuerzaDeEvidencia = (opcion, texto) => palabrasQueLaSostienen(opcion, texto).size;

/**
 * ¿El texto del cliente distingue `elegida` de las demás opciones del grupo?
 *
 * `hermanas` son TODAS las opciones del mismo grupo (incluida la elegida; se
 * ignora sola). Sin hermanas que compitan, cualquier evidencia basta: es el
 * caso normal y no se endurece.
 *
 * Devuelve `{ distingue, empatan }` — `empatan` son los nombres que la frase
 * sostiene igual de bien, para poder preguntarle al cliente por ellos en vez de
 * dejarlo con un rechazo mudo.
 */
export function distingueLaEleccion(elegida, hermanas = [], texto = '') {
  const mias = palabrasQueLaSostienen(elegida, texto);
  if (!mias.size) return { distingue: false, empatan: [] };
  const norm = (s) => palabrasDe(s).join(' ');
  const yo = norm(elegida);
  const empatan = [];
  for (const h of hermanas) {
    if (!h || norm(h) === yo) continue;
    // COMPETIR ES EXPLICAR LO MISMO, no simplemente aparecer.
    //
    // Se compara QUÉ palabras sostienen a cada una, no cuántas. Una hermana
    // solo disputa la elección si explica TODO lo que explica la mía: entonces
    // la frase del cliente no permite separarlas.
    //
    //   "frijoles"              naturales{frijolitos} ⊆ chorizo{frijolitos}  -> disputa
    //   "pollo karaage"         karaage{pollo,karaage} ⊄ asado{pollo}        -> no disputa
    //
    // Contar en vez de comparar rompía el caso de dos platillos con opciones
    // distintas del mismo grupo --"uno con pollo karaage y otro con cerdo
    // chashu"--: cada opción empataba en número con la del OTRO platillo, que
    // el cliente había pedido aparte, y las dos quedaban pendientes. Las
    // palabras que las sostienen son distintas, así que no se disputan nada.
    const suyas = palabrasQueLaSostienen(h, texto);
    let explicaTodoLoMio = true;
    for (const w of mias) if (!suyas.has(w)) { explicaTodoLoMio = false; break; }
    if (explicaTodoLoMio) empatan.push(String(h));
  }
  return { distingue: empatan.length === 0, empatan };
}

/** Las opciones de un grupo, por su nombre, tal como vienen del catálogo. */
export function opcionesDelGrupo(grupo) {
  return (grupo?.opciones || []).map((o) => String(o?.nombre || '')).filter(Boolean);
}
