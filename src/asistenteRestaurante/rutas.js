// Asistente del restaurante, Fase 1: las rutas que lee la campanita.
//
// Solo administrador de la sucursal, con POS. Además (avisos.js → puedeVer):
// la bandera encendida, el modo 'visible' y el usuario en la lista de
// destinatarios. Si no, la lista responde { activo: false } SIN tocar las
// tablas del asistente, y las acciones responden 403. Una sesión de soporte
// (superadmin) no es usuario del negocio: tampoco lo ve.
//
// Fase 2: la configuración de la sucursal (configuracion.js). La lee y la
// cambia solo quien RECIBE los avisos (puedeEditar), en ensayo o visible. A
// los demás la lectura les responde { disponible: false } —sin 403, para que
// el panel no muestre avisos de error— y los cambios, 403.
import { pool, registrarAuditoriaSecundaria } from '../services/database.js';
import {
  configuracionAsistente, puedeVer, listarAvisosAsistente, marcarVistosAsistente, opinarAviso, OPINIONES,
} from './avisos.js';
import {
  leerConfiguracion, puedeEditar, vistaConfiguracion, validarCambio, guardarConfiguracion, volverAAvisar,
} from './configuracion.js';
import { enviarPrueba, negocioDe } from './envioResumen.js';

const ID = /^\d{1,18}$/;
const APAGADO = Object.freeze({ activo: false, sinVer: 0, avisos: [] });
const NO_DISPONIBLE = Object.freeze({ disponible: false });

export function registrarRutasAsistenteRestaurante(app, { requireAdminSeguro, requireModulo, db = pool, registrarAuditoria = registrarAuditoriaSecundaria }) {
  const base = '/api/admin/asistente-restaurante/avisos';
  const guardias = [requireAdminSeguro, requireModulo('pos')];
  const quien = (req) => ({ usuarioId: req.usuarioId || null, esSoporte: req.esSoporte === true });
  const permitido = async (req) => puedeVer(await configuracionAsistente(db, req.negocioId), quien(req));

  app.get(base, ...guardias, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!(await permitido(req))) return res.json(APAGADO);
      res.json(await listarAvisosAsistente(db, req.negocioId, req.usuarioId));
    } catch (e) {
      console.error('[Asistente] lista:', e.message);
      res.status(503).json({ error: 'No se pudieron leer los avisos del asistente.' });
    }
  });

  app.post(`${base}/visto-todos`, ...guardias, async (req, res) => {
    try {
      if (!(await permitido(req))) return res.status(403).json({ error: 'Sin acceso a los avisos del asistente.' });
      res.json(await marcarVistosAsistente(db, req.negocioId, { usuarioId: req.usuarioId }));
    } catch (e) {
      console.error('[Asistente] marcar todos:', e.message);
      res.status(500).json({ error: 'No se pudieron marcar los avisos.' });
    }
  });

  app.post(`${base}/:id/visto`, ...guardias, async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Aviso inválido.' });
    try {
      if (!(await permitido(req))) return res.status(403).json({ error: 'Sin acceso a los avisos del asistente.' });
      res.json(await marcarVistosAsistente(db, req.negocioId, { id: req.params.id, usuarioId: req.usuarioId }));
    } catch (e) {
      console.error('[Asistente] marcar:', e.message);
      res.status(500).json({ error: 'No se pudo marcar el aviso.' });
    }
  });

  app.post(`${base}/:id/opinion`, ...guardias, async (req, res) => {
    const opinion = req.body?.opinion;
    if (!ID.test(req.params.id) || !OPINIONES.includes(opinion)) return res.status(400).json({ error: 'Opinión inválida.' });
    try {
      if (!(await permitido(req))) return res.status(403).json({ error: 'Sin acceso a los avisos del asistente.' });
      const r = await opinarAviso(db, req.negocioId, { id: req.params.id, usuarioId: req.usuarioId, opinion });
      if (!r) return res.status(404).json({ error: 'Aviso no encontrado.' });
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[Asistente] opinión:', e.message);
      res.status(500).json({ error: 'No se pudo guardar la opinión.' });
    }
  });

  // ─── Fase 2: la configuración de la sucursal ───────────────────────────
  const baseCfg = '/api/admin/asistente-restaurante/configuracion';
  const SIN_ACCESO = 'Sin acceso a la configuración del asistente.';
  const editable = async (req) => {
    const cfg = await leerConfiguracion(db, req.negocioId);
    return puedeEditar(cfg, quien(req)) ? cfg : null;
  };
  const vista = async (req) => vistaConfiguracion(db, req.negocioId, await leerConfiguracion(db, req.negocioId), req.usuarioId);

  app.get(baseCfg, ...guardias, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const cfg = await editable(req);
      if (!cfg) return res.json(NO_DISPONIBLE);
      res.json(await vistaConfiguracion(db, req.negocioId, cfg, req.usuarioId));
    } catch (e) {
      console.error('[Asistente] leer configuración:', e.message);
      res.status(503).json({ error: 'No se pudo leer la configuración del asistente.' });
    }
  });

  app.put(baseCfg, ...guardias, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!(await editable(req))) return res.status(403).json({ error: SIN_ACCESO });
      const cambio = validarCambio(req.body, { usuarioId: req.usuarioId });
      await guardarConfiguracion(db, req.negocioId, { usuarioId: req.usuarioId, cambio, registrarAuditoria });
      res.json(await vista(req));
    } catch (e) {
      if (e.code === 'CONFIGURACION_INVALIDA') return res.status(400).json({ error: e.message });
      if (e.code === 'SIN_ACCESO') return res.status(403).json({ error: SIN_ACCESO });
      console.error('[Asistente] guardar configuración:', e.message);
      res.status(500).json({ error: 'No se pudo guardar la configuración del asistente.' });
    }
  });

  app.post(`${baseCfg}/volver-a-avisar`, ...guardias, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const firma = req.body?.firma;
    if (typeof firma !== 'string' || !firma || firma.length > 300) return res.status(400).json({ error: 'Aviso inválido.' });
    try {
      if (!(await editable(req))) return res.status(403).json({ error: SIN_ACCESO });
      const r = await volverAAvisar(db, req.negocioId, { usuarioId: req.usuarioId, firma, registrarAuditoria });
      if (!r.quitado) return res.status(404).json({ error: 'Ese aviso ya no está en la lista.' });
      res.json(await vista(req));
    } catch (e) {
      console.error('[Asistente] volver a avisar:', e.message);
      res.status(500).json({ error: 'No se pudo volver a encender el aviso.' });
    }
  });

  // ─── Fase 3: «Enviar prueba» del resumen por WhatsApp ───────────────────
  // Solo quien puede cambiar la configuración, al número YA guardado (nunca
  // a uno que venga en el cuerpo). Máximo 5 por hora y sucursal.
  app.post(`${baseCfg}/enviar-prueba`, ...guardias, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const cfg = await editable(req);
      if (!cfg) return res.status(403).json({ error: SIN_ACCESO });
      const negocio = await negocioDe(db, req.negocioId);
      if (!negocio) return res.status(404).json({ error: 'Sucursal no encontrada.' });
      const r = await enviarPrueba({ db, negocio, cfg });
      res.json(r);
    } catch (e) {
      console.error('[Asistente] enviar prueba:', e.message);
      res.status(500).json({ error: 'No se pudo enviar la prueba.' });
    }
  });
}
