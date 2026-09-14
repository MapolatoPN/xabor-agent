// ─── Del lenguaje del cliente a la identidad del catálogo ─────────────────
//
// Módulo puro. No consulta nada: recibe la carta del negocio y devuelve a qué
// producto, grupo y opción REALES corresponde lo que se dijo — o que no
// corresponde a ninguno, que es una respuesta igual de válida.
//
// ── El agujero que cierra ────────────────────────────────────────────────
//
// El 13-sep, en tráfico real, el cliente escribió «Quiero unos chilaquiles» y
// el pedido observado acabó así:
//
//   articulo      "chilaquiles"                 ← no existe en la carta
//   tipo          Suizos                        ← no existe ese grupo
//   acompañamientos  Frijolitos                 ← no existe ese grupo
//   acompañamiento   frijolitos/frijoles con chorizo   ← ni ese
//   proteína      huevo estrellado              ← el grupo real es "Proteína"
//
// Ninguna de esas cinco entidades existe en el catálogo de ese negocio. El
// reconciliador las autorizó todas porque su pregunta era «¿lo dijo el
// cliente?» y la respuesta era sí. Nadie preguntaba «¿existe?».
//
// La consecuencia no es cosmética: sin producto real no hay grupos reales, sin
// grupos no hay grupos REQUERIDOS, y toda la maquinaria de ambigüedades y
// pendientes —que funciona— se queda sin nada sobre lo que operar.
//
// ── Las tres capas, que aquí se separan de verdad ────────────────────────
//
//   el modelo PROPONE significado     «esto parece un acompañamiento»
//   el catálogo IDENTIFICA            group_id real, option_id real, o nada
//   el texto del cliente AUTORIZA     lo de siempre: DICHO / PERCIBIDO
//
// Este módulo es la capa de en medio, y sólo esa. No autoriza nada: devuelve
// identidad. Quien decide si la mutación entra sigue siendo el reconciliador,
// con sus mismas reglas.
//
// ── Lo que NO hay aquí ───────────────────────────────────────────────────
//
// Ni un nombre de producto, ni de grupo, ni de opción, ni de negocio. Ni una
// lista de sinónimos. Todo sale de la carta que se le pasa, y por eso el mismo
// motor resuelve unas pizzas que unos chilaquiles. Si algún día aparece aquí
// la palabra «chilaquiles», el módulo está roto.
import { productosVendibles, fichaDeProducto, buscarProductos, buscarCategorias } from './consultasDelMenu.js';
import { palabrasQueLaSostienen } from '../orders/evidenciaDeEleccion.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const lista = (xs) => (Array.isArray(xs) ? xs : []);

/** El nombre de una opción, venga como string o como objeto. */
const nombreDe = (o) => String(typeof o === 'string' ? o : (o?.nombre ?? '')).trim();

/**
 * QUÉ OPCIONES DE ESTE PRODUCTO SOSTIENE LO QUE DIJO EL CLIENTE.
 *
 * Se recorre el producto REAL: sus grupos, sus opciones. Por cada grupo se mide
 * cuántas palabras propias de cada opción aparecen en la evidencia, con la
 * misma función que ya usa el resto del sistema —diminutivos, género y número
 * incluidos— y se aplica la misma regla de siempre:
 *
 *   la más fuerte gana         «los frijoles con chorizo» → Frijolitos con chorizo
 *   empate = no elige          «con frijolitos»           → las dos, ambiguo
 *   ninguna = no se menciona
 *
 * Es deliberado que el GRUPO no se busque por su nombre: el modelo lo escribe
 * como le da la gana («tipo», «acompañamiento», «acompañamientos»), y la opción
 * sí es identificable. La opción encontrada es la que dice a qué grupo
 * pertenece. Por eso da igual cómo lo llame el modelo.
 */
