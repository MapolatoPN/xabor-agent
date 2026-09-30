// Una sugerencia no es una autorización. El motor calcula la oportunidad;
// elegir Agregar otro recorre el carrito normal y confirmar conserva lo actual.
import {createHash} from 'node:crypto';
export function sugerenciaPromocion(orden,promociones,estado,huella) {
  if(!huella || estado?.folio || estado?.confirmacionIncierta || Object.values(estado?.hechos || {}).some(Boolean))return null;
  for(const o of orden?.promo_oportunidades || []) {
    if(o.codigo!=='ADD_ONE_MORE_ELIGIBLE_ITEM' || !Number.isSafeInteger(o.unidadesFaltantes) || o.unidadesFaltantes<1)continue;
    const p=(promociones || []).find(p=>String(p.id)===String(o.promocionId) && ['2x1','segundo_descuento'].includes(p.tipo));
    if(!p || !p.participantesTexto || !p.descripcion)continue;
    const clave=createHash('sha256').update(JSON.stringify([huella,p.id,o.unidadesFaltantes,p.descripcion,p.participantesTexto])).digest('hex');
    if(estado.sugerenciasPromocion?.includes(clave))continue;
    const limpiar=s=>String(s).replace(/[\r\n*]/g,' ').trim();
    const texto=`*Promoción disponible: ${limpiar(p.nombre)}*\n${limpiar(p.descripcion).replace(/[.]+$/,'')}. ${limpiar(p.participantesTexto)}\n`
      +`Te falta${o.unidadesFaltantes===1?'':'n'} ${o.unidadesFaltantes} producto${o.unidadesFaltantes===1?'':'s'} participante${o.unidadesFaltantes===1?'':'s'} para completar el siguiente grupo. `
      +'Usa «Agregar otro» si te interesa, o confirma tu pedido tal como está. No agregamos nada automáticamente.';
    if(texto.length>650)continue;
    return {clave,texto};
  }
  return null;
}
