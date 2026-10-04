/**
 * vencimientoPausasWhatsapp.js — una pausa del bot no puede ser eterna.
 *
 * P3 (3-oct-2026): Obispado acumulaba 63 conversaciones con el bot en pausa.
 * Nadie las iba a quitar: el botón del panel depende de que alguien se
 * acuerde, y soltar() (whatsappContinuidad.js) solo libera tres dudas de
 * catálogo. El cliente que escribía días después no recibía nada.
 *
 * Este job, cada 5 minutos y solo en los negocios con la bandera
 * `whatsapp_pausa_vence_horas`, devuelve al bot las pausas que llevan esas
 * horas sin un mensaje del personal. La DECISIÓN vive en pausaVencePolitica.js
 * (pura y probada sin base); aquí está la lectura, el candado y la escritura.
 *
 * Igual que rescateConversaciones.js: corre en segundo plano, nunca en el
 * camino del webhook, recibe sus efectos (panel y WhatsApp) por parámetro y
 * NUNCA lanza. No toca whatsapp-meta.js: sus chequeos de pausa leen
 * `conversaciones_control` y `whatsapp_conversaciones`, que es justo lo que
 * esto escribe, así que el siguiente mensaje del cliente ya pasa solo.
 */
import { pool as poolApp, obtenerConfiguracion } from './database.js';
import { estadoNuevo } from '../mesero-agente/ejecutorDeHerramientas.js';
import {
  CLAVE_HORAS, CLAVE_MANUALES, CLAVE_SIMULAR, CLAVE_SIN_ATENDER, CLAVE_AVISO_WHATSAPP,
  VENTANA_CLIENTE_HORAS, decidirVencimiento, opcionesDeConfiguracion,
  telefonoEnmascarado, textoDelResumen,
} from './pausaVencePolitica.js';

export const MAX_APLICADAS_POR_CORRIDA = 50;
// Se LEEN muchas más de las que se aplican: una pausa retenida para siempre
// (dinero, efecto incierto) no puede ocupar el lugar de una que sí vence.
const MAX_LEIDAS_POR_CORRIDA = 500;
// Ventana para buscar lo que el agente anotó alrededor del traspaso: el
// aviso a la persona sale ANTES del commit del turno, así que el outbox y la
// traza del turno pueden quedar unos segundos antes o después de la revisión.
const MARGEN_EVIDENCIA_MIN = 30;

// La clave del candado es la MISMA cadena que usan ejecutar(), soltar() y el
// botón /reactivar (`wa:${n}:${t}`, whatsappContinuidad.js): mientras un turno
// del bot está en vuelo, o una persona devuelve la conversación, esto espera
// a la siguiente corrida.
export const claveDelCandado = (negocioId, telefono) => `wa:${negocioId}:${telefono}`;

