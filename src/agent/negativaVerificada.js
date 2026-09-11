// ─── El candado: no se puede negar lo que sí tenemos ──────────────────────
//
// Módulo PURO (sin `pool`, sin `server.js`): se prueba sin levantar nada.
//
// ── Por qué existe ────────────────────────────────────────────────────────
//
// Ocho incidentes distintos, el mismo daño: el bot le dijo a un cliente que no
// manejamos algo que sí está en la carta.
//
//   'no manejamos "900" y "acoros" en Waffles'
//   'no manejamos "Prensado y panela en salsa"'
//   'no manejamos cebolla'
//   'no manejamos "con fruta"'
//   'no manejamos hola'                          <- a un saludo
//   'no manejamos "con pollo" en Chilaquiles Sencillos'
//   'no manejamos salsa suiza y pollo en Hotcakes Tradicionales'
//   'no manejamos "Chilaquiles"'                 <- el platillo más vendido
//
// Cada uno se arregló con una regla para su frase. La lista de reglas creció y
// el comportamiento por omisión nunca cambió: cuando el sistema no logra unir
// las palabras del cliente con la carta, NIEGA. Y negar es la respuesta más
// cara que existe en una conversación de venta.
//
// ── Qué hace distinto esto ────────────────────────────────────────────────
//
// Los arreglos anteriores hacen que el emparejamiento falle MENOS. Esto hace
// que el daño no pueda salir: antes de que una negativa llegue al cliente se
// comprueba contra el catálogo, y si lo negado SÍ está en la carta el mensaje
// no se manda. Da igual quién lo haya escrito -- el validador o el modelo.
//
// No sustituye a arreglar la causa: la avisa. Cada negativa interceptada es un
// reporte de error que se escribe solo, en el momento en que ocurre, en vez de
// esperar a que el dueño lo encuentre probando a las 6:40 de la tarde.
//
// ── Lo que este candado NO cubre, dicho de frente ─────────────────────────
//
// Compara contra NOMBRES: productos, opciones de modificador y categorías. No
// contra descripciones. «no manejamos "con fruta"», cuando la fruta solo vive
// en la descripción de los hotcakes, no lo atrapa. Se decidió así a propósito:
// las descripciones son prosa libre y harían saltar el candado en mensajes
// legítimos, y un candado que estorba se acaba quitando.

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

// Palabras que NO identifican nada por sí solas. Sin esto, «no tenemos esa
// salsa» dispararía el candado: "salsa" aparece en media carta.
const ESTRUCTURALES = new Set([
  'salsa', 'salsas', 'proteina', 'proteinas', 'guarnicion', 'guarniciones',
  'topping', 'toppings', 'tamano', 'tamanos', 'extra', 'extras', 'opcion',
  'opciones', 'sabor', 'sabores', 'grupo', 'complemento', 'complementos',
  'ingrediente', 'ingredientes', 'menu', 'carta', 'combo', 'orden', 'ordenes',
  'platillo', 'platillos', 'producto', 'productos', 'bebida', 'bebidas',
]);

const RELLENO = new Set([
  'esa', 'ese', 'eso', 'esas', 'esos', 'esta', 'este', 'esto', 'la', 'el',
  'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'con', 'sin', 'por',
  'ahora', 'hoy', 'ya', 'mas', 'ningun', 'ninguna', 'ningunos', 'ningunas',
  'nada', 'tipo', 'lo', 'al', 'y', 'o', 'en', 'para',
  // Coletillas de disponibilidad: el modelo escribe en prosa y cuelga cosas al
  // final —"Bistec en Salsa POR EL MOMENTO"—. Sin quitarlas, lo negado queda
  // contaminado y el candado deja pasar la mentira. Lo encontró el caso 3.
  'momento', 'ahorita', 'actualmente', 'disponible', 'disponibles',
  'existencia', 'existencias', 'inventario', 'temporada', 'dia', 'dias',
]);

