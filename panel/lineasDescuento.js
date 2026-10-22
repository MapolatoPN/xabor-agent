// Líneas de descuento del ticket del cliente.
//
// Por qué existe: el ticket decía «Descuento −$390» aunque el pedido llevara el
// «Miercoles de Chilaquiles» (y si además había un descuento manual, los dos
// salían sumados en una sola línea con el motivo del manual). Decisión de Mario
// (22-oct-2026): una línea por promoción con su nombre, y el manual aparte con
// su motivo.
//
// Reglas:
//   · Las promociones salen de `descuentos.promociones` (desglose del servidor)
//     o, si no está, de `promociones` (el snapshot del pedido).
//   · El manual es lo que queda del descuento total (`descuento`) después de
//     las promociones, con `motivo_descuento`. Así cuadra también con lo que el
//     panel guarda en memoria justo después de cobrar.
//   · Si las promociones suman más que el descuento total, algo no cuadra: se
//     imprime la línea de siempre. El ticket nunca imprime montos que no suman.
//   · Rewards no se toca aquí: queda como estaba.
//
// Lo usa ticketHTML de index.html. Es una función pura, sin DOM, para poder
// usarla también fuera del navegador.
(function (global) {
  'use strict';

  function centavos(v) { return Math.round((parseFloat(v) || 0) * 100) / 100; }

  function lineaManual(p, monto) {
    const motivo = p && p.motivo_descuento ? String(p.motivo_descuento) : '';
    return { etiqueta: motivo ? 'Descuento (' + motivo + ')' : 'Descuento', monto: monto };
  }

  function lineas(p) {
    const total = centavos(p && p.descuento);
    if (!(total > 0)) return [];
    const legado = [lineaManual(p, total)];
    const desglose = p.descuentos && Array.isArray(p.descuentos.promociones) && p.descuentos.promociones.length
      ? p.descuentos.promociones.map(function (x) { return { nombre: x && x.nombre, monto: centavos(x && x.monto) }; })
      : (Array.isArray(p.promociones)
        ? p.promociones.map(function (x) { return { nombre: x && x.nombre, monto: centavos(x && x.descuento) }; })
        : []);
    const promos = desglose
      .filter(function (x) { return x.monto > 0; })
      .map(function (x) { return { etiqueta: x.nombre ? String(x.nombre) : 'Promoción', monto: x.monto }; });
    if (!promos.length) return legado;
    const suma = centavos(promos.reduce(function (s, x) { return s + x.monto; }, 0));
    if (suma > total + 0.01) return legado;
    const manual = centavos(total - suma);
    return manual > 0 ? promos.concat([lineaManual(p, manual)]) : promos;
  }

  global.XaborLineasDescuento = { lineas: lineas };
})(typeof window !== 'undefined' ? window : globalThis);
