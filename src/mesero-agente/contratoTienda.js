// Contrato tienda_v1 (formulario «tienda» de WhatsApp con fotos): los nombres
// de la configuración por negocio y los valores por omisión que el dueño aún no
// decidió. Módulo puro y sin dependencias: lo leen el servidor y los scripts
// (definicion-flow-tienda.mjs) sin cargar la base de datos.
//
// Las dos claves nacen apagadas: sin `whatsapp_flow_tienda_v1` en 'prueba' o
// 'true' no se genera ninguna miniatura ni cambia ningún formulario.

export const VERSION_TIENDA = 'tienda_v1';
export const BANDERA_TIENDA = 'whatsapp_flow_tienda_v1'; // 'prueba' = solo TELEFONOS_TIENDA; 'true' = todos
export const FLOW_TIENDA_ID = 'whatsapp_flow_tienda_id';
export const TELEFONOS_TIENDA = 'whatsapp_flow_tienda_telefonos';

/** 'todos' con la bandera en 'true', 'prueba' con 'prueba'; null apagada (cualquier otro valor). */
export function modoTienda(cfg) {
  const v = cfg?.[BANDERA_TIENDA];
  return v === 'true' ? 'todos' : v === 'prueba' ? 'prueba' : null;
}

/**
 * Preguntas del diseño sin respuesta del dueño (3-oct-2026): se usan estos
 * valores. Cambiar uno es cambiar esta línea (y su prueba en check-flow-tienda).
 *   reemplazaArmaTuPedido / reemplazaTuCarrito: con la bandera encendida, la
 *     tienda ocupa el lugar de «Arma tu pedido» (categorias_v1) y de «Tu
 *     carrito» (carrito_v1). Los lee fotoTienda (formularioAgrupado.js).
 *   variosTacos: se conserva «Varios tacos a la vez» (la pantalla TACOS de hoy).
 *   vigenciaMinutos: igual que hoy (flowRepetibleSql.js e interactivos.js usan 30).
 */
export const POR_OMISION_TIENDA = Object.freeze({
  reemplazaArmaTuPedido: true,
  reemplazaTuCarrito: true,
  variosTacos: true,
  vigenciaMinutos: 30,
});
