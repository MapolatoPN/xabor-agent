/**
 * pagosService.js — Generación segura de enlaces de pago (Fase 8/10/11).
 *
 * Reemplaza las llamadas directas a crearLinkDePago() (Clip-específico)
 * por un flujo agnóstico de proveedor: recalcula el total desde la base
 * de datos (nunca confía en el monto que traiga el llamador), resuelve
 * el proveedor PRINCIPAL del negocio (nunca asume Clip), y es idempotente
 * por (negocioId, pedidoId, versionPedido, tipo) -- un doble clic o un
 * reintento del agente devuelve el MISMO enlace en vez de crear uno
 * nuevo; si el pedido cambió de monto/modalidad desde el último intento,
 * el enlace anterior se invalida y se genera uno nuevo.
 */
import {
  obtenerPedidoParaPagoPorFolio, calcularVersionPedidoHash, obtenerPagoVigente,
  crearRegistroPago, actualizarPagoCreado, marcarPagoFallido, invalidarPagosVigentesDePedido,
  guardarLinkPago, obtenerPagoPorReferenciaInterna, reactivarRegistroPago,
  asegurarRoutingTokenIntegracion, registrarIdsDePago,
} from './database.js';

// URL pública canónica de Xabor. La notification_url es sensible -- decide a
// dónde llega el aviso de que un pago se completó -- así que NO se fabrica con
// el Host ni el X-Forwarded-Host de la petición: los pone el cliente. Se toma
// de la configuración del servidor y, si no está, no se manda ninguna: mejor
// sin webhook (y reconciliar por consulta) que un webhook apuntando a donde
// diga un tercero.
function urlPublicaXabor() {
  const base = process.env.XABOR_URL_PUBLICA || process.env.BASE_URL || '';
  return /^https?:\/\//.test(base) ? base.replace(/\/+$/, '') : null;
}

// Estados internos válidos de pagos.estado (CHECK de la migración 025). Un
// adaptador jamás debe poder colar el vocabulario crudo de su proveedor
// ('CHECKOUT' de Clip fue la causa raíz del incidente del enlace no
// enviado): cualquier valor fuera de esta lista se normaliza a 'pendiente'.
const ESTADOS_PAGO_VALIDOS = new Set(['creando', 'pendiente', 'pagado', 'fallido', 'vencido', 'cancelado', 'invalidado', 'reembolsado', 'requiere_revision']);
const normalizarEstadoPago = e => (ESTADOS_PAGO_VALIDOS.has(e) ? e : 'pendiente');
import { obtenerProveedorPrincipal, obtenerCredencialesPagoDescifradas, TenantContextRequiredError } from './integracionesService.js';
import { obtenerAdaptador } from './paymentProviders.js';

export { TenantContextRequiredError };

export class SinProveedorPrincipalError extends Error {
  constructor(negocioId) {
    super(`No hay proveedor de pago principal activo para el negocio ${negocioId}`);
    this.code = 'SIN_PROVEEDOR_PRINCIPAL';
  }
}
export class PedidoInvalidoError extends Error {
  constructor(msg) { super(msg); this.code = 'PEDIDO_INVALIDO'; }
}

/**
 * Crea (o reutiliza, si ya hay uno vigente y sin cambios) un enlace de
 * pago para un pedido. Nunca acepta el total del llamador como fuente de
 * verdad -- siempre se recalcula desde pedidos_activos.
 */
