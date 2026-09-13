// ─── Tapar dónde vive el cliente, sin tapar lo que pidió ──────────────────
//
// Módulo puro. Recibe el texto de un turno y devuelve el texto que puede ir a
// un log. Lo que se tapa es PII —dónde vive alguien—; lo que NO se toca es lo
// que hace útil el log: qué pidió, qué preguntó, qué entendió el mesero.
//
// Redactarlo todo es fácil y no sirve para nada: un log de cuarenta turnos que
// dice `[REDACTADO]` cuarenta veces no permite responder ninguna de las
// preguntas por las que se puso a observar.
//
// ── Por qué NO hay un detector de topónimos ──────────────────────────────
//
// La tentación es una lista de calles y colonias. No funciona en ninguna de las
// dos direcciones: hay decenas de miles, cambian, y el día que falte una se
// publica una dirección en un log; y al revés, «Milanesa» y «Naranjos» son
// platillos y también calles, así que la lista tapa comida.
//
// Lo que sí se reconoce es el MARCO, no el nombre. Las palabras con las que la
// gente —y el propio Xabor— enmarcan una dirección ya existen en el código, y
// de ahí se toman; esto no inventa una detección nueva:
//
//   prompts.js                «calle y número, colonia, referencia o entre qué calles»
//   utils/direccionRepartidor «Col. <colonia>, calle <calle>»
//   orders/carritoDelPedido   PREGUNTAS_CON_NUMEROS: direccion, telefono,
//                             codigo_postal, numero_exterior
//   agent/brain.js            DICE_DOMICILIO, y `pendiente === 'direccion'`
//
// Cuando el marco aparece, se tapa el fragmento entero —con topónimo incluido—
// sin haber tenido que saber que lo era.
//
// ── Por qué se copian dos expresiones en vez de importarlas ──────────────
//
// `brain.js` es un componente protegido y arrastra la base, el proveedor del
// modelo y el registro de pedidos. La sombra no lo importa a propósito: hay una
// prueba sobre el grafo de imports que lo comprueba. Duplicar doce palabras es
// el precio de que observar no pueda tocar lo observado.

// ── EL MARCO: LA PARTE QUE NO ES EL NOMBRE DEL LUGAR ─────────────────────
//
// Cuando aparece, no hace falta nada más. «Calle Naranja 900» es una dirección
// aunque haya jugo de naranja en la carta, y esa prioridad es deliberada:
// equivocarse hacia tapar un platillo cuesta un dato de análisis; equivocarse
// hacia publicar dónde vive alguien cuesta bastante más.
//
// Palabras enteras. Van entre `\b`, y esa es la parte que no se puede olvidar:
// sin frontera, `av` casa dentro de «clave» y la primera prueba que se corrió
// declaró que el registro entero era una dirección.
const MARCO_PALABRAS = [
  // Vialidad. `camino` y `cerrada` NO están, aunque sean tipos de vía: «voy en
  // camino» es media conversación de reparto y «ya cerraron» es una consulta de
  // horario. Cuando aparecen de verdad en un domicilio, casi siempre vienen
  // acompañadas de otra pieza del marco o de una cifra.
  'calle', 'calles', 'avenida', 'av', 'avda', 'blvd', 'boulevard', 'bulevar',
  'carretera', 'carr', 'andador', 'privada', 'priv',
  'callejon', 'callejón', 'prolongacion', 'prolongación', 'circuito', 'eje vial',
  // Asentamiento
  'colonia', 'fraccionamiento', 'fracc', 'barrio', 'ejido',
  'residencial', 'unidad habitacional', 'infonavit',
  // Piezas del domicilio
  'entre calles', 'esquina con', 'esquina de', 'esq', 'codigo postal', 'código postal',
  'numero exterior', 'número exterior', 'num ext', 'depto', 'dpto',
  'kilometro', 'kilómetro',
  // Cómo llegar, y DÓNDE VIVE. «mi casa» a secas no está —dice la modalidad, no
  // dónde vive nadie— pero «vivo en …» sí: es el marco con el que la gente
  // introduce su domicilio sin usar la palabra «calle», y fue el que se coló en
  // la propia prueba que certificaba que el log no llevaba PII.
  'vivo en', 'vivimos en', 'mi casa esta en', 'mi casa está en',
  'mi direccion', 'mi dirección', 'la direccion es', 'la dirección es',
  'mi domicilio es', 'te paso la direccion', 'te paso la dirección',
  'mi ubicacion', 'mi ubicación', 'google maps',
];

