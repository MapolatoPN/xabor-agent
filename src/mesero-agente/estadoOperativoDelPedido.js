import {telefonoTransporte} from '../services/estadosMensajeWhatsapp.js';
import {fraseTiempoEstimado} from './tiempoEstimado.js';

// Leer el folio de ESTE ciclo, nunca «el último pedido» del teléfono. El
// resultado no autoriza cobros, transiciones, entregas ni avisos a cocina.
export async function leerEstadoOperativo(db,{negocioId,telefono,folio}) {
  if(!negocioId || !folio || !/^\d{8,15}$/.test(telefonoTransporte(telefono)))return null;
  try {
    const {rows:[p]}=await db.query({text:`SELECT folio,estado,datos->>'modalidad' AS modalidad
      FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2
        AND regexp_replace(datos->'cliente'->>'telefono','^521([0-9]{10})$','52\\1')=$3`,
      values:[negocioId,folio,telefonoTransporte(telefono)],query_timeout:2000});
    return p || null;
  } catch {return null;}
}

const ETIQUETAS={nuevo:'está recibido, en espera de preparación',en_preparacion:'está en preparación',
  listo:'está listo',entregado:'figura como entregado',cancelado:'figura como cancelado',
  en_camino:'está en camino',en_reparto:'está en reparto'};
const PIE=' Si necesitas otro detalle, escribe «hablar con alguien».';

/**
 * La línea del estado de UN pedido leído de pedidos_activos: el estado y, si
 * todavía no sale, el tiempo estimado de las reglas (nunca uno inventado: un
 * pedido listo a domicilio no lleva tiempo). null si el estado no tiene
 * etiqueta (p. ej. pendiente de pago): no se adivina. `pie` agrega el camino a
 * una persona; con varios pedidos se pone una sola vez, al final.
 *
 * Mismos bytes que respuestaOperativaVerificada, que la usa (paridad, T3).
 */
export function textoEstadoDePedido({folio,estado,modalidad},reglas=null,{pie=true}={}) {
  const descripcion=Object.hasOwn(ETIQUETAS,String(estado))?ETIQUETAS[estado]:null;
  if(!folio || !descripcion)return null;
  const tiempo=['nuevo','en_preparacion'].includes(estado)?fraseTiempoEstimado(reglas,modalidad):null;
  return `Tu pedido ${folio} ${descripcion}.`
    +(estado==='listo' && /recoger/.test(modalidad || '')?' Puedes pasar a recogerlo.':'')
    +(tiempo?` ${tiempo.replace(/\.$/,'')}, contando desde tu pedido.`:'')
    +(pie?PIE:'');
}
export const PIE_ESTADO_DE_PEDIDO=PIE.trim();

// La frase del pago («este estado no acredita el pago») se retiró el 3-oct:
// los clientes que pagan al recibir o que ya pagaron el enlace la leían como
// un problema con su pago. Los pedidos con enlace sin pagar no llegan aquí
// como «recibido»: siguen en pendiente_pago y caen al texto de no verificado.
export function respuestaOperativaVerificada(estado,actual,reglas=null) {
  const folio=String(estado?.folio || '');
  if(!estado?.hechos?.confirmado || !folio || estado.confirmacionIncierta
    || estado.hechos.escalado || estado.hechos.cancelado || estado.hechos.fallido)return null;
  const descripcion=actual?.folio===folio && ETIQUETAS[actual.estado];
  if(!descripcion)return `Tu pedido ${folio} quedó registrado. No pude verificar su estado actual de preparación, entrega o pago. Puedes escribir «hablar con alguien» para pedir ayuda al equipo.`;
  return textoEstadoDePedido({folio,estado:actual.estado,modalidad:actual.modalidad},reglas);
}
