// ─── «Pasar a efectivo» un pedido que esperaba el pago con enlace ───────────
//
// XAB-1130 (2-oct): un pedido de WhatsApp esperaba el pago con enlace
// (estado `pendiente_pago`). El equipo lo «pasó a efectivo» con ✏️ Corregir
// forma de pago, y PATCH /api/admin/pedido/:folio/pago solo reescribió la
// etiqueta: el pedido siguió esperando, no salió comanda y a los 30 min el
// vencimiento del enlace lo canceló solo. Encima el panel imprimió el ticket
// de cliente, así que el equipo creyó que había entrado.
//
// Dos piezas, a propósito separadas:
//
//   1. LA TRABA, sin bandera: sobre un pedido `pendiente_pago` (o ya
//      `cancelado`) la ruta ya no reetiqueta en silencio. Responde 409 con un
//      texto que dice qué hacer. Cortar un cambio que hoy no hace nada y engaña
//      no le cambia la operación a nadie.
//
//   2. LA LIBERACIÓN, con `pago_presencial_libera_pendiente`='true' por
//      negocio (apagada por omisión): pasar a efectivo o terminal manda el
//      pedido a cocina, de forma atómica e idempotente. Anula a mano la
//      garantía «sin pago no hay cocina» del enlace, así que solo la hace un
//      administrador identificado, queda auditada y solo aplica cuando el
//      pendiente lo causó el ENLACE -- nunca el anticipo obligatorio del
//      negocio, una reserva programada, un pago en revisión o la tienda.
//
// La transición vive en una sola transacción bajo el MISMO advisory lock que
// asentarPagoRealVerificado, vencerEsperaDePago y la creación de enlaces
// ('obligacion_pago' sobre negocio+pedido): la carrera dinero / vencimiento /
// cambio queda decidida en la base. El intento del enlace pasa a 'vencido'
// (no 'invalidado'): un pago tardío por ese enlace se asienta como
// `pago_tardio`, sin derivar y sin segunda comanda, y sigue en la
// reconciliación para que el dinero nunca se pierda. Con 'invalidado' sí
// derivaría y marcaría pagado un pedido que el repartidor cobra en la puerta.
//
// La comanda sale por las funciones de siempre de orderManager (sin tocarlo):
// el UPDATE a 'nuevo' crea la deuda de emisión de la 063 en la misma
// transacción, y emitirPedido la reclama. Si el proceso muere entre el COMMIT
// y la emisión, reconciliarEmisionesOperacionalesPendientes la saca sola.
//
// Revisión del 3-oct (correcciones 1-4 y dos mejoras):
//   · Antes de vencer los intentos vivos se RECONSULTA a Clip (el caso más
//     probable de doble cobro: «ya pagué pero no me llega», el equipo lo pasa
//     a efectivo y Clip ya tenía el cobro). Si Clip dice pagado se asienta y
//     se deriva por el camino de siempre, y no se libera.
//   · Ya liberado, ✏️ solo acepta efectivo o terminal y corrige también el
//     tipo y la marca (corregirFormaDePedidoLiberadoTx).
//   · Ningún texto promete una acción que el panel no tiene, y todos los que
//     mandan a cancelar y recapturar dicen que se avise al cliente que NO pague
//     el enlace: Clip no permite cancelar un checkout y sigue cobrable.
import {
  pool,
  poolDeClaims,
  calcularVersionPedidoHash,
  registrarAuditoriaPlataforma,
} from '../services/database.js';
import { consumirReservasDePedido } from '../services/promoReservas.js';
import { debeRegistrarse, registrarUsosDeVenta, telefonoDeAuditoria } from '../services/promoUsosAuditoria.js';
import { verificarYAsentarClip, derivarPedidoPorPagoAsentado } from '../services/webhookPagos.js';
import { esPagoPorEnlace } from './pagoPorEnlace.js';
import { emitirPedido, obtenerPedidoPorId, agregarPedidoAMemoria } from './orderManager.js';

export const BANDERA_LIBERA_PENDIENTE = 'pago_presencial_libera_pendiente';

/** 'efectivo' | 'terminal' | null. Solo lo que se cobra en persona libera. */
export function tipoPresencial(formaPago) {
  const v = String(formaPago ?? '').trim().toLowerCase();
  if (v === 'efectivo') return 'efectivo';
  if (v.startsWith('terminal')) return 'terminal';
  return null;
}

export function banderaEncendida(valor) {
  return String(valor ?? '').trim().toLowerCase() === 'true';
}