// Formas que llevan cifra pegada, donde la cifra es la que desambigua.
//
// TODAS llevan `\b` por delante. Sin él, `n[ºo]\s*\d` casaba dentro de
// cualquier palabra terminada en «-no»: «bueno 3 tortas», «chile relleno 2» y
// «café americano 2» se publicaban como `[DIRECCION_REDACTADA]`, que es
// justamente lo contrario de lo que se quería.
const MARCO_PATRONES = [
  '\\bc\\.?p\\.?\\s*\\d', '\\bint\\.?\\s*\\d', '\\bext\\.?\\s*\\d',
  '\\bmza?\\.?\\s*\\d', '\\blote\\s*\\d', '\\bmanzana\\s*\\d',
  '\\bdepartamento\\s*\\d', '\\bedificio\\s*\\d', '\\bkm\\s*\\d',
  // «#208», «no. 34», «nº 12» — la forma en que se escribe un número de casa.
  '#\\s*\\d', '\\bno\\.?\\s*\\d{1,5}\\b', '\\bn[ºo]\\.?\\s*\\d',
  // «Col Guillén» se escribe tal cual, sin punto, y es el caso del incidente
  // real. `col` sola es también la verdura, así que se exige que la siga un
  // nombre — y no una preposición, que es como aparece en «ensalada de col con
  // zanahoria». Dos caracteres bastan porque muchas colonias empiezan por
  // cifra: «Col 20 de Noviembre», «Col 5 de Mayo». Falso positivo conocido y
  // barato: «col morada».
  '\\bcol\\.?\\s+(?!con\\b|de\\b|del\\b|y\\b|e\\b|o\\b|a\\b|al\\b|para\\b|en\\b|sin\\b'
  + '|la\\b|el\\b|las\\b|los\\b)[a-z0-9ñ]+',
];

/**
 * El marco explícito de una dirección: la parte que NO es el nombre del lugar.
 *
 * Se prueba SIEMPRE contra texto ya normalizado (`norm`), que es donde viven
 * las variantes sin acento.
 */
export const MARCO_DE_DIRECCION = new RegExp(
  `(?:\\b(?:${MARCO_PALABRAS.join('|')})\\b)|(?:${MARCO_PATRONES.join('|')})`,
  'i',
);

/**
 * ¿Esta conversación es de entrega a domicilio?
 *
 * Copia literal de `DICE_DOMICILIO` en `brain.js`. Es la señal débil: por sí
 * sola no redacta nada, solo habilita la regla contextual de abajo.
 */
export const DICE_DOMICILIO = /\bdomicilio\b|\benv[íi]o\b|\benviar\b|\bmand(en|ar|a)\b|(me|nos)\s+lo\s+llev|llev\w*\s+a\s+(mi|la|el)\b|a\s+mi\s+casa\b/i;

/** Copia literal de `DICE_RECOGER`: si el cliente pasa por su pedido, no hay dirección que tapar. */
export const DICE_RECOGER = /\brecoger\b|\brecojo\b|\bpara llevar\b|\ben tienda\b|\bal local\b|\bmostrador\b|\bpas(o|ar[ée]?|amos)\s+(por|a)\b/i;

export const MARCA_DIRECCION = '[DIRECCION_REDACTADA]';
export const MARCA_EMAIL = '[EMAIL_REDACTADO]';
export const MARCA_COORDENADAS = '[COORDENADAS_REDACTADAS]';
export const MARCA_ENLACE = '[ENLACE_REDACTADO]';

/**
 * Correo, coordenadas y enlaces de mapa.
 *
 * Va SIEMPRE antes de la máscara de dígitos: unas coordenadas tapadas a
 * `##.####, -##.####` siguen siendo unas coordenadas, y un enlace de Maps
 * apunta al mismo portal con o sin cifras.
 *
 * Estas tres no necesitan contexto —ni modalidad, ni catálogo, ni marco— y por
 * eso se aplican siempre, también cuando el turno no tiene nada de entrega.
 */
export function redactarContacto(texto) {
  return String(texto || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, MARCA_EMAIL)
    // Un par de decimales con cuatro o más cifras: eso ya no es un precio.
    .replace(/-?\d{1,3}\.\d{4,}\s*[, ]\s*-?\d{1,3}\.\d{4,}/g, MARCA_COORDENADAS)
    .replace(/\bhttps?:\/\/\S+|\b(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.\S+)\S*/gi, MARCA_ENLACE);
}

// Se parte conservando los separadores para poder volver a unir el mensaje tal
// como venía. Es el mismo corte que usa `partirEnClausulas`, con el grupo
// capturado: un log que reordena las comas del cliente ya no es su mensaje.
//
// Con una excepción que costó una prueba: el punto de una abreviatura NO parte.
// «Calle Naranjos 900 col. Álamos» se cortaba justo en «col.» y dejaba el
// nombre de la colonia solo, sin marco, en su propio fragmento — que es
// exactamente el trozo que no debe publicarse.
const ABREVIA = 'col|av|avda|blvd|bulev|fracc|frac|priv|esq|mza|mz|depto|dpto|edif|int|ext|num|nro|km|lt';
const TROZOS = new RegExp(
  `((?<!\\b(?:${ABREVIA}))[,;.!?¿¡\\n]+`
  + '|\\s+(?:y|pero|ademas|adem[aá]s|tambien|tambi[eé]n|aparte|luego|despues|despu[eé]s)\\s+)',
  'i',
);

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const palabras = (s) => norm(s).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Las palabras de la carta, para no tapar comida.
 *
 * Se construye del catálogo REAL del negocio: nombres de producto, de categoría
 * y de opción. No hay lista fija de platillos en este archivo, igual que no la
 * hay en el resto del mesero.
 */
