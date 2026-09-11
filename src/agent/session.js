// Maneja el estado de cada conversación activa
// Una sesión = una llamada o un chat de WhatsApp

const sessions = new Map();

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSession(sessionId));
  }
  return sessions.get(sessionId);
}

// Quien necesite enterarse de que una sesión se borró se registra aquí.
//
// Existe por un defecto concreto: desde que el pedido es durable
// (`sesionDurable.js`), borrar SOLO la memoria dejaba la fila en la base, y
// esa fila resucitaba el carrito viejo en el siguiente mensaje. Peor que no
// haber persistido nada.
//
// Se resuelve con un aviso y no pidiéndole a cada llamador que recuerde
// borrar las dos copias: `server.js` tiene dos endpoints que llaman a
// `deleteSession` y ninguno tenía por qué saber de durabilidad. Una API que
// se puede usar mal se usa mal.
//
// El aviso no puede tumbar el borrado: si un oyente falla, la sesión se
// borra igual de la memoria.
const oyentesDeBorrado = [];
export function registrarAlBorrarSesion(cb) {
  if (typeof cb === 'function') oyentesDeBorrado.push(cb);
}

export function deleteSession(sessionId) {
  sessions.delete(sessionId);
  for (const cb of oyentesDeBorrado) {
    try { cb(sessionId); } catch (e) { console.error('[Sesion] oyente de borrado fallido:', e.message); }
  }
}

/**
 * Saca la conversación de la MEMORIA sin olvidarla.
 *
 * No es lo mismo que `deleteSession`, y la diferencia importa desde que el
 * pedido es durable:
 *
 *   deleteSession        el cliente/operador da la conversación por
 *                        terminada. Se borran las DOS copias.
 *   desalojarDeMemoria   solo se libera la memoria. La copia durable sigue,
 *                        y el siguiente mensaje la recupera.
 *
 * Hace falta porque el `Map` crece sin límite: hoy guarda todas las
 * conversaciones que ha visto el proceso desde que arrancó. Desalojar una
 * vieja ya no pierde nada -- antes sí, y por eso no existía.
 *
 * Es también lo que le pasa al proceso cuando se reinicia: la memoria se va,
 * la base se queda. Por eso las pruebas de durabilidad lo usan para imitar
 * un reinicio sin inventarse un mecanismo aparte.
 */
export function desalojarDeMemoria(sessionId) {
  return sessions.delete(sessionId);
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

function createSession(sessionId) {
  return {
    id: sessionId,
    canal: 'desconocido', // 'voz' | 'whatsapp' | 'test'
    estado: 'inicio',    // 'inicio' | 'tomando_pedido' | 'confirmando' | 'finalizado'
    mensajes: [],        // historial de conversación para Claude
    pedido: {
      items: [],         // [{ id, nombre, cantidad, precio_unitario, notas }]
      cliente: {
        nombre: null,
        telefono: null
      },
      modalidad: null,   // 'recoger' | 'entrega a domicilio'
      total: 0
    },
    // Índice en `mensajes` donde EMPIEZA el ciclo del pedido en curso. Todo lo
    // que el cliente dijo antes pertenece a un pedido ya cerrado y no puede
    // respaldar una selección del pedido actual (ver iniciarCicloPedido).
    cicloPedido: 0,
    creado_en: new Date().toISOString(),
    actualizado_en: new Date().toISOString()
  };
}

// ─── Ciclo del pedido en curso ─────────────────────────────────────────────
//
// La sesión de WhatsApp vive mientras viva la conversación: el mismo cliente
// puede hacer tres pedidos seguidos sobre el MISMO historial. Sin una frontera,
// "que sea de fresa" dicho hace dos pedidos serviría para justificar un sabor
// del pedido de ahora — un respaldo falso.
//
// La frontera mínima segura es un índice, no una máquina de estados: el ciclo
// empieza donde terminó el pedido anterior. Se mueve en UN solo momento —
// cuando una orden sale hacia el registro— porque es el único punto donde el
// carrito deja de estar en construcción.

/** Cierra el ciclo actual: lo dicho hasta aquí ya no respalda el pedido siguiente. */
export function iniciarCicloPedido(sessionId) {
  const session = getSession(sessionId);
  session.cicloPedido = session.mensajes.length;
  // El pedido anterior ya se cerró: su dirección y su forma de pago no pueden
  // arrastrarse al siguiente sin que el cliente las vuelva a decir.
  session.datosPedido = null;
  session.esperandoDato = null;
  session.actualizado_en = new Date().toISOString();
  return session.cicloPedido;
}

/** Turnos del CLIENTE (nunca del asistente) dentro del ciclo activo. */
export function turnosUsuarioDelCiclo(sessionId) {
  const session = getSession(sessionId);
  const desde = Number.isInteger(session.cicloPedido) ? session.cicloPedido : 0;
  return session.mensajes.slice(desde)
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content);
}

