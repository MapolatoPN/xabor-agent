// ─── El borrador del modelo es una hipótesis, no una estructura ───────────
//
// Módulo puro. Se sienta ENTRE el modelo y el motor transaccional, y convierte
// lo que el modelo escribió —que puede venir incompleto, mal atribuido o
// directamente equivocado— en una propuesta canónica que el reconciliador puede
// juzgar con sus reglas de siempre.
//
// ── Lo que el smoke real enseñó, y ninguna prueba veía ────────────────────
//
// 15-sep, Obispado, seis mensajes reales contra GPT:
//
//   T1  «Quiero chilaquiles suizos»   -> línea 1  Chilaquiles Sencillos, SIN salsa
//   T2  «Con frijolitos»              -> línea 2
//   T3  «Con chorizo»                 -> línea 3
//   T4  «También chipotle»            -> línea 4
//   T5  «Con huevo estrellado»        -> línea 5
//   T6  «Que licuados tienen?»        -> línea 6   ← ¡una consulta!
//
// Seis mensajes, seis renglones, seis `lid`. En las suites nunca pasó porque
// los borradores se inyectaban a mano y salían perfectos.
//
// ── Y LA CAUSA NO ERA EL MODELO: ERA NUESTRA ──────────────────────────────
//
// `propuestasDesdeBorrador` empareja cada renglón del borrador con uno del
// carrito usando `parecido`, que compara NOMBRES. El anclaje, un paso después,
// renombra el renglón a su nombre CANÓNICO. Desde el turno siguiente, el modelo
// sigue diciendo lo que dijo el cliente y el carrito ya dice otra cosa:
//
//   carrito  «Chilaquiles Sencillos»
//   modelo   «chilaquiles suizos»
//   parecido -> -1   «nombres ajenos: no son el mismo»   -> RENGLÓN NUEVO
//
// Medido: «chilaquiles» empareja (60), «Chilaquiles Sencillos» empareja (100),
// y «chilaquiles suizos» NO (-1), porque cada uno tiene una palabra que el otro
// no. Canonizar el nombre rompió el puente entre turnos, y lo rompió en una
// función que vive en el componente protegido y que no hay por qué tocar.
//
// ── Las cuatro cosas que decide aquí el CÓDIGO, no el modelo ──────────────
//
//   1. A QUÉ RENGLÓN habla este turno. El `lid` del modelo no es autoridad:
//      puede venir nulo, inventado o de otro renglón.
//   2. QUÉ ENTIDADES nombró el cliente. El modelo puede olvidarlas —olvidó
//      «Suiza» en T1— y el catálogo sabe encontrarlas en el texto real.
//   3. CONTRA QUÉ se resuelve una respuesta. Si hay una pregunta abierta, se
//      resuelve dentro de SUS candidatos antes de mirar la carta entera.
//   4. SI ESTE TURNO MUTA ALGO. Una consulta pura no toca el pedido, diga lo
//      que diga el borrador.
//
// No autoriza nada: lo que sale de aquí sigue pasando por el reconciliador con
// sus mismas reglas de evidencia. Y no hay un solo nombre de producto escrito
// en este archivo.
import { anclarLinea } from './anclajeAlCatalogo.js';
import { productosVendibles, fichaDeProducto, opcionesDelGrupoDeProducto } from './consultasDelMenu.js';
import { palabrasQueLaSostienen, distingueLaEleccion } from '../orders/evidenciaDeEleccion.js';
import { operacionSobreElGrupo } from './mutacionDeOpciones.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const lista = (xs) => (Array.isArray(xs) ? xs : []);
const nombreDe = (o) => String(typeof o === 'string' ? o : (o?.nombre ?? '')).trim();

/** Las opciones que un renglón ya tiene puestas, por grupo canónico. */
function puestasPorGrupo(item) {
  const m = new Map();
  for (const g of lista(item?.modificadores)) {
    const clave = norm(g?.grupo);
    if (!m.has(clave)) m.set(clave, { grupo: String(g?.grupo || ''), opciones: [] });
    for (const o of lista(g?.opciones)) {
      const n = nombreDe(o);
      if (n) m.get(clave).opciones.push(n);
    }
  }
  return m;
}

