// Formulario «tienda» (contrato tienda_v1): CUÁNDO existe para un negocio y un
// cliente, qué flowId le corresponde y qué formulario abierto ya no puede
// seguir. Puro: sin base de datos, Meta ni pedidos.
//
// La tienda nace apagada. Con `whatsapp_flow_tienda_v1` en cualquier valor que
// no sea 'prueba' o 'true' (contratoTienda.modoTienda) nada de esto cambia
// ninguna respuesta: las funciones de aquí devuelven exactamente lo de hoy.
//
// Solo existe con la dirección y la nota del carrito activas (notaCarrito, que
// exige también contratoCarrito): así hay UN solo Flow de tienda y no tres
// variantes. Y con «Arma tu pedido» por categorías: su foto es el catálogo de
// la tienda. Las demás condiciones (endpoint, ≤ 20 categorías, ≤ 20 renglones)
// dependen del pedido y las decide fotoTienda en formularioAgrupado.js.
import { VERSION_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA, modoTienda } from './contratoTienda.js';
import { notaCarrito, flowIdEsperadoConNota, flowIdsConEndpointConNota } from './notaDelPedido.js';
import { enElCanario } from '../orders/modoDelPedido.js';

const valido = (id) => /^\d{5,30}$/.test(id || '');

// Los flowId de los formularios de pedido de hoy. El de la tienda nunca es uno
// de ellos: el mismo id abriría el Flow equivocado para una de las dos fotos.
export const CLAVES_FLOW_PEDIDO = Object.freeze(['whatsapp_flow_categorias_id', 'whatsapp_flow_repetible_id',
  'whatsapp_flow_carrito_id', 'whatsapp_flow_configurar_id', 'whatsapp_flow_editar_id', 'whatsapp_flow_pedido_id',
  'whatsapp_flow_productos_id', 'whatsapp_flow_categorias_dir_id', 'whatsapp_flow_carrito_dir_id',
  'whatsapp_flow_categorias_nota_id', 'whatsapp_flow_carrito_nota_id']);

/** La tienda está configurada en el negocio (bandera, flowId propio, dirección y nota, categorías). */
export function tiendaConfigurada(cfg) {
  if (!modoTienda(cfg) || !valido(cfg?.[FLOW_TIENDA_ID])) return false;
  if (CLAVES_FLOW_PEDIDO.some((k) => cfg?.[k] === cfg[FLOW_TIENDA_ID])) return false;
  return notaCarrito(cfg) && valido(cfg?.whatsapp_flow_categorias_id);
}

/** ¿Se ofrece a ESTE cliente? 'true' = todos; 'prueba' = solo los teléfonos de whatsapp_flow_tienda_telefonos. */
export function tiendaParaTelefono(cfg, telefono) {
  if (!tiendaConfigurada(cfg)) return false;
  return modoTienda(cfg) === 'todos' || enElCanario(telefono, { lista: cfg?.[TELEFONOS_TIENDA], porcentaje: 0 }).dentro;
}

/** El flowId de la tienda, o null si no está configurada (una tienda abierta se corta con 427). */
export const flowIdTienda = (cfg) => (tiendaConfigurada(cfg) ? cfg[FLOW_TIENDA_ID] : null);

/** El flowId que corresponde a una foto: la tienda o el de siempre (con dirección y nota). */
export const flowIdEsperadoFormulario = (cfg, datos) => (datos?.version === VERSION_TIENDA
  ? flowIdTienda(cfg) : flowIdEsperadoConNota(cfg, datos));

/** Los flowId con endpoint que el transporte puede mandar: los de hoy y, configurada, la tienda. */
export function flowIdsConEndpointFormularios(cfg) {
  const tienda = flowIdTienda(cfg);
  return tienda ? [...flowIdsConEndpointConNota(cfg), tienda] : flowIdsConEndpointConNota(cfg);
}

/**
 * Un formulario abierto que ya no debe seguir (el endpoint responde 427):
 *   - una tienda, cuando la tienda ya no es para este cliente (revertida,
 *     apagada o su teléfono salió de la lista de prueba);
 *   - un «Tu carrito» (carrito_v1) o un «Arma tu pedido» por categorías abierto
 *     ANTES de encender la tienda para este cliente: al final la foto
 *     recalculada sería la de la tienda y su recibo se perdería.
 * Uno que salió en lugar de la tienda porque la tienda no lo admitía (más de 20
 * renglones o categorías, fuera del carrito…) lleva `sin_tienda` en su foto y
 * sigue: cortarlo mandaría al cliente a un formulario idéntico, una y otra vez.
 */
export function sinTiendaVieja(cfg, datos, telefono) {
  const activa = tiendaParaTelefono(cfg, telefono);
  if (datos?.version === VERSION_TIENDA) return !activa;
  return activa && (datos?.version === 'carrito_v1' || datos?.presentacion === 'categorias_v1') && !datos?.sin_tienda;
}