export function agregarMensaje(sessionId, rol, contenido) {
  const session = getSession(sessionId);
  session.mensajes.push({ role: rol, content: contenido });
  session.actualizado_en = new Date().toISOString();
  return session;
}

/**
 * Sustituye el último turno del asistente por lo que el cliente REALMENTE vio.
 *
 * Cuando el backend reemplaza la redacción del modelo por el resumen oficial,
 * el historial se quedaba con el texto descartado: el modelo creía haber dicho
 * algo que el cliente nunca leyó, y en el turno siguiente no sabía a qué
 * resumen respondía el "sí". Aquí se alinean las dos versiones.
 */
export function reemplazarUltimoMensajeAsistente(sessionId, contenido) {
  const session = getSession(sessionId);
  for (let i = session.mensajes.length - 1; i >= 0; i--) {
    if (session.mensajes[i].role === 'assistant') {
      session.mensajes[i].content = contenido;
      session.actualizado_en = new Date().toISOString();
      return true;
    }
  }
  return false;
}

export function actualizarEstado(sessionId, nuevoEstado) {
  const session = getSession(sessionId);
  session.estado = nuevoEstado;
  session.actualizado_en = new Date().toISOString();
}

// ─── Snapshot canónico del preview (confirmación determinista) ──────────────
//
// Cuando el backend muestra un resumen oficial, guarda AQUÍ la orden canónica
// que validó — no solo el total. Así, si el cliente responde "sí", el pedido se
// registra desde este snapshot y no depende de que el modelo vuelva a
// reconstruirlo (caso real: preview de $255, "Sí", y ningún folio creado).
//
// `guardarPreviewPedido` reemplaza cualquier snapshot anterior: solo el preview
// MÁS RECIENTE puede confirmarse.

export function guardarPreviewPedido(sessionId, snapshot) {
  const session = getSession(sessionId);
  // Un preview recién calculado SIEMPRE nace confirmable: es lo que el cliente
  // acaba de ver. Guardar uno nuevo reemplaza al anterior, así que una orden
  // estructurada posterior deja obsoleto al viejo aunque el detector léxico
  // hubiera clasificado mal la frase que la originó.
  session.pedidoPreview = { ...snapshot, consumido: false, confirmable: true };
  session.awaitingConfirmacion = true;
  session.actualizado_en = new Date().toISOString();
  return session.pedidoPreview;
}

/**
 * El turno actual NO pudo clasificarse (puede o no cambiar el pedido). El
 * snapshot se conserva —el flujo normal aún puede resolverlo y producir un
 * preview nuevo— pero deja de ser directamente confirmable: un "sí" posterior
 * no puede registrar un pedido que quizá ya no es el que el cliente quiere.
 * Solo un preview nuevo vuelve a habilitarlo.
 */
export function marcarPreviewNoConfirmable(sessionId) {
  const session = getSession(sessionId);
  if (session.pedidoPreview) {
    session.pedidoPreview.confirmable = false;
    session.awaitingConfirmacion = false;
    session.actualizado_en = new Date().toISOString();
  }
}

/**
 * Toma el snapshot y lo marca consumido EN LA MISMA VUELTA del event loop.
 * Node ejecuta este cuerpo sin ceder el control (no hay `await` dentro), así que
 * dos turnos concurrentes de la misma conversación no pueden obtenerlo ambos:
 * el segundo ve `consumido: true` y recibe null. Es el candado que impide dos
 * folios para un mismo carrito sin necesidad de un lock externo.
 */
// ── UN "SÍ" NO PUEDE COBRAR DOS VECES EL MISMO PEDIDO ─────────────────────
// XAB-0263: el cliente registró su pedido (XAB-0262), preguntó otra cosa
// —"¿qué incluyen los desayunos sorpresa?"— y el modelo, con el resumen todavía
// en su contexto, volvió a emitir <ORDEN_PREVIEW> del pedido YA COBRADO. El
// backend construyó un snapshot confirmable NUEVO, reimprimió el resumen, el
// cliente dijo "Sí" y se registró un segundo folio idéntico.
//
// El consumo atómico funcionaba: protegía contra dos "sí" sobre el MISMO
// snapshot. No protegía contra un snapshot NUEVO del MISMO pedido.
//
// Guarda de UN SOLO USO: la primera vez que reaparece un pedido ya confirmado
// se bloquea y se le dice al cliente que ya quedó registrado; si de verdad
// quiere otro igual, su siguiente petición pasa. Bloquearlo para siempre
// impediría repetir un pedido, que es legítimo y frecuente.

/** Deja constancia de que el cliente ya confirmó exactamente este pedido. */
export function marcarOrdenConfirmada(sessionId, fingerprint) {
  if (!fingerprint) return;
  const session = getSession(sessionId);
  if (!Array.isArray(session.ordenesConfirmadas)) session.ordenesConfirmadas = [];
  if (!session.ordenesConfirmadas.includes(fingerprint)) session.ordenesConfirmadas.push(fingerprint);
  if (session.ordenesConfirmadas.length > 5) session.ordenesConfirmadas.shift();
  session.actualizado_en = new Date().toISOString();
}

