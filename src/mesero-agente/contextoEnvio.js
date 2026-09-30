// El texto editable sirve de contexto, no de fuente de tarifas. No alteramos
// la configuración del negocio: retiramos solo afirmaciones económicas de
// envío antes de construir el prompt si hay reglas estructuradas disponibles.
const normalizar=s=>String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function contextoSinTarifasLibres(valor,pedidos={},tema='') {
  const original=String(valor ?? '').trim();
  if(!Array.isArray(pedidos.zonas_entrega) || !pedidos.zonas_entrega.length)return original;
  const zonas=pedidos.zonas_entrega.map(z=>normalizar(z?.nombre)).filter(Boolean);
  const temaEnvio=/\b(envio|entrega|domicilio|reparto|zona|cobertura)\b/.test(normalizar(tema));
  return original.split(/\r?\n|(?<=[.!?;])\s+/).filter(frase=>{
    const s=normalizar(frase);
    const envio=temaEnvio || /\b(envio|entrega|domicilio|reparto|zona|cobertura)\b/.test(s) || zonas.some(z=>s.includes(z));
    const tarifa=/\$\s*\d|\b\d+(?:[.,]\d+)?\s*(?:pesos|mxn)\b|\b(gratis|gratuito|gratuita|sin costo|tarifa|costo|cuesta|cobramos)\b/.test(s);
    return !(envio && tarifa);
  }).join('\n').trim();
}
