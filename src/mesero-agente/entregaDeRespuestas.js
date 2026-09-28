// ─── LA ENTREGA DE LAS RESPUESTAS DEL AGENTE ─────────────────────────────
//
// Una respuesta comprometida (fila `respuesta_cliente` del outbox, escrita en
// el commit del turno) sale a Meta por DOS caminos: en línea, justo después
// del turno, y el despachador, que recoge lo que quedó colgado. Las reglas que
// impiden que salga dos veces:
//
//   1. RECLAMAR antes de enviar. `pendiente → enviando` en un UPDATE atómico,
//      con dueño y hora (un arrendamiento). Quien no la reclama, no la envía:
//      el camino en línea y el despachador —o dos despachadores— nunca mandan
//      la misma fila.
//   2. La ACEPTACIÓN de Meta se persiste PRIMERO y sola: `→ entregado` con el
//      wamid, en una sentencia. El historial del chat y el acuse del diálogo
//      van DESPUÉS, cada uno aislado: si fallan, la fila sigue entregada, con
//      una nota para conciliar, y jamás vuelve a quedar disponible.
//   3. Solo un RECHAZO CONFIRMADO se reintenta: Meta contestó con error, o la
//      conexión nunca llegó a establecerse. Un resultado INCIERTO (timeout,
//      conexión cortada a media petición, respuesta ilegible) no se reenvía:
//      pasa a `incierto` y a revisión humana. El transporte no garantiza
//      exactamente-una-vez y aquí no se finge: entre un posible duplicado y
//      una persona revisando, se elige a la persona.
//   4. Una fila que se queda en `enviando` más allá del arrendamiento es un
//      emisor que murió a media entrega: no se sabe si Meta la aceptó →
//      `incierto`, nunca reenvío.
//   5. Una respuesta que el cliente NO recibió pasa a una PERSONA, y eso
//      también es durable: rechazo agotado, respuesta vencida, resultado
//      incierto o emisor muerto marcan la fila (`humano_motivo`) en la MISMA
//      sentencia que la saca de circulación. Después se confirma la revisión
//      humana de la conversación con un arrendamiento propio
//      (`humano_reclamado_at`): dos procesos nunca la piden a la vez, y si la
//      confirmación falla o el proceso muere, el despachador la retoma hasta
//      dejar `humano_confirmado_at`. Una respuesta superada por otra más nueva
//      o de una conversación que ya atiende una persona no la necesita.
//
// La deduplicación ENTRANTE por wamid (whatsapp_entradas) no se toca: esto es
// solo la salida.
import { pool as poolPorOmision } from '../services/database.js';
import { acusarDialogo } from './contratoConversacional.js';

const claveDeSesion = (telefono) => `agente:${telefono}`;

/**
 * Por qué una respuesta que no llegó pasa a una persona. Son los motivos que
 * ve el panel y el aviso al equipo (ver ETIQUETA_MOTIVO en whatsapp-meta.js).
 */
export const MOTIVO_HUMANO = Object.freeze({
  NO_ENTREGADA: 'AGENTE_RESPUESTA_NO_ENTREGADA', // Meta la rechazó y ya no se reintenta
  VENCIDA: 'AGENTE_RESPUESTA_VENCIDA',           // no salió a tiempo: mandarla ya sería fuera de contexto
  INCIERTA: 'AGENTE_RESPUESTA_INCIERTA',         // no se sabe si llegó: no se reenvía
});

/**
 * CONFIRMA EL PASO A UNA PERSONA de una fila que ya lo tiene marcado.
 *
 * `alHumano({ negocioId, telefono, motivo, fila })` tiene que devolver `true`
 * solo si la conversación quedó en revisión humana de forma durable (nueva o
 * ya existente). Cualquier otra cosa —false, una excepción— deja la fila por
 * confirmar y el despachador la retoma.
 *
 * El reclamo (`humano_reclamado_at`) es condicional y atómico: dos procesos
 * que llegan a la vez a la misma fila no llaman los dos a `alHumano`. Un
 * proceso que muere con el reclamo puesto lo pierde al vencer el arrendamiento.
 *
 * Devuelve { estado: 'confirmada' | 'pendiente' | 'no_reclamada' | 'sin_destino' }.
 */