// ── Textos que ve el equipo: cada uno dice qué hacer ────────────────────────
//
// Cancelar el pedido NO apaga el enlace: Clip no permite cancelar un checkout
// y sigue cobrable hasta que vence en Clip (cancelarPedidoActivo tampoco toca
// el intento). Por eso todo texto que manda a «cancelar y capturar de nuevo»
// dice también que se avise al cliente. Si lo paga de todos modos, el dinero
// se asienta como pago tardío y Caja lo muestra en «Pagos en línea por
// revisar» (cortesCaja.alertasDePagosEnLinea).
const NO_PAGUE_EL_ENLACE =
  'avísale al cliente que NO pague el enlace que ya tiene: sigue activo y se le cobraría dos veces';
const SI_LO_PAGA =
  'Si lo paga de todos modos, Caja lo marca en «Pagos en línea por revisar» para devolverlo.';

export const TEXTOS = {
  esperaPagoBanderaApagada:
    'Este pedido espera el pago con enlace y todavía no entra a cocina. Cambiar la forma de pago aquí no lo libera: '
    + 'se cancelará solo cuando venza la espera. Si el cliente va a pagar en efectivo o con terminal: '
    + `${NO_PAGUE_EL_ENLACE}; cancela este pedido y captúralo de nuevo en el POS. `
    + `No lo pases a «Preparando»: el enlace seguiría cobrable. ${SI_LO_PAGA}`,
  esperaPagoFormaNoPresencial:
    'Este pedido espera el pago con enlace. Solo se puede pasar a 💵 Efectivo o 💳 Terminal: así se manda a cocina '
    + 'y se cobra al entregar.',
  // Verificación final (3-oct): antes salía igual en TODO cancelado y se leía
  // «…se le cobraría dos veces anterior.». La advertencia del enlace va solo
  // si el pedido tiene o tuvo uno (pedidoTuvoEnlace); un cancelado del POS
  // recibe la versión sin enlace. Sin el dato se avisa: callar ante un enlace
  // vivo es el doble cobro.
  cancelado: ({ conEnlace = true } = {}) => (conEnlace
    ? 'Este pedido está cancelado (si esperaba el pago con enlace, venció la espera): cambiar la forma de pago no lo '
      + `revive. Si el cliente sí lo quiere, captúralo de nuevo en el POS y ${NO_PAGUE_EL_ENLACE}. ${SI_LO_PAGA}`
    : 'Este pedido está cancelado: cambiar la forma de pago no lo revive. Si el cliente sí lo quiere, captúralo de '
      + 'nuevo en el POS.'),
  usuarioRequerido:
    'Para mandar a cocina un pedido sin el pago en línea hace falta entrar con tu usuario (no con la contraseña '
    + 'general): así queda registrado quién lo hizo.',
  anticipoObligatorio:
    'Este negocio exige pago anticipado en los pedidos por WhatsApp: el pedido no se manda a cocina sin el pago. '
    + `Si el cliente va a pagar en persona: ${NO_PAGUE_EL_ENLACE}; cancela el pedido y captúralo de nuevo en el POS.`,
  noEsEnlace:
    'Este pedido espera un pago que no es del enlace: no se puede pasar a efectivo desde aquí. Si el cliente pagará '
    + 'en persona, avísale que no haga ese pago, cancela el pedido y captúralo de nuevo en el POS.',
  programado:
    'Este pedido está programado para más tarde: pasarlo a efectivo ahora no lo mandaría a cocina. '
    + `${NO_PAGUE_EL_ENLACE[0].toUpperCase()}${NO_PAGUE_EL_ENLACE.slice(1)}; cancélalo y vuelve a programarlo con pago en efectivo.`,
  tienda:
    'Los pedidos de la tienda en línea solo entran a cocina con el pago confirmado: no se pasan a efectivo desde aquí.',
  // Corrección 3 (3-oct): antes decía «confírmalo o recházalo», y el panel no
  // tiene con qué: la confirmación manual solo acepta transferencias, y ni
  // esa tiene botón (solo POST /api/admin/pagos/:id/confirmar-manual). Ahora
  // dice lo que sí se puede hacer, según de qué pago se trate.
  pagoEnRevision: ({ transferencia = false } = {}) => (transferencia
    ? 'Hay una transferencia de este pedido en revisión (el cliente mandó comprobante): para no cobrarle dos veces, '
      + 'no se pasa a efectivo desde aquí. Revisa en el banco si llegó. Si llegó, no le cobres en persona y pide a '
      + 'soporte de Xabor que la confirme (el panel todavía no tiene ese botón). Si no llegó y el cliente pagará en '
      + 'persona, cancela este pedido y captúralo de nuevo en el POS.'
    : 'El cliente avisó que ya pagó el enlace (mandó comprobante) y el cobro está en revisión: para no cobrarle dos '
      + 'veces, no se pasa a efectivo desde aquí. Clip todavía no confirma el cobro; si entra, el pedido sale a cocina '
      + 'solo. Si en tu cuenta de Clip no aparece y el cliente pagará en persona: '
      + `${NO_PAGUE_EL_ENLACE}; cancela este pedido y captúralo de nuevo en el POS.`),
  yaPagado:
    'Este pedido ya se pagó en línea: no lo cobres en persona. Sale a cocina en cuanto termine de asentarse el pago.',
  yaPagadoSegunClip:
    'Clip acaba de confirmar que el cliente YA pagó el enlace: no lo cobres en persona. El pedido sale a cocina como '
    + 'pagado.',
  // Corrección 4 (3-oct): ya liberado, la forma de pago solo puede quedar en
  // algo que se cobra en persona. Reetiquetarlo a enlace o Rappi dejaba la
  // etiqueta diciendo una cosa y el tipo y la marca otra.
  soloPresencialTrasLiberar:
    'Este pedido ya se pasó a cobro en persona y salió a cocina: su forma de pago solo puede quedar en 💵 Efectivo '
    + 'o 💳 Terminal. El enlace ya no se usa; si el cliente lo pagó de todos modos, no le cobren otra vez: Caja lo '
    + 'marca en «Pagos en línea por revisar».',
  promocionDesfasada:
    'La promoción de este pedido ya no corresponde a su versión actual: revisa el pedido antes de pasarlo a efectivo.',
  noEsperaPago:
    'Este pedido ya no espera el pago con enlace (pudo pagarse o cambiar en otra pantalla). Recarga el tablero.',
  yaLiberadoConOtraForma: (forma) =>
    `Este pedido ya se pasó a ${forma} y salió a cocina. Recarga el tablero; si hay que corregir la forma de pago, `
    + 'hazlo después desde la comanda.',
};

