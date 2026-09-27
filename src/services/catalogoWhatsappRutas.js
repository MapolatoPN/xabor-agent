// Rutas del panel para el catálogo de WhatsApp (Menú › Productos para
// WhatsApp). El negocio SIEMPRE sale de la sesión firmada (`req.negocioId`);
// un negocioId en el cuerpo, la query o una cabecera se ignora. Solo el
// administrador del negocio publica.
//
// Por eso la puerta es `requireSesionNegocio('admin')` y no `requireAuthSeguro`:
// este último conserva una rama legada (token estático + cabecera
// `x-negocio-slug`) en la que el negocio lo elige quien hace la petición.
import { fileURLToPath } from 'node:url';
import {
  listarProductosWhatsapp, publicarProductosWhatsapp, publicarCategoriaWhatsapp,
} from './catalogoWhatsapp.js';

const PAGINA = fileURLToPath(new URL('../../panel/catalogo-whatsapp.html', import.meta.url));

const soloAdministrador = (req, res, next) => {
  if (req.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador del negocio puede cambiar el catálogo de WhatsApp' });
  }
  return next();
};

export function registrarRutasCatalogoWhatsapp(app, { requireSesionNegocio, requireModulo }) {
  if (typeof requireSesionNegocio !== 'function') {
    throw new Error('registrarRutasCatalogoWhatsapp: requiere requireSesionNegocio (sesión firmada)');
  }
  const gate = [requireSesionNegocio('admin'), requireModulo('whatsapp'), soloAdministrador];

  // La página es independiente del panel (sin WebSocket ni impresión) y no
  // lleva datos: todo llega por las rutas de abajo, que exigen la sesión.
  app.get('/catalogo-whatsapp', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(PAGINA);
  });

  app.get('/api/admin/whatsapp/productos', ...gate, async (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json({ productos: await listarProductosWhatsapp(req.negocioId) });
    } catch (e) {
      console.error('[Catalogo WA] listar:', e.message);
      res.status(500).json({ error: 'No pudimos cargar el catálogo de WhatsApp' });
    }
  });

  app.post('/api/admin/whatsapp/productos/publicar', ...gate, async (req, res) => {
    try {
      const r = await publicarProductosWhatsapp(req.negocioId, req.body?.productoIds, req.body?.publicado,
        { actor: req.usuarioId || null });
      res.json({ ok: true, ...r });
    } catch (e) {
      if (e.codigo === 'PUBLICACION_INVALIDA') return res.status(400).json({ error: e.message, codigo: e.codigo });
      console.error('[Catalogo WA] publicar productos:', e.message);
      res.status(500).json({ error: 'No pudimos guardar el catálogo de WhatsApp' });
    }
  });

  app.post('/api/admin/whatsapp/categorias/publicar', ...gate, async (req, res) => {
    try {
      const r = await publicarCategoriaWhatsapp(req.negocioId, req.body?.categoriaId, req.body?.publicado,
        { actor: req.usuarioId || null });
      res.json({ ok: true, ...r });
    } catch (e) {
      if (e.codigo === 'PUBLICACION_INVALIDA') return res.status(400).json({ error: e.message, codigo: e.codigo });
      console.error('[Catalogo WA] publicar categoría:', e.message);
      res.status(500).json({ error: 'No pudimos guardar el catálogo de WhatsApp' });
    }
  });
}
