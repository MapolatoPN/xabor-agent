// Buzones durables de WhatsApp: entrada y salida.
//
// ─── QUE ESTA MAL HOY ───────────────────────────────────────────────────────
//
// El webhook de Meta hace `res.sendStatus(200)` en su PRIMERA linea y despues
// procesa. Si el proceso muere en cualquier punto posterior -- o si la base no
// responde, o si el deploy reinicia justo ahi -- Meta ya recibio el ACK y no
// va a reintentar. El mensaje del cliente desaparece sin dejar rastro y nadie
// se entera.
//
// Ademas, aunque la tabla `mensajes` deduplica por message_id_externo, el
// webhook NO corta cuando detecta el duplicado: sigue hasta el bot. Una
// reentrega de Meta puede acabar en un pedido repetido.
//
// ─── EL ORDEN CORRECTO ──────────────────────────────────────────────────────
//
//   1. validar
//   2. deduplicar
//   3. PERSISTIR
//   4. responder 200
//   5. procesar aparte
//
// Recibir un evento y procesarlo son cosas distintas. El 200 solo puede
// significar "lo tengo guardado", nunca "lo entendi".
//
// ─── LO QUE NO SE PROMETE ───────────────────────────────────────────────────
//
// Meta no ofrece idempotencia de envio: no hay forma de decirle "manda esto
// una vez y si te lo repito ignoralo". Por eso un saliente cuyo intento murio
// a medias queda 'incierto' y no se reintenta solo -- exactamente el mismo
// criterio que la impresion RAW TCP. Reintentar a ciegas es mandarle al
// cliente el mensaje dos veces; darlo por enviado es no mandarselo nunca.
// Entre esas dos, la decision es de una persona.
import { pool } from './database.js';

const LEASE_MS = 60_000;
const MAX_INTENTOS_INBOX = 5;
const MAX_INTENTOS_OUTBOX = 6;

// ─────────────────────────── ENTRADA ────────────────────────────────────────

/**
 * Deriva la clave de deduplicacion de un evento de Meta.
 *
 * Para mensajes es el wamid. Para estados NO basta el wamid: el mismo mensaje
 * genera sent, delivered y read, y los tres son eventos legitimos distintos.
 * Se combina wamid + estado (+ timestamp) para no tirar dos de cada tres.
 */
export function claveEvento(tipo, dato) {
  if (tipo === 'mensaje') return `msg:${dato.id}`;
  if (tipo === 'estado')  return `st:${dato.id}:${dato.status}:${dato.timestamp || ''}`;
  return `otro:${dato.id || JSON.stringify(dato).slice(0, 120)}`;
}

/**
 * Persiste un evento entrante. Idempotente por evento_id.
 *
 * Devuelve `{ duplicado }` para que el webhook pueda cortar en seco: hoy
 * sigue procesando aunque el mensaje ya existiera.
 *
 * `negocioId` puede ser null. Un evento cuyo phone_number_id no esta mapeado
 * se guarda como 'huerfano' en vez de tirarse: perder el mensaje de un
 * cliente porque falta una fila de configuracion es peor que guardarlo sin
 * dueno y arreglarlo despues.
 */
