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

// ─── Health check GET (para verificar que el endpoint es accesible) ──────────
router.get('/', (req, res) => {
  res.json({ status: 'OK', endpoint: '/webhook/rappi', timestamp: new Date().toISOString() });
});

// ─── Webhook unificado ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const body = req.body;
  const ts = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'desconocida';
  const sig = req.headers['rappi-signature'] || 'ninguna';

  // Rappi docs usan "event"; implementaciones previas/DEV pueden usar "type". Soportamos ambos.
  const evento = body?.event || body?.type || '';

  // LOG COMPLETO — siempre
  console.log(`[Rappi] ▶ ${ts} | evento="${evento}" | ip=${ip} | sig=${sig.slice(0,30)} | body=${JSON.stringify(body).slice(0,400)}`);

  // Responder 200 inmediato para evitar timeouts de Rappi
  res.json({ ok: true, received: ts });

  // PING — { store_id: 999 } sin campo event
  if (!evento && body?.store_id && !body?.order_id && !body?.id) {
    console.log(`[Rappi] ✅ PING tienda ${body.store_id}`);
    return;
  }

  // STORE_CONNECTIVITY — { external_store_id, enabled, message }
  if (body?.external_store_id !== undefined) {
    console.log(`[Rappi] 🏪 Store connectivity: enabled=${body.enabled} — ${body.message}`);
    return;
  }

  // MENU_APPROVED — { store_id, message: "Menu Approved" }
  if (body?.message === 'Menu Approved') {
    console.log('[Rappi] ✅ Menú aprobado');
    if (wsBroadcast) wsBroadcast({ tipo: 'rappi_menu_aprobado', timestamp: ts });
    return;
  }

  // MENU_REJECTED — { store_id } sin message
  if (body?.store_id && !body?.order_id && !body?.id && !body?.message && !evento) {
    console.log(`[Rappi] ❌ Menú rechazado para tienda ${body.store_id}`);
    if (wsBroadcast) wsBroadcast({ tipo: 'rappi_menu_rechazado', timestamp: ts });
    return;
  }

  // ORDER_EVENT_CANCEL — { event: "canceled_with_charge", order_id, store_id }
  if (evento && (evento.includes('cancel') || evento.includes('Cancel'))) {
    console.log(`[Rappi] 🚫 Cancelación orden ${body.order_id}: ${evento}`);
    if (wsBroadcast) wsBroadcast({ tipo: 'rappi_cancelacion', orderId: body.order_id, motivo: evento, timestamp: ts });
    return;
  }

  // ORDER_OTHER_EVENT — { event: "taken_visible_order", order_id, store_id }
  if (evento && body?.order_id && !body?.id) {
    console.log(`[Rappi] 📦 Evento de orden ${body.order_id}: ${evento}`);
    return;
  }

  // NEW_ORDER — objeto completo del pedido (tiene id o contiene items/products)
  if (body && (body.id || (body.order_id && body.items))) {
    console.log(`[Rappi] 🛒 Nueva orden ${body.id || body.order_id} — procesando...`);
    procesarOrdenRappi(body).catch(e =>
      console.error('[Rappi] ❌ Error procesando orden:', e.message, e.stack)
    );
    return;
  }

  // Evento no identificado — loguear completo
  console.warn(`[Rappi] ⚠ Evento no identificado | evento="${evento}" | body completo: ${JSON.stringify(body)}`);
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
