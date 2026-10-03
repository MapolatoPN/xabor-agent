// La NOTA DEL PEDIDO dentro del formulario (decisión de Mario del 3-oct-2026):
// una dedicatoria o indicaciones para todo el pedido. El 2-oct tres clientes
// quisieron poner «Feliz cumpleaños…» y tuvieron que pedírselo a una persona.
// Es un campo opcional de «Entrega y pago»; se guarda en el pedido
// (carrito.datos.notas → orden.notas, la convención del POS y la tienda), sale
// en «Revisa tu pedido» y se imprime en la comanda.
//
// Contrato `nota_v1`. Solo existe junto con el contrato de dirección (la
// pantalla «Entrega y pago» con su propio paso) y se enciende por negocio con
// una bandera y un flowId propio por formulario:
//   whatsapp_flow_nota_v1 = 'true'
//   whatsapp_flow_categorias_nota_id / whatsapp_flow_carrito_nota_id
// La bandera y el flowId deciden JUNTOS: el formulario que se abre es el que
// declara la nota si y solo si la foto la lleva. Así ningún `nota_inicial`
// llega a un Flow publicado que no lo declara (Meta rechazaría la pantalla), y
// apagar la bandera a mano nunca deja un formulario a medias. Sin la bandera,
// la foto, los Flows y las respuestas son los de siempre.
import { CONTRATO_DIRECCION, contratoCarrito, contratoCategorias, flowIdEsperado, flowIdsConEndpoint, limpiarCampo }
  from './direccionFormulario.js';

export const CONTRATO_NOTA = 'nota_v1';
export const LIMITE_NOTA_PEDIDO = 200;
export const BANDERA_NOTA = 'whatsapp_flow_nota_v1';
export const ERROR_NOTA_PEDIDO = 'La nota del pedido admite hasta 200 letras.';

const valido = (id) => /^\d{5,30}$/.test(id || '');
/** La nota solo con la bandera, el contrato de dirección y el flowId propio de ese formulario. */
export const notaCategorias = (cfg) => cfg?.[BANDERA_NOTA] === 'true' && contratoCategorias(cfg)
  && valido(cfg?.whatsapp_flow_categorias_nota_id);
export const notaCarrito = (cfg) => cfg?.[BANDERA_NOTA] === 'true' && contratoCarrito(cfg)
  && valido(cfg?.whatsapp_flow_carrito_nota_id);

/** Texto de la nota, saneado como la dirección. `null` si no es texto o pasa del límite. */
export const leerNotaPedido = (valor) => limpiarCampo(valor, LIMITE_NOTA_PEDIDO);

/**
 * Lo que la foto lleva con el contrato: la marca y la nota que ya tiene el
 * pedido (precarga; dejar el campo vacío la borra, y nadie borra lo que no ve).
 */
export function fotoNota({ estado }) {
  const nota = estado?.carrito?.datos?.notas;
  return { contrato_nota: CONTRATO_NOTA,
    nota_inicial: typeof nota === 'string' && nota.length <= LIMITE_NOTA_PEDIDO ? nota : '' };
}

/** La foto sin la nota: la compra de platillos del carrito no tiene «Entrega y pago». */
export function sinContratoNota(foto) {
  const { contrato_nota, nota_inicial, ...resto } = foto || {};
  return resto;
}

/**
 * La nota con que abre «Entrega y pago»: la de un intento rechazado (no se
 * pierde lo que escribió), la que ya mandó en este formulario o la del pedido.
 */
export function notaInicialEntrega(foto, b, intento = null) {
  const deIntento = typeof intento?.nota === 'string' ? leerNotaPedido(intento.nota) : null;
  if (deIntento !== null) return deIntento;
  if (typeof b?.nota === 'string') return b.nota;
  return typeof foto?.nota_inicial === 'string' && foto.nota_inicial.length <= LIMITE_NOTA_PEDIDO ? foto.nota_inicial : '';
}

/**
 * El cierre del formulario con la nota en definir_entrega. Sin contrato el
 * recibo no puede traer nota. Con contrato, un recibo sin nota (el formulario
 * no pasó por «Entrega y pago») deja la del pedido como está; '' la borra.
 */
export function cierreConNota(foto, cierre, nota) {
  if (!cierre) return null;
  if (foto?.contrato_nota !== CONTRATO_NOTA) return nota === undefined ? cierre : null;
  if (nota === undefined) return cierre;
  const limpia = leerNotaPedido(nota);
  const i = cierre.findIndex((c) => c.herramienta === 'definir_entrega');
  if (limpia === null || i < 0) return null;
  return cierre.map((c, j) => (j === i ? { ...c, argumentos: { ...c.argumentos, nota_pedido: limpia } } : c));
}

/** El flowId que corresponde a una foto, con la nota: si la bandera se apaga, ninguno (se corta). */
export function flowIdEsperadoConNota(cfg, datos) {
  if (datos?.contrato_nota === CONTRATO_NOTA) {
    if (datos.version === 'carrito_v1') return notaCarrito(cfg) ? cfg.whatsapp_flow_carrito_nota_id : null;
    if (datos.version === 'repetible_v1') return notaCategorias(cfg) ? cfg.whatsapp_flow_categorias_nota_id : null;
    return null;
  }
  return flowIdEsperado(cfg, datos);
}

/** Los flowId con endpoint, más los de la nota. Sin sus claves, la lista de siempre. */
export const flowIdsConEndpointConNota = (cfg) => [...flowIdsConEndpoint(cfg),
  ...[cfg?.whatsapp_flow_categorias_nota_id, cfg?.whatsapp_flow_carrito_nota_id].filter(valido)];

/**
 * Un formulario con dirección y SIN nota abierto antes de activar la nota: su
 * recibo ya no coincidiría con la foto nueva y se perdería al final. Se corta
 * desde el principio, igual que `sinDireccionVieja`.
 */
export const sinNotaVieja = (cfg, datos) => datos?.contrato === CONTRATO_DIRECCION && datos?.contrato_nota !== CONTRATO_NOTA
  && (datos?.version === 'carrito_v1' ? notaCarrito(cfg) : datos?.presentacion === 'categorias_v1' && notaCategorias(cfg));