export async function encolarEntrante({ negocioId = null, eventoId, tipo, phoneNumberId = null, payload }) {
  if (!eventoId || typeof eventoId !== 'string') {
    return { ok: false, motivo: 'eventoId ausente' };
  }
  const estado = negocioId ? 'pendiente' : 'huerfano';

  // RETURNING vacio == ya existia. Es la unica forma honesta de distinguir
  // "lo inserte" de "ya estaba" con ON CONFLICT DO NOTHING.
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_inbox (negocio_id, evento_id, tipo, phone_number_id, payload, estado)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (evento_id) DO NOTHING
     RETURNING id, estado`,
    [negocioId, eventoId, tipo, phoneNumberId, JSON.stringify(payload ?? {}), estado]);

  if (rows[0]) return { ok: true, duplicado: false, id: rows[0].id, estado: rows[0].estado };

  const previo = await pool.query(
    `SELECT id, estado, procesado_en FROM whatsapp_inbox WHERE evento_id = $1`, [eventoId]);
  return {
    ok: true, duplicado: true,
    id: previo.rows[0]?.id ?? null,
    estado: previo.rows[0]?.estado ?? null,
    yaProcesado: Boolean(previo.rows[0]?.procesado_en),
  };
}

/**
 * Reclama eventos para procesar.
 *
 * FOR UPDATE SKIP LOCKED es lo que permite tener N workers en N instancias
 * sin que dos tomen el mismo evento: el que llega segundo salta las filas
 * bloqueadas en vez de esperarlas.
 *
 * El lease cubre el otro caso: si el worker muere con la fila en
 * 'procesando', nadie la desbloquea -- por eso se recupera tambien lo que
 * tenga el lease vencido.
 */
export async function reclamarEntrantes(workerId, { limite = 10, leaseMs = LEASE_MS } = {}) {
  const { rows } = await pool.query(
    `WITH elegidos AS (
       SELECT id FROM whatsapp_inbox
        WHERE (estado = 'pendiente'
               OR (estado = 'procesando' AND lease_hasta < NOW()))
          AND intentos < $3
        ORDER BY recibido_en
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_inbox i
        SET estado = 'procesando', worker_id = $1,
            lease_hasta = NOW() + ($4 || ' milliseconds')::interval,
            intentos = i.intentos + 1
       FROM elegidos e WHERE i.id = e.id
     RETURNING i.*`,
    [workerId, limite, MAX_INTENTOS_INBOX, String(leaseMs)]);
  return rows;
}

export async function marcarEntranteProcesado(id) {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_inbox SET estado='procesado', procesado_en=NOW(), worker_id=NULL, lease_hasta=NULL
      WHERE id=$1 AND estado='procesando'`, [id]);
  return rowCount === 1;
}

export async function marcarEntranteFallido(id, error) {
  // Se agota, no se borra. Un evento que no supimos procesar sigue siendo
  // informacion: alguien tiene que poder verlo.
  const { rows } = await pool.query(
    `UPDATE whatsapp_inbox
        SET estado = CASE WHEN intentos >= $3 THEN 'fallido' ELSE 'pendiente' END,
            ultimo_error = $2, worker_id = NULL, lease_hasta = NULL
      WHERE id = $1 RETURNING estado, intentos`,
    [id, String(error).slice(0, 500), MAX_INTENTOS_INBOX]);
  return rows[0] || null;
}

/** Reasigna los huerfanos cuando por fin se configura el negocio. */
export async function adoptarHuerfanos(phoneNumberId, negocioId) {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_inbox SET negocio_id = $2, estado = 'pendiente'
      WHERE phone_number_id = $1 AND estado = 'huerfano'`,
    [phoneNumberId, negocioId]);
  return rowCount;
}

// ─────────────────────────── SALIDA ─────────────────────────────────────────

/**
 * Encola un saliente. Idempotente por (negocio, clave_idem): si la misma
 * causa lo genera dos veces, es un solo mensaje.
 */
export async function encolarSaliente({ negocioId, claveIdem, destino, tipo = 'texto', contenido }) {
  if (!negocioId || !claveIdem || !destino) {
    return { ok: false, motivo: 'faltan negocioId, claveIdem o destino' };
  }
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_outbox (negocio_id, clave_idem, destino, tipo, contenido)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (negocio_id, clave_idem) DO NOTHING
     RETURNING id, estado`,
    [negocioId, claveIdem, destino, tipo, JSON.stringify(contenido ?? {})]);

  if (rows[0]) return { ok: true, duplicado: false, id: rows[0].id };

  const previo = await pool.query(
    `SELECT id, estado, wamid FROM whatsapp_outbox WHERE negocio_id=$1 AND clave_idem=$2`,
    [negocioId, claveIdem]);
  return { ok: true, duplicado: true, id: previo.rows[0]?.id ?? null, estado: previo.rows[0]?.estado ?? null };
}

export async function reclamarSalientes(workerId, { limite = 10, leaseMs = LEASE_MS } = {}) {
  const { rows } = await pool.query(
    `WITH elegidos AS (
       SELECT id FROM whatsapp_outbox
        WHERE estado IN ('encolado','fallo_reintentable')
          AND proximo_intento_en <= NOW()
          AND intentos < $3
        ORDER BY proximo_intento_en
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_outbox o
        SET estado='enviando', worker_id=$1,
            lease_hasta = NOW() + ($4 || ' milliseconds')::interval,
            intentos = o.intentos + 1
       FROM elegidos e WHERE o.id = e.id
     RETURNING o.*`,
    [workerId, limite, MAX_INTENTOS_OUTBOX, String(leaseMs)]);
  return rows;
}

