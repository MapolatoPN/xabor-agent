import { pool, poolDeClaims } from './database.js';
import { mpSaasHabilitado, buscarFacturasMpSaasPorContrato, LIMITE_FACTURAS_MP_SAAS } from './mercadoPagoSaasCliente.js';
import { conciliarFacturaMercadoPago, conciliarEstadoMercadoPago } from './suscripcionBasicoMp.js';

export async function registrarAlertaBasico(tipo,negocioId=null,detalle=negocioId||'global') {
  const clave=tipo+':'+detalle;
  await pool.query(`INSERT INTO alertas_facturacion_basico(clave,negocio_id,tipo) VALUES($1,$2,$3)
    ON CONFLICT(clave) DO UPDATE SET ocurrencias=alertas_facturacion_basico.ocurrencias+1,
      ultima_at=NOW(),resuelta_at=NULL`,[clave,negocioId,tipo]);
}
export async function conciliarLoteBasico({
  buscarFacturas=buscarFacturasMpSaasPorContrato,conciliarFactura=conciliarFacturaMercadoPago,
  conciliarEstado=conciliarEstadoMercadoPago,max=10,
}={}) {
  // Pool separado: con max=1 en el pool de consultas no causa interbloqueo.
  const lock=await poolDeClaims().connect();let tomado=false;
  const conteos={contratos:0,acreditadas:0,errores:0};
  try {
    const {rows:[r]}=await lock.query("SELECT pg_try_advisory_lock(hashtext('xabor-basico-conciliacion')) AS tomado");
    tomado=r.tomado;if(!tomado)return {...conteos,ocupado:true};
    const {rows}=await pool.query(`SELECT negocio_id,preapproval_id,conciliacion_offset FROM suscripciones_basico_mp
      WHERE preapproval_id IS NOT NULL ORDER BY ultima_consulta_at NULLS FIRST,creado_at LIMIT $1`,[Math.min(30,Math.max(1,max))]);
    for(const c of rows){
      conteos.contratos++;
      try {
        await conciliarEstado(c.preapproval_id);
        let offset=c.conciliacion_offset;
        // Cursor persistido: no se abandonan contratos antiguos ni facturas
        // anteriores a la primera página. Dos páginas por ejecución y contrato.
        for(let pagina=0;pagina<2;pagina++){
          const facturas=await buscarFacturas(c.preapproval_id,{limit:LIMITE_FACTURAS_MP_SAAS,offset});
          for(const f of facturas){if(!/^\d{1,24}$/.test(String(f.id)))continue;
            const r=await conciliarFactura(String(f.id));if(r.aplicado)conteos.acreditadas++;}
          offset=facturas.length<LIMITE_FACTURAS_MP_SAAS?0:offset+LIMITE_FACTURAS_MP_SAAS;
          if(offset===0||offset>9980){offset=0;break;}
        }
        await pool.query('UPDATE suscripciones_basico_mp SET conciliacion_offset=$2,ultima_consulta_at=NOW() WHERE preapproval_id=$1',[c.preapproval_id,offset]);
        await pool.query("UPDATE alertas_facturacion_basico SET resuelta_at=NOW() WHERE clave=$1",['conciliacion:'+c.preapproval_id]);
      }catch(e){
        conteos.errores++;
        await pool.query('UPDATE suscripciones_basico_mp SET ultima_consulta_at=NOW() WHERE preapproval_id=$1',[c.preapproval_id]);
        await registrarAlertaBasico('conciliacion',c.negocio_id,c.preapproval_id);
      }
    }
    return conteos;
  }finally{
    if(tomado)await lock.query("SELECT pg_advisory_unlock(hashtext('xabor-basico-conciliacion'))").catch(()=>{});
    lock.release();
  }
}
export function iniciarConciliacionBasico(){
  if(process.env.XABOR_CONCILIACION_AUTOMATICA!=='true'||!mpSaasHabilitado())return null;
  const ejecutar=()=>conciliarLoteBasico().then(r=>console.log('[saas-mp] Conciliación',JSON.stringify(r)))
    .catch(async()=>{console.error('[saas-mp] Falló la conciliación programada');await registrarAlertaBasico('conciliacion_global').catch(()=>{});});
  const inicial=setTimeout(ejecutar,5000);inicial.unref();
  const timer=setInterval(ejecutar,15*60_000);timer.unref();return timer;
}
