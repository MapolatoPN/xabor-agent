import { precioBasicoMxn, MODULOS_PLAN_BASICO } from './planBasico.js';

// Catálogo cerrado. El navegador elige una oferta, nunca precio ni permisos.
export const MODULOS_PLAN_PRO = Object.freeze(['pos','menu','restaurante','usuarios','caja',
  'impresion','whatsapp','rappi','facturacion','rewards','chat_imagenes','chat_documentos_pdf',
  'cotizaciones','generador_cotizaciones','pagos','repartidores','tienda_online','personal']);
export function ofertaAutoservicio(plan = 'basico') {
  if (!['basico','pro'].includes(plan)) throw Object.assign(new Error('Elige Básico o Pro.'), {code:'PLAN_INVALIDO',status:400});
  return { plan, nombre:plan==='pro'?'Pro':'Básico', montoMensual:plan==='pro'?900:precioBasicoMxn(),
    moneda:'MXN', diasPrueba:plan==='pro'?0:7, instalacion:0,
    modulos:plan==='pro'?MODULOS_PLAN_PRO:MODULOS_PLAN_BASICO };
}
export const altaPlanHabilitada = (plan, env = process.env) =>
  plan==='basico' ? env.XABOR_ALTA_PUBLICA_BASICO==='true' : plan==='pro' && env.XABOR_ALTA_PUBLICA_PRO==='true';