export function mencionesEnProducto(ficha, evidencia) {
  const fuera = [];
  for (const g of lista(ficha?.grupos)) {
    const puntuadas = lista(g.opciones)
      .map((o) => ({ nombre: nombreDe(o), palabras: palabrasQueLaSostienen(nombreDe(o), evidencia) }))
      .filter((x) => x.nombre && x.palabras.size > 0);
    if (!puntuadas.length) continue;

    // ── DOS OPCIONES NO SON UNA AMBIGÜEDAD SI VIENEN DE PALABRAS DISTINTAS ──
    //
    // «con frijolitos» sostiene «Frijolitos naturales» y «Frijolitos con
    // chorizo» con LA MISMA palabra: la frase no las separa, y eso es una
    // pregunta.
    //
    // «suizos con chipotle» sostiene «Suiza» con una palabra y «Chipotle» con
    // otra: son dos elecciones, no una duda. Confundirlas hacía imposible
    // pedir dos salsas, que es justo lo que distingue una presentación de otra.
    //
    // Así que se agrupan por el CONJUNTO de palabras que las sostiene: mismo
    // conjunto, compiten; conjuntos distintos, conviven. Y dentro de cada
    // competencia gana la que encuentra más palabras propias, como siempre.
    const porEvidencia = new Map();
    for (const x of puntuadas) {
      const clave = [...x.palabras].sort().join(' ');
      if (!porEvidencia.has(clave)) porEvidencia.set(clave, []);
      porEvidencia.get(clave).push(x);
    }
    // Una competencia que es subconjunto de otra ya la explica la más
    // específica: «huevo estrellado» sostiene «Huevos Estrellados» (dos) y
    // «Huevos Revueltos» (una). La de una palabra no es otra elección: es la
    // misma, peor explicada.
    const claves = [...porEvidencia.keys()];
    const elegidas = [];
    const ambiguas = [];
    for (const clave of claves) {
      const propias = new Set(clave.split(' ').filter(Boolean));
      const absorbida = claves.some((otra) => {
        if (otra === clave) return false;
        const suyas = new Set(otra.split(' ').filter(Boolean));
        if (suyas.size <= propias.size) return false;
        for (const w of propias) if (!suyas.has(w)) return false;
        return true;
      });
      if (absorbida) continue;
      const grupo = porEvidencia.get(clave);
      if (grupo.length === 1) elegidas.push(grupo[0].nombre);
      else ambiguas.push(...grupo.map((x) => x.nombre));
    }
    fuera.push({
      grupo: g.nombre,
      requerido: g.requerido === true,
      minimo: g.minimo,
      maximo: g.maximo,
      elegidas,
      ambiguas,
    });
  }
  return fuera;
}

/**
 * ¿PUEDE ESTE PRODUCTO SOSTENER LO QUE EL CLIENTE PIDIÓ?
 *
 * Aquí es donde la cardinalidad del catálogo hace el trabajo. Un producto es
 * incompatible cuando:
 *
 *   · el cliente nombró una opción que este producto no ofrece en ningún grupo
 *     (la pidió «con algo» que este no lleva);
 *   · o nombró MÁS opciones de un grupo de las que ese grupo admite.
 *
 * Lo segundo es lo que distingue dos presentaciones del mismo platillo sin que
 * nadie escriba una regla sobre ellas: si una acepta como mucho una opción de
 * un grupo y otra acepta dos, nombrar dos deja viva sólo a la segunda. Sale de
 * `maximo`, que es dato del negocio.
 */
