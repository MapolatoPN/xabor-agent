// XECADOR · Personal — las rutas del directorio de empleados.
//
// En su propio módulo, como tiendaRutas.js y comprasRutas.js: server.js ya es
// demasiado grande y un módulo nuevo no tiene por qué engordarlo.
//
// Las cinco rutas llevan las mismas dos puertas, en este orden:
//
//   requireAdminModerno  administrador con sesión real (cookie firmada o la
//                        sesión de soporte del Superadmin). Rechaza al staff,
//                        al mesero y a la contraseña de administrador
//                        compartida (modo legado): dar de alta o de baja a una
//                        persona tiene que quedar ligado a una cuenta concreta.
//   requireModulo        el módulo 'personal' encendido para ESE negocio. Si
//                        está apagado contesta 403 con codigo
//                        'modulo_no_contratado' (o 'modulo_suspendido', etc.).
//
// El negocio SIEMPRE sale de req.negocioId, que pone la sesión. Ninguna ruta lo
// acepta del cuerpo, la URL o una cabecera.
import {
  PersonalError, crearEmpleado, actualizarEmpleado, darDeBajaEmpleado,
  reactivarEmpleado, listarEmpleados, siguienteNumeroSugerido,
} from './personalService.js';

/**
 * Traduce PersonalError a su HTTP y todo lo demás a 500, sin filtrar el
 * detalle del error interno a la pantalla.
 */
const manejar = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof PersonalError) {
      return res.status(e.http || 400).json({ error: e.message, codigo: e.codigo });
    }
    console.error(`[Personal] ${req.method} ${req.path}: ${e.message}`);
    res.status(500).json({ error: 'No se pudo completar la operación' });
  }
};

/** Solo los campos que la pantalla puede mandar; lo demás se ignora. */
const camposEmpleado = (body) => {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const c of ['numero', 'nombre', 'puesto', 'telefono']) if (b[c] !== undefined) out[c] = b[c];
  return out;
};

export function registrarRutasPersonal(app, { requireAdminModerno, requireModulo }) {
  if (typeof requireAdminModerno !== 'function' || typeof requireModulo !== 'function') {
    throw new Error('registrarRutasPersonal necesita requireAdminModerno y requireModulo');
  }
  const modulo = requireModulo('personal');

  app.get('/api/personal/empleados', requireAdminModerno, modulo, manejar(async (req, res) => {
    const [empleados, siguienteNumero] = await Promise.all([
      listarEmpleados(req.negocioId, { incluirBajas: req.query.incluirBajas === 'true' }),
      siguienteNumeroSugerido(req.negocioId),
    ]);
    res.json({ empleados, siguienteNumero });
  }));

  app.post('/api/personal/empleados', requireAdminModerno, modulo, manejar(async (req, res) => {
    const empleado = await crearEmpleado(req.negocioId, camposEmpleado(req.body), { actorId: req.usuarioId });
    res.status(201).json({ empleado });
  }));

  app.patch('/api/personal/empleados/:id', requireAdminModerno, modulo, manejar(async (req, res) => {
    const empleado = await actualizarEmpleado(req.negocioId, req.params.id, camposEmpleado(req.body), { actorId: req.usuarioId });
    res.json({ empleado });
  }));

  app.post('/api/personal/empleados/:id/baja', requireAdminModerno, modulo, manejar(async (req, res) => {
    const empleado = await darDeBajaEmpleado(req.negocioId, req.params.id, {
      motivo: req.body?.motivo ?? null, actorId: req.usuarioId,
    });
    res.json({ empleado });
  }));

  app.post('/api/personal/empleados/:id/reactivar', requireAdminModerno, modulo, manejar(async (req, res) => {
    res.json({ empleado: await reactivarEmpleado(req.negocioId, req.params.id) });
  }));
}
