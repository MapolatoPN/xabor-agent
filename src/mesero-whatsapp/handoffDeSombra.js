// ─── LO QUE EL CANAL HABRÍA ENTREGADO, Y EL MOMENTO EN QUE LO HABRÍA HECHO ─
//
// `pedidoHipotetico` contesta QUÉ se entregaría. Esto contesta CUÁNDO, y sella
// la identidad igual que la sella el canal productivo. Sigue sin ejecutar
// nada: el handoff de sombra termina en la propuesta.
//
// ── LA FRONTERA REAL, COPIADA AL PIE DE LA LETRA ─────────────────────────
//
// El canal hace exactamente cuatro cosas al objeto de orden antes de cruzar,
// y después llama. Nada más (whatsapp-meta.js):
//
//   1188  orden.canal = 'whatsapp'
//   1189  orden.cliente.telefono = orden.cliente.telefono || telefono
//   1197  orden.negocioId = negocioId
//   1203  orden.telefono_conversacion = telefono
//   1210  await registrarPedido(orden, 'whatsapp')
//
// Se reproducen las cuatro y se para antes de la quinta. No se copia el canal
// —son cuatro asignaciones, no un bloque— y no se inventa ninguna.
//
// ── LOS DOS TELÉFONOS NO SON EL MISMO ────────────────────────────────────
//
// Es el incidente XAB-0114, y el comentario del canal lo explica: el cliente
// puede dictar un teléfono de ENTREGA distinto del suyo. Entonces
// `cliente.telefono` es ese dato logístico, y `telefono_conversacion` es
// SIEMPRE el remitente del webhook, para que quien escribió pueda recuperar su
// pedido aunque haya dictado otro número.
//
// Por eso uno lleva `||` y el otro no. Invertirlo o igualarlos sería otra
// semántica, y aquí se reproduce la que hay.
//
// ── CUÁNDO HAY HANDOFF ───────────────────────────────────────────────────
//
// No hace falta un candado nuevo: el que decide ya está certificado. La fase
// vale 'confirmando' exactamente UNA vez por confirmación, porque
// `confirmacionVigente` exige que el resumen que el cliente leyó siga
// describiendo el pedido y `ctx.resumenConfirmado` la consume. Dos «confirmo»
// seguidos dan una sola. Un cambio después de confirmar cambia la huella del
// resumen, y entonces hace falta resumen nuevo y confirmación nueva.
//
// Así que el handoff se cuelga de esa transición en vez de inventarse otra: un
// segundo candado con sus propias reglas sería un segundo sitio donde
// equivocarse.
import { createHash } from 'node:crypto';
import { construirPedidoHipotetico } from './pedidoHipotetico.js';

/** Los nueve campos de cliente del contrato, en orden estable. */
const CAMPOS_DEL_CLIENTE = ['nombre', 'telefono', 'calle', 'numero_exterior',
  'numero_interior', 'colonia', 'entre_calles', 'referencia', 'direccion'];

// ── UNA HUELLA NO PUEDE PARECER UN TELÉFONO ──────────────────────────────
//
// `pareceSensibleElRegistro` marca como sensible cualquier tirada de 7 dígitos
// o más, que es como detecta un teléfono sin redactar. Un hash hexadecimal
// puede dar esa tirada por pura suerte —la primera huella que salió fue
// `9344480e36`, con siete dígitos seguidos— y entonces la guardia marca un
// registro que no lleva ni un dato personal.
//
// No se toca la guardia para que pase el log: se parte la huella en dos grupos
// de cinco. Sigue siendo la misma huella y determinista, y ya no puede tener
// una tirada de más de cinco dígitos.
const hash10 = (s) => {
  const h = createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 10);
  return `${h.slice(0, 5)}-${h.slice(5)}`;
};

/**
 * La huella determinística de una propuesta.
 *
 * Mismo estado autorizado, misma huella. Cambia un item, un modificador, una
 * cantidad, la modalidad, el pago o un dato de cliente que viaje al pedido, y
 * cambia. NO entra el `_lid`: es trazabilidad del observador, y dos carritos
 * con el mismo pedido y distintos lids son el mismo pedido.
 */
export function huellaDeLaPropuesta(propuesta) {
  if (!propuesta) return null;
  return hash10(JSON.stringify({
    negocioId: propuesta.negocioId ?? null,
    canal: propuesta.canal ?? null,
    telefono_conversacion: propuesta.telefono_conversacion ?? null,
    modalidad: propuesta.modalidad ?? null,
    forma_pago: propuesta.forma_pago ?? null,
    cliente: CAMPOS_DEL_CLIENTE.map((c) => propuesta.cliente?.[c] ?? null),
    items: (propuesta.items || []).map((i) => [
      i.producto_id, i.cantidad,
      (i.modificadores || []).map((m) => `${m.grupo}:${(m.opciones || []).join('|')}`).sort(),
      i.notas || '',
    ]),
  }));
}

/**
 * ¿Habría handoff en este turno, y con qué propuesta?
 *
 * `resultado` es lo que devolvió `atenderTurno`. La identidad la pasa quien
 * llama —el canal la conoce, el modelo no— y esta función no la busca en el
 * carrito ni una sola vez.
 *
 * Devuelve:
 *   listo       la propuesta está completa Y confirmada: cruzaría el borde
 *   nuevo       este turno GENERÓ el handoff (la confirmación se consumió aquí)
 *   huella      la de la propuesta, o null si no hay propuesta
 *   propuesta   siempre que haya identidad y renglones, aunque no esté lista:
 *               media gracia de observar es poder mirar lo que aún no cruza
 *   bloqueos    por qué no
 */
