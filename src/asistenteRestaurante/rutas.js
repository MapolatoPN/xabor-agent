// Asistente del restaurante, Fase 1: las rutas que lee la campanita.
//
// Solo administrador de la sucursal, con POS. Además (avisos.js → puedeVer):
// la bandera encendida, el modo 'visible' y el usuario en la lista de
// destinatarios. Si no, la lista responde { activo: false } SIN tocar las
// tablas del asistente, y las acciones responden 403. Una sesión de soporte
// (superadmin) no es usuario del negocio: tampoco lo ve.
import { pool } from '../services/database.js';
import {
  configuracionAsistente, puedeVer, listarAvisosAsistente, marcarVistosAsistente, opinarAviso, OPINIONES,
} from './avisos.js';

const ID = /^\d{1,18}$/;
const APAGADO = Object.freeze({ activo: false, sinVer: 0, avisos: [] });

export function registrarRutasAsistenteRestaurante(app, { requireAdminSeguro, requireModulo, db = pool }) {
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
}
