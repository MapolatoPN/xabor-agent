// Autofactura nativa de Xabor — superficie PÚBLICA.
//
//   GET  /f/<token>                            -> panel/autofactura.html (plantilla
//                                                 única, sin datos de venta embebidos)
//   GET  /api/autofactura/<token>              -> datos públicos + catálogos; si hay una
//                                                 emisión pendiente, reconcilia con candado
//   POST /api/autofactura/<token>/validar      -> valida y normaliza datos fiscales
//   POST /api/autofactura/<token>/emitir       -> emite el CFDI (motor autofacturaEmision)
//   POST /api/autofactura/<token>/corregir     -> reabre tras un rechazo determinista (400)
//   GET  /api/autofactura/<token>/pdf | /xml   -> proxy del documento timbrado
//
// El token es la ÚNICA autorización: no hay sesión ni cookie, y nunca se
// acepta negocio_id, folio ni factura_id del navegador (el token resuelve
// todo por sí solo). Un token con formato inválido, inexistente, de un
// negocio inactivo o sin el módulo de facturación responde el MISMO 404
// genérico. Las rutas no reconstruyen lógica fiscal: el único motor es
// src/services/autofacturaEmision.js.
//
// Mismo patrón que la tienda pública (tiendaRutasCore.js): rate limit por IP
// con el middleware existente, plantilla estática, JSON por API. Nada de este
// módulo registra tokens, datos fiscales, payloads ni respuestas del proveedor
// en el log; las respuestas fiscales llevan Cache-Control: no-store.
//
// ORDEN DE MONTAJE: server.js llama a registrarRutasAutofactura ANTES del
// `express.json({ limit: '20mb' })` global. Así los POST públicos llevan su
// propio parser con límite REAL de 8 KB (body-parser corta la lectura al
// exceder el límite, con o sin Content-Length, también en chunked) y el
// parser global, al ver el cuerpo ya leído, no vuelve a parsear.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import express from 'express';
import { rateLimitMiddleware } from './rateLimit.js';
import { pool, obtenerConfiguracion, obtenerNombreNegocio, negocioEstaActivo, moduloHabilitado } from './database.js';
import { resolverAutofacturaPorToken, esFormatoTokenValido } from './autofacturaService.js';
import { obtenerPedidoFacturable } from './facturacionService.js';
import { validarDatosFiscales, AVISO_NOMBRE } from './autofacturaFiscal.js';
import { catalogosPublicos } from './catalogosSat.js';
import { emitirAutofactura, reconciliarSiCorresponde, prepararCorreccionAutofactura } from './autofacturaEmision.js';
import { descargarFacturaPDF, descargarFacturaXML } from './facturapi.js';

const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel');
const NO_ENCONTRADA = Object.freeze({ error: 'No encontramos esta liga de facturación.' });
const CUERPO_MAX = '8kb';
const SEGUNDOS_ENTRE_RECONCILIACIONES = 15;

const MENSAJE_ESTADO = Object.freeze({
  expirada: 'Esta liga de facturación ha expirado.',
  revocada: 'Esta liga ya no está disponible.',
  facturada: 'Este consumo ya fue facturado.',
  emitiendo: 'Este consumo se está facturando en este momento.',
  error: 'No pudimos preparar la facturación de este ticket. Contacta al negocio con tu folio.',
});
const DOCUMENTOS = Object.freeze({ pdf: true, xml: true });

// La fecha que ve el cliente es la de la VENTA, no la de la liga: el
// `timestamp` que el pedido trae desde que se capturó (el mismo que imprime
// el ticket) y, si faltara, la fecha de alta de la fila del pedido.
async function fechaDeVenta(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT datos->>'timestamp' AS ts, created_at, entregado_at
       FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (!r) return null;
  const ts = r.ts && !Number.isNaN(Date.parse(r.ts)) ? new Date(r.ts) : null;
  const fecha = ts || r.created_at || r.entregado_at || null;
  return fecha instanceof Date ? fecha.toISOString() : null;
}

