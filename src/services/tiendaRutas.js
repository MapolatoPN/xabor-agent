// ─── Rutas de la Tienda Online ────────────────────────────────────────────
//
// Se montan desde server.js con una línea. Dos superficies muy distintas:
//
//   PÚBLICAS (/t/:slug, /api/tienda/*, /seguimiento/*): sin sesión, con rate
//   limit, y con el negocio resuelto SIEMPRE desde el slug de la URL. Nunca
//   se acepta un negocio_id del cliente.
//
//   BACKOFFICE (/api/admin/tienda/*): sesión + módulo tienda_online, y el
//   negocio sale de req.negocioId (sesión), como todo el resto del panel.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rateLimitMiddleware } from './rateLimit.js';
import {
  resolverTienda, TiendaError, catalogoPublico, reglasDelNegocio, estadoApertura,
  metodosPagoTienda, obtenerConfigTienda, guardarConfigTienda, checklistPublicacion,
  cambiarEstadoTienda, listarProductosPublicables, publicarProductos, actualizarProductoTienda,
} from './tiendaOnline.js';
import {
  cotizarCarrito, crearPedidoTienda, seguimientoPublico,
} from './tiendaCheckout.js';
import {
  listarPromociones, guardarPromocion, eliminarPromocion, listarCampanas,
  guardarCampana, pistaEnvioGratis, PromocionError,
} from './tiendaPromociones.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '../../panel');

// Traduce cualquier error del dominio a una respuesta segura: mensaje para el
// cliente, código para la UI y NUNCA un stack ni detalle interno.
function responderError(res, e, contexto) {
  if (e instanceof TiendaError || e instanceof PromocionError) {
    return res.status(e.status || 400).json({ error: e.message, codigo: e.codigo });
  }
  console.error(`[Tienda] ${contexto}:`, e?.message || e);
  return res.status(500).json({ error: 'No se pudo completar la operación' });
}

