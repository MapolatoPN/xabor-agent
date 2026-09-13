// ─── Rewards en la Tienda Online ──────────────────────────────────────────
//
// Puente entre la tienda pública y `rewardsService.js`. Archivo nuevo a
// propósito (CLAUDE.md: "módulos nuevos en archivos nuevos"): la tienda no
// reimplementa ni una sola regla de puntos -- las lee de rewardsService, que
// sigue siendo la única fuente de verdad para POS, WhatsApp y voz.
//
// LO QUE ESTE MÓDULO GARANTIZA, y por qué cada cosa está donde está:
//
//   · El navegador NUNCA decide un descuento. Manda una intención ("quiero
//     usar N puntos") y el servidor recalcula todo: módulo contratado,
//     programa activo, canal encendido, cuenta del cliente EN ESTE NEGOCIO,
//     múltiplos, saldo y tope contra el total. Lo que se aplica es lo que
//     devuelve el servidor, nunca lo que pidió el cliente.
//
//   · El recorte es hacia ABAJO. Si el cliente pide más de lo que puede, no
//     se rechaza el checkout entero (el carrito pudo cambiar desde la
//     cotización): se aplica el máximo legítimo y se devuelve ESE número
//     para que la tienda muestre la verdad. Nunca hacia arriba.
//
//   · Aislamiento multiempresa: cada consulta lleva el negocioId resuelto
//     desde el slug de la URL, jamás uno que venga del navegador. La cuenta
//     de Rewards vive en (telefono, tenant_id), así que el mismo teléfono en
//     otro negocio es otra cuenta con otro saldo.
import {
  obtenerConfig, obtenerCuentaPorTelefono, calcularBloquesDisponibles,
  registrarCanje, calcularPuntos, MAPA_CANAL_CONFIG,
} from './rewardsService.js';
import { obtenerEstadoModulo } from './database.js';

// Mismo criterio que rewardsService/requireModulo: 'activo' o 'configurado'.
const ESTADOS_DISPONIBLES = ['activo', 'configurado'];

// El canal del pedido que estampa tiendaCheckout.js. Se nombra una sola vez.
export const CANAL_TIENDA = 'tienda_online';

/**
 * ¿Rewards está realmente encendido para la tienda de este negocio?
 *
 * Tres candados independientes, y los tres tienen que abrir:
 *   1. negocio_modulos.rewards contratado (la decisión comercial),
 *   2. rewards_config.activo (el programa encendido),
 *   3. rewards_config.canal_tienda (este canal en particular, migración 079).
 *
 * Fallo CERRADO en todos los caminos, incluido el error de base: un negocio
 * sin configuración no acumula ni canjea, nunca al revés. Devuelve siempre la
 * misma forma para que el llamador no tenga que distinguir "apagado" de "no
 * existe".
 */
export async function rewardsDeTienda(negocioId) {
  const apagado = { activo: false, config: null };
  if (typeof negocioId !== 'string' || !negocioId.trim()) return apagado;
  const nid = negocioId.trim();
  try {
    const estado = await obtenerEstadoModulo(nid, 'rewards');
    if (!ESTADOS_DISPONIBLES.includes(estado)) return apagado;

    const config = await obtenerConfig(nid);
    if (!config || !config.activo) return apagado;

    // El mapa de canales es el MISMO que usa la acumulación. Si mañana el
    // canal cambia de nombre, cambia en un solo lugar.
    if (!MAPA_CANAL_CONFIG(config)[CANAL_TIENDA]) return apagado;

    return { activo: true, config };
  } catch (e) {
    console.error(`[TiendaRewards] No se pudo resolver Rewards para ${nid}: ${e.message}`);
    return apagado;
  }
}

// Un teléfono sirve como identidad de Rewards con el mismo criterio que
// acumularPuntos: ni vacío, ni el guion del cliente técnico presencial, ni
// algo demasiado corto para ser un número real.
export function telefonoUtilizable(telefono) {
  const t = String(telefono || '').trim();
  return t && t !== '—' && t.length >= 7 ? t : null;
}

