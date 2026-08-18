// ─── Enrutamiento de `nuevo_pedido` en el panel ─────────────────────────────
//
// DOS COSAS QUE NO SON LO MISMO
//
//   A) PROYECCIÓN DE ESTADO   "este pedido sigue activo y debe estar en el
//                              tablero". Es la verdad operativa.
//   B) EFECTOS TRANSITORIOS   sonido, impresión automática, animación. Son
//                              avisos: molestan si se repiten, pero no son
//                              estado.
//
// La primera versión de este dedupe metió LAS DOS detrás de `reclamar()`, y con
// eso introdujo un defecto peor que el que venía a arreglar: tras un F5, el
// snapshot del servidor llegaba con un `eventId` "ya visto", la proyección no
// corría, y **el tablero quedaba vacío con pedidos activos en cocina**.
//
// La regla, en orden de prioridad:
//
//   1. JAMÁS perder un pedido activo.
//   2. Una sola tarjeta lógica.
//   3. El contador se deriva del estado, no de cuántos mensajes llegaron.
//   4. Los efectos transitorios se dedupean best-effort.
//
// No se finge exactly-once: `localStorage` + DOM + audio + `window.print` no
// forman una transacción. Duplicar un sonido en una frontera de crash es
// preferible a ocultar un pedido.
//
// REPLAY vs LIVE
//
// El servidor marca `replay: true` en el volcado de la reconexión. Eso es una
// distinción SEMÁNTICA y sustituye al heurístico anterior (`panelListo` durante
// los primeros segundos), que además tenía su propio defecto: un pedido REAL
// que entrara en esa ventana se quedaba sin sonido ni impresión por el reloj.
//
//   REPLAY  → siempre proyecta. Nunca suena ni imprime. Es autoritativo: si el
//             servidor lo manda, ese pedido está activo, diga lo que diga el
//             `localStorage` de este navegador. Eso es lo que hace que un F5 y
//             una segunda pestaña reconstruyan el tablero.
//   LIVE    → proyecta, y dispara efectos solo la primera vez para ese eventId.
//             Un LIVE duplicado cuya tarjeta ya fue retirada NO resucita: el
//             operador ya lo despachó.
//
// MARCAR DESPUÉS DE PROYECTAR
//
// El `eventId` se anota cuando el estado ya está aplicado. Al revés, una
// excepción entre marcar y proyectar dejaba el evento "procesado" y el pedido
// invisible para siempre.

(function (global) {
  'use strict';

  /**
   * Enruta un mensaje `nuevo_pedido`.
   *
   * `deps` son las piezas del panel, inyectadas para poder probar este mismo
   * archivo fuera del navegador:
   *   · upsertPedido(pedido)      proyecta el estado. Idempotente.
   *   · notificar(pedido, edge)   sonido + impresión automática.
   *   · guardarCuentaFinal(t)     deja la última cuenta recuperable.
   *   · notificarCuentaFinal(t,e) sonido + impresión del ticket.
   *   · estaEnTablero(folio)      ¿la tarjeta sigue visible?
   *   · dedupe                    registro durable (puede ser null).
   *   · alFallar(err, msg)        se llama si la proyección revienta.
   */
  function manejarEventoPedido(msg, deps) {
    if (!msg || msg.tipo !== 'nuevo_pedido') return { ignorado: true };

    var esReplay = msg.replay === true;
    var esCuenta = msg.pedido && msg.pedido.tipo_comanda === 'cuenta_final';
    var dedupe = deps.dedupe || null;
    var eventId = msg.eventId || null;
    // Sin `eventId` no se dedupea nada: mejor un aviso repetido que silenciar
    // un pedido real por una clave que el servidor no supo construir.
    var yaVisto = !!(dedupe && eventId && dedupe.yaVisto(eventId));

    // ── LIVE duplicado sobre una tarjeta ya retirada ───────────────────────
    // El operador lo despachó y llega un reenvío viejo. No resucita. Un REPLAY
    // sí lo haría: ahí manda el servidor, no la memoria del navegador.
    if (!esReplay && yaVisto && !esCuenta &&
        typeof deps.estaEnTablero === 'function' &&
        !deps.estaEnTablero(msg.pedido && msg.pedido.id)) {
      return { proyectado: false, notificado: false, motivo: 'live_duplicado_despachado' };
    }

    var proyectado = false;
    try {
      // ── A) ESTADO ────────────────────────────────────────────────────────
      // Siempre, y antes que nada. No consulta el dedupe.
      if (esCuenta) {
        if (typeof deps.guardarCuentaFinal === 'function') deps.guardarCuentaFinal(msg.pedido);
      } else if (typeof deps.upsertPedido === 'function') {
        deps.upsertPedido(msg.pedido);
      }
      proyectado = true;
    } catch (e) {
      // La proyección falló: el evento NO queda marcado, para que un reintento
      // -- o la próxima reconexión -- lo vuelva a aplicar. Y no se traga.
      if (typeof deps.alFallar === 'function') deps.alFallar(e, msg);
      return { proyectado: false, notificado: false, error: e };
    }

    // ── B) EFECTOS TRANSITORIOS ────────────────────────────────────────────
    var notificar = !esReplay && !yaVisto;
    if (notificar) {
      try {
        if (esCuenta) {
          if (typeof deps.notificarCuentaFinal === 'function') {
            deps.notificarCuentaFinal(msg.pedido, msg.impresionEdge === true);
          }
        } else if (typeof deps.notificar === 'function') {
          deps.notificar(msg.pedido, msg.impresionEdge === true);
        }
      } catch (e) {
        // Un fallo del sonido o del diálogo de impresión no puede tirar el
        // estado, que ya está aplicado.
        if (typeof deps.alFallar === 'function') deps.alFallar(e, msg);
      }
    }

    // Se marca AL FINAL, con el estado ya aplicado.
    if (dedupe && eventId && !yaVisto) dedupe.marcar(eventId);

    return { proyectado: proyectado, notificado: notificar, replay: esReplay };
  }

  global.XaborTableroEventos = { manejarEventoPedido: manejarEventoPedido };
})(typeof window !== 'undefined' ? window : globalThis);
