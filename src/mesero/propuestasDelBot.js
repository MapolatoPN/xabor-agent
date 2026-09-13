// ─── Lo que el bot ofreció no es lo que el cliente pidió ──────────────────
//
// Módulo puro. Extiende las tres procedencias que ya distingue el carrito
// —DICHO, PERCIBIDO, INVENTADO— con las tres que aparecen cuando el bot deja
// de ser un extractor y empieza a conversar:
//
//   PROPUESTO    el bot lo ofreció. No entra al pedido. No es del cliente.
//   CONFIRMADO   el cliente lo aceptó de forma que no admite otra lectura.
//   RECHAZADO    el cliente dijo que no. No se vuelve a ofrecer.
//
// ── Por qué hace falta ───────────────────────────────────────────────────
//
// El reconciliador pregunta «¿nombró el cliente este producto?» mirando lo que
// el cliente escribió en el ciclo. Con un mesero que recomienda, esa pregunta
// se vuelve trampa en las dos direcciones:
//
//   el bot dice «¿te agrego un café?» y el cliente contesta «sí». El café no
//   aparece en ninguna frase del cliente, así que el carrito lo rechaza —y
//   tiene razón, con la información que tiene.
//
//   el bot dice «¿te agrego un café?» y el cliente contesta «no». Si al turno
//   siguiente el modelo mete el café en el borrador, «café» YA aparece en la
//   conversación y la evidencia parece existir.
//
// La salida no es relajar el carrito: es que el «sí» del cliente **produzca
// evidencia**, y solo para el producto concreto que se le ofreció. Eso es
// `evidenciaDeAceptacion`. La autoridad sigue siendo del código, y el ámbito
// de esa autoridad es una propuesta identificada, no una barra libre.
//
// ── El «sí» ambiguo ──────────────────────────────────────────────────────
//
//   bot     «¿Te agrego un café? ¿Y lo quieres para llevar?»
//   cliente «sí»
//
// A qué dijo que sí es indecidible, y elegir la más probable es exactamente lo
// que este proyecto no hace. Con dos propuestas abiertas y sin nada que las
// separe, no se resuelve ninguna: se pregunta.
//
// ── Y el «sí» viejo ──────────────────────────────────────────────────────
//
// Una propuesta solo la puede aceptar la respuesta INMEDIATA. Si el bot ofreció
// café hace cuatro turnos y el cliente escribe «sí» ahora, ese sí es de otra
// cosa. Las propuestas viejas caducan solas: siguen en el registro para no
// repetirlas, pero ya no las despierta un monosílabo.
import { palabrasQueLaSostienen } from '../orders/evidenciaDeEleccion.js';

export const PROPUESTO = 'propuesto';
export const CONFIRMADO = 'confirmado';
export const RECHAZADO = 'rechazado';
export const CADUCADA = 'caducada';

/** Qué clase de cosa se ofreció. Sirve para saber a dónde va un «sí». */
export const CLASES = Object.freeze(['producto', 'modificador', 'cantidad', 'modalidad', 'pago', 'repetir']);

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

// Afirmaciones y negaciones tal como se escriben en WhatsApp. La lista es de
// FORMA de responder, no de productos ni de negocios: no envejece con la carta.
const AFIRMA = /^(si|sii+|sip|claro|va|vale|sale|dale|orale|andale|bueno|ok|okey|okay|oki|de acuerdo|porfa|por favor|obvio|dale pues|dalee|dele|dame|ponle|ponme|agregalo|agregala|agregame|dame uno|dame una|si porfa|si por favor|si gracias|dale si|dale va|yes|dale ps)\b/;
const NIEGA = /^(no|nop|nel|nah|no gracias|gracias no|mejor no|asi esta bien|asi nomas|nada mas|ya no|ya con eso|es todo|eso es todo|paso|no por ahora|por ahora no|luego|despues)\b/;

