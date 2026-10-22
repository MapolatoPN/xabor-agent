// ─── Promociones automáticas en la captura de mostrador ─────────────────────
//
// El POS de envíos (POST /api/pos/pedidos) pasa por el motor y aplica solas
// las promociones del canal «Punto de venta» ('pos'). La captura de mostrador
// (POST /api/pedido-presencial) no lo hacía: el 2x1 dependía de que alguien
// pulsara «🏷️ Aplicar promoción» o lo escribiera como descuento manual.
// XAB-2094 (Obispado, 21-oct-2026) se cobró en $1,550 sin el «Miércoles de
// Chilaquiles» que le tocaba (−$390).
//
// Aquí se calcula, con el MISMO motor y el MISMO canal 'pos', lo que el
// mostrador descuenta al dar de alta. Reglas:
//   · Nunca impide crear el pedido: si el motor falla o la bandera está
//     apagada, el pedido nace sin promoción, como antes.
//   · Sin cliente identificado (sin teléfono de Rewards) no se aplican solas
//     las promociones de primera compra ni las de límite por cliente.
//   · Bandera por negocio `mostrador_promos_automaticas` en `configuracion`:
//     encendida salvo que valga 'false'.
// El cobro (PATCH /pedidos/:folio/cobro) ya respeta `datos.promociones`, igual
// que con «Aplicar promoción»: el descuento manual y el canje de Rewards
// siguen decidiéndose allí.
import { pool } from './database.js';
import { calcularPromociones, registrarUsoPromocionSimple, zonaDePromos } from './tiendaPromociones.js';
import { redondear } from './descuentos.js';

export const BANDERA_PROMOS_MOSTRADOR = 'mostrador_promos_automaticas';

// Si la configuración no se puede leer, el mostrador sigue como antes.
export async function mostradorAplicaPromos(negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2 LIMIT 1`,
      [negocioId, BANDERA_PROMOS_MOSTRADOR]);
    return String(rows[0]?.valor ?? '').trim().toLowerCase() !== 'false';
  } catch (e) {
    console.error(`[Mostrador] No se leyó ${BANDERA_PROMOS_MOSTRADOR} (negocio=${negocioId}): ${e.message}`);
    return false;
  }
}

// Mismo snapshot que guarda el POS de envíos, para que cobro, Caja y ticket
// lean un solo formato.
export function snapshotPromocionMostrador(a) {
  return {
    id: a.id, campaniaId: a.campaniaId || null,
    nombre: a.nombre, tipo: a.tipo, valor: a.valor,
    base_calculo: a.baseCalculo, descuento: a.descuento,
    envio_gratis: false, automatica: a.automatica,
    unidades: a.unidadesBeneficiadas || 0,
    acumulable: a.acumulable, prioridad: a.prioridad, codigo: a.codigo || null,
  };
}

/**
 * Promociones automáticas que le tocan a un pedido de mostrador.
 * `oportunidades` (las del motor: «falta 1 para el 2x1») solo las usa la vista
 * previa del carrito (promoCarritoPOS.js); el alta las ignora.
 * @returns {{ descuento: number, promociones: object[], oportunidades: object[] }}
 */
export async function promocionesParaMostrador({
  negocioId, items = [], subtotal = 0, telefono = null, ahora = new Date(),
  calcular = calcularPromociones,
} = {}) {
  const sinPromo = { descuento: 0, promociones: [], oportunidades: [] };
  if (!(await mostradorAplicaPromos(negocioId))) return sinPromo;
  try {
    const tel = String(telefono || '').trim() || null;
    const r = await calcular({
      negocioId, subtotal, items, costoEnvio: 0, modalidad: 'recoger',
      canal: 'pos', telefono: tel, timezone: await zonaDePromos(negocioId), ahora,
      sinClienteIdentificado: !tel,
    });
    const promociones = (r?.aplicadas || [])
      .filter(a => a && a.envioGratis !== true && Number(a.descuento) > 0)
      .map(snapshotPromocionMostrador);
    const suma = redondear(promociones.reduce((s, p) => s + Number(p.descuento), 0));
    return {
      descuento: Math.max(0, Math.min(redondear(subtotal), suma)), promociones,
      oportunidades: Array.isArray(r?.oportunidades) ? r.oportunidades : [],
    };
  } catch (e) {
    console.error(`[Mostrador] El motor de promociones falló (negocio=${negocioId}): ${e.message} — el pedido sale sin promoción`);
    return sinPromo;
  }
}

// El total que ya se calculaba, menos la promoción. Sin promoción devuelve el
// MISMO valor de siempre (ni siquiera lo convierte a número).
export function totalConPromoMostrador(total, descuentoPromo) {
  if (!(descuentoPromo > 0)) return total;
  return Math.max(0, redondear(Number(total) - descuentoPromo));
}

// Métricas de la promoción, como «Aplicar promoción». Nunca truena: el pedido
// ya existe y su descuento no depende de esto.
export function registrarUsoPromosMostrador({ negocioId, folio, promociones = [], telefono = null, montoVenta = 0 }) {
  if (!promociones.length) return Promise.resolve({ registrados: 0 });
  return registrarUsoPromocionSimple({
    negocioId, folio, telefono, montoVenta, canal: 'presencial',
    aplicadas: promociones.map(p => ({ id: p.id, descuento: p.descuento })),
  }).catch(e => {
    console.error(`[Mostrador] No se registró el uso de promociones de ${folio}: ${e.message}`);
    return { registrados: 0 };
  });
}
