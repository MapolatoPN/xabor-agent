// FIDELIDAD DEL BORRADOR: lo que el cliente DIJO vs lo que el modelo INTERPRETÓ.
//
// El <PEDIDO_BORRADOR> lo escribe el MISMO modelo que ya demostró no ser
// confiable con el catálogo. Tratarlo como evidencia de lo que dijo el cliente
// es un error de diseño: puede OMITIR un atributo (F1), SUSTITUIRLO por uno que
// sí existe (F2) o venir sintácticamente válido pero vacío (F3). En los tres
// casos una selección comercial explícita desaparece en silencio.
//
// Este módulo aporta la única fuente que NO depende de esa interpretación: el
// TEXTO LITERAL del cliente. Separa deliberadamente dos preguntas distintas:
//
//   MENCIONES  — qué valores comerciales afirmó el cliente en su ÚLTIMO turno.
//                Se extraen del turno actual porque son lo que el cliente
//                sostiene AHORA: si antes dijo "mango" y ahora dice "mejor
//                fresa", la mención vigente es fresa.
//   RESPALDO   — si una selección que aparece en el borrador puede rastrearse
//                a algún turno del PROPIO CLIENTE dentro del ciclo activo del
//                pedido. Aquí la ventana es todo el ciclo (no solo el último
//                turno) porque el cliente elige atributos a lo largo de varios
//                mensajes; pero nunca cruza a un pedido anterior.
//
// Todo lo que el extractor produce se VERIFICA contra el texto real: un span
// que no aparece literalmente en el mensaje se descarta. El extractor puede
// equivocarse; lo que no puede es inventar un span que el cliente nunca
// escribió, porque el respaldo lo comprueba CÓDIGO, no otro modelo.
//
// Nada aquí conoce productos, sabores ni negocios: solo texto, conectores del
// español y lo que el catálogo del tenant responda.

/** Minúsculas sin acentos ni puntuación: la forma en que se compara todo. */
export function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function palabras(s) {
  const n = normalizar(s);
  return n ? n.split(' ') : [];
}

/**
 * ¿Este texto aparece LITERALMENTE en el mensaje del cliente?
 *
 * Es la comprobación que impide que el extractor invente un span: si el modelo
 * devuelve "fresa" pero el cliente escribió "mango", esto es false y la mención
 * se descarta. Tolera el plural porque "dos licuados" y "licuado" son la misma
 * palabra para el cliente, no una invención.
 */
export function spanEnTexto(span, texto) {
  const s = normalizar(span);
  const t = ` ${normalizar(texto)} `;
  if (!s || !t.trim()) return false;
  return t.includes(` ${s} `) || t.includes(` ${s}s `) || t.includes(` ${s}es `);
}

/** Palabra inmediatamente anterior al span dentro del texto (o '' si abre). */
function palabraPrevia(span, texto) {
  const s = normalizar(span);
  const t = ` ${normalizar(texto)} `;
  for (const variante of [` ${s} `, ` ${s}s `, ` ${s}es `]) {
    const i = t.indexOf(variante);
    if (i >= 0) return t.slice(0, i).trim().split(' ').filter(Boolean).pop() || '';
  }
  return '';
}

// Marcas de PREPARACIÓN, no de catálogo. "sin cebolla" es una nota: el cliente
// no está eligiendo del menú, está diciendo cómo quiere su comida. Nunca puede
// convertirse en "no manejamos cebolla". Es una lista de partículas del
// español, no de productos: vale igual para cualquier tenant.
const MARCAS_DE_NOTA = new Set(['sin', 'nada', 'poco', 'poca', 'poquito', 'poquita', 'menos', 'aparte', 'extra']);

/** ¿El span viene precedido por una marca de preparación ("sin cebolla")? */
export function esNotaDePreparacion(span, texto) {
  return MARCAS_DE_NOTA.has(palabraPrevia(span, texto));
}

// Conectores que en español introducen un ATRIBUTO de algo ya mencionado
// ("licuado DE mango", "plato CON salsa"). Deliberadamente NO incluye `para`
// ni `a`, que introducen logística ("para llevar", "a domicilio") — ese es el
// filtro determinista que impide tratar "llevar" como un atributo del menú.
const CONECTORES_DE_ATRIBUTO = new Set(['de', 'del', 'con', 'sabor', 'sabores', 'estilo', 'tipo', 'en', 'y', 'o']);

/**
 * ¿El span está en posición de ATRIBUTO dentro del mensaje?
 *
 * Segunda barrera, determinista, detrás de la clasificación del extractor. Un
 * atributo se apoya en un conector ("de mango") o se encadena a algo que ya se
 * aceptó como producto o atributo ("licuado de mango GRANDE"). Una palabra
 * suelta o precedida de `para` no califica, así que "para llevar por favor"
 * jamás llega a compararse contra el catálogo.
 */
