// La fila de conversacion_estado sigue identificada por teléfono, pero cada
// pedido nuevo usa otra identidad en el libro de operaciones. Así la
// confirmación de ayer no bloquea un pedido legítimo de hoy.
import { estadoNuevo } from './ejecutorDeHerramientas.js';

const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

const pideNuevoPedido = (mensaje) => {
  const t = normalizar(mensaje);
  return /\b(?:nuevo|otro|otra)\s+(?:pedido|orden)\b/.test(t)
    || /\b(?:quiero|quisiera|voy a)\s+(?:hacer\s+)?(?:un\s+)?(?:pedido|orden|pedir|ordenar)\b/.test(t);
};

/**
 * Horas tras las cuales un ciclo terminado deja de gobernar la conversación.
 *
 * Un pedido confirmado ayer no puede impedir uno de hoy. Antes la ÚNICA salida
 * era que el cliente dijera una frase concreta, y el 23-sep eso dejó una
 * conversación real muerta: el estado venía `confirmado` del día 21, el cliente
 * escribió «Quiero unos hotcakes para mañana a las 10» —que no casa con
 * `pideNuevoPedido`, porque después de «quiero» viene «unos hotcakes» y no
 * «pedido»— y el agente contestó el texto de escalado sin llamar a una sola
 * herramienta. Tres intentos seguidos, siempre lo mismo.
 *
 * Seis horas es el mismo corte que ya se usa para separar conversaciones
 * distintas del mismo teléfono: más que una pausa larga dentro de un pedido,
 * menos que un turno de servicio.
 */
export const HORAS_PARA_REABRIR = 6;

export function cicloParaTurno(estado, mensaje, { ahora = new Date() } = {}) {
  // Una confirmación sin resultado conocido requiere conciliación humana.
  // No se puede abrir otro ciclo solo porque el cliente vuelva a pedir.
  if (estado?.confirmacionIncierta) return estado;

  // ── EL ESCALADO NO SOBREVIVE AL TURNO ────────────────────────────────
  //
  // Quién contesta una conversación entregada a una persona lo decide el
  // CANAL, con `conversaciones_control.bot_pausado`. Un turno solo llega hasta
  // aquí si esa pausa no está puesta — es decir, si alguien ya devolvió la
  // conversación al bot, o si nunca llegó a pausarse.
  //
  // Guardarlo además como hecho terminal del agente era tener el mismo cierre
  // en dos sitios, y el del agente no tenía forma de abrirse: reanudar el bot
  // desde el panel quitaba la pausa y el agente seguía mudo, porque su propio
  // estado seguía diciendo «escalado». Pasó el 23-sep y costó tres mensajes
  // entenderlo.
  //
  // `confirmado` y `cancelado` sí se quedan: son hechos sobre el PEDIDO, no
  // sobre quién atiende, y se reabren por tiempo o porque el cliente pida otro.
  const hechos = { ...(estado?.hechos || {}) };
  if (hechos.escalado) {
    const limpio = { ...estado, hechos: { ...hechos, escalado: false }, motivoEscalado: null };
    return cicloParaTurno(limpio, mensaje, { ahora });
  }

  const terminado = hechos.confirmado || hechos.cancelado || hechos.fallido;
  if (!terminado) return estado;

  // Se reabre porque el cliente lo pide CON PALABRAS, o porque ha pasado
  // bastante. Lo segundo hace falta porque lo primero es una lista de frases,
  // y una lista de frases nunca cubre cómo habla la gente.
  const marca = Date.parse(estado?._actualizadoAt || '');
  const viejo = Number.isFinite(marca)
    && (ahora.getTime() - marca) > HORAS_PARA_REABRIR * 3600 * 1000;
  if (!pideNuevoPedido(mensaje) && !viejo) return estado;

  const ciclo = Number(estado.ciclo || 0) + 1;
  const base = String(estado.conversacionId || '').replace(/:c\d+$/, '');
  const nuevo = estadoNuevo({ negocioId: estado.negocioId, conversacionId: `${base}:c${ciclo}` });
  nuevo.ciclo = ciclo;
  return nuevo;
}