// Todas las edades se calculan AQUÍ, con now() de PostgreSQL y el pool de la
// app: `mensajes.timestamp` es TIMESTAMP sin zona y leerlo desde JS lo corre
// de hora. La consulta solo MIDE; decide pausaVencePolitica.js.
//
// $1 negocio (o NULL = todos los que tienen la bandera), $2 teléfono (o NULL),
// $3 límite. Con $1 y $2 es la relectura dentro de la transacción.
export const SQL_CANDIDATAS = `
WITH banderas AS (
  SELECT n.id AS negocio_id, n.slug, n.bot_whatsapp_activo,
         h.valor AS cfg_horas,
         (SELECT c.valor FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = '${CLAVE_MANUALES}') AS cfg_manuales,
         (SELECT c.valor FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = '${CLAVE_SIMULAR}') AS cfg_simular,
         (SELECT c.valor FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = '${CLAVE_SIN_ATENDER}') AS cfg_sin_atender,
         (SELECT c.valor FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = '${CLAVE_AVISO_WHATSAPP}') AS cfg_aviso_whatsapp,
         (SELECT c.valor FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = 'bot_revision_minutos') AS minutos_soltar
    FROM negocios n
    JOIN configuracion h ON h.negocio_id = n.id AND h.clave = '${CLAVE_HORAS}'
   WHERE btrim(h.valor) <> '' AND ($1::uuid IS NULL OR n.id = $1::uuid)
),
pausas AS (
  SELECT cc.negocio_id, cc.telefono::text AS telefono
    FROM conversaciones_control cc JOIN banderas b ON b.negocio_id = cc.negocio_id
   WHERE cc.bot_pausado AND ($2::text IS NULL OR cc.telefono = $2::text)
  UNION
  -- Revisión SIN pausa: setBotPausado falló (alRevision lo ignora) o la
  -- revisión llegó por una puerta que no pausa (REENTREGA_LEGADA). Bloquean
  -- al bot igual (ejecutar se salta las conversaciones en revisión).
  SELECT w.negocio_id, w.telefono
    FROM whatsapp_conversaciones w JOIN banderas b ON b.negocio_id = w.negocio_id
   WHERE w.requiere_revision AND ($2::text IS NULL OR w.telefono = $2::text)
),
-- Un solo recorrido por corrida, no uno por conversación: whatsapp_entradas
-- no tiene índice por teléfono, y solo importa lo de la ventana de Meta.
entradas_recientes AS (
  SELECT e.negocio_id, e.telefono, max(e.recibido_at) AS ultimo_entrante
    FROM whatsapp_entradas e JOIN banderas b ON b.negocio_id = e.negocio_id
   WHERE e.recibido_at > now() - interval '${VENTANA_CLIENTE_HORAS + 1} hours'
     AND ($2::text IS NULL OR e.telefono = $2::text)
   GROUP BY e.negocio_id, e.telefono
),
-- Lo abierto sí tiene índice parcial (whatsapp_entradas_pendientes).
entradas_abiertas AS (
  SELECT e.negocio_id, e.telefono,
         count(*) FILTER (WHERE e.estado = 'pendiente') AS pendientes,
         count(*) FILTER (WHERE e.estado = 'procesando') AS procesando
    FROM whatsapp_entradas e JOIN banderas b ON b.negocio_id = e.negocio_id
   WHERE e.estado IN ('pendiente', 'procesando') AND ($2::text IS NULL OR e.telefono = $2::text)
   GROUP BY e.negocio_id, e.telefono
),
-- La última acción del panel sobre cada teléfono: «Tomar conversación» es la
-- evidencia de que la pausa la puso una persona aunque el bot haya escrito
-- updated_by = NULL encima.
auditoria AS (
  SELECT DISTINCT ON (a.negocio_id, a.estado_nuevo->>'telefono')
         a.negocio_id, a.estado_nuevo->>'telefono' AS telefono, a.accion
    FROM auditoria_plataforma a JOIN banderas b ON b.negocio_id = a.negocio_id
   WHERE a.accion IN ('tomar_conversacion', 'devolver_conversacion_bot')
     AND ($2::text IS NULL OR a.estado_nuevo->>'telefono' = $2::text)
   ORDER BY a.negocio_id, a.estado_nuevo->>'telefono', a.created_at DESC
),
-- Pedidos que esperan el pago con enlace: hay dinero en curso con ese cliente.
-- También las reservas programadas: esperan el pago con
-- datos.estado = 'pendiente_pago' y activado = FALSE hasta que pagan o el
-- enlace vence (database.js, vencimiento del intento de pago).
pendientes_pago AS (
  SELECT pa.negocio_id, right(regexp_replace(x.tel, '\\D', '', 'g'), 10) AS tel10
    FROM pedidos_activos pa JOIN banderas b ON b.negocio_id = pa.negocio_id
   CROSS JOIN LATERAL (VALUES (pa.datos->'cliente'->>'telefono'), (pa.datos->>'telefono_conversacion')) x(tel)
   WHERE pa.estado = 'pendiente_pago' AND x.tel IS NOT NULL
  UNION
  SELECT pr.negocio_id, right(regexp_replace(x.tel, '\\D', '', 'g'), 10) AS tel10
    FROM pedidos_programados pr JOIN banderas b ON b.negocio_id = pr.negocio_id
   CROSS JOIN LATERAL (VALUES (pr.datos->'cliente'->>'telefono'), (pr.datos->>'telefono_conversacion')) x(tel)
   WHERE pr.activado = FALSE AND COALESCE(pr.datos->>'estado', '') = 'pendiente_pago' AND x.tel IS NOT NULL
)
SELECT p.negocio_id, p.telefono,
       b.bot_whatsapp_activo, b.cfg_horas, b.cfg_manuales, b.cfg_simular, b.cfg_sin_atender,
       b.cfg_aviso_whatsapp, b.minutos_soltar,
       COALESCE(cc.bot_pausado, false) AS bot_pausado, cc.updated_by, cc.updated_at AS pausado_desde,
       -- La identidad de la fila de control en texto (un Date de JS pierde los
       -- microsegundos): el UPDATE de aplicar() se condiciona a ella. NULL =
       -- no había fila.
       cc.updated_at::text AS control_marca,
       COALESCE(w.requiere_revision, false) AS requiere_revision, w.motivo, w.revision,
       w.actualizado_at AS revision_desde,
       -- Identidad de ESTA pausa (deduplica la simulación) y huella completa
       -- (verificación optimista entre la lectura y la transacción).
       concat_ws('|', COALESCE(cc.updated_at::text, '-'), COALESCE(w.revision::text, '-'),
                 COALESCE(w.actualizado_at::text, '-')) AS identidad_pausa,
       concat_ws('|', COALESCE(cc.bot_pausado::text, '-'), COALESCE(cc.updated_by::text, '-'),
                 COALESCE(cc.updated_at::text, '-'), COALESCE(w.requiere_revision::text, '-'),
                 COALESCE(w.motivo, '-'), COALESCE(w.revision::text, '-'),
                 COALESCE(w.actualizado_at::text, '-')) AS huella,
       au.accion AS ultima_accion,
       (cc.updated_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM agente_solicitudes_servicio s
           WHERE s.negocio_id = p.negocio_id AND s.telefono = p.telefono
             AND s.created_at BETWEEN cc.updated_at - interval '2 minutes' AND cc.updated_at + interval '2 minutes'
       )) AS solicitud_servicio,
       COALESCE(cl.human_takeover_until > now(), false) AS takeover_vigente,
       COALESCE(ea.pendientes, 0)::int AS entradas_pendientes,
       COALESCE(ea.procesando, 0)::int AS entradas_procesando,
       mh.ultimo_humano::timestamptz AS ultimo_humano,
       GREATEST(er.ultimo_entrante, mh.ultimo_entrante::timestamptz) AS ultimo_cliente,
       COALESCE(GREATEST(er.ultimo_entrante, mh.ultimo_entrante::timestamptz)
                  > COALESCE(mh.ultimo_humano::timestamptz, '-infinity'::timestamptz)
                AND GREATEST(er.ultimo_entrante, mh.ultimo_entrante::timestamptz)
                  > now() - interval '${VENTANA_CLIENTE_HORAS} hours', false) AS cliente_esperando,
       COALESCE(w.requiere_revision AND mh.ultimo_humano::timestamptz > w.actualizado_at, false) AS humano_tras_revision,
       COALESCE(mh.ultimo_humano::timestamptz >= COALESCE(
                  CASE WHEN w.requiere_revision THEN w.actualizado_at END, cc.updated_at), false) AS humano_tras_pausa,
       -- Desde el último hecho del PERSONAL: el inicio de la pausa, el de la
       -- revisión, su último mensaje (panel, documento o eco de la Business
       -- App) o el último eco registrado del takeover.
       EXTRACT(EPOCH FROM (now() - GREATEST(
           CASE WHEN cc.bot_pausado THEN cc.updated_at END,
           CASE WHEN w.requiere_revision THEN w.actualizado_at END,
           mh.ultimo_humano::timestamptz,
           cl.last_business_app_message_at::timestamptz))) / 3600.0 AS horas_sin_personal,
       COALESCE(ag.estado->>'confirmacionIncierta' = 'true', false) AS confirmacion_incierta,
       -- Una confirmar_pedido sin resultado conocido de esta conversación. La
       -- reserva del libro es durable y anterior al efecto; la marca de
       -- arriba vive en el estado del turno y se pierde si su commit falla
       -- (AGENTE_NO_PUDO_ATENDER). Cuenta la del ciclo vigente del agente
       -- (sea cual sea su fecha: su índice único sigue bloqueando ese ciclo)
       -- y cualquier otra de este teléfono desde el inicio de esta pausa.
       EXISTS (
         SELECT 1 FROM agente_operaciones op
          WHERE op.negocio_id = p.negocio_id
            AND op.herramienta = 'confirmar_pedido' AND op.estado IN ('pendiente', 'error')
            AND (op.conversacion_id = 'agente:' || p.telefono
                 OR starts_with(op.conversacion_id, 'agente:' || p.telefono || ':'))
            AND (op.conversacion_id = ag.estado->>'conversacionId'
                 OR op.created_at >= COALESCE(
                      CASE WHEN w.requiere_revision THEN w.actualizado_at END, cc.updated_at, now())
                      - interval '${MARGEN_EVIDENCIA_MIN} minutes')
       ) AS confirmacion_sin_resultado,
       ag.estado->'handoff'->>'motivo' AS handoff_motivo,
       ev.motivos AS motivos_agente,
       EXISTS (SELECT 1 FROM pendientes_pago pp
                WHERE pp.negocio_id = p.negocio_id AND pp.tel10 <> ''
                  AND pp.tel10 = right(regexp_replace(p.telefono, '\\D', '', 'g'), 10)) AS pedido_esperando_pago,
       COALESCE(NULLIF(btrim(cl.nombre), ''), mh.nombre) AS nombre
  FROM pausas p
  JOIN banderas b ON b.negocio_id = p.negocio_id
  LEFT JOIN conversaciones_control cc ON cc.negocio_id = p.negocio_id AND cc.telefono = p.telefono
  LEFT JOIN whatsapp_conversaciones w ON w.negocio_id = p.negocio_id AND w.telefono = p.telefono
  LEFT JOIN entradas_recientes er ON er.negocio_id = p.negocio_id AND er.telefono = p.telefono
  LEFT JOIN entradas_abiertas ea ON ea.negocio_id = p.negocio_id AND ea.telefono = p.telefono
  LEFT JOIN auditoria au ON au.negocio_id = p.negocio_id AND au.telefono = p.telefono
  -- Mismo criterio de dueño que getTakeoverHumanoActivo: la excepción legada
  -- con negocio NULL es SOLO de nonna-maye.
  LEFT JOIN LATERAL (
    SELECT c.human_takeover_until, c.last_business_app_message_at, c.nombre
      FROM clientes c
     WHERE c.telefono = p.telefono
       AND (c.negocio_id = p.negocio_id OR (b.slug = 'nonna-maye' AND c.negocio_id IS NULL))
     LIMIT 1) cl ON true
  LEFT JOIN LATERAL (
    SELECT max(m."timestamp") FILTER (WHERE m.direccion = 'saliente' AND m.origen = 'humano') AS ultimo_humano,
           max(m."timestamp") FILTER (WHERE m.direccion = 'entrante') AS ultimo_entrante,
           (array_agg(m.nombre ORDER BY m.id DESC)
              FILTER (WHERE m.direccion = 'entrante' AND COALESCE(btrim(m.nombre), '') <> ''))[1] AS nombre
      FROM mensajes m
     WHERE m.negocio_id = p.negocio_id AND m.telefono = p.telefono) mh ON true
  LEFT JOIN conversacion_estado ag ON ag.negocio_id = p.negocio_id AND ag.session_id = 'agente:' || p.telefono
  -- Lo que el AGENTE anotó alrededor de esta pausa: el motivo de cada paso a
  -- persona del outbox, el de cada traspaso y el de la traza del turno. La
  -- revisión solo guarda el PRIMERO; aquí aparece también el que llegó después.
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT z.motivo) FILTER (WHERE z.motivo IS NOT NULL) AS motivos
      FROM (
        SELECT o.humano_motivo AS motivo
          FROM agente_outbox o
         WHERE o.negocio_id = p.negocio_id
           AND (o.conversacion_id = 'agente:' || p.telefono OR o.carga->>'telefono' = p.telefono)
           AND o.humano_motivo IS NOT NULL
           AND COALESCE(o.humano_solicitado_at, o.created_at) >= COALESCE(
                 CASE WHEN w.requiere_revision THEN w.actualizado_at END, cc.updated_at, now())
                 - interval '${MARGEN_EVIDENCIA_MIN} minutes'
        UNION ALL
        SELECT o.carga->>'motivo'
          FROM agente_outbox o
         WHERE o.negocio_id = p.negocio_id AND o.tipo = 'handoff'
           AND (o.conversacion_id = 'agente:' || p.telefono OR o.carga->>'telefono' = p.telefono)
           AND o.created_at >= COALESCE(
                 CASE WHEN w.requiere_revision THEN w.actualizado_at END, cc.updated_at, now())
                 - interval '${MARGEN_EVIDENCIA_MIN} minutes'
        UNION ALL
        SELECT t.motivo_handoff
          FROM agente_turnos t
         WHERE t.negocio_id = p.negocio_id
           AND (t.conversacion_id = 'agente:' || p.telefono OR t.conversacion_id LIKE 'agente:' || p.telefono || ':%')
           AND t.motivo_handoff IS NOT NULL
           AND t.created_at >= COALESCE(
                 CASE WHEN w.requiere_revision THEN w.actualizado_at END, cc.updated_at, now())
                 - interval '${MARGEN_EVIDENCIA_MIN} minutes'
      ) z) ev ON true
 ORDER BY horas_sin_personal DESC NULLS LAST, p.negocio_id, p.telefono
 LIMIT $3`;

