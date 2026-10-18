// Tiempo estimado que el cliente lee al confirmar y al preguntar por su pedido.
//
// Sale de las reglas del negocio (Asistente → Pedidos), nunca del modelo: el
// 2-oct el equipo escribió a mano «45 minutos aproximadamente» en 7
// conversaciones porque el bot respondía el estado sin ningún tiempo.

const minutos = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** «unos 45 minutos» o «de 45 a 55 minutos»; null si no hay un rango válido. */
export function rangoEnMinutos(min, max) {
  const a = minutos(min);
  const b = minutos(max);
  if (a && b && b > a) return `de ${a} a ${b} minutos`;
  if (a && (!b || b === a)) return `unos ${a} minutos`;
  return null;
}

/**
 * Frase del tiempo estimado según la modalidad. A domicilio usa el tiempo de
 * entrega; para recoger, el de preparación. `desdePago` la ancla al pago del
 * enlace, porque esos pedidos no entran a cocina antes.
 */
export function fraseTiempoEstimado(reglas, modalidad, { desdePago = false, items = [] } = {}) {
  const p = reglas?.pedidos;
  if (!p || typeof p !== 'object') return null;
  const configurado=Number(p.umbral_pedido_grande);
  const umbral=Number.isInteger(configurado) && configurado>=2 && configurado<=100?configurado:10;
  const cantidad=(Array.isArray(items)?items:[]).reduce((a,i)=>a+Math.max(0,Number(i?.cantidad)||0),0);
  if(cantidad>=umbral)return 'Por el tamaño de tu pedido, consulta con el personal el tiempo estimado de preparación y entrega.';
  const m = String(modalidad || '').toLowerCase();
  const desde = desdePago ? ' después de recibir tu pago' : '';
  if (m.includes('domicilio')) {
    const rango = rangoEnMinutos(p.tiempo_entrega_min_minutos, p.tiempo_entrega_max_minutos);
    return rango ? `Tiempo estimado de entrega: ${rango}${desde}.` : null;
  }
  if (m.includes('recoger')) {
    const rango = rangoEnMinutos(p.tiempo_preparacion_minutos, p.tiempo_preparacion_minutos);
    return rango ? `Estará listo para recoger en ${rango}${desde}.` : null;
  }
  return null;
}
