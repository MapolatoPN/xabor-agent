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

// Línea "Entrega en:" del PRIMER mensaje de oferta (hotfix
// oferta-repartidor): solo colonia y calle -- nunca número, referencias,
// teléfono ni nombre del cliente antes de la aceptación. Formatos exactos:
//   ambas          -> "Col. <colonia>, calle <calle>"
//   solo colonia   -> "Col. <colonia>"
//   solo calle     -> "Calle <calle>"
//   ninguna        -> "Zona por confirmar"
// Nunca "null"/"undefined", comas duplicadas ni "Col. Col.". Pura, sin I/O.
export function formatearEntregaOferta(calle, colonia) {
  const limpiar = v => (typeof v === 'string' ? v.trim() : '');
  let c = limpiar(calle).replace(/^calle\s+/i, '').trim();
  // La calle capturada suele incluir el número exterior ("Av. Tecnológico
  // 123", "Carranza #245 int 2") -- se recorta el número FINAL para no
  // exponerlo antes de la aceptación. Solo si lo que queda sigue siendo un
  // nombre real (contiene letras): "Calle 21" no se vacía.
  const sinNumero = c.replace(/[\s,]*(?:#|n[oº]\.?|num\.?|n[uú]mero)?\s*\d+\s*[a-z]?(?:\s*(?:int(?:erior)?|ext(?:erior)?|depto\.?|local)\.?\s*\S*)?\s*$/i, '').trim();
  if (sinNumero && /[a-záéíóúñ]/i.test(sinNumero)) c = sinNumero;
  let col = limpiar(colonia).replace(/^col\.?\s*/i, '').trim();
  if (c && col && c.toLowerCase() === col.toLowerCase()) col = '';
  if (c && col) return `Col. ${col}, calle ${c}`;
  if (col) return `Col. ${col}`;
  if (c) return `Calle ${c}`;
  return 'Zona por confirmar';
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
