// Autofactura nativa de Xabor — superficie PÚBLICA.
//
//   GET  /f/<token>                        -> panel/autofactura.html (plantilla
//                                             única, sin datos de venta embebidos)
//   GET  /api/autofactura/<token>          -> datos públicos de la venta + catálogos
//   POST /api/autofactura/<token>/validar  -> valida y normaliza datos fiscales
//                                             (fase 3: NO persiste, NO timbra)
//
// El token es la ÚNICA autorización: no hay sesión ni cookie, y nunca se
// acepta negocio_id ni folio del navegador (el token resuelve ambos por sí
// solo, ver autofacturaService.resolverAutofacturaPorToken). Un token con
// formato inválido, inexistente, de un negocio inactivo o de un negocio sin
// el módulo de facturación responde el MISMO 404 genérico: desde afuera no se
// distingue "no existe" de "existe pero no te corresponde verlo".
//
// Mismo patrón que la tienda pública (tiendaRutasCore.js): rate limit por IP
// con el middleware existente, plantilla estática, JSON por API. Nada de este
// módulo escribe en la base ni registra tokens ni datos fiscales en el log.
//
// ORDEN DE MONTAJE: server.js llama a registrarRutasAutofactura ANTES del
// `express.json({ limit: '20mb' })` global. Así el POST público lleva su
// propio parser con límite REAL de 8 KB (body-parser corta la lectura al
// exceder el límite, con o sin Content-Length, también en chunked) y el
// parser global, al ver el cuerpo ya leído, no vuelve a parsear.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { rateLimitMiddleware } from './rateLimit.js';
import { pool, obtenerConfiguracion, obtenerNombreNegocio, negocioEstaActivo, moduloHabilitado } from './database.js';
import { resolverAutofacturaPorToken, esFormatoTokenValido } from './autofacturaService.js';
import { obtenerPedidoFacturable } from './facturacionService.js';
import { validarDatosFiscales, AVISO_NOMBRE } from './autofacturaFiscal.js';
import { catalogosPublicos } from './catalogosSat.js';

const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel');
const NO_ENCONTRADA = Object.freeze({ error: 'No encontramos esta liga de facturación.' });
const CUERPO_MAX = '8kb';

const MENSAJE_ESTADO = Object.freeze({
  expirada: 'Esta liga de facturación ha expirado.',
  revocada: 'Esta liga ya no está disponible.',
  facturada: 'Este consumo ya fue facturado.',
  emitiendo: 'Este consumo se está facturando en este momento.',
  error: 'No pudimos preparar la facturación de este ticket. Contacta al negocio con tu folio.',
});

// La fecha que ve el cliente es la de la VENTA, no la de la liga: el
// `timestamp` que el pedido trae desde que se capturó (el mismo que imprime
// el ticket) y, si faltara, la fecha de alta de la fila del pedido.
async function fechaDeVenta(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT datos->>'timestamp' AS ts, created_at, entregado_at
       FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (!r) return null;
  const ts = r.ts && !Number.isNaN(Date.parse(r.ts)) ? new Date(r.ts) : null;
  const fecha = ts || r.created_at || r.entregado_at || null;
  return fecha instanceof Date ? fecha.toISOString() : null;
}

// Token -> autofactura visible para el público, o null (404 genérico).
async function resolverParaPublico(token) {
  if (!esFormatoTokenValido(token)) return null;
  const af = await resolverAutofacturaPorToken(token);
  if (!af) return null;
  const [activo, habilitado] = await Promise.all([
    negocioEstaActivo(af.negocioId), moduloHabilitado(af.negocioId, 'facturacion'),
  ]);
  return activo && habilitado ? af : null;
}

/**
 * Lo que un cliente con la liga puede ver, y nada más. Devuelve
 * `{ status, body }` para que la ruta HTTP y las pruebas compartan la misma
 * lógica. Nunca incluye negocio_id, ids internos, token, hash, material
 * cifrado, intento_key, errores internos ni datos fiscales.
 */