/**
 * ¿SON EL MISMO PLATILLO, AUNQUE SE LLAMEN DISTINTO?
 *
 * Aquí está el puente que `parecido` no puede cruzar. Dos nombres pertenecen al
 * mismo renglón cuando el CATÁLOGO dice que son de la misma familia: se anclan
 * a productos que comparten núcleo. «Chilaquiles Sencillos» y «chilaquiles
 * suizos» lo son; «Chilaquiles Sencillos» y «Licuado de fresa» no.
 *
 * Se mide con la carta, no con una lista: las palabras propias del nombre del
 * renglón que aparecen en el nombre propuesto, y al revés. Si alguna de las dos
 * direcciones encuentra algo, hablan del mismo platillo.
 */
export function mismaFamilia(catalogo, nombreEnCarrito, nombrePropuesto) {
  const a = String(nombreEnCarrito || '');
  const b = String(nombrePropuesto || '');
  if (!a || !b) return false;
  if (norm(a) === norm(b)) return true;
  if (palabrasQueLaSostienen(a, b).size > 0 || palabrasQueLaSostienen(b, a).size > 0) {
    // Comparten palabra. Para no unir dos platillos que sólo coinciden en un
    // genérico, se exige que la carta los reconozca como parientes: el producto
    // del renglón tiene que estar entre los candidatos que produce el nombre
    // propuesto, o al revés.
    const candidatos = productosVendibles(catalogo)
      .filter((p) => palabrasQueLaSostienen(p.nombre, b).size > 0)
      .map((p) => norm(p.nombre));
    if (candidatos.includes(norm(a))) return true;
    const alReves = productosVendibles(catalogo)
      .filter((p) => palabrasQueLaSostienen(p.nombre, a).size > 0)
      .map((p) => norm(p.nombre));
    return alReves.includes(norm(b));
  }
  return false;
}

/**
 * ─── A QUÉ RENGLÓN LE HABLA ESTE TURNO ───────────────────────────────────
 *
 * Devuelve `{ lid, motivo, candidatos }`. `lid` null significa «renglón nuevo»;
 * `candidatos` con más de uno significa «hay que preguntar», y entonces NO se
 * elige: elegir el último es exactamente el error que este módulo viene a
 * impedir.
 *
 * El orden de las reglas es el orden de la autoridad:
 *
 *   1. LO QUE EL CLIENTE SEÑALÓ. Si la referencia resolvió a un renglón, es ése.
 *   2. UN SOLO RENGLÓN COMPATIBLE. Con un pedido de una línea y una intención de
 *      modificar, no hay nada que adivinar.
 *   3. EL FOCO, si es compatible. Es de lo que se venía hablando.
 *   4. VARIOS COMPATIBLES -> se pregunta.
 *
 * El `lid` que venga del modelo se usa SÓLO si existe de verdad en el carrito;
 * si es nulo, inventado o de otro renglón, se ignora sin ruido — no es una
 * fuente de verdad, es una sugerencia.
 */
