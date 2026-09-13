// ─── La ambigüedad la detecta el código; el modelo solo la redacta ────────
//
// Módulo puro. Recoge todo lo que quedó sin resolver en un turno —del carrito,
// de las referencias, de las propuestas, del catálogo— y lo deja en una sola
// lista con la misma forma.
//
// ── Por qué importa quién detecta ────────────────────────────────────────
//
// Si el modelo decide cuándo hay ambigüedad, no la hay casi nunca: un modelo
// siempre tiene una lectura preferida y la ofrece con confianza. Lo que sale es
// «creo que quieres Coca Cola», que es adivinar en voz educada.
//
// Detectándola aquí, la pregunta existe ANTES de que el modelo abra la boca, y
// lo único que se le pide es que suene a persona:
//
//   entra   { tipo: 'termino_ambiguo', termino: 'refresco',
//             candidatos: ['Coca Cola', 'Sprite'] }
//   sale    «Tengo Coca Cola y Sprite, ¿cuál prefieres?»
//
// Y nunca «creo que quieres Coca Cola».
//
// ── El texto de respaldo ─────────────────────────────────────────────────
//
// Cada aclaración trae su propia redacción mínima (`pregunta`). No es la que se
// va a usar cuando el modelo esté disponible —suena a máquina— pero existe por
// dos razones: sirve de contrato de lo que hay que preguntar, y si el modelo
// falla el cliente recibe una pregunta legible en vez de un silencio.

const lista = (xs) => (Array.isArray(xs) ? xs : []);
const nombres = (xs) => lista(xs).map((x) => (typeof x === 'string' ? x : String(x?.nombre || ''))).filter(Boolean);

