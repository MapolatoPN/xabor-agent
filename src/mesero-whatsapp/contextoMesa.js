// ─── El contexto de la atención, no una mesa del POS ──────────────────────
//
// Módulo puro y serializable. No consulta la base, no llama al modelo, no
// envía nada. Guarda lo que un mesero recordaría mientras atiende UNA
// conversación de WhatsApp, y nada más.
//
// ── Qué NO es ────────────────────────────────────────────────────────────
//
// No es una mesa del punto de venta ni un pedido. El pedido sigue viviendo
// donde vive: `session.carrito` bajo V2, protegido campo a campo por
// `carritoDelPedido.js`. Duplicarlo aquí crearía dos fuentes de verdad y la
// pregunta «¿cuál manda?» no tiene respuesta buena.
//
// Por eso el contexto **no guarda productos**. Guarda, POR `lid`, lo que el
// carrito no sabe y el carrito no debería saber:
//
//   en qué orden aparecieron        para «el primero», «el segundo»
//   cuál se está hablando ahora     para «ese», «esa», «quítalo»
//   de dónde salió cada renglón     DICHO / PERCIBIDO / PROPUESTO
//   qué propuso el bot y qué pasó   una sugerencia no es un pedido
//   qué quedó pendiente             para no volver a preguntar lo mismo
//
// El `lid` es la junta entre las dos mitades: lo asigna el carrito, es estable
// entre turnos aunque el artículo cambie de nombre al elegir presentación, y
// nunca sale hacia el modelo.
//
// ── Aislamiento ──────────────────────────────────────────────────────────
//
// El contexto lleva grabado a QUÉ negocio y a QUÉ conversación pertenece, y
// `contextoDeLaConversacion` lo comprueba antes de devolverlo. Un contexto que
// no coincide no se arregla: se descarta y se empieza de cero. En un proceso
// con muchos negocios dentro, prestar el contexto de uno a otro es peor que
// perderlo.
//
// ── Por qué serializable ─────────────────────────────────────────────────
//
// La conversación de WhatsApp sobrevive a los reinicios: `restaurarSesion`
// vuelve a meter en memoria un snapshot que salió de la base. Un `Map` o una
// clase no sobreviven ese viaje. Aquí todo es objeto y arreglo plano, y
// `sanearContexto` reconstruye la forma de cualquier cosa que vuelva mal.

/** Cuántos turnos se recuerdan. Un mesero tampoco recuerda la conversación entera. */
export const TURNOS_RECORDADOS = 24;

/** Cuántas propuestas del bot se conservan con su desenlace. */
export const PROPUESTAS_RECORDADAS = 20;

export const FASES = Object.freeze([
  'inicio',
  'explorando_menu',
  'tomando_orden',
  'completando_producto',
  'revisando',
  'esperando_modalidad',
  'esperando_pago',
  'confirmando',
  'confirmado',
  'escalado_humano',
]);

/** Un contexto recién puesto, atado a su negocio y su conversación. */
export function contextoNuevo({ negocioId, conversacionId, cliente = null } = {}) {
  return {
    negocioId: String(negocioId || ''),
    conversacionId: String(conversacionId || ''),
    cliente: cliente ? { ...cliente } : null,
    fase: 'inicio',
    // Metadatos por renglón del carrito, indexados por `lid`. El producto NO
    // está aquí: está en el carrito.
    lineas: [],
    foco: null,              // `lid` del renglón del que se está hablando
    referencias: [],         // { turno, lid, texto } — a qué apuntó cada referencia
    pendientes: [],          // preguntas vivas, estructuradas (ver más abajo)
    modalidad: null,
    pago: null,
    propuestas: [],          // Fase E: lo que el bot ofreció y en qué acabó
    aclaraciones: [],        // ambigüedades abiertas, generadas por código
    turnos: [],              // { rol, texto, dicho, percibido }
    contador: 0,             // número de turno; sirve de reloj sin usar Date
    // Solo en sombra: { turno, motivo } del punto en que, atendiendo de verdad,
    // esto habría pasado a una persona. En producción es siempre `null` porque
    // allí el handoff es terminal y no hay «después».
    habriaEscalado: null,
    // { huella, turno } del resumen que se le enseñó al cliente la última vez
    // que el pedido estuvo completo, y del que ya confirmó. Un «sí» sólo vale
    // contra el primero, y sólo una vez.
    resumenMostrado: null,
    resumenConfirmado: null,
  };
}