export async function marcarSalienteEnviado(id, wamid) {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_outbox
        SET estado='enviado_a_meta', wamid=$2, enviado_en=NOW(), worker_id=NULL, lease_hasta=NULL
      WHERE id=$1`, [id, wamid || null]);
  return rowCount === 1;
}

/**
 * Un saliente cuyo intento murio despues de escribir en el socket.
 *
 * No se reintenta solo. Meta pudo haberlo recibido y no hay forma de
 * preguntarselo: reintentar es arriesgar un mensaje duplicado al cliente.
 * Queda marcado y lo decide una persona.
 */
export async function marcarSalienteIncierto(id, motivo) {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_outbox SET estado='incierto', ultimo_error=$2, worker_id=NULL, lease_hasta=NULL
      WHERE id=$1`, [id, String(motivo).slice(0, 500)]);
  return rowCount === 1;
}

/**
 * Fallo antes de que saliera un solo byte: reintentar es seguro.
 * Backoff exponencial con techo, para no martillar a Meta cuando esta caido.
 */
export async function marcarSalienteFallido(id, { codigo = null, error = '', reintentable = true } = {}) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_outbox
        SET estado = CASE WHEN $4 = false OR intentos >= $5 THEN 'fallo_definitivo' ELSE 'fallo_reintentable' END,
            codigo_error = $2, ultimo_error = $3,
            proximo_intento_en = NOW() + (LEAST(POWER(2, intentos) * 1000, 300000) || ' milliseconds')::interval,
            worker_id = NULL, lease_hasta = NULL
      WHERE id = $1 RETURNING estado, intentos`,
    [id, codigo, String(error).slice(0, 500), reintentable, MAX_INTENTOS_OUTBOX]);
  return rows[0] || null;
}

/** Rescata salientes cuyo worker murio con el lease puesto. */
export async function recuperarSalientesColgados({ leaseMs = LEASE_MS } = {}) {
  // 'enviando' con el lease vencido es AMBIGUO: pudo haber llegado a Meta.
  // Se marca incierto en vez de devolverlo a la cola.
  const { rows } = await pool.query(
    `UPDATE whatsapp_outbox
        SET estado='incierto', ultimo_error='el worker murio con el envio en vuelo',
            worker_id=NULL, lease_hasta=NULL
      WHERE estado='enviando' AND lease_hasta < NOW() RETURNING id`);
  return rows.length;
}

// ─────────────────────────── OBSERVABILIDAD ─────────────────────────────────

/**
 * Metricas para alertar antes de que un cliente se queje. Lo importante no es
 * cuantos hay pendientes sino cuanto lleva esperando el mas viejo: una cola
 * de 3 mensajes parada 40 minutos es peor que una de 300 que avanza.
 */
export async function metricasWhatsapp(negocioId = null) {
  const filtro = negocioId ? 'WHERE negocio_id = $1' : '';
  const args = negocioId ? [negocioId] : [];
  const { rows: [m] } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM whatsapp_inbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado IN ('pendiente','procesando')) AS inbox_pendientes,
       (SELECT count(*)::int FROM whatsapp_inbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado = 'fallido')                    AS inbox_fallidos,
       (SELECT count(*)::int FROM whatsapp_inbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado = 'huerfano')                   AS inbox_huerfanos,
       (SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(recibido_en))), 0)::int FROM whatsapp_inbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado IN ('pendiente','procesando')) AS inbox_mas_viejo_seg,
       (SELECT count(*)::int FROM whatsapp_outbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado IN ('encolado','enviando','fallo_reintentable')) AS outbox_pendientes,
       (SELECT count(*)::int FROM whatsapp_outbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado = 'incierto')                  AS outbox_inciertos,
       (SELECT count(*)::int FROM whatsapp_outbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado = 'fallo_definitivo')          AS outbox_fallidos,
       (SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int FROM whatsapp_outbox ${filtro} ${filtro ? 'AND' : 'WHERE'} estado IN ('encolado','fallo_reintentable')) AS outbox_mas_viejo_seg
    `, args);
  return m;
}
