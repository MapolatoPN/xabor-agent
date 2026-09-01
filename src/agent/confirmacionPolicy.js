// Política PURA de confirmación de pedidos (sin dependencias de I/O), para que
// el enforcement sea testeable en aislamiento y no dependa del prompt.
//
// Invariante: el cliente NUNCA confirma un total que no vio calculado por Xabor.
// En WhatsApp es ESTRICTO — sin un preview oficial previo (o si se perdió por
// reinicio del proceso) NO se registra: se genera el preview y se pide confirmar.
// Otros canales (voz/test/api) conservan la confirmación directa por
// compatibilidad con flujos existentes.
//
//   canal:      canal del turno ('whatsapp' | 'voz' | 'test' | 'api' | ...).
//   prevTotal:  total del último preview oficial guardado en sesión (o null).
//   nuevoTotal: total oficial recalculado por el backend para la orden a confirmar.
// Devuelve { accion: 'registrar' | 'reconfirmar_cambio' | 'preview_requerido' }.
export function decidirConfirmacion({ canal, prevTotal, nuevoTotal }) {
  const estricto = String(canal || '').toLowerCase() === 'whatsapp';
  const huboPreview = prevTotal != null;
  if (huboPreview && Number(prevTotal) === Number(nuevoTotal)) return { accion: 'registrar' };
  if (huboPreview) return { accion: 'reconfirmar_cambio' };
  if (estricto) return { accion: 'preview_requerido' };
  return { accion: 'registrar' };
}