export function resolverObjetivo({
  catalogo = [], carrito = null, contexto = null, intenciones = [],
  nombrePropuesto = '', lidDelModelo = null, referencia = null, esAlta = false,
} = {}) {
  const items = lista(carrito?.items);
  if (!items.length) return { lid: null, motivo: 'carrito_vacio', candidatos: [] };

  // 1) Lo que el cliente señaló manda… SOBRE LO QUE SEÑALÓ.
  //
  // «Ponme dos cocas» resuelve la referencia elíptica al renglón en foco —los
  // chilaquiles— y el cliente está nombrando OTRA cosa. Aplicarle esa
  // referencia al artículo nombrado hacía desaparecer la coca y subía a dos los
  // chilaquiles que nadie pidió: el foco ganándole al nombre explícito, que es
  // justo al revés.
  //
  // Así que una referencia sólo vincula a un artículo cuando hablan del mismo
  // platillo. Si el borrador nombra otro producto, el nombre manda y la
  // referencia no le toca.
  if (referencia?.resuelta && lista(referencia.lids).length === 1) {
    const lid = referencia.lids[0];
    const senalado = items.find((i) => i.lid === lid);
    const hablaDeOtro = String(nombrePropuesto || '').trim()
      && senalado && !mismaFamilia(catalogo, senalado.nombre, nombrePropuesto);
    if (senalado && !hablaDeOtro) return { lid, motivo: 'referencia_del_cliente', candidatos: [] };
    if (hablaDeOtro) return { lid: null, motivo: 'nombre_explicito_gana_al_foco', candidatos: [] };
  }
  if (referencia?.resuelta && lista(referencia.lids).length > 1) {
    return { lid: null, motivo: 'referencia_multiple', candidatos: referencia.lids };
  }

  // Un alta EXPLÍCITA del cliente crea renglón, aunque haya foco.
  if (esAlta) return { lid: null, motivo: 'alta_explicita', candidatos: [] };

  // 2/3) Los renglones que este nombre podría estar describiendo.
  const compatibles = nombrePropuesto
    ? items.filter((i) => mismaFamilia(catalogo, i.nombre, nombrePropuesto))
    : items;

  // El `lid` del modelo sólo vale si señala a uno de los compatibles. Nunca se
  // usa a ciegas: un `lid` de otro renglón modificaría en silencio algo que el
  // cliente no tocó.
  if (lidDelModelo && compatibles.some((i) => i.lid === lidDelModelo)) {
    return { lid: lidDelModelo, motivo: 'lid_del_modelo_verificado', candidatos: [] };
  }

  if (compatibles.length === 1) return { lid: compatibles[0].lid, motivo: 'unico_compatible', candidatos: [] };

  if (compatibles.length > 1) {
    const foco = contexto?.foco || null;
    if (foco && compatibles.some((i) => i.lid === foco)) {
      // El foco sólo decide si el cliente no dio con qué separarlos. Si nombró
      // algo que distingue a uno, eso ya lo habría resuelto la referencia.
      return { lid: foco, motivo: 'foco', candidatos: compatibles.map((i) => i.lid) };
    }
    return { lid: null, motivo: 'varios_compatibles', candidatos: compatibles.map((i) => i.lid) };
  }

  return { lid: null, motivo: 'ninguno_compatible', candidatos: [] };
}

/**
 * ─── LAS ENTIDADES QUE DIJO EL CLIENTE, LAS PROPONGA EL MODELO O NO ───────
 *
 * En T1 el cliente escribió «Quiero chilaquiles suizos» y el modelo devolvió el
 * platillo sin salsa: la Suiza viajaba dentro del NOMBRE, y `anclarPropuestas`
 * sólo canoniza lo que el modelo puso en `modificadores`. Resultado: el bot
 * preguntó «¿qué salsa le pongo?» por algo que el cliente acababa de decir.
 *
 * El catálogo ya sabe encontrar opciones en un texto —es lo que hace
 * `mencionesEnProducto`—; lo que faltaba era usarlo sobre el MENSAJE REAL y no
 * sólo sobre el borrador.
 *
 * Y con el mismo freno de siempre: una opción entra sólo si existe en ese grupo
 * de ese producto, y sólo si la palabra del cliente la SEPARA de sus hermanas.
 * Si no la separa, no se elige: eso ya es una pregunta, y la hace quien sabe.
 */
/**
 * ─── DECIR EL NOMBRE DE UN GRUPO NO ES ELEGIR EN OTRO ─────────────────────
 *
 * Smoke del 19-sep, turno 9. El cliente escribió «Mejor salsa roja» sobre un
 * pedido ya confirmado. La salsa cambió bien, pero además se le preguntó
 * «¿Bistec en Salsa, Queso Panela en Salsa o Chicharron Cuerito en Salsa?»
 * —tres opciones del grupo PROTEÍNA— y con esa pregunta abierta el pedido ya
 * no se podía volver a confirmar.
 *
 * La carta de Obispado tiene tres proteínas y tres guarniciones que se llaman
 * «… en Salsa». La palabra «salsa» las sostiene a todas por igual, ninguna
 * separa, y eso es exactamente la forma de una ambigüedad legítima. Pero no lo
 * es: el cliente estaba NOMBRANDO EL GRUPO, no eligiendo una proteína.
 *
 * La regla, mínima: la palabra que es el nombre de OTRO grupo del mismo
 * producto no sostiene a las opciones de éste. Se quita del texto antes de
 * medir, así que la quitan por igual `palabrasQueLaSostienen` y
 * `distingueLaEleccion`, que es lo que evita que una mida una cosa y la otra
 * otra.
 *
 * Lo que NO hace, y es lo que la mantiene honesta:
 *
 *   «Mejor bistec en salsa»   «bistec» no es nombre de grupo → sigue eligiendo
 *   «Con frijolitos»          no hay grupo llamado así → la duda sigue viva
 *   «salsa roja y pechuga»    cada grupo se resuelve por su palabra propia
 *
 * Una opción que sólo se sostenía con el nombre de otro grupo se queda sin
 * respaldo, que es justo lo que debía pasar desde el principio.
 */