// Cierres que no empiezan la frase pero la definen: «con eso está bien».
const CIERRA = /\b(asi esta bien|asi nomas|nada mas|es todo|eso es todo|con eso|ya con eso|ya es todo|seria todo|sería todo|nada mas gracias)\b/;

let secuencia = 0;
const nuevoId = () => `pr${(secuencia++).toString(36)}`;

/**
 * El bot ofrece algo. Queda anotado, y NO entra al pedido.
 *
 * `referencia` es lo que hay que reconocer después en la respuesta del cliente:
 * el nombre del producto, el de la opción, el valor de la modalidad. Sale del
 * catálogo del negocio; aquí no se escribe ningún nombre.
 */
export function proponer(ctx, { clase, referencia, etiqueta = '', datos = null } = {}) {
  const ref = String(referencia || '').trim();
  if (!ctx || !ref || !CLASES.includes(clase)) return null;
  // No se ofrece dos veces lo que ya se rechazó. Insistir es la diferencia
  // entre un mesero y un vendedor de tiempo compartido.
  if (fueRechazada(ctx, ref)) return null;
  const p = {
    id: nuevoId(),
    clase,
    referencia: ref,
    etiqueta: String(etiqueta || ref),
    ...(datos ? { datos } : {}),
    turno: ctx.contador || 0,
    estado: PROPUESTO,
  };
  ctx.propuestas.push(p);
  return p;
}

const abiertas = (ctx) => (ctx?.propuestas || []).filter((p) => p.estado === PROPUESTO);

/**
 * Las propuestas que UNA respuesta puede aceptar: las del último turno del bot.
 *
 * `turnoDelBot` es el número de turno en que el bot habló por última vez. Si no
 * se pasa, se toma el turno anterior al actual, que es lo que ocurre cuando el
 * cliente contesta de inmediato.
 */
export function propuestasVivas(ctx, turnoDelBot = null) {
  const t = turnoDelBot ?? ((ctx?.contador || 0) - 1);
  return abiertas(ctx).filter((p) => p.turno >= t);
}

/** ¿Ya se rechazó algo con esta referencia? Para no volver a ofrecerlo. */
export function fueRechazada(ctx, referencia) {
  const r = norm(referencia);
  return (ctx?.propuestas || []).some((p) => p.estado === RECHAZADO && norm(p.referencia) === r);
}

/** ¿Está confirmada? Para no volver a proponerla ni a contarla dos veces. */
export function fueConfirmada(ctx, referencia) {
  const r = norm(referencia);
  return (ctx?.propuestas || []).some((p) => p.estado === CONFIRMADO && norm(p.referencia) === r);
}

/** ¿El mensaje nombra esta propuesta? Con las palabras propias de su referencia. */
function laNombra(propuesta, mensaje) {
  const sostienen = palabrasQueLaSostienen(propuesta.referencia, mensaje);
  return sostienen.size > 0;
}

/**
 * Qué hizo el cliente con lo que se le ofreció.
 *
 * Devuelve siempre las cuatro listas. `ambigua` es la señal de que hay que
 * preguntar: hubo una respuesta de sí/no pero apunta a más de una propuesta y
 * nada en la frase las separa.
 *
 * No muta el contexto. Aplicar el resultado es `aplicarDesenlace`, y va aparte
 * para que quien decida pueda mirar antes de escribir.
 */
