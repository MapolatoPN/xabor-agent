// Decisiones puras de scripts/activar-flows-direccion.mjs (contrato
// direccion_v1): qué se escribe al activar y qué al revertir. Aparte para que
// el chequeo previo al despliegue las pruebe sin base ni Meta.
import { contratoCategorias, contratoCarrito } from './direccionFormulario.js';
import { BANDERA_NOTA } from './notaDelPedido.js';

export const CLAVE_RESPALDO_DIRECCION = 'whatsapp_flows_direccion_respaldo';
const CLAVES_BASE = ['whatsapp_flow_categorias_id', 'whatsapp_flow_repetible_id', 'whatsapp_flow_carrito_id',
  'whatsapp_flow_configurar_id', 'whatsapp_flow_editar_id', 'whatsapp_flow_pedido_id', 'whatsapp_flow_productos_id'];
// La nota del pedido (activacionNota.js) vive dentro de los formularios con
// dirección: sus Flows se revisaron contra la dirección de ESA activación.
const CLAVES_NOTA = [BANDERA_NOTA, 'whatsapp_flow_categorias_nota_id', 'whatsapp_flow_carrito_nota_id'];

/**
 * Los cambios de una activación, o un error con el motivo. Cada formulario
 * nuevo tiene su propio flowId: el mismo para los dos (o uno de los de
 * siempre) abriría en «Arma tu pedido» un Flow sin sus pantallas.
 */
export function planActivacion(cfg, categoriasDirId, carritoDirId) {
  for (const id of [categoriasDirId, carritoDirId]) {
    if (!/^\d{5,30}$/.test(id || '')) return { error: 'Indica los dos flowId nuevos' };
  }
  if (categoriasDirId === carritoDirId) return { error: 'Los dos formularios nuevos no pueden tener el mismo flowId' };
  const base = CLAVES_BASE.filter((k) => [categoriasDirId, carritoDirId].includes(cfg?.[k]));
  if (base.length) return { error: `Un flowId nuevo es el de un formulario de siempre (${base.join(', ')})` };
  const cambios = { whatsapp_flow_categorias_dir_id: categoriasDirId, whatsapp_flow_carrito_dir_id: carritoDirId };
  const siguiente = { ...cfg, ...cambios };
  if (!contratoCategorias(siguiente) || !contratoCarrito(siguiente)) return { error: 'Faltan los formularios de siempre (claves base)' };
  const respaldo = cfg?.[CLAVE_RESPALDO_DIRECCION] ? JSON.parse(cfg[CLAVE_RESPALDO_DIRECCION]) : null;
  if (respaldo && !Object.entries(cambios).every(([k, v]) => cfg[k] === v)) {
    return { error: 'Ya existe respaldo; revertir antes de activar otros flowId' };
  }
  // Claves puestas a mano sin respaldo: el respaldo guardaría como «antes» un
  // contrato encendido y revertir no lo apagaría. Que se quiten primero.
  if (!respaldo && Object.keys(cambios).some((k) => cfg?.[k] != null && cfg[k] !== '')) {
    return { error: 'Hay claves *_dir_id puestas a mano: quítalas antes de activar' };
  }
  // Una reversa de emergencia de la dirección deja las claves de la nota (la
  // apagan solas: sin dirección no hay nota). Activar otra dirección encima la
  // volvería a encender con Flows que nadie revisó contra ella. Primero se
  // revierte la nota. Sin la nota configurada, la regla es la de siempre.
  if (!respaldo && CLAVES_NOTA.some((k) => cfg?.[k] != null && cfg[k] !== '')) {
    return { error: 'La nota del pedido sigue configurada: revierte la nota (activar-flows-nota.mjs) antes de activar' };
  }
  return {
    cambios,
    // Los Flow que hay que comprobar en Meta, en pares (id, tipo).
    flows: [[categoriasDirId, 'categorias'], [carritoDirId, 'carrito']],
    respaldo: respaldo ? null : { antes: Object.fromEntries(Object.keys(cambios).map((k) => [k, cfg?.[k] ?? null])), despues: cambios },
  };
}

/**
 * Lo que restaura una reversa. Acepta que una clave ya se haya quitado a mano
 * (o tenga otra vez su valor de antes): solo restaura las que siguen activas y
 * borra el respaldo. Un tercer valor es un cambio ajeno: no se sobrescribe.
 * `clave` es la del respaldo: la nota del pedido (activacionNota.js) revierte
 * con la misma regla y su propio respaldo.
 */
export function planReversa(cfg, clave = CLAVE_RESPALDO_DIRECCION) {
  const respaldo = cfg?.[clave] ? JSON.parse(cfg[clave]) : null;
  if (!respaldo) return { error: 'Sin respaldo no se revierte' };
  const aplicar = {};
  for (const [k, despues] of Object.entries(respaldo.despues || {})) {
    const antes = respaldo.antes?.[k] ?? null;
    const actual = cfg[k] ?? null;
    if (actual === despues) aplicar[k] = antes;
    else if (actual !== antes) return { error: `La configuración cambió después (${k}): no sobrescribir` };
  }
  return { aplicar };
}