export function palabrasDeLaCarta(catalogo = []) {
  const fuera = new Set();
  for (const c of catalogo || []) {
    for (const w of palabras(c?.nombre)) if (w.length >= 3) fuera.add(w);
    for (const p of c?.productos || []) {
      for (const w of palabras(p?.nombre)) if (w.length >= 3) fuera.add(w);
      for (const g of p?.modificadores || []) {
        for (const o of g?.opciones || []) {
          for (const w of palabras(typeof o === 'string' ? o : o?.nombre)) if (w.length >= 3) fuera.add(w);
        }
      }
    }
  }
  return fuera;
}

const hablaDeLaCarta = (fragmento, vocabulario) => {
  if (!vocabulario || !vocabulario.size) return false;
  return palabras(fragmento).some((w) => vocabulario.has(w));
};

/**
 * ¿Este MENSAJE trae una dirección dentro?
 *
 * Se decide sobre el mensaje entero, no sobre cada trozo, porque una dirección
 * no cabe en un trozo: «Nogal 900, Álamos» son dos, y el segundo por sí solo no
 * se distingue de nada.
 *
 *   · sustancia   la regla de `brain.js`: «un "sí" o un "gracias" no es una
 *                 calle». Ahí el corte está en tres palabras, y se respeta.
 *   · marco       una de las palabras con las que se enmarca un domicilio; o
 *   · entrega     la conversación ya es a domicilio Y hay una cifra de dos o
 *                 más dígitos. Sin cifra no hay nada que distinga una dirección
 *                 de una frase cualquiera, y tapar frases cualesquiera es
 *                 justo lo que no se quiere.
 */
export function traeDireccion(texto, { entrega = false } = {}) {
  const t = String(texto || '');
  if (palabras(t).length < 3) return false;
  if (MARCO_DE_DIRECCION.test(norm(t))) return true;
  return entrega && /\d{2,}/.test(t);
}

/**
 * El texto del cliente, con la dirección tapada y lo demás intacto.
 *
 * Dentro de un mensaje que trae dirección, los trozos se deciden en orden y con
 * arrastre, porque una dirección es una RACHA:
 *
 *   marco            se tapa, y lo que sigue queda bajo sospecha
 *   habla de la carta se conserva, y corta la racha
 *   cifra            se tapa, y lo que sigue queda bajo sospecha
 *   bajo sospecha    se tapa
 *   nada de eso      se conserva
 *
 * El marco gana sobre la carta a propósito: «Calle Naranja 900» es una
 * dirección aunque haya jugo de naranja en el menú. Equivocarse hacia tapar un
 * platillo cuesta un dato de análisis; equivocarse hacia publicar el domicilio
 * de alguien cuesta bastante más.
 *
 * `entrega` es la señal contextual —que esta conversación va a domicilio— y
 * quien llama la deduce de lo que ya sabe: la modalidad que fijó el mesero o el
 * propio mensaje. Nunca de una lista de lugares.
 */
export function redactarDireccion(texto, { entrega = false, catalogo = null, vocabulario = null } = {}) {
  const original = String(texto || '');
  if (!traeDireccion(original, { entrega })) return { texto: original, redactado: false };
  const vocab = vocabulario || (catalogo ? palabrasDeLaCarta(catalogo) : null);
  const partes = original.split(TROZOS);
  let arrastre = false;
  let toco = false;
  const salida = partes.map((parte, i) => {
    if (i % 2 === 1) return parte;                       // es un separador
    if (!parte.trim()) return parte;
    const conMarco = MARCO_DE_DIRECCION.test(norm(parte));
    if (!conMarco && hablaDeLaCarta(parte, vocab)) { arrastre = false; return parte; }
    if (!conMarco && !/\d{2,}/.test(parte) && !arrastre) return parte;
    arrastre = true;
    toco = true;
    // Se conserva el espaciado de los bordes para que el mensaje siga leyéndose.
    const izq = parte.match(/^\s*/)[0];
    const der = parte.match(/\s*$/)[0];
    return `${izq}${MARCA_DIRECCION}${der}`;
  }).join('');
  // Dos marcas seguidas no dicen más que una: «[X]. [X]» se colapsa.
  const limpio = salida.replace(
    /\[DIRECCION_REDACTADA\](?:\s*(?:[,;.]|\sy\s|\se\s)?\s*\[DIRECCION_REDACTADA\])+/g, MARCA_DIRECCION,
  );
  return { texto: limpio, redactado: toco };
}

/** ¿Quedó algo con pinta de domicilio después de redactar? Para poder afirmarlo con una prueba. */
export const pareceDomicilioSinTapar = (texto) => {
  const t = norm(texto).replace(/\[direccion_redactada\]/g, ' ');
  return MARCO_DE_DIRECCION.test(t);
};