export function compatible(ficha, evidencia, { opcionesSueltas = [] } = {}) {
  const menciones = mencionesEnProducto(ficha, evidencia);

  for (const m of menciones) {
    // Una ambigüedad cuenta como UNA selección: sea cual sea la que gane, será
    // una.
    const firmes = m.elegidas.length;
    const pedidas = firmes + (m.ambiguas.length ? 1 : 0);
    if (pedidas === 0) continue;             // grupo que el cliente no tocó

    const max = Number.isFinite(Number(m.maximo)) && Number(m.maximo) > 0 ? Number(m.maximo) : null;
    const min = Number.isFinite(Number(m.minimo)) && Number(m.minimo) > 0 ? Number(m.minimo) : null;

    // NO LE CABEN. Aquí es donde «dos salsas» deja fuera a las presentaciones
    // que sólo admiten una, sin que nadie haya escrito una regla sobre salsas.
    if (max !== null && pedidas > max) {
      return { ok: false, motivo: `cardinalidad:${m.grupo}`, menciones, pedidas, maximo: max };
    }
    // LE FALTAN. Un producto que EXIGE dos de un grupo no es lo que describe
    // quien nombró una sola: una «mitad y mitad» con un solo sabor no es una
    // mitad y mitad. La comprobación se hace únicamente sobre los grupos que el
    // cliente TOCÓ — si no dijo nada de un grupo, todavía no ha terminado de
    // pedir y no se le puede descartar nada por eso.
    if (min !== null && pedidas < min) {
      return { ok: false, motivo: `faltan:${m.grupo}`, menciones, pedidas, minimo: min };
    }
  }

  // Lo que el cliente nombró y este producto NO ofrece en ningún grupo. Se mide
  // contra las opciones SUELTAS —las que alguno de los candidatos sí tiene—
  // para no castigar a un producto por palabras que no eran de una opción.
  const mias = new Set(menciones.flatMap((m) => [...m.elegidas, ...m.ambiguas].map(norm)));
  const faltantes = lista(opcionesSueltas)
    .filter((o) => !mias.has(norm(o)))
    .filter((o) => palabrasQueLaSostienen(o, evidencia).size > 0);
  // Una opción suelta sólo descarta si NINGUNA opción de este producto la
  // explica: si el cliente dijo «frijolitos» y este producto tiene su propio
  // «Frijolitos naturales», está cubierto aunque el nombre exacto sea otro.
  const sinCubrir = faltantes.filter((o) => {
    const palabras = palabrasQueLaSostienen(o, evidencia);
    return ![...mias].some((m) => {
      const suyas = palabrasQueLaSostienen(m, evidencia);
      for (const w of palabras) if (suyas.has(w)) return true;
      return false;
    });
  });
  if (sinCubrir.length) {
    return { ok: false, motivo: 'opcion_ajena', menciones, ajenas: sinCubrir };
  }

  return { ok: true, motivo: null, menciones };
}

/**
 * Todas las opciones de todos los candidatos que la evidencia sostiene.
 *
 * Sirve para saber si una opción que un candidato no tiene la tiene OTRO — que
 * es lo que permite descartar por «esto no lo lleva» sin inventarse nada.
 */
function opcionesSostenidas(fichas, evidencia) {
  const fuera = new Set();
  for (const f of fichas) {
    for (const g of lista(f.grupos)) {
      for (const o of lista(g.opciones)) {
        const n = nombreDe(o);
        if (n && palabrasQueLaSostienen(n, evidencia).size > 0) fuera.add(n);
      }
    }
  }
  return [...fuera];
}

const VACIAS = new Set(['de', 'con', 'sin', 'en', 'la', 'el', 'los', 'las', 'y', 'a', 'al', 'del', 'para']);

/** Las palabras propias de un nombre: las que de verdad lo identifican. */
const propiasDe = (nombre) => norm(nombre)
  .replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/)
  .filter((w) => w.length >= 3 && !VACIAS.has(w));

