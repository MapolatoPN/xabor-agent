// ─── «El primero», «ese», «otra igual» ────────────────────────────────────
//
// Módulo puro. Traduce las expresiones con las que la gente señala un renglón
// del pedido sin nombrarlo, a un `lid` concreto — o a la conclusión de que hay
// que preguntar.
//
// ── Por qué es su propia capa ────────────────────────────────────────────
//
// Hoy el modelo resuelve esto solo, dentro de su cabeza, y devuelve un borrador
// ya resuelto. Cuando acierta no se nota; cuando falla, el reconciliador ve un
// cambio sobre el renglón equivocado con la evidencia del renglón correcto, y
// lo aprueba. La protección campo a campo no puede salvar de un objetivo mal
// elegido: protege el campo que se le señaló.
//
// Sacarlo del modelo lo vuelve auditable: se ve QUÉ se entendió, y sobre todo
// se ve cuándo no se entendió nada.
//
// ── La regla, que es la de siempre ───────────────────────────────────────
//
//   un candidato      se resuelve
//   ningún candidato  se pregunta
//   dos o más         se pregunta
//
// Nunca «el más probable». En un pedido de dos platillos iguales, elegir mal
// «el primero» significa quitarle la cebolla al de la otra persona, y eso
// llega a la mesa.
//
// ── De dónde salen los candidatos ────────────────────────────────────────
//
// Del carrito —los renglones que existen de verdad— cruzado con el orden de
// aparición que guarda el contexto. El orden no se recalcula cuando se borra un
// renglón: si el cliente pidió A, B y C, quitó B y luego dice «el primero»,
// sigue siendo A. Eso vive en `contextoMesa.sincronizarLineas`.
//
// Aquí no se escribe un solo nombre de producto.

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const ORDINALES = [
  [/\b(?:el|la|los|las)?\s*primer[oa]?s?\b/, 1],
  [/\b(?:el|la|los|las)?\s*segund[oa]s?\b/, 2],
  [/\b(?:el|la|los|las)?\s*tercer[oa]?s?\b/, 3],
  [/\b(?:el|la|los|las)?\s*cuart[oa]s?\b/, 4],
  [/\b(?:el|la|los|las)?\s*quint[oa]s?\b/, 5],
];

const ULTIMO = /\b(ultim[oa]s?|el de hasta abajo|la de hasta abajo|el de abajo|el final|el ultimo que dije)\b/;
const ANTERIOR = /\b(el anterior|la anterior|el de antes|la de antes|lo anterior|como el anterior|igual que el anterior|igual que la anterior)\b/;
const REPETIR = /\b(otra igual|otro igual|uno mas|una mas|otro mas|otra mas|lo mismo|otra vez lo mismo|una igual|uno igual|repite|repiteme|rep[ií]teme)\b/;
const AMBOS = /\b(los dos|las dos|ambos|ambas|todos|todas|los tres|las tres|todo|los demas|el resto)\b/;
const OTRO = /\b(el otro|la otra|los otros|las otras|el que sigue|la que sigue|el que falta|la que falta)\b/;
const POSEEDOR = /\b(el de ella|la de ella|el de el|la de el|el mio|el m[ií]o|la mia|la m[ií]a|el tuyo|la tuya|el suyo|la suya|el de mi \w+|la de mi \w+|el de la nina|el de el nino)\b/;
const DEICTICO = /\b(ese|esa|eso|este|esta|esto|aquel|aquella|aquello|esos|esas|estos|estas)\b/;

// Clíticos pegados a un verbo: «hazlos tres», «quítalo», «cámbialos». La lista
// es de VERBOS, no de productos, y sin ella «los chilaquiles» —que nombra— se
// confundiría con «los» —que señala.
const CLITICO = /\b(quita|quitame|quitale|haz|hazme|cambia|cambiame|pon|ponme|deja|dejame|saca|sacame|sube|subele|baja|bajale|repite|repiteme|duplica|agrega|quiero)(lo|la|los|las)\b/;