function textoParaElGrupo(texto, ficha, grupo) {
  const otros = lista(ficha?.grupos)
    .map((g) => norm(g?.nombre))
    .filter((n) => n && n !== norm(grupo));
  if (!otros.length) return texto;
  // Se quitan PALABRA A PALABRA y con frontera, no como subcadena: un grupo
  // llamado «Salsa» no puede borrar «Salsas» de un nombre de opción ni partir
  // una palabra por la mitad.
  const palabras = new Set(otros.flatMap((n) => n.split(/\s+/)).filter((w) => w.length >= 4));
  if (!palabras.size) return texto;
  return String(texto || '').split(/(\s+)/)
    .map((tramo) => (palabras.has(norm(tramo).replace(/[^a-z0-9ñ]+/g, '')) ? ' ' : tramo))
    .join('');
}

export function opcionesDelTexto({
  ficha = null, texto = '', soloGrupos = null, conAmbiguas = false, conCompetidoras = false,
} = {}) {
  if (!ficha || !String(texto || '').trim()) return conAmbiguas ? { claras: [], ambiguas: [] } : [];
  const fuera = [];
  const ambiguas = [];
  for (const g of lista(ficha.grupos)) {
    if (soloGrupos && !soloGrupos.some((x) => norm(x) === norm(g.nombre))) continue;
    const hermanas = lista(g.opciones).map(nombreDe).filter(Boolean);
    // Para ESTE grupo, el texto sin los nombres de los demás.
    const texto_ = textoParaElGrupo(texto, ficha, g.nombre);
    // ── LO QUE LA FRASE SOSTIENE PERO NO SEPARA ES UNA PREGUNTA ─────────
    //
    // «Con frijolitos» sostiene a las dos de frijolitos por igual. No entra
    // ninguna —eso ya lo impide la regla de abajo— pero tampoco puede caerse en
    // silencio: sin la pregunta, el turno siguiente («con chorizo») no tiene
    // contra qué resolverse y acaba compitiendo con las papas de la carta
    // entera. Fue exactamente lo que pasó en el smoke real.
    const sostenidas = hermanas.filter((n) => palabrasQueLaSostienen(n, texto_).size > 0);
    if (sostenidas.length > 1) {
      const ningunaSepara = sostenidas.every((n) => !distingueLaEleccion(n, hermanas, texto_).distingue);
      if (ningunaSepara) {
        ambiguas.push({ grupo: String(g.nombre || ''), candidatos: sostenidas });
        // ── LA COMPETENCIA VIAJA, LA DECISIÓN NO ─────────────────────────
        //
        // «Con frijolitos» sostiene a las dos por igual. Si no salen de aquí, el
        // filtro de ambigüedad no las ve, no hay pregunta, y el turno siguiente
        // («con chorizo») se queda sin universo contra el que resolverse. Salen
        // las dos, sin elegir: quien pregunta es la capa que ya sabe hacerlo.
        if (conCompetidoras) for (const c of sostenidas) fuera.push({ grupo: String(g.nombre || ''), opcion: c });
      }
    }
    for (const nombre of hermanas) {
      const suyas = palabrasQueLaSostienen(nombre, texto_);
      if (!suyas.size) continue;
      // ── AQUÍ SE ENTRA POR LA PUERTA DE ATRÁS, ASÍ QUE SE ENTRA ENTERO ──
      //
      // Esta vía añade opciones que el modelo NO propuso, sacándolas del texto
      // del cliente. Es potente y por eso se exige lo más estricto: que el
      // cliente haya nombrado la opción COMPLETA, con todas sus palabras
      // propias.
      //
      // «con queso azul» sostiene «Queso Panela en Salsa» con la palabra
      // «queso» y no hay otra opción de queso que compita, así que el guardia
      // de ambigüedad la daría por buena — y volveríamos a servir un queso que
      // nadie pidió, por una puerta nueva. Con el nombre completo, «panela» no
      // aparece y no entra.
      //
      // Y no estorba a lo que sí debe pasar: «huevo estrellado» nombra entero a
      // «Huevos Estrellados», y «suizos» entero a «Suiza». Lo que se nombra a
      // medias —«con chorizo»— no entra por aquí: eso es una respuesta a una
      // pregunta abierta, y la resuelve `resolverContraPendiente`.
      // Las palabras PROPIAS se cuentan con la misma vara que las dichas: si
      // «salsa» no puede ser evidencia para este grupo, tampoco cuenta como
      // palabra que el cliente tenga que decir. Sin esta simetría, «Mejor
      // bistec en salsa» dejaba de elegir «Bistec en Salsa» —se le exigía una
      // palabra que acabábamos de declarar inservible— y el arreglo de la
      // pregunta espuria se llevaba por delante una elección legítima.
      const propias = palabrasQueLaSostienen(nombre, textoParaElGrupo(nombre, ficha, g.nombre));
      if (suyas.size < propias.size) continue;
      const { distingue } = distingueLaEleccion(nombre, hermanas, texto_);
      if (distingue) fuera.push({ grupo: String(g.nombre || ''), opcion: nombre });
    }
  }
  return conAmbiguas ? { claras: fuera, ambiguas } : fuera;
}

