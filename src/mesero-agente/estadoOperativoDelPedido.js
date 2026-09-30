import {telefonoTransporte} from '../services/estadosMensajeWhatsapp.js';

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

export function respuestaOperativaVerificada(estado,actual) {
  const folio=String(estado?.folio || '');
  if(!estado?.hechos?.confirmado || !folio || estado.confirmacionIncierta
    || estado.hechos.escalado || estado.hechos.cancelado || estado.hechos.fallido)return null;
  const etiquetas={nuevo:'está recibido, en espera de preparación',en_preparacion:'está en preparación',
    listo:'está listo',entregado:'figura como entregado',cancelado:'figura como cancelado',
    en_camino:'está en camino',en_reparto:'está en reparto'};
  const descripcion=actual?.folio===folio && etiquetas[actual.estado];
  if(!descripcion)return `Tu pedido ${folio} quedó registrado. No pude verificar su estado actual de preparación, entrega o pago. Puedes escribir «hablar con alguien» para pedir ayuda al equipo.`;
  return `Tu pedido ${folio} ${descripcion}.`
    +(actual.estado==='listo' && /recoger/.test(actual.modalidad || '')?' Puedes pasar a recogerlo.':'')
    +' Este estado no acredita el pago. Si necesitas otro detalle, escribe «hablar con alguien».';
}