export async function consultarAutofacturaPublica(token) {
  const af = await resolverParaPublico(token);
  if (!af) return { status: 404, body: NO_ENCONTRADA };

  const [cfg, nombreNegocio, fecha] = await Promise.all([
    obtenerConfiguracion(af.negocioId), obtenerNombreNegocio(af.negocioId), fechaDeVenta(af.negocioId, af.folio),
  ]);
  const nombre = String(cfg?.nombre || nombreNegocio || '').trim() || null;
  const logo = String(cfg?.logo_url || '').trim();
  return {
    status: 200,
    body: {
      negocio: { nombre, logo_url: /^https:\/\//i.test(logo) ? logo : null },
      folio: af.folio,
      fecha,
      total: af.total,
      estado: af.estado,
      expires_at: af.expiresAt,
      // Catálogos SAT del backend: el portal los consume de aquí, nunca los
      // duplica, y el backend sigue siendo la autoridad al validar.
      catalogos: catalogosPublicos(),
      avisos: { nombre: AVISO_NOMBRE },
    },
  };
}

/**
 * Fase 3: valida y normaliza los datos fiscales de una liga VIGENTE cuya
 * venta sigue siendo facturable con el mismo total. No persiste nada y no
 * llama a Facturapi: devuelve lo que la pantalla de confirmación mostrará.
 */
export async function validarAutofacturaPublica(token, cuerpo) {
  const af = await resolverParaPublico(token);
  if (!af) return { status: 404, body: NO_ENCONTRADA };
  if (af.estado !== 'vigente') {
    return { status: 409, body: { error: MENSAJE_ESTADO[af.estado] || MENSAJE_ESTADO.error, estado: af.estado } };
  }
  // La venta debe seguir pagada/no cancelada y con el total congelado.
  let pedido;
  try {
    pedido = await obtenerPedidoFacturable(af.negocioId, af.folio);
  } catch (e) {
    if (e?.codigo) return { status: 409, body: { error: 'Esta venta ya no se puede facturar. Contacta al negocio con tu folio.', codigo: 'VENTA_NO_FACTURABLE' } };
    throw e;
  }
  if (Math.round(Number(pedido.total) * 100) / 100 !== af.total) {
    return { status: 409, body: { error: 'El total de la venta cambió y esta liga requiere revisión. Contacta al negocio con tu folio.', codigo: 'TOTAL_CAMBIO' } };
  }
  const r = validarDatosFiscales(cuerpo);
  if (!r.ok) return { status: 422, body: { ok: false, errores: r.errores } };
  return { status: 200, body: { ok: true, datos: r.datos, venta: { folio: af.folio, total: af.total } } };
}

export function registrarRutasAutofactura(app) {
  const tope = (env, omision) => {
    const n = parseInt(process.env[env], 10);
    return Number.isFinite(n) && n > 0 ? n : omision;
  };
  const limitePublico = rateLimitMiddleware(
    (req) => `autofactura:${req.ip}`, tope('XABOR_AUTOFACTURA_LIMITE_LECTURA', 60), 60 * 1000);
  const limiteValidar = rateLimitMiddleware(
    (req) => `autofactura-validar:${req.ip}`, tope('XABOR_AUTOFACTURA_LIMITE_VALIDAR', 20), 60 * 1000,
    'Demasiados intentos. Espera un momento e inténtalo de nuevo.');

  app.get('/f/:token', limitePublico, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(PANEL_DIR, 'autofactura.html'));
  });

  app.get('/api/autofactura/:token', limitePublico, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const r = await consultarAutofacturaPublica(req.params.token);
      res.status(r.status).json(r.body);
    } catch (e) {
      // Solo el mensaje del error: nunca el token ni la URL de la petición.
      console.error('[autofactura] consulta pública falló:', e.message);
      res.status(500).json({ error: 'No pudimos consultar esta liga en este momento. Intenta de nuevo más tarde.' });
    }
  });

  // Parser propio con límite real: body-parser deja de leer al superar 8 KB
  // (con Content-Length o en chunked) y levanta `entity.too.large`, que el
  // manejador de abajo convierte en 413 JSON.
  const cuerpoAcotado = express.json({ limit: CUERPO_MAX });

  app.post('/api/autofactura/:token/validar', limiteValidar, cuerpoAcotado, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Cuerpo inválido.' });
    }
    try {
      const r = await validarAutofacturaPublica(req.params.token, req.body);
      res.status(r.status).json(r.body);
    } catch (e) {
      // Nunca el token ni los datos fiscales capturados.
      console.error('[autofactura] validación pública falló:', e.message);
      res.status(500).json({ error: 'No pudimos validar tus datos en este momento. Intenta de nuevo más tarde.' });
    }
  });

  // JSON malformado o demasiado grande en cualquier ruta pública de
  // autofactura: respuesta JSON controlada, nunca la página de error por
  // defecto de Express.
  app.use('/api/autofactura', (err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Los datos enviados son demasiado grandes.' });
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'Cuerpo inválido.' });
    next(err);
  });
}