/**
 * ─── UNA RESPUESTA SE MIDE CONTRA LA PREGUNTA QUE SE HIZO ─────────────────
 *
 * «Con chorizo», con una pregunta abierta entre «Frijolitos naturales» y
 * «Frijolitos con chorizo», significa una de esas dos. Buscar primero en la
 * carta entera encuentra además «Papas con chorizo» y convierte una respuesta
 * clara en otra pregunta — que fue exactamente lo que pasó en el smoke.
 *
 * Así que si hay pendiente abierto y el texto resuelve DENTRO de sus
 * candidatos, ahí se acaba la búsqueda.
 */
export function resolverContraPendiente({ pendientes = [], texto = '', grupo = null } = {}) {
  const abiertos = lista(pendientes).filter((p) => (p?.tipo === 'opcion_ambigua' || p?.tipo === 'grupo_requerido')
    && lista(p.candidatos).length >= 2
    && (!grupo || norm(p.grupo) === norm(grupo)));
  for (const p of abiertos) {
    const candidatos = lista(p.candidatos).map((c) => nombreDe(c)).filter(Boolean);
    const sostenidas = candidatos.filter((c) => palabrasQueLaSostienen(c, texto).size > 0);
    if (sostenidas.length !== 1) continue;
    const { distingue } = distingueLaEleccion(sostenidas[0], candidatos, texto);
    if (distingue) return { opcion: sostenidas[0], grupo: String(p.grupo || ''), clave: p.clave || null };
  }
  return null;
}

// Marcadores de que el turno es un ACTO sobre el pedido y no un comentario.
// Es la misma frontera que ya distingue sumar de sustituir; aquí sólo se
// pregunta si hay acto, no cuál.
const PIDE_ALGO = new RegExp('\\b('
  + 'tambien|también|ademas|además|'                       // suma
  + 'agrega|agregale|agrégale|agregame|agrégame|'          // alta
  + 'ponle|ponme|pon|dame|traeme|tráeme|mandame|mándame|'  // petición directa
  + 'quiero|quisiera|necesito|'
  + 'quita|quitale|quítale|sin|'                           // resta
  + 'mejor|cambia|que sea|'                                // sustitución
  + 'con'                                                  // atributo
  + ')\\b', 'i');

/**
 * ─── REPARAR «OTRO», PERO SÓLO CON EVIDENCIA ─────────────────────────────
 *
 * El clasificador mandó «También chipotle» a `OTRO`. Tenemos delante un renglón
 * en foco, un grupo real, una opción que existe y un marcador de adición: eso
 * es una mutación, y depender de que el clasificador acierte es depender otra
 * vez del modelo.
 *
 * Pero no todo `OTRO` es una mutación. «Qué rico» y «perfecto» no piden nada, y
 * repararlos sería inventar. Hacen falta las tres cosas a la vez: una opción
 * canónica dicha, un renglón al que aplicarla, y una palabra que exprese acto.
 */
