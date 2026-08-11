// Quién imprime un pedido: Edge o el navegador. Nunca los dos.
//
// Esta es la ÚNICA autoridad que responde esa pregunta, y vive en el
// servidor a propósito. El panel no la puede calcular: no sabe si hay un
// Edge conectado, ni si el negocio tiene una impresora para 'comanda', ni si
// el trabajo llegó a crearse. Cuando lo decidía el navegador, cada pestaña
// abierta decidía por su cuenta -- y dos pestañas eran dos papeles.
//
// La respuesta es un hecho comprobable, no una configuración: `true`
// significa "se creó al menos un trabajo de impresión para este pedido". Si
// el routing no encontró destino, si no hay sucursal, si la base falló --
// cualquier cosa que impida que salga papel por Edge -- la respuesta es
// `false` y el navegador sigue imprimiendo exactamente como hasta hoy. Un
// negocio sin Edge no nota ningún cambio.
import { crearTrabajosDePedido } from '../services/impresionService.js';

// La entrega al Edge conectado necesita el WebSocket, que vive en server.js.
// Mismo patrón de inyección que setWsBroadcast/setBroadcastsImpresion: este
// módulo no importa server.js (sería un ciclo) y falla cerrado si nadie la
// inyectó -- sin entregar, el trabajo queda 'pendiente' en la nube y se
// recupera cuando el Edge reconecte, que es justo lo que debe pasar.
let _entregarTrabajos = null;
export function setEntregaEdge(fn) {
  if (typeof fn !== 'function') throw new Error('setEntregaEdge: se requiere una función');
  _entregarTrabajos = fn;
}

// Exclusiva para pruebas: permite volver al estado sin inyectar.
export function _resetEntregaEdgeParaPruebas() { _entregarTrabajos = null; }

/**
 * Crea los trabajos Edge de un pedido y los entrega si hay alguien escuchando.
 *
 * Nunca lanza: un fallo de impresión no puede tumbar la creación de un
 * pedido. El pedido manda; el papel es una consecuencia.
 *
 * @returns {Promise<{seHizoCargo: boolean, trabajos: number, avisos: string[]}>}
 */
export async function emitirComandaDePedidoPorEdge(pedido) {
  const vacio = { seHizoCargo: false, trabajos: 0, avisos: [] };
  if (pedido === null || typeof pedido !== 'object') return vacio;
  if (typeof pedido.negocioId !== 'string' || !pedido.negocioId.trim()) return vacio;

  try {
    const r = await crearTrabajosDePedido({ negocioId: pedido.negocioId.trim(), pedido });

    // Los duplicados NO cuentan como "se hizo cargo por primera vez", pero sí
    // como "Edge ya tiene este pedido": si el mismo folio se reemite, el papel
    // ya salió (o está en cola) y el navegador tampoco debe imprimirlo. Esa es
    // la garantía de idempotencia vista desde el panel.
    const total = r.creados.length + r.duplicados.length;
    if (total > 0 && r.creados.length > 0 && typeof _entregarTrabajos === 'function') {
      await _entregarTrabajos(r.creados);
    }
    return { seHizoCargo: total > 0, trabajos: r.creados.length, avisos: r.avisos };
  } catch (e) {
    // Si ni siquiera se pudo intentar, el navegador es el respaldo. Callarlo
    // sería peor: dejaría al restaurante sin comanda y sin explicación.
    console.error(`[Impresion] Edge no pudo hacerse cargo del pedido ${pedido.id ?? '-'}: ${e.message}`);
    return vacio;
  }
}