export async function confirmarEntregaHumana({
  db = poolPorOmision, id, alHumano = null, arrendamientoSeg = 60,
} = {}) {
  if (typeof alHumano !== 'function') return { estado: 'sin_destino' };
  const { rows: [f] } = await db.query(
    `UPDATE agente_outbox
        SET humano_reclamado_at = now()
      WHERE id = $1 AND humano_motivo IS NOT NULL AND humano_confirmado_at IS NULL
        AND (humano_reclamado_at IS NULL OR humano_reclamado_at < now() - ($2 || ' seconds')::interval)
      RETURNING id, negocio_id, carga, humano_motivo`,
    [id, String(arrendamientoSeg)]);
  if (!f) return { estado: 'no_reclamada' };
  let confirmada = false;
  let error = null;
  try {
    confirmada = (await alHumano({ negocioId: f.negocio_id, telefono: f.carga?.telefono || null,
      motivo: f.humano_motivo, fila: f })) === true;
  } catch (e) {
    error = e;
  }
  if (confirmada) {
    await db.query(
      `UPDATE agente_outbox SET humano_confirmado_at = now(), humano_reclamado_at = NULL
        WHERE id = $1 AND humano_confirmado_at IS NULL`, [f.id]);
    console.warn(`[AGENTE-OUTBOX] evento=entrega_humana_confirmada fila=${f.id} motivo=${f.humano_motivo}`);
    return { estado: 'confirmada' };
  }
  // No se pudo confirmar: se suelta el reclamo para que el siguiente barrido
  // lo intente otra vez. Nunca se da por atendida una conversación que nadie
  // tiene en su lista.
  await db.query(
    `UPDATE agente_outbox SET humano_reclamado_at = NULL,
            ultimo_error = left(coalesce(ultimo_error || ' | ', '') || $2, 500)
      WHERE id = $1 AND humano_confirmado_at IS NULL`,
    [f.id, `humano_sin_confirmar: ${error ? error.message : 'la revisión no quedó activa'}`]).catch(() => {});
  console.error(`[AGENTE-OUTBOX] ALERTA entrega_humana_sin_confirmar fila=${f.id} motivo=${f.humano_motivo}: `
    + `${error ? error.message : 'la revisión no quedó activa'} — se reintenta en el siguiente barrido`);
  return { estado: 'pendiente' };
}

// Errores de red en los que la petición NUNCA llegó a Meta: la conexión no se
// estableció. Cualquier otro error de red puede haber ocurrido después de que
// Meta recibiera el mensaje.
const SIN_CONEXION = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT']);

/**
 * ¿Qué se sabe de un envío que lanzó? Puro.
 *   rechazado — Meta respondió con error, o no hubo conexión: se puede reintentar.
 *   incierto  — pudo haberse entregado: no se reenvía.
 */
export function clasificarErrorDeEnvio(error) {
  const mensaje = String(error?.message || error || '');
  if (/^Meta API:/.test(mensaje)) return { resultado: 'rechazado', motivo: mensaje.slice(0, 300) };
  const codigo = error?.code || error?.cause?.code || null;
  if (codigo && SIN_CONEXION.has(codigo)) return { resultado: 'rechazado', motivo: `sin_conexion:${codigo}` };
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { resultado: 'incierto', motivo: `timeout: ${mensaje.slice(0, 200)}` };
  }
  return { resultado: 'incierto', motivo: (codigo ? `${codigo}: ` : '') + (mensaje.slice(0, 280) || 'error_desconocido') };
}

/**
 * Llama al transporte y traduce lo que pasó. El transporte devuelve el cuerpo
 * de Meta (o el wamid) al aceptar, `null` si ni siquiera lo intentó (sin
 * credenciales), o lanza.
 */