// Las formas en que el sistema o el modelo le dicen que no a un cliente. El
// grupo 1 es SIEMPRE lo negado.
const PATRONES = [
  /(?:no|tampoco)\s+manejamos\s+([^.;\n!?]+)/gi,
  /(?:no|tampoco)\s+tenemos\s+([^.;\n!?]+)/gi,
  /(?:no|tampoco)\s+contamos\s+con\s+([^.;\n!?]+)/gi,
  /(?:no|tampoco)\s+disponemos\s+de\s+([^.;\n!?]+)/gi,
  /(?:no|tampoco)\s+hay\s+([^.;\n!?]+)/gi,
];

// "no tenemos chilaquiles y tampoco hay waffles" es UNA frase con DOS
// negativas. Sin partirla, lo negado sería el churro entero y el aviso al
// dueño nombraría algo que nadie dijo. Se evalúa pedazo por pedazo.
const partirEnumeracion = (frase) => String(frase)
  .split(/\s*(?:,|;| y | e | ni | o |\btampoco\b)\s*/i)
  .map((x) => x.trim())
  .filter(Boolean);

/**
 * Los nombres contra los que se comprueba una negativa. Solo NOMBRES: de
 * productos, de opciones de modificador y de categorías.
 */
export function terminosDelCatalogo(catalogo = []) {
  const terminos = [];
  const visto = new Set();
  const agregar = (nombre, ofrece) => {
    const n = String(nombre || '').trim();
    if (!n || visto.has(n)) return;
    visto.add(n);
    terminos.push({ nombre: n, ofrece: ofrece.filter(Boolean) });
  };
  for (const cat of catalogo) {
    const productos = (cat?.productos || []).map((p) => String(p?.nombre || '')).filter(Boolean);
    // Una CATEGORÍA sirve para detectar ("no tenemos desayunos") pero no se le
    // ofrece al cliente: nadie pide "un DESAYUNOS". Lo que se ofrece en su
    // lugar son los platillos que contiene.
    if (cat?.nombre) agregar(cat.nombre, productos);
    for (const p of (cat?.productos || [])) {
      if (p?.nombre) agregar(p.nombre, [String(p.nombre)]);
      for (const g of (p?.modificadores || [])) {
        for (const o of (g?.opciones || [])) {
          if (o?.nombre) agregar(o.nombre, [String(o.nombre)]);
        }
      }
    }
  }
  return terminos;
}