export function esCandidatoDeAtributo(span, texto, anclas = []) {
  const previo = palabraPrevia(span, texto);
  if (!previo) return false;                        // abre el mensaje: no modifica a nada
  if (CONECTORES_DE_ATRIBUTO.has(previo)) return true;
  return anclas.some((a) => palabras(a).includes(previo));
}

/**
 * ¿Esta selección del borrador tiene RESPALDO en lo que el cliente escribió
 * durante el ciclo activo?
 *
 * Acepta el nombre completo o cualquier palabra significativa suya, porque el
 * cliente dice "entera" y el catálogo guarda "Leche Entera". Lo que NO acepta
 * es que la selección no aparezca por ningún lado: entonces la introdujo el
 * modelo, no el cliente.
 */
export function tieneRespaldo(valor, textoCiclo) {
  if (!String(valor || '').trim()) return false;
  if (spanEnTexto(valor, textoCiclo)) return true;
  const significativas = palabras(valor).filter((w) => w.length >= 4);
  return significativas.some((w) => spanEnTexto(w, textoCiclo));
}

// Instrucción del extractor independiente. Pide SPANS VERBATIM y separa
// explícitamente lo comercial de lo logístico/cortesía, que es la distinción
// que evita convertir "para llevar por favor" en una consulta de catálogo.
export const INSTRUCCION_MENCIONES =
  'Extrae las MENCIONES COMERCIALES del último mensaje del cliente: el producto que nombra y los '
  + 'atributos con que lo describe (sabor, tamaño, tipo, ingrediente elegido).\n'
  + 'Reglas:\n'
  + '- "texto_fuente" debe ser TEXTUAL del mensaje del cliente, copiado tal cual. Nunca lo corrijas, '
  + 'traduzcas ni sustituyas por algo que exista en un menú.\n'
  + '- tipo "producto" para lo que pide, "atributo" para cómo lo quiere, "nota" para indicaciones de '
  + 'preparación (sin cebolla, poco hielo, aparte).\n'
  + '- NO son menciones comerciales: la modalidad (para llevar, a domicilio, recoger), la hora, la '
  + 'forma de pago, las cantidades, los saludos y la cortesía (por favor, gracias). Omítelos.\n'
  + '- Si el cliente solo pregunta o conversa y no describe nada que quiera, responde {"menciones":[]}.\n'
  + 'Responde SOLO con JSON: {"menciones":[{"tipo":"producto|atributo|nota","texto_fuente":"..."}]}';

/** Extrae el objeto JSON de una respuesta del modelo (tolera texto alrededor). */
export function parsearMenciones(texto) {
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    return Array.isArray(obj?.menciones) ? obj.menciones : [];
  } catch { return []; }
}

/**
 * Convierte la salida CRUDA del extractor en menciones utilizables.
 *
 * Aquí es donde el modelo deja de ser autoridad: cada span se comprueba contra
 * el texto real del cliente y contra su posición gramatical. Lo que no pasa
 * ambas barreras se descarta con registro, nunca se usa.
 *
 * Devuelve { atributos, productos, notas, descartadas } con los spans ya
 * normalizados a su forma verbatim recortada.
 */
export function depurarMenciones(crudas, textoTurno) {
  const salida = { atributos: [], productos: [], notas: [], descartadas: [] };
  const vistos = new Set();
  const anclas = [];

  // Los productos se procesan primero: sirven de ancla para encadenar los
  // atributos que los siguen ("licuado de mango grande").
  const ordenadas = [...(Array.isArray(crudas) ? crudas : [])].sort(
    (a, b) => (a?.tipo === 'producto' ? -1 : 0) - (b?.tipo === 'producto' ? -1 : 0));

  for (const c of ordenadas) {
    const span = String(c?.texto_fuente || '').trim().slice(0, 60);
    const tipo = String(c?.tipo || '').trim().toLowerCase();
    if (!span) continue;
    const clave = `${tipo}|${normalizar(span)}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    // BARRERA 1 — el span tiene que existir de verdad en el mensaje.
    if (!spanEnTexto(span, textoTurno)) {
      salida.descartadas.push({ span, motivo: 'span_inexistente' });
      continue;
    }
    if (tipo === 'producto') { salida.productos.push(span); anclas.push(span); continue; }
    if (tipo === 'nota') { salida.notas.push(span); continue; }
    if (tipo !== 'atributo') { salida.descartadas.push({ span, motivo: 'tipo_desconocido' }); continue; }

    // BARRERA 2 — una indicación de preparación NUNCA es una selección de menú,
    // aunque el extractor la haya clasificado como atributo.
    if (esNotaDePreparacion(span, textoTurno)) { salida.notas.push(span); continue; }

    // BARRERA 3 — posición gramatical de atributo (conector o encadenado).
    if (!esCandidatoDeAtributo(span, textoTurno, anclas)) {
      salida.descartadas.push({ span, motivo: 'sin_posicion_de_atributo' });
      continue;
    }
    salida.atributos.push(span);
    anclas.push(span);
  }
  return salida;
}
