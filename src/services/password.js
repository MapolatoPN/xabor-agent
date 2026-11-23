// ─── Hashing de contraseñas (Fase 3) ────────────────────────────────────────
// Se usa scrypt de node:crypto en vez de agregar bcrypt como dependencia
// nueva — scrypt es al menos igual de seguro (más resistente a ataques por
// GPU que bcrypt) y ya viene incluido en Node, sin necesidad de npm install
// dentro del repositorio. Formato de almacenamiento: "<salt_hex>:<hash_hex>".
// Nunca se guarda ni se loguea la contraseña en texto plano.

import { scryptSync, scrypt, randomBytes, timingSafeEqual } from 'crypto';

const KEYLEN = 64;

// scrypt en el pool de hilos de libuv (Fase 1, bloque 2): scryptSync congela el
// proceso mientras calcula, y una ráfaga de intentos de login frenaba a todos
// los negocios a la vez. Las comprobaciones que puede disparar alguien de
// afuera (login, PIN) usan las versiones async; mismo formato y mismo resultado.
function scryptAsync(texto, salt) {
  return new Promise((resolve, reject) => {
    scrypt(texto, salt, KEYLEN, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

async function coincideAsync(texto, storedHash) {
  const [salt, hash] = String(storedHash).split(':');
  if (!salt || !hash) return false;
  const esperado = Buffer.from(hash, 'hex');
  const calculado = await scryptAsync(texto, salt);
  return esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
}

// Hash con el que se compara cuando el correo no existe o la cuenta está
// inactiva: el login tarda lo mismo exista o no el correo. Nadie conoce su
// contraseña (sal y texto aleatorios, de este proceso).
const HASH_SEÑUELO = (() => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(randomBytes(32).toString('hex'), salt, KEYLEN).toString('hex')}`;
})();

// Nunca lanza. Sin hash (correo inexistente) calcula igual contra el señuelo
// y devuelve false: mismo trabajo, mismo tiempo.
export async function verifyPasswordAsync(password, storedHash) {
  try {
    if (!password || typeof password !== 'string') return false;
    if (!storedHash) { await coincideAsync(password, HASH_SEÑUELO); return false; }
    return await coincideAsync(password, storedHash);
  } catch {
    return false;
  }
}

export function hashPassword(password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

// Nunca lanza — una contraseña o hash mal formado simplemente no valida.
export function verifyPassword(password, storedHash) {
  try {
    if (!password || !storedHash) return false;
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const hashBuf = Buffer.from(hash, 'hex');
    const testBuf = scryptSync(password, salt, KEYLEN);
    if (hashBuf.length !== testBuf.length) return false;
    return timingSafeEqual(hashBuf, testBuf);
  } catch {
    return false;
  }
}

// ─── PIN de acceso local (meseros) ──────────────────────────────────────────
// Mismo primitivo que las contraseñas (scrypt con salt por registro), otra
// política de longitud: un PIN de mostrador son 4-6 dígitos. No se guarda ni
// se transmite nunca en claro, y vive en usuarios.pin_hash — separado de
// password_hash para que un PIN jamás sirva para iniciar sesión.
export function pinValido(pin) {
  return typeof pin === 'string' && /^[0-9]{4,6}$/.test(pin);
}

export function hashPin(pin) {
  if (!pinValido(pin)) throw new Error('El PIN debe tener entre 4 y 6 dígitos');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, KEYLEN).toString('hex')}`;
}

// Versión async de verifyPin (mismo resultado). Nunca lanza.
export async function verifyPinAsync(pin, storedHash) {
  try {
    if (!pinValido(pin) || !storedHash) return false;
    return await coincideAsync(pin, storedHash);
  } catch {
    return false;
  }
}

// Nunca lanza: un PIN o hash mal formado simplemente no valida.
export function verifyPin(pin, storedHash) {
  try {
    if (!pinValido(pin) || !storedHash) return false;
    const [salt, hash] = String(storedHash).split(':');
    if (!salt || !hash) return false;
    const esperado = Buffer.from(hash, 'hex');
    const calculado = scryptSync(pin, salt, KEYLEN);
    return esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
  } catch {
    return false;
  }
}