/**
 * Las fichas de partida: lo que la frase señala, con las dos reglas de desempate
 * que ya usa el resto del sistema.
 *
 *   1. FUERZA MÁXIMA. «Licuado de fresa» sostiene «Licuado de fresa» con dos
 *      palabras y «Licuado de plátano» con una: la frase SÍ los separa, y
 *      tratarlos como empate convertía cada bebida en una pregunta.
 *
 *   2. COINCIDENCIA COMPLETA. Con la misma fuerza, gana el producto cuyo nombre
 *      está ENTERO en la frase. «Chilaquiles» encuentra una palabra de
 *      «Chilaquiles» —que es todo su nombre— y una de «Chilaquiles suizos con
 *      pollo» —que es un tercio—. El primero es lo que el cliente dijo; el
 *      segundo es otra cosa que empieza igual.
 *
 * Cuando ninguna de las dos separa —«chilaquiles» contra cuatro presentaciones
 * que lo llevan en el nombre— quedan todas, y eso es una pregunta.
 */
function candidatosDePartida(catalogo, pistas, { ampliarFamilia = false } = {}) {
  const vistos = new Map();
  for (const pista of pistas.filter(Boolean)) {
    const hallados = buscarProductos(catalogo, pista);
    if (!hallados.length) continue;
    let mejores = hallados;
    if (!ampliarFamilia) {
      const tope = Math.max(...hallados.map((p) => p.fuerza));
      mejores = hallados.filter((p) => p.fuerza === tope);
      const completos = mejores.filter((p) => {
        const propias = propiasDe(p.nombre);
        return propias.length > 0 && propias.length === p.fuerza;
      });
      if (completos.length) mejores = completos;
    }
    for (const p of mejores) if (!vistos.has(norm(p.nombre))) vistos.set(norm(p.nombre), p);
  }
  if (vistos.size) return [...vistos.values()];
  // Sin producto, se prueba por CATEGORÍA: es la forma que tiene un término
  // genérico en la carta de cada negocio, y ya la usa el reconciliador.
  for (const pista of pistas.filter(Boolean)) {
    for (const c of buscarCategorias(catalogo, pista)) {
      for (const p of lista(c.productos)) if (!vistos.has(norm(p.nombre))) vistos.set(norm(p.nombre), p);
    }
  }
  return [...vistos.values()];
}

/**
 * ANCLAR UNA LÍNEA AL CATÁLOGO. Cero, uno o varios. Nunca inventar.
 *
 *   `nombrePropuesto`  cómo llamó el modelo al artículo. Es una PISTA, no una
 *                      identidad: sirve para buscar, no para guardar.
 *   `evidencia`        lo que el cliente ha dicho en este ciclo. Es lo único
 *                      que puede elegir entre opciones.
 *   `restringirA`      nombres canónicos a los que ya se había reducido la
 *                      línea en turnos anteriores. Es lo que hace progresiva la
 *                      resolución: la evidencia nueva se aplica sobre los
 *                      candidatos que quedaban, no sobre la carta entera.
 *
 * Devuelve SIEMPRE la misma forma, y `estado` manda:
 *
 *   sin_candidatos   nada de la carta corresponde        → no nace una línea
 *   resuelto         exactamente uno                     → identidad canónica
 *   ambiguo          varios siguen en pie                → se pregunta cuál
 */
