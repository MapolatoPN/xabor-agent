import { createHash } from 'crypto';
import { validarImagenReal, comprimirImagen } from './imagenes.js';
import { guardarArchivo, leerArchivo, eliminarArchivo } from './almacenamiento.js';
import { rateLimitMiddleware } from './rateLimit.js';
import { extraerTicketConIA, CATEGORIAS_COMPRA } from './ticketComprasIA.js';
import {
  CompraOperativaError,
  crearBorradorManual, crearBorradorDesdeTicket, actualizarBorrador,
  confirmarCompra, cancelarCompra, obtenerCompra, listarCompras,
  registrarFondo, resumenCompras, obtenerTicketPrivado,
} from './comprasOperativas.js';

function responderError(res, e, contexto) {
  if (e instanceof CompraOperativaError) {
    return res.status(e.status || 400).json({ error: e.message, codigo: e.codigo });
  }
  if (e?.codigo?.startsWith?.('TICKET_')) {
    const status = e.codigo === 'TICKET_IA_ERROR' ? 503 : 400;
    return res.status(status).json({ error: e.message, codigo: e.codigo });
  }
  console.error(`[Compras] ${contexto}:`, e?.message || e);
  return res.status(500).json({ error: 'No se pudo completar la operación' });
}

function bufferDesdeBase64(valor) {
  if (typeof valor !== 'string' || !valor.trim()) throw new CompraOperativaError('No recibimos ninguna foto', 'TICKET_VACIO');
  const limpio = valor.includes(',') ? valor.slice(valor.indexOf(',') + 1) : valor;
  if (!/^[a-zA-Z0-9+/=\s]+$/.test(limpio)) throw new CompraOperativaError('La imagen no es base64 válido', 'TICKET_BASE64_INVALIDO');
  const buffer = Buffer.from(limpio.replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new CompraOperativaError('No recibimos ninguna foto', 'TICKET_VACIO');
  return buffer;
}

function nombreSeguro(v) {
  return String(v || 'ticket').replace(/[\x00-\x1f\x7f"\\/]/g, '_').trim().slice(0, 160) || 'ticket';
}

function soloAdmin(req, res, next) {
  const rol = req.rol || req.role;
  if (rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede registrar fondos de compra' });
  next();
}

/**
 * Registra el módulo de compras sin aceptar negocio_id desde el navegador.
 * `requireAuthSeguro` debe provenir de server.js: ahí se deriva req.negocioId
 * exclusivamente de la sesión/membresía real del usuario.
 */
export function registrarRutasCompras(app, { requireAuthSeguro }) {
  const gate = [requireAuthSeguro];
  const limiteIA = rateLimitMiddleware(req => `compras-ticket:${req.negocioId || req.ip}`, 12, 60 * 1000);

  app.get('/api/admin/compras/categorias', ...gate, (_req, res) => {
    res.json({ categorias: CATEGORIAS_COMPRA });
  });

  app.get('/api/admin/compras/resumen', ...gate, async (req, res) => {
    try { res.json(await resumenCompras(req.negocioId, req.query)); }
    catch (e) { responderError(res, e, 'GET resumen'); }
  });

  app.get('/api/admin/compras', ...gate, async (req, res) => {
    try { res.json(await listarCompras(req.negocioId, req.query)); }
    catch (e) { responderError(res, e, 'GET lista'); }
  });

  app.get('/api/admin/compras/:id', ...gate, async (req, res) => {
    try {
      const compra = await obtenerCompra(req.negocioId, req.params.id);
      if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
      res.json(compra);
    } catch (e) { responderError(res, e, 'GET detalle'); }
  });

  app.get('/api/admin/compras/:id/ticket', ...gate, async (req, res) => {
    try {
      const meta = await obtenerTicketPrivado(req.negocioId, req.params.id);
      if (!meta) return res.status(404).json({ error: 'Esta compra no tiene ticket guardado' });
      const buffer = await leerArchivo(meta.ticket_storage_key);
      res.set('Content-Type', meta.ticket_mime || 'image/jpeg');
      res.set('Content-Disposition', `inline; filename="${nombreSeguro(meta.ticket_nombre)}"`);
      res.set('Cache-Control', 'private, no-store');
      res.send(buffer);
    } catch (e) { responderError(res, e, 'GET ticket'); }
  });

  app.post('/api/admin/compras/manual', ...gate, async (req, res) => {
    try { res.status(201).json(await crearBorradorManual(req.negocioId, req.body || {}, req.usuarioId || null)); }
    catch (e) { responderError(res, e, 'POST manual'); }
  });

  app.post('/api/admin/compras/analizar-ticket', ...gate, limiteIA, async (req, res) => {
    let storageKey = null;
    try {
      const original = bufferDesdeBase64(req.body?.base64);
      const validacion = await validarImagenReal(original);
      if (!validacion.valido) {
        const mensajes = {
          tamano_excedido: 'La foto pesa demasiado', mime_invalido: 'Sube una foto JPG, PNG o WEBP',
          imagen_corrupta: 'La imagen está dañada o incompleta', archivo_vacio: 'No recibimos ninguna foto',
        };
        throw new CompraOperativaError(mensajes[validacion.motivo] || 'Foto inválida', `TICKET_${String(validacion.motivo).toUpperCase()}`,
          validacion.motivo === 'tamano_excedido' ? 413 : 400);
      }

      // Re-encodar elimina EXIF/GPS antes de persistir o mandar la imagen a la IA.
      const comprimida = await comprimirImagen(original, validacion.mime);
      const checksum = createHash('sha256').update(comprimida.buffer).digest('hex');
      storageKey = await guardarArchivo(comprimida.buffer, {
        negocioId: req.negocioId,
        extension: comprimida.extension,
        mimeType: comprimida.mime,
        categoria: 'documento',
      });

      const extraccion = await extraerTicketConIA(comprimida.buffer, comprimida.mime);
      const compra = await crearBorradorDesdeTicket(req.negocioId, extraccion, {
        storageKey,
        mimeType: comprimida.mime,
        checksum,
        nombre: nombreSeguro(req.body?.filename),
      }, req.usuarioId || null);
      storageKey = null; // la compra ya es dueña del archivo
      res.status(201).json({ compra, extraccion });
    } catch (e) {
      // Si falló IA/DB antes de crear el borrador, no dejamos tickets huérfanos.
      if (storageKey) await eliminarArchivo(storageKey).catch(() => {});
      responderError(res, e, 'POST analizar-ticket');
    }
  });

  app.put('/api/admin/compras/:id', ...gate, async (req, res) => {
    try { res.json(await actualizarBorrador(req.negocioId, req.params.id, req.body || {})); }
    catch (e) { responderError(res, e, 'PUT borrador'); }
  });

  app.post('/api/admin/compras/:id/confirmar', ...gate, async (req, res) => {
    try { res.json(await confirmarCompra(req.negocioId, req.params.id)); }
    catch (e) { responderError(res, e, 'POST confirmar'); }
  });

  app.post('/api/admin/compras/:id/cancelar', ...gate, async (req, res) => {
    try { res.json(await cancelarCompra(req.negocioId, req.params.id)); }
    catch (e) { responderError(res, e, 'POST cancelar'); }
  });

  app.post('/api/admin/compras/fondos', ...gate, soloAdmin, async (req, res) => {
    try { res.status(201).json(await registrarFondo(req.negocioId, req.body || {}, req.usuarioId || null)); }
    catch (e) { responderError(res, e, 'POST fondo'); }
  });
}
