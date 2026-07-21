/**
 * Canal Rappi — Sprint 1
 * Maneja webhooks: NEW_ORDER y PING (health check)
 * Cancellations: ORDER_EVENT_CANCEL
 */

import { Router } from 'express';
import { tomarOrden, rechazarOrden, actualizarDisponibilidad } from '../services/rappi-api.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { guardarPedido, guardarMensaje } from '../services/database.js';

let wsBroadcast = null;
export function setWsBroadcastRappi(fn) { wsBroadcast = fn; }

const router = Router();
const STORE_ID = process.env.RAPPI_STORE_ID || '900172582';

// ─── Verificar HMAC de Rappi (opcional, recomendado en producción) ────────────
// Rappi incluye Rappi-Signature header (HMAC-SHA256)
// Por ahora solo logueamos; activar en producción con RAPPI_WEBHOOK_SECRET

// ─── Webhook unificado ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const body = req.body;
  const tipo = body?.type || '';

  // PING — health check de Rappi
  if (tipo === 'PING' || (body?.store_id && !body?.id && !body?.order_id && !tipo)) {
    console.log(`[Rappi] PING para tienda ${body.store_id || STORE_ID}`);
    return res.json({ status: 'OK', description: 'Nonna Maye operando' });
  }

  // MENU_APPROVED — menú aprobado por Rappi
  if (tipo === 'MENU_APPROVED') {
    console.log('[Rappi] ✅ Menú aprobado por Rappi');
    if (wsBroadcast) wsBroadcast({ tipo: 'rappi_menu_aprobado', timestamp: new Date().toISOString() });
    return res.json({ ok: true });
  }

  // MENU_REJECTED — menú rechazado, loguear razón
  if (tipo === 'MENU_REJECTED') {
    const razon = body.reason || body.message || 'sin detalle';
    console.warn(`[Rappi] ❌ Menú rechazado: ${razon}`);
    if (wsBroadcast) wsBroadcast({ tipo: 'rappi_menu_rechazado', razon, timestamp: new Date().toISOString() });
    return res.json({ ok: true });
  }

  // ORDER_EVENT_CANCEL — cancelación
  if (tipo.toLowerCase().includes('cancel')) {
    const orderId = body.order_id || body.id;
    console.log(`[Rappi] Cancelación de orden ${orderId}: ${tipo}`);
    if (wsBroadcast) {
      wsBroadcast({ tipo: 'rappi_cancelacion', orderId, motivo: tipo, timestamp: new Date().toISOString() });
    }
    return res.json({ ok: true });
  }

  // NEW_ORDER — orden nueva
  if (body && (body.id || body.order_id)) {
    res.json({ ok: true }); // responder inmediato a Rappi (< 5 seg o timeout)
    procesarOrdenRappi(body).catch(e =>
      console.error('[Rappi] Error procesando orden:', e.message)
    );
    return;
  }

  // Evento desconocido — loguear y responder OK para no generar reintentos
  console.log('[Rappi] Evento desconocido:', JSON.stringify(body).slice(0, 200));
  res.json({ ok: true });
});

// ─── Procesamiento de orden ───────────────────────────────────────────────────
async function procesarOrdenRappi(data) {
  const orderId = data.id || data.order_id;
  console.log(`[Rappi] Nueva orden #${orderId}`);

  try {
    // Mapear orden Rappi → formato interno Xabor
    const orden = mapearOrdenRappi(data);

    // Registrar y emitir al panel de comandas
    const pedido = registrarPedido(orden, 'rappi');
    emitirPedido(pedido);

    // Guardar en BD (teléfono ficticio para órdenes Rappi)
    const telefonoRappi = `rappi-${orderId}`;
    await guardarPedido(telefonoRappi, orden);

    // Emitir notificación extra al panel con el ID de Rappi
    if (wsBroadcast) {
      wsBroadcast({
        tipo: 'rappi_orden',
        rappiOrderId: orderId,
        pedidoInternoId: pedido.id,
        pedido
      });
    }

    // Tomar la orden en Rappi (cooking time 20 min por defecto)
    const cookingTime = parseInt(process.env.RAPPI_COOKING_TIME || '20', 10);
    await tomarOrden(orderId, cookingTime);
    console.log(`[Rappi] Orden #${orderId} tomada — cooking time ${cookingTime} min`);

  } catch (error) {
    console.error(`[Rappi] Error en orden #${orderId}:`, error.message);
    // Intentar rechazar para no dejar la orden colgada
    try {
      await rechazarOrden(orderId, `Error interno: ${error.message}`);
      console.warn(`[Rappi] Orden #${orderId} rechazada por error`);
    } catch (rejectErr) {
      console.error('[Rappi] No se pudo rechazar:', rejectErr.message);
    }
  }
}

// ─── Mapeo Rappi → Xabor ─────────────────────────────────────────────────────
function mapearOrdenRappi(data) {
  const orderId = data.id || data.order_id;

  // Items
  const items = (data.items || data.products || []).map(item => ({
    nombre: item.name || item.product_name || 'Producto Rappi',
    cantidad: item.units || item.quantity || 1,
    precio_unitario: item.unit_price || item.price || 0,
    notas: formatearTopping(item.toppings || item.sub_items || [])
  }));

  // Totales
  const totales = data.totals || data.total || {};
  const total = totales.total_order || totales.total || data.total_price || 0;
  const subtotal = totales.total_products || total;
  const descuento = totales.total_discounts || 0;

  // Entrega
  const delivery = data.delivery || data.address || {};
  const modalidad = data.delivery_method === 'pickup' ? 'recoger en tienda' : 'entrega a domicilio';

  // Cliente (Rappi puede ofuscar algunos datos)
  const cliente = {
    nombre: data.customer?.name || `Cliente Rappi #${orderId}`,
    telefono: data.customer?.phone || `rappi-${orderId}`,
    calle: delivery.complete_address || delivery.street_name || 'Dirección Rappi',
    colonia: delivery.neighborhood || '',
    entre_calles: delivery.complement || ''
  };

  return {
    rappi_order_id: orderId,
    cliente,
    modalidad,
    items,
    subtotal: parseFloat(subtotal),
    costo_envio: 0,          // Rappi cobra su propio envío
    descuento: parseFloat(descuento),
    total: parseFloat(total),
    canal: 'rappi',
    pago: 'rappi_pay'        // Pago ya procesado por Rappi
  };
}

function formatearTopping(toppings) {
  if (!toppings || toppings.length === 0) return '';
  return toppings.map(t => `${t.name || t.topping_name}: ${t.units || 1}`).join(', ');
}

// ─── Endpoint de stockout (llamado desde el panel) ───────────────────────────
// Este endpoint lo monta server.js en /api/rappi/stockout
export async function manejarStockout(req, res) {
  const { turn_off = [], turn_on = [] } = req.body;

  if (turn_off.length === 0 && turn_on.length === 0) {
    return res.status(400).json({ error: 'Envía turn_off o turn_on con array de SKUs' });
  }

  try {
    const result = await actualizarDisponibilidad(turn_on, turn_off);
    console.log('[Rappi] Disponibilidad actualizada:', { turn_on, turn_off });
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[Rappi] Error actualizando disponibilidad:', e.message);
    res.status(500).json({ error: e.message });
  }
}

export default router;
