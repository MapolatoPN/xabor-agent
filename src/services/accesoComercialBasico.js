// Solo altas públicas; los negocios anteriores conservan sus condiciones.
import { pool } from './database.js';
import { diasGraciaBasico } from './planBasico.js';
const SQL=`WITH datos AS (
 SELECT s.used_at+(s.dias_prueba*INTERVAL '1 day') AS prueba_hasta,s.plan_solicitado AS plan,s.dias_prueba,pc.mensualidad,pc.estado AS estado_manual,
 mp.estado_mp,mp.checkout_url,p.pagado_hasta,p.vigente,p.contracargo,
 COALESCE(p.pagado_hasta,s.used_at+(s.dias_prueba*INTERVAL '1 day'))+($2::int*INTERVAL '1 day') AS gracia_hasta
 FROM solicitudes_registro_basico s
 LEFT JOIN negocio_plan_comercial pc ON pc.negocio_id=s.negocio_id
 LEFT JOIN LATERAL (SELECT estado_mp,checkout_url FROM suscripciones_basico_mp WHERE negocio_id=s.negocio_id
 ORDER BY (estado_mp NOT IN ('canceled','cancelled')) DESC,creado_at DESC,id DESC LIMIT 1) mp ON TRUE
 LEFT JOIN LATERAL (SELECT MAX(periodo_hasta) FILTER(WHERE estado_pago='approved' AND reembolsado=0) AS pagado_hasta,
 BOOL_OR(estado_pago='approved' AND reembolsado=0 AND periodo_desde<=NOW() AND periodo_hasta>NOW()) AS vigente,
 BOOL_OR(estado_pago='charged_back' AND periodo_desde<=NOW() AND periodo_hasta>NOW()) AS contracargo
 FROM pagos_suscripcion_basico_mp WHERE negocio_id=s.negocio_id) p ON TRUE
 WHERE s.negocio_id = $1 AND s.used_at IS NOT NULL
), calculado AS (SELECT *,CASE
 WHEN estado_manual IS NULL OR estado_manual='suspendido' THEN 'suspendido'
 WHEN vigente THEN 'activo' WHEN contracargo THEN 'suspendido'
 WHEN prueba_hasta>NOW() THEN 'prueba'
 WHEN estado_mp='authorized' AND gracia_hasta>NOW() AND (dias_prueba>0 OR pagado_hasta IS NOT NULL) THEN 'gracia'
 WHEN estado_mp IN ('canceled','cancelled') THEN 'cancelado'
 WHEN estado_mp='pending' THEN 'pendiente' ELSE 'vencido' END AS estado FROM datos)
SELECT *,estado IN ('prueba','activo','gracia') AS permitido FROM calculado`;
export async function consultarEstadoComercialBasico(negocioId,{consultar=(q,p)=>pool.query(q,p)}={}){
 const {rows:[r]}=await consultar(SQL,[negocioId,diasGraciaBasico()]);return r||null;
}
export async function accesoComercialBasico(negocioId,{consultar=(q,p)=>pool.query(q,p)}={}){
 if(typeof negocioId!=='string'||!negocioId)return false;
 try{const r=await consultarEstadoComercialBasico(negocioId,{consultar});return r?r.permitido===true:true;}
 catch(e){
  if(e.code==='42P01'){
   // Solo permitir compatibilidad si NO existe la tabla de altas nuevas.
   try{const {rows:[r]}=await consultar("SELECT to_regclass('public.solicitudes_registro_basico') AS tabla",[]);
    if(r?.tabla===null)return true;
   }catch{}
  }
  console.error('[acceso-basico] Error comprobando suscripción:',e.code||'desconocido');return false;
 }
}
export const SUSCRIPCION_BASICO_VENCIDA=Object.freeze({
 error:'Tu prueba o suscripción requiere renovación. Conservamos tus datos; entra a Suscripción para pagar.',
 code:'SUSCRIPCION_BASICO_VENCIDA',
});