const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arreglo = (x) => (Array.isArray(x) ? x : []);

/**
 * Devuelve un contexto utilizable SIEMPRE, con la forma completa.
 *
 * Se le pasa lo que venga del snapshot —que pudo escribirlo una versión
 * anterior, o llegar truncado— y sale algo con todos sus campos. Nunca lanza:
 * un contexto ilegible es un contexto nuevo, no un turno caído.
 */
export function sanearContexto(crudo, { negocioId, conversacionId } = {}) {
  const base = contextoNuevo({ negocioId, conversacionId });
  if (!esObjeto(crudo)) return base;
  return {
    ...base,
    ...(esObjeto(crudo.cliente) ? { cliente: { ...crudo.cliente } } : {}),
    fase: FASES.includes(crudo.fase) ? crudo.fase : 'inicio',
    lineas: arreglo(crudo.lineas).filter((l) => esObjeto(l) && l.lid).map((l) => ({
      lid: String(l.lid),
      orden: Number.isFinite(Number(l.orden)) ? Number(l.orden) : 0,
      procedencia: String(l.procedencia || 'dicho'),
      turnoAlta: Number.isFinite(Number(l.turnoAlta)) ? Number(l.turnoAlta) : 0,
      turnoUltimoCambio: Number.isFinite(Number(l.turnoUltimoCambio)) ? Number(l.turnoUltimoCambio) : 0,
    })),
    foco: crudo.foco ? String(crudo.foco) : null,
    referencias: arreglo(crudo.referencias).slice(-TURNOS_RECORDADOS),
    pendientes: arreglo(crudo.pendientes).filter(esObjeto),
    modalidad: crudo.modalidad ?? null,
    pago: crudo.pago ?? null,
    propuestas: arreglo(crudo.propuestas).filter(esObjeto).slice(-PROPUESTAS_RECORDADAS),
    aclaraciones: arreglo(crudo.aclaraciones).filter(esObjeto),
    turnos: arreglo(crudo.turnos).filter(esObjeto).slice(-TURNOS_RECORDADOS),
    contador: Number.isFinite(Number(crudo.contador)) ? Number(crudo.contador) : 0,
    // SOLO en modo sombra: el turno en que, atendiendo de verdad, esto habría
    // pasado a una persona. Tiene que sobrevivir al guardado, porque su razón
    // de ser es marcar todos los turnos POSTERIORES como contrafactuales; si se
    // pierde al serializar, cada turno vuelve a creer que el escalado es suyo.
    habriaEscalado: esObjeto(crudo.habriaEscalado)
      && Number.isFinite(Number(crudo.habriaEscalado.turno))
      ? { turno: Number(crudo.habriaEscalado.turno), motivo: String(crudo.habriaEscalado.motivo || '') }
      : null,
    // ── LA HUELLA DEL RESUMEN QUE SE LE ENSEÑÓ, Y LA DEL YA CONFIRMADO ───
    //
    // Tienen que sobrevivir al guardado o la protección no existe: el «sí»
    // llega SIEMPRE en el turno siguiente al que enseñó el resumen, así que
    // una huella que no cruce la serialización nunca llegaría a comprobarse
    // y todo «sí» pasaría por vigente. Son dos cadenas, no el resumen: lo que
    // se compara es la huella, y guardar el contenido invitaría a leerlo como
    // si fuera el pedido.
    resumenMostrado: huella(crudo.resumenMostrado),
    resumenConfirmado: huella(crudo.resumenConfirmado),
  };
}

/** Una huella guardada, o nada. Se valida la forma, no el contenido. */
function huella(x) {
  return esObjeto(x) && typeof x.huella === 'string' && Number.isFinite(Number(x.turno))
    ? { huella: x.huella, turno: Number(x.turno) }
    : null;
}