export function leerRespuesta(ctx, mensaje, { turnoDelBot = null } = {}) {
  const texto = norm(mensaje);
  const vivas = propuestasVivas(ctx, turnoDelBot);
  const vacio = { aceptadas: [], rechazadas: [], ambigua: false, candidatas: [] };
  if (!vivas.length) return vacio;

  const afirma = AFIRMA.test(texto);
  const niega = NIEGA.test(texto) || CIERRA.test(texto);

  // Nombradas: el cliente dijo de qué habla. Esto gana sobre todo lo demás,
  // incluso con varias abiertas, porque ya no hay nada que adivinar.
  const nombradas = vivas.filter((p) => laNombra(p, mensaje));
  if (nombradas.length) {
    // «no, el café no» nombra y niega: la negación manda sobre la mención.
    if (niega && !afirma) return { aceptadas: [], rechazadas: nombradas, ambigua: false, candidatas: [] };
    // Nombrarla y no negarla es aceptarla. «ponme el café», «va el café», «café».
    return { aceptadas: nombradas, rechazadas: [], ambigua: false, candidatas: [] };
  }

  if (!afirma && !niega) return vacio;

  // Sí/no pelados. Solo resuelven si hay UNA sola cosa a la que puedan apuntar.
  if (vivas.length === 1) {
    return niega
      ? { aceptadas: [], rechazadas: [vivas[0]], ambigua: false, candidatas: [] }
      : { aceptadas: [vivas[0]], rechazadas: [], ambigua: false, candidatas: [] };
  }

  // Un «no» general cierra TODAS las propuestas abiertas, y eso no es ambiguo:
  // rechazar de más no le agrega nada al pedido de nadie. Un «sí» general, en
  // cambio, agregaría — y por eso ese sí se pregunta.
  if (niega) return { aceptadas: [], rechazadas: vivas, ambigua: false, candidatas: [] };
  return { aceptadas: [], rechazadas: [], ambigua: true, candidatas: vivas };
}

/** Escribe el desenlace en el contexto. Devuelve lo aplicado. */
export function aplicarDesenlace(ctx, desenlace) {
  for (const p of desenlace?.aceptadas || []) {
    const viva = (ctx.propuestas || []).find((x) => x.id === p.id);
    if (viva) { viva.estado = CONFIRMADO; viva.turnoDesenlace = ctx.contador; }
  }
  for (const p of desenlace?.rechazadas || []) {
    const viva = (ctx.propuestas || []).find((x) => x.id === p.id);
    if (viva) { viva.estado = RECHAZADO; viva.turnoDesenlace = ctx.contador; }
  }
  return desenlace;
}

/**
 * Las propuestas que ya nadie va a contestar se marcan caducadas.
 *
 * Se llama al empezar un turno del cliente que no las resolvió. Siguen en el
 * registro —para no repetir lo que ya se ofreció y se ignoró— pero un «sí» de
 * dentro de tres turnos ya no las despierta.
 */
export function caducarViejas(ctx, { ventana = 2 } = {}) {
  const ahora = ctx?.contador || 0;
  let n = 0;
  for (const p of ctx?.propuestas || []) {
    if (p.estado === PROPUESTO && (ahora - p.turno) > ventana) { p.estado = CADUCADA; n++; }
  }
  return n;
}

/**
 * LA EVIDENCIA QUE PRODUCE UN «SÍ».
 *
 * Esto es lo que le permite al carrito aceptar un producto que el cliente nunca
 * escribió. No es una excepción al reconciliador: es alimentarle el hecho que
 * de verdad ocurrió —el cliente autorizó ESTE producto— en el único lenguaje
 * que el reconciliador entiende, que es texto del cliente.
 *
 * El ámbito es exactamente la referencia aceptada. Nada más de ese turno queda
 * autorizado por haber dicho que sí a una cosa.
 */
export function evidenciaDeAceptacion(aceptadas = []) {
  return aceptadas.map((p) => String(p.referencia || '').trim()).filter(Boolean).join(' ');
}

/** Lo ofrecido y no contestado, para que el bot no lo repita ni lo olvide. */
export const pendientesDeRespuesta = (ctx) => abiertas(ctx).map((p) => p.etiqueta);

/** Todo lo que el cliente ya rechazó. Una recomendación no puede volver aquí. */
export const rechazadas = (ctx) => (ctx?.propuestas || [])
  .filter((p) => p.estado === RECHAZADO).map((p) => p.referencia);