export async function leerCandidatas(db, { negocioId = null, telefono = null, limite = MAX_LEIDAS_POR_CORRIDA } = {}) {
  const { rows } = await db.query(SQL_CANDIDATAS, [negocioId, telefono, limite]);
  return rows;
}

const opcionesDeFila = (f) => opcionesDeConfiguracion({
  [CLAVE_HORAS]: f.cfg_horas, [CLAVE_MANUALES]: f.cfg_manuales,
  [CLAVE_SIMULAR]: f.cfg_simular, [CLAVE_SIN_ATENDER]: f.cfg_sin_atender,
  [CLAVE_AVISO_WHATSAPP]: f.cfg_aviso_whatsapp,
});

const SQL_REGISTRO = `
  INSERT INTO conversaciones_pausa_vencimientos
    (negocio_id, telefono, modo, origen_pausa, pausado_por, pausado_desde, requeria_revision,
     motivo_revision, motivo_agente, atendida_por_humano, ultimo_mensaje_personal,
     ultimo_mensaje_cliente, horas_configuradas, horas_sin_personal, revision_nueva,
     identidad_pausa, aviso)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`;

function valoresDelRegistro(f, d, horas, modo, revisionNueva, aviso) {
  return [f.negocio_id, f.telefono, modo, d.origen,
    // Solo se atribuye a quien la pausó si de verdad la pausó una persona.
    d.origen === 'manual' ? (f.updated_by || null) : null,
    f.pausado_desde || null, f.requiere_revision === true, f.motivo || null,
    f.handoff_motivo ? String(f.handoff_motivo).slice(0, 200) : null,
    f.humano_tras_pausa === true, f.ultimo_humano || null, f.ultimo_cliente || null,
    horas, f.horas_sin_personal == null ? null : Number(f.horas_sin_personal), revisionNueva,
    f.identidad_pausa, aviso];
}

