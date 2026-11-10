// XECADOR · Cara — rutas del administrador (migración 134).
//
// Las mismas tres puertas que el directorio (requireAdminModerno,
// soloAdminDelNegocio, requireModulo('personal')): el consentimiento, el
// registro de la cara y su foto de referencia los maneja solo el
// administrador del negocio. El negocio sale de la sesión.
//
// La tablet no tiene rutas propias para la cara: manda las fotos con la
// checada (/api/checador/checar y /api/checador/sincronizar).
import * as K from './caraService.js';

export function registrarRutasCara(app, { puertas, manejar }) {
  if (!Array.isArray(puertas) || typeof manejar !== 'function') throw new Error('registrarRutasCara necesita las puertas y manejar');
  const E = '/api/personal/empleados/:id';
  const privado = (res) => res.set('Cache-Control', 'private, no-store');

  // ¿Este servidor puede comparar caras? (sin motor o sin llave, no se enciende)
  app.get('/api/personal/cara/estado', ...puertas, manejar(async (_req, res) => {
    res.json({ ...K.caraDisponible(), registro_min: K.REGISTRO_MIN, registro_max: K.REGISTRO_MAX });
  }));
  app.get(`${E}/cara`, ...puertas, manejar(async (req, res) => {
    privado(res);
    res.json(await K.estadoCaraEmpleado(req.negocioId, req.params.id));
  }));
  app.put(`${E}/consentimiento-cara`, ...puertas, manejar(async (req, res) => {
    res.json(await K.guardarConsentimiento(req.negocioId, req.params.id, req.body, { actorId: req.usuarioId }));
  }));
  app.post(`${E}/cara`, ...puertas, manejar(async (req, res) => {
    privado(res);
    res.status(201).json(await K.registrarCara(req.negocioId, req.params.id, req.body, { actorId: req.usuarioId }));
  }));
  app.delete(`${E}/cara`, ...puertas, manejar(async (req, res) => {
    res.json(await K.borrarCara(req.negocioId, req.params.id, { actorId: req.usuarioId }));
  }));
  app.get(`${E}/cara/foto`, ...puertas, manejar(async (req, res) => {
    const f = await K.fotoReferencia(req.negocioId, req.params.id);
    privado(res);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(f.mime).send(f.datos);
  }));
}
