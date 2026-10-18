// ─── Pago con Clip en la tienda en línea ──────────────────────────────────
//
// Tres piezas, ninguna es un sistema de pagos nuevo:
//
//   1. CHECKOUT EMBEBIDO. El mismo checkout de /v2/checkout que ya crea
//      pagosService (mismo payment_request_id, misma fila de `pagos`, misma
//      expiración) se le presenta al cliente con el componente oficial de
//      Clip (https://sdk.clip.mx/js/v1/checkout.js) en una página propia,
//      /pagar/:token, en vez de mandarlo a la página de Clip. Se enciende por
//      negocio con `configuracion.tienda_clip_checkout_embebido = 'true'`; sin
//      esa fila todo queda exactamente como antes (checkout redireccionado).
//
//      Por qué una página propia y no dentro de /t/:slug: el SDK lee el
//      atributo `payment_request_id` UNA sola vez, en DOMContentLoaded (está
//      así en su código, v1). La tienda es una sola página que obtiene el id
//      mucho después de ese evento; insertarle el script a mitad de camino lo
//      dejaría sin arrancar. /pagar/:token nace con el id ya escrito.
//
//   2. VERIFICACIÓN AL REGRESAR. Cuando el cliente vuelve de pagar (o cierra
//      la ventana de pago), la página pide que se le pregunte a Clip por SU
//      pedido, en vez de esperar al webhook o al barrido de 5 minutos. Es la
//      MISMA verificación del barrido (verificarYAsentarClip → transición
//      financiera única → derivación con deuda), acotada a un folio, con
//      tope de frecuencia por folio y de concurrencia global. Se apaga por
//      negocio con `configuracion.tienda_pago_verificar_al_regresar = 'false'`.
//
//   3. NINGÚN COBRO NUEVO SOBRE UNO INCIERTO. Antes de que pagosService pueda
//      abrir un checkout distinto del vigente, si hay uno anterior de Clip con
//      identidad externa y sin evidencia terminal, se le pregunta primero a
//      Clip. Pagado: no se cobra otra vez. Sin respuesta: no se abre nada.
//
// Los parámetros de regreso (?retorno=pago&r=exito|error|salida) NUNCA llegan
// aquí como autoridad: solo eligen el mensaje en el navegador. Lo único que
// confirma un pago es la reconsulta autenticada con las credenciales del
// negocio dueño del pedido.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool, calcularVersionPedidoHash, obtenerPagoVigente, obtenerPagoPorId } from './database.js';
import { TiendaError } from './tiendaOnline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLANTILLA_PAGO = join(__dirname, '../../panel/tienda-pago.html');

export const CLAVE_EMBEBIDO = 'tienda_clip_checkout_embebido';
export const CLAVE_VERIFICACION = 'tienda_pago_verificar_al_regresar';
export const MARCA_ID_CHECKOUT = '__XABOR_CLIP_PAYMENT_REQUEST_ID__';

// payment_request_id de Clip: un UUID en la documentación. Se acepta un poco
// más ancho (letras, dígitos y guiones) pero JAMÁS un carácter que pueda
// cerrar el atributo HTML donde se escribe.
export const ID_CHECKOUT_CLIP = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const TOKEN_TRACKING = /^[a-f0-9]{48}$/;

// ── Banderas por negocio ────────────────────────────────────────────────────
async function leerClave(negocioId, clave) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows: [r] } = await pool.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId.trim(), clave]);
  return r ? String(r.valor ?? '').trim().toLowerCase() : null;
}

/** Encendido SOLO con el valor exacto 'true'. Cualquier otra cosa: apagado. */
export async function embebidoClipHabilitado(negocioId) {
  try { return (await leerClave(negocioId, CLAVE_EMBEBIDO)) === 'true'; }
  catch { return false; }
}

/** Encendida salvo que el negocio la apague con 'false'. */
export async function verificacionAlRegresarHabilitada(negocioId) {
  try { return (await leerClave(negocioId, CLAVE_VERIFICACION)) !== 'false'; }
  catch { return false; }
}

