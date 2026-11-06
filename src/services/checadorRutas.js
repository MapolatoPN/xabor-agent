// XECADOR · Checador — rutas (Parte B1).
//
// Dos superficies:
//
//   /api/personal/checador/*  del administrador del negocio. Las mismas tres
//                             puertas que el directorio (requireAdminModerno,
//                             soloAdminDelNegocio, requireModulo('personal')):
//                             tablets, configuración, checadas del día, fotos
//                             y avisos.
//
//   /checador y /api/checador/*  la tablet de la sucursal. No usan la sesión
//                             del panel: cada llamada lleva el token de la
//                             tablet (Authorization: Bearer). El negocio y la
//                             sucursal salen de ese token; después pasa por
//                             requireModulo('personal') como cualquier ruta.
//                             La única ruta sin token es la que canjea el
//                             código de un solo uso, con su propio límite.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './checadorService.js';

const PAGINA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel', 'checador.html');
const sinCache = (res) => res.set('Cache-Control', 'no-store');

// Canjear códigos: 10 códigos EQUIVOCADOS por IP cada 10 minutos (el código es
// de 8 caracteres y vence en 30 minutos; esto frena a quien prueba a ciegas).
// Los que sí sirven no cuentan: vincular varias tablets desde la misma red del
// restaurante no debe bloquear a nadie.
export const VINCULAR_FALLOS = 10;
const VINCULAR_VENTANA_MS = 10 * 60 * 1000;
const fallosVincular = new Map();
function limiteVincular(req, res, next) {
  const ip = req.ip || 'sin-ip';
  const ahora = Date.now();
  const lista = (fallosVincular.get(ip) || []).filter((t) => ahora - t < VINCULAR_VENTANA_MS);
  fallosVincular.set(ip, lista);
  if (lista.length >= VINCULAR_FALLOS) {
    return res.status(429).json({ error: 'Demasiados códigos equivocados. Espera unos minutos y vuelve a intentarlo.', codigo: 'DEMASIADOS_INTENTOS' });
  }
  res.on('finish', () => {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      lista.push(Date.now());
      if (fallosVincular.size > 5000) fallosVincular.clear();   // no crece sin límite
    }
  });
  next();
}

/** La tablet de este token, o 401. Pone req.negocioId para requireModulo. */
async function tablet(req, res, next) {
  const m = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
  let d = null;
  try {
    d = m ? await C.autenticarDispositivo(m[1]) : null;
  } catch (e) {
    console.error(`[Checador] no se pudo verificar la tablet: ${e.message}`);
    return res.status(503).json({ error: 'No se pudo verificar la tablet. Inténtalo de nuevo.', codigo: 'tablet_no_verificable' });
  }
  if (!d) {
    return res.status(401).json({ error: 'Esta tablet no está autorizada para checar. Pide al administrador un código para vincularla.', codigo: 'tablet_no_autorizada' });
  }
  if (!d.sucursal_activa) {
    return res.status(403).json({ error: `La sucursal «${d.sucursal}» está desactivada: esta tablet no puede checar.`, codigo: 'sucursal_inactiva' });
  }
  req.dispositivo = d;
  req.negocioId = d.negocio_id;
  next();
}

export function registrarRutasChecador(app, { puertas, requireModulo, manejar }) {
  if (!Array.isArray(puertas) || typeof requireModulo !== 'function' || typeof manejar !== 'function') {
    throw new Error('registrarRutasChecador necesita las puertas, requireModulo y manejar');
  }
  const P = '/api/personal/checador';

  // ── Administrador ─────────────────────────────────────────────────────────
  app.get(`${P}/config`, ...puertas, manejar(async (req, res) => {
    res.json(await C.obtenerConfig(req.negocioId));
  }));
  app.put(`${P}/config`, ...puertas, manejar(async (req, res) => {
    res.json(await C.guardarConfig(req.negocioId, req.body, { actorId: req.usuarioId }));
  }));

  app.get(`${P}/dispositivos`, ...puertas, manejar(async (req, res) => {
    res.json({ dispositivos: await C.listarDispositivos(req.negocioId) });
  }));
  // El código de un solo uso viaja SOLO en esta respuesta.
  app.post(`${P}/dispositivos`, ...puertas, manejar(async (req, res) => {
    const r = await C.crearDispositivo(req.negocioId, req.body, { actorId: req.usuarioId });
    sinCache(res);
    res.status(201).json(r);
  }));
  app.post(`${P}/dispositivos/:id/revocar`, ...puertas, manejar(async (req, res) => {
    res.json({ dispositivo: await C.revocarDispositivo(req.negocioId, req.params.id, { actorId: req.usuarioId }) });
  }));

  app.get(`${P}/checadas`, ...puertas, manejar(async (req, res) => {
    const fecha = typeof req.query.fecha === 'string' ? req.query.fecha : undefined;
    res.json(await C.listarChecadas(req.negocioId, { fecha }));
  }));
  app.get(`${P}/checadas/:id/foto`, ...puertas, manejar(async (req, res) => {
    const f = await C.obtenerFoto(req.negocioId, req.params.id);
    res.set('Cache-Control', 'private, no-store');
    res.type(f.mime).send(f.datos);
  }));

  app.get(`${P}/avisos`, ...puertas, manejar(async (req, res) => {
    res.json({ avisos: await C.listarAvisos(req.negocioId, { pendientes: req.query.todos !== 'true' }) });
  }));
  app.post(`${P}/avisos/:id/atender`, ...puertas, manejar(async (req, res) => {
    res.json(await C.atenderAviso(req.negocioId, req.params.id, { actorId: req.usuarioId }));
  }));

  // ── Tablet ────────────────────────────────────────────────────────────────
  // La página no trae datos: todo sale de /api/checador/* con el token.
  app.get('/checador', (req, res) => { res.sendFile(PAGINA); });

  app.post('/api/checador/vincular', limiteVincular, manejar(async (req, res) => {
    const r = await C.vincularDispositivo(req.body?.codigo);
    sinCache(res);
    res.json(r);
  }));

  const conTablet = [tablet, requireModulo('personal')];
  app.get('/api/checador/estado', ...conTablet, manejar(async (req, res) => {
    const d = req.dispositivo;
    const config = await C.obtenerConfig(d.negocio_id);
    sinCache(res);
    res.json({ ahora: new Date().toISOString(), dispositivo: { nombre: d.nombre, sucursal: d.sucursal, negocio: d.negocio },
      foto_al_checar: config.foto_al_checar });
  }));
  app.post('/api/checador/identificar', ...conTablet, manejar(async (req, res) => {
    const r = await C.identificar(req.dispositivo, req.body);
    sinCache(res);
    res.json(r);
  }));
  app.post('/api/checador/checar', ...conTablet, manejar(async (req, res) => {
    const r = await C.checar(req.dispositivo, req.body);
    sinCache(res);
    res.status(r.repetida ? 200 : 201).json(r);
  }));
}
