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
// Desde el bloque 2 se guarda en la base (limitesPersistentes.js, migración
// 145): un despliegue ya no lo reinicia. La toma es atómica en la base.
import { tomarLugares, usados } from './limitesPersistentes.js';

export const UNA_HORA_MS = 60 * 60 * 1000;

export function crearLimiteAltas({ limite, ventanaMs = UNA_HORA_MS }) {
  if (!Number.isInteger(limite) || limite <= 0) throw new Error('crearLimiteAltas: limite debe ser un entero positivo');
  return {
    limite,
    /**
     * Toma un lugar. Resuelve null si ya no hay, o una función async que lo
     * devuelve (para cuando el pedido no se creó o era un reintento).
     * Devolver dos veces no libera dos lugares.
     */
    tomar: (clave) => tomarLugares([{ clave: `altas:${clave}`, limite, ventanaMs }]),
    // Para las pruebas.
    usados: (clave) => usados(`altas:${clave}`, ventanaMs),
  };
}