/**
 * El contexto de ESTA conversación de ESTE negocio.
 *
 * Si el guardado pertenece a otro par, no se recicla: se devuelve uno nuevo.
 * Es el punto donde el aislamiento multiempresa deja de depender de que quien
 * llame use bien la clave.
 */
export function contextoDeLaConversacion(guardado, { negocioId, conversacionId }) {
  const n = String(negocioId || ''), c = String(conversacionId || '');
  if (!n || !c) return contextoNuevo({ negocioId: n, conversacionId: c });
  // LA COMPROBACIÓN VA SOBRE EL CRUDO, NO SOBRE EL SANEADO.
  //
  // `sanearContexto` rellena los huecos con el negocio y la conversación que se
  // le PIDEN, así que preguntarle a su salida de quién es siempre contesta que
  // sí. La primera versión hacía justo eso y el aislamiento era una línea que
  // no podía fallar nunca; lo enseñaron C3 y C4 antes de que existiera un solo
  // negocio con el mesero encendido.
  //
  // Un contexto que no declara a quién pertenece tampoco se adopta: puede venir
  // de una versión anterior, y heredarlo es exactamente el riesgo que se está
  // cerrando. Empezar de cero cuesta una conversación; equivocarse de negocio
  // cuesta el pedido de otro.
  const suNegocio = String(guardado?.negocioId || '');
  const suConversacion = String(guardado?.conversacionId || '');
  if (suNegocio !== n || suConversacion !== c) {
    return contextoNuevo({ negocioId: n, conversacionId: c });
  }
  return sanearContexto(guardado, { negocioId: n, conversacionId: c });
}

/** Un turno más. Devuelve el número de turno, que hace de reloj. */
export function anotarTurno(ctx, rol, texto, { dicho = null, percibido = null } = {}) {
  ctx.contador += 1;
  ctx.turnos.push({
    turno: ctx.contador,
    rol: rol === 'bot' ? 'bot' : 'cliente',
    texto: String(texto || ''),
    ...(dicho !== null ? { dicho: String(dicho) } : {}),
    ...(percibido ? { percibido: String(percibido) } : {}),
  });
  if (ctx.turnos.length > TURNOS_RECORDADOS) ctx.turnos.splice(0, ctx.turnos.length - TURNOS_RECORDADOS);
  return ctx.contador;
}

/** Los turnos del cliente, del más viejo al más nuevo. */
export const turnosDelCliente = (ctx) => arreglo(ctx?.turnos).filter((t) => t.rol === 'cliente');

/** El último turno del bot, para saber a qué contesta un «sí» pelado. */
export const ultimoTurnoDelBot = (ctx) => [...arreglo(ctx?.turnos)].reverse().find((t) => t.rol === 'bot') || null;

/**
 * Pone al día los metadatos con los renglones que el carrito tiene AHORA.
 *
 * El carrito manda: si un `lid` ya no está, su metadato se va con él; si
 * apareció uno nuevo, se le da su lugar en el orden de aparición. El orden no
 * se recalcula para los que ya estaban — es lo que sostiene «el primero»
 * cuando el cliente borra el segundo y agrega otro.
 */
export function sincronizarLineas(ctx, carrito, { procedencia = 'dicho', turno = null } = {}) {
  const vivos = arreglo(carrito?.items).map((i) => String(i?.lid || '')).filter(Boolean);
  const conocidos = new Map(arreglo(ctx.lineas).map((l) => [l.lid, l]));
  const t = turno ?? ctx.contador;
  let siguienteOrden = arreglo(ctx.lineas).reduce((m, l) => Math.max(m, Number(l.orden) || 0), 0);
  const lineas = [];
  for (const lid of vivos) {
    const previo = conocidos.get(lid);
    if (previo) { lineas.push(previo); continue; }
    siguienteOrden += 1;
    lineas.push({ lid, orden: siguienteOrden, procedencia, turnoAlta: t, turnoUltimoCambio: t });
  }
  ctx.lineas = lineas;
  // El foco apuntaba a un renglón que ya no existe: se suelta. Apuntar a un
  // fantasma es peor que no apuntar — «quítalo» resolvería a nada en silencio.
  if (ctx.foco && !vivos.includes(ctx.foco)) ctx.foco = null;
  return ctx.lineas;
}

