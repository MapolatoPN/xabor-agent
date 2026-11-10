// XECADOR · Cara — cifrado de lo que se guarda de cada cara.
//
// La cara registrada (sus vectores y su foto de referencia) son datos
// biométricos: se guardan cifrados con AES-256-GCM, que además detecta
// cualquier alteración.
//
// La llave se deriva (HKDF) de INTEGRATIONS_ENCRYPTION_KEY, la que ya cifra
// las credenciales de cada negocio, con un propósito propio: un texto cifrado
// de las integraciones no se abre con la llave de las caras ni al revés. Sin
// esa variable, o si no es Base64 de 32 bytes, no se guarda ni se lee ninguna
// cara (fallo cerrado; nunca una llave «de emergencia»).
//
// Cada texto cifrado va atado a su negocio, su empleado y su campo: copiado a
// otro expediente no se abre. Y cada cara guarda la huella de la llave: si la
// variable cambia, las caras anteriores dejan de usarse (se vuelven a
// registrar), en vez de dar errores al checar.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VARIABLE = 'INTEGRATIONS_ENCRYPTION_KEY';
const VERSION = 1;

export class LlaveCaraError extends Error {}

function llave() {
  const crudo = String(process.env[VARIABLE] || '').trim();
  if (!crudo || !/^[A-Za-z0-9+/]+={0,2}$/.test(crudo) || crudo.length % 4 !== 0) {
    throw new LlaveCaraError(`${VARIABLE} falta o no es Base64: no se puede guardar ni leer una cara`);
  }
  const base = Buffer.from(crudo, 'base64');
  if (base.length !== 32) throw new LlaveCaraError(`${VARIABLE} no mide 32 bytes: no se puede guardar ni leer una cara`);
  return Buffer.from(hkdfSync('sha256', base, Buffer.from('xecador'), Buffer.from('xecador-caras-v1'), 32));
}

/** La huella (8 hex) de la llave de hoy, o null si no hay llave. */
export function huellaLlave() {
  try {
    return createHmac('sha256', llave()).update('huella').digest('hex').slice(0, 8);
  } catch {
    return null;
  }
}

const contexto = (negocioId, empleadoId, campo) =>
  Buffer.from(`xecador-cara|${String(negocioId).toLowerCase()}|${String(empleadoId).toLowerCase()}|${campo}`);

/** [versión 1 byte][iv 12][etiqueta 16][cifrado] */
export function cifrarCara(datos, { negocioId, empleadoId, campo }) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llave(), iv);
  c.setAAD(contexto(negocioId, empleadoId, campo));
  const cifrado = Buffer.concat([c.update(datos), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), cifrado]);
}

/** Lanza si la llave no es la misma, si se alteró o si es de otro expediente o campo. */
export function descifrarCara(blob, { negocioId, empleadoId, campo }) {
  const b = Buffer.isBuffer(blob) ? blob : Buffer.from(blob || []);
  if (b.length < 30 || b[0] !== VERSION) throw new LlaveCaraError('Cara cifrada con un formato desconocido');
  const d = createDecipheriv('aes-256-gcm', llave(), b.subarray(1, 13));
  d.setAAD(contexto(negocioId, empleadoId, campo));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]);
}

/** Los vectores de un registro ↔ bytes (JSON con cada vector en Float32 y Base64). */
export function vectoresABytes(vectores) {
  const v = vectores.map((x) => Buffer.from(Float32Array.from(x).buffer).toString('base64'));
  return Buffer.from(JSON.stringify({ v }));
}
export function bytesAVectores(bytes) {
  const { v } = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!Array.isArray(v) || !v.length) throw new Error('Vectores vacíos');
  return v.map((s) => {
    const b = Buffer.from(s, 'base64');
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  });
}
