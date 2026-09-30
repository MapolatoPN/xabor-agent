import { agenteDentro } from './interactivos.js';
import { alcanceDePruebaPermite } from './alcanceDePrueba.js';
import { betaHibridaActiva } from './experienciaHibrida.js';

// Lista cerrada: nunca concede a prosa del modelo permiso para saltar pausas.
export const TEXTOS_RECIBO_HANDOFF=[
  'Permíteme un momento, te paso con alguien del equipo para atenderte bien.',
  'Te paso con alguien del equipo para que te atienda mejor. Un momento, por favor.',
];

export async function vincularReciboHandoff(db,{clave,negocioId,telefono}) {
  // La pausa automática ya ocurrió. Guarda su identidad exacta, no un
  // booleano que serviría para cualquier pausa futura de la conversación.
  await db.query(`UPDATE agente_outbox o SET carga=o.carga || jsonb_build_object('recibo_handoff',
      jsonb_build_object('revision_at',w.actualizado_at::text,'pausa_at',c.updated_at::text,'motivo',w.motivo))
    FROM whatsapp_conversaciones w JOIN conversaciones_control c
      ON c.negocio_id=w.negocio_id AND c.telefono=w.telefono
    WHERE o.evento_clave=$1 AND o.negocio_id=$2 AND o.carga->>'telefono'=$3
      AND o.carga->>'beta'='hibrida' AND NOT (o.carga ? 'interactivo')
      AND o.carga->>'texto'=ANY($4::text[])
      AND w.negocio_id=$2 AND w.telefono=$3 AND w.requiere_revision IS TRUE
      AND c.bot_pausado IS TRUE AND c.updated_by IS NULL
      AND w.actualizado_at>now()-interval '2 minutes' AND c.updated_at>now()-interval '2 minutes'
      AND EXISTS(SELECT 1 FROM agente_outbox h WHERE h.negocio_id=o.negocio_id
        AND h.conversacion_id=o.conversacion_id AND h.turno_clave=o.turno_clave AND h.tipo='handoff')`,
  [clave,negocioId,telefono,TEXTOS_RECIBO_HANDOFF]);
}

export async function permiteReciboHandoff({db,fila}) {
  const carga=fila?.carga;
  if(!carga?.recibo_handoff || carga.interactivo || !TEXTOS_RECIBO_HANDOFF.includes(carga.texto))return false;
  const {rows:[r]}=await db.query(`SELECT n.bot_whatsapp_activo,
      (SELECT jsonb_object_agg(clave,valor) FROM configuracion WHERE negocio_id=o.negocio_id) AS cfg,
      EXISTS(SELECT 1 FROM integraciones_canal i WHERE i.negocio_id=o.negocio_id
        AND i.canal='whatsapp' AND i.activo IS TRUE) AS canal,
      EXISTS(SELECT 1 FROM negocio_modulos m WHERE m.negocio_id=o.negocio_id
        AND m.modulo='whatsapp' AND m.estado='activo') AS modulo,
      EXISTS(SELECT 1 FROM clientes cl WHERE (cl.negocio_id=o.negocio_id OR cl.negocio_id IS NULL)
        AND cl.telefono=$3 AND cl.human_takeover_until>now()) AS tomado,
      EXISTS(SELECT 1 FROM mensajes m WHERE m.negocio_id=o.negocio_id AND m.telefono=$3
        AND m.direccion='saliente' AND m.origen='humano'
        AND m.timestamp >= w.actualizado_at) AS humano,
      EXISTS(SELECT 1 FROM whatsapp_entradas e WHERE e.negocio_id=o.negocio_id AND e.telefono=$3
        AND e.recibido_at>now()-interval '24 hours'
        AND CASE WHEN e.payload->'message'->>'timestamp' ~ '^[0-9]{9,11}$'
          THEN to_timestamp((e.payload->'message'->>'timestamp')::double precision)
            BETWEEN now()-interval '24 hours' AND now() ELSE false END) AS ventana
    FROM agente_outbox o JOIN negocios n ON n.id=o.negocio_id
    JOIN whatsapp_conversaciones w ON w.negocio_id=o.negocio_id AND w.telefono=$3
    JOIN conversaciones_control c ON c.negocio_id=o.negocio_id AND c.telefono=$3
    WHERE o.id=$1 AND o.negocio_id=$2 AND o.carga->>'telefono'=$3
      AND o.carga->'recibo_handoff'=$4::jsonb AND o.carga->>'texto'=$5
      AND o.created_at>now()-interval '2 minutes'
      AND w.requiere_revision IS TRUE AND c.bot_pausado IS TRUE AND c.updated_by IS NULL
      AND w.actualizado_at::text=o.carga->'recibo_handoff'->>'revision_at'
      AND c.updated_at::text=o.carga->'recibo_handoff'->>'pausa_at'
      AND w.motivo=o.carga->'recibo_handoff'->>'motivo'
      AND NOT EXISTS(SELECT 1 FROM agente_outbox otro WHERE otro.negocio_id=o.negocio_id
        AND otro.conversacion_id=o.conversacion_id AND otro.tipo='respuesta_cliente' AND otro.created_at>o.created_at)`,
  [fila.id,fila.negocio_id,carga.telefono,JSON.stringify(carga.recibo_handoff),carga.texto]);
  return !!r && r.bot_whatsapp_activo===true && r.canal===true && r.modulo===true
    && !r.tomado && !r.humano && r.ventana===true
    && agenteDentro(r.cfg,carga.telefono) && alcanceDePruebaPermite(r.cfg,carga.telefono)
    && betaHibridaActiva(r.cfg,carga.telefono);
}
