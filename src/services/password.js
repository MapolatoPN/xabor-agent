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
