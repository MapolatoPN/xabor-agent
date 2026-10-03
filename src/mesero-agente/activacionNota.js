// Decisiones puras de scripts/activar-flows-nota.mjs (contrato nota_v1, la
// nota del pedido en «Entrega y pago»): qué se escribe al activar y qué al
// revertir. Aparte para que el chequeo previo al despliegue las pruebe sin base
// ni Meta. Misma regla que activacionDireccion.js: respaldo, reversa que acepta
// lo ya quitado a mano y nunca pisa un cambio ajeno.
import { contratoCategorias, contratoCarrito } from './direccionFormulario.js';
import { planReversa } from './activacionDireccion.js';
import { BANDERA_NOTA, notaCategorias, notaCarrito } from './notaDelPedido.js';

export const CLAVE_RESPALDO_NOTA = 'whatsapp_flows_nota_respaldo';
const CLAVES_FLOW = ['whatsapp_flow_categorias_id', 'whatsapp_flow_repetible_id', 'whatsapp_flow_carrito_id',
  'whatsapp_flow_configurar_id', 'whatsapp_flow_editar_id', 'whatsapp_flow_pedido_id', 'whatsapp_flow_productos_id',
  'whatsapp_flow_categorias_dir_id', 'whatsapp_flow_carrito_dir_id'];

/**
 * Los cambios de una activación, o un error con el motivo. La bandera y los
 * dos flowId nuevos se escriben JUNTOS: la nota solo existe con su Flow, y su
 * Flow solo se abre con la nota. Exige la dirección ya activa en los dos
 * formularios: la nota vive en su pantalla «Entrega y pago».
 */
export function planActivacionNota(cfg, categoriasNotaId, carritoNotaId) {
  for (const id of [categoriasNotaId, carritoNotaId]) {
    if (!/^\d{5,30}$/.test(id || '')) return { error: 'Indica los dos flowId nuevos' };
  }
  if (categoriasNotaId === carritoNotaId) return { error: 'Los dos formularios nuevos no pueden tener el mismo flowId' };
  const usados = CLAVES_FLOW.filter((k) => [categoriasNotaId, carritoNotaId].includes(cfg?.[k]));
  if (usados.length) return { error: `Un flowId nuevo ya es de otro formulario (${usados.join(', ')})` };
  if (!contratoCategorias(cfg) || !contratoCarrito(cfg)) {
    return { error: 'La nota exige la dirección activa en los dos formularios (activar-flows-direccion.mjs)' };
  }
  const cambios = { whatsapp_flow_categorias_nota_id: categoriasNotaId, whatsapp_flow_carrito_nota_id: carritoNotaId,
    [BANDERA_NOTA]: 'true' };
  const siguiente = { ...cfg, ...cambios };
  if (!notaCategorias(siguiente) || !notaCarrito(siguiente)) return { error: 'La configuración resultante no enciende la nota' };
  const respaldo = cfg?.[CLAVE_RESPALDO_NOTA] ? JSON.parse(cfg[CLAVE_RESPALDO_NOTA]) : null;
  if (respaldo && !Object.entries(cambios).every(([k, v]) => cfg[k] === v)) {
    return { error: 'Ya existe respaldo; revertir antes de activar otros flowId' };
  }
  // Claves puestas a mano sin respaldo: el respaldo guardaría como «antes» una
  // nota encendida y revertir no la apagaría. Que se quiten primero.
  if (!respaldo && Object.keys(cambios).some((k) => cfg?.[k] != null && cfg[k] !== '')) {
    return { error: 'Hay claves de la nota puestas a mano: quítalas antes de activar' };
  }
  return {
    cambios,
    // Los Flow que hay que comprobar en Meta, en pares (id, tipo).
    flows: [[categoriasNotaId, 'categorias'], [carritoNotaId, 'carrito']],
    respaldo: respaldo ? null : { antes: Object.fromEntries(Object.keys(cambios).map((k) => [k, cfg?.[k] ?? null])), despues: cambios },
  };
}

/** Lo que restaura la reversa de la nota (misma regla que la de la dirección). */
export const planReversaNota = (cfg) => planReversa(cfg, CLAVE_RESPALDO_NOTA);