const no = (http, codigo, error) => ({ ok: false, http, codigo, error });

// ¿El cliente tiene (o tuvo) un enlace de pago de este pedido? Todo enlace
// nace como fila de `pagos` (crearRegistroPago, antes de pedírselo a Clip) y
// cuenta en CUALQUIER estado: vencido o invalidado en Xabor, en Clip sigue
// cobrable. El legacy, previo al ledger, vive en `datos.clip_link_id`. La
// forma de pago no basta: el «pasar a efectivo» viejo (XAB-1130) reescribía
// la etiqueta y dejaba el enlace vivo.
async function pedidoTuvoEnlace(cliente, nid, folio, datos = {}) {
  if (datos.clip_link_id) return true;
  const { rows } = await cliente.query(
    `SELECT 1 FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 AND tipo = 'enlace_pago' LIMIT 1`,
    [nid, folio]);
  return rows.length > 0;
}
const respuestaCancelado = async (cliente, nid, folio, datos) =>
  no(409, 'PEDIDO_CANCELADO', TEXTOS.cancelado({ conEnlace: await pedidoTuvoEnlace(cliente, nid, folio, datos) }));

/**
 * LA TRANSICIÓN, atómica. Devuelve { ok:true, datos, marca, pagosVencidos,
 * promocionesConsumidas } o { ok:true, yaLiberado:true } o
 * { ok:false, http, codigo, error }. Lanza solo ante un error real de base.
 *
 * `actor`: { usuarioId, esSoporte, rol } -- quién lo pidió (ya autorizado como
 * administrador por la ruta).
 */