export function anclarLinea({
  catalogo = [], nombrePropuesto = '', evidencia = '', restringirA = null, ampliarFamilia = false,
} = {}) {
  // `ampliarFamilia` desactiva los desempates por nombre y deja que decidan las
  // RESTRICCIONES. Se usa al reclasificar: ahí la identidad ya se conoce y la
  // pregunta es otra —«con estas opciones, ¿cuál de la familia encaja?»—, así
  // que quedarse con el que mejor casa el nombre sería quedarse con el de
  // antes, que es justo lo que se está revisando.
  const partida = candidatosDePartida(catalogo, [nombrePropuesto, evidencia], { ampliarFamilia });

  const acotados = Array.isArray(restringirA) && restringirA.length
    ? partida.filter((p) => restringirA.some((n) => norm(n) === norm(p.nombre)))
    : partida;
  // Si el acotado se queda vacío pero había candidatos, la restricción es vieja
  // y la evidencia nueva manda: se vuelve a la lista completa antes que mentir.
  const base = acotados.length ? acotados : partida;

  if (!base.length) {
    return { estado: 'sin_candidatos', producto: null, candidatos: [], grupos: [], motivo: 'no_esta_en_la_carta' };
  }

  const sueltas = opcionesSostenidas(base, evidencia);
  const evaluados = base.map((f) => ({ ficha: f, ...compatible(f, evidencia, { opcionesSueltas: sueltas }) }));
  const viables = evaluados.filter((e) => e.ok);

  if (!viables.length) {
    return {
      estado: 'sin_candidatos',
      producto: null,
      candidatos: [],
      grupos: [],
      motivo: evaluados[0]?.motivo || 'incompatible',
      descartados: evaluados.map((e) => ({ nombre: e.ficha.nombre, motivo: e.motivo })),
    };
  }

  if (viables.length === 1) {
    const v = viables[0];
    return {
      estado: 'resuelto',
      producto: v.ficha,
      candidatos: [],
      grupos: v.menciones,
      motivo: evaluados.length > 1 ? 'unico_compatible' : 'unico_candidato',
      descartados: evaluados.filter((e) => !e.ok).map((e) => ({ nombre: e.ficha.nombre, motivo: e.motivo })),
    };
  }

  return {
    estado: 'ambiguo',
    producto: null,
    candidatos: viables.map((v) => v.ficha),
    // Lo que TODOS los viables comparten sí se puede aplicar ya: si los cuatro
    // candidatos entienden «suiza» como la misma opción del mismo grupo, esa
    // elección no depende de cuál se acabe eligiendo.
    grupos: mencionesComunes(viables),
    motivo: 'varios_compatibles',
    descartados: evaluados.filter((e) => !e.ok).map((e) => ({ nombre: e.ficha.nombre, motivo: e.motivo })),
  };
}

/** Las menciones que TODOS los candidatos comparten, grupo a grupo. */
function mencionesComunes(viables) {
  if (!viables.length) return [];
  const [primero, ...resto] = viables;
  const fuera = [];
  for (const m of primero.menciones) {
    const iguales = resto.every((v) => {
      const suyo = v.menciones.find((x) => norm(x.grupo) === norm(m.grupo));
      if (!suyo) return false;
      return JSON.stringify(suyo.elegidas.map(norm).sort()) === JSON.stringify(m.elegidas.map(norm).sort())
        && JSON.stringify(suyo.ambiguas.map(norm).sort()) === JSON.stringify(m.ambiguas.map(norm).sort());
    });
    if (iguales) fuera.push(m);
  }
  return fuera;
}

/**
 * LOS MODIFICADORES CANÓNICOS DE UNA LÍNEA YA ANCLADA.
 *
 * Se construyen desde `anclarLinea`, es decir: desde las opciones REALES del
 * producto real que la evidencia del cliente sostiene. El nombre de grupo que
 * escribió el modelo no entra en ningún momento — no se traduce, no se mapea,
 * no se guarda: se ignora.
 *
 * Por eso «tipo», «acompañamiento» y «acompañamientos» no pueden producir tres
 * grupos: no producen ninguno. El grupo lo dice el catálogo, porque es el
 * catálogo el que sabe a qué grupo pertenece la opción que el cliente nombró.
 *
 * Sólo se devuelven las elegidas. Las ambiguas no son una selección todavía:
 * son la pregunta que `aclaraciones.js` va a redactar.
 */
export function modificadoresCanonicos(anclaje) {
  return lista(anclaje?.grupos)
    .filter((m) => m.elegidas.length)
    .map((m) => ({ grupo: m.grupo, opciones: [...m.elegidas] }));
}

