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

// ── El Mesero Digital, dos interruptores más ─────────────────────────────
//
// Mismo criterio y misma tabla. Se suman aquí y no en un módulo aparte porque
// la pregunta es la misma —«¿en qué modo atiende este negocio?»— y tener dos
// sitios donde se responde es cómo se acaba con un negocio en dos modos.
//
//   mesero_whatsapp_v1      = 'true'   el mesero conversa de verdad
//   mesero_whatsapp_shadow  = 'true'   el mesero observa y no contesta
export const CLAVE_MESERO = 'mesero_whatsapp_v1';
export const CLAVE_MESERO_SOMBRA = 'mesero_whatsapp_shadow';

// ── El AGENTE de herramientas, y su canario ──────────────────────────────
//
// Es el camino nuevo: el modelo pide herramientas, Xabor decide. Sustituye a
// `brain.js` para la conversación en la que está encendido, así que no depende
// de `pedido_reconciliador_v2` — no comparte carrito con el bot viejo, usa el
// reconciliador siempre y por su cuenta. Exigir V2 aquí no añadiría ninguna
// garantía y sí una configuración más que se puede poner mal.
//
//   mesero_agente_v1         = 'true'       el agente atiende de verdad
//   mesero_agente_shadow     = 'true'       el agente observa y no contesta
//   mesero_agente_telefonos  = '52…,52…'    SOLO estos números (el canario)
//   mesero_agente_porcentaje = '0'..'100'   o este porcentaje del tráfico
//
// Y dos llaves del PROCESO, que son el interruptor de apagado inmediato:
//
//   MESERO_AGENTE_MODE=true      habilita el productivo
//   MESERO_AGENTE_SHADOW=true    habilita la sombra
//
// El canario es fail-closed de una forma concreta: **sin lista y sin
// porcentaje no atiende a nadie.** Encender `mesero_agente_v1` y olvidarse del
// alcance no despliega el agente a todo el negocio; lo deja sin alcance. El
// 12 de septiembre un experimento pensado para un negocio alcanzó a otros dos,
// y la lección fue que el alcance tiene que ser explícito, no el default.
export const CLAVE_AGENTE = 'mesero_agente_v1';
export const CLAVE_AGENTE_SOMBRA = 'mesero_agente_shadow';
export const CLAVE_AGENTE_TELEFONOS = 'mesero_agente_telefonos';
export const CLAVE_AGENTE_PORCENTAJE = 'mesero_agente_porcentaje';

export const agenteHabilitadoEnElProceso = () => esVerdadero(process.env.MESERO_AGENTE_MODE);
export const agenteSombraHabilitadoEnElProceso = () => esVerdadero(process.env.MESERO_AGENTE_SHADOW);

/** Los dígitos de un teléfono, para comparar sin depender de cómo se escriba. */
const soloDigitos = (t) => String(t ?? '').replace(/\D+/g, '');

/**
 * ¿ESTE teléfono entra en el canario?
 *
 * La lista manda sobre el porcentaje: con lista, solo la lista. Así una prueba
 * con dos números no se contamina con tráfico real por un porcentaje que quedó
 * puesto de antes.
 *
 * El porcentaje se decide por el HASH del teléfono, no al azar: el mismo
 * cliente cae siempre del mismo lado. Un cliente que salta entre el bot viejo
 * y el nuevo a mitad de pedido es la peor forma posible de hacer un canario.
 */
export function enElCanario(telefono, { lista = '', porcentaje = '' } = {}) {
  // Se separa SOLO por coma, punto y coma o salto de línea: un número se
  // escribe «52 878 123 4567» tanto como «528781234567», y partir por espacios
  // convertía un teléfono en cuatro números que no son ninguno.
  const numeros = String(lista || '').split(/[,;\n]+/).map(soloDigitos).filter(Boolean);
  const t = soloDigitos(telefono);
  if (numeros.length) return { dentro: !!t && numeros.includes(t), via: 'lista' };

  const pct = Number(String(porcentaje || '').trim());
  if (!Number.isFinite(pct) || pct <= 0) return { dentro: false, via: 'sin_alcance' };
  if (pct >= 100) return { dentro: true, via: 'porcentaje' };
  if (!t) return { dentro: false, via: 'sin_telefono' };
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) % 100000;
  return { dentro: (h % 100) < pct, via: 'porcentaje' };
}

/**
 * Decide si el lote puede llegar al procesador conversacional.
 *
 * El agente tiene su propio interruptor y alcance por teléfono. Por eso un
 * teléfono incluido en el canario puede entrar aunque el bot legacy del
 * negocio esté apagado. Pausa manual y takeover humano siguen mandando sobre
 * ambos caminos.
 */