export async function crearEnlacePago({ negocioId, pedidoId, actor = null, idempotencyKey = null, descripcion = null }) {
  // Mismo contrato que crearLinkDePago (clip-api.js, Incidente P0):
  // negocioId ausente/inválido es un bug del llamador, nunca un estado de
  // negocio -> TenantContextRequiredError, lanzada antes de tocar la BD.
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new TenantContextRequiredError('pagosService.crearEnlacePago');
  if (typeof pedidoId !== 'string' || !pedidoId.trim()) throw new Error('crearEnlacePago: pedidoId requerido');

  // Incidente XAB-0114: el lookup anterior (obtenerPedidoActivoPorFolio)
  // excluía pedidos 'entregado' pero ACEPTABA 'cancelado' -- exactamente al
  // revés de lo que el dinero necesita: un pedido entregado SIN pagar es el
  // caso típico que pide el enlace, y uno cancelado jamás debe cobrarse.
  const pedido = await obtenerPedidoParaPagoPorFolio(pedidoId, negocioId);
  if (!pedido) throw new PedidoInvalidoError(`Pedido ${pedidoId} no encontrado para este negocio`);
  if (pedido.pago_confirmado === true || pedido.pago_confirmado === 'true') {
    throw new PedidoInvalidoError(`Pedido ${pedidoId} ya está pagado`);
  }
  const total = Number(pedido.total);
  if (!Number.isFinite(total) || total <= 0) throw new PedidoInvalidoError(`Pedido ${pedidoId} tiene un total inválido`);

  const versionHash = calcularVersionPedidoHash(pedido);

  // El proveedor PRINCIPAL se resuelve ANTES de revisar idempotencia porque
  // el tipo de pago depende de él: Clip crea un enlace real ('enlace_pago'),
  // manual_transfer no crea nada, solo instrucciones a conciliar a mano
  // ('transferencia') -- sin esto, un negocio con manual_transfer como
  // principal quedaría registrado con el tipo equivocado y chocaría contra
  // el índice único de "un pago vigente por pedido+tipo".
  const principal = await obtenerProveedorPrincipal(negocioId);
  if (!principal) throw new SinProveedorPrincipalError(negocioId);
  const adaptador = obtenerAdaptador(principal.proveedor);
  if (!adaptador) throw new SinProveedorPrincipalError(negocioId);
  const tipo = adaptador.getCapabilities().createLink ? 'enlace_pago' : 'transferencia';

  // Idempotencia: si ya hay un pago vigente para este pedido (mismo tipo) y
  // coincide la versión, se reutiliza tal cual (mismo enlace) -- nunca se
  // genera uno nuevo por un doble clic o un reintento.
  const vigente = await obtenerPagoVigente(negocioId, pedidoId, tipo);

  // P1: el intento vigente pertenece a UN proveedor. Si el negocio cambió su
  // principal entre el primer intento y el reintento, devolver la URL vieja
  // etiquetada con el proveedor nuevo sería mentir sobre a qué cuenta va el
  // dinero. Decisión explícita: un pago pendiente NO queda fijado a su
  // proveedor original -- se invalida y se crea un intento nuevo con el
  // proveedor actual. Nunca se mezclan los dos.
  //
  // El dinero que sí entró por el enlace viejo se sigue honrando: su webhook
  // resuelve por referencia_interna y confirma igual, aunque el registro esté
  // invalidado. Invalidar no es repudiar un cobro, es dejar de ofrecerlo.
  if (vigente && vigente.proveedor && vigente.proveedor !== principal.proveedor) {
    await invalidarPagosVigentesDePedido(negocioId, pedidoId,
      `el negocio cambió de proveedor (${vigente.proveedor} → ${principal.proveedor}) antes de completar el pago`);
  } else if (vigente && vigente.version_pedido_hash === versionHash && ['pendiente', 'requiere_revision'].includes(vigente.estado)) {
    return { pagoId: vigente.id, url: vigente.url, reutilizado: true, referenciaExterna: vigente.referencia_externa, estado: vigente.estado };
  }
  if (vigente && vigente.proveedor === principal.proveedor && vigente.version_pedido_hash !== versionHash) {
    // El pedido cambió desde el último intento (ejemplo del encargo:
    // domicilio $560 -> recoger $500) -- el enlace anterior ya no es
    // válido, se invalida explícitamente y nunca se reenvía.
    await invalidarPagosVigentesDePedido(negocioId, pedidoId, 'pedido modificado antes de completar el pago anterior');
  }

  // El proveedor forma parte de la identidad del intento: sin esto, un
  // reintento con otro proveedor chocaba contra el UNIQUE de referencia_interna
  // y terminaba REUTILIZANDO la fila del proveedor anterior -- exactamente la
  // mezcla que hay que impedir. Las tres primeras partes no se mueven: el
  // webhook de Clip sigue leyendo negocio y folio de las posiciones 0 y 1.
  const referenciaInterna = `${negocioId.trim()}:${pedidoId}:${versionHash}:${principal.proveedor}`;
  // Reintento tras un intento FALLIDO (segunda causa del incidente del
  // enlace): la fila fallida conserva la referencia_interna única, así que
  // un segundo intento con el pedido sin cambios chocaba contra el UNIQUE y
  // fallaba para siempre. Si la referencia ya existe en un estado terminal
  // no cobrable, se REUTILIZA esa fila (vuelve a 'creando') en vez de
  // insertar; si ya está pagada, se devuelve tal cual (jamás re-cobrar).
  const previo = await obtenerPagoPorReferenciaInterna(negocioId, referenciaInterna);
  let registro;
  if (previo && previo.estado === 'pagado') {
    return { pagoId: previo.id, url: previo.url, reutilizado: true, referenciaExterna: previo.referencia_externa, estado: 'pagado' };
  }
  if (previo && ['fallido', 'invalidado', 'vencido', 'cancelado'].includes(previo.estado)) {
    await reactivarRegistroPago(previo.id);
    registro = previo;
  } else if (previo) {
    // 'creando'/'pendiente'/'requiere_revision' con la misma referencia ya
    // se habría reutilizado arriba como vigente; llegar aquí es una carrera
    // mínima entre dos requests -- se reutiliza igual, sin insertar.
    registro = previo;
  } else {
    registro = await crearRegistroPago({
      negocioId, pedidoFolio: pedidoId, clienteTelefono: pedido.cliente?.telefono || null,
      proveedor: principal.proveedor, integracionId: principal.id, referenciaInterna,
      tipo, moneda: 'MXN', monto: total, versionPedidoHash: versionHash,
      idempotencyKey, createdBy: actor,
    });
  }

  try {
    const credenciales = await obtenerCredencialesPagoDescifradas(negocioId, principal.proveedor);

    // notification_url con el token de ruteo: es lo que permitirá al webhook
    // resolver ESTA integración sin creerle nada al cuerpo del mensaje. Sólo
    // para proveedores que firman sus webhooks; Clip no los ofrece y se
    // reconcilia por consulta activa.
    let notificationUrl = null;
    if (adaptador.getCapabilities().webhookSignature) {
      const raiz = urlPublicaXabor();
      const routing = await asegurarRoutingTokenIntegracion(negocioId, principal.proveedor);
      if (raiz && routing) {
        notificationUrl = `${raiz}/webhook/pagos/${principal.proveedor}/${routing}`;
      } else {
        console.warn(`[Pagos] Sin notification_url para ${principal.proveedor} (raiz=${!!raiz} routing=${!!routing}) — se dependerá de la reconciliación`);
      }
    }

    const resultado = await adaptador.createPaymentLink({
      negocioId, pedidoId, total, descripcion: descripcion || `Pedido Xabor #${pedidoId}`,
      cliente: pedido.cliente || {}, referencia: referenciaInterna, credenciales,
      notificationUrl,
    });
    await actualizarPagoCreado(registro.id, {
      referenciaExterna: resultado.referenciaExterna, url: resultado.url || null,
      estado: normalizarEstadoPago(resultado.estado || 'pendiente'),
    });
    // Compatibilidad: mismo campo legacy que ya usa la reconciliación en
    // background (obtenerPagosPendientesConLink) para negocios que no han
    // migrado ese job todavía. Solo aplica cuando hay una referencia real
    // de proveedor (Clip) -- transferencia manual no tiene nada que
    // reconciliar por esa vía.
    // El id de la PREFERENCIA en su propia columna. No es un payment_id y jamás
    // debe consultarse como /v1/payments/:preferenceId -- ese id lo trae después
    // el webhook, y se guarda aparte.
    if (resultado.preferenceId) {
      await registrarIdsDePago(registro.id, negocioId,
        { preferenceId: resultado.preferenceId, proveedor: principal.proveedor });
    }
    if (resultado.referenciaExterna) await guardarLinkPago(pedidoId, negocioId, resultado.referenciaExterna);
    return { pagoId: registro.id, url: resultado.url, reutilizado: false, referenciaExterna: resultado.referenciaExterna, estado: normalizarEstadoPago(resultado.estado || 'pendiente'), instrucciones: resultado.instrucciones || null };
  } catch (e) {
    await marcarPagoFallido(registro.id, e.code || e.message);
    throw e;
  }
}
