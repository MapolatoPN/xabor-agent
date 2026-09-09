/**
 * rescateConversaciones.js — el cliente que se quedó esperando deja rastro.
 *
 * INCIDENTE QUE LO ORIGINA (2026-09-09, negocio 5de544d8…, cliente ***8357):
 * el bot contestó a las 06:51:36. UN SEGUNDO después alguien del restaurante
 * la saludó a mano desde la app de WhatsApp Business, y ese eco activa
 * `activarTakeoverHumano` — el bot calla 30 minutos en esa conversación. La
 * clienta escribió a las 07:01 y 07:02 pidiendo hotcakes; nadie le contestó
 * hasta las 07:04. Trece minutos.
 *
 * Y nadie se enteró de nada. Desde fuera se veía idéntico a que el bot se
 * había roto: de hecho el restaurante concluyó eso y pausó la automatización
 * que ya llevaba diez minutos pausada sola.
 *
 * Ese es el agujero real de operar sin supervisión: NO es que el bot falle,
 * es que cuando alguien queda esperando no queda rastro. El takeover en sí
 * está bien —una persona atendiendo debe poder tomar la conversación— pero no
 * tiene red: si quien la tomó se distrae, el silencio dura hasta que el plazo
 * vence y nadie lo sabe.
 *
 * Este módulo solo OBSERVA y AVISA. No responde por nadie, no toca el
 * takeover, no escribe en la conversación, no modifica ningún pedido. Si algo
 * aquí falla, el peor caso es que no llegue un aviso -- jamás que se rompa una
 * conversación. Por eso vive aparte de whatsapp-meta.js y de brain.js.
 */

import { pool, obtenerConfiguracion } from './database.js';

/** Minutos que el cliente puede llevar esperando antes de que esto avise. */
export const ESPERA_POR_DEFECTO_MIN = 5;

/**
 * Conversaciones donde el cliente escribió y sigue sin respuesta HUMANA,
 * mientras el takeover mantiene al bot callado.
 *
 * Las tres condiciones importan y ninguna sobra:
 *  · takeover vigente          → el bot no va a contestar, por diseño;
 *  · último mensaje = cliente  → la pelota está del lado del restaurante;
 *  · lleva más de N minutos    → no se avisa por una espera normal.
 */
export async function buscarConversacionesEnEspera(minutos = ESPERA_POR_DEFECTO_MIN) {
  const { rows } = await pool.query(`
    WITH ultimos AS (
      SELECT m.negocio_id, m.telefono,
             MAX(CASE WHEN m.direccion = 'entrante' THEN m."timestamp" END) AS ultimo_cliente,
             MAX(CASE WHEN m.direccion = 'saliente' AND m.origen = 'humano' THEN m."timestamp" END) AS ultimo_humano
        FROM mensajes m
       WHERE m."timestamp" > NOW() - INTERVAL '3 hours'
       GROUP BY m.negocio_id, m.telefono
    )
    SELECT u.negocio_id, u.telefono, u.ultimo_cliente, u.ultimo_humano,
           c.human_takeover_until,
           EXTRACT(EPOCH FROM (NOW() - u.ultimo_cliente))::int AS segundos_esperando
      FROM ultimos u
      JOIN clientes c
        ON c.telefono = u.telefono
       AND (c.negocio_id = u.negocio_id OR c.negocio_id IS NULL)
     WHERE c.human_takeover_until IS NOT NULL
       AND c.human_takeover_until > NOW()
       AND u.ultimo_cliente IS NOT NULL
       AND (u.ultimo_humano IS NULL OR u.ultimo_humano < u.ultimo_cliente)
       AND u.ultimo_cliente < NOW() - ($1 || ' minutes')::interval
     ORDER BY u.ultimo_cliente ASC
  `, [String(Number(minutos) || ESPERA_POR_DEFECTO_MIN)]);
  return rows;
}