/** Marca que en este turno se tocó ese renglón, y lo pone en foco. */
export function tocarLinea(ctx, lid, { turno = null, foco = true } = {}) {
  const l = arreglo(ctx.lineas).find((x) => x.lid === lid);
  if (l) l.turnoUltimoCambio = turno ?? ctx.contador;
  if (foco && l) ctx.foco = lid;
  return l || null;
}

/** Anota que una referencia del cliente resolvió a un renglón. */
export function anotarReferencia(ctx, texto, lid) {
  ctx.referencias.push({ turno: ctx.contador, texto: String(texto || ''), lid: lid ? String(lid) : null });
  if (ctx.referencias.length > TURNOS_RECORDADOS) ctx.referencias.shift();
}

// ── PENDIENTES: LO QUE SE PREGUNTA, NO CÓMO SE REDACTA ───────────────────
//
// Un pendiente es una PREGUNTA VIVA. Se guarda por su contenido —qué línea, qué
// grupo, entre qué candidatos— y NUNCA por la frase con la que se dijo. La
// frase se vuelve a redactar cada vez a partir del pendiente vigente, así que
// no puede sobrevivirle.
//
// ── Por qué se rehízo esto ───────────────────────────────────────────────
//
// En el primer tráfico real, una pregunta sobre la presentación de un platillo
// apareció idéntica durante cinco turnos mientras el cliente hablaba de su
// dirección y de un licuado. Y en otra conversación, tres mensajes que no
// tenían nada que ver —«no tendrá el menú?», «es que no lo encuentro», «😬»—
// hicieron creer al sistema que llevaba tres intentos fallidos y lo mandaron a
// un humano.
//
// Las dos cosas salían del mismo diseño: el pendiente era una CLAVE y una
// FRASE, y su contador subía por el mero paso de los turnos.
//
// ── El ciclo de vida ─────────────────────────────────────────────────────
//
//   creado      aparece algo que hace falta preguntar
//   vigente     sigue haciendo falta, y sus candidatos son los mismos
//   obsoleto    sigue haciendo falta pero CAMBIÓ (otros candidatos, otro
//               grupo): la pregunta anterior ya no lo representa y se rehace
//   resuelto    dejó de hacer falta porque se llenó
//   cancelado   dejó de hacer falta porque su línea desapareció
//
// Cada turno se recalcula qué hace falta y se reconcilia contra lo guardado.
// Un pendiente no puede quedarse: o está en la foto de este turno, o se fue.

/** La identidad estable de un pendiente. Dos preguntas iguales tienen la misma. */
export function clavePendiente(d) {
  if (!d || !d.tipo) return null;
  // Las partes vacías no dejan hueco: `dato:modalidad`, no `dato:::modalidad`.
  // Una clave se lee en los logs y en las pruebas, y una llena de dos puntos
  // no se lee.
  return [d.tipo, d.lid, d.grupo, d.dato].filter(Boolean).join(':');
}

const mismosCandidatos = (a, b) => {
  const n = (x) => (Array.isArray(x) ? x : []).map((y) => String(typeof y === 'string' ? y : y?.nombre || ''))
    .filter(Boolean).sort().join('|');
  return n(a) === n(b);
};

/**
 * Pone los pendientes al día con lo que hace falta AHORA.
 *
 * `vigentes` son descriptores `{ tipo, lid, producto, grupo, candidatos, dato,
 * evidenciaOrigen }` recalculados este turno. `lidsVivos` son los renglones que
 * existen, para poder distinguir «se resolvió» de «se fue con su línea».
 *
 * Devuelve el recuento del ciclo de vida, que es lo que alimenta las métricas.
 */