/** Las ambigüedades de opción que el anclaje dejó abiertas, listas para preguntar. */
export function ambiguedadesDelAnclaje(anclaje, producto = null) {
  const nombre = producto || anclaje?.producto?.nombre || '';
  return lista(anclaje?.grupos)
    .filter((m) => m.ambiguas.length > 1)
    .map((m) => ({ opcion: m.ambiguas[0], empatan: m.ambiguas.slice(1), grupo: m.grupo, producto: nombre }));
}

/**
 * ANCLAR LAS PROPUESTAS DEL MODELO ANTES DE QUE LLEGUEN AL RECONCILIADOR.
 *
 * Es el punto donde se corta el problema de raíz. Entra lo que el modelo
 * escribió; sale lo mismo pero con identidad del catálogo, o no sale.
 *
 *   agregar con producto resuelto    → nombre canónico + modificadores canónicos
 *   agregar con varios candidatos    → NO se agrega nada: se pregunta cuál
 *   agregar sin candidatos           → se cae la propuesta
 *   cambiar_modificador              → se recalcula contra el producto real de
 *                                      esa línea; el nombre de grupo del modelo
 *                                      se descarta siempre
 *
 * Lo que NO hace: autorizar. Las propuestas que salen de aquí siguen pasando
 * por el reconciliador con sus mismas reglas de evidencia, y una opción sin
 * respaldo se sigue cayendo allí aunque el catálogo la haya identificado.
 */
/**
 * ¿A qué OPCIÓN REAL de este producto se refiere lo que escribió el modelo?
 *
 * Se mide contra el texto del propio modelo, que es quien hizo la propuesta.
 * Devuelve `{grupo, opcion}` reales, o `null` si no corresponde a nada — y
 * entonces la propuesta se cae, que es el punto.
 */
function opcionRealDe(ficha, textoDelModelo) {
  let mejor = null;
  let empate = false;
  for (const gr of lista(ficha?.grupos)) {
    for (const op of lista(gr.opciones)) {
      const nombre = nombreDe(op);
      const fuerza = palabrasQueLaSostienen(nombre, textoDelModelo).size;
      if (!fuerza) continue;
      if (!mejor || fuerza > mejor.fuerza) { mejor = { grupo: gr.nombre, opcion: nombre, fuerza }; empate = false; }
      else if (fuerza === mejor.fuerza && norm(mejor.opcion) !== norm(nombre)) empate = true;
    }
  }
  if (!mejor) return null;
  // Un empate lo resuelve la capa de ambigüedad de opciones, que ya existe y
  // sabe preguntar. Aquí sólo importa que el grupo sea real, y en un empate
  // ambas candidatas viven en el mismo grupo.
  return { grupo: mejor.grupo, opcion: mejor.opcion, empate };
}

/** La ficha del producto al que está anclada una línea del carrito. */
function fichaDeLaLinea(catalogo, nombre) {
  const p = productosVendibles(catalogo).find((x) => norm(x.nombre) === norm(nombre));
  return p ? fichaDeProducto(p) : null;
}

