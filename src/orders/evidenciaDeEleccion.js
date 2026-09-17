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
//
// Es GRAMÁTICA, no carta: preposiciones, artículos, determinantes y
// demostrativos del español. Ni un solo nombre de platillo entra aquí — si
// entrara, este archivo dejaría de servir para el negocio que se dé de alta
// mañana. Y se amplía con cuidado: cada palabra que se añade deja de contar
// como evidencia también para una opción que se llame así de verdad.
const VACIAS = new Set([
  'de', 'con', 'sin', 'en', 'la', 'el', 'los', 'las', 'y', 'a', 'al', 'del', 'para',
  // determinantes y cuantificadores: «unos chilaquiles» nombra chilaquiles.
  'un', 'una', 'uno', 'unos', 'unas',
  // posesivos y demostrativos: «mi torta», «esa agua».
  'mi', 'mis', 'tu', 'tus', 'su', 'sus',
  'ese', 'esa', 'esos', 'esas', 'este', 'esta', 'estos', 'estas',
  'que', 'por', 'lo',
]);

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
 * ─── LO QUE EL CANDIDATO NO EXPLICA DE LO QUE SE LE PIDIÓ ────────────────
 *
 * Todo lo de arriba responde a «¿hay otro tan bueno como éste?». Nada responde
 * a «¿es éste bastante bueno?», y son preguntas distintas:
 *
 *   «queso azul» contra un grupo donde la única opción con la palabra «queso»
 *   es «Queso Panela en Salsa». Nadie empata, así que `distingueLaEleccion`
 *   dice que sí distingue y la opción entra al pedido. Pero el cliente no pidió
 *   panela: pidió AZUL, y «azul» no lo explica nadie.
 *
 * La ausencia de empate no convierte una coincidencia débil en válida. Una
 * única coincidencia débil sigue siendo débil.
 *
 * LA REGLA, y es una sola: un candidato tiene que EXPLICAR las palabras
 * distintivas de la mención. La que no explique lo descarta.
 *
 *   «queso azul»           →  «Queso Panela en Salsa» deja «azul»     → fuera
 *   «panela»               →  «Queso Panela en Salsa» no deja nada    → vale
 *   «huevo estrellado»     →  «Huevos Estrellados» no deja nada       → vale
 *   «frijoles con chorizo» →  «Frijolitos con chorizo», nada          → vale
 *
 * QUIÉN EXPLICA no es sólo el nombre del candidato. «salsa suiza» contra la
 * opción «Suiza» dejaría «salsa» colgando, y sin embargo el cliente habló
 * perfecto: quien explica «salsa» es el GRUPO. Por eso quien llama pasa TODOS
 * los textos que sostienen legítimamente a ese candidato —su nombre, su grupo o
 * su categoría, las opciones que ofrece, los alias que el negocio declaró—.
 * Un alias declarado explica tanto como el nombre: si el negocio dice que a su
 * «Combito» se le llama «combo», «combo» está explicado.
 *
 * Se mide con la MISMA `palabrasQueLaSostienen` de arriba, así que hereda la
 * tolerancia de género, número y diminutivo. No hay un segundo motor, ni un
 * umbral: o la palabra la explica alguien, o no.
 *
 * Y se mide contra la MENCIÓN —como llamó el cliente o el modelo a la cosa—,
 * nunca contra el mensaje entero: pedir que un producto explique «quiero»,
 * «porfa» y «para llevar» no dejaría vivo ni un platillo.
 */
export function palabrasSinExplicar(mencion, explicadores = []) {
  const propias = palabrasQuePidenAlgo(mencion);
  const textos = (Array.isArray(explicadores) ? explicadores : [explicadores])
    .map((e) => String(e || '')).filter(Boolean);
  const explicada = (w) => textos.some((t) => palabrasQueLaSostienen(t, w).size > 0);
  // ── LO QUE VA DELANTE ES EL GÉNERO; LO QUE VA DETRÁS, LA ESPECIE ───────
  //
  // El español pone primero el núcleo y después lo que lo distingue: «CHILE
  // jalapeño», «SALSA suiza», «AGUA de horchata». Esa primera palabra es el
  // género —lo que la cosa es— y el negocio no tiene por qué haberla escrito en
  // el nombre de la opción ni en el del grupo: «Jalapeño» a secas, en un grupo
  // llamado «Complemento», es una opción perfectamente normal, y exigirle que
  // explicara «chile» negaba un chile que sí existe.
  //
  // Lo que va DETRÁS de lo que el candidato sí explica es otra cosa: es la
  // especie, lo que separa este de sus hermanos. «Queso AZUL» y «torta de
  // SALMÓN» piden una variedad concreta, y ahí es donde no se puede improvisar.
  //
  // Por eso sólo descalifica lo que aparece después de la primera palabra que el
  // candidato explica. Es gramática del idioma, no de ninguna carta, y no añade
  // ningún umbral: sigue siendo «o alguien la explica, o no».
  const desde = propias.findIndex(explicada);
  if (desde < 0) return propias.filter((w) => !explicada(w));
  return propias.slice(desde + 1).filter((w) => !explicada(w));
}