/**
 * Lo que la tienda puede mostrarle a un cliente identificado por su teléfono.
 *
 * PRIVACIDAD: devuelve EXCLUSIVAMENTE cifras de puntos. Ni nombre, ni última
 * visita, ni historial, ni si el teléfono existe como cliente -- un teléfono
 * sin cuenta devuelve exactamente la misma forma con ceros, así que la
 * respuesta no confirma ni desmiente que alguien sea cliente del negocio.
 * (Riesgo residual documentado: un saldo > 0 sí revela que ese teléfono
 * compró aquí. Ver docs/rewards-tienda-online.md.)
 *
 * `totalCarrito` es opcional: sin él se informa el saldo; con él se calcula
 * además cuánto de ese saldo cabe realmente en esta compra.
 */
export async function saldoParaTienda(negocioId, telefono, totalCarrito = 0) {
  const vacio = {
    activo: false, puntos: 0, canjeMinimo: 0, valorPunto: 0,
    puntosAplicables: 0, descuento: 0, nombrePrograma: null,
  };
  const { activo, config } = await rewardsDeTienda(negocioId);
  if (!activo) return vacio;

  const base = {
    activo: true,
    puntos: 0,
    canjeMinimo: parseInt(config.canje_minimo, 10) || 100,
    valorPunto: parseFloat(config.puntos_por_peso) || 0,
    puntosAplicables: 0,
    descuento: 0,
    nombrePrograma: config.nombre_programa || 'Rewards',
    // Para la frase "esta compra te da N puntos". Es una ESTIMACIÓN: la
    // acumulación real la calcula el backend al entregar, sobre el total ya
    // cobrado y descontando lo que se haya canjeado.
    puntosQueGanaria: calcularPuntos(Number(totalCarrito) || 0, config),
  };

  const tel = telefonoUtilizable(telefono);
  if (!tel) return base;

  const cuenta = await obtenerCuentaPorTelefono(tel, negocioId);
  if (!cuenta || !cuenta.activo) return base;

  const saldo = parseInt(cuenta.puntos_balance, 10) || 0;
  const cabe = calcularBloquesDisponibles(saldo, Number(totalCarrito) || 0, config);
  return { ...base, puntos: saldo, puntosAplicables: cabe.puntos, descuento: cabe.valor };
}

/**
 * Traduce la intención del cliente ("usar N puntos") al canje que el negocio
 * de verdad puede conceder sobre ESTE total. Devuelve null cuando no aplica
 * nada -- que es el caso normal, no un error.
 *
 * No toca la base más allá de leer: aquí no se gasta ningún punto. El débito
 * real (atómico, con lock de fila e idempotente por folio) es `registrarCanje`
 * y ocurre en `consumirCanjeDeTienda`, ya con el pedido creado.
 */
export async function planDeCanje({ negocioId, telefono, puntosSolicitados, total }) {
  const pedidos = parseInt(puntosSolicitados, 10) || 0;
  if (pedidos <= 0) return null;

  const { activo, config } = await rewardsDeTienda(negocioId);
  if (!activo) return null;

  const tel = telefonoUtilizable(telefono);
  if (!tel) return null;

  const cuenta = await obtenerCuentaPorTelefono(tel, negocioId);
  if (!cuenta || !cuenta.activo) return null;

  const saldo = parseInt(cuenta.puntos_balance, 10) || 0;

  // El techo real es el MENOR de tres: lo que pidió, lo que tiene y lo que
  // cabe en la venta. `calcularBloquesDisponibles` ya cruza saldo × total en
  // bloques de canje_minimo; pasarle el mínimo entre saldo y lo solicitado
  // añade el tercer límite sin duplicar la aritmética de bloques.
  const tope = Math.min(pedidos, saldo);
  const cabe = calcularBloquesDisponibles(tope, Number(total) || 0, config);
  if (cabe.puntos <= 0 || cabe.valor <= 0) return null;

  return {
    telefono: tel,
    puntos: cabe.puntos,
    monto: Math.round(cabe.valor * 100) / 100,
    recortado: cabe.puntos < pedidos,
  };
}

