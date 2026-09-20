// ─── LA MÁQUINA DE ESTADOS DEL PEDIDO ─────────────────────────────────────
//
// Ocho estados y una regla: el estado NO se guarda, se CALCULA.
//
// ── Por qué calculado y no guardado ──────────────────────────────────────
//
// Un estado guardado es una opinión sobre el pedido, y una opinión se
// desincroniza. El caso real: el bot se quedó en `esperando_modalidad` seis
// turnos con un artículo que no existía en el menú (13-sep). El estado decía
// una cosa y el carrito otra, y el que hablaba con el cliente era el estado.
//
// Aquí `estadoDelPedido()` se deduce del carrito REAL cada vez que se
// pregunta. No puede mentir sobre lo que hay porque no guarda nada sobre lo
// que hay.
//
// Lo único que SÍ se guarda son los tres hechos irreversibles —confirmado,
// escalado, cancelado— y el fallo. Son irreversibles precisamente porque no
// se deducen: no hay nada en el carrito que diga «esto ya se mandó a la
// cocina».
//
// ── Por qué no hay un estado CONFIRMANDO ─────────────────────────────────
//
// Estaba en el diseño y se retiró a propósito. «Confirmando» sería un estado
// intermedio guardado cuya única función es recordar que se mostró un resumen
// — y eso ya lo lleva la huella que `confirmar_pedido` exige. Dos mecanismos
// para lo mismo es cómo se acaba con uno de los dos mintiendo. La huella se
// queda porque además prueba QUÉ resumen se mostró, cosa que un estado no.
import { loQueFalta } from '../mesero-whatsapp/faseConversacional.js';

export const NAVEGANDO = 'navegando';
export const ARMANDO = 'armando';
export const ACLARANDO = 'aclarando';
export const LISTO = 'listo';
export const CONFIRMADO = 'confirmado';
export const ESCALADO = 'escalado';
export const CANCELADO = 'cancelado';
export const FALLIDO = 'fallido';

export const ESTADOS = Object.freeze([
  NAVEGANDO, ARMANDO, ACLARANDO, LISTO, CONFIRMADO, ESCALADO, CANCELADO, FALLIDO,
]);

/** Estados de los que ya no se sale. Ninguna mutación es legal desde aquí. */
export const TERMINALES = Object.freeze([CONFIRMADO, ESCALADO, CANCELADO, FALLIDO]);

export const esTerminal = (estado) => TERMINALES.includes(estado);

/**
 * El estado AHORA, deducido del pedido real.
 *
 * `hechos` son los irreversibles: `{ confirmado, escalado, cancelado, fallido }`.
 * Se comprueban primero porque ninguno se puede deducir del carrito.
 */
export function estadoDelPedido({ carrito = null, aclaraciones = [], requierePago = true, hechos = {} } = {}) {
  if (hechos.fallido) return FALLIDO;
  if (hechos.escalado) return ESCALADO;
  if (hechos.cancelado) return CANCELADO;
  if (hechos.confirmado) return CONFIRMADO;

  const items = Array.isArray(carrito?.items) ? carrito.items : [];
  const datos = {
    modalidad: carrito?.datos?.modalidad ?? null,
    pago: carrito?.datos?.forma_pago ?? null,
  };
  const falta = loQueFalta({ carrito, datos, aclaraciones, requierePago });

  // Una aclaración abierta manda sobre todo lo demás: mientras no se sepa QUÉ
  // es un renglón, preguntar por la modalidad es empezar por el tejado. Es la
  // misma prioridad que ya aplica `loQueFalta`, dicha una sola vez.
  if ((aclaraciones || []).length) return ACLARANDO;
  if (!items.length) return NAVEGANDO;
  if (falta.length) return ARMANDO;
  return LISTO;
}

// ── QUÉ HERRAMIENTA ES LEGAL EN QUÉ ESTADO ───────────────────────────────
//
// Leer es legal siempre, incluso con el pedido confirmado: quien pregunta
// «¿qué pedí?» después de confirmar merece una respuesta y leer no rompe nada.
//
// Mutar es ilegal en cualquier terminal, y esa es toda la protección contra
// «cambiar el pedido después de confirmar»: no hace falta una regla por
// herramienta porque no hay ninguna mutación legal ahí.
const SIEMPRE = Object.freeze([...ESTADOS]);
const EN_CURSO = Object.freeze([NAVEGANDO, ARMANDO, ACLARANDO, LISTO]);

export const LEGALIDAD = Object.freeze({
  ver_pedido: SIEMPRE,
  buscar_producto: SIEMPRE,
  ver_opciones_producto: SIEMPRE,

  agregar_producto: EN_CURSO,
  modificar_linea: EN_CURSO,
  quitar_linea: EN_CURSO,
  definir_entrega: EN_CURSO,
  definir_pago: EN_CURSO,
  definir_cliente: EN_CURSO,
  cancelar_pedido: EN_CURSO,

  // Solo desde LISTO. No desde ARMANDO («falta la dirección»), no desde
  // ACLARANDO («no sé cuál de los cuatro chilaquiles es»), no desde NAVEGANDO
  // (no hay nada que confirmar). Esta línea es la invariante «no se confirma
  // un pedido incompleto», y no hay una segunda copia de ella en ningún sitio.
  confirmar_pedido: Object.freeze([LISTO]),

  // Una persona tiene que poder entrar también después de confirmar: las
  // quejas sobre un pedido ya mandado son exactamente el caso.
  pedir_humano: Object.freeze([...EN_CURSO, CONFIRMADO]),
});

/**
 * ¿Puede esta herramienta correr en este estado?
 *
 * Devuelve `{ legal, motivo, estado }`. El motivo viaja al modelo como
 * `tool_result` de error, así que está escrito para que el modelo sepa qué
 * hacer a continuación, no para un log.
 */
export function transicionLegal(herramienta, estado) {
  const permitidos = LEGALIDAD[herramienta];
  if (!permitidos) return { legal: false, estado, motivo: `herramienta_desconocida: ${herramienta}` };
  if (permitidos.includes(estado)) return { legal: true, estado, motivo: null };

  if (herramienta === 'confirmar_pedido') {
    return { legal: false, estado,
      motivo: `no_se_puede_confirmar: el pedido está en "${estado}", no en "listo". `
        + 'Llama a ver_pedido para saber qué falta y pregúntaselo al cliente.' };
  }
  if (esTerminal(estado)) {
    return { legal: false, estado,
      motivo: `pedido_${estado}: ya no se puede cambiar. `
        + (estado === CONFIRMADO
          ? 'Si el cliente quiere cambiar algo, usa pedir_humano.'
          : 'Esta conversación ya terminó para el bot.') };
  }
  return { legal: false, estado, motivo: `transicion_ilegal: ${herramienta} no se puede usar en "${estado}"` };
}

/** Lo que falta para poder confirmar, en palabras que el modelo puede usar. */
export function queFaltaParaConfirmar({ carrito = null, aclaraciones = [], requierePago = true } = {}) {
  const datos = {
    modalidad: carrito?.datos?.modalidad ?? null,
    pago: carrito?.datos?.forma_pago ?? null,
  };
  return loQueFalta({ carrito, datos, aclaraciones, requierePago });
}