// ── ¿Este checkout se puede presentar embebido? ────────────────────────────
//
// Solo el checkout VIGENTE y entregable que pagosService ya le daría al
// cliente: mismo criterio de "no entregar" (expiración del proveedor más
// laxa, creación ambigua) y versión igual a la del pedido. Si algo no cuadra,
// el cliente sigue por el camino de siempre y ahí decide pagosService.
export function checkoutEmbebible(pago, datosPedido, ahora = Date.now()) {
  if (!pago || pago.proveedor !== 'clip' || pago.tipo !== 'enlace_pago') return false;
  if (pago.estado !== 'pendiente' || !pago.url) return false;
  if (!ID_CHECKOUT_CLIP.test(String(pago.referencia_externa || ''))) return false;
  const m = pago.metadata_sanitizada || {};
  if (m.expiracion_proveedor_mas_larga === true || m.expiracion_proveedor_no_verificable === true) return false;
  if (m.creacion_ambigua_abierta === true || m.anomalia === 'creacion_ambigua') return false;
  if (!datosPedido || pago.version_pedido_hash !== calcularVersionPedidoHash(datosPedido)) return false;
  // A menos de un minuto de vencer no vale la pena abrir el componente: el
  // cliente no alcanzaría a capturar la tarjeta.
  const limite = pago.xabor_espera_hasta ? Date.parse(pago.xabor_espera_hasta) : NaN;
  if (Number.isFinite(limite) && limite - ahora < 60 * 1000) return false;
  return true;
}

/**
 * ¿Ofrecer /pagar/:token para el enlace que pagosService acaba de devolver?
 * Devuelve { pagina } o null. Lee la fila por su id: es la misma que respalda
 * la URL que el cliente recibiría en el camino redireccionado.
 */
export async function ofertaEmbebida({ negocioId, trackingToken, enlace, datosPedido, proveedor }) {
  if (proveedor !== 'clip' || !enlace?.url || !enlace?.pagoId || enlace.requiereRevision) return null;
  if (!(await embebidoClipHabilitado(negocioId))) return null;
  const pago = await obtenerPagoPorId(enlace.pagoId, negocioId).catch(() => null);
  if (!checkoutEmbebible(pago, datosPedido)) return null;
  return { pagina: `/pagar/${trackingToken}` };
}

// ── Página /pagar/:token ────────────────────────────────────────────────────
let plantillaPago = null;
function plantilla() {
  if (!plantillaPago) plantillaPago = readFileSync(PLANTILLA_PAGO, 'utf8');
  return plantillaPago;
}

async function pedidoDeToken(trackingToken) {
  const token = String(trackingToken || '').trim();
  if (!TOKEN_TRACKING.test(token)) throw new TiendaError('Pedido no encontrado', 'TRACKING_INVALIDO', 404);
  const { rows: [r] } = await pool.query(
    `SELECT tp.negocio_id, tp.pedido_folio, pa.estado, pa.datos
       FROM tienda_pedidos tp
       LEFT JOIN pedidos_activos pa ON pa.folio = tp.pedido_folio AND pa.negocio_id = tp.negocio_id
      WHERE tp.tracking_token = $1`, [token]);
  if (!r || !r.pedido_folio) throw new TiendaError('Pedido no encontrado', 'TRACKING_NO_EXISTE', 404);
  return { ...r, token };
}

/**
 * Lo que responde GET /pagar/:token. Solo LEE: jamás crea un checkout (eso es
 * del POST de pago, idempotente). Cualquier cosa que no sea "pedido esperando
 * pago + bandera encendida + Clip principal + checkout vigente entregable"
 * manda al seguimiento, que ofrece el camino de siempre.
 *
 *   { redirigir } | { html }
 */