// Token -> autofactura visible para el público, o null (404 genérico).
async function resolverParaPublico(token) {
  if (!esFormatoTokenValido(token)) return null;
  const af = await resolverAutofacturaPorToken(token);
  if (!af) return null;
  const [activo, habilitado] = await Promise.all([
    negocioEstaActivo(af.negocioId), moduloHabilitado(af.negocioId, 'facturacion'),
  ]);
  return activo && habilitado ? af : null;
}

async function emisionPublica(af) {
  const { rows: [r] } = await pool.query(
    'SELECT uuid, email_enviado_at, error_codigo, proveedor_status, intento_cerrado_at FROM autofacturas WHERE id=$1', [af.id]);
  return r || {};
}

// Estado público de la liga: `emitiendo` se muestra como `procesando`; una
// `facturada` expone UUID y documentos, nunca factura_id. Un intento cerrado
// como rechazado (400 determinista) se marca `corregible`.
function estadoPublico(af, extra) {
  if (af.estado === 'facturada') {
    return { estado: 'facturada', uuid: extra.uuid || af.uuid || null, documentos: { ...DOCUMENTOS }, email_enviado: Boolean(extra.email_enviado_at) };
  }
  if (af.estado === 'emitiendo') return { estado: 'procesando' };
  if (af.estado === 'error') {
    const corregible = extra.proveedor_status === 'rejected' && Boolean(extra.intento_cerrado_at) && /^FACTURAPI_4\d\d/.test(String(extra.error_codigo || ''));
    return { estado: 'error', corregible };
  }
  return { estado: af.estado };
}

/**
 * Lo que un cliente con la liga puede ver, y nada más. Devuelve
 * `{ status, body }` para que la ruta HTTP y las pruebas compartan la misma
 * lógica. Nunca incluye negocio_id, ids internos, factura_id, intento_key,
 * token, hash, material cifrado, errores internos ni datos fiscales.
 */
