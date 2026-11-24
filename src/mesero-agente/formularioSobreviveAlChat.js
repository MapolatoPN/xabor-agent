// «Este formulario ya no está disponible», opción A (24-nov-2026, decisión de Mario).
//
// Hasta hoy, cualquier texto del cliente posterior al envío (texto_posterior)
// y cualquier respuesta del bot (estrena diálogo) cortaban la tienda que el
// cliente tenía abierta. Medido del 9 al 24-nov en Obispado y Acuña: en 7 de
// 30 casos el cliente escribió en el chat y volvió segundos después al MISMO
// formulario. En otros 6 volvió al viejo después de recibir uno más nuevo.
//
// Con la bandera `whatsapp_formulario_sobrevive_chat_v1` (por negocio, nace
// apagada) y el modo formulario completo para ese cliente, la tienda
// (tienda_v1) sigue viva pese al texto y al diálogo nuevo mientras:
//   - siga disponible y en la misma conversación;
//   - no haya llegado del cliente una foto, un documento ni un pedido de catálogo;
//   - no haya pedido registrado, evento, confirmación incierta, hecho ni reserva;
//   - la pregunta pendiente sea de la recepción o de un formulario de pedido
//     (nunca un resumen por confirmar ni una pregunta que espera respuesta);
//   - el carrito sea el mismo con el que se envió (líneas, cantidades, entrega y pago).
// Lo demás lo sigue cortando igual: la vigencia (30 min sin actividad, 2 h),
// una persona atendiendo (pausa, takeover, revisión), las banderas y el flowId.
//
// Un formulario más nuevo ya no corta al viejo. Los dos sirven para lo mismo,
// y solo uno puede volverse pedido: el primero que se envía cambia el carrito
// y el pendiente (resumen por confirmar), y el otro muere por esas mismas
// reglas. Al final, el envío (interactivos.js) vuelve a comparar la foto
// completa contra la carta y el carrito de ese momento (formularioVigente).
//
// Con la bandera apagada, todo es como antes, byte a byte (también el texto
// del error).
import { modoIA } from './recepcionista.js';
import { VERSION_TIENDA } from './contratoTienda.js';

export const CLAVE_SOBREVIVE_CHAT = 'whatsapp_formulario_sobrevive_chat_v1';

const ACCIONES_TIENDA = new Set(['flow_productos', 'flow_configurar']);

// La recepción (botones, lista «Información»), el saludo con botones y los
// formularios de pedido. Fuera: confirmar_resumen y lo que espera respuesta
// (elegir_opcion, modalidad, pago, direccion), elegir_producto (cambia la
// foto), configurar_pedido (formulario legado), fecha_hora, eventos y servicios.
const PENDIENTES_COMPATIBLES = new Set(['recepcion', 'inicio_mapo', 'agregar_otro', 'editar_pedido']);

// Lo que sí sigue cortando la tienda aunque la bandera esté encendida: una
// foto, un documento o un pedido de catálogo del cliente después del envío.
// Es la misma ventana que texto_posterior. `entrada` es la del toque, en el
// envío final: solo cuenta lo que llegó antes de él (id menor).
const TIPOS_QUE_CORTAN = "('image','document','order')";
export function sqlOtroPosterior({ pregunta, telefono, entrada = null }) {
  return `EXISTS(SELECT 1 FROM whatsapp_entradas otro WHERE otro.negocio_id=${pregunta}.negocio_id
    AND otro.telefono=${telefono} AND otro.recibido_at>${pregunta}.created_at${entrada ? ` AND otro.id<${entrada}.id` : ''}
    AND otro.payload->'message'->>'type' IN ${TIPOS_QUE_CORTAN})`;
}

/** La bandera está encendida y este cliente está en el modo formulario completo. */
export function sobreviveAlChatActivo(cfg, telefono) {
  if (cfg?.[CLAVE_SOBREVIVE_CHAT] !== 'true') return false;
  const ia = modoIA(cfg, telefono);
  return ia?.modo === 'formulario' && ia.completo === true;
}

/**
 * El carrito del estado es el que el formulario muestra: mismas líneas (en
 * orden, por identidad y cantidad) y la misma entrega y forma de pago. Es la
 * parte de la foto que puede moverse por el chat; la carta y los precios los
 * revisa formularioVigente al final.
 */
export function carritoComoEnLaFoto(datos, estado) {
  const items = estado?.carrito?.items || [];
  const lineas = Array.isArray(datos?.lineas) ? datos.lineas : null;
  const d = estado?.carrito?.datos || {};
  if (!lineas || items.length !== lineas.length) return false;
  return items.every((item, i) => String(item?.lid) === String(lineas[i]?.linea_id)
      && String(item?.id) === String(lineas[i]?.ficha?.id)
      && Number(item?.cantidad) === Number(lineas[i]?.cantidad))
    && (d.modalidad || '') === (datos.modalidad || '')
    && (d.forma_pago || '') === (datos.pago || '');
}

/**
 * ¿El texto del cliente y el diálogo nuevo pueden dejar viva esta tienda?
 * `q` es la fila de la pregunta con `accion`, `datos` y `otro_posterior` (que
 * la consulta tiene que haber calculado: si falta, no sobrevive).
 */
export function formularioSobreviveAlChat({ q, estado, cfg, telefono }) {
  if (!q || !estado || !sobreviveAlChatActivo(cfg, telefono)) return false;
  if (!ACCIONES_TIENDA.has(q.accion) || q.datos?.version !== VERSION_TIENDA) return false;
  if (q.estado !== 'disponible' || q.otro_posterior !== false) return false;
  if (!q.ciclo || q.ciclo !== estado.conversacionId) return false;
  if (estado.botonesReserva || estado.folio || estado.evento || estado.confirmacionIncierta
    || Object.values(estado.hechos || {}).some(Boolean)) return false;
  const tipo = estado.pendiente?.tipo ?? null;
  if (tipo !== null && !PENDIENTES_COMPATIBLES.has(tipo)) return false;
  return carritoComoEnLaFoto(q.datos, estado);
}

// Lo que el teléfono muestra cuando la tienda ya no sigue (opción C). Solo
// cuando la causa es segura; si no, el texto de siempre.
export const AVISOS_NO_DISPONIBLE = Object.freeze({
  persona: 'Ya te está atendiendo alguien del equipo: sigue con esa persona en el chat.',
  vencido: 'Este formulario venció por tiempo. Escribe «seguir pedido» en el chat y te mandamos uno nuevo.',
});

/** El texto del error para el endpoint, o undefined (el de siempre). */
export function avisoNoDisponible({ q, barreras, telefono }) {
  if (!sobreviveAlChatActivo(barreras?.cfg, telefono)) return undefined;
  if (barreras.activo === false && barreras.persona === true) return AVISOS_NO_DISPONIBLE.persona;
  if (q && q.vigente === false) return AVISOS_NO_DISPONIBLE.vencido;
  return undefined;
}
