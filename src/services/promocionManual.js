// ─── Aplicar una promoción a un pedido YA TOMADO ────────────────────────────
//
// El motor aplica las promociones automáticas al capturar (POS, WhatsApp,
// tienda). Dos huecos dejaban sin salida al mostrador:
//   · la captura presencial nunca pasa por el motor, así que un 2x1 solo se
//     podía dar como «descuento manual» con motivo escrito a mano (XAB-1007);
//   · un pedido que entró sin la promoción (el 30-sep, por la vigencia mal
//     guardada: XAB-1011) no tenía forma de recibirla después.
//
// Aquí la persona ELIGE la promoción, pero el importe lo sigue decidiendo el
// servidor con las reglas de la promoción (productos, modificadores, mínimo,
// cupo): nunca se escribe un monto a mano. Fuera de su horario o vigencia
// solo la aplica un administrador, con motivo.
import { pool } from './database.js';
import { evaluarPromocionSobrePedido, registrarUsoPromocionSimple, zonaDePromos } from './tiendaPromociones.js';
import { construirDesgloseDescuentos, redondear } from './descuentos.js';

export class PromocionManualError extends Error {
  constructor(mensaje, codigo, status = 400) { super(mensaje); this.codigo = codigo; this.status = status; }
}

const CANALES_ADMITIDOS = new Set(['pos', 'presencial', 'whatsapp']);

// ¿Este pedido puede recibir una promoción ahora? null = sí; si no, el motivo.
export function motivoPedidoNoAdmite(estado, datos = {}) {
  if (estado === 'cancelado') return 'El pedido está cancelado';
  if (estado === 'entregado') return 'El pedido ya se entregó: usa una devolución';
  if (datos.pago_confirmado === true) return 'El pedido ya está cobrado: usa una devolución';
  if (!CANALES_ADMITIDOS.has(String(datos.canal || ''))) return 'Este tipo de pedido no admite promociones manuales';
  // Un enlace de pago ya se generó por el total anterior: bajarlo aquí dejaría
  // al cliente pagando de más por un enlace que no se entera del cambio.
  if (/enlace/i.test(String(datos.forma_pago || ''))) return 'El pedido tiene un enlace de pago por el total anterior';
  return null;
}

function itemsDe(datos) {
  return Array.isArray(datos?.items) ? datos.items : [];
}

// Subtotal real, igual que el cobro: de los items persistidos.
function subtotalDe(datos) {
  return redondear(itemsDe(datos).reduce((s, i) =>
    s + (parseFloat(i.precio_unitario) || 0) * Math.max(1, parseInt(i.cantidad, 10) || 1), 0));
}

function modalidadDe(datos) {
  return String(datos?.modalidad || '').toLowerCase().includes('domicilio') ? 'domicilio' : 'recoger';
}

async function promocionesDelNegocio(db, negocioId, promocionId = null) {
  const { rows } = await db.query(
    `SELECT * FROM tienda_promociones
      WHERE negocio_id = $1 AND activa = TRUE AND tipo <> 'envio_gratis'
        AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY prioridad ASC, created_at ASC`,
    [negocioId, promocionId]);
  return rows;
}

/**
 * Lo que el panel muestra al abrir «Aplicar promoción»: cada promoción activa
 * con el descuento que le daría a ESTE pedido, o por qué no aplica.
 */
