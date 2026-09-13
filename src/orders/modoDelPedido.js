// ─── En qué modo atiende el pedido CADA negocio ──────────────────────────
//
// Xabor es un solo proceso con muchos negocios dentro. Desplegar un cambio del
// asistente se lo aplica a todos a la vez, y eso es justo lo que no puede pasar
// con un reconciliador nuevo.
//
// ── El incidente que obliga a esto ───────────────────────────────────────
//
// 2026-09-12, 02:34 UTC. Se apuntó el servicio a esta rama para observar en
// sombra a un negocio con el bot apagado. Al comprobar el interruptor del bot,
// negocio por negocio, aparecieron OTROS DOS con el bot encendido: para ellos
// el despliegue no era una observación, era el reconciliador nuevo decidiendo
// sobre pedidos reales. Se revirtió en tres minutos y no hubo tráfico, pero la
// bandera global nunca podía haber dado esa garantía: `PEDIDO_SHADOW_MODE` es
// del PROCESO, y la pregunta es del NEGOCIO.
//
// ── Los tres modos ───────────────────────────────────────────────────────
//
//   LEGACY   el comportamiento de `main`, sin una sola línea nueva en su
//            camino. Es el DEFAULT y lo es a propósito: un negocio sin
//            configuración explícita no participa de nada.
//   SHADOW   el bot no responde y el reconciliador observa en copia.
//   V2       el reconciliador nuevo decide de verdad, para ese negocio.
//
// ── Dónde viven los interruptores ────────────────────────────────────────
//
// En `configuracion`, la tabla clave/valor por negocio que ya usa el sistema
// para `modo_pedidos`, `pedido_requiere_anticipo` y las credenciales de canal.
// No hace falta tabla nueva ni migración: una clave ausente es la respuesta
// correcta —LEGACY— sin escribir una fila.
//
//   pedido_reconciliador_v2 = 'true'   el negocio decide con V2
//   pedido_shadow           = 'true'   el negocio se observa en sombra
//
// No se usa `negocio_modulos` a propósito: esa tabla alimenta la navegación del
// panel y la lista de módulos del Superadmin, y estos dos interruptores no son
// una capacidad que se le venda a nadie — son un experimento nuestro.
//
// ── Fail safe ────────────────────────────────────────────────────────────
//
// Cualquier duda cae a LEGACY: sin negocio, con la base caída, con un valor
// raro o con la clave ausente. `obtenerConfiguracion` ya devuelve `{}` cuando
// falla, así que un error de lectura no puede encender nada.
import { obtenerConfiguracion } from '../services/database.js';

export const CLAVE_V2 = 'pedido_reconciliador_v2';
export const CLAVE_SHADOW = 'pedido_shadow';

/**
 * Comparación EXPLÍCITA contra "true".
 *
 * Los valores de `configuracion` son TEXT y los de entorno también, así que
 * `"false"` y `"0"` son verdaderos para JavaScript. Aquí solo enciende la
 * palabra, con espacios o mayúsculas alrededor y nada más.
 */
export const esVerdadero = (v) => String(v ?? '').trim().toLowerCase() === 'true';

/** El interruptor MAESTRO de sombra, del proceso. Apaga a todos de golpe. */
export const sombraHabilitadaEnElProceso = () => esVerdadero(process.env.PEDIDO_SHADOW_MODE);

/**
 * El modo de ESTE negocio, leído en el momento.
 *
 * Sin caché a propósito: cambiar un interruptor tiene que valer para el
 * siguiente mensaje, sin reiniciar ni redesplegar. Es una consulta indexada a
 * una tabla de una decena de filas por negocio, y el turno ya hace varias.
 *
 * Devuelve siempre un objeto utilizable; nunca lanza.
 */
export async function modoDelPedido(negocioId) {
  const apagado = { v2: false, shadow: false, modo: 'legacy' };
  if (typeof negocioId !== 'string' || !negocioId.trim()) return apagado;
  let cfg;
  try {
    cfg = await obtenerConfiguracion(negocioId);
  } catch {
    // `obtenerConfiguracion` ya se traga sus errores, pero si algún día dejara
    // de hacerlo, un fallo de lectura NO puede encender el reconciliador.
    return apagado;
  }
  const v2 = esVerdadero(cfg?.[CLAVE_V2]);
  const pedidoShadow = esVerdadero(cfg?.[CLAVE_SHADOW]);

  // LOS DOS A LA VEZ: manda V2 y la sombra no corre.
  //
  // Observar a un negocio que ya está decidiendo con V2 no mide nada nuevo, y
  // costaría una llamada al modelo por turno para escribir una línea sobre un
  // hipotético que no ocurrió. Tampoco se rechaza la configuración tirando el
  // turno: el cliente no tiene la culpa de una casilla mal puesta. Manda V2, la
  // sombra se ignora, y queda dicho en el log para que se corrija.
  const shadow = pedidoShadow && !v2 && sombraHabilitadaEnElProceso();
  if (pedidoShadow && v2) {
    console.warn(`[TXN] evento=configuracion_de_pedido_ambigua negocio=${negocioId} `
      + 'shadow y v2 encendidos a la vez: manda v2 y no se observa');
  }
  return { v2, shadow, modo: v2 ? 'v2' : (shadow ? 'shadow' : 'legacy') };
}
