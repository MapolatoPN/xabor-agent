import { createHash } from 'crypto';
import { validarImagenReal, comprimirImagen } from './imagenes.js';
import { guardarArchivo, leerArchivo, eliminarArchivo } from './almacenamiento.js';
import { rateLimitMiddleware } from './rateLimit.js';
import { extraerTicketConIA, CATEGORIAS_COMPRA } from './ticketComprasIA.js';
import { crearResponsable, listarResponsables, registrarPagoCompra, revertirMovimiento, uuid } from './comprasFinanzas.js';
import { pool } from './database.js';
import { telefonoComprador } from './comprasWhatsappDialogo.js';
import {
  CompraOperativaError,
  crearBorradorManual, crearBorradorDesdeTicket, actualizarBorrador,
  confirmarCompra, cancelarCompra, obtenerCompra, listarCompras,
  registrarFondo, resumenCompras, obtenerTicketPrivado,
  actualizarFacturaCompra,
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
  if (valor.length > 16 * 1024 * 1024) throw new CompraOperativaError('La foto pesa demasiado', 'TICKET_TAMANO_EXCEDIDO',413);
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
export function registrarRutasCompras(app, { requireAuthSeguro, extraerTicket = extraerTicketConIA }) {
  const gate = [requireAuthSeguro, (req,res,next)=>{
    if (!['admin','staff'].includes(req.rol || req.role)) return res.status(403).json({error:'No tienes acceso a Compras'});
    try { uuid(req.negocioId); next(); } catch(e) { responderError(res,e,'identidad'); }
  }];
  const limiteIA = rateLimitMiddleware(req => `compras-ticket:${req.negocioId || req.ip}`, 12, 60 * 1000);

  app.get('/api/admin/compras/whatsapp', ...gate, soloAdmin, async(req,res)=>{
    try {
      const {rows} = await pool.query(`SELECT a.telefono,a.responsable_id,a.activo,r.nombre
        FROM compras_whatsapp_autorizados a JOIN compras_responsables r ON r.negocio_id=a.negocio_id AND r.id=a.responsable_id
        WHERE a.negocio_id=$1 ORDER BY r.nombre`,[req.negocioId]);
      res.json({autorizados:rows});
    } catch(e){responderError(res,e,'whatsapp autorizados');}
  });
  app.put('/api/admin/compras/whatsapp', ...gate, soloAdmin, async(req,res)=>{
    try {
      const telefono = telefonoComprador(req.body?.telefono), responsable = uuid(req.body?.responsable_id);
      if (!telefono || typeof req.body?.activo!=='boolean') throw new CompraOperativaError('Revisa el número mexicano y el estado de autorización','WHATSAPP_INVALIDO');
      const {rows:[propio]} = await pool.query('SELECT id FROM compras_responsables WHERE negocio_id=$1 AND id=$2',[req.negocioId,responsable]);
      if (!propio) throw new CompraOperativaError('Responsable no encontrado','RESPONSABLE_INVALIDO');
      await pool.query(`INSERT INTO compras_whatsapp_autorizados(negocio_id,telefono,responsable_id,activo,updated_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(negocio_id,telefono) DO UPDATE
        SET responsable_id=excluded.responsable_id,activo=excluded.activo,updated_by=excluded.updated_by,updated_at=now()`,
      [req.negocioId,telefono,responsable,req.body.activo,req.usuarioId || null]);
      res.json({ok:true});
    } catch(e){responderError(res,e,'whatsapp configurar');}
  });

  app.get('/api/admin/compras/categorias', ...gate, (_req, res) => {
    res.json({ categorias: CATEGORIAS_COMPRA });
  });

  app.get('/api/admin/compras/contexto', ...gate, async (req,res)=>{
    try { res.json({rol:req.rol || req.role,responsables:await listarResponsables(req.negocioId)}); }
    catch(e){responderError(res,e,'contexto');}
  });
  app.post('/api/admin/compras/responsables', ...gate, soloAdmin, async (req,res)=>{
    try { res.status(201).json(await crearResponsable(req.negocioId,req.body)); }
    catch(e){responderError(res,e,'responsable');}
  });
  app.post('/api/admin/compras/fondos/:id/revertir', ...gate, soloAdmin, async (req,res)=>{
    try { res.json(await revertirMovimiento(req.negocioId,'fondo',req.params.id,req.body,req.usuarioId)); }
    catch(e){responderError(res,e,'revertir fondo');}
  });
  app.post('/api/admin/compras/pagos/:id/revertir', ...gate, soloAdmin, async (req,res)=>{
    try { res.json(await revertirMovimiento(req.negocioId,'pago',req.params.id,req.body,req.usuarioId)); }
    catch(e){responderError(res,e,'revertir pago');}
  });
  app.post('/api/admin/compras/:id/pagos', ...gate, soloAdmin, async (req,res)=>{
    try { res.status(201).json(await registrarPagoCompra(req.negocioId,req.params.id,req.body,req.usuarioId)); }
    catch(e){responderError(res,e,'pago');}
  });
  app.post('/api/admin/compras/:id/factura', ...gate, soloAdmin, async (req,res)=>{
    try { res.json(await actualizarFacturaCompra(req.negocioId,req.params.id,req.body,req.usuarioId)); }
    catch(e){responderError(res,e,'factura');}
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
      const {rows:repetidos} = await pool.query("SELECT id FROM compras_operativas WHERE negocio_id=$1 AND ticket_checksum=$2 AND estado<>'cancelada'",[req.negocioId,checksum]);
      if (repetidos.length) throw new CompraOperativaError('Este archivo de ticket ya fue registrado en este negocio','TICKET_DUPLICADO',409);
      storageKey = await guardarArchivo(comprimida.buffer, {
        negocioId: req.negocioId,
        extension: comprimida.extension,
        mimeType: comprimida.mime,
        categoria: 'documento',
      });

      const extraccion = await extraerTicket(comprimida.buffer, comprimida.mime);
      if (extraccion.moneda && !['MXN','MX$','$','PESO','PESOS','PESOS MEXICANOS'].includes(String(extraccion.moneda).trim().toUpperCase()))
        throw new CompraOperativaError('Este ticket indica otra moneda. Captura manualmente el importe pagado en pesos mexicanos y anota la conversión.','TICKET_MONEDA_NO_SOPORTADA');
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
    try { res.json(await confirmarCompra(req.negocioId, req.params.id, req.body || {}, req.usuarioId || null)); }
    catch (e) { responderError(res, e, 'POST confirmar'); }
  });

  app.post('/api/admin/compras/:id/cancelar', ...gate, soloAdmin, async (req, res) => {
    try { res.json(await cancelarCompra(req.negocioId, req.params.id, req.body || {}, req.usuarioId || null)); }
    catch (e) { responderError(res, e, 'POST cancelar'); }
  });

  app.post('/api/admin/compras/fondos', ...gate, soloAdmin, async (req, res) => {
    try { res.status(201).json(await registrarFondo(req.negocioId, req.body || {}, req.usuarioId || null)); }
    catch (e) { responderError(res, e, 'POST fondo'); }
  });
}