/**
 * Modo simular: la bitácora y el log, NADA más. Como mucho una fila por
 * identidad de pausa: cada 5 minutos la misma candidata no puede sumar otra
 * (con 63 serían ~18 000 filas al día que esconderían lo que importa).
 */
async function simular(db, f, d, horas, log) {
  const { rowCount } = await db.query(
    `${SQL_REGISTRO} ON CONFLICT (negocio_id, telefono, modo, identidad_pausa) DO NOTHING`,
    valoresDelRegistro(f, d, horas, 'simulado', null, 'no_aplica'));
  if (rowCount) {
    log(`[PAUSA-VENCE] modo=simulado negocio=${f.negocio_id} telefono=${telefonoEnmascarado(f.telefono)} `
      + `origen=${d.origen} motivo=${f.motivo || '-'} horas=${Math.floor(Number(f.horas_sin_personal))}`);
  }
  return rowCount > 0;
}

/**
 * Libera UNA conversación, con la MISMA semántica que «Revisé y atendí»
 * (server.js, cambiarAtencionConversacion): entradas en revisión o pendientes
 * a 'revisado' (nunca se reprocesan: podría registrarse dos veces un pedido),
 * revisión fuera con su número +1, sesión legada borrada y el estado del
 * agente reiniciado con una identidad de libro nueva. Ese reinicio solo es
 * seguro porque la política ya descartó `confirmacionIncierta` y todo motivo
 * de dinero; se vuelve a comprobar DENTRO de la transacción.
 *
 * Devuelve { ok, razon, revisionNueva, fila, decision }.
 *
 * `dentroDeLaTransaccion(fila, cliente)` existe solo para las pruebas de
 * concurrencia: corre con la transacción abierta, después de la nueva
 * decisión y antes de escribir, que es la ventana que cubren los FOR UPDATE.
 */
