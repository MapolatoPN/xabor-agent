// ─── Dedupe de eventos en el panel ──────────────────────────────────────────
//
// El backend no puede prometer que `nuevo_pedido` salga una sola vez: entre el
// envío por WebSocket y la marca durable de derivación hay una ventana, y un
// proceso que muere ahí obliga al retry a reemitir. Tampoco el volcado de la
// reconexión, que reenvía todo lo activo.
//
// Lo que sí se puede prometer es UN SOLO EFECTO LÓGICO por pedido: una tarjeta,
// un sonido, un incremento de contador, una impresión. Este módulo es quien lo
// promete, y lo hace mirando el `eventId` determinístico que manda el servidor.
//
// POR QUÉ NO BASTA UN Set() EN MEMORIA
//
// Un Set se pierde al recargar la pestaña, y el volcado de la reconexión vuelve
// a mandar todo. El registro vive en `localStorage`: sobrevive al F5, al cierre
// del navegador y al reinicio del equipo. El Set en memoria se conserva encima
// como caché, para no tocar el almacenamiento en cada mensaje.
//
// POR QUÉ NO HACE FALTA UNA TABLA NUEVA
//
// El efecto que se está protegiendo es del CONSUMIDOR: lo que este panel ya
// mostró. Persistirlo en el servidor no ayudaría -- dos panels abiertos deben
// ver el pedido cada uno --, y la identidad determinística ya garantiza que el
// mismo pedido produzca la misma clave aunque lo emita otra instancia o se
// recupere mañana. Por eso la durabilidad correcta es la del navegador.
//
// AISLAMIENTO
//
// La clave del servidor ya lleva el negocio (`nuevo_pedido:<negocioId>:<folio>`)
// y además el almacenamiento se separa por negocio. Dos negocios con el mismo
// folio no se pisan ni se silencian entre sí.

(function (global) {
  'use strict';

  var LIMITE = 500;              // eventos recordados por negocio
  var VIDA_MS = 72 * 60 * 60e3;  // 72 h: más que cualquier turno de cocina

  function almacen() {
    try {
      if (global.localStorage) return global.localStorage;
    } catch (e) { /* modo privado, iframe con storage bloqueado */ }
    return null;
  }

  function clave(negocioId) {
    return 'xabor:eventos-vistos:' + (negocioId || 'sin-negocio');
  }

  function leer(negocioId) {
    var s = almacen();
    if (!s) return {};
    try {
      var crudo = s.getItem(clave(negocioId));
      var obj = crudo ? JSON.parse(crudo) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }

  function escribir(negocioId, mapa) {
    var s = almacen();
    if (!s) return;
    try { s.setItem(clave(negocioId), JSON.stringify(mapa)); }
    catch (e) { /* cuota llena: el dedupe en memoria sigue funcionando */ }
  }

  // Poda: por antigüedad primero y por tamaño después. Sin esto el
  // almacenamiento crecería sin límite en un negocio con años de pedidos.
  function podar(mapa, ahora) {
    var claves = Object.keys(mapa);
    var vivos = {};
    for (var i = 0; i < claves.length; i++) {
      var t = Number(mapa[claves[i]]);
      if (Number.isFinite(t) && ahora - t < VIDA_MS) vivos[claves[i]] = t;
    }
    var restantes = Object.keys(vivos);
    if (restantes.length <= LIMITE) return vivos;
    restantes.sort(function (a, b) { return vivos[a] - vivos[b]; });
    var sobran = restantes.length - LIMITE;
    for (var j = 0; j < sobran; j++) delete vivos[restantes[j]];
    return vivos;
  }

  function crear(negocioId, opciones) {
    var ahoraFn = (opciones && opciones.ahora) || function () { return Date.now(); };
    var memoria = null;

    function cargar() {
      if (memoria) return memoria;
      memoria = podar(leer(negocioId), ahoraFn());
      return memoria;
    }

    return {
      /**
       * ¿Este evento ya produjo su efecto?
       *
       * Un evento SIN `eventId` nunca se considera visto: es preferible un
       * efecto repetido a silenciar un pedido real por una clave que el
       * servidor no supo construir.
       */
      yaVisto: function (eventId) {
        if (!eventId) return false;
        return Object.prototype.hasOwnProperty.call(cargar(), eventId);
      },

      /** Lo marca como procesado, de forma durable. */
      marcar: function (eventId) {
        if (!eventId) return;
        var mapa = cargar();
        mapa[eventId] = ahoraFn();
        memoria = podar(mapa, ahoraFn());
        escribir(negocioId, memoria);
      },

      /**
       * Atajo del camino real: devuelve true la PRIMERA vez y false siempre
       * después. Reclamar y marcar en un solo paso evita el hueco entre
       * comprobar y anotar.
       */
      reclamar: function (eventId) {
        if (!eventId) return true;          // sin identidad, no se dedupea
        if (this.yaVisto(eventId)) return false;
        this.marcar(eventId);
        return true;
      },

      /** Solo para pruebas y para el borrado de sesión. */
      olvidarTodo: function () {
        memoria = {};
        var s = almacen();
        if (s) { try { s.removeItem(clave(negocioId)); } catch (e) { /* noop */ } }
      },

      /** Cuántos eventos recuerda ahora mismo. */
      tamano: function () { return Object.keys(cargar()).length; },
    };
  }

  global.XaborDedupeEventos = { crear: crear, LIMITE: LIMITE, VIDA_MS: VIDA_MS };
})(typeof window !== 'undefined' ? window : globalThis);
