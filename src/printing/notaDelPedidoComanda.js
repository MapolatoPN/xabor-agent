// ─── La nota del pedido en la comanda ───────────────────────────────────────
//
// La NOTA DEL PEDIDO (dedicatoria o indicaciones que el cliente escribe en el
// formulario de WhatsApp, `pedido.notas`, contrato nota_v1) va al inicio de la
// nota del PRIMER artículo de cada papel. Es el mismo truco que «CAMBIO DE:»
// en impresionService: el renderer del Edge instalado en el negocio ya imprime
// la nota de un artículo en grande y negritas, y no se actualiza con un
// despliegue (lo pinta la PC del negocio). Con esto sale en cuanto se despliega
// el servidor.
//
// Cada papel la lleva: una estación que solo recibe su parte también tiene que
// saber del «Feliz cumpleaños». Solo canal whatsapp: el POS y la tienda usan
// `notas` del pedido para otras cosas y siguen imprimiendo como siempre.
//
// Módulo puro (sin base): el servidor lo usa al armar el payload y el chequeo
// previo al despliegue lo prueba sin Postgres.
export const PREFIJO_NOTA_DEL_PEDIDO = 'NOTA DEL PEDIDO: ';

/** Agrega la nota del pedido al primer artículo del payload (lo modifica y lo devuelve). */
export function conNotaDelPedido(payload, pedido) {
  // Controles fuera y una sola línea: es texto del cliente camino al papel.
  const nota = pedido?.canal === 'whatsapp' && typeof pedido.notas === 'string'
    ? pedido.notas.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const primero = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!nota || !primero) return payload;
  const texto = `${PREFIJO_NOTA_DEL_PEDIDO}${nota}`;
  // Sin duplicarla si ya la trae (un payload armado otra vez sobre sí mismo).
  if (!String(primero.notas || '').includes(texto)) primero.notas = [texto, primero.notas].filter(Boolean).join(' · ');
  return payload;
}
