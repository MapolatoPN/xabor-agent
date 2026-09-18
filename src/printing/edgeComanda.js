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
//
// Y la respuesta deja RASTRO: `datos.impresion_edge` en el pedido dice qué
// trabajos se crearon, para qué impresoras, qué ítems se quedaron sin ruta y
// con qué avisos. Cuando un negocio con impresoras activas recibe una
// comanda que termina con cero trabajos, eso no es "enviado": es un error
// que se registra y se avisa al panel. Antes caía en silencio al navegador,
// y si el navegador no estaba abierto, nadie se enteraba.
import {
  crearTrabajosDePedido, resumirImpresionDePedido, guardarEstadoImpresionPedido, negocioTieneImpresorasActivas,
} from '../services/impresionService.js';

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

// Aviso al panel cuando una comanda se queda sin papel. Misma inyección:
// server.js presta su broadcast por negocio. Sin inyección no se avisa a
// nadie, pero el rastro en el pedido y el log de error salen igual.
let _avisar = null;
export function setAvisoImpresionEdge(fn) {
  if (typeof fn !== 'function') throw new Error('setAvisoImpresionEdge: se requiere una función');
  _avisar = fn;
}
export function _resetAvisoImpresionEdgeParaPruebas() { _avisar = null; }

/**
 * Crea los trabajos Edge de un pedido y los entrega si hay alguien escuchando.
 *
 * Nunca lanza: un fallo de impresión no puede tumbar la creación de un
 * pedido. El pedido manda; el papel es una consecuencia.
 *
 * @returns {Promise<{seHizoCargo: boolean, trabajos: number, avisos: string[], resumen: object|null}>}
 */
export async function emitirComandaDePedidoPorEdge(pedido) {
  const vacio = { seHizoCargo: false, trabajos: 0, avisos: [], resumen: null };
  if (pedido === null || typeof pedido !== 'object') return vacio;
  if (typeof pedido.negocioId !== 'string' || !pedido.negocioId.trim()) return vacio;
  const negocioId = pedido.negocioId.trim();

  try {
    const r = await crearTrabajosDePedido({ negocioId, pedido });

    // Los duplicados NO cuentan como "se hizo cargo por primera vez", pero sí
    // como "Edge ya tiene este pedido": si el mismo folio se reemite, el papel
    // ya salió (o está en cola) y el navegador tampoco debe imprimirlo. Esa es
    // la garantía de idempotencia vista desde el panel.
    const total = r.creados.length + r.duplicados.length;
    if (total > 0 && r.creados.length > 0 && typeof _entregarTrabajos === 'function') {
      await _entregarTrabajos(r.creados);
    }
    const resumen = await dejarRastro(negocioId, pedido, r);
    return { seHizoCargo: total > 0, trabajos: r.creados.length, avisos: r.avisos, resumen };
  } catch (e) {
    // Si ni siquiera se pudo intentar, el navegador es el respaldo. Callarlo
    // sería peor: dejaría al restaurante sin comanda y sin explicación.
    console.error(`[Impresion] Edge no pudo hacerse cargo del pedido ${pedido.id ?? '-'}: ${e.message}`);
    const resumen = await dejarRastro(negocioId, pedido, {
      creados: [], duplicados: [], sinRuta: [], avisos: [e.message], error: e.code || 'ERROR_IMPRESION',
    });
    return { ...vacio, resumen };
  }
}

// El rastro durable y el aviso. Nunca lanza: si no se pudo guardar, se
// registra y el pedido sigue su camino -- el papel (o su falta) ya ocurrió.
async function dejarRastro(negocioId, pedido, r) {
  const resumen = resumirImpresionDePedido(r);
  const folio = typeof pedido.id === 'string' && pedido.id ? pedido.id : null;
  try {
    if (resumen.estado === 'sin_trabajos' || resumen.estado === 'error') {
      // Sin impresoras activas no es una anomalía: ese negocio imprime desde
      // el navegador (o no imprime) y así lo decidió. Con impresoras, sí lo es.
      resumen.alerta = await negocioTieneImpresorasActivas(negocioId).catch(() => false);
    }
    if (folio) {
      await guardarEstadoImpresionPedido(negocioId, folio, resumen);
      // El evento `nuevo_pedido` que sigue a esta llamada viaja con ESTE mismo
      // objeto: el panel ve el rastro sin una segunda consulta. La copia en
      // memoria del tablero (la que se vuelca al reconectar) se actualiza
      // aparte; el import es dinámico porque orderManager importa este módulo.
      pedido.impresion_edge = resumen;
      try {
        const { obtenerPedidoPorId } = await import('../orders/orderManager.js');
        const enMemoria = obtenerPedidoPorId(folio, negocioId);
        if (enMemoria && enMemoria !== pedido) enMemoria.impresion_edge = resumen;
      } catch { /* sin tablero en memoria (pruebas unitarias): el rastro durable basta */ }
    }
    if (resumen.alerta) {
      const detalle = resumen.sin_ruta.length
        ? `sin impresora para: ${resumen.sin_ruta.join(', ')}`
        : (resumen.avisos.join(' | ') || 'sin avisos del motor');
      console.error(`[Impresion] COMANDA SIN PAPEL: el pedido ${folio ?? '-'} del negocio ${negocioId} no generó ningún trabajo para Edge (${resumen.estado}; ${detalle}). El negocio tiene impresoras activas: revisar reglas de destino.`);
      if (typeof _avisar === 'function') {
        _avisar(negocioId, {
          tipo: 'impresion_sin_trabajo', folio, estado: resumen.estado,
          sinRuta: resumen.sin_ruta, avisos: resumen.avisos,
        });
      }
    }
  } catch (e) {
    console.error(`[Impresion] no se pudo dejar rastro de impresión del pedido ${folio ?? '-'}: ${e.message}`);
  }
  return resumen;
}