/**
 * ¿Este pedido ya lo confirmó el cliente? CONSUME la marca: se avisa una vez y
 * la siguiente petición idéntica se toma como un pedido nuevo de verdad.
 */
export function yaConfirmadaAntes(sessionId, fingerprint) {
  if (!fingerprint) return false;
  const session = getSession(sessionId);
  const i = (session.ordenesConfirmadas || []).indexOf(fingerprint);
  if (i < 0) return false;
  session.ordenesConfirmadas.splice(i, 1);
  session.actualizado_en = new Date().toISOString();
  return true;
}

// ── EL BACKEND LEE LAS RESPUESTAS A SUS PROPIAS PREGUNTAS ─────────────────
// Bucle real: el backend pidió la dirección, el cliente la escribió —"Boulevard
// Cbtis 34 #208 Col Guillén"— y el backend la volvió a pedir. Y otra vez. El
// dato viajaba en el borrador del modelo, y si el modelo no lo ponía ahí, nadie
// más lo veía; el cliente contestaba a una pregunta que nadie estaba oyendo.
//
// La pregunta la hace el backend, así que la respuesta también le toca a él.
// Aquí NO hay modelo de por medio ni llamada extra: se recuerda qué se preguntó
// y se lee lo que llega después. Lo recordado se fusiona con el borrador en
// cada turno, así que un modelo olvidadizo ya no puede perder un dato dicho.

/** Qué dato operativo está esperando el backend ('direccion', 'modalidad'...). */
export function esperandoDato(sessionId) {
  return getSession(sessionId).esperandoDato || null;
}

/** Deja anotado qué acaba de preguntar el backend. */
export function anotarPreguntaPendiente(sessionId, campo) {
  const session = getSession(sessionId);
  session.esperandoDato = campo || null;
  session.actualizado_en = new Date().toISOString();
}

/** Datos operativos ya dichos por el cliente y capturados por el backend. */
export function datosDelPedido(sessionId) {
  return getSession(sessionId).datosPedido || {};
}

/** Guarda un dato operativo dicho por el cliente. Vacío nunca sobreescribe. */
export function recordarDatoPedido(sessionId, campo, valor) {
  const v = String(valor || '').trim();
  if (!campo || !v) return;
  const session = getSession(sessionId);
  if (!session.datosPedido) session.datosPedido = {};
  session.datosPedido[campo] = v;
  session.esperandoDato = null;
  session.actualizado_en = new Date().toISOString();
}

export function consumirPreviewPedido(sessionId) {
  const session = getSession(sessionId);
  const snap = session.pedidoPreview;
  if (!snap || snap.consumido) return null;
  // Marcado como no confirmable por un turno indeterminado: no se registra.
  if (snap.confirmable === false) return null;
  snap.consumido = true;
  session.awaitingConfirmacion = false;
  session.actualizado_en = new Date().toISOString();
  return snap;
}

/** Devuelve el snapshot vigente SIN consumirlo (para inspección/decisión). */
export function verPreviewPedido(sessionId) {
  const snap = getSession(sessionId).pedidoPreview;
  return snap && !snap.consumido ? snap : null;
}

/**
 * Igual que verPreviewPedido, pero SOLO si el snapshot sigue siendo
 * confirmable. Es la única puerta que puede autorizar una escritura.
 *
 * Existe porque el camino legacy (<ORDEN_CONFIRMADA> emitida por el modelo)
 * leía `session.pedidoPreview.total` directamente: con un snapshot marcado
 * no-confirmable, una orden del mismo total volvía a pasar por 'registrar' y
 * escribía igual. `confirmable=false` tiene que ser autoridad para TODOS los
 * caminos, no solo para el determinista.
 */
export function verPreviewConfirmable(sessionId) {
  const snap = verPreviewPedido(sessionId);
  return snap && snap.confirmable !== false ? snap : null;
}

/**
 * Reactiva un snapshot que se consumió pero cuyo registro NO llegó a ocurrir
 * (p. ej. la escritura falló). Nunca revive uno cuyo pedido sí se creó: eso lo
 * decide el llamador, que es quien conoce el resultado transaccional.
 */
export function restaurarPreviewPedido(sessionId, snapshot) {
  const session = getSession(sessionId);
  if (!snapshot) return null;
  session.pedidoPreview = { ...snapshot, consumido: false };
  session.awaitingConfirmacion = true;
  session.actualizado_en = new Date().toISOString();
  return session.pedidoPreview;
}

/** El pedido cambió (o el cliente pidió otra cosa): el preview queda obsoleto. */
export function invalidarPreviewPedido(sessionId) {
  const session = getSession(sessionId);
  session.pedidoPreview = null;
  session.awaitingConfirmacion = false;
  session.actualizado_en = new Date().toISOString();
}