export async function paginaPagoEmbebido(trackingToken) {
  const r = await pedidoDeToken(trackingToken);
  const seguimiento = `/seguimiento/${r.token}`;
  if (r.estado !== 'pendiente_pago') return { redirigir: seguimiento };
  if (!(await embebidoClipHabilitado(r.negocio_id))) return { redirigir: seguimiento };
  const { obtenerProveedorPrincipal } = await import('./integracionesService.js');
  const principal = await obtenerProveedorPrincipal(r.negocio_id).catch(() => null);
  if (principal?.proveedor !== 'clip') return { redirigir: seguimiento };
  const pago = await obtenerPagoVigente(r.negocio_id, r.pedido_folio, 'enlace_pago');
  if (!checkoutEmbebible(pago, r.datos)) return { redirigir: seguimiento };
  // El id ya pasó ID_CHECKOUT_CLIP: no trae comillas, < ni &.
  return { html: plantilla().replace(MARCA_ID_CHECKOUT, pago.referencia_externa) };
}

// ── Verificación con el proveedor, acotada a un pedido ─────────────────────
const _ultimaConsulta = new Map();   // `${negocio}:${folio}` → ms
const _enVuelo = new Map();          // `${negocio}:${folio}` → promesa
let _consultando = 0;

const MAX_CONCURRENTES = 3;
function intervaloMinimoMs() {
  // Override EXCLUSIVO de pruebas, mismo candado que el resto del proyecto.
  const n = Number(process.env.XABOR_TIENDA_VERIFICACION_INTERVALO_MS);
  if (process.env.NODE_ENV !== 'production' && Number.isFinite(n) && n >= 0) return n;
  return 8000;
}
function podarConsultas(ahora) {
  if (_ultimaConsulta.size < 500) return;
  for (const [k, t] of _ultimaConsulta) if (ahora - t > 10 * 60 * 1000) _ultimaConsulta.delete(k);
}

/**
 * Pregunta a Clip por los checkouts de UN pedido y asienta lo que haya entrado,
 * por el mismo camino que el barrido periódico de server.js:
 * verificarYAsentarClip → derivarPedidoPorPagoAsentado → aviso al panel.
 *
 * Límites (el dinero no depende de ellos: la transición y la derivación ya son
 * idempotentes; protegen a Clip y al proceso):
 *   · una consulta en vuelo por pedido: las demás esperan su resultado;
 *   · como mucho una consulta nueva por pedido cada 8 s (salvo `forzar`);
 *   · como mucho MAX_CONCURRENTES pedidos consultándose a la vez.
 *
 * Devuelve { consulta } con:
 *   'pagado'        el dinero quedó asentado (ahora o antes);
 *   'pendiente'     Clip dice que el checkout sigue sin pagar;
 *   'vencido'       Clip confirmó que el checkout expiró sin pago;
 *   'sin_respuesta' Clip no contestó (o la verificación falló): INCIERTO;
 *   'revision'      la reconsulta encontró algo que no cuadra (anomalía);
 *   'sin_checkout'  el pedido no tiene checkout de Clip que consultar;
 *   'omitida'       no se consultó (reciente u ocupado): ver `motivo`.
 */
export async function verificarPagoClipDePedido({ negocioId, folio, alConfirmar = null, origen = 'tienda_retorno', forzar = false }) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || typeof folio !== 'string' || !folio) {
    return { consulta: 'sin_checkout' };
  }
  const clave = `${negocioId.trim()}:${folio}`;
  const enVuelo = _enVuelo.get(clave);
  if (enVuelo) return enVuelo;
  const ahora = Date.now();
  if (!forzar && ahora - (_ultimaConsulta.get(clave) || 0) < intervaloMinimoMs()) {
    return { consulta: 'omitida', motivo: 'reciente' };
  }
  if (_consultando >= MAX_CONCURRENTES) return { consulta: 'omitida', motivo: 'ocupado' };

  podarConsultas(ahora);
  _ultimaConsulta.set(clave, ahora);
  _consultando++;
  const promesa = consultarPedido({ negocioId: negocioId.trim(), folio, alConfirmar, origen })
    .catch(e => {
      console.error(`[Tienda Pago] Verificación de ${folio} falló: ${e.message}`);
      return { consulta: 'sin_respuesta' };
    })
    .finally(() => { _consultando--; _enVuelo.delete(clave); });
  _enVuelo.set(clave, promesa);
  return promesa;
}

