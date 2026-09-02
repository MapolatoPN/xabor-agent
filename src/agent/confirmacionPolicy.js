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
//   prevFingerprint/nuevoFingerprint: huella del CONTENIDO canónico (productos,
//     cantidades, grupo:opción de cada modificador, modalidad, forma de pago).
//     Dos pedidos distintos pueden costar lo mismo — cambiar la salsa Verde por
//     Roja no mueve el total —, así que la igualdad de total NUNCA basta para
//     dar por hecho que es el mismo pedido que el cliente aprobó. Si falta
//     alguna huella se compara solo el total (compatibilidad con llamadores
//     antiguos); el camino de WhatsApp siempre las pasa.
/**
 * Huella estable del CONTENIDO canónico de una orden. Es identidad/versionado,
 * NUNCA una fuente económica: el precio siempre lo calcula el pipeline.
 *
 * Debe variar si cambia el producto, la cantidad, cualquier grupo:opción de
 * modificador, la modalidad o la forma de pago — precisamente porque dos
 * pedidos distintos pueden costar lo mismo y el total no los distingue.
 */
export function huellaOrden(orden) {
  try {
    const base = (orden?.items || []).map((i) => [
      i.producto_id, i.cantidad, i.precio_unitario,
      (i.modificadores || []).map((m) => `${m.grupo_id}:${m.opcion_id}`).sort().join(','),
    ].join('|')).sort().join(';');
    return `${base}#${orden?.modalidad || ''}#${orden?.forma_pago || ''}#${orden?.total ?? ''}`;
  } catch { return ''; }
}

export function decidirConfirmacion({ canal, prevTotal, nuevoTotal, prevFingerprint = null, nuevoFingerprint = null }) {
  const estricto = String(canal || '').toLowerCase() === 'whatsapp';
  const huboPreview = prevTotal != null;
  if (huboPreview) {
    const mismoTotal = Number(prevTotal) === Number(nuevoTotal);
    const mismoContenido = (prevFingerprint == null || nuevoFingerprint == null)
      ? true
      : String(prevFingerprint) === String(nuevoFingerprint);
    if (mismoTotal && mismoContenido) return { accion: 'registrar' };
    return { accion: 'reconfirmar_cambio' };
  }
  if (estricto) return { accion: 'preview_requerido' };
  return { accion: 'registrar' };
}
