// Formatea calle/colonia para el primer mensaje de oferta a un repartidor
// (Fase C, Red de Repartidores). Reglas exactas pedidas por el usuario:
//   1. calle y colonia -> "calle, Col. colonia"
//   2. solo calle -> "calle"
//   3. solo colonia -> "Col. colonia"
//   4. ninguna -> "Ubicación pendiente de confirmar" (ubicacionPendiente=true,
//      el llamador decide cómo registrar el caso -- aquí es puro, sin I/O)
//   - nunca "null"/"undefined" literales, nunca comas duplicadas, nunca
//     "Col. Col." (si colonia ya trae el prefijo "Col." se limpia antes de
//     re-anteponerlo), nunca la misma dirección repetida en ambos campos.
// Función pura (sin I/O) para poder probarla exhaustivamente sin base de datos.
const LONGITUD_MAXIMA = 300;

export function formatearUbicacionRepartidor(calle, colonia) {
  const limpiar = (v) => (typeof v === 'string' ? v.trim() : '');
  const c = limpiar(calle);
  let col = limpiar(colonia).replace(/^col\.?\s*/i, '').trim();

  // Evita "X, Col. X" cuando ambos campos traen el mismo valor por error de captura.
  if (c && col && c.toLowerCase() === col.toLowerCase()) col = '';

  let texto = null;
  if (c && col) texto = `${c}, Col. ${col}`;
  else if (c) texto = c;
  else if (col) texto = `Col. ${col}`;

  const ubicacionPendiente = texto === null;
  if (texto && texto.length > LONGITUD_MAXIMA) {
    texto = texto.slice(0, LONGITUD_MAXIMA - 1).trimEnd() + '…';
  }

  return {
    texto: texto || 'Ubicación pendiente de confirmar',
    ubicacionPendiente,
  };
}

// "Tarifa" hoy sigue siendo pedido.total (no existe todavía un cálculo de
// comisión propia del repartidor separado del total que paga el cliente --
// ya documentado como fuera de alcance en el piloto original). Esta función
// solo formatea el valor ya existente, no inventa un cálculo nuevo.
export function formatearTarifaRepartidor(monto) {
  const num = Number(monto);
  if (!Number.isFinite(num)) return 'No aplica';
  return `$${num.toFixed(2)} MXN`;
}
