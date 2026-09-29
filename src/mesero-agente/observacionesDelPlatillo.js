// Texto del cliente para cocina, no instrucciones para el agente ni opciones
// de catálogo. Nunca se interpreta para cambiar productos, cantidades o precios.
export const MAX_OBSERVACIONES_PLATILLO = 300;
export function leerObservacionesPlatillo(valor) {
  if (valor === undefined || valor === null) return '';
  if (typeof valor !== 'string' || valor.length > MAX_OBSERVACIONES_PLATILLO
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(valor)) return null;
  // Una línea de nota no puede simular otra sección del resumen o la comanda.
  return valor.replace(/\s+/g, ' ').trim();
}
