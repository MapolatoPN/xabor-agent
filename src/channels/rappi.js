/**
 * Canal Rappi — webhook entrante y ciclo de vida de la orden.
 *
 * NEW_ORDER, en este orden y ninguno más:
 *   1. resolver el negocio por store.internal_id (integraciones_canal);
 *   2. verificar la firma Rappi-Signature con el secreto de esa integración
 *      (modo 'exigir' rechaza; modo 'registrar' solo deja constancia);
 *   3. reclamar la orden en `pedidos_externos` (UNIQUE negocio+canal+id):
 *      duplicado o en curso → no se crea nada;
 *   4. acusar recibo a Rappi (la constancia ya es durable);
 *   5. mapear contra el catálogo real y PERSISTIR el pedido (registrarPedido);
 *   6. solo entonces aceptar en Rappi (take);
 *   7. publicar al POS e impresión (emitirPedido → WS + Edge).
 *
 * Un error interno de Xabor NUNCA rechaza la orden en Rappi: la venta ya está
 * cobrada. Queda 'fallido' en el ledger (reintentable por el reconciliador),
 * se avisa al panel y la orden sigue SENT en Rappi para que alguien la tome
 * desde la tablet si hace falta.
 *
 * Cancelaciones (ORDER_EVENT_CANCEL): se localiza el pedido por el ledger,
 * se cancela en Xabor, se avisa en papel a las mismas estaciones que
 * recibieron la comanda, se avisa al panel y queda trazado.
 */

import { Router } from 'express';
import { registrarPedido, emitirPedido, obtenerPedidoPorId, actualizarEstadoPedido } from '../orders/orderManager.js';
import { guardarPedido, upsertCliente, cancelarPedidoActivo, pool } from '../services/database.js';
import { eventoTxn } from '../orders/validadorOrden.js';
import {
  obtenerIntegracionRappiPorStore, obtenerIntegracionRappi, crearClienteRappiParaIntegracion,
  clienteRappiDeNegocio, cookingTimeDe, secretoWebhookDe, modoFirmaDe, CANAL_RAPPI,
} from '../services/rappiIntegracion.js';
import { clienteRappiDesdeEntorno } from '../services/rappi-api.js';
import {
  reclamarPedidoExterno, retomarPedidoExterno, marcarPedidoExternoCreado, marcarAceptacionProveedor,
  marcarPedidoExternoFallido, marcarPedidoExternoCancelado, marcarListoNotificado,
  obtenerPedidoExterno, pedidosExternosPendientes,
} from '../services/pedidosExternos.js';
import { normalizarSobreRappi, cargarCatalogoParaRappi, mapearOrdenRappi } from './rappiMapeo.js';
import { verificarFirmaRappi } from './rappiFirma.js';
import { crearTrabajosDeCancelacionDePedido } from '../services/impresionService.js';
import { entregarTrabajosPorEdge } from '../printing/edgeComanda.js';

// Dos canales de emisión, inyectados desde server.js:
//   - wsBroadcastNegocio(negocioId, data, opts) → aislado por negocio.
//   - wsBroadcastLegacy(data) → broadcast global legado; solo para
//     rappi_menu_aprobado/rechazado (sin datos operativos que aislar).
let wsBroadcastNegocio = null;
let wsBroadcastLegacy = null;
export function setWsBroadcastRappi(fnNegocio, fnLegacy) {
  wsBroadcastNegocio = fnNegocio;
  wsBroadcastLegacy = fnLegacy;
}
function avisarNegocio(negocioId, data, opts) {
  if (negocioId && wsBroadcastNegocio) {
    try { wsBroadcastNegocio(negocioId, data, opts); } catch (e) { console.error('[Rappi] WS:', e.message); }
  }
}

// Punto de fallo inyectable SOLO para pruebas (nunca en producción): permite
// demostrar que un error interno no rechaza la orden en Rappi.
function _falloInyectado(punto) {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.RAPPI_PRUEBA_FALLO === punto) throw new Error(`fallo inyectado en ${punto}`);
}

const router = Router();

// ─── Health check GET ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ status: 'OK', endpoint: '/webhook/rappi', timestamp: new Date().toISOString() });
});

