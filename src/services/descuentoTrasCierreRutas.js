/**
 * descuentoTrasCierreRutas.js — las dos rutas del botón «Encender / Apagar» del
 * descuento a quien escribió con el negocio cerrado (panel: Tienda →
 * Promociones; panel/descuento-cierre.js).
 *
 * Solo administradores (requireAdminSeguro): el operador no enciende ni apaga
 * descuentos (test/fase-permisos-operador.mjs lo vigila). El negocio sale
 * SIEMPRE de la sesión, nunca del cuerpo de la petición.
 */
import {
  ErrorDescuentoCierre, apagarDescuentoTrasCierre, encenderDescuentoTrasCierre, estadoDescuentoTrasCierre,
} from './descuentoTrasCierreAdmin.js';

export function registrarRutasDescuentoTrasCierre(app, { requireAdminSeguro, servicio = {} }) {
  if (typeof requireAdminSeguro !== 'function') throw new Error('registrarRutasDescuentoTrasCierre: falta requireAdminSeguro');
  const estado = servicio.estado || estadoDescuentoTrasCierre;
  const encender = servicio.encender || encenderDescuentoTrasCierre;
  const apagar = servicio.apagar || apagarDescuentoTrasCierre;

  app.get('/api/admin/descuento-cierre', requireAdminSeguro, async (req, res) => {
    try {
      res.json(await estado(req.negocioId));
    } catch (e) {
      console.error('[DESCUENTO-CIERRE] estado:', e.message);
      res.status(500).json({ error: 'No pudimos leer el descuento por cierre' });
    }
  });

  app.put('/api/admin/descuento-cierre', requireAdminSeguro, async (req, res) => {
    const encendido = req.body?.encendido;
    if (typeof encendido !== 'boolean') return res.status(400).json({ error: 'encendido debe ser true o false' });
    const usuarioId = req.usuarioId ?? req.usuario?.id ?? null;
    try {
      const r = encendido
        ? await encender(req.negocioId, { usuarioId })
        : await apagar(req.negocioId, { usuarioId });
      res.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof ErrorDescuentoCierre) return res.status(409).json({ error: e.message, codigo: e.codigo });
      console.error('[DESCUENTO-CIERRE] cambiar:', e.message);
      res.status(500).json({ error: 'No pudimos completar el cambio. Recarga la página para ver cómo quedó.' });
    }
  });
}
