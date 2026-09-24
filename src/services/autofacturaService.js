// Autofactura nativa de Xabor — fase 1: liga pública por venta (token + modelo).
//
// Facturapi deja de ser quien genera la liga de autofactura (E-Receipts): la
// liga la emite Xabor. Este módulo solo crea, resuelve, renueva y revoca la
// liga; la emisión del CFDI (POST /invoices) es una fase posterior.
//
// Decisiones criptográficas (todas con helpers que YA existen en Xabor):
//   - Token: 32 bytes de crypto.randomBytes (256 bits), base64url, 43 chars.
//     Mismo generador que las invitaciones de usuario (database.js).
//   - Lookup público: SHA-256 hex del token (`token_hash`, UNIQUE). Mismo
//     patrón que invitaciones_usuario.token_hash y terminales.token_hash.
//   - Reimpresión: el token se guarda CIFRADO con AES-256-GCM bajo
//     INTEGRATIONS_ENCRYPTION_KEY (cifradoIntegraciones.js: el mismo helper y
//     formato con que se guardan las credenciales de Meta/Clip/Facturapi).
//     Nunca en claro, nunca con una API key ni un secreto fiscal como clave.
//
// Aislamiento: todo se consulta por negocio_id; el token resuelve por sí
// solo negocio y folio, nunca se acepta un negocioId del navegador.
import { randomBytes, createHash } from 'crypto';
import { pool } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { obtenerPedidoFacturable, normalizarFolioFactura, FacturacionError } from './facturacionService.js';
import { urlPublicaXabor } from './pagosService.js';

export const VIGENCIA_DIAS = 30;
export const ESTADOS_AUTOFACTURA = ['vigente', 'emitiendo', 'facturada', 'expirada', 'revocada', 'error'];
const TOKEN_BYTES = 32;
// 32 bytes en base64url son exactamente 43 caracteres sin relleno.
const TOKEN_FORMATO = /^[A-Za-z0-9_-]{43}$/;

function exigirNegocio(negocioId, fn) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new FacturacionError(`${fn}: negocioId requerido`, 'NEGOCIO_REQUERIDO', 400);
  }
  return negocioId.trim();
}

function exigirFolio(folio) {
  const f = normalizarFolioFactura(folio);
  if (!f) throw new FacturacionError('Folio requerido.', 'FOLIO_REQUERIDO', 400);
  return f;
}