export function handoffDeSombra(resultado, {
  negocioId = null, canal = null, telefonoConversacion = null,
  catalogo = [], requierePago = true, handoffPrevio = null,
} = {}) {
  const artefacto = construirPedidoHipotetico({
    carrito: resultado?.carrito,
    catalogo,
    negocioId,
    canal,
    telefonoConversacion,
    aclaraciones: resultado?.aclaraciones || [],
    falta: resultado?.falta || [],
    confirmacionVigente: !!resultado?.confirmacionVigente,
    requierePago,
  });

  // El sellado del canal, sus cuatro líneas. `negocioId`, `canal` y
  // `telefono_conversacion` ya los puso el artefacto con lo que se le pasó;
  // lo que falta es el `||` del teléfono del cliente, que es la mitad
  // interesante del XAB-0114.
  const propuesta = artefacto.propuesta;
  if (propuesta && telefonoConversacion && !propuesta.cliente.telefono) {
    propuesta.cliente.telefono = String(telefonoConversacion);
  }

  // LA CONFIRMACIÓN SE CONSUMIÓ EN ESTE TURNO. No hay candado nuevo: 'confirmando'
  // ya vale una sola vez por confirmación, y eso está certificado aparte.
  const confirmadoAhora = resultado?.fase === 'confirmando';
  if (!telefonoConversacion || typeof telefonoConversacion !== 'string' || !telefonoConversacion.trim()) {
    artefacto.bloqueos.push('sin_telefono_conversacion');
  }
  const listo = !!propuesta && artefacto.bloqueos.length === 0 && confirmadoAhora;
  const huella = huellaDeLaPropuesta(propuesta);

  const bloqueos = [...artefacto.bloqueos];
  if (!confirmadoAhora) bloqueos.push('sin_confirmacion');

  return {
    listo,
    // Nuevo contra ya visto. Sin esto, un observador que vuelva a mirar el
    // mismo estado contaría dos pedidos donde hubo uno.
    nuevo: listo && huella !== handoffPrevio,
    yaObservado: listo && huella === handoffPrevio,
    confirmacionVigente: !!resultado?.confirmacionVigente,
    huella,
    propuesta,
    bloqueos,
  };
}

/**
 * Lo que va al log, sin una sola cosa que no deba salir.
 *
 * El registro NO lleva la propuesta: lleva su huella y sus formas. El teléfono
 * de la conversación va hasheado y separado en dos grupos de cinco. `conv`
 * conserva el identificador que usa el resto de la sombra para cruzar líneas.
 * La dirección, el nombre y el teléfono del cliente no salen NI
 * redactados: de ellos sólo se dice CUÁNTOS campos venían.
 *
 * Para diagnóstico profundo está `propuesta` en el retorno de `handoffDeSombra`,
 * que vive en memoria y en las pruebas — no en el log.
 */
export function registroDeHandoff(h, { turno = null, negocioId = null, conversacion = null } = {}) {
  const p = h?.propuesta || null;
  // Los bloqueos pueden llevar nombres libres de productos o campos. Al log
  // salen códigos cerrados, nunca sus detalles ni valores de un borrador.
  const codigos = new Set(['sin_negocio', 'sin_canal', 'sin_items', 'sin_modalidad',
    'sin_pago', 'aclaraciones_abiertas', 'resumen_no_vigente', 'sin_confirmacion',
    'sin_telefono_conversacion', 'producto_sin_id', 'falta']);
  const etiqueta = (v, permitidos) => v == null ? null : permitidos.includes(v) ? v : 'otro';
  return {
    negocio: negocioId ?? null,
    conv: conversacion ?? null,
    turno,
    handoff_ready: !!h?.listo,
    handoff_nuevo: !!h?.nuevo,
    handoff_ya_observado: !!h?.yaObservado,
    confirmacion_vigente: !!h?.confirmacionVigente,
    huella: h?.huella ?? null,
    bloqueos: [...new Set((h?.bloqueos || []).map(b => {
      const codigo = String(b).split(':', 1)[0];
      return codigos.has(codigo) ? codigo : 'otro';
    }))],
    items_count: (p?.items || []).length,
    unidades: (p?.items || []).reduce((s, i) => s + (Number(i.cantidad) || 0), 0),
    modalidad: etiqueta(p?.modalidad, ['entrega a domicilio', 'recoger en tienda', 'comer aqui', 'para llevar']),
    forma_pago: etiqueta(p?.forma_pago, ['efectivo', 'terminal', 'transferencia', 'tarjeta', 'clip', 'mercadopago']),
    // Formas, no contenidos: cuántos campos de cliente viajarían y si hay
    // dirección, sin decir cuál.
    cliente_campos: p?.cliente ? Object.keys(p.cliente).length : 0,
    cliente_con_direccion: !!(p?.cliente
      && (p.cliente.calle || p.cliente.direccion || p.cliente.colonia)),
    tel_conv: p?.telefono_conversacion ? hash10(p.telefono_conversacion) : null,
  };
}

/** Una línea por handoff, con el mismo prefijo greppable que el resto. */
export const lineaDeHandoff = (registro) => '[SOMBRA-MESERO-HANDOFF] ' + JSON.stringify(registro);
