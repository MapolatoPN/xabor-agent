// EL PEDIDO EN CURSO SOBREVIVE AL REINICIO.
//
// `session.js` guarda las conversaciones en un `Map` del proceso. Ahí vive todo
// lo acordado ANTES de registrar el pedido: el carrito, la modalidad, la
// dirección, la forma de pago, qué dato se está esperando y el preview
// confirmable. Un reinicio lo borra, y los reinicios no son raros — cada
// despliegue es uno.
//
// El 2026-09-11, desplegando tres correcciones del asistente, se reiniciaron
// los procesos con conversaciones en curso. El cliente escribe "sí, confirmo" y
// el bot ya no sabe de qué.
//
// ── POR QUÉ ESTO NO CONVIERTE LA SESIÓN EN ASÍNCRONA ──────────────────────
//
// `getSession()` es SÍNCRONO y lo llaman decenas de sitios en `brain.js`.
// Volverlo asíncrono obligaría a tocar todos, que es exactamente la
// rearquitectura que no toca hacer para arreglar esto.
//
// En su lugar: el `Map` sigue siendo la memoria de trabajo, y esta capa lo
// hidrata y lo persiste en DOS puntos, los dos en `procesarMensaje`:
//
//   hidratar   ANTES de procesar el turno — si el proceso es nuevo, el carrito
//              vuelve de la base y la conversación continúa donde iba.
//   persistir  DESPUÉS, pase lo que pase (incluido un error) — lo que el
//              cliente acordó no puede perderse porque el turno fallara.
//
// Es literalmente lo que pide la auditoría: "recuperar antes de procesar el
// siguiente mensaje". Ni una llamada síncrona cambia de forma.
//
// ── LO QUE NO GUARDA ──────────────────────────────────────────────────────
//
// Pedidos ya REGISTRADOS. Esos viven en `pedidos_activos` con su folio, su
// deuda de emisión y su idempotencia, y ese mecanismo no se toca. Dos rutas
// hacia la cocina es justo lo que la 063 existe para impedir.
import { pool } from '../services/database.js';
import { getSession, deleteSession, registrarAlBorrarSesion } from './session.js';

// Tope del historial que se persiste. El `Map` puede tener una conversación de
// doscientos mensajes; la fila no necesita todos para reconstruir el carrito.
// Se conservan los últimos, que son los del ciclo en curso.
//
// Es un tope de TAMAÑO DE FILA, no una regla de negocio: el índice del ciclo
// (`cicloPedido`) se ajusta al recortar para que siga apuntando al mismo sitio
// relativo. Sin ese ajuste, el respaldo de una selección miraría mensajes
// equivocados y "mejor de fresa" dejaría de valer.
const MAX_MENSAJES_PERSISTIDOS = 60;

/** Qué campos viajan a la base. Todo lo demás se recalcula o no importa. */
function aFoto(session) {
  const mensajes = Array.isArray(session.mensajes) ? session.mensajes : [];
  const recorte = Math.max(0, mensajes.length - MAX_MENSAJES_PERSISTIDOS);
  return {
    canal: session.canal,
    estado: session.estado,
    mensajes: mensajes.slice(recorte),
    pedido: session.pedido,
    // El índice del ciclo se recalcula sobre el historial YA recortado.
    cicloPedido: Math.max(0, (session.cicloPedido || 0) - recorte),
    datosPedido: session.datosPedido ?? null,
    esperandoDato: session.esperandoDato ?? null,
    aclaracionProducto: session.aclaracionProducto ?? null,
    pedidoPreview: session.pedidoPreview ?? null,
    awaitingConfirmacion: session.awaitingConfirmacion ?? null,
    ordenesConfirmadas: session.ordenesConfirmadas ?? null,
    creado_en: session.creado_en,
    actualizado_en: session.actualizado_en,
  };
}

/** Vuelca la foto sobre la sesión en memoria, sin romper su identidad. */
function aplicarFoto(session, foto) {
  if (!foto || typeof foto !== 'object') return session;
  for (const [clave, valor] of Object.entries(foto)) {
    if (valor !== undefined) session[clave] = valor;
  }
  return session;
}

/**
 * Trae de la base lo que esta conversación tenía, si el proceso no lo tiene.
 *
 * NO pisa una sesión que ya está en memoria y tiene contenido: la memoria es
 * más reciente por definición —acaba de atender un turno— y la fila es de
 * antes. Solo hidrata cuando el proceso llega vacío, que es el caso del
 * reinicio.
 *
 * Nunca lanza. Si la base no responde, la conversación sigue como siempre
 * —en memoria— y se registra el aviso. Perder la durabilidad es malo; tumbar
 * el turno de un cliente por eso, peor.
 */
export async function hidratarSesion(sessionId, negocioId) {
  if (!sessionId || !negocioId) return { hidratada: false, motivo: 'sin identidad' };
  // Si su borrado va en vuelo, esta conversación se dio por terminada hace
  // un instante: recuperarla sería resucitar justo lo que se acaba de tirar.
  if (borradosEnVuelo.has(sessionId)) return { hidratada: false, motivo: 'recién borrada' };
  const session = getSession(sessionId);
  const enMemoria = (session.mensajes?.length || 0) > 0
    || (session.pedido?.items?.length || 0) > 0
    || !!session.pedidoPreview;
  if (enMemoria) return { hidratada: false, motivo: 'ya estaba en memoria' };

  try {
    const { rows } = await pool.query(
      `SELECT estado, revision FROM conversacion_estado
        WHERE negocio_id = $1 AND session_id = $2`, [negocioId, sessionId]);
    if (!rows.length) return { hidratada: false, motivo: 'sin estado previo' };
    aplicarFoto(session, rows[0].estado);
    session._revision = Number(rows[0].revision);
    console.log(`[Sesion] recuperada tras reinicio session=${sessionId.slice(-18)} `
      + `items=${session.pedido?.items?.length || 0} mensajes=${session.mensajes?.length || 0}`);
    return { hidratada: true, revision: session._revision };
  } catch (e) {
    console.error('[Sesion] no se pudo hidratar (se sigue en memoria):', e.message);
    return { hidratada: false, motivo: e.message };
  }
}

