// XECADOR · Personal — las rutas del directorio de empleados.
//
// En su propio módulo, como tiendaRutas.js y comprasRutas.js: server.js ya es
// demasiado grande y un módulo nuevo no tiene por qué engordarlo.
//
// Todas las rutas llevan las mismas tres puertas, en este orden:
//
//   requireAdminModerno  administrador con sesión real (cookie firmada).
//                        Rechaza al staff, al mesero y a la contraseña de
//                        administrador compartida (modo legado): dar de alta o
//                        de baja a una persona tiene que quedar ligado a una
//                        cuenta concreta.
//   soloAdminDelNegocio  decisión del dueño (5-nov-2026): Xecador lo administra
//                        SOLO el administrador del negocio. El Superadmin de
//                        Xabor no, ni con su sesión normal ni con una sesión de
//                        soporte (que requireAdminModerno sí deja pasar como
//                        'admin'). Contesta 403 con codigo
//                        'superadmin_sin_acceso_personal'. Si no se puede
//                        comprobar, 503: nunca deja pasar por un error.
//   requireModulo        el módulo 'personal' encendido para ESE negocio. Si
//                        está apagado contesta 403 con codigo
//                        'modulo_no_contratado' (o 'modulo_suspendido', etc.).
//
// El negocio SIEMPRE sale de req.negocioId, que pone la sesión. Ninguna ruta lo
// acepta del cuerpo, la URL o una cabecera. El autor de cada cambio
// (req.usuarioId) es por eso siempre un administrador del propio negocio.
import {
  PersonalError, darDeAltaEmpleado, actualizarEmpleado, darDeBajaEmpleado,
  reactivarEmpleado, listarEmpleados, siguienteNumeroSugerido, historialEmpleado,
  usuarioEsSuperadmin, listarSucursales, asignarJornada, obtenerJornadas, asignarPin,
} from './personalService.js';
import { registrarRutasChecador } from './checadorRutas.js';
import { configurarNotificador } from './checadorService.js';

/**
 * Traduce PersonalError a su HTTP y todo lo demás a 500, sin filtrar el
 * detalle del error interno a la pantalla. `extra` lleva datos para la
 * pantalla (segundos o minutos de una pausa, las acciones posibles).
 */
const manejar = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof PersonalError) {
      return res.status(e.http || 400).json({ ...(e.extra || {}), error: e.message, codigo: e.codigo });
    }
    console.error(`[Personal] ${req.method} ${req.path}: ${e.message}`);
    res.status(500).json({ error: 'No se pudo completar la operación' });
  }
};

/** Solo los campos que la pantalla puede mandar; lo demás se ignora. */
const camposEmpleado = (body) => {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const c of ['numero', 'nombre', 'puesto', 'telefono', 'sucursal_id', 'puede_checar_otras_sucursales',
    'fecha_ingreso', 'nss']) if (b[c] !== undefined) out[c] = b[c];
  return out;
};

const SIN_ACCESO_SUPERADMIN = {
  error: 'El directorio de empleados lo administra solo el administrador del negocio. El Superadmin de Xabor no tiene acceso, tampoco desde una sesión de soporte.',
  codigo: 'superadmin_sin_acceso_personal',
};

/**
 * El Superadmin no administra empleados: ni en una sesión de soporte (la marca
 * la sesión firmada, req.esSoporte) ni con su sesión normal (es superadmin
 * según administradores_plataforma, aunque además sea administrador de un
 * negocio). Falla cerrada: si la consulta no responde, 503.
 */
export async function soloAdminDelNegocio(req, res, next) {
  if (req.esSoporte === true) return res.status(403).json(SIN_ACCESO_SUPERADMIN);
  let esSuper;
  try {
    esSuper = await usuarioEsSuperadmin(req.usuarioId);
  } catch (e) {
    console.error(`[Personal] no se pudo comprobar si ${req.usuarioId} es superadmin: ${e.message}`);
    return res.status(503).json({ error: 'No se pudo comprobar el permiso. Inténtalo de nuevo.', codigo: 'permiso_no_verificable' });
  }
  if (esSuper) return res.status(403).json(SIN_ACCESO_SUPERADMIN);
  next();
}

/**
 * ¿Esta sesión puede administrar el directorio? Para que el panel muestre u
 * oculte «Empleados» (GET /api/auth/me → puedeAdministrarPersonal). Misma regla
 * que las puertas de arriba: administrador del negocio, que no sea el
 * Superadmin (ni en soporte), con el módulo encendido. Las puertas siguen
 * siendo la autoridad; esto es solo visibilidad. Si no se puede comprobar,
 * false: la entrada no aparece.
 */
export async function puedeAdministrarPersonal({ rol, esSoporte, usuarioId, modulos }) {
  if (rol !== 'admin' || esSoporte === true || !Array.isArray(modulos) || !modulos.includes('personal')) return false;
  try {
    return !(await usuarioEsSuperadmin(usuarioId));
  } catch {
    return false;
  }
}