export async function listarPromocionesParaPedido(negocioId, folio, { ahora = new Date() } = {}) {
  const { rows: [fila] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`,
    [folio, negocioId]);
  if (!fila) throw new PromocionManualError('Pedido no encontrado', 'PEDIDO_NO_ENCONTRADO', 404);
  const datos = fila.datos || {};
  const timezone = await zonaDePromos(negocioId);
  const yaAplicadas = new Set((Array.isArray(datos.promociones) ? datos.promociones : []).map(p => String(p.id)));
  const subtotal = subtotalDe(datos);
  const promos = await promocionesDelNegocio(pool, negocioId);
  return {
    pedido: {
      folio, subtotal,
      descuento: redondear(datos.descuento),
      total: redondear(datos.total),
      motivoNoAdmite: motivoPedidoNoAdmite(fila.estado, datos),
    },
    promociones: promos.map(p => {
      const ev = evaluarPromocionSobrePedido(p, {
        items: itemsDe(datos), subtotal, modalidad: modalidadDe(datos), timezone, ahora,
      });
      return {
        id: p.id, nombre: p.nombre, tipo: p.tipo,
        descuento: ev.aplicada ? ev.aplicada.descuento : 0,
        motivo: yaAplicadas.has(String(p.id)) ? 'Ya está aplicada a este pedido' : ev.motivo,
        motivoHorario: ev.motivoHorario,
      };
    }),
  };
}

/**
 * Aplica UNA promoción a un pedido abierto. Transaccional: el pedido se
 * bloquea mientras se decide, así dos clics no la aplican dos veces.
 *
 * @returns {{ folio, promocion, descuento, total, cambios }}
 */
export async function aplicarPromocionManual(negocioId, folio, {
  promocionId, motivo = '', rol = 'staff', usuarioId = null, ahora = new Date(),
} = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new PromocionManualError('Sesión inválida', 'SIN_NEGOCIO', 401);
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(promocionId || ''))) {
    throw new PromocionManualError('Elige una promoción', 'PROMOCION_REQUERIDA');
  }
  const motivoLimpio = String(motivo || '').trim().slice(0, 200);
  const timezone = await zonaDePromos(negocioId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [fila] } = await client.query(
      `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, negocioId]);
    if (!fila) throw new PromocionManualError('Pedido no encontrado', 'PEDIDO_NO_ENCONTRADO', 404);
    const datos = fila.datos || {};
    const noAdmite = motivoPedidoNoAdmite(fila.estado, datos);
    if (noAdmite) throw new PromocionManualError(noAdmite, 'PEDIDO_NO_ADMITE', 409);

    const previas = Array.isArray(datos.promociones) ? datos.promociones : [];
    if (previas.some(p => String(p.id) === String(promocionId))) {
      throw new PromocionManualError('Esa promoción ya está aplicada a este pedido', 'YA_APLICADA', 409);
    }

    const [promo] = await promocionesDelNegocio(client, negocioId, promocionId);
    if (!promo) throw new PromocionManualError('Promoción no encontrada o inactiva', 'PROMOCION_NO_ENCONTRADA', 404);

    const subtotal = subtotalDe(datos);
    const ev = evaluarPromocionSobrePedido(promo, {
      items: itemsDe(datos), subtotal, modalidad: modalidadDe(datos), timezone, ahora,
    });
    if (!ev.aplicada) throw new PromocionManualError(ev.motivo, 'NO_APLICA');
    if (ev.motivoHorario) {
      if (rol !== 'admin') {
        throw new PromocionManualError(
          `${ev.motivoHorario}. Solo un administrador puede aplicarla fuera de su horario.`,
          'FUERA_DE_HORARIO', 403);
      }
      if (!motivoLimpio) {
        throw new PromocionManualError('Escribe por qué se aplica fuera de su horario', 'MOTIVO_REQUERIDO');
      }
    }

    // Nunca más descuento que lo que queda del subtotal.
    const descuentoPrevio = redondear(datos.descuento);
    const descuento = redondear(Math.min(ev.aplicada.descuento, Math.max(0, subtotal - descuentoPrevio)));
    if (!(descuento > 0)) throw new PromocionManualError('El pedido ya no tiene importe que descontar', 'SIN_MARGEN');

    const snapshot = {
      id: ev.aplicada.id, campaniaId: ev.aplicada.campaniaId,
      nombre: ev.aplicada.nombre, tipo: ev.aplicada.tipo, valor: ev.aplicada.valor,
      base_calculo: ev.aplicada.baseCalculo, descuento,
      envio_gratis: false, automatica: ev.aplicada.automatica,
      unidades: ev.aplicada.unidadesBeneficiadas,
      acumulable: ev.aplicada.acumulable, prioridad: ev.aplicada.prioridad,
      codigo: ev.aplicada.codigo,
      // Quién, cuándo y por qué: la huella de que no la puso el motor.
      manual: true,
      aplicada_por: usuarioId,
      aplicada_at: ahora.toISOString(),
      fuera_de_horario: !!ev.motivoHorario,
      motivo: motivoLimpio || null,
    };
    const promociones = [...previas, snapshot];
    const totalPrevio = datos.total != null ? Number(datos.total) : subtotal;
    const cambios = {
      promociones,
      descuento: redondear(descuentoPrevio + descuento),
      total: Math.max(0, redondear(totalPrevio - descuento)),
      descuentos: construirDesgloseDescuentos({
        manual: datos.descuentos?.manual || null,
        promociones,
        rewards: datos.descuentos?.rewards || null,
      }),
    };
    await client.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb, updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2`,
      [folio, negocioId, JSON.stringify(cambios)]);
    await client.query('COMMIT');

    // Métricas de la promoción. Fuera de la transacción a propósito: si esto
    // falla, el descuento ya aplicado al pedido no se deshace.
    registrarUsoPromocionSimple({
      negocioId, folio, aplicadas: [{ id: promo.id, descuento }],
      telefono: datos.cliente?.telefono || null,
      montoVenta: cambios.total, canal: datos.canal || null,
    }).catch(e => console.error(`[Promo manual] No se registró el uso de ${promo.id} en ${folio}:`, e.message));

    console.log(`[Promo manual] ${folio}: «${promo.nombre}» -$${descuento} usuario=${usuarioId || '-'} rol=${rol}`
      + (ev.motivoHorario ? ` FUERA DE HORARIO (${motivoLimpio})` : ''));
    return { folio, promocion: { id: promo.id, nombre: promo.nombre }, descuento, total: cambios.total, cambios };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