export function sincronizarPendientes(ctx, vigentes = [], { lidsVivos = null } = {}) {
  const turno = ctx.contador || 0;
  const antes = new Map(arreglo(ctx.pendientes).map((p) => [p.clave, p]));
  const salida = [];
  const cuenta = { creados: 0, resueltos: 0, cancelados: 0, obsoletos: 0 };

  for (const d of arreglo(vigentes)) {
    const clave = clavePendiente(d);
    if (!clave) continue;
    const previo = antes.get(clave);
    antes.delete(clave);
    const candidatos = arreglo(d.candidatos)
      .map((c) => String(typeof c === 'string' ? c : c?.nombre || '')).filter(Boolean);

    if (previo && mismosCandidatos(previo.candidatos, candidatos)) {
      salida.push({ ...previo, producto: d.producto ?? previo.producto, turnoVisto: turno });
      continue;
    }
    // Nuevo, o el mismo con OTROS candidatos: en los dos casos la pregunta
    // anterior ya no lo representa, así que se rehace desde cero.
    if (previo) cuenta.obsoletos += 1; else cuenta.creados += 1;
    salida.push({
      clave,
      tipo: String(d.tipo),
      lid: d.lid || null,
      producto: d.producto ? String(d.producto) : null,
      grupo: d.grupo ? String(d.grupo) : null,
      dato: d.dato ? String(d.dato) : null,
      candidatos,
      evidenciaOrigen: String(d.evidenciaOrigen || ''),
      turnoCreacion: turno,
      turnoVisto: turno,
      turnoUltimaPregunta: null,
      intentos: 0,
    });
  }

  // Lo que ya no está en la foto: se resolvió, o se fue con su línea.
  for (const p of antes.values()) {
    const seFueLaLinea = p.lid && Array.isArray(lidsVivos) && !lidsVivos.includes(p.lid);
    if (seFueLaLinea) cuenta.cancelados += 1; else cuenta.resueltos += 1;
  }

  ctx.pendientes = salida;
  cuenta.vivos = salida.length;
  return cuenta;
}

/** Deja anotado que en este turno se preguntó por él. */
export function marcarPreguntado(ctx, clave) {
  const p = arreglo(ctx?.pendientes).find((x) => x.clave === clave);
  if (p) p.turnoUltimaPregunta = ctx.contador || 0;
}

/**
 * UN INTENTO FALLIDO: el cliente contestó A ESTO y no se pudo resolver.
 *
 * Es lo único que sube el contador. Un mensaje sobre otra cosa —la dirección,
 * otro producto, un saludo— no cuenta, porque el cliente no está fallando en
 * contestar: está hablando de otra cosa, que es lo normal en una conversación.
 */
export function anotarIntentoFallido(ctx, clave) {
  const p = arreglo(ctx?.pendientes).find((x) => x.clave === clave);
  if (p) p.intentos = (p.intentos || 0) + 1;
  return p?.intentos || 0;
}

export const pendienteVigente = (ctx, clave) => arreglo(ctx?.pendientes).find((p) => p.clave === clave) || null;
export const tienePendiente = (ctx, clave) => arreglo(ctx?.pendientes).some((p) => p.clave === String(clave));

/** ¿Se preguntó por él en este turno o en el anterior? Para no insistir. */
export const preguntadoRecientemente = (ctx, clave, ventana = 2) => {
  const p = arreglo(ctx?.pendientes).find((x) => x.clave === String(clave));
  return !!p && p.turnoUltimaPregunta !== null && ((ctx.contador || 0) - p.turnoUltimaPregunta) < ventana;
};

/** Instantánea mínima para el log y las métricas: sin texto del cliente. */
export function resumenDelContexto(ctx) {
  return {
    fase: ctx?.fase || 'inicio',
    turno: ctx?.contador || 0,
    lineas: arreglo(ctx?.lineas).length,
    foco: ctx?.foco || null,
    pendientes: arreglo(ctx?.pendientes).map((p) => p.clave),
    pendientes_detalle: arreglo(ctx?.pendientes).map((p) => ({
      clave: p.clave, tipo: p.tipo, grupo: p.grupo || null,
      candidatos: p.candidatos || [], intentos: p.intentos || 0, desde: p.turnoCreacion,
    })),
    propuestas_abiertas: arreglo(ctx?.propuestas).filter((p) => p.estado === 'propuesto').length,
    aclaraciones: arreglo(ctx?.aclaraciones).length,
  };
}