// ── LO QUE SE PIDE, LO QUE SE QUITA Y LO QUE NO ES COMIDA ────────────────
//
// «Una torta de pierna SIN CHILE» no pide chile: lo quita. «Una torta PARA
// LLEVAR» no pide un platillo llamado «llevar». Si esas palabras contaran como
// petición, exigirle al producto que las explique invertiría el sentido de lo
// que dijo el cliente y le negaríamos la torta POR el chile que pidió no
// ponerle — el peor resultado posible, porque convierte una frase perfectamente
// clara en un rechazo.
//
// El repo ya distingue estas dos clases y en el mismo sitio: `MARCAS_DE_NOTA`
// marca la preparación y el comentario de `CONECTORES_DE_ATRIBUTO` explica por
// qué `para` y `a` quedan deliberadamente fuera de los atributos («ese es el
// filtro determinista que impide tratar "llevar" como un atributo del menú»).
// Aquí se aplica la misma frontera: lo que va detrás de una de esas marcas NO
// es una afirmación sobre la identidad de lo pedido, así que no puede
// descalificar a nadie.
//
// Se añaden los intensificadores —«bien frío», «muy picoso»— por la misma
// razón: encabezan una preparación, no un platillo. Sigue siendo gramática:
// ni una palabra de ninguna carta.
const ABREN_NOTA = new Set([
  'sin', 'nada', 'poco', 'poca', 'poquito', 'poquita', 'menos', 'aparte', 'extra',
  'bien', 'muy', 'medio', 'media',
  'para', 'a',
]);

/** Las palabras de la mención que de verdad AFIRMAN qué se quiere. */
function palabrasQuePidenAlgo(mencion) {
  const todas = palabrasDe(mencion);
  const fuera = [];
  for (let i = 0; i < todas.length; i += 1) {
    const w = todas[i];
    if (w.length < 3 || VACIAS.has(w) || ABREN_NOTA.has(w)) continue;
    // La palabra anterior manda, saltando las vacías —«sin mucho chile» sigue
    // siendo una nota sobre el chile—, pero una marca de nota NUNCA se salta
    // aunque además sea vacía: «sin» está en las dos listas, y saltarla dejaba
    // «chile» como si lo hubiera pedido, que es el error al revés.
    let j = i - 1;
    while (j >= 0 && VACIAS.has(todas[j]) && !ABREN_NOTA.has(todas[j])) j -= 1;
    if (j >= 0 && ABREN_NOTA.has(todas[j])) continue;
    fuera.push(w);
  }
  return fuera;
}

/** ¿Este candidato explica todo lo que se le pidió? */
export const explicaLaMencion = (mencion, explicadores = []) => palabrasSinExplicar(mencion, explicadores).length === 0;

/**
 * ─── LO QUE EL VALOR AFIRMA Y EL TEXTO DEL CLIENTE NO SOSTIENE ──────────
 *
 * La de arriba perdona lo que va DELANTE de la primera palabra explicada,
 * porque en «chile jalapeño» el negocio no tiene por qué haber escrito el
 * género. Esa indulgencia es correcta para una mención de carta y es un
 * agujero para un dato del cliente. Medido:
 *
 *   palabrasSinExplicar('Depto 5B Reforma 200', ['Reforma 200'])  →  []
 *
 * El departamento entra porque va delante. En una dirección no hay género
 * que perdonar: toda palabra que el cliente no dijo es una invención, vaya
 * donde vaya.
 *
 * Comparte el tokenizador y la lista de vacías, y por eso normalizar la forma
 * sigue saliendo gratis mientras añadir contenido no:
 *
 *   «av reforma #200»  →  «Av. Reforma 200»   nada nuevo      → []
 *   «Reforma 200»      →  «Reforma 200, Col. Centro»          → [colonia, centro]
 *
 * Cuidado al usarla como única puerta: un valor sin ninguna palabra
 * significativa —«Av 5 #3», todo de menos de tres letras— devuelve la lista
 * vacía porque no afirma nada que comprobar. Quien decida con esto tiene que
 * exigir además que algo SÍ esté sostenido.
 *
 * ── Y AQUÍ NO HAY MARCAS DE NOTA QUE VALGAN ────────────────────────────
 *
 * Tampoco usa `palabrasQuePidenAlgo`, y esto lo destapó una revisión
 * adversarial: aquella salta la palabra que va detrás de una marca de nota
 * —«sin», «para», «a», «poco»—, porque en la carta «sin chile» no pide chile
 * y no puede descalificar al platillo. Con eso puesto, el filtro bloqueaba
 * «Reforma 200, Depto 5B» y dejaba pasar «Reforma 200 PARA Depto 5B»: al
 * modelo le bastaba una preposición para volver invisible lo que inventaba.
 *
 * En un dato de cliente, lo que va detrás de «para» o de «a» es justo lo que
 * más importa —el destinatario, el interior, la instrucción de entrega—, así
 * que cuentan todas las palabras significativas y ninguna se salta.
 *
 * ── UN NÚMERO CON ESPACIOS ES EL MISMO NÚMERO ──────────────────────────
 *
 * «878 123 4567» y «8781234567» son el mismo teléfono, y el tokenizador los
 * ve como tres palabras y una. Es el dato que más se escribe con separadores,
 * así que un valor que sea SÓLO un número se compara aparte: se le quitan los
 * separadores a los dos lados y se exige que la tirada coincida ENTERA. No es
 * normalización postal ni un parser; y al pedir la tirada completa, el «123»
 * de un teléfono no puede respaldar un número de casa.
 */