export async function enviarYClasificar(enviar) {
  let respuesta;
  try {
    respuesta = await enviar();
  } catch (e) {
    return clasificarErrorDeEnvio(e);
  }
  if (respuesta === null || respuesta === undefined) {
    return { resultado: 'rechazado', motivo: 'no_intentado: sin credenciales o sin destino' };
  }
  const wamid = typeof respuesta === 'string' ? respuesta : respuesta?.messages?.[0]?.id;
  if (!wamid) return { resultado: 'incierto', motivo: 'respuesta_de_meta_sin_wamid' };
  return { resultado: 'aceptado', wamid: String(wamid) };
}

/**
 * El acuse del DIÁLOGO: Meta aceptó esta respuesta, así que el resumen que
 * llevaba ya lo leyó el cliente (solo un resumen acusado autoriza un «sí»).
 * Una transacción sobre la fila de la conversación; la versión del JSON
 * acompaña a la revisión.
 */
export async function acusarDialogoEnviado({
  db = poolPorOmision, negocioId, telefono, dialogoId = null, texto, mensaje = '', wamidSalida,
} = {}) {
  if (!wamidSalida) throw new Error('acuse_de_transporte_ausente');
  const sessionId = claveDeSesion(telefono);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    // La hora del acuse sale del reloj de la BASE, el mismo que fecha la
    // recepción de cada mensaje (`whatsapp_entradas.recibido_at`): así se
    // puede saber si una respuesta del cliente se escribió antes o después de
    // que le llegara la pregunta (ver `escritoAntesDelAcuse`).
    const { rows } = await cliente.query(
      `SELECT estado, clock_timestamp() AS ahora FROM conversacion_estado
        WHERE negocio_id=$1 AND session_id=$2 FOR UPDATE`,
      [negocioId, sessionId]);
    if (rows[0]) {
      const estado = rows[0].estado;
      // La reserva del botón puede haber conciliado el acuse desde el outbox.
      // Un acuse tardío idéntico no cambia la revisión debajo del ejecutor.
      if (dialogoId && estado.dialogo?.id === dialogoId && estado.dialogo.texto === texto
        && estado.dialogo.enviado === true && estado.dialogo.wamid === wamidSalida) {
        await cliente.query('COMMIT'); return;
      }
      if (dialogoId) {
        if (!acusarDialogo(estado, dialogoId, texto, { acusadoAt: rows[0].ahora })) throw new Error('acuse_no_corresponde_al_turno');
        estado.dialogo.wamid = wamidSalida;
      } else {
        estado.dialogo = null;
        estado.foco = null;
        estado.pendiente = null;
        estado.historialDialogo = [...(estado.historialDialogo || []),
          { rol: 'user', texto: mensaje }, { rol: 'assistant', texto }].slice(-20);
      }
      await cliente.query(
        `UPDATE conversacion_estado
            SET estado = jsonb_set($3::jsonb, '{version}', to_jsonb(conversacion_estado.revision + 1)),
                revision = revision + 1, actualizado_at = NOW()
          WHERE negocio_id = $1 AND session_id = $2`,
        [negocioId, sessionId, JSON.stringify(estado)]);
    }
    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/** La aceptación de Meta, escrita sola: la fila deja de estar disponible para siempre. */
async function registrarAceptacion(db, id, wamid) {
  await db.query(
    `UPDATE agente_outbox
        SET estado = 'entregado', entregado_at = now(), wamid_salida = $2,
            carga = carga || jsonb_build_object('wamid_salida', $2::text)
      WHERE id = $1 AND estado IN ('pendiente', 'enviando', 'incierto')`,
    [id, wamid]);
}

/**
 * ENTREGA UNA RESPUESTA. `fila` es una fila ya reclamada (el despachador);
 * sin ella se reclama por `outboxClave` (el camino en línea).
 *
 * `enviar({ negocioId, telefono, texto })` → cuerpo de Meta | wamid | null | lanza.
 * `registrarHistorial({ wamid, fila })` y el acuse del diálogo son secundarios.
 * `politicaRechazo`: 'reintentar' (el despachador) o 'no_reintentar' (en
 * línea: una respuesta rechazada pasa a una persona y no se reenvía sola
 * minutos después, fuera de contexto).
 * `alHumano`: confirma la revisión humana de una respuesta que no llegó (ver
 * `confirmarEntregaHumana`). `alIncierto` es su nombre anterior.
 *
 * Devuelve { estado: 'entregado'|'reintentar'|'fallido'|'incierto'|'no_reclamada', humano?, … }.
 */
export async function entregarRespuesta({
  db = poolPorOmision, outboxClave = null, fila = null, enviar, registrarHistorial = null,
  alHumano = null, alIncierto = null, arrendamientoHumanoSeg = 60,
  reclamador = `emisor-${process.pid}`, mensajeCliente = '', politicaRechazo = 'reintentar', maxIntentos = 3,
} = {}) {
  if (typeof enviar !== 'function') throw new Error('entregarRespuesta necesita enviar');
  const aPersona = typeof alHumano === 'function' ? alHumano : alIncierto;
  let f = fila;
  if (!f) {
    const { rows } = await db.query(
      `UPDATE agente_outbox
          SET estado = 'enviando', reclamado_at = now(), reclamado_por = $2, intentos = intentos + 1
        WHERE evento_clave = $1 AND tipo = 'respuesta_cliente' AND estado = 'pendiente'
        RETURNING *`,
      [outboxClave, reclamador]);
    f = rows[0];
    if (!f) {
      const { rows: [actual] } = await db.query(
        'SELECT estado, wamid_salida FROM agente_outbox WHERE evento_clave = $1', [outboxClave]);
      return { estado: 'no_reclamada', estadoFila: actual?.estado ?? null, wamid: actual?.wamid_salida ?? null };
    }
  }
  const carga = f.carga || {};
  const r = await enviarYClasificar(async () => {
    let interactivo = carga.interactivo || null;
    if (interactivo) {
      const { prepararEnvioInteractivo } = await import('./transporteInteractivo.js');
      const v = await prepararEnvioInteractivo({ db, negocioId: f.negocio_id,
        telefono: carga.telefono, texto: carga.texto, interactivo });
      if (!v.permitido) return null;
      interactivo = v.interactivo;
    }
    const texto = !interactivo && carga.interactivo && carga.texto_fallback ? carga.texto_fallback : carga.texto;
    if (texto !== carga.texto) {
      await db.query("UPDATE agente_outbox SET carga=jsonb_set(carga,'{texto_enviado}',to_jsonb($2::text)) WHERE id=$1 AND estado='enviando'",[f.id,texto]);
      // Historial muestra lo enviado; el acuse sigue ligado al diálogo
      // original y su huella, no a un resumen reconstruido al despachar.
      f = {...f,carga:{...carga,texto}};
    }
    return enviar({ negocioId: f.negocio_id, telefono: carga.telefono, texto, interactivo });
  });

  if (r.resultado === 'aceptado') {
    try {
      await registrarAceptacion(db, f.id, r.wamid);
    } catch (e) {
      // Meta ya lo aceptó y la base no lo pudo anotar. La fila sigue en
      // `enviando`: el barrido de arrendamientos la pasará a `incierto`, jamás
      // a reenvío. Se grita aquí con el wamid para poder conciliar.
      console.error(`[AGENTE-OUTBOX] ALERTA aceptacion_sin_registrar fila=${f.id} wamid=${r.wamid}: ${e?.message}`);
      return { estado: 'entregado', wamid: r.wamid, aceptacionRegistrada: false, notas: [`aceptacion:${e?.message}`] };
    }
    const notas = [];
    if (typeof registrarHistorial === 'function') {
      try { await registrarHistorial({ wamid: r.wamid, fila: f }); }
      catch (e) { notas.push(`historial: ${e?.message}`); }
    }
    try {
      await acusarDialogoEnviado({ db, negocioId: f.negocio_id, telefono: carga.telefono,
        dialogoId: carga.dialogo_id || null, texto: carga.texto, mensaje: mensajeCliente, wamidSalida: r.wamid });
    } catch (e) {
      // Un diálogo que cambió (ya lo superó otro turno) no es un error de
      // entrega. Si fue la base, el siguiente turno lo concilia leyendo esta
      // fila entregada (ver `conciliarDialogoEntregado`).
      if (e?.message !== 'acuse_no_corresponde_al_turno') notas.push(`dialogo: ${e?.message}`);
    }
    if (notas.length) {
      console.error(`[AGENTE-OUTBOX] entregado con pendientes de conciliar fila=${f.id} wamid=${r.wamid}: ${notas.join(' | ')}`);
      await db.query('UPDATE agente_outbox SET ultimo_error = $2 WHERE id = $1',
        [f.id, `post_aceptacion: ${notas.join(' | ')}`.slice(0, 500)]).catch(() => {});
    }
    return { estado: 'entregado', wamid: r.wamid, aceptacionRegistrada: true, notas };
  }

  if (r.resultado === 'rechazado') {
    const agotada = politicaRechazo !== 'reintentar' || Number(f.intentos) >= maxIntentos;
    // Agotada = el cliente ya no la va a recibir: la marca de «pasa a una
    // persona» se escribe en la MISMA sentencia que la saca de circulación.
    const { rowCount } = await db.query(
      `UPDATE agente_outbox
          SET estado = $2, ultimo_error = $3, reclamado_at = NULL, reclamado_por = NULL,
              disponible_at = now() + (LEAST(intentos, 6) * 30 || ' seconds')::interval,
              humano_motivo = CASE WHEN $4::text IS NULL THEN humano_motivo ELSE COALESCE(humano_motivo, $4::text) END,
              humano_solicitado_at = CASE WHEN $4::text IS NULL THEN humano_solicitado_at
                                          ELSE COALESCE(humano_solicitado_at, now()) END
        WHERE id = $1 AND estado = 'enviando'`,
      [f.id, agotada ? 'fallido' : 'pendiente', `rechazado: ${r.motivo}`.slice(0, 500),
        agotada ? MOTIVO_HUMANO.NO_ENTREGADA : null]);
    if (!agotada) return { estado: 'reintentar', motivo: r.motivo };
    console.error(`[AGENTE-OUTBOX] ALERTA respuesta_no_entregada fila=${f.id}: ${r.motivo} — pasa a una persona`);
    const humano = rowCount
      ? await confirmarEntregaHumana({ db, id: f.id, alHumano: aPersona, arrendamientoSeg: arrendamientoHumanoSeg })
      : { estado: 'no_reclamada' };
    return { estado: 'fallido', motivo: r.motivo, humano: humano.estado };
  }

  const { rowCount } = await db.query(
    `UPDATE agente_outbox SET estado = 'incierto', ultimo_error = $2,
            humano_motivo = COALESCE(humano_motivo, $3::text),
            humano_solicitado_at = COALESCE(humano_solicitado_at, now())
      WHERE id = $1 AND estado = 'enviando'`,
    [f.id, `incierto: ${r.motivo}`.slice(0, 500), MOTIVO_HUMANO.INCIERTA]);
  console.error(`[AGENTE-OUTBOX] ALERTA respuesta_incierta fila=${f.id}: ${r.motivo} — no se reenvía; revisión humana`);
  const humano = rowCount
    ? await confirmarEntregaHumana({ db, id: f.id, alHumano: aPersona, arrendamientoSeg: arrendamientoHumanoSeg })
    : { estado: 'no_reclamada' };
  return { estado: 'incierto', motivo: r.motivo, humano: humano.estado };
}

/**
 * El TRANSPORTE simulado de las pruebas y replays: se da por aceptada la
 * respuesta con un wamid conocido, por los mismos pasos que una aceptación real
 * (fila entregada + acuse del diálogo).
 */
export async function registrarAceptacionExterna({
  db = poolPorOmision, negocioId, telefono, outboxClave = null, dialogoId = null, texto, mensaje = '', wamidSalida,
} = {}) {
  if (!wamidSalida) throw new Error('acuse_de_transporte_ausente');
  if (outboxClave) {
    await db.query(
      `UPDATE agente_outbox
          SET estado = 'entregado', entregado_at = now(), wamid_salida = $2,
              carga = carga || jsonb_build_object('wamid_salida', $2::text)
        WHERE evento_clave = $1 AND estado IN ('pendiente', 'enviando', 'incierto')`,
      [outboxClave, wamidSalida]);
  }
  await acusarDialogoEnviado({ db, negocioId, telefono, dialogoId, texto, mensaje, wamidSalida });
}

/**
 * Si el acuse del diálogo se perdió DESPUÉS de que Meta aceptara (la base
 * falló en ese instante), la fila del outbox sí dice `entregado`. Al leer la
 * conversación se concilia: el diálogo cuya respuesta Meta aceptó cuenta como
 * enviado. En memoria; lo persiste el commit del turno.
 */
export async function conciliarDialogoEntregado(estado, { db = poolPorOmision, negocioId } = {}) {
  const d = estado?.dialogo;
  if (!d?.id || d.enviado) return false;
  const { rows: [fila] } = await db.query(
    `SELECT carga->>'texto' AS texto, wamid_salida, entregado_at FROM agente_outbox
      WHERE negocio_id = $1 AND tipo = 'respuesta_cliente' AND estado = 'entregado'
        AND carga->>'dialogo_id' = $2
      LIMIT 1`, [negocioId, String(d.id)]);
  if (!fila || !acusarDialogo(estado, d.id, fila.texto, { acusadoAt: fila.entregado_at || null })) return false;
  estado.dialogo.wamid = fila.wamid_salida || null;
  return true;
}

/**
 * EL DESPACHADOR. Recoge lo comprometido y no entregado (el proceso murió
 * entre el commit y el envío, o Meta rechazó) y lo entrega UNA vez:
 *   · primero, los arrendamientos vencidos pasan a `incierto` (no se sabe si
 *     salieron: revisión humana);
 *   · después reclama un lote (`FOR UPDATE SKIP LOCKED` + `enviando`): dos
 *     despachadores nunca toman la misma fila;
 *   · descarta lo superado por una respuesta más nueva y lo de conversaciones
 *     que tomó una persona (sin más: el cliente tiene la nueva, o ya lo
 *     atiende alguien) y lo VENCIDO, que sí pasa a una persona;
 *   · confirma, con su propio reclamo, cada paso a persona que haya quedado
 *     sin confirmar (de esta corrida, de otra o de un proceso que murió).
 */
export async function despacharRespuestasPendientes({
  db = poolPorOmision, enviar, registrarHistorial = null, alHumano = null, alIncierto = null,
  limite = 20, edadMaximaMin = 15, maxIntentos = 3, arrendamientoSeg = 120, arrendamientoHumanoSeg = 60,
  reclamador = `despachador-${process.pid}`,
} = {}) {
  if (typeof enviar !== 'function') throw new Error('despacharRespuestasPendientes necesita enviar');
  const aPersona = typeof alHumano === 'function' ? alHumano : alIncierto;
  const resumen = { colgadas: 0, tomadas: 0, entregadas: 0, descartadas: 0, fallidas: 0, reprogramadas: 0, inciertas: 0,
    vencidas: 0, humanasConfirmadas: 0, humanasPendientes: 0 };
  const contarHumana = (h) => {
    if (h === 'confirmada') resumen.humanasConfirmadas += 1;
    else if (h === 'pendiente' || h === 'sin_destino') resumen.humanasPendientes += 1;
  };

  const { rows: colgadas } = await db.query(
    `UPDATE agente_outbox
        SET estado = 'incierto',
            ultimo_error = 'arrendamiento_vencido: el emisor no registró el resultado del envío',
            humano_motivo = COALESCE(humano_motivo, $2::text),
            humano_solicitado_at = COALESCE(humano_solicitado_at, now())
      WHERE tipo = 'respuesta_cliente' AND estado = 'enviando'
        AND reclamado_at < now() - ($1 || ' seconds')::interval
      RETURNING id`, [String(arrendamientoSeg), MOTIVO_HUMANO.INCIERTA]);
  for (const c of colgadas) {
    resumen.colgadas += 1;
    console.error(`[AGENTE-OUTBOX] ALERTA arrendamiento_vencido fila=${c.id} — no se reenvía; revisión humana`);
  }

  // Todo paso a persona marcado y sin confirmar: el de las colgadas de arriba
  // y el que otro proceso no alcanzó a confirmar (o murió intentándolo).
  const { rows: porConfirmar } = await db.query(
    `SELECT id FROM agente_outbox
      WHERE tipo = 'respuesta_cliente' AND humano_motivo IS NOT NULL AND humano_confirmado_at IS NULL
        AND (humano_reclamado_at IS NULL OR humano_reclamado_at < now() - ($2 || ' seconds')::interval)
      ORDER BY humano_solicitado_at
      LIMIT $1`, [limite, String(arrendamientoHumanoSeg)]);
  for (const { id } of porConfirmar) {
    contarHumana((await confirmarEntregaHumana({ db, id, alHumano: aPersona,
      arrendamientoSeg: arrendamientoHumanoSeg })).estado);
  }

  const { rows } = await db.query(
    `WITH candidatas AS (
       SELECT id FROM agente_outbox
        WHERE tipo = 'respuesta_cliente' AND estado = 'pendiente' AND disponible_at <= now()
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED)
     UPDATE agente_outbox o
        SET estado = 'enviando', reclamado_at = now(), reclamado_por = $2, intentos = o.intentos + 1
       FROM candidatas c
      WHERE o.id = c.id
     RETURNING o.*`, [limite, reclamador]);
  resumen.tomadas = rows.length;

  for (const fila of rows) {
    // Cada fila por su cuenta: un error ANTES de llamar a Meta devuelve SOLO
    // esa fila a la cola y el lote sigue; uno DESPUÉS (ya se intentó enviar)
    // la deja como está: el barrido de arrendamientos la pasa a incierto,
    // nunca a reenvío.
    let seIntentoEnviar = false;
    try {
      seIntentoEnviar = await despacharFila(fila, () => { seIntentoEnviar = true; });
    } catch (e) {
      console.error(`[AGENTE-OUTBOX] error con la fila ${fila.id} (${seIntentoEnviar ? 'tras intentar enviar' : 'antes de enviar'}): ${e?.message}`);
      if (!seIntentoEnviar) {
        await db.query(
          `UPDATE agente_outbox SET estado = 'pendiente', reclamado_at = NULL, reclamado_por = NULL,
                  disponible_at = now() + interval '30 seconds'
            WHERE id = $1 AND estado = 'enviando' AND reclamado_por = $2`, [fila.id, reclamador]).catch(() => {});
        resumen.reprogramadas += 1;
      }
    }
  }
  return resumen;

  async function despacharFila(fila, alEnviar) {
    const carga = fila.carga || {};
    // `humanoMotivo` solo cuando el cliente se queda SIN respuesta: la marca
    // va en la misma sentencia que la saca de circulación.
    const descartar = async (motivo, humanoMotivo = null) => {
      const { rowCount } = await db.query(
        `UPDATE agente_outbox SET estado = 'descartado', ultimo_error = $2, reclamado_at = NULL, reclamado_por = NULL,
                humano_motivo = CASE WHEN $3::text IS NULL THEN humano_motivo ELSE COALESCE(humano_motivo, $3::text) END,
                humano_solicitado_at = CASE WHEN $3::text IS NULL THEN humano_solicitado_at
                                            ELSE COALESCE(humano_solicitado_at, now()) END
          WHERE id = $1 AND estado = 'enviando'`, [fila.id, motivo, humanoMotivo]);
      resumen.descartadas += 1;
      return rowCount;
    };
    // Primero lo que NO necesita a una persona: una respuesta más nueva de la
    // misma conversación la dejó sin objeto, o una persona ya la atiende.
    const { rows: [nueva] } = await db.query(
      `SELECT 1 FROM agente_outbox
        WHERE negocio_id = $1 AND conversacion_id = $2 AND tipo = 'respuesta_cliente'
          AND created_at > $3 AND id <> $4 LIMIT 1`,
      [fila.negocio_id, fila.conversacion_id, fila.created_at, fila.id]);
    if (nueva) { await descartar('respuesta_superada'); return false; }
    // «¿Ya la atiende una persona?»: la pausa manual, la revisión durable de
    // la conversación o el bot del negocio APAGADO (el interruptor maestro:
    // apagado, ninguna automatización responde, tampoco una respuesta que
    // quedó en cola). Si no se puede leer, no se envía a ciegas: la fila
    // vuelve a la cola y se decide en el siguiente ciclo.
    let atendida;
    let botApagado;
    try {
      const { rows: [c] } = await db.query(
        `SELECT (SELECT bot_pausado FROM conversaciones_control
                  WHERE negocio_id = $1 AND telefono = $2) IS TRUE
             OR (SELECT requiere_revision FROM whatsapp_conversaciones
                  WHERE negocio_id = $1 AND telefono = $2) IS TRUE AS atendida,
                (SELECT bot_whatsapp_activo FROM negocios WHERE id = $1) IS NOT TRUE AS bot_apagado`,
        [fila.negocio_id, carga.telefono]);
      atendida = c?.atendida === true;
      botApagado = c?.bot_apagado === true;
    } catch (e) {
      console.error(`[AGENTE-OUTBOX] no se pudo leer la atención humana fila=${fila.id}: ${e?.message} — se reintenta`);
      await db.query(
        `UPDATE agente_outbox SET estado = 'pendiente', reclamado_at = NULL, reclamado_por = NULL,
                disponible_at = now() + interval '30 seconds'
          WHERE id = $1 AND estado = 'enviando'`, [fila.id]).catch(() => {});
      resumen.reprogramadas += 1;
      return false;
    }
    if (atendida) { await descartar('atencion_humana'); return false; }
    if (botApagado) { await descartar('bot_apagado'); return false; }
    // Vencida: mandarla ahora llegaría fuera de contexto, y no mandarla deja
    // al cliente sin respuesta. Se descarta Y pasa a una persona.
    const { rows: [vieja] } = await db.query(
      `SELECT (created_at < now() - ($2 || ' minutes')::interval) AS vencida FROM agente_outbox WHERE id = $1`,
      [fila.id, String(edadMaximaMin)]);
    if (vieja?.vencida) {
      resumen.vencidas += 1;
      console.error(`[AGENTE-OUTBOX] ALERTA respuesta_vencida fila=${fila.id} — no se envía; pasa a una persona`);
      if (await descartar('respuesta_vencida', MOTIVO_HUMANO.VENCIDA)) {
        contarHumana((await confirmarEntregaHumana({ db, id: fila.id, alHumano: aPersona,
          arrendamientoSeg: arrendamientoHumanoSeg })).estado);
      }
      return false;
    }

    // El arrendamiento se renueva JUSTO antes de enviar: si otra corrida ya
    // barrió esta fila (a incierto, con su aviso de «no se reenvió») mientras
    // esta procesaba el lote, no se envía.
    const { rowCount: sigueSiendoMia } = await db.query(
      `UPDATE agente_outbox SET reclamado_at = now()
        WHERE id = $1 AND estado = 'enviando' AND reclamado_por = $2`, [fila.id, reclamador]);
    if (!sigueSiendoMia) {
      console.error(`[AGENTE-OUTBOX] fila=${fila.id} ya no es de ${reclamador} (otra corrida la tomó): no se envía`);
      return false;
    }
    alEnviar();
    const r = await entregarRespuesta({ db, fila, enviar, registrarHistorial, alHumano: aPersona, maxIntentos,
      arrendamientoHumanoSeg, politicaRechazo: 'reintentar' });
    if (r.estado === 'entregado') resumen.entregadas += 1;
    else if (r.estado === 'reintentar') resumen.reprogramadas += 1;
    else if (r.estado === 'fallido') resumen.fallidas += 1;
    else if (r.estado === 'incierto') resumen.inciertas += 1;
    if (r.humano) contarHumana(r.humano);
    return true;
  }
}
