// Avisos al personal para revisiones pendientes, incluso si la queja llegó
// DESPUÉS de que el bot quedó pausado. Nunca responde al cliente ni modifica
// pedidos, pagos, pausas o el takeover. Apagado por negocio hasta su activación.
import { pool } from './database.js';
import { evaluarHorarioLocal } from './horarioSemanal.js';
import { prioridadDeAtencion, instruccionesDeAtencion } from '../mesero-agente/incidenciasAtencion.js';
import { referenciaDeConversacion } from './avisoRescateHumano.js';
import { telefonoEnmascarado } from './rescateConversaciones.js';
import { esCierreTrasPersonal } from '../mesero-agente/recepcionista.js';

export const BANDERA_SEGUIMIENTO = 'whatsapp_seguimiento_atencion_v1';
export const DESDE_SEGUIMIENTO = 'whatsapp_seguimiento_atencion_desde';

export function horarioDeAtencion(cfg, ahora = new Date()) {
  try {
    const reglas = JSON.parse(cfg.reglas_atencion);
    const zona = cfg.timezone;
    if (!zona || !reglas?.horarios) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ahora).map(x => [x.type, x.value]));
    const e = evaluarHorarioLocal(reglas, `${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute));
    return e.horarioInvalido ? null : e;
  } catch { return null; }
}

export function decidirRecordatorio(fila, ahora = new Date()) {
  const cfg = fila.cfg || {};
  const desde = Date.parse(cfg[DESDE_SEGUIMIENTO]);
  if (cfg[BANDERA_SEGUIMIENTO] !== 'true' || !Number.isFinite(desde) || desde > ahora.getTime()) return null;
  const horario = horarioDeAtencion(cfg, ahora);
  if (!horario) return null;
  const prioridad = prioridadDeAtencion(fila.motivo, fila.texto);
  // Solo omitir acuses posteriores a una respuesta humana. Un «gracias» tras
  // pedir ayuda al bot sigue siendo un pendiente real. Las urgencias ganan.
  if (prioridad === 'normal' && fila.ultimo_humano_id
    && esCierreTrasPersonal(fila.texto)) return null;
  // Fuera de horario solo las incidencias urgentes: al abrir también se
  // avisan las solicitudes normales que esperan 5 min. Son dos fases distintas.
  if (!horario.abierto && prioridad !== 'urgente') return null;
  if (horario.abierto && prioridad === 'normal' && Number(fila.segundos) < 300) return null;
  return { fase: horario.abierto ? 'abierto' : 'cerrado', prioridad,
    instruccion: instruccionesDeAtencion(fila.motivo, { fueraHorario: !horario.abierto, prioridad }) };
}

export async function buscarPendientesAtencion(db) {
  const { rows } = await db.query(`
    WITH negocios_activos AS (
      SELECT c.negocio_id, jsonb_object_agg(c.clave,c.valor) cfg
      FROM configuracion c
      WHERE EXISTS(SELECT 1 FROM configuracion b WHERE b.negocio_id=c.negocio_id
        AND b.clave=$1 AND b.valor='true')
      GROUP BY c.negocio_id
    )
    SELECT w.negocio_id,w.telefono,w.motivo,n.cfg,h.id ultimo_humano_id,
           min(m.id) mensaje_id,
           EXTRACT(EPOCH FROM (now() - (min(m.timestamp) AT TIME ZONE 'UTC'))) segundos,
           left(string_agg(left(m.texto,500),E'\n' ORDER BY m.id DESC),6000) texto
    FROM whatsapp_conversaciones w JOIN negocios_activos n ON n.negocio_id=w.negocio_id
    JOIN LATERAL (SELECT max(h.id) id FROM mensajes h WHERE h.negocio_id=w.negocio_id
      AND h.telefono=w.telefono AND h.direccion='saliente' AND h.origen='humano') h ON true
    JOIN mensajes m ON m.negocio_id=w.negocio_id AND m.telefono=w.telefono
      AND m.direccion='entrante' AND m.id>COALESCE(h.id,0)
      AND m.timestamp>=now() AT TIME ZONE 'UTC' - interval '48 hours'
      AND m.timestamp>=CASE WHEN n.cfg->>$2 ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$'
        AND pg_input_is_valid(n.cfg->>$2,'timestamptz')
        THEN (n.cfg->>$2)::timestamptz AT TIME ZONE 'UTC' ELSE 'infinity'::timestamp END
    WHERE w.requiere_revision IS TRUE
    GROUP BY w.negocio_id,w.telefono,w.motivo,n.cfg,h.id
    ORDER BY min(m.id)`, [BANDERA_SEGUIMIENTO, DESDE_SEGUIMIENTO]);
  return rows;
}

export async function reclamarRecordatorio(db, fila, decision) {
  const { rows: [r] } = await db.query(`INSERT INTO conversaciones_atencion_avisos
      (negocio_id,telefono,mensaje_id,fase,prioridad,lease_hasta)
    VALUES($1,$2,$3,$4,$5,now()+interval '2 minutes')
    ON CONFLICT(negocio_id,telefono,mensaje_id,fase,prioridad) DO UPDATE
      SET lease_hasta=now()+interval '2 minutes'
      WHERE conversaciones_atencion_avisos.enviado_at IS NULL
        AND conversaciones_atencion_avisos.lease_hasta<now()
    RETURNING id`, [fila.negocio_id,fila.telefono,fila.mensaje_id,decision.fase,decision.prioridad]);
  return r?.id || null;
}

export async function siguePendiente(db, fila) {
  const { rows: [r] } = await db.query(`SELECT EXISTS(
    SELECT 1 FROM whatsapp_conversaciones w WHERE w.negocio_id=$1 AND w.telefono=$2
      AND w.requiere_revision IS TRUE
      AND EXISTS(SELECT 1 FROM configuracion c WHERE c.negocio_id=w.negocio_id
        AND c.clave=$4 AND c.valor='true')
      AND NOT EXISTS(SELECT 1 FROM mensajes m WHERE m.negocio_id=w.negocio_id AND m.telefono=w.telefono
        AND m.direccion='saliente' AND m.origen='humano' AND m.id>$3)) pendiente`,
  [fila.negocio_id,fila.telefono,fila.mensaje_id,BANDERA_SEGUIMIENTO]);
  return r?.pendiente === true;
}

export async function revisarAtencionPendiente({ db = pool, broadcastPanel, ahora = new Date(), log = console.warn,
  buscar = buscarPendientesAtencion, reclamar = reclamarRecordatorio, vigente = siguePendiente } = {}) {
  if (typeof broadcastPanel !== 'function') return 0;
  let avisados = 0;
  try {
    for (const fila of await buscar(db)) {
      const decision = decidirRecordatorio(fila, ahora);
      if (!decision) continue;
      const id = await reclamar(db, fila, decision);
      if (!id) continue;
      try {
        if (await vigente(db, fila)) {
          await broadcastPanel(fila.negocio_id, { tipo: 'rescate_humano',
            telefono: telefonoEnmascarado(fila.telefono), ref: referenciaDeConversacion(fila.negocio_id,fila.telefono),
            motivo: fila.motivo, prioridad: decision.prioridad, recordatorio: true,
            fueraHorario: decision.fase === 'cerrado', razon: decision.instruccion });
          avisados++;
        }
        await db.query('UPDATE conversaciones_atencion_avisos SET enviado_at=now() WHERE id=$1', [id]);
      } catch (e) {
        await db.query('UPDATE conversaciones_atencion_avisos SET lease_hasta=now() WHERE id=$1', [id]);
        log(`[ATENCION] aviso pendiente de reintento: ${e.message}`);
      }
    }
  } catch (e) { log(`[ATENCION] revisión fallida: ${e.message}`); }
  return avisados;
}
