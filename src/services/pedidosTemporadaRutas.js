// ─── Rutas de los pedidos de temporada ─────────────────────────────────────
//
// Se montan desde server.js con una línea, como tiendaRutas.js y
// personalRutas.js. Dos superficies:
//
//   PÚBLICA (/api/temporada/:clave y …/pedidos): sin sesión ni cookies. La
//   llama la página del sitio del negocio (p. ej. www.mapolato.com/thanksgiving),
//   que vive en OTRO dominio: por eso responde CORS, pero SOLO a los orígenes
//   de TEMPORADA_ORIGENES. El negocio sale siempre de la clave de la URL;
//   nunca se acepta un negocio_id del cliente. Con rate limit por IP.
//
//   ADMINISTRACIÓN (/temporada y /api/admin/temporada/*): administrador con
//   sesión real (requireAdminModerno). El negocio es el de la sesión, salvo
//   que el recurso (campaña, pedido o pago) sea de otra sucursal que el mismo
//   usuario también administra: entonces se atiende con la de ese recurso.
//   Lo decide negocioDeRecursoTemporada leyendo la base, nunca la página.
//
//   LECTURA (20-nov-2026, decisión de Mario): las tres rutas que solo leen la
//   lista (campañas, una campaña, el día junto) aceptan cualquier sesión real
//   del panel (requireSesionModerna): la encargada (staff) ve e imprime. Lo que
//   ve cada sesión, y qué va en solo lectura, lo decide alcanceTemporada.
//   Todo lo que escribe sigue con requireAdminModerno.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rateLimitMiddleware } from './rateLimit.js';
import { crearLimiteAltas } from './limiteAltas.js';
import {
  TemporadaError, campanaPublica, crearPedidoTemporada, listarCampanas, guardarCampana,
  cancelarPedidoTemporada, registrarPagoTemporada, anularPagoTemporada,
  cambiarEntregaTemporada, crearPedidoPanel, editarPedidoTemporada, historialPedidoTemporada,
  anotarWhatsAppTemporada, restaurarPedidoTemporada, negocioDeRecursoTemporada, listarCampanasAdmin, pedidosJuntos,
  verCampanaTemporada, fijarPreparacionTemporada,
} from './pedidosTemporada.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '../../panel');

const ORIGENES_OMISION = 'https://www.mapolato.com,https://mapolato.com';

/** Orígenes que pueden llamar la API pública desde el navegador. */
export function origenesPermitidos(valor = process.env.TEMPORADA_ORIGENES) {
  const lista = String(valor ?? ORIGENES_OMISION).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return new Set(lista.filter((o) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)));
}

const manejar = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof TemporadaError) {
      return res.status(e.http || 400).json({ ...(e.extra || {}), error: e.message, codigo: e.codigo });
    }
    console.error(`[Temporada] ${req.method} ${req.path}: ${e.message}`);
    res.status(500).json({ error: 'No se pudo completar la operación' });
  }
};

