// Vista previa de promociones en el carrito del POS (mostrador y envíos).
//
// Por qué existe: la promoción automática se aplica al CREAR el pedido, en el
// servidor, y hasta entonces el carrito mostraba el precio completo. Quien
// atiende le decía al cliente un total que no era el que iba a pagar. Aquí se
// le pregunta al servidor —POST /api/pos/promociones/previsualizar, el mismo
// motor que el alta— qué promoción le tocaría al carrito tal como está.
//
// Reglas:
//   · Es solo pantalla. El total que vale lo fija el servidor al crear.
//   · Espera a que el carrito deje de moverse (`esperaMs`) y descarta las
//     respuestas viejas: solo se pinta la del carrito que se está viendo.
//   · Si la consulta falla o tarda más de `limiteMs`, no hay vista previa y
//     el carrito se ve como antes. Nunca bloquea la captura.
//   · Un resultado (bueno o fallido) se recuerda por carrito: repintar no
//     vuelve a preguntar mientras el carrito no cambie.
(function (global) {
  'use strict';

  function firma(payload) {
    try { return JSON.stringify(payload); } catch (e) { return ''; }
  }

  function crear(opciones) {
    const pedir = opciones && opciones.pedir;
    const esperaMs = (opciones && opciones.esperaMs) != null ? opciones.esperaMs : 350;
    const limiteMs = (opciones && opciones.limiteMs) != null ? opciones.limiteMs : 1200;
    let actual = null;      // { firma, resultado } del último carrito respondido
    let pendiente = null;   // firma esperando o en vuelo
    let temporizador = null;
    let controlador = null;
    let turno = 0;

    function cancelar() {
      if (temporizador) { clearTimeout(temporizador); temporizador = null; }
      if (controlador) { try { controlador.abort(); } catch (e) { /* ya terminó */ } controlador = null; }
    }

    // El resultado de ESTE carrito, o null si no hay (todavía, o falló).
    function ultimo(payload) {
      const f = firma(payload);
      return actual && actual.firma === f ? actual.resultado : null;
    }

    // Pide la vista previa de este carrito si hace falta. `alListo` se llama
    // con el resultado (o null) solo si el carrito no cambió mientras tanto.
    function consultar(payload, alListo) {
      const f = firma(payload);
      if (!f || typeof pedir !== 'function') return null;
      if (actual && actual.firma === f) return actual.resultado;
      if (pendiente === f) return null;
      cancelar();
      pendiente = f;
      const miTurno = ++turno;
      temporizador = setTimeout(async function () {
        temporizador = null;
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        controlador = ctl;
        let vencido = false;
        const limite = setTimeout(function () {
          vencido = true;
          if (ctl) { try { ctl.abort(); } catch (e) { /* nada */ } }
        }, limiteMs);
        let resultado = null;
        try {
          const r = await pedir(payload, ctl ? ctl.signal : undefined);
          if (!vencido && r && r.ok !== false) resultado = r;
        } catch (e) {
          resultado = null;
        } finally {
          clearTimeout(limite);
        }
        if (miTurno !== turno) return;   // el carrito cambió: esta ya no se pinta
        pendiente = null;
        controlador = null;
        actual = { firma: f, resultado: resultado };
        if (typeof alListo === 'function') {
          try { alListo(resultado); } catch (e) { /* el dibujo no tumba la captura */ }
        }
      }, esperaMs);
      return null;
    }

    function olvidar() { turno++; cancelar(); pendiente = null; actual = null; }

    return { consultar: consultar, ultimo: ultimo, olvidar: olvidar };
  }

  // Texto del aviso «falta 1 para el 2x1». Sin nombres de producto, se dice
  // solo con el de la promoción.
  function textoOportunidad(o) {
    if (!o || !(o.unidadesFaltantes > 0)) return '';
    const productos = Array.isArray(o.productos) && o.productos.length ? ' de ' + o.productos.join(' o ') : '';
    return 'Agrega ' + o.unidadesFaltantes + ' más' + productos + ' y aplica «' + (o.nombre || 'la promoción') + '»';
  }

  global.XaborPromoCarrito = { crear: crear, firma: firma, textoOportunidad: textoOportunidad };
})(typeof window !== 'undefined' ? window : globalThis);
