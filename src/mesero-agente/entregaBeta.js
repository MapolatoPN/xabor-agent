import { barrerasDeBotones } from './interactivos.js';
import { betaHibridaActiva } from './experienciaHibrida.js';
import { catalogoNativoActivo } from './catalogoNativo.js';

// También protege el texto sin botones. Se revalida al despachar, no solo
// cuando se creó la respuesta: una pausa o retirar el piloto debe ganar.
export async function permiteEntregaBeta({db,negocioId,telefono,tipo}) {
  const b=await barrerasDeBotones(db,negocioId,telefono);
  if(!b.activo || !betaHibridaActiva(b.cfg,telefono))return false;
  if(tipo==='catalogo' && !catalogoNativoActivo(b.cfg,telefono))return false;
  if(!['hibrida','catalogo'].includes(tipo))return false;
  const {rows:[v]}=await db.query(`SELECT max(
      CASE WHEN payload->'message'->>'timestamp' ~ '^[0-9]{9,11}$'
        THEN CASE WHEN to_timestamp((payload->'message'->>'timestamp')::double precision) <= clock_timestamp()
          THEN LEAST(recibido_at,to_timestamp((payload->'message'->>'timestamp')::double precision)) END
        ELSE NULL END) > clock_timestamp()-interval '24 hours' AS abierta
    FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2`,[negocioId,telefono]);
  return v?.abierta===true;
}
