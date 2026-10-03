// La fila de conversacion_estado sigue identificada por teléfono, pero cada
// pedido nuevo usa otra identidad en el libro de operaciones. Así la
// confirmación de ayer no bloquea un pedido legítimo de hoy.
import { estadoNuevo } from './ejecutorDeHerramientas.js';
import { esSolicitudCatering } from '../agent/catering.js';
import { fechaHoyEn } from '../services/zonaHoraria.js';

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

/**
 * Un flujo de servicio abierto (formulario de factura o de evento, menú de
 * inicio, ficha de evento) vence a los 30 minutos sin actividad o al cambiar
 * el día del negocio. El 2-oct un formulario de factura pendiente seguía
 * gobernando la conversación al día siguiente: un botón viejo lo reabrió y la
 * ficha de evento siguió preguntando «¿para cuántas personas?».
 *
 * Mide con el reloj de la base (_actualizadoAt + _inactividadMs), igual que
 * el borrador vencido. Sin esas marcas no vence: conservador, como hoy.
 */
export const MINUTOS_FLUJO_ABIERTO = 30;
const PENDIENTES_DE_FLUJO = new Set(['formulario_servicio', 'inicio_mapo', 'datos_evento']);

export function flujoAbiertoVencido(estado, { zona = 'America/Matamoros', minutos = MINUTOS_FLUJO_ABIERTO } = {}) {
  if (!estado || estado.folio || estado.confirmacionIncierta) return false;
  if (!estado.evento && !PENDIENTES_DE_FLUJO.has(estado.pendiente?.tipo)) return false;
  const ultima = Date.parse(estado._actualizadoAt || '');
  const inactividad = Number(estado._inactividadMs);
  if (!Number.isFinite(ultima) || !Number.isFinite(inactividad)) return false;
  if (inactividad > minutos * 60 * 1000) return true;
  try {
    return fechaHoyEn(zona, new Date(ultima)) !== fechaHoyEn(zona, new Date(ultima + inactividad));
  } catch { return false; }
}

/** Quita el flujo vencido; el carrito y lo demás se quedan. */
export function limpiarFlujoVencido(estado, opciones = {}) {
  if (!flujoAbiertoVencido(estado, opciones)) return estado;
  return { ...estado, evento: null, pendiente: null, foco: null };
}

export function cicloParaTurno(estado, mensaje, { ahora = new Date(), zona, flujosCaducan = false } = {}) {
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
    return cicloParaTurno(limpio, mensaje, { ahora, zona, flujosCaducan });
  }

  // Un flujo de servicio vencido no gobierna el turno. Sin carrito ni hechos
  // se abre un ciclo nuevo, como un borrador vencido; con carrito solo se
  // suelta el flujo y el pedido sigue.
  if (flujosCaducan && flujoAbiertoVencido(estado, { zona })) {
    const sinNada = !estado.carrito?.items?.length && !Object.values(hechos).some(Boolean);
    if (!sinNada) return limpiarFlujoVencido(estado, { zona });
    const ciclo = Number(estado.ciclo || 0) + 1;
    const base = String(estado.conversacionId || '').replace(/:c\d+$/, '');
    const nuevo = estadoNuevo({ negocioId: estado.negocioId, conversacionId: `${base}:c${ciclo}` });
    nuevo.ciclo = ciclo;
    return nuevo;
  }

  const terminado = hechos.confirmado || hechos.cancelado || hechos.fallido;
  // Un borrador sin efectos también tiene frontera temporal. Antes solo
  // caducaban los terminales: la modalidad de ayer sobrevivía incluso a un
  // «hola» de hoy. Eventos y pedidos con folio conservan su propio ciclo.
  const ultimaActividad = Date.parse(estado?._actualizadoAt || '');
  // En producción ambos extremos salen del reloj de PostgreSQL; un desfase
  // entre el servidor y la DB no debe caducar un carrito recién escrito.
  const inactividad = Number.isFinite(estado?._inactividadMs)
    ? estado._inactividadMs : ahora.getTime() - ultimaActividad;
  const borradorVencido = !terminado && !estado?.folio && !estado?.evento
    && Number.isFinite(inactividad)
    && inactividad > HORAS_PARA_REABRIR * 3600 * 1000;
  if (!terminado && !borradorVencido) return estado;

  // Se reabre porque el cliente lo pide CON PALABRAS, o porque ha pasado
  // bastante. Lo segundo hace falta porque lo primero es una lista de frases,
  // y una lista de frases nunca cubre cómo habla la gente.
  //
  // ── LA FECHA ES LA DEL CIERRE, NO LA DEL ÚLTIMO ESCRITO ──────────────
  //
  // Medir desde cuándo se guardó el estado la última vez no sirve: el estado
  // se reescribe en CADA turno, así que la conversación se rejuvenece sola
  // cada vez que el cliente habla y la regla no llega a dispararse nunca.
  // Se vio en producción el mismo día que se escribió: un pedido confirmado
  // el 21 seguía mandando el 23, con dos días de por medio y la marca a
  // nueve minutos.
  //
  // Lo que vale es CUÁNDO TERMINÓ el ciclo. Eso lo anota el ejecutor al poner
  // el hecho, y no se vuelve a tocar.
  // Un estado sin `terminadoEn` viene de antes de que esto existiera. Se cae
  // a la fecha de guardado, que no es buena —se renueva en cada turno— pero
  // es CONSERVADORA: como mucho no reabre, y no reabrir de más es lo que
  // protege «preguntar por el pedido confirmado no abre otro ciclo».
  //
  // Tratar la ausencia como «viejo» se probó y rompía justo esa garantía: un
  // cliente preguntando «¿ya está listo?» empezaba un pedido vacío. Esas
  // filas se curan solas en cuanto cierren su siguiente ciclo.
  const marca = Date.parse(estado?.terminadoEn || estado?._actualizadoAt || '');
  const viejo = Number.isFinite(marca)
    && (ahora.getTime() - marca) > HORAS_PARA_REABRIR * 3600 * 1000;
  // Tras cancelar un borrador vacío, saludar debe permitir volver a comprar.
  // No se aplica a folios, fallos, efectos inciertos o carritos con contenido.
  const saludoTrasCancelar=hechos.cancelado && !hechos.confirmado && !hechos.fallido
    && !estado.folio && !estado.evento && estado.carrito?.items?.length===0
    && /^(?:hola|buenos dias|buenas tardes|buenas noches|buen dia|buenas)[!.\s]*$/.test(normalizar(mensaje));
  // Un evento explícito también es trabajo nuevo. Reutilizar un ciclo
  // cancelado haría ilegal registrar_solicitud_evento durante seis horas y
  // conservaría el carrito anterior dentro de una ficha comercial nueva.
  if (!borradorVencido && !saludoTrasCancelar && !pideNuevoPedido(mensaje) && !esSolicitudCatering(mensaje) && !viejo) return estado;

  const ciclo = Number(estado.ciclo || 0) + 1;
  const base = String(estado.conversacionId || '').replace(/:c\d+$/, '');
  const nuevo = estadoNuevo({ negocioId: estado.negocioId, conversacionId: `${base}:c${ciclo}` });
  nuevo.ciclo = ciclo;
  return nuevo;
}
