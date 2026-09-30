// La cortesía no contiene hechos operativos. No se infiere preparación,
// reparto, cobro ni entrega a partir de que exista un pedido confirmado.
// Mensajes mixtos, dudas o cambios conservan su ruta habitual completa.
export function cortesiaPostPedido({estado,mensaje}) {
  if(!estado?.hechos?.confirmado || !estado.folio || estado.confirmacionIncierta
    || estado.hechos.escalado || estado.hechos.fallido || estado.hechos.cancelado
    || typeof mensaje!=='string' || mensaje.length>180)return null;
  const t=mensaje.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[!¡.,\s😊🙂🙏👍\uFE0F]/gu,' ').replace(/\s+/g,' ').trim();
  if(!/^(?:(?:ok|okay|vale|perfecto|excelente|entendido|esta bien) )?(?:muchas |muchisimas |mil )?gracias(?: por (?:todo|la ayuda|tu ayuda|su ayuda|la atencion))?$/.test(t)
    && !/^(?:ok|okay|vale|perfecto|excelente|entendido|esta bien)$/.test(t))return null;
  return '¡Gracias a ti! Si necesitas algo más, aquí estamos para ayudarte.';
}