export function reparaLaIntencion({ intenciones = [], texto = '', opciones = [], objetivo = null } = {}) {
  if (!lista(intenciones).includes('OTRO')) return false;
  if (lista(intenciones).some((i) => i !== 'OTRO')) return false;
  if (!objetivo) return false;
  if (!lista(opciones).length) return false;
  return PIDE_ALGO.test(String(texto || '')) || operacionSobreElGrupo(texto) !== null;
}

/**
 * ─── UNA CONSULTA PURA NO TOCA EL PEDIDO ─────────────────────────────────
 *
 * En el smoke, «Que licuados tienen?» se clasificó BIEN como consulta y aun así
 * creó un renglón: el extractor devuelve el pedido acumulado tal y como lo dijo
 * el cliente, y ese texto entraba al motor como si fuera un acto nuevo.
 *
 * La guarda es por INVARIANTE, no por confianza: si el turno es consulta y no
 * trae ningún acto de pedido, no sale ni una propuesta. Y se cuida de no romper
 * las frases mixtas —«¿qué licuados tienen? ponme uno de fresa»— que sí piden:
 * ahí hay acto, y el acto manda.
 */
export function esConsultaPura({ intenciones = [], texto = '' } = {}) {
  const ints = lista(intenciones);
  if (!ints.length) return false;
  if (!ints.every((i) => i.startsWith('CONSULTA_') || i === 'OTRO')) return false;
  if (!ints.some((i) => i.startsWith('CONSULTA_'))) return false;
  return !PIDE_ALGO.test(String(texto || ''));
}

/**
 * ─── EL COMPILADOR DEL TURNO: REPARA, NO RECONSTRUYE ─────────────────────
 *
 * Recibe las propuestas que YA produjo `propuestasDesdeBorrador` y sólo corrige
 * los defectos estructurales del borrador. Todo lo demás —cantidades, notas,
 * bajas, duplicados, modalidad, pago, cliente— pasa intacto: son reglas
 * certificadas y este módulo no las reimplementa.
 *
 * Reconstruirlas fue el error de la primera versión: rompió 37 pruebas de siete
 * suites, casi todas de bajas y cantidades, porque un adaptador que se cree
 * motor cambia la semántica de todo lo que toca.
 *
 * Lo único que reescribe es un `agregar` que en realidad hablaba de un renglón
 * que ya existe, y lo único que añade son las entidades que el cliente dijo y
 * el modelo omitió. La AMBIGÜEDAD no se decide aquí: se emiten las candidatas y
 * el filtro que ya existe —el único dueño— decide si preguntar.
 */