// ─── Clasificación del sobre ────────────────────────────────────────────────
function clasificar(body) {
  const evento = String(body?.event || body?.type || '');
  if (!body || typeof body !== 'object') return { tipo: 'desconocido', evento };
  if (body.external_store_id !== undefined) return { tipo: 'store_connectivity', evento };
  if (body.message === 'Menu Approved') return { tipo: 'menu_aprobado', evento };
  if (evento && /cancel/i.test(evento)) return { tipo: 'cancelacion', evento };
  const sobre = normalizarSobreRappi(body);
  if (sobre) return { tipo: 'nueva_orden', evento, sobre };
  if (evento && body.order_id != null) return { tipo: 'evento_orden', evento };
  if (!evento && body.store_id != null && body.order_id == null && body.id == null) {
    // PING ({store_id}) y MENU_REJECTED ({store_id}) tienen la misma forma;
    // Rappi los distingue por el webhook al que los manda, no por el cuerpo.
    // Ambos se responden igual (status OK) y solo cambia la constancia.
    return { tipo: 'ping_o_menu_rechazado', evento };
  }
  return { tipo: 'desconocido', evento };
}

// ─── Webhook unificado ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const body = req.body;
  const ts = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'desconocida';
  const firmaHeader = req.get('rappi-signature') || null;
  const { tipo, evento, sobre } = clasificar(body);

  // Constancia sin datos del cliente: solo tipo, evento, ids y tamaño.
  console.log(`[Rappi] ▶ ${ts} | tipo=${tipo} evento="${evento}" | ip=${ip} | firma=${firmaHeader ? 'si' : 'no'} | orden=${sobre?.orderId ?? body?.order_id ?? '-'} | bytes=${req.rawBody?.length ?? 0}`);

  switch (tipo) {
    case 'ping_o_menu_rechazado':
      // Doc de Rappi: «this field is required, if the value is null or
      // different to OK it will be considered as unavailable store».
      console.log(`[Rappi] PING/MENU_REJECTED tienda …${String(body.store_id).slice(-4)}`);
      if (wsBroadcastLegacy) wsBroadcastLegacy({ tipo: 'rappi_ping', timestamp: ts });
      return res.json({ status: 'OK', description: 'Store on' });

    case 'store_connectivity':
      console.log(`[Rappi] 🏪 Store connectivity: enabled=${body.enabled} — ${body.message}`);
      return res.json({ status: 'OK', received: ts });

    case 'menu_aprobado':
      console.log('[Rappi] ✅ Menú aprobado');
      if (wsBroadcastLegacy) wsBroadcastLegacy({ tipo: 'rappi_menu_aprobado', timestamp: ts });
      return res.json({ status: 'OK', received: ts });

    case 'evento_orden':
      console.log(`[Rappi] 📦 Evento de orden ${body.order_id}: ${evento}`);
      return res.json({ status: 'OK', received: ts });

    case 'cancelacion': {
      res.json({ status: 'OK', received: ts });
      procesarCancelacionRappi(body, evento).catch(e =>
        console.error('[Rappi] ❌ Error procesando cancelación:', e.message, e.stack));
      return;
    }

    case 'nueva_orden':
      return recibirNuevaOrden(req, res, sobre, ts);

    default:
      console.warn(`[Rappi] ⚠ Evento no identificado | evento="${evento}" | claves=${Object.keys(body || {}).join(',')}`);
      return res.json({ status: 'OK', received: ts, ignorado: 'evento_no_identificado' });
  }
});

