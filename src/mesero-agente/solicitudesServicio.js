import { inicioMapoActivo, textoReciboServicio } from './inicioMapo.js';
import { agenteDentro,barrerasDeBotones } from './interactivos.js';
import { alcanceDePruebaPermite } from './alcanceDePrueba.js';

export const motivoServicio = servicio => servicio==='facturacion'?'FACTURACION_REVISION_HUMANA'
  :servicio==='evento'?'SOLICITUD_EVENTO':'AGENTE_PIDE_HUMANO';

// Dentro del commit del turno: ficha + consumo del token + pausa + aviso
// durable. Una caída no pierde la captura ni deja al modelo contestando.
export async function guardarSolicitudServicio(tx,{solicitud,negocioId,telefono,clave,reserva}) {
  if(!solicitud)return;
  const b=await barrerasDeBotones(tx,negocioId,telefono);
  if(!b.activo || !inicioMapoActivo(b.cfg) || reserva?.ids?.length!==1)
    throw Error('SERVICIO_BARRERAS_CAMBIARON');
  await tx.query(`INSERT INTO agente_solicitudes_servicio(id,negocio_id,telefono,pregunta_id,respuesta_clave,servicio,datos)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[solicitud.id,negocioId,telefono,reserva.ids[0],clave,solicitud.servicio,JSON.stringify(solicitud.datos)]);
  if(solicitud.servicio==='facturacion')await tx.query(
    'DELETE FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2',[negocioId,telefono]);
  // No escribe requiere_revision: el mecanismo existente la marca y avisa
  // al panel. La pausa anticipada cierra el intervalo hasta ese aviso.
  const pausa=await tx.query(`INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado,updated_at)
    VALUES($1,$2,true,now()) ON CONFLICT(negocio_id,telefono) DO UPDATE
    SET bot_pausado=true,updated_by=NULL,updated_at=now() WHERE conversaciones_control.bot_pausado IS NOT TRUE`,[negocioId,telefono]);
  if(pausa.rowCount!==1)throw Error('SERVICIO_PAUSA_CONCURRENTE');
  await tx.query(`UPDATE agente_outbox SET humano_motivo=$2,humano_solicitado_at=now(),
    carga=carga || jsonb_build_object('recibo_servicio',$3::text) WHERE evento_clave=$1`,
    [clave,motivoServicio(solicitud.servicio),solicitud.id]);
}

// Única excepción a la pausa que acabamos de aplicar: el acuse fijo de ESTA
// solicitud, durante dos minutos. No permite preguntas, Flows ni al modelo.
// Una pausa manual posterior, cambio de motivo o respuesta del personal gana.
export async function permiteReciboServicio({db,fila}) {
  if(!fila?.carga?.recibo_servicio || fila.carga.interactivo)return false;
  const {rows:[s]}=await db.query(`SELECT s.servicio,s.created_at,
      n.bot_whatsapp_activo,c.updated_by,c.updated_at,c.bot_pausado,w.requiere_revision,w.motivo,
      (SELECT jsonb_object_agg(clave,valor) FROM configuracion WHERE negocio_id=s.negocio_id) AS cfg,
      EXISTS(SELECT 1 FROM integraciones_canal ic WHERE ic.negocio_id=s.negocio_id AND ic.canal='whatsapp' AND ic.activo IS TRUE) AS canal,
      EXISTS(SELECT 1 FROM negocio_modulos nm WHERE nm.negocio_id=s.negocio_id AND nm.modulo='whatsapp' AND nm.estado='activo') AS modulo,
      EXISTS(SELECT 1 FROM mensajes m WHERE m.negocio_id=s.negocio_id AND m.telefono=s.telefono
        AND m.direccion='saliente' AND m.origen='humano' AND m.timestamp>s.created_at) AS humano,
      EXISTS(SELECT 1 FROM clientes cl WHERE (cl.negocio_id=s.negocio_id OR cl.negocio_id IS NULL) AND cl.telefono=s.telefono
        AND cl.human_takeover_until>now()) AS tomado,
      EXISTS(SELECT 1 FROM whatsapp_entradas e WHERE e.negocio_id=s.negocio_id AND e.telefono=s.telefono
        AND e.recibido_at>now()-interval '24 hours'
        AND e.payload->'message'->>'timestamp' ~ '^[0-9]{9,11}$'
        AND CASE WHEN e.payload->'message'->>'timestamp' ~ '^[0-9]{9,11}$'
          THEN to_timestamp((e.payload->'message'->>'timestamp')::double precision)
            BETWEEN now()-interval '24 hours' AND now() ELSE false END) AS ventana,
      s.created_at>now()-interval '2 minutes' AS reciente
    FROM agente_solicitudes_servicio s JOIN negocios n ON n.id=s.negocio_id
    JOIN conversaciones_control c ON c.negocio_id=s.negocio_id AND c.telefono=s.telefono
    LEFT JOIN whatsapp_conversaciones w ON w.negocio_id=s.negocio_id AND w.telefono=s.telefono
    WHERE s.id::text=$1 AND s.negocio_id=$2 AND s.telefono=$3 AND s.respuesta_clave=$4`,
    [fila.carga.recibo_servicio,fila.negocio_id,fila.carga.telefono,fila.evento_clave]);
  return !!s && s.bot_whatsapp_activo===true && inicioMapoActivo(s.cfg) && s.reciente===true
    && s.canal===true && s.modulo===true && agenteDentro(s.cfg,fila.carga.telefono) && alcanceDePruebaPermite(s.cfg,fila.carga.telefono)
    && !s.updated_by && !s.humano && !s.tomado && s.ventana===true
    && (!s.requiere_revision || s.motivo===motivoServicio(s.servicio))
    && fila.carga.texto===textoReciboServicio(s.servicio);
}
