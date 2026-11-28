/**
 * campanasWaRutas.js — las rutas de Clientes → Campañas (panel/campanas-wa.js).
 *
 * Solo administradores con el módulo de WhatsApp (requireAdminSeguro +
 * requireModulo('whatsapp')): el operador no manda campañas
 * (test/fase-permisos-operador.mjs lo vigila). El negocio sale SIEMPRE de la
 * sesión, nunca del cuerpo ni de la dirección.
 */
import {
  ErrorCampana, crearCampanaPlantilla, detenerCampana, enviarPrueba, listarCampanasWa, pausarCampana, plantillasDelNegocio,
  prepararCampana, reanudarCampana, trazabilidadEncendida,
} from './campanasWa.js';
import { DIAS_SIN_REPETIR, HORARIO_ENVIO, SEGMENTOS, TANDAS, TARIFA_APROX_USD } from './campanasWaPlantillas.js';

const CODIGO_HTTP = { LISTA_CAMBIO: 409, OTRA_EN_CURSO: 409, NO_EN_CURSO: 409, NO_PAUSADA: 409, DEMASIADAS_PRUEBAS: 429,
  META_RECHAZO: 502, META_NO_RESPONDE: 502 };

function responderError(res, e, que) {
  if (e instanceof ErrorCampana) {
    const { message, codigo, total, clave } = e;
    return res.status(CODIGO_HTTP[codigo] || 400).json({ error: message, codigo, ...(total != null ? { total } : {}),
      ...(clave ? { clave } : {}) });
  }
  console.error(`[CAMPANAS-WA] ${que}:`, e.message);
  return res.status(500).json({ error: 'No pudimos completar esto. Recarga la página e intenta otra vez.' });
}

// Lo que el panel puede mandar en el cuerpo; nada más (y nunca el negocio).
function datosDe(body) {
  const b = body || {};
  return {
    nombre: b.nombre, plantilla: b.plantilla, idioma: b.idioma, variables: b.variables, respaldoNombre: b.respaldoNombre,
    segmento: b.segmento, excluirRecientes: b.excluirRecientes, totalVisto: b.totalVisto,
    // Asistente, Mejora 1: el número del aviso (solo con segmento 'asistente').
    avisoAsistente: b.avisoAsistente,
    tope24h: b.tope24h, umbralRechazoPct: b.umbralRechazoPct,
    telefono: b.telefono, nombrePrueba: b.nombrePrueba,
  };
}

export function registrarRutasCampanasWa(app, { requireAdminSeguro, requireModulo, servicio = {} }) {
  if (typeof requireAdminSeguro !== 'function') throw new Error('registrarRutasCampanasWa: falta requireAdminSeguro');
  if (typeof requireModulo !== 'function') throw new Error('registrarRutasCampanasWa: falta requireModulo');
  const s = {
    listar: listarCampanasWa, plantillas: plantillasDelNegocio, trazabilidad: trazabilidadEncendida, preparar: prepararCampana,
    crear: crearCampanaPlantilla, prueba: enviarPrueba, detener: detenerCampana, pausar: pausarCampana,
    reanudar: reanudarCampana, ...servicio,
  };
  const wa = requireModulo('whatsapp');

  app.get('/api/admin/campanas-wa', requireAdminSeguro, wa, async (req, res) => {
    try {
      res.json({ campanas: await s.listar(req.negocioId) });
    } catch (e) { responderError(res, e, 'listar'); }
  });

  app.get('/api/admin/campanas-wa/plantillas', requireAdminSeguro, wa, async (req, res) => {
    try {
      const [p, trazabilidad] = await Promise.all([s.plantillas(req.negocioId, { sinCache: req.query.recargar === '1' }),
        s.trazabilidad(req.negocioId)]);
      res.json({ ...p, trazabilidad, segmentos: SEGMENTOS, horario: HORARIO_ENVIO, diasSinRepetir: DIAS_SIN_REPETIR,
        tarifas: TARIFA_APROX_USD, tandas: TANDAS });
    } catch (e) { responderError(res, e, 'plantillas'); }
  });

  app.post('/api/admin/campanas-wa/vista-previa', requireAdminSeguro, wa, async (req, res) => {
    try {
      const { resumen } = await s.preparar(req.negocioId, datosDe(req.body));
      res.json(resumen);
    } catch (e) { responderError(res, e, 'vista previa'); }
  });

  app.post('/api/admin/campanas-wa/prueba', requireAdminSeguro, wa, async (req, res) => {
    try {
      res.json(await s.prueba(req.negocioId, datosDe(req.body)));
    } catch (e) { responderError(res, e, 'prueba'); }
  });

  app.post('/api/admin/campanas-wa', requireAdminSeguro, wa, async (req, res) => {
    try {
      const usuarioId = req.usuarioId ?? req.usuario?.id ?? null;
      res.json({ ok: true, ...(await s.crear(req.negocioId, datosDe(req.body), { usuarioId })) });
    } catch (e) { responderError(res, e, 'crear'); }
  });

  app.post('/api/admin/campanas-wa/:id/detener', requireAdminSeguro, wa, async (req, res) => {
    try {
      res.json(await s.detener(req.negocioId, req.params.id));
    } catch (e) { responderError(res, e, 'detener'); }
  });

  app.post('/api/admin/campanas-wa/:id/pausar', requireAdminSeguro, wa, async (req, res) => {
    try {
      res.json(await s.pausar(req.negocioId, req.params.id));
    } catch (e) { responderError(res, e, 'pausar'); }
  });

  app.post('/api/admin/campanas-wa/:id/reanudar', requireAdminSeguro, wa, async (req, res) => {
    try {
      res.json(await s.reanudar(req.negocioId, req.params.id));
    } catch (e) { responderError(res, e, 'reanudar'); }
  });
}