// Referencia ELÍPTICA: no hay pronombre, el objeto está sobreentendido.
//
//   «mejor dos»   «que sean tres»   «súbele a cuatro»
//
// Es como la gente corrige de verdad, y sin esto el bot tiene que preguntar
// «¿de cuál?» a alguien que acaba de decir de cuál hablando de ello. Lo que
// vuelve seguro resolverlo es la RECENCIA: solo apunta a lo que se tocó en los
// últimos turnos. Un «mejor dos» suelto, sin nada reciente en foco, se
// pregunta como cualquier otra ambigüedad.
const NUMERO = '(?:\\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';
const ELIPTICA = new RegExp(`\\b(?:mejor|que sean?|que sea|subele a|sube a|bajale a|baja a|ponme|pon|dame|solo|nada mas)\\s+${NUMERO}\\b`);

/** Cuántos turnos atrás sigue contando como «de lo que veníamos hablando». */
export const RECENCIA_DEL_FOCO = 3;

/** ¿Hay algo que señalar en esta frase? Sin resolverlo todavía. */
export function hayReferencia(texto) {
  const t = norm(texto);
  if (!t) return false;
  return REPETIR.test(t) || ANTERIOR.test(t) || ULTIMO.test(t) || OTRO.test(t)
    || AMBOS.test(t) || POSEEDOR.test(t) || DEICTICO.test(t) || CLITICO.test(t)
    || ELIPTICA.test(t) || ORDINALES.some(([re]) => re.test(t));
}

/** Los renglones vivos, en el orden en que el cliente los pidió. */
export function renglonesEnOrden(contexto, carrito) {
  const porLid = new Map((carrito?.items || []).map((i) => [String(i.lid), i]));
  return (contexto?.lineas || [])
    .filter((l) => porLid.has(l.lid))
    .slice()
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map((l) => ({ lid: l.lid, orden: l.orden, nombre: String(porLid.get(l.lid)?.nombre || ''),
      cantidad: Number(porLid.get(l.lid)?.cantidad) || 1, turnoUltimoCambio: l.turnoUltimoCambio || 0 }));
}

const sinResolver = (tipo, frase, candidatos, motivo) => ({
  tipo, frase, accion: 'senalar', resuelta: false, lids: [], candidatos, motivo,
});
const resuelta = (tipo, frase, lids, accion = 'senalar') => ({
  tipo, frase, accion, resuelta: true, lids, candidatos: [], motivo: null,
});

/**
 * A qué renglón apunta el cliente.
 *
 * Devuelve siempre un objeto. `tipo: null` significa que no había ninguna
 * referencia que resolver — que no es lo mismo que no haber podido resolverla.
 *
 *   resuelta: true    `lids` trae exactamente a qué apunta
 *   resuelta: false   `candidatos` trae entre qué hay que preguntar (puede ir
 *                     vacío: eso es «no hay a qué apuntar»)
 *
 * `accion: 'duplicar'` es «otra igual»: no señala para cambiar, señala para
 * copiar. Quien lo aplique tiene que saber que va a haber un renglón más.
 */