export function registrarRutasPersonal(app, { requireAdminModerno, requireModulo, notificar = null }) {
  if (typeof requireAdminModerno !== 'function' || typeof requireModulo !== 'function') {
    throw new Error('registrarRutasPersonal necesita requireAdminModerno y requireModulo');
  }
  const puertas = [requireAdminModerno, soloAdminDelNegocio, requireModulo('personal')];
  // Los avisos del checador (PIN en pausa, tablet en pausa, turno sin cerrar)
  // también llegan por push al panel del negocio, si server.js lo conecta.
  configurarNotificador(notificar);

  app.get('/api/personal/empleados', ...puertas, manejar(async (req, res) => {
    const [empleados, siguienteNumero] = await Promise.all([
      listarEmpleados(req.negocioId, { incluirBajas: req.query.incluirBajas === 'true' }),
      siguienteNumeroSugerido(req.negocioId),
    ]);
    res.json({ empleados, siguienteNumero });
  }));

  // claveAlta: la clave que la pantalla repite al reintentar el MISMO alta. Con
  // una clave ya usada en este negocio contesta 200 con el expediente que ya
  // existe (repetida: true): no crea otro ni aparta otro número.
  app.post('/api/personal/empleados', ...puertas, manejar(async (req, res) => {
    const { empleado, repetida } = await darDeAltaEmpleado(req.negocioId, camposEmpleado(req.body), {
      actorId: req.usuarioId, claveAlta: req.body?.claveAlta,
    });
    if (repetida) return res.status(200).json({ empleado, repetida: true });
    res.status(201).json({ empleado });
  }));

  // version: la que la pantalla tenía al abrir el expediente. Si otra persona
  // lo cambió entretanto, 409 EXPEDIENTE_CAMBIO en vez de pisar su cambio.
  app.patch('/api/personal/empleados/:id', ...puertas, manejar(async (req, res) => {
    const empleado = await actualizarEmpleado(req.negocioId, req.params.id, camposEmpleado(req.body), {
      actorId: req.usuarioId, version: req.body?.version,
    });
    res.json({ empleado });
  }));

  // Baja con fecha efectiva (hoy si no se manda) y motivo de catálogo
  // (renuncia, despido, termino_contrato u otro, que pide el texto).
  app.post('/api/personal/empleados/:id/baja', ...puertas, manejar(async (req, res) => {
    const empleado = await darDeBajaEmpleado(req.negocioId, req.params.id, {
      fecha: req.body?.fecha, tipo: req.body?.tipo, motivo: req.body?.motivo ?? null, actorId: req.usuarioId,
    });
    res.json({ empleado });
  }));

  app.post('/api/personal/empleados/:id/reactivar', ...puertas, manejar(async (req, res) => {
    res.json({ empleado: await reactivarEmpleado(req.negocioId, req.params.id, { actorId: req.usuarioId }) });
  }));

  // La bitácora del expediente: altas, ediciones (antes → después), bajas con su
  // motivo y reactivaciones, con quién y cuándo. Solo lectura.
  app.get('/api/personal/empleados/:id/historial', ...puertas, manejar(async (req, res) => {
    res.json({ eventos: await historialEmpleado(req.negocioId, req.params.id) });
  }));

  // Las sucursales activas del negocio de la sesión, para el expediente.
  app.get('/api/personal/sucursales', ...puertas, manejar(async (req, res) => {
    res.json({ sucursales: await listarSucursales(req.negocioId) });
  }));

  // La jornada: la vigente y sus versiones. Cambiarla agrega una versión nueva
  // con su «vigente desde»; las anteriores no se tocan.
  app.get('/api/personal/empleados/:id/jornada', ...puertas, manejar(async (req, res) => {
    res.json(await obtenerJornadas(req.negocioId, req.params.id));
  }));

  app.put('/api/personal/empleados/:id/jornada', ...puertas, manejar(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const jornada = await asignarJornada(req.negocioId, req.params.id,
      { tipo: b.tipo, vigente_desde: b.vigente_desde, dias: b.dias }, { actorId: req.usuarioId });
    res.json({ jornada });
  }));

  // Asigna o restablece el PIN. Es la ÚNICA respuesta que lo trae en claro: no
  // se guarda en ninguna caché y después solo se sabe si el empleado tiene PIN.
  app.post('/api/personal/empleados/:id/pin', ...puertas, manejar(async (req, res) => {
    const { empleado, pin } = await asignarPin(req.negocioId, req.params.id, {
      longitud: req.body?.longitud ?? 6, actorId: req.usuarioId,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ empleado, pin });
  }));

  // El checador (Parte B1): tablets, checadas, avisos y la pantalla /checador.
  registrarRutasChecador(app, { puertas, requireModulo, manejar });
}
