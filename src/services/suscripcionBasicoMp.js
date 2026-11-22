// Estado de suscripción y acreditación de pagos de Xabor, NUNCA de pedidos.
// La cuenta de Mercado Pago pertenece a Xabor: un negocio no proporciona
// credenciales ni IDs de suscripción mediante body/query.
import { pool } from './database.js';
import {
  crearPreapprovalBasico, obtenerPreapprovalBasico, obtenerFacturaMpSaas,
  obtenerPagoMpSaas, validarCobroSaas, enlaceMPValido, PRECIO_SAAS_MXN,
} from './mercadoPagoSaasCliente.js';

export class ErrorSuscripcionBasico extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'ErrorSuscripcionBasico';
    this.code = code; this.status = status;
  }
}

// Consulta sin confiar en un negocioId enviado por el navegador:
// lo proporciona el middleware de sesión, que verificó su membresía.
export async function estadoSuscripcionBasico(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT s.used_at + INTERVAL '7 days' AS prueba_hasta,
            pc.estado AS estado_comercial, pc.proxima_fecha_pago,
            mp.estado_mp, mp.checkout_url
       FROM solicitudes_registro_basico s
       JOIN negocio_plan_comercial pc ON pc.negocio_id = s.negocio_id
       LEFT JOIN suscripciones_basico_mp mp ON mp.negocio_id = s.negocio_id
      WHERE s.negocio_id = $1 AND s.used_at IS NOT NULL`,
    [negocioId]);
  if (!r) throw new ErrorSuscripcionBasico('NO_AUTOSERVICIO', 'Este negocio no usa esta suscripción', 404);
  return {
    plan: 'basico', montoMensual: PRECIO_SAAS_MXN, moneda: 'MXN',
    estado: r.estado_comercial,
    pruebaHasta: r.prueba_hasta, proximaFechaPago: r.proxima_fecha_pago,
    estadoMercadoPago: r.estado_mp ?? 'sin_suscripcion',
    checkoutUrl: enlaceMPValido(r.checkout_url) ? r.checkout_url : null,
  };
}

export async function iniciarCheckoutBasico({ negocioId, usuarioId, crear = crearPreapprovalBasico }) {
  // Solo permitir si el usuario autenticado es administrador de este negocio
  // *y* proviene del registro autoservicio. La ruta ya verifica rol admin.
  const { rows: [r] } = await pool.query(
    `SELECT s.used_at + INTERVAL '7 days' AS prueba_hasta,
            u.email
       FROM solicitudes_registro_basico s
       JOIN usuarios u ON u.id = $2 AND u.negocio_id = s.negocio_id
      WHERE s.negocio_id = $1 AND s.used_at IS NOT NULL`,
    [negocioId, usuarioId]);
  if (!r) throw new ErrorSuscripcionBasico('NO_AUTOSERVICIO', 'Esta cuenta no puede contratar este plan', 404);

  // Reserva única: dos pestañas o múltiples réplicas NO generan dos contratos.
  const { rows: reservada } = await pool.query(
    `INSERT INTO suscripciones_basico_mp (negocio_id, external_reference, estado_mp)
      VALUES ($1, 'xabor-basico:' || $1::text, 'creando')
      ON CONFLICT (negocio_id) DO NOTHING
      RETURNING negocio_id, external_reference, estado_mp, checkout_url`,
    [negocioId]);
  if (!reservada.length) {
    const { rows: [actual] } = await pool.query(
      'SELECT estado_mp, checkout_url FROM suscripciones_basico_mp WHERE negocio_id = $1',
      [negocioId]);
    if (actual?.checkout_url && enlaceMPValido(actual.checkout_url) &&
        !['canceled','cancelled'].includes(actual.estado_mp)) {
      return { checkoutUrl: actual.checkout_url, existente: true };
    }
    // No reintentamos a ciegas: una solicitud HTTP incierta pudo crear el
    // contrato remoto aunque la respuesta se perdiera.
    throw new ErrorSuscripcionBasico('CONTRATO_EN_REVISION',
      'La suscripción está en preparación o necesita revisión. Contacta a soporte.', 409);
  }

  const fechaPrueba = new Date(r.prueba_hasta).getTime();
  const inicioCobro = new Date(Math.max(fechaPrueba, Date.now() + 2 * 60_000));
  const backUrl = process.env.PUBLIC_URL || 'https://xabor.mx';
  const resultado = await crear({
    negocioId, email: r.email, inicioCobro, baseUrl: backUrl,
    // Enviar clave estable también al proveedor, sin presuponer que este
    // endpoint aplique idempotencia: la barrera real es la reserva local.
    idempotencyKey: negocioId,
  });

  await pool.query(
    `UPDATE suscripciones_basico_mp SET
       preapproval_id = $2, checkout_url = $3, estado_mp = $4, actualizado_at = NOW()
      WHERE negocio_id = $1 AND preapproval_id IS NULL`,
    [negocioId, resultado.id, resultado.checkoutUrl,
     ['pending','authorized'].includes(resultado.estado) ? resultado.estado : 'pending']);
  return { checkoutUrl: resultado.checkoutUrl, existente: false };
}

// La notificación NO acredita por sí misma. Se consulta el recurso remoto,
// luego la operación de pago; únicamente si ambas verificaciones coinciden
// con la suscripción local y con $150 MXN se escribe el ledger.
export async function conciliarFacturaMercadoPago(idFactura, {
  obtenerFactura = obtenerFacturaMpSaas,
  obtenerPago = obtenerPagoMpSaas,
  obtenerPreapproval = obtenerPreapprovalBasico,
} = {}) {
  const factura = await obtenerFactura(idFactura);
  const preapprovalId = String(factura?.preapproval_id ?? '');
  if (!preapprovalId || !factura?.payment?.id) return { aplicado: false, motivo: 'sin_pago' };
  const { rows: [local] } = await pool.query(
    `SELECT negocio_id, external_reference
       FROM suscripciones_basico_mp WHERE preapproval_id = $1`,
    [preapprovalId]);
  if (!local) return { aplicado: false, motivo: 'no_corresponde_a_xabor' };

  const [contrato, pago] = await Promise.all([
    obtenerPreapproval(preapprovalId),
    obtenerPago(factura.payment.id),
  ]);
  if (String(contrato?.id) !== preapprovalId ||
      contrato?.external_reference !== local.external_reference ||
      !validarCobroSaas({ factura, pago, preapprovalId })) {
    return { aplicado: false, motivo: 'cobro_no_verificado' };
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [insertado] } = await cliente.query(
      `INSERT INTO pagos_suscripcion_basico_mp
          (negocio_id, preapproval_id, authorized_payment_id, payment_id, monto, moneda, aprobado_at)
       VALUES ($1,$2,$3,$4,150,'MXN',$5)
       ON CONFLICT (authorized_payment_id) DO NOTHING RETURNING id`,
      [local.negocio_id, preapprovalId, String(factura.id), String(pago.id), pago.date_approved]);
    if (!insertado) {
      await cliente.query('COMMIT');
      return { aplicado: false, motivo: 'ya_acreditado' };
    }
    // Solo un cobro certificado aumenta el periodo pagado; las altas
    // autorizadas sin dinero no alteran estado comercial.
    await cliente.query(
      `UPDATE negocio_plan_comercial
       SET estado = 'activo',
           proxima_fecha_pago = (GREATEST(CURRENT_DATE,
             COALESCE(proxima_fecha_pago, CURRENT_DATE)) + INTERVAL '1 month')::date,
           updated_at = NOW()
       WHERE negocio_id = $1 AND plan = 'basico'`,
      [local.negocio_id]);
    await cliente.query('COMMIT');
    return { aplicado: true };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}

// Cambios del contrato sirven para mostrar el estado, nunca para acreditar
// dinero. "authorized" es una autorización, NO un pago.
export async function conciliarEstadoMercadoPago(id, {
  obtenerPreapproval = obtenerPreapprovalBasico,
} = {}) {
  const remote = await obtenerPreapproval(id);
  const { rows: [local] } = await pool.query(
    'SELECT negocio_id, external_reference FROM suscripciones_basico_mp WHERE preapproval_id = $1',
    [String(remote?.id || '')]);
  if (!local || remote.external_reference !== local.external_reference) {
    return { actualizado: false };
  }
  const estado = ['pending','authorized','paused','cancelled','canceled'].includes(remote.status)
    ? remote.status : 'error';
  await pool.query(
    `UPDATE suscripciones_basico_mp
       SET estado_mp = $2, ultima_consulta_at = NOW(), actualizado_at = NOW()
       WHERE negocio_id = $1`,
    [local.negocio_id, estado]);
  return { actualizado: true };
}
