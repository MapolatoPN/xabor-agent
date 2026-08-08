// ─── Hashing de contraseñas (Fase 3) ────────────────────────────────────────
// Se usa scrypt de node:crypto en vez de agregar bcrypt como dependencia
// nueva — scrypt es al menos igual de seguro (más resistente a ataques por
// GPU que bcrypt) y ya viene incluido en Node, sin necesidad de npm install
// dentro del repositorio. Formato de almacenamiento: "<salt_hex>:<hash_hex>".
// Nunca se guarda ni se loguea la contraseña en texto plano.

import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const KEYLEN = 64;

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