export function anclarPropuestas({
  catalogo = [], propuestas = [], carrito = null, evidencia = '',
} = {}) {
  const fuera = [];
  const ambiguos = [];       // productos que no se pudieron identificar solos
  const rechazados = [];     // lo que no existe en la carta
  const descartados = [];    // grupos y opciones que el modelo se inventó

  const porLid = new Map((carrito?.items || []).map((i) => [i.lid, i]));

  for (const p of lista(propuestas)) {
    if (!p) continue;

    if (p.accion === 'agregar') {
      const propuesto = String(p.valorNuevo?.nombre || '');
      // ── LA EVIDENCIA DE UNA LÍNEA ES LA DE ESA LÍNEA ──────────────────
      //
      // Se arma con lo que el modelo propuso PARA ESTE artículo: su nombre y
      // sus opciones. No con el texto del ciclo entero.
      //
      // La diferencia no es de matiz. Con el ciclo entero, un pedido de
      // «chilaquiles con salsa roja y unos hotcakes» declaraba los hotcakes
      // incompatibles —porque no tienen salsa roja— y los tiraba. La evidencia
      // de una línea no puede incluir lo que el cliente dijo de otra.
      const suyo = [propuesto, ...lista(p.valorNuevo?.modificadores)
        .flatMap((g) => lista(g?.opciones).map((o) => nombreDe(o)))].filter(Boolean).join(' ');
      const a = anclarLinea({ catalogo, nombrePropuesto: propuesto, evidencia: suyo });
      if (a.estado === 'sin_candidatos') {
        rechazados.push({ propuesto, motivo: a.motivo });
        continue;                                    // no nace una línea libre
      }
      if (a.estado === 'ambiguo') {
        ambiguos.push({ propuesto, candidatos: a.candidatos.map((c) => c.nombre), grupos: a.grupos });
        continue;                                    // se pregunta, no se elige
      }
      // Producto real. Sus modificadores se CANONIZAN uno a uno: lo que el
      // modelo llamó «tipo» pasa a llamarse como se llame de verdad el grupo al
      // que pertenece la opción, y lo que no corresponde a nada se cae.
      const porGrupo = new Map();
      for (const g of lista(p.valorNuevo?.modificadores)) {
        for (const o of lista(g?.opciones)) {
          const real = opcionRealDe(a.producto, nombreDe(o));
          if (!real) { descartados.push({ grupo: String(g?.grupo ?? ''), opcion: nombreDe(o), motivo: 'no_existe' }); continue; }
          if (!porGrupo.has(real.grupo)) porGrupo.set(real.grupo, new Set());
          porGrupo.get(real.grupo).add(real.opcion);
        }
      }
      fuera.push({
        ...p,
        valorNuevo: {
          ...p.valorNuevo,
          nombre: a.producto.nombre,
          ...(a.producto.id !== undefined ? { id: a.producto.id } : {}),
          modificadores: [...porGrupo].map(([grupo, ops]) => ({ grupo, opciones: [...ops] })),
        },
      });
      continue;
    }

    if (p.accion === 'cambiar_modificador') {
      const item = porLid.get(p.lid);
      const ficha = item ? fichaDeLaLinea(catalogo, item.nombre) : null;
      // Una línea que no está anclada a ningún producto real no tiene grupos a
      // los que pertenecer. No se adivina: la propuesta se cae.
      if (!ficha) {
        if (item) rechazados.push({ propuesto: String(item.nombre || ''), lid: p.lid, motivo: 'linea_sin_ancla' });
        continue;
      }
      const opciones = Array.isArray(p.valorNuevo) ? p.valorNuevo : [p.valorNuevo];
      const porGrupo = new Map();
      for (const o of opciones) {
        const texto = nombreDe(o);
        if (!texto) continue;
        const real = opcionRealDe(ficha, texto);
        if (!real) { descartados.push({ grupo: String(p.campo ?? ''), opcion: texto, motivo: 'no_existe' }); continue; }
        if (!porGrupo.has(real.grupo)) porGrupo.set(real.grupo, new Set());
        porGrupo.get(real.grupo).add(real.opcion);
      }
      // El nombre del grupo NUNCA es el que escribió el modelo: es el del grupo
      // real al que pertenece la opción. Por eso «tipo», «acompañamiento» y
      // «acompañamientos» no pueden producir tres grupos distintos.
      for (const [grupo, ops] of porGrupo) {
        const yaPuestas = lista(item.modificadores)
          .filter((x) => norm(x?.grupo) === norm(grupo))
          .flatMap((x) => lista(x.opciones).map((o) => nombreDe(o)))
          .filter(Boolean);
        fuera.push({ ...p, campo: grupo, valorAnterior: yaPuestas, valorNuevo: [...ops] });
      }
      continue;
    }

    fuera.push(p);   // cantidades, notas, modalidad, pago: no son del catálogo
  }

  return { propuestas: fuera, ambiguos, rechazados, descartados };
}
