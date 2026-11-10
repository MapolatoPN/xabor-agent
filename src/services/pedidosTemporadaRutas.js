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
//   sesión real (requireAdminModerno). El negocio sale de req.negocioId.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rateLimitMiddleware } from './rateLimit.js';
import {
  TemporadaError, campanaPublica, crearPedidoTemporada, listarCampanas, guardarCampana,
  pedidosDeCampana, cancelarPedidoTemporada,
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

export function registrarRutasTemporada(app, { requireAdminModerno, notificar = null }) {
  if (typeof requireAdminModerno !== 'function') {
    throw new Error('registrarRutasTemporada necesita requireAdminModerno');
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
    const { pedido, repetido, negocioId } = await crearPedidoTemporada(req.params.clave, req.body);
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

  app.get('/api/admin/temporada/campanas', requireAdminModerno, manejar(async (req, res) => {
    res.json(await listarCampanas(req.negocioId));
  }));

  app.post('/api/admin/temporada/campanas', requireAdminModerno, manejar(async (req, res) => {
    res.status(201).json({ campana: await guardarCampana(req.negocioId, null, req.body) });
  }));

  app.put('/api/admin/temporada/campanas/:id', requireAdminModerno, manejar(async (req, res) => {
    res.json({ campana: await guardarCampana(req.negocioId, req.params.id, req.body) });
  }));

  app.get('/api/admin/temporada/campanas/:id/pedidos', requireAdminModerno, manejar(async (req, res) => {
    res.json(await pedidosDeCampana(req.negocioId, req.params.id));
  }));

  app.post('/api/admin/temporada/pedidos/:id/cancelar', requireAdminModerno, manejar(async (req, res) => {
    res.json(await cancelarPedidoTemporada(req.negocioId, req.params.id, { actorId: req.usuarioId }));
  }));
}
