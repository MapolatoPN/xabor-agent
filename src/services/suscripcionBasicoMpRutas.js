// Suscripción SaaS de Xabor, no pagos de órdenes de comida.
// App sin configuración: no hace cargos ni genera contratos.
import { rateLimitMiddleware } from './rateLimit.js';
import {
  mpSaasHabilitado, validarFirmaWebhookMp,
} from './mercadoPagoSaasCliente.js';
import {
  estadoSuscripcionBasico, iniciarCheckoutBasico,
  conciliarFacturaMercadoPago, conciliarEstadoMercadoPago, conciliarPagoNotificadoMercadoPago, ErrorSuscripcionBasico,
} from './suscripcionBasicoMp.js';

const soloHabilitado = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!mpSaasHabilitado()) return res.status(503).json({
    code: 'SUSCRIPCIONES_NO_DISPONIBLES',
    error: 'La contratación automática estará disponible próximamente.',
  });
  next();
};
const errorSeguro = (res, e) => {
  if (e instanceof ErrorSuscripcionBasico) {
    return res.status(e.status).json({ code: e.code, error: e.message });
  }
  console.error('[saas-mp] Error en operación:', e?.code || e?.name || 'desconocido');
  return res.status(503).json({ error: 'No pudimos completar la operación. Intenta más tarde.' });
};

export function registrarRutasSuscripcionBasicoMp(app, { requireSesionNegocio }) {
  // El middleware de sesión siempre valida rol y tenant real. La excepción
  // de vencimiento solo se aplica a estos endpoints, NO a ventas ni menú.
  app.get('/api/suscripciones-basico/estado',
    requireSesionNegocio('admin'), async (req, res) => {
      try {
        const estado = await estadoSuscripcionBasico(req.negocioId);
        return res.json({ ...estado, cobroDisponible: mpSaasHabilitado() });
      } catch (e) { return errorSeguro(res, e); }
    });

  app.post('/api/suscripciones-basico/checkout',
    soloHabilitado,
    rateLimitMiddleware(req => `mp-saas-checkout:${req.ip}`, 10, 60 * 60_000),
    requireSesionNegocio('admin'),
    async (req, res) => {
      try {
        const checkout = await iniciarCheckoutBasico({
          negocioId: req.negocioId, usuarioId: req.usuarioId,
        });
        return res.json(checkout);
      } catch (e) { return errorSeguro(res, e); }
    });

  // Exclusivo para la aplicación Mercado Pago de Xabor. Nunca aceptar un
  // ID de negocio, monto, estado de pago o autorización desde el webhook.
  app.post('/webhook/xabor-saas-mp',
    soloHabilitado,
    rateLimitMiddleware(req => `mp-saas-webhook:${req.ip}`, 300, 60_000),
    async (req, res) => {
      const dataId = req.query?.['data.id'];
      const requestId = req.headers['x-request-id'];
      const signature = req.headers['x-signature'];
      if (!validarFirmaWebhookMp({
        signature, requestId, dataId,
        secret: process.env.MP_SAAS_WEBHOOK_SECRET,
      })) return res.status(401).end();

      const tipo = req.body?.type;
      // Si viene un identificador en el JSON, debe coincidir con el ID
      // firmado de la URL; nunca se consulta un recurso distinto al firmado.
      if (req.body?.data?.id != null && String(req.body.data.id) !== dataId) {
        return res.status(400).end();
      }
      try {
        if (tipo === 'subscription_authorized_payment') {
          await conciliarFacturaMercadoPago(dataId);
        } else if (tipo === 'subscription_preapproval') {
          await conciliarEstadoMercadoPago(dataId);
        } else if (tipo === 'payment') {
          // Solo pagos del contrato SaaS de Xabor: primero consultar la
          // factura y luego verificar contrato, importe y pago aprobado.
          await conciliarPagoNotificadoMercadoPago(dataId);
        }
        // Ignorar otros tópicos firmados. Esta ruta usa la app de cobros
        // de Xabor, separada de las ventas de los restaurantes.
        return res.status(200).json({ ok: true });
      } catch (e) {
        // MP reintentará y el ledger es idempotente.
        console.error('[saas-mp] No se pudo conciliar webhook:', e?.code || 'desconocido');
        return res.status(503).json({ error: 'Conciliación pendiente' });
      }
    });
}