async function recibirNuevaOrden(req, res, sobre, ts) {
  // 1. Negocio dueño del store. Sin fallback a ningún negocio por defecto.
  const integracion = sobre.storeId ? await obtenerIntegracionRappiPorStore(sobre.storeId) : null;
  if (!integracion) {
    eventoTxn('rappi_store_no_registrado', '(sin negocio)', { formato: sobre.formato, conStore: !!sobre.storeId });
    console.warn(`[Rappi] Orden ${sobre.orderId} de un store no registrado (o sin store.internal_id) — ignorada`);
    return res.json({ status: 'OK', received: ts, ignorado: 'store_no_registrado' });
  }

  // 2. Firma. El secreto es el de ESTA integración (o el del entorno).
  const firma = verificarFirmaRappi({ header: req.get('rappi-signature'), rawBody: req.rawBody, secret: secretoWebhookDe(integracion) });
  const modoFirma = modoFirmaDe(integracion);
  if (!firma.valida) {
    console.warn(`[Rappi] firma ${firma.motivo} (modo ${modoFirma}) negocio=${integracion.negocioSlug} orden=${sobre.orderId}`);
    if (modoFirma === 'exigir') {
      eventoTxn('rappi_firma_rechazada', integracion.negocioId, { motivo: firma.motivo });
      return res.status(401).json({ error: 'Firma inválida', motivo: firma.motivo });
    }
    eventoTxn('rappi_firma_no_verificada', integracion.negocioId, { motivo: firma.motivo });
  }

  // 3. Idempotencia durable ANTES de acusar recibo.
  let reclamo;
  try {
    reclamo = await reclamarPedidoExterno({ negocioId: integracion.negocioId, canal: CANAL_RAPPI, idExterno: sobre.orderId, payload: req.body });
  } catch (e) {
    // Sin constancia durable no se acusa recibo: que Rappi reintente.
    console.error(`[Rappi] no se pudo registrar la orden ${sobre.orderId} en pedidos_externos: ${e.message}`);
    return res.status(503).json({ error: 'No se pudo registrar la orden; reintentar' });
  }
  if (reclamo.accion === 'duplicado') {
    console.log(`[Rappi] Orden ${sobre.orderId} ya procesada (folio ${reclamo.registro.folio ?? '-'}, estado ${reclamo.registro.estado}) — reentrega ignorada`);
    return res.json({ status: 'OK', received: ts, duplicado: true, folio: reclamo.registro.folio ?? null });
  }
  if (reclamo.accion === 'en_curso') {
    console.log(`[Rappi] Orden ${sobre.orderId} en proceso por otro trabajador — reentrega ignorada`);
    return res.json({ status: 'OK', received: ts, en_curso: true });
  }

  // 4. Acuse: la constancia ya está en la base.
  res.json({ status: 'OK', received: ts });
  procesarOrdenReclamada({ sobre, integracion, registro: reclamo.registro, origen: 'webhook' }).catch(e =>
    console.error(`[Rappi] ❌ Error inesperado procesando orden ${sobre.orderId}:`, e.message, e.stack));
}

