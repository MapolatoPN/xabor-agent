// Excepción comercial individual. Nunca se obtiene la cuenta autorizada del body.
export const VERSION_PILOTO_BASICO='piloto-150-sin-espera-v1';
export const MONTO_PILOTO_BASICO=150;
export const TEXTO_PILOTO_BASICO='Acepto una suscripción de 150 MXN mensuales para este piloto. El primer cobro se solicitará sin esperar los siete días gratis y los siguientes serán mensuales. Mercado Pago procesa el cargo después de autorizar el medio de pago.';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
export function cuentaPilotoBasico({negocioId,usuarioId,montoMensual},env=process.env){
 return uuid(negocioId)&&uuid(usuarioId)&&negocioId===env.XABOR_PILOTO_COBRO_NEGOCIO_ID&&
  usuarioId===env.XABOR_PILOTO_COBRO_USUARIO_ID&&Number(montoMensual)===MONTO_PILOTO_BASICO;
}
export function inicioCobroBasico({pruebaHasta,pagadoHasta,sinEspera=false,ahora=Date.now()}){
 const prueba=new Date(pruebaHasta).getTime();
 const pagado=pagadoHasta?new Date(pagadoHasta).getTime():0;
 if(!Number.isFinite(prueba)||!Number.isFinite(pagado)||!Number.isFinite(ahora))throw Error('Fecha de contratación inválida');
 return new Date(Math.max(sinEspera?0:prueba,pagado,ahora+120000));
}