export function registrarRutasTienda(app, { requireAuthSeguro, requireModulo }) {
  // ══════════════════ SUPERFICIE PÚBLICA ══════════════════
  // Rate limit por IP: la tienda es pública y hay que protegerla de scraping
  // de catálogo, fuerza bruta de cupones y avalanchas de checkout.
  // Los topes son configurables porque una IP no siempre es una persona:
  // varios clientes detrás del NAT del operador móvil, o de la wifi de una
  // plaza, comparten IP. Los valores por omisión protegen sin estorbar; si un
  // negocio real choca con ellos, se suben sin tocar código.
  const tope = (env, omision) => {
    const n = parseInt(process.env[env], 10);
    return Number.isFinite(n) && n > 0 ? n : omision;
  };
  const limitePublico = rateLimitMiddleware(req => `tienda:${req.ip}`,
    tope('XABOR_TIENDA_LIMITE_LECTURA', 120), 60 * 1000);
  const limiteCheckout = rateLimitMiddleware(req => `tienda-checkout:${req.ip}`,
    tope('XABOR_TIENDA_LIMITE_CHECKOUT', 20), 60 * 1000);
  const limiteCupon = rateLimitMiddleware(req => `tienda-cupon:${req.ip}`,
    tope('XABOR_TIENDA_LIMITE_COTIZAR', 60), 60 * 1000);

  // La página de la tienda: una sola plantilla para TODOS los negocios. El
  // slug no entra al HTML; el cliente lo lee de su propia URL y pide los
  // datos por API. Así no hay HTML por negocio ni riesgo de inyección.
  app.get('/t/:slug', limitePublico, (req, res) => {
    res.sendFile(join(PANEL_DIR, 'tienda.html'));
  });
  app.get('/seguimiento/:token', limitePublico, (req, res) => {
    res.sendFile(join(PANEL_DIR, 'tienda-seguimiento.html'));
  });

  // Datos de la tienda: identidad, estado de apertura, modalidades y reglas
  // que el cliente necesita para comprar.
  app.get('/api/tienda/:slug', limitePublico, async (req, res) => {
    try {
      const tienda = await resolverTienda(req.params.slug);
      const reglas = await reglasDelNegocio(tienda.negocioId);
      const apertura = estadoApertura(reglas);
      res.json({
        slug: tienda.slug,
        negocio: tienda.branding.titular,
        descripcion: tienda.branding.descripcion,
        logo: tienda.branding.logo,
        portada: tienda.branding.portada,
        color: tienda.branding.color,
        bienvenida: tienda.branding.bienvenida,
        apertura,
        modalidades: tienda.modalidades,
        aceptaProgramados: tienda.aceptaProgramados,
        anticipacionMinutos: tienda.anticipacionMinutos,
        entrega: {
          costoBase: reglas.costoEnvioBase,
          pedidoMinimo: reglas.pedidoMinimo,
          entregaGratisDesde: reglas.entregaGratisDesde,
          zonas: (reglas.zonas || []).map(z => ({ nombre: z.nombre, costo: Number(z.costo) || 0 })),
          tiempo: `${reglas.entregaMin}-${reglas.entregaMax} min`,
        },
        preparacionMinutos: reglas.preparacionMinutos,
      });
    } catch (e) { responderError(res, e, 'GET /api/tienda/:slug'); }
  });

  app.get('/api/tienda/:slug/catalogo', limitePublico, async (req, res) => {
    try {
      const tienda = await resolverTienda(req.params.slug);
      res.json({ categorias: await catalogoPublico(tienda.negocioId) });
    } catch (e) { responderError(res, e, 'GET catalogo'); }
  });

  app.get('/api/tienda/:slug/pagos', limitePublico, async (req, res) => {
    try {
      const tienda = await resolverTienda(req.params.slug);
      const modalidad = String(req.query.modalidad || 'recoger');
      res.json({ metodos: await metodosPagoTienda(tienda.negocioId, modalidad) });
    } catch (e) { responderError(res, e, 'GET pagos'); }
  });

  // Cotización en vivo del carrito: mismos cálculos que el checkout.
  app.post('/api/tienda/:slug/cotizar', limiteCupon, async (req, res) => {
    try {
      const tienda = await resolverTienda(req.params.slug);
      const { items, modalidad, zona, codigo, telefono } = req.body || {};
      const cotizacion = await cotizarCarrito({ tienda, items, modalidad, zona, codigo, telefono });
      const pista = await pistaEnvioGratis({
        negocioId: tienda.negocioId, subtotal: cotizacion.subtotal, modalidad: cotizacion.modalidad,
      });
      res.json({ ...cotizacion, pistaEnvioGratis: pista });
    } catch (e) { responderError(res, e, 'POST cotizar'); }
  });

  app.post('/api/tienda/:slug/checkout', limiteCheckout, async (req, res) => {
    try {
      const tienda = await resolverTienda(req.params.slug);
      const r = await crearPedidoTienda({ tienda, ...(req.body || {}) });
      res.json({ ok: true, ...r });
    } catch (e) { responderError(res, e, 'POST checkout'); }
  });

  app.get('/api/tienda/seguimiento/:token', limitePublico, async (req, res) => {
    try {
      res.json(await seguimientoPublico(req.params.token));
    } catch (e) { responderError(res, e, 'GET seguimiento'); }
  });

  // ══════════════════ BACKOFFICE (sesión + módulo) ══════════════════
  const gate = [requireAuthSeguro, requireModulo('tienda_online')];

  app.get('/api/admin/tienda', ...gate, async (req, res) => {
    try {
      const [config, checklist] = await Promise.all([
        obtenerConfigTienda(req.negocioId),
        checklistPublicacion(req.negocioId),
      ]);
      res.json({ config, checklist });
    } catch (e) { responderError(res, e, 'GET admin tienda'); }
  });

  app.put('/api/admin/tienda', ...gate, async (req, res) => {
    try {
      res.json({ ok: true, config: await guardarConfigTienda(req.negocioId, req.body || {}) });
    } catch (e) { responderError(res, e, 'PUT admin tienda'); }
  });

  app.post('/api/admin/tienda/estado', ...gate, async (req, res) => {
    try {
      const config = await cambiarEstadoTienda(req.negocioId, String(req.body?.estado || ''));
      console.log(`[Tienda] negocio=${req.negocioId} estado=${config.estado} por usuario=${req.usuarioId}`);
      res.json({ ok: true, config });
    } catch (e) { responderError(res, e, 'POST estado tienda'); }
  });

  app.get('/api/admin/tienda/productos', ...gate, async (req, res) => {
    try {
      res.json({ productos: await listarProductosPublicables(req.negocioId) });
    } catch (e) { responderError(res, e, 'GET productos tienda'); }
  });

  app.post('/api/admin/tienda/productos/publicar', ...gate, async (req, res) => {
    try {
      const r = await publicarProductos(req.negocioId, req.body?.productoIds, req.body?.publicado);
      res.json({ ok: true, ...r });
    } catch (e) { responderError(res, e, 'POST publicar productos'); }
  });

  app.put('/api/admin/tienda/productos/:id', ...gate, async (req, res) => {
    try {
      res.json(await actualizarProductoTienda(req.negocioId, req.params.id, req.body || {}));
    } catch (e) { responderError(res, e, 'PUT producto tienda'); }
  });

  // ── Promociones y campañas ──
  app.get('/api/admin/tienda/promociones', ...gate, async (req, res) => {
    try {
      const [promociones, campanas] = await Promise.all([
        listarPromociones(req.negocioId), listarCampanas(req.negocioId),
      ]);
      res.json({ promociones, campanas });
    } catch (e) { responderError(res, e, 'GET promociones'); }
  });

  app.post('/api/admin/tienda/promociones', ...gate, async (req, res) => {
    try {
      res.json({ ok: true, ...(await guardarPromocion(req.negocioId, req.body || {})) });
    } catch (e) { responderError(res, e, 'POST promocion'); }
  });

  app.put('/api/admin/tienda/promociones/:id', ...gate, async (req, res) => {
    try {
      res.json({ ok: true, ...(await guardarPromocion(req.negocioId, req.body || {}, req.params.id)) });
    } catch (e) { responderError(res, e, 'PUT promocion'); }
  });

  app.delete('/api/admin/tienda/promociones/:id', ...gate, async (req, res) => {
    try {
      const ok = await eliminarPromocion(req.negocioId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Promoción no encontrada' });
      res.json({ ok: true });
    } catch (e) { responderError(res, e, 'DELETE promocion'); }
  });

  app.post('/api/admin/tienda/campanas', ...gate, async (req, res) => {
    try {
      res.json({ ok: true, ...(await guardarCampana(req.negocioId, req.body || {})) });
    } catch (e) { responderError(res, e, 'POST campana'); }
  });

  app.put('/api/admin/tienda/campanas/:id', ...gate, async (req, res) => {
    try {
      res.json({ ok: true, ...(await guardarCampana(req.negocioId, req.body || {}, req.params.id)) });
    } catch (e) { responderError(res, e, 'PUT campana'); }
  });

  // ── Métricas de la tienda ──
  // Solo lo que se puede calcular con datos reales: ventas por canal,
  // reparto recoger/domicilio, ticket promedio y desempeño de promociones.
  app.get('/api/admin/tienda/metricas', ...gate, async (req, res) => {
    try {
      const { pool } = await import('./database.js');
      const desde = req.query.desde || new Date(Date.now() - 30 * 86400000).toISOString();
      const hasta = req.query.hasta || new Date().toISOString();
      const { rows: [v] } = await pool.query(
        `SELECT COUNT(*)::int AS pedidos,
                COALESCE(SUM((datos->>'total')::decimal), 0)::float AS ventas,
                COALESCE(AVG((datos->>'total')::decimal), 0)::float AS ticket,
                COUNT(*) FILTER (WHERE datos->>'modalidad' ILIKE '%domicilio%')::int AS domicilio,
                COUNT(*) FILTER (WHERE datos->>'modalidad' ILIKE '%recoger%')::int AS recoger
           FROM pedidos_activos
          WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'
            AND estado <> 'cancelado' AND created_at BETWEEN $2 AND $3`,
        [req.negocioId, desde, hasta]);
      const [promociones, campanas] = await Promise.all([
        listarPromociones(req.negocioId), listarCampanas(req.negocioId),
      ]);
      res.json({
        periodo: { desde, hasta },
        pedidos: v.pedidos, ventas: v.ventas, ticketPromedio: v.ticket,
        porModalidad: { domicilio: v.domicilio, recoger: v.recoger },
        promociones: promociones.filter(p => p.metricas.usos > 0)
          .sort((a, b) => b.metricas.ventas - a.metricas.ventas),
        campanas: campanas.filter(c => c.metricas.usos > 0)
          .sort((a, b) => b.metricas.ventas - a.metricas.ventas),
      });
    } catch (e) { responderError(res, e, 'GET metricas tienda'); }
  });
}