export function compilarTurno({
  catalogo = [], carrito = null, contexto = null, borrador = null,
  intenciones = [], dicho = '', referencia = null, pendientes = [],
  propuestasBase = null,
} = {}) {
  const base = lista(propuestasBase);
  const deItem = (p) => ['agregar', 'cambiar_modificador', 'cambiar_cantidad',
    'agregar_nota'].includes(p?.accion);

  // ── INVARIANTE: una consulta pura no toca EL PEDIDO ────────────────────
  //
  // Lo que no es el pedido —modalidad, pago, datos— no se toca: preguntar por
  // el menú no borra lo que el cliente ya dijo.
  if (esConsultaPura({ intenciones, texto: dicho })) {
    return { propuestas: base.filter((p) => !deItem(p)), preguntas: [], motivo: 'consulta_pura', inerte: true };
  }

  const items = lista(carrito?.items);
  const esAlta = pideOtraUnidad(dicho);
  const fuera = [];
  let objetivoDelTurno = null;

  for (const p of base) {
    if (p?.accion !== 'agregar') { fuera.push(p); continue; }

    const nombrePropuesto = String(p?.valorNuevo?.nombre || '');
    const objetivo = resolverObjetivo({
      catalogo, carrito, contexto, intenciones, nombrePropuesto,
      lidDelModelo: p?.valorNuevo?.lid || null, referencia, esAlta,
    });

    if (!objetivo.lid) {
      // SIGUE SIENDO UN ALTA — y también aquí el modelo pudo omitir lo que el
      // cliente dijo: «Quiero chilaquiles suizos» nació sin salsa porque la
      // Suiza viajaba en el nombre. Se añade al renglón que está naciendo.
      const ancla = anclarLinea({
        catalogo, nombrePropuesto, evidencia: `${nombrePropuesto} ${dicho}`, dichoDelCliente: dicho,
      });
      const ficha = ancla.estado === 'resuelto' ? ancla.producto : null;
      const sueltas = opcionesDelTexto({ ficha, texto: `${nombrePropuesto} ${dicho}` });
      if (sueltas.length) {
        const mods = lista(p.valorNuevo?.modificadores).map((g) => ({
          grupo: String(g?.grupo || ''), opciones: lista(g?.opciones).map(nombreDe).filter(Boolean),
        }));
        for (const e of sueltas) {
          const ya = mods.find((m) => norm(m.grupo) === norm(e.grupo));
          if (ya) { if (!ya.opciones.some((o) => norm(o) === norm(e.opcion))) ya.opciones.push(e.opcion); }
          else mods.push({ grupo: e.grupo, opciones: [e.opcion] });
        }
        fuera.push({ ...p, valorNuevo: { ...p.valorNuevo, modificadores: mods } });
        continue;
      }
      fuera.push(p);
      continue;
    }
    objetivoDelTurno = objetivo.lid;

    // Era una MODIFICACIÓN disfrazada de alta. Se reescribe sobre su renglón.
    const destino = items.find((i) => i.lid === objetivo.lid);
    const operacion = operacionSobreElGrupo(dicho);
    const porGrupo = new Map();
    for (const g of lista(p.valorNuevo?.modificadores)) {
      const clave = norm(g?.grupo);
      if (!porGrupo.has(clave)) porGrupo.set(clave, { grupo: String(g?.grupo || ''), opciones: [] });
      for (const o of lista(g?.opciones)) {
        const n = nombreDe(o);
        if (n) porGrupo.get(clave).opciones.push(n);
      }
    }
    for (const { grupo, opciones } of porGrupo.values()) {
      if (!opciones.length) continue;
      const yaPuestas = (puestasPorGrupo(destino).get(norm(grupo))?.opciones) || [];
      // Sumar es sumar: el borrador real ya no repite lo que había.
      const valorNuevo = operacion === 'agregar'
        ? [...yaPuestas, ...opciones.filter((o) => !yaPuestas.some((v) => norm(v) === norm(o)))]
        : opciones;
      fuera.push({
        accion: 'cambiar_modificador', lid: objetivo.lid, campo: grupo,
        valorAnterior: yaPuestas, valorNuevo, evidencia: dicho, origenObjetivo: objetivo.motivo,
      });
    }
    const nota = String(p.valorNuevo?.notas || '').trim();
    if (nota && norm(nota) !== norm(destino?.notas)) {
      fuera.push({ accion: 'agregar_nota', lid: objetivo.lid, campo: 'notas',
        valorAnterior: destino?.notas || null, valorNuevo: nota, evidencia: dicho });
    }
  }

  // ── LO QUE DIJO EL CLIENTE Y EL MODELO NO PUSO ─────────────────────────
  //
  // Sólo sobre el renglón al que este turno le habla, y sólo si hay uno solo:
  // sin objetivo no hay a quién añadírselo sin adivinar.
  const objetivo = objetivoDelTurno
    || (items.length === 1 && !esAlta ? items[0].lid : null);
  if (objetivo) {
    const destino = items.find((i) => i.lid === objetivo);
    const ficha = fichaDeLaLinea(catalogo, destino?.nombre);
    const delPendiente = resolverContraPendiente({ pendientes, texto: dicho });
    const operacion = operacionSobreElGrupo(dicho);

    // ── LA BAJA EXPLÍCITA, CUANDO EL BORRADOR NO TRAE NADA ──────────────
    //
    // «Quítale el chipotle» con un borrador sin modificadores dejaba al
    // compilador sin nada que proponer, y la salsa se quedaba puesta. La baja
    // SÍ se puede leer del texto, con las tres condiciones de siempre: hay
    // marcador explícito de quitar, la opción está REALMENTE en ese renglón, y
    // el cliente la nombró ENTERA.
    //
    // Y la diferencia que importa, que es la que vigila B22: esto no convierte
    // una omisión en una baja. Si el borrador se olvida de algo y el cliente no
    // pidió quitarlo, no pasa por aquí — hace falta que él lo diga. Tampoco
    // vacía un grupo: si lo nombrado es todo lo que había, esta vía no actúa y
    // decide el reconciliador, que sabe distinguir «quítale la salsa» de
    // «quítalo».
    if (operacion === 'quitar') {
      for (const { grupo, opciones } of puestasPorGrupo(destino).values()) {
        const nombradas = opciones.filter((o) => {
          const suyas = palabrasQueLaSostienen(o, dicho);
          return suyas.size > 0 && suyas.size >= palabrasQueLaSostienen(o, o).size;
        });
        if (!nombradas.length || nombradas.length === opciones.length) continue;
        fuera.push({
          accion: 'cambiar_modificador', lid: objetivo, campo: grupo,
          valorAnterior: opciones,
          valorNuevo: opciones.filter((o) => !nombradas.some((n) => norm(n) === norm(o))),
          evidencia: dicho, origenObjetivo: 'baja_explicita_del_texto',
        });
      }
    }

    // EN UN TURNO DE QUITAR NO SE AÑADE NADA. El texto nombra justo lo que el
    // cliente quiere fuera; proponerlo como valor del grupo lo devolvería al
    // pedido.
    const sueltas = operacion === 'quitar'
      ? []
      : (delPendiente ? [delPendiente] : opcionesDelTexto({ ficha, texto: dicho, conCompetidoras: true }));
    const porGrupo = new Map();
    for (const e of sueltas) {
      const clave = norm(e.grupo);
      if (!porGrupo.has(clave)) porGrupo.set(clave, { grupo: e.grupo, opciones: [] });
      porGrupo.get(clave).opciones.push(e.opcion);
    }
    for (const { grupo, opciones } of porGrupo.values()) {
      // Si el modelo YA propuso estas opciones, esto no añade nada — y añadirlo
      // duplicaría la pregunta. La comparación es por OPCIÓN y no por nombre de
      // grupo: el modelo escribe «acompañamiento» donde la carta dice
      // «Guarniciones», y comparando nombres las dos propuestas sobrevivían y
      // el cliente recibía la misma pregunta dos veces.
      const yaPropuestas = fuera
        .filter((x) => x.accion === 'cambiar_modificador' && x.lid === objetivo)
        .flatMap((x) => lista(x.valorNuevo).map((o) => norm(nombreDe(o))));
      if (opciones.some((o) => yaPropuestas.includes(norm(o)))) continue;
      if (fuera.some((x) => x.accion === 'cambiar_modificador' && x.lid === objetivo
        && norm(x.campo) === norm(grupo))) continue;
      const yaPuestas = (puestasPorGrupo(destino).get(norm(grupo))?.opciones) || [];
      if (opciones.every((o) => yaPuestas.some((v) => norm(v) === norm(o)))) continue;
      const valorNuevo = operacion === 'quitar'
        ? opciones
        : [...yaPuestas, ...opciones.filter((o) => !yaPuestas.some((v) => norm(v) === norm(o)))];
      fuera.push({
        accion: 'cambiar_modificador', lid: objetivo, campo: grupo,
        valorAnterior: yaPuestas, valorNuevo, evidencia: dicho, origenObjetivo: 'texto_del_cliente',
      });
    }
  }

  return { propuestas: fuera, preguntas: [], motivo: 'compilado', inerte: false };
}

/** La ficha del producto al que está anclado un renglón. */
function fichaDeLaLinea(catalogo, nombre) {
  const p = productosVendibles(catalogo).find((x) => norm(x.nombre) === norm(nombre));
  return p ? fichaDeProducto(p) : null;
}

// «Otro», «otra», «más», «uno más», un número: el cliente pide UNA UNIDAD MÁS,
// y eso sí es un alta aunque repita el nombre de algo que ya está en el pedido.
// Repetir el nombre, por sí solo, no lo es: «los chilaquiles con huevo» habla
// de los que ya pidió.
const PIDE_OTRA_UNIDAD = /\b(otro|otra|otros|otras|mas|agregame)\b/i;
// Se NORMALIZA antes de medir. En JavaScript `\b` no reconoce una vocal
// acentuada como parte de la palabra, asi que /\bmas\b/ con tilde no casa
// nunca: la frontera cae entre la vocal y el diacritico. Quitandolos primero,
// «mas» y «más» son la misma palabra, que es lo que son.
export const pideOtraUnidad = (texto) => PIDE_OTRA_UNIDAD.test(norm(texto));


export { opcionesDelGrupoDeProducto, fichaDeProducto };