/** Une nombres con comas y una «o» al final, que es como habla la gente. */
export function enumerar(xs, conjuncion = 'o') {
  const n = nombres(xs);
  if (!n.length) return '';
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(', ')} ${conjuncion} ${n.at(-1)}`;
}

const aclaracion = (tipo, campos, pregunta) => ({ tipo, ...campos, pregunta });

/**
 * TODO lo que quedó sin decidir en este turno, normalizado.
 *
 * `fuentes`:
 *   cambios        el `cambios` que devuelve `reconciliar` (ambiguos, porConfirmar)
 *   referencia     lo que devolvió `resolverReferencia`, si no resolvió
 *   propuestas     el desenlace de `leerRespuesta`, si salió ambiguo
 *   terminos       términos del cliente que cubren varios productos
 *   gruposFaltantes grupos requeridos sin elegir, por renglón
 *
 * Se devuelven en el orden en que conviene preguntarlas: primero lo que impide
 * avanzar, después lo que solo falta por confirmar. Preguntar tres cosas a la
 * vez es no preguntar ninguna, así que quien las use debe tomar las primeras.
 */
export function recolectarAclaraciones({
  cambios = null, referencia = null, propuestas = null, terminos = [], gruposFaltantes = [],
} = {}) {
  const fuera = [];

  // 1) Dos artículos caben en el mismo «quítalo». No se quita ninguno.
  for (const a of lista(cambios?.ambiguos)) {
    fuera.push(aclaracion('quitar_ambiguo', {
      candidatos: [a.nombre, ...nombres(a.empatan)],
      frase: a.frase || '',
    }, `¿Cuál quito, ${enumerar([a.nombre, ...nombres(a.empatan)])}? Los dejo los dos hasta que me digas.`));
  }

  // 2) Una referencia que no apunta a nada o apunta a varios.
  if (referencia && referencia.tipo && !referencia.resuelta) {
    const cands = lista(referencia.candidatos);
    fuera.push(aclaracion('referencia_ambigua', {
      referencia: referencia.frase || '',
      motivo: referencia.motivo,
      candidatos: cands.map((c) => ({ lid: c.lid, nombre: c.nombre, posicion: c.posicion })),
    }, cands.length
      ? `¿Te refieres a ${enumerar(cands)}?`
      : 'No tengo claro a cuál te refieres, ¿me lo dices por su nombre?'));
  }

  // 3) Un «sí» que puede ser de dos cosas.
  if (propuestas?.ambigua) {
    const cands = lista(propuestas.candidatas).map((p) => p.etiqueta || p.referencia);
    fuera.push(aclaracion('respuesta_ambigua', { candidatos: cands },
      `¿El sí es por ${enumerar(cands)}?`));
  }

  // 4) Una palabra del cliente que cubre varios productos de la carta.
  for (const t of lista(terminos)) {
    const cands = nombres(t.candidatos);
    if (cands.length < 2) continue;
    fuera.push(aclaracion('termino_ambiguo', { termino: String(t.termino || ''), candidatos: cands },
      `De ${t.termino} tenemos ${enumerar(cands.slice(0, 4), 'y')}. ¿Cuál te sirve?`));
  }

  // 5) El carrito dejó algo pendiente de confirmar (foto, término).
  for (const c of lista(cambios?.porConfirmar)) {
    if (c.motivo === 'termino_ambiguo') {
      fuera.push(aclaracion('termino_ambiguo', {
        termino: String(c.termino || ''), candidatos: nombres(c.candidatos),
      }, `De ${c.termino} tenemos ${enumerar(nombres(c.candidatos).slice(0, 4), 'y')}. ¿Cuál te sirve?`));
    } else {
      fuera.push(aclaracion('percepcion_por_confirmar', { nombre: String(c.nombre || '') },
        `En la foto veo algo parecido a "${c.nombre}". ¿Te lo agrego al pedido?`));
    }
  }

  // 6) Un grupo requerido sin elegir. Es lo único que de verdad bloquea.
  for (const g of lista(gruposFaltantes)) {
    fuera.push(aclaracion('grupo_requerido', {
      lid: g.lid || null, producto: String(g.producto || ''), grupo: String(g.grupo || ''),
      candidatos: nombres(g.opciones),
    }, `Para ${g.producto}, ¿qué ${String(g.grupo || '').toLowerCase()} le pongo: ${enumerar(nombres(g.opciones), 'o')}?`));
  }

  return fuera;
}

/** Lo que de verdad impide cerrar el pedido, separado de lo que solo falta. */
export const bloquean = (aclaraciones) => lista(aclaraciones)
  .filter((a) => ['grupo_requerido', 'quitar_ambiguo', 'referencia_ambigua', 'termino_ambiguo'].includes(a.tipo));

/**
 * Las que se preguntan en ESTE turno.
 *
 * Como mucho dos, y las que bloquean van primero. Un mesero que suelta cinco
 * preguntas de golpe no obtiene cinco respuestas: obtiene una y pierde cuatro.
 */
export function aPreguntarAhora(aclaraciones, { maximo = 2 } = {}) {
  const todas = lista(aclaraciones);
  const primero = bloquean(todas);
  const resto = todas.filter((a) => !primero.includes(a));
  return [...primero, ...resto].slice(0, maximo);
}

/**
 * El texto de respaldo, si el modelo no puede redactar.
 *
 * Deliberadamente pobre: no compite con el modelo, lo sustituye cuando falla.
 */
export const preguntaDeRespaldo = (aclaraciones, opciones = {}) =>
  aPreguntarAhora(aclaraciones, opciones).map((a) => a.pregunta).filter(Boolean).join(' ');

/**
 * Lo que se le pasa al modelo para que redacte.
 *
 * Sin `pregunta`: si se le diera la frase ya hecha, la copiaría y volveríamos a
 * hablar como una máquina. Se le dan los HECHOS y se le pide que pregunte.
 */
export const paraElModelo = (aclaraciones, opciones = {}) =>
  aPreguntarAhora(aclaraciones, opciones).map(({ pregunta, ...datos }) => datos);