export function registrarRutasTemporada(app, { requireAdminModerno, requireSesionModerna, notificar = null }) {
  if (typeof requireAdminModerno !== 'function') {
    throw new Error('registrarRutasTemporada necesita requireAdminModerno');
  }
  if (typeof requireSesionModerna !== 'function') {
    throw new Error('registrarRutasTemporada necesita requireSesionModerna');
  }
  const permitidos = origenesPermitidos();
  const tope = (env, omision) => {
    const n = parseInt(process.env[env], 10);
    return Number.isFinite(n) && n > 0 ? n : omision;
  };
  // Varias personas pueden compartir IP (datos móviles, wifi de una plaza):
  // los topes protegen sin estorbar y se suben sin tocar código.
  const limiteLectura = rateLimitMiddleware((req) => `temporada:${req.ip}`,
    tope('XABOR_TEMPORADA_LIMITE_LECTURA', 120), 60 * 1000);
  const limiteEnvio = rateLimitMiddleware((req) => `temporada-envio:${req.ip}`,
    tope('XABOR_TEMPORADA_LIMITE_ENVIO', 12), 60 * 1000,
    'Recibimos muchos pedidos desde tu conexión. Espera un minuto e inténtalo de nuevo.');
  // Pedidos agendados (no intentos) por conexión en una hora (bloque 1.4).
  const altasPorHora = crearLimiteAltas({ limite: tope('XABOR_TEMPORADA_LIMITE_ENVIO_HORA', 6) });

  // CORS antes del rate limit: así hasta un 429 llega legible a la página.
  const cors = (req, res, next) => {
    res.setHeader('Vary', 'Origin');
    const origen = req.headers.origin;
    if (origen && permitidos.has(origen)) {
      res.setHeader('Access-Control-Allow-Origin', origen);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    // La disponibilidad cambia con cada pedido: nadie la guarda en caché.
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  // ══════════════════ PÚBLICA ══════════════════
  app.options('/api/temporada/:clave', cors);
  app.options('/api/temporada/:clave/pedidos', cors);

  app.get('/api/temporada/:clave', cors, limiteLectura, manejar(async (req, res) => {
    res.json(await campanaPublica(req.params.clave));
  }));

  app.post('/api/temporada/:clave/pedidos', cors, limiteEnvio, manejar(async (req, res) => {
    const devolverLugar = altasPorHora.tomar(`temporada-altas:${req.ip}`);
    if (!devolverLugar) {
      return res.status(429).json({
        error: 'Ya se agendaron varios pedidos desde tu conexión. Si necesitas otro, comunícate con el restaurante.',
        codigo: 'LIMITE_CONEXION',
      });
    }
    let resultado;
    try {
      resultado = await crearPedidoTemporada(req.params.clave, req.body);
    } catch (e) {
      devolverLugar();
      throw e;
    }
    const { pedido, repetido, negocioId } = resultado;
    // Un reintento del mismo pedido no agendó otro: no gasta lugar.
    if (repetido) devolverLugar();
    if (!repetido && typeof notificar === 'function') {
      // Aviso al panel del negocio: nunca detiene ni retrasa la respuesta.
      const lugar = pedido.modalidad === 'domicilio' ? 'domicilio' : 'recoger';
      Promise.resolve()
        .then(() => notificar(negocioId, `Nuevo pedido ${pedido.folio}`,
          `${pedido.platillos} ${pedido.producto.toLowerCase()} · ${pedido.ventana.inicio}–${pedido.ventana.fin} · ${lugar}`))
        .catch((e) => console.warn(`[Temporada] aviso no enviado (${pedido.folio}): ${e.message}`));
    }
    res.status(repetido ? 200 : 201).json({ pedido, repetido });
  }));

  // ══════════════════ ADMINISTRACIÓN ══════════════════
  // La página no trae datos: los pide a las rutas de abajo, que exigen sesión.
  app.get('/temporada', (req, res) => {
    res.sendFile(join(PANEL_DIR, 'temporada.html'));
  });

  // La sucursal con la que se atiende cada recurso (ver arriba).
  const negocioDe = (req, tipo, id) =>
    negocioDeRecursoTemporada(req.usuarioId, req.negocioId, tipo, id, { soporte: req.esSoporte === true });
  const sesionDe = (req) => ({ usuarioId: req.usuarioId, soporte: req.esSoporte === true });
  // Para las lecturas: con el rol en la sucursal de la sesión (la encargada es staff).
  const lectorDe = (req) => ({ ...sesionDe(req), rol: req.rol === 'admin' ? 'admin' : 'staff' });

  app.get('/api/admin/temporada/campanas', requireSesionModerna, manejar(async (req, res) => {
    res.json(await listarCampanasAdmin(req.negocioId, lectorDe(req)));
  }));

  // Una campaña nueva nace en la sucursal de la sesión.
  app.post('/api/admin/temporada/campanas', requireAdminModerno, manejar(async (req, res) => {
    res.status(201).json({ campana: await guardarCampana(req.negocioId, null, req.body) });
  }));

  app.put('/api/admin/temporada/campanas/:id', requireAdminModerno, manejar(async (req, res) => {
    res.json({ campana: await guardarCampana(await negocioDe(req, 'campana', req.params.id), req.params.id, req.body) });
  }));

  // «Se prepara en» (CEDIS): solo quien administra la sucursal de la campaña y la de destino.
  app.put('/api/admin/temporada/campanas/:id/preparacion', requireAdminModerno, manejar(async (req, res) => {
    res.json({ campana: await fijarPreparacionTemporada(await negocioDe(req, 'campana', req.params.id), req.params.id, req.body,
      { ...sesionDe(req), negocioActual: req.negocioId }) });
  }));

  app.get('/api/admin/temporada/campanas/:id/pedidos', requireSesionModerna, manejar(async (req, res) => {
    res.json(await verCampanaTemporada(req.negocioId, req.params.id, lectorDe(req)));
  }));

  // Todas las sucursales que ve, de un día: una sola lista.
  app.get('/api/admin/temporada/juntas/:fecha', requireSesionModerna, manejar(async (req, res) => {
    res.json(await pedidosJuntos(req.negocioId, req.params.fecha, lectorDe(req)));
  }));

  // Cancelar pide motivo; restaurar devuelve el pedido con su folio solo si
  // su horario todavía tiene cupo (409 SIN_CUPO si no).
  app.post('/api/admin/temporada/pedidos/:id/cancelar', requireAdminModerno, manejar(async (req, res) => {
    res.json(await cancelarPedidoTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id, req.body, { actorId: req.usuarioId }));
  }));

  app.post('/api/admin/temporada/pedidos/:id/restaurar', requireAdminModerno, manejar(async (req, res) => {
    res.json(await restaurarPedidoTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id, { actorId: req.usuarioId }));
  }));

  // Pagos: cada «Registrar pago» es un movimiento con quién y cuándo; uno mal
  // capturado se anula con motivo (nunca se borra).
  app.post('/api/admin/temporada/pedidos/:id/pagos', requireAdminModerno, manejar(async (req, res) => {
    res.status(201).json(await registrarPagoTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id, req.body, { actorId: req.usuarioId }));
  }));

  app.post('/api/admin/temporada/pagos/:id/anular', requireAdminModerno, manejar(async (req, res) => {
    res.json(await anularPagoTemporada(await negocioDe(req, 'pago', req.params.id), req.params.id, req.body, { actorId: req.usuarioId }));
  }));

  // Entrega: Agendado → En preparación → Listo → Entregado/Recogido, un paso a
  // la vez y con el paso que veía quien pulsó (dos tabletas no se pisan).
  app.post('/api/admin/temporada/pedidos/:id/entrega', requireAdminModerno, manejar(async (req, res) => {
    res.json(await cambiarEntregaTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id, req.body, { actorId: req.usuarioId }));
  }));

  // Captura y edición: pedidos que llegan por WhatsApp o por teléfono, y
  // cambios a uno ya agendado sin cancelarlo. Pasar un cupo exige
  // `exceder: true` después de ver la advertencia (409 CUPO_EXCEDIDO).
  app.post('/api/admin/temporada/campanas/:id/pedidos', requireAdminModerno, manejar(async (req, res) => {
    const r = await crearPedidoPanel(await negocioDe(req, 'campana', req.params.id), req.params.id, req.body, { actorId: req.usuarioId });
    res.status(r.repetido ? 200 : 201).json(r);
  }));

  app.post('/api/admin/temporada/pedidos/:id/editar', requireAdminModerno, manejar(async (req, res) => {
    res.json(await editarPedidoTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id, req.body, { actorId: req.usuarioId }));
  }));

  app.get('/api/admin/temporada/pedidos/:id/historial', requireAdminModerno, manejar(async (req, res) => {
    res.json(await historialPedidoTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id));
  }));

  // WhatsApp al cliente: Xabor no envía nada; la página abre wa.me con el
  // texto y aquí solo se anota quién lo abrió y cuándo.
  app.post('/api/admin/temporada/pedidos/:id/whatsapp', requireAdminModerno, manejar(async (req, res) => {
    res.json(await anotarWhatsAppTemporada(await negocioDe(req, 'pedido', req.params.id), req.params.id, req.body, { actorId: req.usuarioId }));
  }));
}
