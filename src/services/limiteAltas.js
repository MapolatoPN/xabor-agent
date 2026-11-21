// ─── Pedidos creados por hora desde una conexión (Fase 1, bloque 1.4) ───────
//
// Las formas públicas (Temporada, la tienda en línea) no verifican el
// teléfono: cualquiera puede agendar pedidos falsos y apartar el cupo de una
// fecha, o mandar comandas a la cocina. El límite por minuto de rateLimit.js
// frena ráfagas, pero cuenta TODO intento (también un «ese horario ya se
// llenó») y se recupera en un minuto.
//
// Este límite cuenta solo los pedidos que SÍ se crearon, en una hora. Un
// cliente que se equivoca y reintenta no gasta nada; quien agenda en serie
// desde una misma conexión se topa con él. Un reintento del mismo pedido
// (doble clic, misma clave de envío) tampoco cuenta: no crea otro.
//
// El lugar se TOMA antes de crear y se DEVUELVE si no se creó nada. Así dos
// peticiones simultáneas no pasan las dos con el último lugar.
//
// En memoria del proceso, como rateLimit.js: un despliegue lo reinicia. Pasar
// los límites a la base es del bloque 2.
export const UNA_HORA_MS = 60 * 60 * 1000;

export function crearLimiteAltas({ limite, ventanaMs = UNA_HORA_MS, reloj = () => Date.now() }) {
  if (!Number.isInteger(limite) || limite <= 0) throw new Error('crearLimiteAltas: limite debe ser un entero positivo');
  const altas = new Map(); // clave -> [{ t }]
  const vigentes = (clave) => {
    const ahora = reloj();
    const lista = (altas.get(clave) || []).filter((a) => ahora - a.t < ventanaMs);
    if (lista.length) altas.set(clave, lista); else altas.delete(clave);
    return lista;
  };
  return {
    limite,
    /**
     * Toma un lugar. Devuelve null si ya no hay, o una función que lo
     * devuelve (para cuando el pedido no se creó o era un reintento).
     */
    tomar(clave) {
      const lista = vigentes(clave);
      if (lista.length >= limite) return null;
      const alta = { t: reloj() };
      lista.push(alta);
      altas.set(clave, lista);
      // Devolver dos veces no libera dos lugares: la segunda ya no la encuentra.
      return () => {
        const l = altas.get(clave);
        if (!l) return;
        const i = l.indexOf(alta);
        if (i >= 0) l.splice(i, 1);
        if (!l.length) altas.delete(clave);
      };
    },
    // Para las pruebas.
    usados: (clave) => vigentes(clave).length,
  };
}