async function consultarPedido({ negocioId, folio, alConfirmar, origen }) {
  const { verificarYAsentarClip, derivarPedidoPorPagoAsentado, procesarExpiracionProveedorClip } =
    await import('./webhookPagos.js');

  // a) Dinero ya asentado cuyo pedido quedó a deber la derivación (el proceso
  //    murió en esa ventana): se salda aquí en vez de esperar al barrido.
  const { rows: deudas } = await pool.query(
    `SELECT id FROM pagos
      WHERE negocio_id = $1 AND pedido_folio = $2 AND proveedor = 'clip'
        AND estado = 'pagado' AND derivacion_pendiente`, [negocioId, folio]);
  for (const d of deudas) {
    try {
      const r = await derivarPedidoPorPagoAsentado({ pagoId: d.id, negocioId, folio });
      if (r.derivado && alConfirmar) avisar(alConfirmar, negocioId, folio, origen);
    } catch (e) {
      console.error(`[Tienda Pago] Derivación pendiente de ${folio} no se saldó: ${e.message}`);
    }
  }
  if (deudas.length) return { consulta: 'pagado' };

  // b) Los checkouts de este pedido que el barrido periódico consultaría: los
  //    mismos criterios de pagosReconciliablesDeProveedor, acotados al folio,
  //    y estampando la misma marca de rotación para que el barrido no repita
  //    enseguida lo que se acaba de preguntar.
  const { rows: filas } = await pool.query(
    `UPDATE pagos SET metadata_sanitizada = COALESCE(metadata_sanitizada, '{}'::jsonb)
        || jsonb_build_object('ultima_reconsulta_at', to_jsonb(NOW()))
      WHERE id IN (
        SELECT id FROM pagos
         WHERE negocio_id = $1 AND pedido_folio = $2 AND proveedor = 'clip'
           AND referencia_externa IS NOT NULL
           AND estado NOT IN ('pagado','reembolsado','cancelado')
           AND (metadata_sanitizada->>'provider_terminal_status') IS NULL
         ORDER BY created_at DESC
         LIMIT 5
         FOR UPDATE SKIP LOCKED)
      RETURNING *`, [negocioId, folio]);
  if (!filas.length) {
    const { rows: [pagada] } = await pool.query(
      `SELECT 1 FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 AND proveedor = 'clip' AND estado = 'pagado' LIMIT 1`,
      [negocioId, folio]);
    return { consulta: pagada ? 'pagado' : 'sin_checkout' };
  }

  const vistos = new Set();
  for (const pago of filas) {
    let r;
    try {
      r = await verificarYAsentarClip({ pago, checkoutId: pago.referencia_externa });
    } catch (e) {
      console.error(`[Tienda Pago] Reconsulta de ${pago.id} (${folio}) falló: ${e.message}`);
      vistos.add('sin_respuesta');
      continue;
    }
    if (r.ok) {
      try {
        await derivarPedidoPorPagoAsentado({ pagoId: pago.id, negocioId, folio });
      } catch (e) {
        // El dinero ya quedó asentado con su deuda de derivación: el barrido
        // de derivaciones la salda. Para el cliente, el pago SÍ entró.
        console.error(`[Tienda Pago] ${folio} pagado; la derivación quedó pendiente: ${e.message}`);
      }
      if (alConfirmar) avisar(alConfirmar, negocioId, folio, origen);
      console.log(`[Tienda Pago] ✅ ${folio}: pago ${r.razon} al consultar a Clip (${origen})`);
      vistos.add('pagado');
      continue;
    }
    if (r.razon === 'estado_no_pagado:CHECKOUT_EXPIRED') {
      const rExp = await procesarExpiracionProveedorClip({ pago, checkoutId: pago.referencia_externa })
        .catch(e => ({ ok: false, razon: e.message }));
      console.log(`[Tienda Pago] ${folio} vencido en Clip: ${rExp.razon}`);
      vistos.add('vencido');
      continue;
    }
    if (r.razon === 'sin_respuesta_del_proveedor') { vistos.add('sin_respuesta'); continue; }
    if (String(r.razon).startsWith('estado_no_pagado:')) { vistos.add('pendiente'); continue; }
    // referencia_no_coincide, monto_distinto, transicion_*: la anomalía ya
    // quedó registrada por verificarYAsentarClip. Nadie cobra otra vez.
    console.warn(`[Tienda Pago] ${folio}: ${r.razon}`);
    vistos.add('revision');
  }
  for (const c of ['pagado', 'sin_respuesta', 'revision', 'pendiente', 'vencido']) {
    if (vistos.has(c)) return { consulta: c };
  }
  return { consulta: 'sin_checkout' };
}

