/**
 * clientesSaneamientoRutas.js — Clientes → teléfonos del negocio y marca de
 * interno (panel/clientes-saneamiento.js).
 *
 * Solo administradores (requireAdminSeguro): el operador no decide quién es
 * cliente (test/fase-permisos-operador.mjs lo vigila). El negocio sale SIEMPRE
 * de la sesión, nunca del cuerpo ni de la dirección; un id se busca siempre
 * junto con el negocio (uno ajeno es 404).
 */
import {
  ErrorSaneamiento, agregarTelefonoPropio, bitacoraDe, cambiarTelefonoPropio, listarTelefonosPropios, marcarInterno,
  numeroWhatsappDeMeta, registrarTelefonoWhatsapp,
} from './clientesSaneamiento.js';

const esUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

function responderError(res, e, que) {
  if (e instanceof ErrorSaneamiento) return res.status(e.http || 400).json({ error: e.message, codigo: e.codigo });
  console.error(`[CLIENTES] ${que}:`, e.message);
  return res.status(500).json({ error: 'No pudimos completar esto. Recarga la página e intenta otra vez.' });
}

const quienEs = (req) => (req.usuarioId ?? req.usuario?.id ?? null);

export function registrarRutasClientesSaneamiento(app, { requireAdminSeguro, servicio = {} }) {
  if (typeof requireAdminSeguro !== 'function') throw new Error('registrarRutasClientesSaneamiento: falta requireAdminSeguro');
  const s = {
    listar: listarTelefonosPropios, agregar: agregarTelefonoPropio, cambiar: cambiarTelefonoPropio, interno: marcarInterno,
    bitacora: bitacoraDe, numeroMeta: numeroWhatsappDeMeta, registrarWhatsapp: registrarTelefonoWhatsapp, ...servicio,
  };

  app.get('/api/admin/clientes/telefonos-negocio', requireAdminSeguro, async (req, res) => {
    try {
      // Mejor esfuerzo: si el WhatsApp del negocio todavía no está en la lista,
      // se le pregunta a Meta su número. Si Meta no contesta, la lista sale igual.
      if (req.query.revisarWhatsapp === '1') {
        try {
          const numero = await s.numeroMeta(req.negocioId);
          if (numero) await s.registrarWhatsapp(req.negocioId, numero);
        } catch { /* sin dato de Meta */ }
      }
      res.json({ telefonos: await s.listar(req.negocioId) });
    } catch (e) { responderError(res, e, 'teléfonos del negocio'); }
  });

  app.post('/api/admin/clientes/telefonos-negocio', requireAdminSeguro, async (req, res) => {
    try {
      const b = req.body || {};
      res.json({ ok: true, telefono: await s.agregar(req.negocioId, { telefono: b.telefono, etiqueta: b.etiqueta }, quienEs(req)) });
    } catch (e) { responderError(res, e, 'agregar teléfono del negocio'); }
  });

  app.patch('/api/admin/clientes/telefonos-negocio/:id', requireAdminSeguro, async (req, res) => {
    try {
      res.json({ ok: true, telefono: await s.cambiar(req.negocioId, req.params.id, { activo: req.body?.activo }, quienEs(req)) });
    } catch (e) { responderError(res, e, 'cambiar teléfono del negocio'); }
  });

  app.patch('/api/admin/clientes/v2/:id/interno', requireAdminSeguro, async (req, res) => {
    try {
      if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Cliente no encontrado.', codigo: 'NO_EXISTE' });
      const b = req.body || {};
      res.json({ ok: true, ...(await s.interno(req.negocioId, req.params.id, { interno: b.interno, motivo: b.motivo }, quienEs(req))) });
    } catch (e) { responderError(res, e, 'marcar interno'); }
  });

  app.get('/api/admin/clientes/v2/:id/bitacora', requireAdminSeguro, async (req, res) => {
    try {
      if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Cliente no encontrado.', codigo: 'NO_EXISTE' });
      res.json({ cambios: await s.bitacora(req.negocioId, 'cliente', req.params.id) });
    } catch (e) { responderError(res, e, 'bitácora del cliente'); }
  });
}