export function generarTokenAutofactura() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashTokenAutofactura(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function esFormatoTokenValido(token) {
  return typeof token === 'string' && TOKEN_FORMATO.test(token);
}

/** La URL pública de la liga, o null si XABOR_URL_PUBLICA/BASE_URL no están. */
export function urlDeAutofactura(token) {
  const base = urlPublicaXabor();
  return base && token ? `${base}/f/${token}` : null;
}

function columnasDeToken(token) {
  const c = cifrarSecretoIntegracion(token);
  return {
    token_hash: hashTokenAutofactura(token),
    token_cifrado: c.cifrado, token_iv: c.iv, token_auth_tag: c.authTag, token_formato_version: c.version,
  };
}

function descifrarToken(fila) {
  return descifrarSecretoIntegracion({
    cifrado: fila.token_cifrado, iv: fila.token_iv, authTag: fila.token_auth_tag, version: fila.token_formato_version,
  });
}

function estadoEfectivo(fila, ahora = Date.now()) {
  if (fila.estado === 'vigente' && fila.expires_at && new Date(fila.expires_at).getTime() <= ahora) return 'expirada';
  return fila.estado;
}

// Lo que puede ver cualquiera que tenga la liga: sin token, sin hash, sin
// material cifrado, sin intento_key.
function vistaPublica(fila) {
  return {
    id: fila.id,
    negocioId: fila.negocio_id,
    folio: fila.folio,
    estado: estadoEfectivo(fila),
    total: Number(fila.total),
    expiresAt: fila.expires_at,
    facturaId: fila.factura_id || null,
    uuid: fila.uuid || null,
    emitidaAt: fila.emitida_at || null,
    fuenteEmision: fila.fuente_emision || null,
    errorCodigo: fila.error_codigo || null,
    createdAt: fila.created_at,
    updatedAt: fila.updated_at,
  };
}

// Lo que ve el personal autorizado (panel/POS): además, la liga para imprimir.
function vistaConLiga(fila, tokenConocido = null) {
  const token = tokenConocido || descifrarToken(fila);
  return { ...vistaPublica(fila), token, url: urlDeAutofactura(token) };
}

async function filaPorVenta(negocioId, folio, client = pool) {
  const { rows: [fila] } = await client.query(
    'SELECT * FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [negocioId, folio]);
  return fila || null;
}

// Persiste la expiración cuando se detecta al leer. Idempotente: solo toca
// filas que siguen 'vigente' y ya vencieron.
async function marcarExpiradaSiVencio(fila) {
  if (estadoEfectivo(fila) !== 'expirada' || fila.estado !== 'vigente') return fila;
  const { rows: [actual] } = await pool.query(
    `UPDATE autofacturas SET estado='expirada'
      WHERE id=$1 AND estado='vigente' AND expires_at <= now() RETURNING *`, [fila.id]);
  return actual || fila;
}

/**
 * Crea la liga de autofactura de una venta PAGADA, o devuelve la que ya
 * existe. Nunca genera una segunda liga para la misma venta: con dos
 * llamadas simultáneas, una inserta y la otra lee la fila ganadora
 * (ON CONFLICT (negocio_id, folio) DO NOTHING).
 *
 *   - venta no encontrada / cancelada / no pagada / total <= 0 -> lanza
 *     (mismos códigos que obtenerPedidoFacturable);
 *   - ya facturada -> se devuelve tal cual (estado 'facturada'), jamás se renueva;
 *   - total de la venta distinto al congelado -> TOTAL_CAMBIO;
 *   - vencida -> se devuelve 'expirada' (renovar es una decisión del personal).
 */
export async function crearOObtenerAutofactura(negocioId, folioEntrada) {
  const nid = exigirNegocio(negocioId, 'crearOObtenerAutofactura');
  const folioPedido = exigirFolio(folioEntrada);
  const pedido = await obtenerPedidoFacturable(nid, folioPedido);
  const folio = pedido.folio;
  const total = Math.round(Number(pedido.total) * 100) / 100;

  const token = generarTokenAutofactura();
  const cols = columnasDeToken(token);
  const { rows: [nueva] } = await pool.query(
    `INSERT INTO autofacturas
       (negocio_id, folio, token_hash, token_cifrado, token_iv, token_auth_tag, token_formato_version,
        total, estado, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'vigente', now() + make_interval(days => $9))
     ON CONFLICT (negocio_id, folio) DO NOTHING
     RETURNING *`,
    [nid, folio, cols.token_hash, cols.token_cifrado, cols.token_iv, cols.token_auth_tag,
      cols.token_formato_version, total, VIGENCIA_DIAS]);
  if (nueva) return { ...vistaConLiga(nueva, token), creada: true };

  // Perdió la carrera o la venta ya tenía liga: se devuelve LA MISMA.
  const existente = await filaPorVenta(nid, folio);
  if (!existente) throw new FacturacionError('No se pudo preparar la liga de autofactura.', 'AUTOFACTURA_NO_DISPONIBLE', 500);
  if (existente.estado === 'facturada') return { ...vistaConLiga(existente), creada: false };
  if (Number(existente.total) !== total) {
    throw new FacturacionError('La venta cambió después de crear su liga de autofactura; requiere revisión.', 'TOTAL_CAMBIO', 409);
  }
  const actual = await marcarExpiradaSiVencio(existente);
  return { ...vistaConLiga(actual), creada: false };
}

/**
 * Resuelve una solicitud PÚBLICA (/f/<token>). El token es la única llave:
 * nunca se acepta negocioId ni folio del cliente. Devuelve null si el token
 * no tiene el formato exacto o no existe; nunca devuelve secretos.
 */
export async function resolverAutofacturaPorToken(token) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!esFormatoTokenValido(t)) return null;
  const { rows: [fila] } = await pool.query(
    'SELECT * FROM autofacturas WHERE token_hash=$1', [hashTokenAutofactura(t)]);
  if (!fila) return null;
  const actual = await marcarExpiradaSiVencio(fila);
  return vistaPublica(actual);
}