export function resolverReferencia(texto, { contexto, carrito } = {}) {
  const t = norm(texto);
  const lineas = renglonesEnOrden(contexto, carrito);
  const foco = contexto?.foco || null;
  const nada = { tipo: null, frase: '', accion: 'senalar', resuelta: false, lids: [], candidatos: [], motivo: null };
  if (!t || !hayReferencia(t)) return nada;

  const unicoSiHayUno = (tipo, frase, extra = 'senalar') => {
    if (lineas.length === 1) return resuelta(tipo, frase, [lineas[0].lid], extra);
    return sinResolver(tipo, frase, lineas, lineas.length ? 'varios_candidatos' : 'sin_candidatos');
  };

  // ── «otra igual», «uno más» ─────────────────────────────────────────────
  // Va primero porque manda sobre el resto: «otra igual» contiene «otra», que
  // también dispararía el señalamiento genérico.
  if (REPETIR.test(t)) {
    if (foco && lineas.some((l) => l.lid === foco)) return resuelta('repetir', t, [foco], 'duplicar');
    if (lineas.length === 1) return resuelta('repetir', t, [lineas[0].lid], 'duplicar');
    return sinResolver('repetir', t, lineas, lineas.length ? 'varios_candidatos' : 'sin_candidatos');
  }

  // ── ordinales ───────────────────────────────────────────────────────────
  for (const [re, n] of ORDINALES) {
    if (!re.test(t)) continue;
    if (lineas.length >= n) return resuelta('ordinal', t, [lineas[n - 1].lid]);
    // Pidió «el tercero» y hay dos. No se estira al último: se pregunta.
    return sinResolver('ordinal', t, lineas, 'sin_candidatos');
  }

  if (ULTIMO.test(t)) {
    if (lineas.length) return resuelta('ultimo', t, [lineas.at(-1).lid]);
    return sinResolver('ultimo', t, [], 'sin_candidatos');
  }

  // ── «el anterior»: el que se tocó antes del que está en foco ────────────
  if (ANTERIOR.test(t)) {
    const porRecencia = lineas.slice().sort((a, b) => b.turnoUltimoCambio - a.turnoUltimoCambio);
    const previos = porRecencia.filter((l) => l.lid !== foco);
    if (previos.length === 1) return resuelta('anterior', t, [previos[0].lid]);
    if (previos.length > 1) {
      // Empate en recencia: dos renglones tocados en el mismo turno no tienen
      // «anterior» distinguible.
      const top = previos[0].turnoUltimoCambio;
      const empatan = previos.filter((l) => l.turnoUltimoCambio === top);
      if (empatan.length === 1) return resuelta('anterior', t, [empatan[0].lid]);
      return sinResolver('anterior', t, empatan, 'varios_candidatos');
    }
    return sinResolver('anterior', t, lineas, 'sin_candidatos');
  }

  // ── «el otro» ───────────────────────────────────────────────────────────
  if (OTRO.test(t)) {
    const otros = lineas.filter((l) => l.lid !== foco);
    if (otros.length === 1) return resuelta('otro', t, [otros[0].lid]);
    return sinResolver('otro', t, otros, otros.length ? 'varios_candidatos' : 'sin_candidatos');
  }

  // ── «los dos», «ambos», «todos» ─────────────────────────────────────────
  if (AMBOS.test(t)) {
    const esPar = /\b(los dos|las dos|ambos|ambas)\b/.test(t);
    const esTrio = /\b(los tres|las tres)\b/.test(t);
    if (esPar && lineas.length !== 2) return sinResolver('ambos', t, lineas, lineas.length ? 'varios_candidatos' : 'sin_candidatos');
    if (esTrio && lineas.length !== 3) return sinResolver('ambos', t, lineas, lineas.length ? 'varios_candidatos' : 'sin_candidatos');
    if (!lineas.length) return sinResolver('ambos', t, [], 'sin_candidatos');
    return resuelta('ambos', t, lineas.map((l) => l.lid));
  }

  // ── «el de ella», «el mío» ──────────────────────────────────────────────
  //
  // El sistema no sabe de quién es cada platillo, y no va a suponerlo. Con un
  // solo renglón la frase no tiene con qué confundirse; con dos, se pregunta.
  if (POSEEDOR.test(t)) return unicoSiHayUno('poseedor', t);

  // ── «ese», «hazlos» ─────────────────────────────────────────────────────
  if (DEICTICO.test(t) || CLITICO.test(t)) {
    if (foco && lineas.some((l) => l.lid === foco)) return resuelta('deictico', t, [foco]);
    return unicoSiHayUno('deictico', t);
  }

  // ── «mejor dos» ─────────────────────────────────────────────────────────
  if (ELIPTICA.test(t)) {
    const enFoco = lineas.find((l) => l.lid === foco);
    const turnoAhora = Number(contexto?.contador) || 0;
    const reciente = enFoco && (turnoAhora - (enFoco.turnoUltimoCambio || 0)) <= RECENCIA_DEL_FOCO;
    if (reciente) return resuelta('eliptica', t, [enFoco.lid]);
    // Sin nada reciente en foco, la elipsis no tiene antecedente. Con un solo
    // renglón no hay confusión posible; con varios, se pregunta.
    return unicoSiHayUno('eliptica', t);
  }

  return nada;
}

/**
 * La referencia, contada para que la capa de aclaraciones pueda preguntar.
 *
 * No redacta la pregunta —eso lo hace el modelo con los datos— pero sí decide
 * QUÉ hay que preguntar y entre qué opciones.
 */
export function aclaracionDeReferencia(ref) {
  if (!ref || ref.resuelta || !ref.tipo) return null;
  return {
    tipo: 'referencia_ambigua',
    referencia: ref.frase,
    motivo: ref.motivo,
    candidatos: (ref.candidatos || []).map((c, i) => ({
      lid: c.lid, nombre: c.nombre, posicion: i + 1, cantidad: c.cantidad,
    })),
  };
}