export async function consultarAutofacturaPublica(token, { reconciliar = false } = {}) {
  let af = await resolverParaPublico(token);
  if (!af) return { status: 404, body: NO_ENCONTRADA };

  // Emisión pendiente: reconciliación con candado (una consulta al proveedor
  // cada SEGUNDOS_ENTRE_RECONCILIACIONES por liga, no en cada refresh).
  if (reconciliar && af.estado === 'emitiendo') {
    try {
      await reconciliarSiCorresponde(af.id, { minSegundos: SEGUNDOS_ENTRE_RECONCILIACIONES });
    } catch (e) {
      console.warn(`[autofactura] reconciliación desde el portal falló (${e.codigo || 'error'})`);
    }
    af = (await resolverParaPublico(token)) || af;
  }

  const [cfg, nombreNegocio, fecha, extra] = await Promise.all([
    obtenerConfiguracion(af.negocioId), obtenerNombreNegocio(af.negocioId), fechaDeVenta(af.negocioId, af.folio), emisionPublica(af),
  ]);
  const nombre = String(cfg?.nombre || nombreNegocio || '').trim() || null;
  const logo = String(cfg?.logo_url || '').trim();
  return {
    status: 200,
    body: {
      negocio: { nombre, logo_url: /^https:\/\//i.test(logo) ? logo : null },
      folio: af.folio,
      fecha,
      total: af.total,
      ...estadoPublico(af, extra),
      expires_at: af.expiresAt,
      // Catálogos SAT del backend: el portal los consume de aquí, nunca los
      // duplica, y el backend sigue siendo la autoridad al validar.
      catalogos: catalogosPublicos(),
      avisos: { nombre: AVISO_NOMBRE },
    },
  };
}

/**
 * Fase 3: valida y normaliza los datos fiscales de una liga VIGENTE cuya
 * venta sigue siendo facturable con el mismo total. No persiste nada y no
 * llama a Facturapi: devuelve lo que la pantalla de confirmación mostrará.
 */
export async function validarAutofacturaPublica(token, cuerpo) {
  const af = await resolverParaPublico(token);
  if (!af) return { status: 404, body: NO_ENCONTRADA };
  if (af.estado !== 'vigente') {
    return { status: 409, body: { error: MENSAJE_ESTADO[af.estado] || MENSAJE_ESTADO.error, estado: af.estado === 'emitiendo' ? 'procesando' : af.estado } };
  }
  // La venta debe seguir pagada/no cancelada y con el total congelado.
  let pedido;
  try {
    pedido = await obtenerPedidoFacturable(af.negocioId, af.folio);
  } catch (e) {
    if (e?.codigo) return { status: 409, body: { error: 'Esta venta ya no se puede facturar. Contacta al negocio con tu folio.', codigo: 'VENTA_NO_FACTURABLE' } };
    throw e;
  }
  if (Math.round(Number(pedido.total) * 100) / 100 !== af.total) {
    return { status: 409, body: { error: 'El total de la venta cambió y esta liga requiere revisión. Contacta al negocio con tu folio.', codigo: 'TOTAL_CAMBIO' } };
  }
  // Acepta los nombres públicos del portal (cp_fiscal, regimen_fiscal) y los internos.
  const r = validarDatosFiscales(datosFiscalesDelCuerpo(cuerpo || {}));
  if (!r.ok) return { status: 422, body: { ok: false, errores: r.errores } };
  return { status: 200, body: { ok: true, datos: r.datos, venta: { folio: af.folio, total: af.total } } };
}

// El cuerpo del portal usa los nombres públicos (cp_fiscal, regimen_fiscal);
// aquí SOLO se renombran llaves, la validación vive en el motor.
function datosFiscalesDelCuerpo(b) {
  return {
    rfc: b.rfc, nombre: b.nombre ?? b.razon_social, cp: b.cp_fiscal ?? b.cp,
    regimen: b.regimen_fiscal ?? b.regimen, uso_cfdi: b.uso_cfdi, email: b.email,
  };
}

/**
 * Fase 4B: emite el CFDI con el motor. Devuelve `{ status, body }` con la
 * vista pública del resultado; jamás factura_id, intento_key, snapshot ni
 * mensajes del proveedor.
 */
export async function emitirAutofacturaPublica(token, cuerpo) {
  const af = await resolverParaPublico(token);
  if (!af) return { status: 404, body: NO_ENCONTRADA };
  let r;
  try {
    r = await emitirAutofactura({ token, datosFiscales: datosFiscalesDelCuerpo(cuerpo || {}), fuente: 'portal' });
  } catch (e) {
    if (e?.codigo === 'DATOS_FISCALES_INVALIDOS') return { status: 422, body: { ok: false, errores: e.errores || {} } };
    if (e?.codigo === 'AUTOFACTURA_NO_ENCONTRADA') return { status: 404, body: NO_ENCONTRADA };
    if (e?.codigo === 'FORMA_PAGO_NO_DETERMINADA' || e?.codigo === 'IVA_NO_CONFIGURADO' || e?.codigo === 'CONCEPTO_INVALIDO' || e?.codigo === 'TOTAL_NO_FACTURABLE') {
      return { status: 409, body: { ok: false, codigo: 'VENTA_NO_FACTURABLE', error: 'Esta venta no se puede facturar en línea. Contacta al negocio con tu folio.' } };
    }
    if (e?.codigo === 'TOTAL_CAMBIO') return { status: 409, body: { ok: false, codigo: 'TOTAL_CAMBIO', error: 'El total de la venta cambió y esta liga requiere revisión. Contacta al negocio con tu folio.' } };
    if (e?.codigo === 'PEDIDO_NO_ENCONTRADO' || e?.codigo === 'PEDIDO_CANCELADO' || e?.codigo === 'PEDIDO_NO_PAGADO') {
      return { status: 409, body: { ok: false, codigo: 'VENTA_NO_FACTURABLE', error: 'Esta venta ya no se puede facturar. Contacta al negocio con tu folio.' } };
    }
    if (typeof e?.codigo === 'string' && e.codigo.startsWith('AUTOFACTURA_')) {
      const estado = e.codigo.slice('AUTOFACTURA_'.length).toLowerCase();
      return { status: 409, body: { ok: false, codigo: e.codigo, estado, error: MENSAJE_ESTADO[estado] || MENSAJE_ESTADO.error } };
    }
    if (e?.codigo === 'FUENTE_INVALIDA') return { status: 400, body: { ok: false, error: 'Solicitud inválida.' } };
    throw e;
  }
  if (r.estado === 'facturada') {
    const extra = await emisionPublica(af);
    return { status: 200, body: { ok: true, estado: 'facturada', folio: af.folio, uuid: r.uuid || extra.uuid || null, documentos: { ...DOCUMENTOS }, email_enviado: Boolean(r.email_enviado || extra.email_enviado_at) } };
  }
  if (r.estado === 'procesando') {
    if (r.codigo === 'EMISION_EN_CURSO') return { status: 409, body: { ok: false, estado: 'procesando', codigo: 'EMISION_EN_CURSO', folio: af.folio } };
    return { status: 200, body: { ok: true, estado: 'procesando', folio: af.folio } };
  }
  if (r.estado === 'emitiendo') {
    // Resultado desconocido (timeout, red, credenciales, 429, 5xx): el intento
    // sigue en curso y NO se reenvía desde el navegador.
    return { status: r.reintentable ? 503 : 502, body: { ok: false, estado: 'verificando', codigo: 'PROVEEDOR_NO_DISPONIBLE', folio: af.folio, error: 'Estamos verificando el estado de tu factura. No vuelvas a enviarla.' } };
  }
  if (r.estado === 'error') {
    return { status: 409, body: { ok: false, estado: 'error', codigo: 'DATOS_FISCALES_RECHAZADOS', corregible: true, folio: af.folio, error: 'El SAT o el proveedor rechazaron los datos fiscales. Revísalos y vuelve a intentarlo.' } };
  }
  return { status: 500, body: { ok: false, error: 'No pudimos completar la emisión. Intenta de nuevo más tarde.' } };
}

// Documento timbrado resuelto EXCLUSIVAMENTE desde el token.
async function documentoDeAutofactura(token) {
  const af = await resolverParaPublico(token);
  if (!af || af.estado !== 'facturada') return null;
  const { rows: [r] } = await pool.query(
    `SELECT negocio_id, folio, factura_id FROM autofacturas WHERE id=$1 AND estado='facturada' AND factura_id IS NOT NULL`, [af.id]);
  return r || null;
}

export function registrarRutasAutofactura(app) {
  const tope = (env, omision) => {
    const n = parseInt(process.env[env], 10);
    return Number.isFinite(n) && n > 0 ? n : omision;
  };
  const limitePublico = rateLimitMiddleware(
    (req) => `autofactura:${req.ip}`, tope('XABOR_AUTOFACTURA_LIMITE_LECTURA', 60), 60 * 1000);
  const limiteValidar = rateLimitMiddleware(
    (req) => `autofactura-validar:${req.ip}`, tope('XABOR_AUTOFACTURA_LIMITE_VALIDAR', 20), 60 * 1000,
    'Demasiados intentos. Espera un momento e inténtalo de nuevo.');
  // Emitir: más estricto, por IP + huella del token (nunca el token en claro).
  const huella = (t) => createHash('sha256').update(String(t || '')).digest('hex').slice(0, 16);
  const limiteEmitir = rateLimitMiddleware(
    (req) => `autofactura-emitir:${req.ip}:${huella(req.params.token)}`, tope('XABOR_AUTOFACTURA_LIMITE_EMITIR', 5), 60 * 1000,
    'Demasiados intentos de emisión. Espera un momento; si ya enviaste tu factura, no la vuelvas a enviar.');
  const limiteDocumento = rateLimitMiddleware(
    (req) => `autofactura-doc:${req.ip}`, tope('XABOR_AUTOFACTURA_LIMITE_DOCUMENTO', 20), 60 * 1000);

  const sinCache = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); };

  app.get('/f/:token', limitePublico, (req, res) => {
    sinCache(res);
    res.sendFile(join(PANEL_DIR, 'autofactura.html'));
  });

  app.get('/api/autofactura/:token', limitePublico, async (req, res) => {
    sinCache(res);
    try {
      const r = await consultarAutofacturaPublica(req.params.token, { reconciliar: true });
      res.status(r.status).json(r.body);
    } catch (e) {
      // Solo el mensaje del error: nunca el token ni la URL de la petición.
      console.error('[autofactura] consulta pública falló:', e.message);
      res.status(500).json({ error: 'No pudimos consultar esta liga en este momento. Intenta de nuevo más tarde.' });
    }
  });

  // Parser propio con límite real: body-parser deja de leer al superar 8 KB
  // (con Content-Length o en chunked) y levanta `entity.too.large`, que el
  // manejador de abajo convierte en 413 JSON.
  const cuerpoAcotado = express.json({ limit: CUERPO_MAX });
  const cuerpoEsObjeto = (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Cuerpo inválido.' });
    next();
  };

  app.post('/api/autofactura/:token/validar', limiteValidar, cuerpoAcotado, cuerpoEsObjeto, async (req, res) => {
    sinCache(res);
    try {
      const r = await validarAutofacturaPublica(req.params.token, req.body);
      res.status(r.status).json(r.body);
    } catch (e) {
      // Nunca el token ni los datos fiscales capturados.
      console.error('[autofactura] validación pública falló:', e.message);
      res.status(500).json({ error: 'No pudimos validar tus datos en este momento. Intenta de nuevo más tarde.' });
    }
  });

  app.post('/api/autofactura/:token/emitir', limiteEmitir, cuerpoAcotado, cuerpoEsObjeto, async (req, res) => {
    sinCache(res);
    try {
      const r = await emitirAutofacturaPublica(req.params.token, req.body);
      res.status(r.status).json(r.body);
    } catch (e) {
      console.error('[autofactura] emisión pública falló:', e.message);
      res.status(500).json({ ok: false, error: 'No pudimos completar la emisión en este momento. No vuelvas a enviar tus datos: consulta el estado de tu liga más tarde.' });
    }
  });

  app.post('/api/autofactura/:token/corregir', limiteValidar, async (req, res) => {
    sinCache(res);
    try {
      const r = await prepararCorreccionAutofactura(req.params.token);
      res.json({ ok: true, estado: r.estado, folio: r.folio });
    } catch (e) {
      if (e?.codigo === 'AUTOFACTURA_NO_ENCONTRADA') return res.status(404).json(NO_ENCONTRADA);
      if (e?.codigo === 'AUTOFACTURA_NO_CORREGIBLE') return res.status(409).json({ ok: false, codigo: e.codigo, error: e.message });
      console.error('[autofactura] corrección pública falló:', e.message);
      res.status(500).json({ ok: false, error: 'No pudimos reabrir esta liga en este momento.' });
    }
  });

  const servirDocumento = (tipo) => async (req, res) => {
    sinCache(res);
    try {
      const doc = await documentoDeAutofactura(req.params.token);
      if (!doc) return res.status(404).json(NO_ENCONTRADA);
      const buf = tipo === 'pdf'
        ? await descargarFacturaPDF(doc.negocio_id, doc.factura_id)
        : await descargarFacturaXML(doc.negocio_id, doc.factura_id);
      const folioSeguro = String(doc.folio).replace(/[^A-Za-z0-9-]/g, '');
      res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Factura-${folioSeguro}.${tipo}"`);
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error(`[autofactura] descarga ${tipo} falló: ${e.codigo || e.status || e.message}`);
      res.status(502).json({ error: 'No pudimos obtener el documento en este momento. Intenta de nuevo más tarde.' });
    }
  };
  app.get('/api/autofactura/:token/pdf', limiteDocumento, servirDocumento('pdf'));
  app.get('/api/autofactura/:token/xml', limiteDocumento, servirDocumento('xml'));

  // JSON malformado o demasiado grande en cualquier ruta pública de
  // autofactura: respuesta JSON controlada, nunca la página de error por
  // defecto de Express.
  app.use('/api/autofactura', (err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Los datos enviados son demasiado grandes.' });
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'Cuerpo inválido.' });
    next(err);
  });
}