/** La liga de una venta, para reimprimirla. Aislada por negocio: ajena -> null. */
export async function obtenerAutofacturaPorVenta(negocioId, folioEntrada) {
  const nid = exigirNegocio(negocioId, 'obtenerAutofacturaPorVenta');
  const folio = exigirFolio(folioEntrada);
  const fila = await filaPorVenta(nid, folio);
  if (!fila) return null;
  const actual = await marcarExpiradaSiVencio(fila);
  return vistaConLiga(actual);
}

/**
 * Renueva la liga (token nuevo, otros VIGENCIA_DIAS). Interna por ahora, sin
 * endpoint. El token anterior deja de resolver en el mismo UPDATE. Nunca
 * renueva una autofactura facturada ni una emisión en curso, y vuelve a
 * exigir que la venta siga siendo facturable con el mismo total.
 */
export async function renovarAutofactura(negocioId, folioEntrada) {
  const nid = exigirNegocio(negocioId, 'renovarAutofactura');
  const folio = exigirFolio(folioEntrada);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [fila] } = await client.query(
      'SELECT * FROM autofacturas WHERE negocio_id=$1 AND folio=$2 FOR UPDATE', [nid, folio]);
    if (!fila) throw new FacturacionError('Esta venta no tiene liga de autofactura.', 'AUTOFACTURA_NO_ENCONTRADA', 404);
    if (fila.estado === 'facturada') throw new FacturacionError('La venta ya fue facturada; su liga no se renueva.', 'AUTOFACTURA_FACTURADA', 409);
    if (fila.estado === 'emitiendo') throw new FacturacionError('La factura de esta venta se está emitiendo.', 'AUTOFACTURA_EN_EMISION', 409);
    const pedido = await obtenerPedidoFacturable(nid, fila.folio);
    if (Number(fila.total) !== Math.round(Number(pedido.total) * 100) / 100) {
      throw new FacturacionError('La venta cambió después de crear su liga de autofactura; requiere revisión.', 'TOTAL_CAMBIO', 409);
    }
    const token = generarTokenAutofactura();
    const cols = columnasDeToken(token);
    const { rows: [renovada] } = await client.query(
      `UPDATE autofacturas
          SET token_hash=$2, token_cifrado=$3, token_iv=$4, token_auth_tag=$5, token_formato_version=$6,
              estado='vigente', expires_at=now() + make_interval(days => $7),
              error_codigo=NULL, error_detalle=NULL
        WHERE id=$1 RETURNING *`,
      [fila.id, cols.token_hash, cols.token_cifrado, cols.token_iv, cols.token_auth_tag,
        cols.token_formato_version, VIGENCIA_DIAS]);
    await client.query('COMMIT');
    return vistaConLiga(renovada, token);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Revoca la liga (p. ej. venta cancelada o devuelta). Una autofactura
 * facturada no se revoca: el CFDI ya existe y el ledger manda.
 */
export async function revocarAutofactura(negocioId, folioEntrada) {
  const nid = exigirNegocio(negocioId, 'revocarAutofactura');
  const folio = exigirFolio(folioEntrada);
  const { rows: [revocada] } = await pool.query(
    `UPDATE autofacturas SET estado='revocada'
      WHERE negocio_id=$1 AND folio=$2 AND estado IN ('vigente','expirada','error')
      RETURNING *`, [nid, folio]);
  if (revocada) return vistaPublica(revocada);
  const fila = await filaPorVenta(nid, folio);
  if (!fila) throw new FacturacionError('Esta venta no tiene liga de autofactura.', 'AUTOFACTURA_NO_ENCONTRADA', 404);
  if (fila.estado === 'facturada') throw new FacturacionError('La venta ya fue facturada; su liga no se revoca.', 'AUTOFACTURA_FACTURADA', 409);
  if (fila.estado === 'emitiendo') throw new FacturacionError('La factura de esta venta se está emitiendo.', 'AUTOFACTURA_EN_EMISION', 409);
  return vistaPublica(fila); // ya estaba revocada: idempotente
}