export function puedeProcesarTurno({
  botGlobalActivo = false,
  agenteCanario = false,
  pausado = false,
  takeoverVigente = false,
} = {}) {
  if (pausado || takeoverVigente) return false;
  return !!botGlobalActivo || !!agenteCanario;
}

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
 * El maestro del mesero en sombra. Aparte del anterior, a propósito.
 *
 * Reutilizar `PEDIDO_SHADOW_MODE` habría hecho que encender la observación del
 * reconciliador encendiera también la del mesero, que es otro experimento, con
 * otro código y otro riesgo. Un interruptor por experimento.
 */
export const meseroSombraHabilitadoEnElProceso = () => esVerdadero(process.env.MESERO_SHADOW_MODE);

/**
 * El modo de ESTE negocio, leído en el momento.
 *
 * Sin caché a propósito: cambiar un interruptor tiene que valer para el
 * siguiente mensaje, sin reiniciar ni redesplegar. Es una consulta indexada a
 * una tabla de una decena de filas por negocio, y el turno ya hace varias.
 *
 * Devuelve siempre un objeto utilizable; nunca lanza.
 */
export async function modoDelPedido(negocioId, { leerConfiguracion = obtenerConfiguracion, telefono = null } = {}) {
  const apagado = { v2: false, shadow: false, mesero: false, meseroSombra: false,
    agente: false, agenteSombra: false, canario: null, modo: 'legacy' };
  if (typeof negocioId !== 'string' || !negocioId.trim()) return apagado;
  let cfg;
  try {
    // El lector se puede inyectar SOLO para probar el camino de error. Hoy
    // `obtenerConfiguracion` se traga sus propios fallos y devuelve `{}`, así
    // que este catch no se alcanza en producción; existe para que un cambio
    // futuro en esa función no convierta un error de lectura en un negocio
    // encendido, y para poder demostrarlo con una prueba en vez de con fe.
    cfg = await leerConfiguracion(negocioId);
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

  // ── EL MESERO NO CORRE SIN SU MOTOR TRANSACCIONAL ──────────────────────
  //
  // El mesero conversa, interpreta y PROPONE. Lo que decide qué entra al
  // pedido es el reconciliador V2: identidad de renglón, protección campo a
  // campo, evidencia. Encender el mesero sobre LEGACY sería quitarle el freno
  // justo al componente que más propone — un modelo recomendando y nadie
  // comprobando qué de eso autorizó el cliente.
  //
  // Así que `mesero_whatsapp_v1` sin `pedido_reconciliador_v2` NO enciende
  // nada. No es una preferencia de diseño: es la única configuración en la que
  // el mesero sería menos seguro que el bot que reemplaza.
  const meseroPedido = esVerdadero(cfg?.[CLAVE_MESERO]);
  const meseroSombraPedido = esVerdadero(cfg?.[CLAVE_MESERO_SOMBRA]);
  const mesero = meseroPedido && v2;
  if (meseroPedido && !v2) {
    console.warn(`[MESERO] evento=mesero_sin_reconciliador negocio=${negocioId} `
      + 'mesero_whatsapp_v1 encendido sin pedido_reconciliador_v2: no se activa');
  }
  // La sombra del mesero solo mira. No necesita V2 productivo —de hecho es lo
  // que se quiere observar antes de encenderlo— pero sí las dos llaves, como
  // toda observación: la del proceso y la del negocio.
  const meseroSombra = meseroSombraPedido && !mesero && meseroSombraHabilitadoEnElProceso();

  // ── EL AGENTE DE HERRAMIENTAS ──────────────────────────────────────────
  //
  // Tres condiciones para atender de verdad, y las tres tienen que darse:
  // la llave del proceso, la bandera del negocio y que ESTE teléfono esté en
  // el canario. La tercera es la que hace que encender la bandera no sea
  // desplegar a todo el negocio.
  const canario = enElCanario(telefono, {
    lista: cfg?.[CLAVE_AGENTE_TELEFONOS],
    porcentaje: cfg?.[CLAVE_AGENTE_PORCENTAJE],
  });
  const agentePedido = esVerdadero(cfg?.[CLAVE_AGENTE]);
  const agente = agentePedido && agenteHabilitadoEnElProceso() && canario.dentro;
  if (agentePedido && agenteHabilitadoEnElProceso() && !canario.dentro) {
    console.log(`[AGENTE] evento=fuera_del_canario negocio=${negocioId} via=${canario.via}`);
  }
  // La sombra no necesita canario: no contesta, no toca nada y lo que se
  // quiere es verla con el tráfico que haya. Pero sí las dos llaves.
  const agenteSombra = esVerdadero(cfg?.[CLAVE_AGENTE_SOMBRA]) && !agente
    && agenteSombraHabilitadoEnElProceso();

  return {
    v2,
    shadow,
    mesero,
    meseroSombra,
    agente,
    agenteSombra,
    canario,
    modo: agente ? 'agente' : (v2 ? (mesero ? 'mesero' : 'v2') : (shadow ? 'shadow' : 'legacy')),
  };
}