/**
 * Gasta de verdad los puntos del plan, contra un folio ya existente.
 *
 * Delega en `registrarCanje`, que es quien tiene la garantía fuerte: lock
 * `FOR UPDATE` sobre la cuenta (dos checkouts simultáneos se serializan y el
 * segundo ve el saldo ya bajado) e idempotencia por el índice único
 * (tenant_id, folio_venta, 'canje') -- un reintento del mismo pedido no
 * vuelve a cobrar puntos.
 *
 * Lanza si el saldo ya no alcanza. El llamador DEBE tratar ese error como
 * "este pedido no puede llevar descuento", nunca ignorarlo: un pedido con
 * descuento y sin movimiento de canje es dinero regalado.
 */
export async function consumirCanjeDeTienda({ negocioId, folio, plan }) {
  if (!plan || !plan.puntos) return null;
  const r = await registrarCanje(folio, plan.telefono, plan.puntos, 'tienda', negocioId);
  // registrarCanje devuelve null cuando el folio YA tenía canje (reintento):
  // eso es éxito idempotente, no un fallo.
  return r || { puntos: plan.puntos, monto: plan.monto, yaEstaba: true };
}

/**
 * Devuelve los puntos de los pedidos que acabaron CANCELADOS y todavía tienen
 * el canje vivo.
 *
 * Por qué hace falta un barrido y no basta el botón de cancelar: un pedido de
 * pago en línea que nadie paga NO lo cancela una persona, lo cancela
 * `vencerEsperaDePago` desde el job de expiración — dentro de una transacción
 * de dinero donde meter Rewards sería mezclar un programa de lealtad con el
 * asiento financiero. Sin este barrido, abandonar el checkout después de
 * elegir "usar mis puntos" se los comía: pedido cancelado y saldo gastado.
 *
 * Cubre además cualquier otro camino de cancelación que olvide (hoy o mañana)
 * llamar al reverso: la condición no es "quién canceló", es "el pedido está
 * cancelado y sus puntos siguen gastados".
 *
 * Idempotente por dos vías: la consulta solo trae folios SIN reverso, y
 * `revertirMovimientosFolio` no duplica un reverso que ya existe. Reejecutarlo
 * cuantas veces sea no mueve un solo punto de más.
 */
export async function reconciliarCanjesDePedidosCancelados(limite = 50) {
  const { pool } = await import('./database.js');
  const { revertirMovimientosFolio } = await import('./rewardsService.js');

  let filas = [];
  try {
    ({ rows: filas } = await pool.query(
      `SELECT p.negocio_id, p.folio
         FROM pedidos_activos p
         JOIN rewards_movements c
           ON c.tenant_id = p.negocio_id::text AND c.folio_venta = p.folio AND c.tipo = 'canje'
        WHERE p.estado = 'cancelado'
          AND p.updated_at > NOW() - INTERVAL '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM rewards_movements r
             WHERE r.tenant_id = c.tenant_id AND r.tipo = 'reverso'
               AND r.metadata->>'movimiento_original_id' = c.id::text)
        LIMIT $1`, [limite]));
  } catch (e) {
    console.error('[Rewards] No se pudo listar canjes de pedidos cancelados:', e.message);
    return 0;
  }

  let devueltos = 0;
  for (const f of filas) {
    try {
      await revertirMovimientosFolio(f.folio, f.negocio_id);
      devueltos++;
      console.log(`[Rewards] Puntos devueltos: el pedido ${f.folio} quedó cancelado`);
    } catch (e) {
      console.error(`[Rewards] No se pudo devolver los puntos de ${f.folio}: ${e.message}`);
    }
  }
  return devueltos;
}