async function aplicar(db, f, log, { dentroDeLaTransaccion = null } = {}) {
  const cliente = await db.connect();
  const cambio = async () => { await cliente.query('ROLLBACK'); return { ok: false, razon: 'la_pausa_cambio' }; };
  try {
    await cliente.query('BEGIN');
    const { rows: [candado] } = await cliente.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', [claveDelCandado(f.negocio_id, f.telefono)]);
    if (!candado.ok) { await cliente.query('ROLLBACK'); return { ok: false, razon: 'candado_ocupado' }; }
    // «Tomar conversación» y `recibir` (whatsappContinuidad.js) NO toman el
    // candado advisory: lo que los serializa con esto es el bloqueo de estas
    // dos filas, ANTES de volver a decidir. Sin el de whatsapp_conversaciones,
    // un mensaje que llegue ahora se marcaría 'revisado' sin que nadie lo
    // viera; sin el de conversaciones_control, esto pisaría un «Tomar».
    await cliente.query('SELECT 1 FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE',
      [f.negocio_id, f.telefono]);
    await cliente.query('SELECT 1 FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE',
      [f.negocio_id, f.telefono]);
    const [fresca] = await leerCandidatas(cliente, { negocioId: f.negocio_id, telefono: f.telefono, limite: 1 });
    // Verificación optimista: si la pausa cambió entre la lectura y ahora
    // (alguien la tomó, la devolvió o el bot la volvió a escalar), no se toca.
    if (!fresca || fresca.huella !== f.huella) return await cambio();
    const opciones = opcionesDeFila(fresca);
    const d = decidirVencimiento(fresca, opciones);
    if (!d.vence || opciones.simular) { await cliente.query('ROLLBACK'); return { ok: false, razon: d.vence ? 'ahora_simula' : d.razon }; }
    if (dentroDeLaTransaccion) await dentroDeLaTransaccion(fresca, cliente);

    // La fila de control, condicionada a la identidad que se acaba de leer.
    // Si existía, el FOR UPDATE ya la protege y esto es una segunda barrera.
    // Si NO existía (revisión sin pausa), el FOR UPDATE no bloqueó nada y
    // «Tomar» pudo insertarla entre la relectura y aquí: entonces gana la
    // persona y no se toca nada.
    if (fresca.control_marca == null) {
      const { rows: [creada] } = await cliente.query(
        'SELECT 1 FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE', [f.negocio_id, f.telefono]);
      if (creada) return await cambio();
    } else {
      // updated_by NULL: la quitó el sistema, no una persona (la bitácora
      // dice quién la había puesto).
      const { rowCount } = await cliente.query(`UPDATE conversaciones_control
          SET bot_pausado=false, updated_by=NULL, updated_at=now()
        WHERE negocio_id=$1 AND telefono=$2 AND updated_at::text = $3`,
      [f.negocio_id, f.telefono, fresca.control_marca]);
      if (rowCount !== 1) return await cambio();
    }

    let revisionNueva = null;
    if (fresca.requiere_revision) {
      await cliente.query(`UPDATE whatsapp_entradas SET estado='revisado', actualizado_at=now()
         WHERE negocio_id=$1 AND telefono=$2 AND estado IN ('revision','pendiente')`, [f.negocio_id, f.telefono]);
      const { rows: [w] } = await cliente.query(`UPDATE whatsapp_conversaciones
          SET requiere_revision=false, motivo=NULL, revision=revision+1, actualizado_at=now()
        WHERE negocio_id=$1 AND telefono=$2 RETURNING revision`, [f.negocio_id, f.telefono]);
      if (w?.revision === undefined) throw new Error('CONVERSACION_REVISION_AUSENTE');
      revisionNueva = Number(w.revision);
      await cliente.query('DELETE FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',
        [f.negocio_id, `meta-${f.negocio_id}-${f.telefono}`]);
      const { rows: [agente] } = await cliente.query(
        `SELECT estado->>'confirmacionIncierta' = 'true' AS incierta FROM conversacion_estado
          WHERE negocio_id=$1 AND session_id=$2 FOR UPDATE`, [f.negocio_id, `agente:${f.telefono}`]);
      if (agente?.incierta === true) throw new Error('CONFIRMACION_INCIERTA_NO_SE_REINICIA');
      const reiniciado = estadoNuevo({ negocioId: f.negocio_id, conversacionId: `agente:${f.telefono}:r${revisionNueva}` });
      await cliente.query(
        `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
         VALUES ($1,$2,$3::jsonb,1)
         ON CONFLICT (negocio_id, session_id) DO UPDATE
           SET estado=EXCLUDED.estado, revision=conversacion_estado.revision+1, actualizado_at=now()`,
        [f.negocio_id, `agente:${f.telefono}`, JSON.stringify(reiniciado)]);
    }
    const { rows: [registro] } = await cliente.query(`${SQL_REGISTRO} RETURNING id`,
      valoresDelRegistro(fresca, d, opciones.horas, 'aplicado', revisionNueva, 'pendiente'));
    await cliente.query('COMMIT');
    return { ok: true, razon: 'vence', revisionNueva, fila: fresca, decision: d, registroId: registro.id,
      horas: opciones.horas, avisoWhatsapp: opciones.avisoWhatsapp };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    log(`[PAUSA-VENCE] no se pudo devolver al bot negocio=${f.negocio_id} telefono=${telefonoEnmascarado(f.telefono)}: ${e.message}`);
    return { ok: false, razon: 'error' };
  } finally {
    cliente.release();
  }
}