export async function liberarPendientePagoAPresencialTx({ negocioId, folio, formaPago, actor = {} } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return no(404, 'NO_ENCONTRADO', 'Pedido no encontrado');
  const nid = negocioId.trim();
  const tipo = tipoPresencial(formaPago);

  const cliente = await poolDeClaims().connect();
  const salir = async (r) => { await cliente.query('ROLLBACK'); return r; };
  try {
    await cliente.query('BEGIN');
    // El MISMO lock que asentar, vencer y crear enlaces. Quien llegue segundo
    // relee y ve lo que dejó el primero: si entró el dinero, aquí se responde
    // «ya se pagó»; si venció, «cancelado»; si se liberó, idempotente.
    await cliente.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ['obligacion_pago', `${nid}:${folio}`]);

    const { rows: [fila] } = await cliente.query(
      `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, nid]);
    if (!fila) return salir(no(404, 'NO_ENCONTRADO', 'Pedido no encontrado'));
    const datos = fila.datos || {};

    if (fila.estado === 'cancelado') return salir(await respuestaCancelado(cliente, nid, folio, datos));
    if (fila.estado !== 'pendiente_pago') {
      const previa = datos.pago_cambiado_a_presencial;
      if (previa) {
        // Idempotente con la MISMA forma (doble clic, reintento, dos pantallas);
        // con OTRA forma se dice, no se traga en silencio.
        if (tipo && previa.forma_pago_tipo === tipo) {
          await cliente.query('COMMIT');
          return { ok: true, yaLiberado: true, marca: previa };
        }
        return salir(no(409, 'YA_LIBERADO_CON_OTRA_FORMA', TEXTOS.yaLiberadoConOtraForma(previa.forma_pago || previa.forma_pago_tipo)));
      }
      return salir(no(409, 'NO_ESPERA_PAGO', TEXTOS.noEsperaPago));
    }

    // La bandera y la política del negocio se leen DENTRO de la transacción:
    // la decisión se toma con lo que hay en la base en este instante.
    const { rows: cfg } = await cliente.query(
      `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2::text[])`,
      [nid, [BANDERA_LIBERA_PENDIENTE, 'pedido_requiere_anticipo']]);
    const valor = (clave) => cfg.find(c => c.clave === clave)?.valor;
    if (!banderaEncendida(valor(BANDERA_LIBERA_PENDIENTE))) {
      return salir(no(409, 'PEDIDO_ESPERA_PAGO_EN_LINEA', TEXTOS.esperaPagoBanderaApagada));
    }
    // Rappi, transferencia o el mismo enlace no se cobran en persona: no hay
    // nada que liberar, y reetiquetar volvería a ser el cambio mudo de XAB-1130.
    if (!tipo) return salir(no(409, 'PEDIDO_ESPERA_PAGO_EN_LINEA', TEXTOS.esperaPagoFormaNoPresencial));
    if (!actor?.usuarioId) return salir(no(403, 'USUARIO_REQUERIDO', TEXTOS.usuarioRequerido));
    if (datos.canal === 'tienda_online') return salir(no(409, 'TIENDA_PAGO_EN_LINEA', TEXTOS.tienda));
    // El anticipo obligatorio es una política del negocio, no una elección del
    // cliente: liberar aquí la anularía con un clic.
    if (banderaEncendida(valor('pedido_requiere_anticipo'))) {
      return salir(no(409, 'ANTICIPO_OBLIGATORIO', TEXTOS.anticipoObligatorio));
    }
    if (!esPagoPorEnlace(datos.forma_pago_tipo) && !esPagoPorEnlace(datos.forma_pago)) {
      return salir(no(409, 'PENDIENTE_NO_ES_ENLACE', TEXTOS.noEsEnlace));
    }
    // Un programado (o una conversión en curso) no crea deuda de emisión en la
    // 063: pasarlo a 'nuevo' no sacaría comanda y pisaría la conversión.
    if (datos.programado_para) return salir(no(409, 'PEDIDO_PROGRAMADO', TEXTOS.programado));

    const { rows: pagos } = await cliente.query(
      `SELECT id, estado, tipo FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 FOR UPDATE`,
      [nid, folio]);
    if (datos.pago_confirmado === true || datos.pago_confirmado === 'true' || pagos.some(p => p.estado === 'pagado')) {
      // El dinero ya entró: la derivación normal lo libera como pagado.
      return salir(no(409, 'YA_PAGADO_EN_LINEA', TEXTOS.yaPagado));
    }
    // Un comprobante o una transferencia que alguien revisa: vencerlo dejaría
    // ese dinero real sin forma de asentarse desde el panel. El texto depende
    // de qué pago es: una transferencia la confirma soporte; un enlace de Clip
    // se asienta solo en cuanto Clip lo confirma.
    const enRevision = pagos.filter(p => p.estado === 'requiere_revision');
    if (enRevision.length) {
      return salir(no(409, 'PAGO_EN_REVISION',
        TEXTOS.pagoEnRevision({ transferencia: enRevision.some(p => p.tipo === 'transferencia') })));
    }

    // Las reservas de promoción se CONSUMEN aquí: el pedido se vende. Si
    // quedaran 'reservada', el vencimiento ya no las tocaría (el pedido no
    // está en pendiente_pago) y un pago tardío tampoco: cupo apartado por nadie.
    const promo = await consumirReservasDePedido(cliente, {
      negocioId: nid, folio, version: calcularVersionPedidoHash(datos) });
    if (promo.invalidas.length) return salir(no(409, 'PROMOCION_DESFASADA', TEXTOS.promocionDesfasada));

    const ahora = new Date().toISOString();
    // 'vencido', NO 'invalidado': ver la cabecera. La historia del checkout
    // (referencia, url, monto) queda intacta y sigue siendo reconciliable.
    const { rows: vencidos } = await cliente.query(
      `UPDATE pagos SET estado = 'vencido',
                        metadata_sanitizada = metadata_sanitizada || $3::jsonb
        WHERE negocio_id = $1 AND pedido_folio = $2 AND estado IN ('creando','pendiente')
        RETURNING id`,
      [nid, folio, JSON.stringify({
        vencido_por_xabor_at: ahora,
        vencido_motivo: `el equipo pasó el pedido a ${formaPago}`,
        cambiado_a_presencial: true,
        cambiado_a_presencial_at: ahora,
        cambiado_a_presencial_por: actor.usuarioId,
      })]);

    const marca = {
      at: ahora,
      por: actor.usuarioId,
      por_rol: actor.esSoporte ? 'soporte' : (actor.rol || 'admin'),
      forma_pago: formaPago,
      forma_pago_tipo: tipo,
      forma_pago_anterior: datos.forma_pago ?? null,
      forma_pago_tipo_anterior: datos.forma_pago_tipo ?? null,
      pagos_vencidos: vencidos.map(v => v.id),
    };
    // El trigger de la 063 crea la deuda de emisión en ESTE UPDATE: desde el
    // COMMIT la comanda queda obligada de forma durable. No se escribe
    // pago_confirmado: queda como cualquier pedido de WhatsApp en efectivo,
    // que se cobra al entregar.
    const { rows: [actualizado] } = await cliente.query(
      `UPDATE pedidos_activos
          SET estado = 'nuevo', datos = datos || $3::jsonb, updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2 AND estado = 'pendiente_pago'
        RETURNING datos`,
      [folio, nid, JSON.stringify({
        estado: 'nuevo',
        forma_pago: formaPago,
        forma_pago_tipo: tipo,
        requierePagoAnticipado: false,
        pago_cambiado_a_presencial: marca,
      })]);

    // Auditoría OBLIGATORIA, en la misma transacción: mandar a cocina sin el
    // dinero confirmado es la acción manual más delicada del flujo de pago, y
    // no puede ocurrir sin rastro de quién la hizo.
    await registrarAuditoriaPlataforma({
      ...(actor.esSoporte ? { superadminId: actor.usuarioId } : { actorUsuarioId: actor.usuarioId }),
      accion: 'pedido_liberado_a_pago_presencial',
      negocioId: nid,
      estadoAnterior: { estado: 'pendiente_pago', forma_pago: marca.forma_pago_anterior, forma_pago_tipo: marca.forma_pago_tipo_anterior },
      estadoNuevo: { estado: 'nuevo', forma_pago: formaPago, forma_pago_tipo: tipo },
      contexto: { folio, pagos_vencidos: marca.pagos_vencidos, promociones_consumidas: promo.consumidas },
    }, cliente);

    await cliente.query('COMMIT');
    return {
      ok: true, datos: actualizado.datos, marca,
      pagosVencidos: marca.pagos_vencidos, promocionesConsumidas: promo.consumidas,
    };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// ── Reconsultar a Clip antes de vencer los intentos vivos ──────────────────
//
// El doble cobro más probable no es la clienta que paga DESPUÉS: es la que ya
// pagó. «Ya pagué pero no me llega», el equipo lo pasa a efectivo, y Clip ya
// tenía el cobro COMPLETED pero el webhook o la reconciliación (cada 5 min)
// todavía no corrían. La transacción solo mira el registro local, así que
// liberaba y vencía ese intento: el dinero entraba después como tardío y el
// repartidor cobraba otra vez en la puerta.
//
// Aquí se pregunta a Clip por cada intento vivo, por EL MISMO camino del
// webhook y la reconciliación (verificarYAsentarClip: credenciales del
// negocio, referencia, monto y moneda verificados, transición financiera
// única). Si Clip dice pagado, se asienta, se deriva como cualquier cobro y
// NO se libera. Va fuera de la transacción y sin el lock: no se sostiene un
// candado de la obligación mientras se espera a la red.
//
// Nunca bloquea la operación por Clip: sin credenciales, sin respuesta o con
// más de `topeMs`, se sigue a la liberación de siempre. Lo que ya no se pudo
// evitar lo atrapa la transacción (si el dinero entró mientras tanto, ve el
// pago asentado y responde «ya se pagó») o, si entra después, el pago tardío
// que Caja señala. Solo corre con la bandera encendida y el pedido esperando
// el pago: con la bandera apagada no sale ni una petición a Clip.
export const TOPE_RECONSULTA_CLIP_MS = 6000;

function topeReconsultaMs() {
  // Solo en pruebas se acorta (mismo doble candado que la inyección de fallos).
  const prueba = process.env.NODE_ENV !== 'production' ? Number(process.env.XABOR_TEST_TOPE_RECONSULTA_CLIP_MS) : NaN;
  return Number.isFinite(prueba) && prueba > 0 ? prueba : TOPE_RECONSULTA_CLIP_MS;
}

function conTope(promesa, ms) {
  let reloj = null;
  const vencido = new Promise((resolve) => {
    reloj = setTimeout(() => resolve({ ok: false, razon: 'tiempo_agotado' }), ms);
  });
  // Si Clip contesta después del tope, ese resultado ya no decide nada aquí:
  // si trae dinero, la transición lo deja asentado con su deuda de derivación
  // (o como tardío, si ya se liberó) y el reconciliador sigue su curso.
  promesa.catch(() => {});
  return Promise.race([promesa, vencido]).finally(() => clearTimeout(reloj));
}

/**
 * Devuelve { consultados, pagado, pagoId?, razones }. Nunca lanza por Clip.
 */
export async function reconsultarCobrosVivosAntesDeLiberar({
  negocioId, folio, formaPago,
  verificar = verificarYAsentarClip, derivar = derivarPedidoPorPagoAsentado, topeMs = topeReconsultaMs(),
} = {}) {
  const nada = { consultados: 0, pagado: false, razones: [] };
  if (typeof negocioId !== 'string' || !negocioId.trim() || !tipoPresencial(formaPago)) return nada;
  const nid = negocioId.trim();
  const { rows: vivos } = await pool.query(
    `SELECT p.* FROM pagos p
       JOIN pedidos_activos pa ON pa.folio = p.pedido_folio AND pa.negocio_id = p.negocio_id
      WHERE p.negocio_id = $1 AND p.pedido_folio = $2 AND pa.estado = 'pendiente_pago'
        AND p.proveedor = 'clip' AND p.referencia_externa IS NOT NULL
        AND p.estado IN ('creando','pendiente','requiere_revision')
        AND EXISTS (SELECT 1 FROM configuracion c
                     WHERE c.negocio_id = $1 AND c.clave = $3 AND lower(trim(c.valor)) = 'true')
      ORDER BY p.created_at DESC
      LIMIT 3`,
    [nid, folio, BANDERA_LIBERA_PENDIENTE]);
  const razones = [];
  for (const pago of vivos) {
    let r;
    try {
      r = await conTope(Promise.resolve().then(() => verificar({ pago, checkoutId: pago.referencia_externa })), topeMs);
    } catch (e) {
      r = { ok: false, razon: `error:${e.message}` };
    }
    razones.push(r?.razon || 'sin_razon');
    if (r?.ok) {
      try {
        await derivar({ pagoId: pago.id, negocioId: nid, folio });
      } catch (e) {
        // El dinero ya quedó asentado con su deuda de derivación: el
        // reconciliador (reconciliarDerivacionesPendientes) saca la comanda.
        console.error(`[Pagos] ${folio}: Clip confirmó el pago al pasar a efectivo, pero la derivación falló: ${e.message}`);
      }
      console.log(`[Pagos] ${folio}: al pasar a ${formaPago} se reconsultó Clip y el pago YA estaba hecho (pago=${pago.id}); no se libera`);
      return { consultados: razones.length, pagado: true, pagoId: pago.id, razones };
    }
  }
  if (vivos.length) {
    console.log(`[Pagos] ${folio}: reconsulta a Clip antes de pasar a ${formaPago}: ${razones.join(', ')}`);
  }
  return { consultados: razones.length, pagado: false, razones };
}

/**
 * Lo que hace PATCH /api/admin/pedido/:folio/pago cuando el pedido está en
 * `pendiente_pago` o `cancelado`. Devuelve { http, cuerpo }. Toda decisión
 * (cancelado, bandera, política) se toma dentro de la transacción, con la fila
 * bloqueada: lo que la ruta leyó antes pudo cambiar mientras tanto.
 *
 * `broadcast(negocioId, evento)` es el broadcastNegocio del servidor.
 * `alPagoConfirmado(negocioId, folio)`: lo que el servidor hace después de
 * derivar un cobro (avisar al panel, recibo automático), igual que la
 * reconciliación de Clip.
 */
export async function atenderCambioDePagoSobrePendiente({
  negocioId, folio, formaPago, actor = {}, broadcast = null, alPagoConfirmado = null,
  reconsultar = reconsultarCobrosVivosAntesDeLiberar,
} = {}) {
  // Primero se pregunta a Clip (fuera del lock): si el cliente ya pagó, no se
  // libera ni se vence nada; el pedido sale a cocina como pagado.
  let previa = null;
  try {
    previa = await reconsultar({ negocioId, folio, formaPago });
  } catch (e) {
    console.error(`[Pagos] ${folio}: no se pudo reconsultar el cobro antes de pasar a ${formaPago}: ${e.message}`);
  }
  if (previa?.pagado) {
    try { alPagoConfirmado?.(negocioId.trim(), folio); }
    catch (e) { console.error(`[WS] No se pudo avisar el pago confirmado de ${folio}: ${e.message}`); }
    return { http: 409, cuerpo: { error: TEXTOS.yaPagadoSegunClip, codigo: 'YA_PAGADO_EN_LINEA' } };
  }

  const r = await liberarPendientePagoAPresencialTx({ negocioId, folio, formaPago, actor });
  if (!r.ok) return { http: r.http, cuerpo: { error: r.error, codigo: r.codigo } };
  const nid = negocioId.trim();
  if (r.yaLiberado) {
    return { http: 200, cuerpo: { ok: true, liberado: true, yaLiberado: true, forma_pago: r.marca?.forma_pago } };
  }

  // ── Después del COMMIT: memoria, promociones y comanda ───────────────────
  // La memoria solo alimenta el volcado del tablero al reconectar; la base ya
  // manda. Si este proceso no tenía el pedido (otro proceso lo creó, o
  // reinició), se reconstruye desde lo que la base guardó.
  const cambios = {
    estado: 'nuevo',
    forma_pago: r.datos.forma_pago,
    forma_pago_tipo: r.datos.forma_pago_tipo,
    requierePagoAnticipado: false,
    pago_cambiado_a_presencial: r.marca,
  };
  let pedido = obtenerPedidoPorId(folio, nid);
  if (pedido) Object.assign(pedido, cambios);
  else {
    pedido = { ...r.datos, ...cambios, id: folio, negocioId: nid };
    agregarPedidoAMemoria(pedido);
  }

  // Igual que confirmarPedidoPendientePago: ya es una venta, sus promociones se
  // auditan. Un fallo aquí no detiene la comanda (el reconciliador lo repone).
  if (debeRegistrarse(pedido, pedido.canal)) {
    await registrarUsosDeVenta({
      negocioId: nid, folio, promociones: pedido.descuentos.promociones,
      telefono: telefonoDeAuditoria(pedido), montoVenta: pedido.total, canal: pedido.canal,
    }).catch(e => console.error(`[Promos] registro de uso fallo para ${folio}:`, e.message));
  }

  let emision = null;
  try {
    emision = await emitirPedido(pedido);
  } catch (e) {
    // La deuda de emisión quedó escrita en el COMMIT: el reconciliador (cada
    // 60 s) saca la comanda aunque esto falle. Se registra y se responde ok:
    // el pedido SÍ quedó liberado.
    console.error(`[Pagos] ${folio} liberado a ${r.marca.forma_pago_tipo}, pero la comanda no salió todavía: ${e.message}`);
  }

  try {
    broadcast?.(nid, { tipo: 'actualizar_pago', id: folio, forma_pago: r.datos.forma_pago });
    broadcast?.(nid, { tipo: 'actualizar_estado', id: folio, estado: 'nuevo' });
  } catch (e) {
    console.error(`[WS] No se pudo avisar la liberación de ${folio}: ${e.message}`);
  }

  console.log(`[Pagos] Pedido ${folio} LIBERADO a cocina con pago ${r.marca.forma_pago_tipo} `
    + `(antes ${r.marca.forma_pago_anterior || '-'}) negocio=${nid} usuario=${r.marca.por} `
    + `pagos_vencidos=${r.pagosVencidos.join(',') || '-'} comanda=${emision?.seHizoCargo ? 'emitida' : `pendiente(${emision?.razon || 'error'})`}`);

  // `comandaEmitida` es lo que devolvió emitirPedido (la deuda se reclamó y
  // corrió). Si Edge imprime o no lo dice el `nuevo_pedido` del WebSocket, como
  // en cualquier otro pedido.
  return {
    http: 200,
    cuerpo: {
      ok: true, liberado: true, forma_pago: r.datos.forma_pago,
      comandaEmitida: emision?.seHizoCargo === true,
      pagosVencidos: r.pagosVencidos.length,
    },
  };
}

// ── Ya liberado: ✏️ solo cambia entre efectivo y terminal ──────────────────
//
// Corrección 4 (3-oct). Después de liberar, el pedido queda en 'nuevo' y la
// ruta tomaba el camino normal de ✏️, que solo reescribe la etiqueta: pasar a
// «enlace de pago» o «rappi» dejaba `forma_pago_tipo` y la marca en efectivo
// (Caja contaba venta por enlace de un pedido al que ya no se le puede crear
// enlace), y pasar de efectivo a terminal dejaba el tipo en efectivo, así que
// el aviso de un cobro tardío decía «en efectivo».
//
// Aquí, con el MISMO lock de la obligación (para que un pago que entra a la
// vez lea la forma ya corregida): solo efectivo o terminal; la etiqueta, el
// tipo y la marca cambian juntos y la marca guarda cada corrección. La misma
// forma es idempotente, como la liberación repetida.
export async function corregirFormaDePedidoLiberadoTx({ negocioId, folio, formaPago, actor = {} } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return no(404, 'NO_ENCONTRADO', 'Pedido no encontrado');
  const nid = negocioId.trim();
  const tipo = tipoPresencial(formaPago);
  const cliente = await poolDeClaims().connect();
  const salir = async (r) => { await cliente.query('ROLLBACK'); return r; };
  try {
    await cliente.query('BEGIN');
    await cliente.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ['obligacion_pago', `${nid}:${folio}`]);
    const { rows: [fila] } = await cliente.query(
      `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, nid]);
    if (!fila) return salir(no(404, 'NO_ENCONTRADO', 'Pedido no encontrado'));
    const datos = fila.datos || {};
    const previa = datos.pago_cambiado_a_presencial;
    // No es un pedido liberado (la ruta leyó otra cosa): que siga su camino.
    if (!previa) return salir({ ok: false, noLiberado: true });
    if (fila.estado === 'cancelado') return salir(await respuestaCancelado(cliente, nid, folio, datos));
    if (!tipo) return salir(no(409, 'PAGO_PRESENCIAL_FIJO', TEXTOS.soloPresencialTrasLiberar));
    if (datos.forma_pago === formaPago && datos.forma_pago_tipo === tipo) {
      await cliente.query('COMMIT');
      return { ok: true, sinCambio: true, marca: previa };
    }
    const ahora = new Date().toISOString();
    const correcciones = Array.isArray(previa.correcciones) ? previa.correcciones.slice(-19) : [];
    const marca = {
      ...previa,
      forma_pago: formaPago,
      forma_pago_tipo: tipo,
      correcciones: [...correcciones, {
        at: ahora, por: actor?.usuarioId || null,
        de: datos.forma_pago ?? null, a: formaPago,
      }],
    };
    const { rows: [actualizado] } = await cliente.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb, updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2
        RETURNING datos`,
      [folio, nid, JSON.stringify({ forma_pago: formaPago, forma_pago_tipo: tipo, pago_cambiado_a_presencial: marca })]);
    await cliente.query('COMMIT');
    return { ok: true, datos: actualizado.datos, marca };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/**
 * PATCH /api/admin/pedido/:folio/pago sobre un pedido que el equipo ya pasó a
 * cobro en persona. Devuelve { http, cuerpo }, o null si resultó no estar
 * liberado (la ruta sigue con su camino normal).
 */
export async function atenderCambioDeFormaEnPedidoLiberado({
  negocioId, folio, formaPago, actor = {}, broadcast = null,
} = {}) {
  const r = await corregirFormaDePedidoLiberadoTx({ negocioId, folio, formaPago, actor });
  if (r.noLiberado) return null;
  if (!r.ok) return { http: r.http, cuerpo: { error: r.error, codigo: r.codigo } };
  if (r.sinCambio) {
    return { http: 200, cuerpo: { ok: true, liberado: true, yaLiberado: true, forma_pago: r.marca?.forma_pago } };
  }
  const nid = negocioId.trim();
  const p = obtenerPedidoPorId(folio, nid);
  if (p) Object.assign(p, {
    forma_pago: r.datos.forma_pago,
    forma_pago_tipo: r.datos.forma_pago_tipo,
    pago_cambiado_a_presencial: r.marca,
  });
  try {
    broadcast?.(nid, { tipo: 'actualizar_pago', id: folio, forma_pago: r.datos.forma_pago });
  } catch (e) {
    console.error(`[WS] No se pudo avisar la corrección de pago de ${folio}: ${e.message}`);
  }
  console.log(`[Pagos] ${folio} (ya liberado) corregido a ${r.datos.forma_pago} negocio=${nid} usuario=${actor?.usuarioId || '-'}`);
  return { http: 200, cuerpo: { ok: true, liberado: true, forma_pago: r.datos.forma_pago } };
}
