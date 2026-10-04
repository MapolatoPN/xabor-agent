// Orden de la lista de Chats del panel (GET /api/conversaciones).
//
// Hasta el 3-oct-2026 la lista ponía PRIMERO las conversaciones en revisión,
// de la más vieja a la más nueva y con tope de 20, y después las recientes.
// En Mapolato Obispado se juntaron 26 en revisión en tres días, así que las
// 20 filas de arriba eran chats de hace 1 a 3 días, el cliente que escribía
// en ese momento quedaba en la fila 21 (fuera de la pantalla) y el panel
// «no se actualizaba». Peor: el tope se quedaba con las 20 MÁS VIEJAS, y las
// 6 revisiones de ese día salían entre las recientes sin su aviso.
//
// Ahora la lista va como en cualquier mensajería: la conversación con el
// mensaje más reciente arriba. Las que están en revisión conservan su marca
// (`requiereRevision`) en su lugar, y ninguna se pierde por el tope: entran
// todas las que devuelva la consulta de revisión, más las recientes que no
// estén ya entre ellas.
//
// `revisiones` y `recientes` son filas { telefono, nombre, texto, direccion,
// timestamp, requiereRevision? } tal como salen de la base.
export function ordenarBandejaChats(revisiones = [], recientes = []) {
  const enRevision = new Set(revisiones.map((r) => r.telefono));
  const filas = [...revisiones, ...recientes.filter((r) => !enRevision.has(r.telefono))];
  const ms = (r) => {
    const t = r?.timestamp instanceof Date ? r.timestamp.getTime() : Date.parse(r?.timestamp);
    return Number.isFinite(t) ? t : -Infinity; // sin mensajes: al final
  };
  return filas
    .map((fila, i) => ({ fila, i }))
    .sort((a, b) => (ms(b.fila) - ms(a.fila)) || (a.i - b.i))
    .map(({ fila }) => fila);
}