/**
 * Guarda el estado de la conversación. Se llama al terminar CADA turno.
 *
 * `revision` sube en cada escritura y se compara con la que teníamos: si otro
 * proceso escribió mientras este pensaba, se avisa. Hoy no debería ocurrir
 * —la cola serializa los turnos de una conversación dentro del proceso— pero
 * con dos réplicas sí, y es mejor verlo en el log que descubrirlo por un
 * carrito raro.
 *
 * Se escribe igualmente (last-write-wins). La alternativa —rechazar— dejaría
 * al cliente sin el turno que acaba de tener, y el estado que estamos
 * guardando incluye lo que ese cliente dijo hace un segundo.
 *
 * Nunca lanza, por el mismo motivo que `hidratarSesion`.
 */
export async function persistirSesion(sessionId, negocioId) {
  if (!sessionId || !negocioId) return { guardada: false };
  const session = getSession(sessionId);
  try {
    const { rows } = await pool.query(
      `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
       VALUES ($1, $2, $3::jsonb, 1)
       ON CONFLICT (negocio_id, session_id) DO UPDATE
         SET estado = $3::jsonb,
             revision = conversacion_estado.revision + 1,
             actualizado_at = NOW()
       RETURNING revision`,
      [negocioId, sessionId, JSON.stringify(aFoto(session))]);
    const revision = Number(rows[0].revision);
    const esperada = (session._revision || 0) + 1;
    if (session._revision && revision !== esperada) {
      console.warn(`[Sesion] escritura concurrente session=${sessionId.slice(-18)} `
        + `esperaba revision=${esperada} y quedó en ${revision} — otro proceso escribió esta conversación`);
    }
    session._revision = revision;
    return { guardada: true, revision };
  } catch (e) {
    console.error('[Sesion] no se pudo persistir (el turno ya se atendió):', e.message);
    return { guardada: false, motivo: e.message };
  }
}

// Borrar la memoria borra también la copia durable, SIEMPRE.
//
// Sin esto, `deleteSession()` --que llaman dos endpoints de `server.js` sin
// saber nada de durabilidad-- dejaba la fila viva y el carrito viejo volvía
// en el siguiente mensaje del cliente. Se detectó porque las suites que
// reutilizan un id de sesión empezaron a heredar estado entre corridas.
//
// Se borra por `session_id` a secas: la clave ya lleva el negocio dentro
// (`meta-<negocioId>-<telefono>`), así que no puede alcanzar a otro tenant.
//
// Es fuego y olvido: quien borra una sesión no debería esperar a la base, y
// una fila que sobreviva un instante de más no hace daño -- la siguiente
// hidratación solo ocurre si la memoria está vacía.
// Conversaciones cuyo borrado está EN VUELO.
//
// El borrado de la fila es asíncrono y `deleteSession` es síncrono, así que
// entre los dos hay una ventana: quien borre y vuelva a usar el mismo id en
// el mismo tick --`deleteSession(id); getSession(id)`, que es justo lo que
// hacen varias suites y lo que hará cualquiera-- encontraría la fila todavía
// viva y recuperaría el carrito que acababa de tirar.
//
// La intención "esta conversación terminó" SÍ se conoce en el acto. Se anota
// aquí y la hidratación la respeta, sin depender de que la base haya
// terminado. Lo detectó `fase-confirmacion-agrupada`, no esta suite.
const borradosEnVuelo = new Set();

registrarAlBorrarSesion((sessionId) => {
  borradosEnVuelo.add(sessionId);
  pool.query('DELETE FROM conversacion_estado WHERE session_id = $1', [sessionId])
    .catch((e) => console.error('[Sesion] no se pudo borrar la copia durable:', e.message))
    .finally(() => borradosEnVuelo.delete(sessionId));
});

/**
 * Olvida la conversación, en memoria y en la base.
 *
 * Se usa cuando el ciclo termina de verdad. Borrar solo la memoria dejaría una
 * fila que resucitaría el carrito viejo en el siguiente mensaje, que es peor
 * que no haber persistido nada.
 */
export async function olvidarSesion(sessionId, negocioId) {
  deleteSession(sessionId);
  if (!sessionId || !negocioId) return;
  try {
    await pool.query(`DELETE FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2`,
      [negocioId, sessionId]);
  } catch (e) {
    console.error('[Sesion] no se pudo olvidar:', e.message);
  }
}

/**
 * Barrido de conversaciones abandonadas.
 *
 * Cuántos días es "abandonada" lo decide el negocio, no este archivo: se pasa
 * por parámetro y sin valor por defecto escondido. Devuelve cuántas borró.
 */
export async function purgarConversacionesViejas(dias) {
  const d = Number(dias);
  if (!Number.isFinite(d) || d <= 0) throw new Error('purgarConversacionesViejas: hacen falta días > 0');
  const { rowCount } = await pool.query(
    `DELETE FROM conversacion_estado WHERE actualizado_at < NOW() - ($1 || ' days')::interval`, [String(d)]);
  return rowCount;
}
