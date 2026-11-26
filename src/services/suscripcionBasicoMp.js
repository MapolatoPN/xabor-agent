// Mensualidades SaaS de Xabor. Ningún ID de contrato proviene del body.
import { pool } from './database.js';
import { consultarEstadoComercialBasico } from './accesoComercialBasico.js';
import {cuentaPilotoBasico,inicioCobroBasico,VERSION_PILOTO_BASICO,TEXTO_PILOTO_BASICO} from './pilotoCobroBasico.js';
import {
 crearPreapprovalBasico, obtenerPreapprovalBasico, obtenerFacturaMpSaas,
 obtenerPagoMpSaas, buscarFacturaMpSaasPorPago, cancelarPreapprovalBasico,
 validarCobroSaas, enlaceMPValido, ErrorMercadoPagoSaas, normalizarCorreoPagador, validarCorreoPagadorMpSaas,
} from './mercadoPagoSaasCliente.js';
export class ErrorSuscripcionBasico extends Error {
 constructor(code,message,status=400){super(message);this.name='ErrorSuscripcionBasico';this.code=code;this.status=status;}
}
const ORDEN_CONTRATO="ORDER BY (estado_mp NOT IN ('canceled','cancelled')) DESC,creado_at DESC,id DESC LIMIT 1";
async function pilotoDisponible({negocioId,usuarioId,montoMensual}){
 if(!cuentaPilotoBasico({negocioId,usuarioId,montoMensual}))return false;
 const {rows:[r]}=await pool.query(`SELECT EXISTS(SELECT 1 FROM solicitudes_registro_basico s
 JOIN usuarios u ON u.negocio_id=s.negocio_id AND u.id=$2 AND u.activo
 JOIN usuario_negocios un ON un.usuario_id=u.id AND un.negocio_id=s.negocio_id AND un.activo AND un.rol='admin'
 WHERE s.negocio_id=$1 AND s.used_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1)
 AND NOT EXISTS(SELECT 1 FROM suscripciones_basico_mp WHERE negocio_id=$1 AND preapproval_id IS NOT NULL
 AND NOT(cobro_sin_espera AND estado_mp='pending')) AS disponible`,[negocioId,usuarioId]);
 return r?.disponible===true;
}
export async function estadoSuscripcionBasico(negocioId,{usuarioId}={}){
 const r=await consultarEstadoComercialBasico(negocioId);
 if(!r)throw new ErrorSuscripcionBasico('NO_AUTOSERVICIO','Este negocio no usa esta suscripción',404);
 const {rows:historial}=await pool.query(`SELECT monto,moneda,estado_pago,reembolsado,aprobado_at,periodo_desde,periodo_hasta
 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1 ORDER BY aprobado_at DESC LIMIT 24`,[negocioId]);
 const {rows:[actual]}=await pool.query('SELECT cobro_sin_espera,correo_pagador FROM suscripciones_basico_mp WHERE negocio_id=$1 '+ORDEN_CONTRATO,[negocioId]);
 const {rows:[usuario]}=await pool.query('SELECT email FROM usuarios WHERE id=$1 AND negocio_id=$2',[usuarioId,negocioId]);
 const disponible=await pilotoDisponible({negocioId,usuarioId,montoMensual:r.mensualidad});
 return {plan:'basico',montoMensual:Number(r.mensualidad),moneda:'MXN',estado:r.estado,
 accesoPermitido:r.permitido,pruebaHasta:r.prueba_hasta,proximaFechaPago:r.pagado_hasta,
 correoPagador:actual?.correo_pagador??null,correoSugerido:usuario?.email??null,
 correoPagadorRequiereRevision:r.estado_mp==='pending'&&!actual?.correo_pagador,
 graciaHasta:r.gracia_hasta,estadoMercadoPago:r.estado_mp??'sin_suscripcion',
 pilotoCobroSinEspera:{disponible,solicitado:actual?.cobro_sin_espera===true&&!['canceled','cancelled'].includes(r.estado_mp),...(disponible?{version:VERSION_PILOTO_BASICO,texto:TEXTO_PILOTO_BASICO}:{})},
 checkoutUrl:actual?.correo_pagador&&(!actual.cobro_sin_espera||disponible)&&!['canceled','cancelled','authorized'].includes(r.estado_mp)&&enlaceMPValido(r.checkout_url)?r.checkout_url:null,historial};
}
export async function iniciarCheckoutBasico({negocioId,usuarioId,correoPagador,aceptarCobroSinEspera,crear=crearPreapprovalBasico}){
 if(aceptarCobroSinEspera!==undefined&&aceptarCobroSinEspera!==VERSION_PILOTO_BASICO)
  throw new ErrorSuscripcionBasico('CONDICIONES_PILOTO_INVALIDAS','Revisa y acepta las condiciones del piloto.',400);
 const sinEspera=aceptarCobroSinEspera===VERSION_PILOTO_BASICO;
 const {rows:[r]}=await pool.query(`SELECT s.used_at+INTERVAL '7 days' AS prueba_hasta,u.email,pc.mensualidad,
 (SELECT MAX(periodo_hasta) FROM pagos_suscripcion_basico_mp WHERE negocio_id=s.negocio_id
 AND estado_pago='approved' AND reembolsado=0) AS pagado_hasta
 FROM solicitudes_registro_basico s JOIN usuarios u ON u.id=$2 AND u.negocio_id=s.negocio_id
 JOIN negocio_plan_comercial pc ON pc.negocio_id=s.negocio_id
 WHERE s.negocio_id=$1 AND s.used_at IS NOT NULL`,[negocioId,usuarioId]);
 if(!r)throw new ErrorSuscripcionBasico('NO_AUTOSERVICIO','Esta cuenta no puede contratar este plan',404);
 if(sinEspera&&!await pilotoDisponible({negocioId,usuarioId,montoMensual:r.mensualidad}))
  throw new ErrorSuscripcionBasico('PILOTO_NO_AUTORIZADO','El cobro sin espera no está habilitado para esta cuenta.',403);
 const correo=normalizarCorreoPagador(correoPagador===undefined?r.email:correoPagador);
 try{await validarCorreoPagadorMpSaas(correo);}
 catch(e){if(e instanceof ErrorMercadoPagoSaas&&e.estado===400)throw new ErrorSuscripcionBasico('CORREO_PAGADOR_INVALIDO',e.message,400);throw e;}
 const inicioCobro=inicioCobroBasico({pruebaHasta:r.prueba_hasta,pagadoHasta:r.pagado_hasta,sinEspera});
 const {rows:[reserva]}=await pool.query(`INSERT INTO suscripciones_basico_mp
 (negocio_id,external_reference,estado_mp,mensualidad,cobro_sin_espera,condiciones_cobro_version,
 condiciones_cobro_aceptadas_at,solicitado_por_usuario_id,inicio_cobro_solicitado,correo_pagador)
 VALUES($1::uuid,'xabor-basico:'||$1::uuid::text,'creando',$2,$3,$4,CASE WHEN $3 THEN NOW() END,$5,$6,$7)
 ON CONFLICT (negocio_id) WHERE estado_mp NOT IN ('canceled','cancelled') DO NOTHING RETURNING id`,
 [negocioId,r.mensualidad,sinEspera,sinEspera?VERSION_PILOTO_BASICO:null,usuarioId,inicioCobro,correo]);
 if(!reserva){
  const {rows:[actual]}=await pool.query('SELECT estado_mp,checkout_url,cobro_sin_espera,correo_pagador FROM suscripciones_basico_mp WHERE negocio_id=$1 '+ORDEN_CONTRATO,[negocioId]);
  if(actual&&actual.cobro_sin_espera!==sinEspera)throw new ErrorSuscripcionBasico('CONDICIONES_CONTRATO_DISTINTAS','Hay una contratación con otras condiciones. Revísala antes de continuar.',409);
  if(actual?.estado_mp==='pending'){
   if(!actual.correo_pagador)throw new ErrorSuscripcionBasico('CORREO_CONTRATO_REQUIERE_REVISION','Esta contratación anterior necesita revisión para confirmar su correo de pago. Contacta a soporte.',409);
   if(actual.correo_pagador!==correo)throw new ErrorSuscripcionBasico('CORREO_CONTRATO_DISTINTO','La contratación pendiente usa otro correo de Mercado Pago. Contacta a soporte antes de cambiar la cuenta que paga.',409);
   if(enlaceMPValido(actual.checkout_url))return {checkoutUrl:actual.checkout_url,existente:true};
  }
  throw new ErrorSuscripcionBasico('CONTRATO_EN_REVISION',actual?.estado_mp==='authorized'?
   'Tu suscripción ya está autorizada.':'La suscripción está en preparación o necesita revisión. Contacta a soporte.',409);
 }
 // Ante respuesta incierta queda la reserva: no se reintenta a ciegas.
 let resultado;
 try{
  resultado=await crear({negocioId,email:correo,inicioCobro,baseUrl:process.env.PUBLIC_URL||'https://xabor.mx',
   montoMensual:Number(r.mensualidad),idempotencyKey:reserva.id,cobroSinEspera:sinEspera});
 }catch(e){
  if(e instanceof ErrorMercadoPagoSaas && e.rechazoDefinitivo){
   // Conservar el intento fallido y permitir otro contrato solo cuando MP
   // confirmó que no aceptó la solicitud. Una respuesta incierta sigue reservada.
   await pool.query(`UPDATE suscripciones_basico_mp SET estado_mp='cancelled',actualizado_at=NOW()
    WHERE id=$1 AND estado_mp='creando' AND preapproval_id IS NULL`,[reserva.id]);
  }
  throw e;
 }
 await pool.query(`UPDATE suscripciones_basico_mp SET preapproval_id=$2,checkout_url=$3,estado_mp=$4,actualizado_at=NOW()
 WHERE id=$1 AND preapproval_id IS NULL`,[reserva.id,resultado.id,resultado.checkoutUrl,
 ['pending','authorized'].includes(resultado.estado)?resultado.estado:'pending']);
 return {checkoutUrl:resultado.checkoutUrl,existente:false};
}
function periodoFactura(factura,pago){
 const desde=new Date(factura.debit_date||pago.date_approved);
 if(!Number.isFinite(desde.getTime()))throw new ErrorSuscripcionBasico('FECHA_INVALIDA','Factura sin fecha verificable',503);
 const hasta=new Date(desde),dia=hasta.getUTCDate();hasta.setUTCDate(1);hasta.setUTCMonth(hasta.getUTCMonth()+1);
 const ultimo=new Date(Date.UTC(hasta.getUTCFullYear(),hasta.getUTCMonth()+1,0)).getUTCDate();
 hasta.setUTCDate(Math.min(dia,ultimo));return {desde,hasta};
}
export async function conciliarFacturaMercadoPago(idFactura,{
 obtenerFactura=obtenerFacturaMpSaas,obtenerPago=obtenerPagoMpSaas,obtenerPreapproval=obtenerPreapprovalBasico,
}={}){
 const factura=await obtenerFactura(idFactura),preapprovalId=String(factura?.preapproval_id??'');
 if(String(factura?.id)!==String(idFactura))return {aplicado:false,motivo:'factura_inconsistente'};
 if(!preapprovalId)return {aplicado:false,motivo:'sin_contrato'};
 const {rows:[local]}=await pool.query('SELECT negocio_id,external_reference,mensualidad FROM suscripciones_basico_mp WHERE preapproval_id=$1',[preapprovalId]);
 if(!local)return {aplicado:false,motivo:'no_corresponde_a_xabor'};
 const contrato=await obtenerPreapproval(preapprovalId);
 if(String(contrato?.id)!==preapprovalId||contrato?.external_reference!==local.external_reference||
 factura.currency_id!=='MXN'||Number(factura.transaction_amount)!==Number(local.mensualidad))return {aplicado:false,motivo:'cobro_no_verificado'};
 const pago=factura.payment?.id?await obtenerPago(factura.payment.id):null;
 if(pago&&(String(pago.id)!==String(factura.payment.id)||pago.currency_id!=='MXN'||
 Number(pago.transaction_amount)!==Number(local.mensualidad)))return {aplicado:false,motivo:'cobro_no_verificado'};
 const estado=pago?.status||factura.payment?.status||factura.status||'pending';
 const reembolsado=Number(pago?.transaction_amount_refunded||0);
 if(!Number.isFinite(reembolsado)||reembolsado<0||reembolsado>Number(local.mensualidad))return {aplicado:false,motivo:'reembolso_invalido'};
 const aprobado=validarCobroSaas({factura,pago,preapprovalId,montoEsperado:Number(local.mensualidad)});
 const cliente=await pool.connect();
 try{
  await cliente.query('BEGIN');
  const plan=await cliente.query('SELECT negocio_id FROM negocio_plan_comercial WHERE negocio_id=$1 FOR UPDATE',[local.negocio_id]);
  if(plan.rowCount!==1)throw new ErrorSuscripcionBasico('PLAN_NO_ENCONTRADO','El plan requiere revisión',503);
  const intento=await cliente.query(`INSERT INTO facturas_suscripcion_basico_mp
  (authorized_payment_id,negocio_id,preapproval_id,payment_id,estado_pago) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(authorized_payment_id) DO UPDATE SET payment_id=EXCLUDED.payment_id,estado_pago=EXCLUDED.estado_pago,consultado_at=NOW()
  WHERE facturas_suscripcion_basico_mp.negocio_id=EXCLUDED.negocio_id AND facturas_suscripcion_basico_mp.preapproval_id=EXCLUDED.preapproval_id
  RETURNING authorized_payment_id`,[String(factura.id),local.negocio_id,preapprovalId,pago?String(pago.id):null,estado]);
  if(!intento.rowCount)throw new ErrorSuscripcionBasico('FACTURA_INCONSISTENTE','Factura requiere revisión',503);
  let aplicado=false;
  const {rows:[existente]}=await cliente.query(`SELECT * FROM pagos_suscripcion_basico_mp
  WHERE authorized_payment_id=$1 OR payment_id=$2 FOR UPDATE`,[String(factura.id),pago?String(pago.id):null]);
  if(existente){
   if(existente.negocio_id!==local.negocio_id||existente.preapproval_id!==preapprovalId||
    existente.authorized_payment_id!==String(factura.id)||existente.payment_id!==String(pago?.id)){
    await cliente.query('ROLLBACK');return {aplicado:false,motivo:'pago_duplicado_o_inconsistente'};
   }
   // Un evento atrasado no vuelve a acreditar un reembolso o contracargo.
   if(['refunded','charged_back','cancelled','canceled'].includes(estado)||reembolsado>0){
    await cliente.query(`UPDATE pagos_suscripcion_basico_mp SET estado_pago=$2,
    reembolsado=GREATEST(reembolsado,$3),revisado_at=NOW() WHERE id=$1`,[existente.id,estado,reembolsado]);
   }
  }else if(aprobado){
   const {desde,hasta}=periodoFactura(factura,pago);
   const ins=await cliente.query(`INSERT INTO pagos_suscripcion_basico_mp
   (negocio_id,preapproval_id,authorized_payment_id,payment_id,monto,moneda,aprobado_at,periodo_desde,periodo_hasta)
   VALUES($1,$2,$3,$4,$5,'MXN',$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
   [local.negocio_id,preapprovalId,String(factura.id),String(pago.id),local.mensualidad,pago.date_approved,desde,hasta]);
   aplicado=ins.rowCount===1;
  }
  await cliente.query(`UPDATE negocio_plan_comercial pc SET
  estado=CASE WHEN pc.estado='suspendido' THEN 'suspendido'
  WHEN EXISTS(SELECT 1 FROM pagos_suscripcion_basico_mp p WHERE p.negocio_id=pc.negocio_id
   AND estado_pago='approved' AND reembolsado=0 AND periodo_hasta>NOW()) THEN 'activo'
  WHEN EXISTS(SELECT 1 FROM solicitudes_registro_basico s WHERE s.negocio_id=pc.negocio_id
   AND s.used_at+INTERVAL '7 days'>NOW()) THEN 'prueba' ELSE 'vencido' END,
  proxima_fecha_pago=(SELECT MAX(periodo_hasta)::date FROM pagos_suscripcion_basico_mp p
   WHERE p.negocio_id=pc.negocio_id AND estado_pago='approved' AND reembolsado=0),updated_at=NOW()
  WHERE pc.negocio_id=$1`,[local.negocio_id]);
  await cliente.query('COMMIT');
  return {aplicado,motivo:aplicado?'acreditado':existente?'ya_acreditado':'pago_no_aprobado'};
 }catch(e){await cliente.query('ROLLBACK').catch(()=>{});throw e;}finally{cliente.release();}
}
export async function conciliarEstadoMercadoPago(id,{obtenerPreapproval=obtenerPreapprovalBasico}={}){
 const remote=await obtenerPreapproval(id);if(String(remote?.id)!==String(id))return {actualizado:false};
 const {rows:[local]}=await pool.query('SELECT negocio_id,external_reference FROM suscripciones_basico_mp WHERE preapproval_id=$1',[String(id)]);
 if(!local||remote.external_reference!==local.external_reference)return {actualizado:false};
 const estado=['pending','authorized','paused','cancelled','canceled'].includes(remote.status)?remote.status:'error';
 await pool.query(`UPDATE suscripciones_basico_mp SET estado_mp=$2,ultima_consulta_at=NOW(),actualizado_at=NOW()
 WHERE preapproval_id=$1 AND (estado_mp NOT IN ('canceled','cancelled') OR $2 IN ('canceled','cancelled'))`,[String(id),estado]);
 return {actualizado:true};
}
export async function conciliarPagoNotificadoMercadoPago(idPago,{
 buscarFactura=buscarFacturaMpSaasPorPago,conciliarFactura=conciliarFacturaMercadoPago,
}={}){
 const facturas=await buscarFactura(idPago);let aplicadas=0;
 const {rows:locales}=await pool.query('SELECT authorized_payment_id AS id FROM pagos_suscripcion_basico_mp WHERE payment_id=$1',[String(idPago)]);
 const ids=new Set([...facturas,...locales].map(f=>String(f.id)));
 for(const id of ids){if(!/^\d{1,24}$/.test(id))continue;const r=await conciliarFactura(id);if(r.aplicado)aplicadas++;}
 return {aplicadas};
}
export async function cancelarSuscripcionBasico({negocioId,cancelar=cancelarPreapprovalBasico,obtenerPreapproval=obtenerPreapprovalBasico}={}){
 const {rows:[local]}=await pool.query('SELECT negocio_id, external_reference, preapproval_id, estado_mp FROM suscripciones_basico_mp WHERE negocio_id = $1 '+ORDEN_CONTRATO,[negocioId]);
 if(!local?.preapproval_id)throw new ErrorSuscripcionBasico('CONTRATO_INEXISTENTE','No existe una contratación para cancelar.',404);
 if(['canceled','cancelled'].includes(local.estado_mp))return {cancelada:true,yaCancelada:true};
 const antes=await obtenerPreapproval(local.preapproval_id);
 if(String(antes?.id)!==local.preapproval_id||antes?.external_reference !== local.external_reference)
 throw new ErrorSuscripcionBasico('CONTRATO_INCONSISTENTE','No se pudo validar la suscripción.',409);
 // Un intento anterior pudo completarse en MP y perder su respuesta. La
 // consulta verificada permite conciliar ese resultado sin otro PUT.
 if(!['canceled','cancelled'].includes(antes.status)){
  const confirmacion=await cancelar(local.preapproval_id);
  if(String(confirmacion?.id)!==local.preapproval_id||confirmacion?.external_reference!==local.external_reference||
   !['canceled','cancelled'].includes(confirmacion?.status))
   throw new ErrorSuscripcionBasico('CANCELACION_NO_CONFIRMADA','Mercado Pago no confirmó la cancelación. Revisa el estado e inténtalo de nuevo.',503);
 }
 await pool.query(`UPDATE suscripciones_basico_mp SET estado_mp='canceled',actualizado_at=NOW(),ultima_consulta_at=NOW()
 WHERE negocio_id=$1 AND preapproval_id=$2`,[negocioId,local.preapproval_id]);
 // No se borra el histórico ni el periodo pagado; recontratar crea otra fila.
 return {cancelada:true};
}