/** Quita comillas, relleno y estructurales; deja lo que de verdad identifica. */
function nucleo(frase) {
  const limpio = norm(String(frase).replace(/["«»“”']/g, ' '));
  const palabras = limpio.split(' ')
    .filter((w) => w && !RELLENO.has(w) && !ESTRUCTURALES.has(w));
  return palabras.join(' ');
}

/**
 * ¿Lo negado existe en la carta?
 *
 * Misma regla de emparejamiento que usa el resolvedor de productos —igualdad
 * normalizada, o contención por palabra completa en cualquier dirección— para
 * que el candado y el resolvedor no puedan opinar distinto sobre la misma
 * frase. Devuelve los nombres reales que lo contradicen.
 */
export function contradiceElCatalogo(loNegado, terminos = []) {
  const buscado = nucleo(loNegado);
  if (!buscado) return [];
  // Una sola palabra corta ("pan", "te") empareja con demasiadas cosas: no es
  // identificación, es ruido. Se exige una palabra con cuerpo.
  if (!buscado.split(' ').some((w) => w.length >= 4)) return [];
  const contienePalabra = (texto, sub) => ` ${texto} `.includes(` ${sub} `);
  const ofrecibles = [];
  for (const t of terminos) {
    // Los DOS lados se reducen igual. Reducir solo la pregunta dejaba escapar
    // todo nombre con partícula en medio: "Pechuga de pollo" quedaba como
    // "pechuga pollo" de un lado y "pechuga de pollo" del otro, y no casaban.
    // Lo encontró el caso 14, que intenta negar la carta entera nombre por
    // nombre -- exactamente para que un hueco así no dependa de que a alguien
    // se le ocurra el ejemplo.
    const n = nucleo(t.nombre);
    if (!n) continue;
    // LA DIRECCIÓN IMPORTA, y es la diferencia entre proteger y estorbar:
    //
    //   negado "chilaquiles"  ⊂  "Chilaquiles Sencillos"  -> negativa FALSA:
    //       el cliente nombró la familia y tenemos variantes de ella.
    //   negado "chilaquiles veganos"  ⊃  "chilaquiles"     -> negativa VÁLIDA:
    //       el cliente pidió algo MÁS específico que lo que hay, y decirle que
    //       no es la respuesta correcta.
    //
    // Solo se ataja el primer caso. Emparejar en las dos direcciones hacía que
    // el candado bloqueara negativas legítimas, que es la forma más rápida de
    // que alguien acabe quitándolo.
    if (n === buscado || contienePalabra(n, buscado)) ofrecibles.push(...t.ofrece);
  }
  return [...new Set(ofrecibles)];
}

/**
 * Revisa un mensaje ya redactado, a punto de salir hacia el cliente.
 *
 * Devuelve `{ seguro, hallazgos }`. Cada hallazgo trae la frase negada y los
 * nombres del catálogo que la desmienten.
 */
export function revisarNegativas(texto, terminos = []) {
  const t = String(texto || '');
  if (!t.trim() || !terminos.length) return { seguro: true, hallazgos: [] };
  const hallazgos = [];
  const vistos = new Set();
  for (const patron of PATRONES) {
    patron.lastIndex = 0;
    let m;
    while ((m = patron.exec(t)) !== null) {
      for (const negado of partirEnumeracion(m[1] || '')) {
        if (vistos.has(negado.toLowerCase())) continue;
        const existen = contradiceElCatalogo(negado, terminos);
        if (existen.length) { vistos.add(negado.toLowerCase()); hallazgos.push({ negado, existen }); }
      }
    }
  }
  return { seguro: hallazgos.length === 0, hallazgos };
}

/**
 * El mensaje que sale EN LUGAR de la negativa falsa.
 *
 * Se construye con los nombres reales del catálogo, así que dice la verdad por
 * construcción. Es la misma forma que ya usa el validador cuando un platillo
 * tiene varias variantes: se ofrece y se pregunta, no se niega.
 */
export function mensajeEnLugarDeLaNegativa(hallazgos = []) {
  const partes = hallazgos.slice(0, 2).map((h) => {
    const ops = h.existen.slice(0, 6);
    if (ops.length === 1) return `Sí tenemos ${ops[0]}. ¿Te lo preparo?`;
    const lista = `${ops.slice(0, -1).join(', ')} o ${ops[ops.length - 1]}`;
    return `Sí manejamos eso: tenemos ${lista}. ¿Cuál prefieres?`;
  });
  return partes.join(' ');
}

// ─── Aviso: quién quiere enterarse de una negativa interceptada ───────────
//
// El registro vive AQUÍ, y no en brain.js, por una razón concreta: el canal se
// suscribe al importar, y brain.js participa en un ciclo de módulos con
// server.js. Registrarse contra brain corría antes de que su cuerpo terminara
// de inicializarse y reventaba con "Cannot access 'avisos' before
// initialization". Este módulo no importa nada, así que no puede pasarle.
const suscriptores = [];

export function registrarAvisoNegativaFalsa(cb) {
  if (typeof cb === 'function') suscriptores.push(cb);
}

/** Un aviso jamás puede tumbar una respuesta al cliente. */
export function avisarNegativaFalsa(negocioId, hallazgos) {
  for (const cb of suscriptores) {
    try { Promise.resolve(cb(negocioId, hallazgos)).catch(() => {}); } catch { /* nunca propaga */ }
  }
}
