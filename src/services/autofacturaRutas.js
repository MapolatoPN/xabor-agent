// Autofactura nativa de Xabor — fase 2: superficie PÚBLICA de solo lectura.
//
//   GET /f/<token>               -> panel/autofactura.html (plantilla única,
//                                   sin datos de venta embebidos)
//   GET /api/autofactura/<token> -> datos públicos de la venta
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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rateLimitMiddleware } from './rateLimit.js';
import { pool, obtenerConfiguracion, obtenerNombreNegocio, negocioEstaActivo, moduloHabilitado } from './database.js';
import { resolverAutofacturaPorToken, esFormatoTokenValido } from './autofacturaService.js';

const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel');
const NO_ENCONTRADA = Object.freeze({ error: 'No encontramos esta liga de facturación.' });

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

/**
 * Lo que un cliente con la liga puede ver, y nada más. Devuelve
 * `{ status, body }` para que la ruta HTTP y las pruebas compartan la misma
 * lógica. Nunca incluye negocio_id, ids internos, token, hash, material
 * cifrado, intento_key, errores internos ni datos fiscales.
 */
export async function consultarAutofacturaPublica(token) {
  if (!esFormatoTokenValido(token)) return { status: 404, body: NO_ENCONTRADA };
  const af = await resolverAutofacturaPorToken(token);
  if (!af) return { status: 404, body: NO_ENCONTRADA };
  const [activo, habilitado] = await Promise.all([
    negocioEstaActivo(af.negocioId), moduloHabilitado(af.negocioId, 'facturacion'),
  ]);
  if (!activo || !habilitado) return { status: 404, body: NO_ENCONTRADA };

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
    },
  };
}

export function registrarRutasAutofactura(app) {
  const tope = parseInt(process.env.XABOR_AUTOFACTURA_LIMITE_LECTURA, 10);
  const limitePublico = rateLimitMiddleware(
    (req) => `autofactura:${req.ip}`, Number.isFinite(tope) && tope > 0 ? tope : 60, 60 * 1000);

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
}
