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
    pendientes: [],          // { clave, pregunta, turno } — lo que falta y ya se preguntó
    modalidad: null,
    pago: null,
    propuestas: [],          // Fase E: lo que el bot ofreció y en qué acabó
    aclaraciones: [],        // ambigüedades abiertas, generadas por código
    turnos: [],              // { rol, texto, dicho, percibido }
    contador: 0,             // número de turno; sirve de reloj sin usar Date
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
  };
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

// ── Pendientes ───────────────────────────────────────────────────────────
//
// Un pendiente es algo que falta Y que ya se preguntó. Guardarlo evita las dos
// faltas de educación del bot actual: repetir la misma pregunta tres veces, y
// preguntar algo que el cliente ya contestó.

/**
 * `veces` cuenta INSISTENCIAS, no repeticiones.
 *
 * La diferencia importa porque de `veces` cuelga el escalado a una persona por
 * «demasiadas idas y vueltas». Sin `avanzo`, una conversación perfectamente
 * sana —el cliente elige salsa, luego proteína, luego pide una bebida— sube el
 * contador en cada turno solo porque la modalidad sigue sin preguntarse, y a
 * los tres turnos el bot llama a un humano en medio de un pedido que iba bien.
 * Pasó en el primer E2E, en el turno 8 de doce.
 *
 * Estar atascado es preguntar lo mismo SIN que el pedido se mueva. Cuando el
 * turno movió algo, el contador vuelve a uno.
 */
export function anotarPendiente(ctx, clave, pregunta = '', { avanzo = false } = {}) {
  const k = String(clave || '').trim();
  if (!k) return;
  const ya = ctx.pendientes.find((p) => p.clave === k);
  if (ya) {
    ya.turno = ctx.contador;
    ya.veces = avanzo ? 1 : (ya.veces || 1) + 1;
    return;
  }
  ctx.pendientes.push({ clave: k, pregunta: String(pregunta || ''), turno: ctx.contador, veces: 1 });
}

export function resolverPendiente(ctx, clave) {
  const k = String(clave || '').trim();
  ctx.pendientes = ctx.pendientes.filter((p) => p.clave !== k);
}

export const tienePendiente = (ctx, clave) => arreglo(ctx?.pendientes).some((p) => p.clave === String(clave));

/** ¿Ya se preguntó esto en este turno o en el anterior? Para no insistir. */
export const preguntadoRecientemente = (ctx, clave, ventana = 2) => {
  const p = arreglo(ctx?.pendientes).find((x) => x.clave === String(clave));
  return !!p && (ctx.contador - p.turno) < ventana;
};

/** Instantánea mínima para el log y las métricas: sin texto del cliente. */
export function resumenDelContexto(ctx) {
  return {
    fase: ctx?.fase || 'inicio',
    turno: ctx?.contador || 0,
    lineas: arreglo(ctx?.lineas).length,
    foco: ctx?.foco || null,
    pendientes: arreglo(ctx?.pendientes).map((p) => p.clave),
    propuestas_abiertas: arreglo(ctx?.propuestas).filter((p) => p.estado === 'propuesto').length,
    aclaraciones: arreglo(ctx?.aclaraciones).length,
  };
}
