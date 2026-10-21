// ─── El ticket del cliente: uno solo ─────────────────────────────────────────
//
// Al cobrar, al corregir con ✏️ Pago y con el botón 🧾, el panel llega a
// imprimirTicketCliente() de index.html, y de ahí aquí. Decisión de Mario
// (21-oct-2026): el ticket automático y el manual son EL MISMO.
//
// Cada minuto se pregunta al servidor si el negocio imprime el ticket por el
// Edge (Caja con Xabor Edge 1.2 o más, conectada). Si no, index.html abre la
// ventana del navegador en el MISMO clic, como siempre: esperar a la red antes
// de abrirla haría que el navegador la pudiera bloquear. Si sí, se le pide al
// servidor (POST /api/pedidos/:folio/ticket); y si justo en ese momento ya no
// se puede (equipo apagado, sin red), sale con el navegador: un ticket nunca
// se queda sin salir.
//
// Vive en su propio archivo para tocar lo menos posible index.html, que es
// componente protegido; index.html lo carga con ?v=<huella>.
(function () {
  'use strict';

  var aviso = function (texto, opciones) {
    if (typeof window.avisoPanel === 'function') window.avisoPanel(texto, opciones || {});
  };
  var corto = function (folio) { return typeof window.folioCorto === 'function' ? window.folioCorto(folio) : folio; };
  // Uno por toque: si la red reintenta, el servidor no saca dos del mismo toque.
  var intento = function () {
    try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch (e) { /* abajo */ }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  };

  // `respaldo()` imprime con el navegador y devuelve false si el navegador
  // bloqueó la ventana. Devuelve una promesa con true si salió por algún lado.
  async function imprimir(folio, respaldo) {
    var r = null, datos = {};
    try {
      r = await window.apiFetch('/api/pedidos/' + encodeURIComponent(folio) + '/ticket', {
        method: 'POST', body: JSON.stringify({ intento: intento() }),
      });
      datos = await r.json().catch(function () { return {}; });
    } catch (e) { r = null; }

    if (r && r.ok && datos.porEdge) {
      var donde = (datos.impresoras || []).join(', ');
      if (!donde && (datos.enEspera || []).length) {
        aviso(corto(folio) + ': la impresora de Caja no está conectada. El ticket saldrá en cuanto vuelva.', { error: true, ms: 20000 });
      } else {
        aviso('🧾 ' + corto(folio) + ': ticket enviado a ' + (donde || 'Caja') + '.', { ms: 4000 });
      }
      return true;
    }

    // Sin Edge para tickets, o no se pudo preguntar: el navegador, como antes.
    var salio = false;
    try { salio = respaldo() === true; } catch (e) { salio = false; }
    if (!salio) {
      aviso(corto(folio) + ': el navegador bloqueó la ventana del ticket. Permite las ventanas emergentes de este sitio y vuelve a imprimirlo con 🧾 Ticket.', { error: true, ms: 30000 });
    }
    return salio;
  }

  var porEdge = false;
  async function refrescar() {
    if (typeof window.apiFetch !== 'function') return porEdge;
    try {
      var r = await window.apiFetch('/api/impresion/ticket-por-edge');
      var d = await r.json().catch(function () { return {}; });
      porEdge = r.ok && d.porEdge === true;
    } catch (e) { /* sin red: se queda como estaba */ }
    return porEdge;
  }
  var empezar = function () { refrescar(); setInterval(refrescar, 60000); };
  if (typeof document !== 'undefined' && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', empezar);
  else setTimeout(empezar, 0);

  window.XaborTicket = { imprimir: imprimir, refrescar: refrescar, get porEdge() { return porEdge; } };
})();
