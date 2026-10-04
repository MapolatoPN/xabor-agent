// Decisiones puras de scripts/activar-flows-tienda.mjs (contrato tienda_v1, el
// formulario «tienda» con fotos): qué se escribe al activar y qué al revertir.
// Aparte para que las pruebas las cubran sin base ni Meta. Misma regla que
// activacionDireccion.js y activacionNota.js: respaldo, reversa que acepta lo
// ya quitado a mano y nunca pisa un cambio ajeno.
//
// Se activa en dos tiempos sobre el MISMO Flow publicado:
//   1. 'prueba' con los teléfonos de prueba (whatsapp_flow_tienda_telefonos);
//   2. 'true' (todos). Cambiar el alcance conserva el «antes» del respaldo:
//      revertir siempre deja la configuración de antes del paso 1.
import { BANDERA_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA } from './contratoTienda.js';
import { CLAVES_FLOW_PEDIDO, tiendaConfigurada } from './disponibilidadTienda.js';
import { notaCarrito } from './notaDelPedido.js';
import { planReversa } from './activacionDireccion.js';

export const CLAVE_RESPALDO_TIENDA = 'whatsapp_flows_tienda_respaldo';
export const MODOS_TIENDA = Object.freeze(['prueba', 'true']);
const valido = (id) => /^\d{5,30}$/.test(id || '');

/** «52 878 123 4567, 5218781234567» → ['528781234567', '5218781234567'], o null si alguno no es un teléfono. */
export function telefonosDePrueba(texto) {
  const lista = String(texto ?? '').split(/[,;\n]+/).map((t) => t.replace(/\D/g, '')).filter(Boolean);
  if (!lista.length || lista.some((t) => t.length < 10 || t.length > 15)) return null;
  return [...new Set(lista)];
}

/**
 * Los cambios de una activación, o un error con el motivo. El flowId, la
 * bandera y (en 'prueba') los teléfonos se escriben JUNTOS. Exige la dirección
 * y la nota del carrito ya activas (la tienda vive con ellas) y «Arma tu
 * pedido» por categorías (su catálogo).
 */
export function planActivacionTienda(cfg, flowId, { modo, telefonos = '' } = {}) {
  if (!valido(flowId)) return { error: 'Indica el flowId de la tienda' };
  if (!MODOS_TIENDA.includes(modo)) return { error: 'Indica el alcance: --prueba <teléfonos> o --todos' };
  const lista = modo === 'prueba' ? telefonosDePrueba(telefonos) : null;
  if (modo === 'prueba' && !lista) return { error: 'Con --prueba indica uno o más teléfonos (10 a 15 dígitos, separados por coma)' };
  const usados = CLAVES_FLOW_PEDIDO.filter((k) => cfg?.[k] === flowId);
  if (usados.length) return { error: `El flowId ya es de otro formulario (${usados.join(', ')})` };
  if (!notaCarrito(cfg)) {
    return { error: 'La tienda exige la dirección y la nota activas en «Tu carrito» (activar-flows-direccion.mjs y activar-flows-nota.mjs)' };
  }
  if (!valido(cfg?.whatsapp_flow_categorias_id)) return { error: 'La tienda exige «Arma tu pedido» por categorías (whatsapp_flow_categorias_id)' };
  const cambios = { [FLOW_TIENDA_ID]: flowId, [BANDERA_TIENDA]: modo, [TELEFONOS_TIENDA]: lista ? lista.join(',') : null };
  if (!tiendaConfigurada({ ...cfg, ...cambios })) return { error: 'La configuración resultante no enciende la tienda' };
  const respaldo = cfg?.[CLAVE_RESPALDO_TIENDA] ? JSON.parse(cfg[CLAVE_RESPALDO_TIENDA]) : null;
  if (respaldo) {
    // Cambiar el alcance (prueba → todos, otros teléfonos) con el mismo Flow.
    if (respaldo.despues?.[FLOW_TIENDA_ID] !== flowId) return { error: 'Ya existe respaldo con otro flowId; revertir antes de activar otro Flow' };
    const ajenas = Object.entries(respaldo.despues || {}).filter(([k, v]) => (cfg?.[k] ?? null) !== v).map(([k]) => k);
    if (ajenas.length) return { error: `La configuración cambió después de activar (${ajenas.join(', ')}): no sobrescribir` };
    return { cambios, flows: [[flowId, 'tienda']], respaldo: { antes: respaldo.antes, despues: cambios }, reemplazaRespaldo: true };
  }
  // Claves puestas a mano sin respaldo: el respaldo guardaría como «antes» una
  // tienda encendida y revertir no la apagaría. Que se quiten primero.
  if (Object.keys(cambios).some((k) => cfg?.[k] != null && cfg[k] !== '')) {
    return { error: 'Hay claves de la tienda puestas a mano: quítalas antes de activar' };
  }
  return { cambios, flows: [[flowId, 'tienda']],
    respaldo: { antes: Object.fromEntries(Object.keys(cambios).map((k) => [k, cfg?.[k] ?? null])), despues: cambios } };
}

/** Lo que restaura la reversa de la tienda (misma regla que la de la dirección). */
export const planReversaTienda = (cfg) => planReversa(cfg, CLAVE_RESPALDO_TIENDA);