function avisar(alConfirmar, negocioId, folio, origen) {
  try { alConfirmar(negocioId, folio, origen); }
  catch (e) { console.error(`[Tienda Pago] Aviso de pago confirmado de ${folio} falló: ${e.message}`); }
}

/**
 * POST /api/tienda/seguimiento/:token/pago/verificar. El pedido sale SOLO del
 * token (192 bits); nunca se acepta un negocio ni un folio del navegador.
 */
export async function verificarPagoAlRegresar(trackingToken, { alConfirmar = null } = {}) {
  const r = await pedidoDeToken(trackingToken);
  if (r.estado !== 'pendiente_pago') return { consulta: 'no_aplica' };
  if (!(await verificacionAlRegresarHabilitada(r.negocio_id))) return { consulta: 'desactivada' };
  return verificarPagoClipDePedido({ negocioId: r.negocio_id, folio: r.pedido_folio, alConfirmar });
}

/**
 * Antes de que pagosService pueda abrir un checkout DISTINTO del vigente.
 *
 * Si el vigente de Clip sigue siendo entregable para esta versión del pedido,
 * pagosService lo reutiliza (mismo checkout, cero cobro nuevo) y aquí no hay
 * nada que hacer. Si no, y existe un checkout anterior de Clip con identidad
 * externa y sin evidencia terminal del proveedor, se le pregunta a Clip
 * primero:
 *   'pagado'   → no se abre nada: el pedido ya está cobrado;
 *   'incierto' → no se abre nada: Clip no contestó y ese checkout pudo cobrar;
 *   'libre'    → pagosService decide como siempre.
 */
export async function revisarAntesDeOtroCobro({ negocioId, folio, datosPedido, alConfirmar = null }) {
  const vigente = await obtenerPagoVigente(negocioId, folio, 'enlace_pago');
  const reutilizable = vigente && vigente.proveedor === 'clip' && vigente.url
    && ['pendiente', 'requiere_revision'].includes(vigente.estado)
    && datosPedido && vigente.version_pedido_hash === calcularVersionPedidoHash(datosPedido);
  if (reutilizable) return 'libre';
  const { rows: [abierto] } = await pool.query(
    `SELECT 1 FROM pagos
      WHERE negocio_id = $1 AND pedido_folio = $2 AND proveedor = 'clip'
        AND referencia_externa IS NOT NULL
        AND estado NOT IN ('pagado','reembolsado','cancelado')
        AND (metadata_sanitizada->>'provider_terminal_status') IS NULL
      LIMIT 1`, [negocioId, folio]);
  if (!abierto) return 'libre';
  const r = await verificarPagoClipDePedido({ negocioId, folio, alConfirmar, origen: 'tienda_antes_de_cobrar', forzar: true });
  if (r.consulta === 'pagado') return 'pagado';
  if (['sin_respuesta', 'revision', 'omitida'].includes(r.consulta)) return 'incierto';
  return 'libre';
}