const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const esUnNumeroEscrito = (s) => /^[\d\s.()+-]+$/.test(String(s ?? '').trim())
  && soloDigitos(s).length >= 3;
const tiradasDeDigitos = (t) => (String(t ?? '').match(/\d[\d\s.()+-]*\d|\d+/g) || [])
  .map(soloDigitos).filter(Boolean);

const textosDe = (textos) => (Array.isArray(textos) ? textos : [textos])
  .map((t) => String(t || '')).filter(Boolean);

// ── LO CORTO CON UN DÍGITO DENTRO NO ES DECORACIÓN ──────────────────────
//
// El tokenizador descarta lo de menos de tres letras, y para la carta está
// bien. Aquí abría un hueco medido contra las 148 calles reales: «{calle},
// Depto 5B» se bloqueaba en las 148 y «{calle} para el 5B» se colaba en las
// 148. La diferencia era la palabra «Depto»; sin ella, «5b» mide dos y era
// invisible. Un interior no es ruido: es a qué puerta llama el repartidor.
//
// La línea es el DÍGITO, no el largo. «av», «s», «n» o «cp» no afirman nada
// que se pueda equivocar; «5B», «2A» o «#3» sí. Endurecer todo lo corto habría
// tirado «S/N» y «C.P.», que están en media libreta de direcciones reales.
const llevaDigito = (w) => /\d/.test(w);
const significativasDe = (valor) => palabrasDe(valor)
  .filter((w) => !VACIAS.has(w) && (w.length >= 3 || llevaDigito(w)));

// Lo corto se busca como token exacto: `palabrasQueLaSostienen` filtra por su
// cuenta lo de menos de tres letras y contestaría que no lo sostiene nadie.
const laSostiene = (w, t) => (w.length >= 3
  ? palabrasQueLaSostienen(w, t).size > 0
  : palabrasDe(t).includes(w));

export function palabrasSinRespaldo(valor, textos = []) {
  const lista = textosDe(textos);
  if (esUnNumeroEscrito(valor)) {
    const mio = soloDigitos(valor);
    return lista.some((t) => tiradasDeDigitos(t).includes(mio)) ? [] : [mio];
  }
  const propias = significativasDe(valor);
  return propias.filter((w) => !lista.some((t) => laSostiene(w, t)));
}

/**
 * ¿El texto del cliente respalda este valor ENTERO?
 *
 * Dos preguntas que hay que hacer juntas, y por eso viven en una sola función
 * en vez de en el sitio que llama: que no sobre nada —lo de arriba— y que el
 * valor AFIRME algo comprobable. Sin lo segundo, «Av 5 #3» pasa sola: no
 * tiene ni una palabra de tres letras, así que no le sobra ninguna.
 *
 * Separadas se pisan. Con un teléfono dictado —«878 123 4567» contra
 * «8781234567»— la primera dice que no sobra nada y la segunda, que mira
 * palabras, no encuentra el token pegado y lo tira igual. La comprobación de
 * la tirada de dígitos tiene que valer para las dos, o no vale para ninguna.
 */
export function elTextoRespaldaElValor(valor, textos = []) {
  const lista = textosDe(textos);
  if (!lista.length) return false;
  if (esUnNumeroEscrito(valor)) {
    const mio = soloDigitos(valor);
    return lista.some((t) => tiradasDeDigitos(t).includes(mio));
  }
  const propias = significativasDe(valor);
  if (!propias.length) return false;
  return propias.every((w) => lista.some((t) => laSostiene(w, t)));
}

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