/**
 * Una corrida. Nunca lanza: un fallo suyo no puede tumbar el intervalo ni
 * tocar una conversación a medias (cada liberación es su propia transacción).
 *
 * `antesDeAplicar(fila)` y `dentroDeLaTransaccion(fila, cliente)` existen solo
 * para las pruebas de carrera: el primero corre entre la lectura y la
 * transacción; el segundo, con la transacción abierta y las filas bloqueadas.
 */
export async function vencerPausasWhatsapp({
  db = poolApp,
  broadcastPanel = null,
  enviarAvisoWhatsapp = null,
  log = console.warn,
  negocioId = null,
  maxAplicadas = MAX_APLICADAS_POR_CORRIDA,
  antesDeAplicar = null,
  dentroDeLaTransaccion = null,
} = {}) {
  const resumen = { candidatas: 0, aplicadas: 0, simuladas: 0, retenidas: {}, avisos: {} };
  let filas;
  try {
    filas = await leerCandidatas(db, { negocioId });
  } catch (e) {
    log(`[PAUSA-VENCE] no se pudieron leer las pausas (no afecta al bot): ${e.message}`);
    return resumen;
  }
  resumen.candidatas = filas.length;
  const liberadasPorNegocio = new Map();
  const retener = (razon) => { resumen.retenidas[razon] = (resumen.retenidas[razon] || 0) + 1; };

  for (const f of filas) {
    const opciones = opcionesDeFila(f);
    const d = decidirVencimiento(f, opciones);
    if (!d.vence) { retener(d.razon); continue; }
    try {
      if (opciones.simular) {
        if (await simular(db, f, d, opciones.horas, log)) resumen.simuladas++;
        continue;
      }
      if (resumen.aplicadas >= maxAplicadas) { retener('tope_por_corrida'); continue; }
      if (antesDeAplicar) await antesDeAplicar(f);
      const r = await aplicar(db, f, log, { dentroDeLaTransaccion });
      if (!r.ok) { retener(r.razon); continue; }
      resumen.aplicadas++;
      log(`[PAUSA-VENCE] modo=aplicado negocio=${f.negocio_id} telefono=${telefonoEnmascarado(f.telefono)} `
        + `origen=${r.decision.origen} motivo=${r.fila.motivo || '-'} horas=${Math.floor(Number(r.fila.horas_sin_personal))}`);
      // El mismo aviso que alLiberar (whatsapp-meta.js): el panel ya escucha
      // `bot_pausado` y vuelve a leer /estado-bot del chat abierto.
      if (broadcastPanel) {
        try {
          broadcastPanel(f.negocio_id, { tipo: 'bot_pausado', telefono: f.telefono, pausado: false, requiereRevision: false, motivo: null });
        } catch (e) { log(`[PAUSA-VENCE] panel: ${e.message}`); }
      }
      const lista = liberadasPorNegocio.get(f.negocio_id) || { horas: r.horas, avisoWhatsapp: r.avisoWhatsapp, filas: [] };
      lista.filas.push({ registroId: r.registroId, telefono: f.telefono, nombre: r.fila.nombre,
        origen: r.decision.origen, motivo: r.fila.motivo, horas_sin_personal: r.fila.horas_sin_personal });
      liberadasPorNegocio.set(f.negocio_id, lista);
    } catch (e) {
      retener('error');
      log(`[PAUSA-VENCE] conversación ${telefonoEnmascarado(f.telefono)}: ${e.message}`);
    }
  }

  // El aviso que vale es la bitácora (113) y /estado-bot: el dueño revisa al
  // entrar al sistema. El resumen por WhatsApp al encargado es OPCIONAL
  // (whatsapp_pausa_vence_aviso_whatsapp), uno por negocio y corrida.
  // 'aceptado' solo dice que Meta aceptó el envío, NO que llegó: fuera de la
  // ventana de 24 h el rechazo de un texto libre llega después, por el
  // webhook de estados, y aquí no se ve.
  for (const [nid, { horas, avisoWhatsapp, filas: liberadas }] of liberadasPorNegocio) {
    let aviso = 'no_aplica';
    if (avisoWhatsapp && enviarAvisoWhatsapp) {
      try {
        const cfg = await obtenerConfiguracion(nid);
        if (!cfg?.wa_admin_numero) aviso = 'sin_numero';
        else {
          const r = await enviarAvisoWhatsapp(cfg.wa_admin_numero, textoDelResumen(liberadas, horas), nid);
          aviso = r === false ? 'fallido' : 'aceptado';
        }
      } catch (e) {
        aviso = 'fallido';
        log(`[PAUSA-VENCE] resumen por WhatsApp: ${e.message}`);
      }
    }
    resumen.avisos[aviso] = (resumen.avisos[aviso] || 0) + liberadas.length;
    await db.query(`UPDATE conversaciones_pausa_vencimientos SET aviso=$2 WHERE id = ANY($1::bigint[])`,
      [liberadas.map((l) => l.registroId), aviso]).catch((e) => log(`[PAUSA-VENCE] bitácora del aviso: ${e.message}`));
  }

  if (resumen.aplicadas || resumen.simuladas) {
    log(`[PAUSA-VENCE] corrida candidatas=${resumen.candidatas} aplicadas=${resumen.aplicadas} `
      + `simuladas=${resumen.simuladas} retenidas=${JSON.stringify(resumen.retenidas)}`);
  }
  return resumen;
}