/**
 * Un aviso por espera, no uno por minuto.
 *
 * La clave incluye el instante del mensaje que quedó sin responder: si el
 * cliente vuelve a escribir, es una espera NUEVA y vuelve a avisar. Pero
 * mientras sea el mismo mensaje esperando, se avisa una sola vez. Sin esto el
 * job de cada minuto convertiría un aviso útil en ruido que nadie mira, que
 * es la forma más segura de que un aviso deje de servir.
 */
const _avisados = new Map();
export function claveDeAviso(fila) {
  const ts = fila?.ultimo_cliente instanceof Date
    ? fila.ultimo_cliente.toISOString()
    : String(fila?.ultimo_cliente ?? '');
  return `${fila?.negocio_id ?? ''}:${fila?.telefono ?? ''}:${ts}`;
}
export function yaSeAviso(fila) { return _avisados.has(claveDeAviso(fila)); }
export function marcarAvisado(fila) { _avisados.set(claveDeAviso(fila), Date.now()); }
/** Las claves viejas no sirven para nada: se sueltan a las 6 horas. */
export function limpiarAvisos(ahoraMs = Date.now(), ttlMs = 6 * 60 * 60 * 1000) {
  for (const [k, t] of _avisados) if (ahoraMs - t > ttlMs) _avisados.delete(k);
}
/** Solo para pruebas. */
export function reiniciarAvisos() { _avisados.clear(); }

/** Los últimos 4 dígitos y nada más: un aviso no es sitio para un teléfono. */
export function telefonoEnmascarado(telefono) {
  const s = String(telefono || '');
  return s.length >= 4 ? `***${s.slice(-4)}` : '***';
}

export function textoDeAviso(fila) {
  const mins = Math.max(1, Math.round((fila?.segundos_esperando ?? 0) / 60));
  return `⏳ *Cliente esperando*: ${telefonoEnmascarado(fila?.telefono)} escribió hace ${mins} min `
    + `y nadie ha respondido. El bot está en pausa porque alguien tomó la conversación a mano. `
    + `Contéstale desde WhatsApp o reactiva el bot en el panel.`;
}

/**
 * Revisa y avisa. Recibe sus efectos por parámetro para poder probarse sin
 * red ni WhatsApp real: mismo criterio que el resto de servicios de aquí.
 *
 * Nunca lanza: un fallo suyo no puede tumbar el job que lo llama.
 */
export async function revisarConversacionesEnEspera({
  minutos = ESPERA_POR_DEFECTO_MIN,
  enviarAvisoWhatsapp = null,
  broadcastPanel = null,
  log = console.warn,
} = {}) {
  let avisadas = 0;
  try {
    const filas = await buscarConversacionesEnEspera(minutos);
    for (const fila of filas) {
      if (yaSeAviso(fila)) continue;
      marcarAvisado(fila);
      avisadas++;
      log(`[Rescate] evento=cliente_esperando_sin_respuesta negocio=${fila.negocio_id} `
        + `telefono=${telefonoEnmascarado(fila.telefono)} segundos=${fila.segundos_esperando}`);

      // El panel primero: es donde hay alguien mirando ahora mismo.
      if (broadcastPanel) {
        try {
          broadcastPanel(fila.negocio_id, {
            tipo: 'cliente_esperando',
            telefono: telefonoEnmascarado(fila.telefono),
            segundos: fila.segundos_esperando,
          });
        } catch (e) { log(`[Rescate] panel: ${e.message}`); }
      }

      // Y WhatsApp al admin, por si nadie tiene el panel abierto -- que es
      // justamente el caso en el que este aviso hace falta.
      if (enviarAvisoWhatsapp) {
        try {
          const cfg = await obtenerConfiguracion(fila.negocio_id);
          if (cfg?.wa_admin_numero) {
            await enviarAvisoWhatsapp(cfg.wa_admin_numero, textoDeAviso(fila), fila.negocio_id);
          }
        } catch (e) { log(`[Rescate] whatsapp: ${e.message}`); }
      }
    }
    limpiarAvisos();
  } catch (e) {
    log(`[Rescate] revisión fallida (no afecta al bot): ${e.message}`);
  }
  return avisadas;
}