// ─── 5–7: mapear, persistir, aceptar, publicar ─────────────────────────────
export async function procesarOrdenReclamada({ sobre, integracion, registro, origen = 'webhook' }) {
  const negocioId = integracion.negocioId;
  const orderId = sobre.orderId;
  console.log(`[Rappi] Procesando orden ${orderId} → ${integracion.negocioSlug} (${origen}, intento ${registro.intentos})`);

  // Fase 1: hasta que el pedido exista. Cualquier fallo aquí deja el ledger
  // en 'fallido' (reintentable) y NO toca Rappi.
  let pedido;
  try {
    const catalogo = await cargarCatalogoParaRappi(negocioId);
    const { orden, auditoria } = mapearOrdenRappi(sobre, catalogo, integracion);
    if (auditoria.requiere_revision) {
      eventoTxn('rappi_mapeo_incompleto', negocioId, {
        orden: orderId, sin_resolver: auditoria.sin_resolver.length,
        mods_sin_resolver: auditoria.modificadores_sin_resolver.length, no_disponibles: auditoria.no_disponibles.length,
      });
    }
    _falloInyectado('antes_de_persistir');
    pedido = await registrarPedido(orden, 'rappi');
    await marcarPedidoExternoCreado(registro.id, { folio: pedido.id });
  } catch (e) {
    await marcarPedidoExternoFallido(registro.id, e).catch(() => {});
    eventoTxn('rappi_orden_fallida', negocioId, { orden: orderId, error: String(e.message).slice(0, 160), intento: registro.intentos });
    console.error(`[Rappi] ❌ Orden ${orderId} NO creada en Xabor (queda SENT en Rappi, se reintentará): ${e.message}`);
    avisarNegocio(negocioId, { tipo: 'rappi_orden_fallida', rappiOrderId: orderId, error: String(e.message).slice(0, 200), intento: registro.intentos, timestamp: new Date().toISOString() }, { soloAdmin: true });
    return { ok: false, error: e };
  }

  // Historial legado (tablas pedidos/clientes) -- best effort, nunca decide.
  try {
    const telefonoRappi = `rappi-${orderId}`;
    await upsertCliente(telefonoRappi, pedido.cliente?.nombre, negocioId);
    await guardarPedido(telefonoRappi, pedido, negocioId);
  } catch (e) {
    console.warn(`[Rappi] historial legado no guardado para ${pedido.id}: ${e.message}`);
  }

  // Fase 2: aceptar en Rappi. Un fallo aquí NO deshace el pedido: se marca y
  // se avisa; el pedido igual sale a cocina (la venta existe).
  let aceptado = false;
  let errorAceptacion = null;
  try {
    const cliente = await crearClienteRappiParaIntegracion(integracion);
    if (!cliente) throw new Error('sin credenciales de Rappi para este negocio');
    _falloInyectado('al_aceptar');
    await cliente.tomarOrden(orderId, cookingTimeDe(integracion));
    aceptado = true;
    console.log(`[Rappi] Orden ${orderId} tomada — cooking time ${cookingTimeDe(integracion)} min (${cliente.etiqueta})`);
  } catch (e) {
    errorAceptacion = String(e.message).slice(0, 300);
    eventoTxn('rappi_orden_no_aceptada', negocioId, { orden: orderId, folio: pedido.id, error: errorAceptacion.slice(0, 160) });
    console.error(`[Rappi] ⚠ Orden ${orderId} creada como ${pedido.id} pero NO aceptada en Rappi: ${errorAceptacion}`);
  }
  await marcarAceptacionProveedor(registro.id, { aceptado, error: errorAceptacion }).catch(() => {});
  const aceptacion = { aceptado, error: errorAceptacion, at: new Date().toISOString() };
  pedido.rappi = { ...(pedido.rappi || {}), aceptacion };
  await pool.query(
    `UPDATE pedidos_activos SET datos = jsonb_set(COALESCE(datos,'{}'::jsonb), '{rappi,aceptacion}', $3::jsonb, true), updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $2`,
    [pedido.id, negocioId, JSON.stringify(aceptacion)]).catch(e => console.warn('[Rappi] no se pudo anotar la aceptación:', e.message));

  // Fase 3: publicar (WS + Edge). emitirPedido relee el pedido de la base y
  // es idempotente por la deuda de emisión (063).
  try {
    await emitirPedido(pedido);
  } catch (e) {
    console.error(`[Rappi] emitirPedido(${pedido.id}) falló (la deuda de emisión lo reintentará): ${e.message}`);
  }
  avisarNegocio(negocioId, {
    tipo: 'rappi_orden', rappiOrderId: orderId, pedidoInternoId: pedido.id, aceptado,
    requiereRevision: pedido.mapeo?.requiere_revision === true, pedido,
  });
  if (!aceptado) {
    avisarNegocio(negocioId, { tipo: 'rappi_orden_no_aceptada', rappiOrderId: orderId, folio: pedido.id, error: errorAceptacion, timestamp: aceptacion.at }, { soloAdmin: true });
  }
  return { ok: true, pedido, aceptado };
}

// ─── Reconciliación: lo que un crash o un fallo dejó sin pedido ────────────
// Mismo camino que el webhook (procesarOrdenReclamada), nunca uno paralelo.
export async function reconciliarPedidosExternosRappi({ limite = 20 } = {}) {
  const pendientes = await pedidosExternosPendientes(CANAL_RAPPI, { limite }).catch(() => []);
  let recuperados = 0;
  for (const fila of pendientes) {
    const tomada = await retomarPedidoExterno(fila.id).catch(() => null);
    if (!tomada) continue;
    const sobre = normalizarSobreRappi(tomada.payload);
    if (!sobre) { await marcarPedidoExternoFallido(tomada.id, 'payload no reconocido como orden').catch(() => {}); continue; }
    const integracion = (sobre.storeId ? await obtenerIntegracionRappiPorStore(sobre.storeId) : null)
      || await obtenerIntegracionRappi(tomada.negocio_id);
    if (!integracion || integracion.negocioId !== tomada.negocio_id) {
      await marcarPedidoExternoFallido(tomada.id, 'integración ya no resuelve al mismo negocio').catch(() => {});
      continue;
    }
    const r = await procesarOrdenReclamada({ sobre, integracion, registro: tomada, origen: 'reconciliacion' });
    if (r.ok) recuperados++;
  }
  if (recuperados) console.log(`[Rappi] Órdenes recuperadas por reconciliación: ${recuperados}`);
  return recuperados;
}

