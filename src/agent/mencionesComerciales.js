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

/**
 * Raíz de una palabra, quitando la flexión de género y número del español.
 *
 * El catálogo guarda "Suiza", "Roja", "Verde"; el cliente dice "suizos",
 * "rojos", "verdes" —concordando con "chilaquiles"— y también "entera" por
 * "Entera". Comparar literalmente hacía que su propia elección no contara como
 * respaldo: el backend la descartaba y volvía a preguntar lo mismo, sin salida.
 *
 * Deliberadamente conservadora: solo recorta la terminación de palabras de al
 * menos cuatro letras, así que no colapsa cosas distintas ("Papa" y "Papaya"
 * siguen siendo distintas, "Melón" no se toca). No es un stemmer general: es la
 * mínima tolerancia para que la concordancia gramatical no rompa un pedido.
 */
export function raizPalabra(p) {
  let w = normalizar(p);
  if (w.length >= 5 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length >= 4 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length >= 4 && 'oae'.includes(w.slice(-1))) w = w.slice(0, -1);
  return w;
}

/**
 * La forma NO diminutiva de una palabra, o null si no parecía un diminutivo.
 *
 * "pollito" es "pollo" en la boca de cualquier cliente mexicano, y también
 * "huevitos", "cafecito", "aguita". `raizPalabra` recorta género y número, no
 * esto: la raíz de "pollito" es "pollit" y la de "pollo" es "poll", así que no
 * casaban y el bot negaba algo que sí tenía.
 *
 * Deliberadamente SEPARADA de `raizPalabra` en vez de añadirse a ella, y esa
 * separación es el control de seguridad: media carta mexicana termina en
 * diminutivo SIN serlo —Carnitas, Gorditas, Burrito, Quesadillas, Molletes—, y
 * recortarlos por defecto convertiría "carnitas" en "carn", que es también la
 * raíz de "Carne asada". Por eso esta lectura se intenta SOLO al final, cuando
 * la palabra tal cual no casó con nada: si el catálogo dice "Carnitas", la
 * comparación normal ya acertó y aquí no se llega nunca.
 */
export function sinDiminutivo(p) {
  const w = normalizar(p);
  for (const suf of ['ecitos', 'ecitas', 'ecito', 'ecita', 'citos', 'citas',
    'cito', 'cita', 'itos', 'itas', 'ito', 'ita']) {
    if (!w.endsWith(suf)) continue;
    const base = w.slice(0, -suf.length);
    // Una base demasiado corta ya no es la misma palabra: "pita" no es "p".
    if (base.length < 4) continue;
    return base;
  }
  return null;
}

/** ¿Dos textos son la misma cosa salvo género/número? ("suizos" ≡ "Suiza") */
export function mismaRaiz(a, b) {
  const pa = palabras(a).map(raizPalabra).filter(Boolean);
  const pb = palabras(b).map(raizPalabra).filter(Boolean);
  if (!pa.length || pa.length !== pb.length) return false;
  return pa.every((w, i) => w === pb[i]);
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
  if (!previo) return false;                        // abre el mensaje: ver `esRespuestaDirecta`
  if (CONECTORES_DE_ATRIBUTO.has(previo)) return true;
  return anclas.some((a) => palabras(a).includes(previo));
}

/**
 * ¿El mensaje ES la respuesta a una pregunta? ("Entera", "Leche entera", "Suiza")
 *
 * Cuando el backend pregunta —y ahora pregunta casi siempre— el cliente
 * contesta con el nombre pelado de la opción. Ahí no hay conector delante,
 * así que `esCandidatoDeAtributo` lo descartaba y la selección se perdía: en un
 * smoke real, "Leche entera" no rescató nada y el bot volvió a pedir la leche.
 *
 * Estas menciones sirven para RESOLVER una selección que el borrador omitió,
 * pero NUNCA para acusar al negocio de no vender algo. La asimetría es
 * deliberada: recuperar una opción real es seguro; declarar inexistente lo que
 * el cliente dijo, cuando en realidad era un saludo o una palabra suelta, no lo
 * es. Por eso un "Hola" jamás puede producir "no manejamos hola".
 */
export function esRespuestaDirecta(span, texto) {
  const t = normalizar(texto);
  const s = normalizar(span);
  if (!t || !s) return false;
  if (palabraPrevia(span, texto)) return false;     // no abre el mensaje
  // El mensaje ES la respuesta: el span cubre casi todo lo que se dijo.
  return palabras(t).length <= palabras(s).length + 1;
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
  if (significativas.some((w) => spanEnTexto(w, textoCiclo))) return true;
  // El cliente concuerda en género y número con lo que está pidiendo:
  // "chilaquiles SUIZOS" por la salsa "Suiza". Su propia elección tiene que
  // contar como respaldo, o el backend la descarta y vuelve a preguntarla.
  const raices = new Set(palabras(textoCiclo).map(raizPalabra).filter((w) => w.length >= 3));
  if (significativas.some((w) => raices.has(raizPalabra(w)))) return true;
  // Y el cliente pide en diminutivo: "pollito" por "Pechuga de pollo". Aquí la
  // tolerancia es especialmente barata: NO estamos eligiendo por él, estamos
  // comprobando si respaldó una opción que el modelo ya interpretó. Un sí de
  // más solo confía en esa lectura; un no de más le niega lo que sí pidió.
  const dim = new Set(palabras(textoCiclo)
    .map((w) => sinDiminutivo(w)).filter(Boolean).map(raizPalabra));
  return significativas.some((w) => dim.has(raizPalabra(w)));
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
  // `atributos`  → pueden resolver Y pueden declarar que algo no existe.
  // `respuestas` → SOLO pueden resolver (ver `esRespuestaDirecta`).
  const salida = { atributos: [], respuestas: [], productos: [], notas: [], descartadas: [] };
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

    // BARRERA 3 — posición gramatical de atributo (conector o encadenado), o
    // bien el mensaje ENTERO es la respuesta a lo que se acaba de preguntar.
    if (!esCandidatoDeAtributo(span, textoTurno, anclas)) {
      if (esRespuestaDirecta(span, textoTurno)) {
        salida.respuestas.push(span);
        anclas.push(span);
        continue;
      }
      salida.descartadas.push({ span, motivo: 'sin_posicion_de_atributo' });
      continue;
    }
    salida.atributos.push(span);
    anclas.push(span);
  }
  return salida;
}
