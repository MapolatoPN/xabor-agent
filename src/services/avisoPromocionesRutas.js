/**
 * avisoPromocionesRutas.js — Clientes → «Aviso de promociones» de la tienda
 * (panel/clientes-consentimiento.js).
 *
 * Solo administradores (requireAdminSeguro): el operador no decide qué acepta
 * el cliente al pedir (test/fase-permisos-operador.mjs lo vigila). El negocio
 * sale SIEMPRE de la sesión, nunca del cuerpo ni de la dirección.
 */
import { ErrorAviso, avisoParaPanel, guardarAviso } from './avisoPromociones.js';

function responderError(res, e, que) {
  if (e instanceof ErrorAviso) return res.status(e.http || 400).json({ error: e.message, codigo: e.codigo });
  console.error(`[AVISO] ${que}:`, e.message);
  return res.status(500).json({ error: 'No pudimos completar esto. Recarga la página e intenta otra vez.' });
}

const quienEs = (req) => (req.usuarioId ?? req.usuario?.id ?? null);

export function registrarRutasAvisoPromociones(app, { requireAdminSeguro, servicio = {} }) {
  if (typeof requireAdminSeguro !== 'function') throw new Error('registrarRutasAvisoPromociones: falta requireAdminSeguro');
  const s = { leer: avisoParaPanel, guardar: guardarAviso, ...servicio };

  app.get('/api/admin/clientes/aviso-promociones', requireAdminSeguro, async (req, res) => {
    try {
      res.json(await s.leer(req.negocioId));
    } catch (e) { responderError(res, e, 'leer aviso de promociones'); }
  });

  app.put('/api/admin/clientes/aviso-promociones', requireAdminSeguro, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await s.guardar(req.negocioId, { texto: b.texto, enTienda: b.enTienda }, quienEs(req));
      res.json({ ok: true, ...r, ...(await s.leer(req.negocioId)) });
    } catch (e) { responderError(res, e, 'guardar aviso de promociones'); }
  });
}