// ─── Cancelación desde Rappi ────────────────────────────────────────────────
export async function procesarCancelacionRappi(body, evento) {
  const orderId = body?.order_id != null ? String(body.order_id) : null;
  const integracion = body?.store_id != null ? await obtenerIntegracionRappiPorStore(body.store_id) : null;
  console.log(`[Rappi] 🚫 Cancelación orden ${orderId ?? '-'}: ${evento} (${integracion ? integracion.negocioSlug : 'store no resuelto'})`);
  if (!orderId) return { resultado: 'sin_order_id' };
  if (!integracion) {
    // Sin negocio no se inventa uno. Se deja en el broadcast legado para no
    // perder el evento, como antes.
    if (wsBroadcastLegacy) wsBroadcastLegacy({ tipo: 'rappi_cancelacion', orderId, motivo: evento, resultado: 'store_no_registrado', timestamp: new Date().toISOString() });
    eventoTxn('rappi_cancelacion_store_no_registrado', '(sin negocio)', { orden: orderId });
    return { resultado: 'store_no_registrado' };
  }
  const negocioId = integracion.negocioId;

  let registro = await obtenerPedidoExterno({ negocioId, canal: CANAL_RAPPI, idExterno: orderId });
  if (!registro) {
    // Orden que nunca entró (o entró antes del ledger): queda constancia de
    // la cancelación igualmente, con el sobre.
    const r = await reclamarPedidoExterno({ negocioId, canal: CANAL_RAPPI, idExterno: orderId, payload: body }).catch(() => null);
    registro = r?.registro ?? null;
  }
  if (registro?.estado === 'cancelado') {
    console.log(`[Rappi] cancelación de ${orderId} ya aplicada — reentrega ignorada`);
    return { resultado: 'ya_cancelado', folio: registro.folio };
  }

  const folio = registro?.folio ?? null;
  let resultado = 'sin_pedido';
  let impresion = null;
  if (folio) {
    const { rows: [fila] } = await pool.query(
      `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, negocioId]);
    const enMemoria = obtenerPedidoPorId(folio, negocioId);
    const estadoActual = fila?.estado ?? enMemoria?.estado ?? null;
    const marca = { evento, origen: 'rappi', timestamp: new Date().toISOString(), estado_previo: estadoActual };

    if (!fila) {
      resultado = 'pedido_no_encontrado';
    } else if (estadoActual === 'entregado') {
      // Ya se entregó: no se cambia el estado (el corte ya lo cuenta); queda
      // la marca para que el admin lo revise contra la liquidación de Rappi.
      resultado = 'ya_entregado';
      await pool.query(
        `UPDATE pedidos_activos SET datos = jsonb_set(COALESCE(datos,'{}'::jsonb), '{rappi,cancelacion}', $3::jsonb, true), updated_at = NOW()
          WHERE folio = $1 AND negocio_id = $2`, [folio, negocioId, JSON.stringify(marca)]).catch(() => {});
    } else if (estadoActual === 'cancelado') {
      resultado = 'ya_cancelado';
    } else {
      const yaPreparado = estadoActual === 'listo';
      const motivo = `Cancelado por Rappi (${evento})${yaPreparado ? ' — el pedido ya estaba listo' : ''}`;
      const ok = await cancelarPedidoActivo(folio, motivo, negocioId);
      if (!ok) {
        resultado = 'no_se_pudo_cancelar';
      } else {
        resultado = yaPreparado ? 'cancelado_ya_preparado' : 'cancelado';
        // Memoria + WS actualizar_estado (si el pedido no está en memoria,
        // la base ya quedó cancelada y el replay lo traerá así).
        actualizarEstadoPedido(folio, 'cancelado', negocioId);
        await pool.query(
          `UPDATE pedidos_activos SET datos = jsonb_set(COALESCE(datos,'{}'::jsonb), '{rappi,cancelacion}', $3::jsonb, true), updated_at = NOW()
            WHERE folio = $1 AND negocio_id = $2`, [folio, negocioId, JSON.stringify(marca)]).catch(() => {});
        // Papel en las mismas estaciones que recibieron la comanda.
        const pedidoParaPapel = enMemoria || { id: folio, canal: 'rappi', rappi_order_id: orderId, items: fila.datos?.items || [] };
        impresion = await crearTrabajosDeCancelacionDePedido({ negocioId, pedido: pedidoParaPapel, motivo: `${evento}${yaPreparado ? ' · YA ESTABA LISTO' : ''}` });
        await entregarTrabajosPorEdge(impresion.creados);
      }
    }
  }

  if (registro) {
    await marcarPedidoExternoCancelado(registro.id, { evento, resultado, folio, timestamp: new Date().toISOString() }).catch(() => {});
  }
  eventoTxn('rappi_cancelacion', negocioId, { orden: orderId, folio, resultado, papel: impresion ? impresion.creados.length : 0 });
  avisarNegocio(negocioId, {
    tipo: 'rappi_cancelacion', orderId, folio, resultado, motivo: evento,
    impresion: impresion ? { trabajos: impresion.creados.length, duplicados: impresion.duplicados.length, avisos: impresion.avisos } : null,
    timestamp: new Date().toISOString(),
  });
  return { resultado, folio, impresion };
}

// ─── "Listo" hacia Rappi (ready-for-pickup) ────────────────────────────────
// Lo llama el punto donde el panel marca 'listo' (PATCH /pedidos/:id/estado).
// Una sola vez por pedido (Rappi corta a la tercera llamada por orden).
export async function notificarListoARappi(pedido) {
  if (!pedido || pedido.canal !== 'rappi' || !pedido.rappi_order_id) return { enviado: false, razon: 'no_es_rappi' };
  const negocioId = pedido.negocioId;
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { enviado: false, razon: 'sin_negocio' };
  const gano = await marcarListoNotificado(negocioId, CANAL_RAPPI, pedido.id);
  if (!gano) return { enviado: false, razon: 'ya_notificado_o_sin_registro' };
  try {
    const integracion = await obtenerIntegracionRappi(negocioId);
    const cliente = integracion ? await crearClienteRappiParaIntegracion(integracion) : null;
    if (!cliente) throw new Error('sin integración o credenciales de Rappi');
    await cliente.ordenListaParaRecoger(String(pedido.rappi_order_id));
    console.log(`[Rappi] ready-for-pickup enviado para ${pedido.id} (orden ${pedido.rappi_order_id})`);
    return { enviado: true };
  } catch (e) {
    // Se libera la marca para que un segundo clic pueda reintentar.
    await pool.query(
      `UPDATE pedidos_externos SET listo_notificado_at = NULL, actualizado_at = NOW() WHERE negocio_id = $1 AND canal = $2 AND folio = $3`,
      [negocioId, CANAL_RAPPI, pedido.id]).catch(() => {});
    eventoTxn('rappi_listo_no_notificado', negocioId, { folio: pedido.id, error: String(e.message).slice(0, 160) });
    console.error(`[Rappi] ready-for-pickup falló para ${pedido.id}: ${e.message}`);
    return { enviado: false, razon: 'error', error: e.message };
  }
}

// ─── Endpoint de stockout (llamado desde el panel) ─────────────────────────
// Montado por server.js en /api/rappi/stockout. Con sesión de negocio usa la
// integración de ESE negocio; sin ella (token legado) el cliente del entorno.
export async function manejarStockout(req, res) {
  const { turn_off = [], turn_on = [] } = req.body;
  if (turn_off.length === 0 && turn_on.length === 0) {
    return res.status(400).json({ error: 'Envía turn_off o turn_on con array de SKUs' });
  }
  try {
    let cliente = null;
    if (typeof req.negocioId === 'string' && req.negocioId) {
      ({ cliente } = await clienteRappiDeNegocio(req.negocioId));
      if (!cliente) return res.status(409).json({ error: 'Este negocio no tiene la integración de Rappi configurada' });
    } else {
      cliente = clienteRappiDesdeEntorno();
      if (!cliente) return res.status(409).json({ error: 'Rappi no está configurado' });
    }
    const result = await cliente.actualizarDisponibilidad(turn_on, turn_off);
    console.log(`[Rappi] Disponibilidad actualizada (${cliente.etiqueta}):`, { turn_on, turn_off });
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[Rappi] Error actualizando disponibilidad:', e.message);
    res.status(500).json({ error: e.message });
  }
}

export default router;
