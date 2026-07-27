/**
 * satCredentials.js — Almacenamiento cifrado de credenciales e.firma SAT
 *
 * SEGURIDAD:
 * - La llave privada se almacena cifrada (AES-256-CBC) en la tabla configuracion.
 * - La clave de cifrado se deriva de ADMIN_TOKEN (variable de entorno).
 * - La contraseña del .key NUNCA se almacena — solo se usa al subir para descifrar el .key.
 * - Nunca se loguea la llave privada ni la contraseña.
 */

import crypto from 'crypto';
import { pool } from './database.js';

const ALGORITHM = 'aes-256-cbc';

function derivarClaveCifrado() {
  // Usa PANEL_SECRET como clave base (ya existe en Railway como secret del HMAC de tokens)
  // Fallback a ADMIN_PASSWORD si PANEL_SECRET no está configurado
  const secret = process.env.PANEL_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error('PANEL_SECRET / ADMIN_PASSWORD no configurados en Railway');
  // Deriva 32 bytes deterministas (sha256 con prefijo fijo)
  return crypto.createHash('sha256').update(`xabor-sat-efirma:${secret}`).digest();
}

function cifrar(texto) {
  const key = derivarClaveCifrado();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return { encrypted: encrypted.toString('base64'), iv: iv.toString('base64') };
}

function descifrar(encryptedB64, ivB64) {
  const key = derivarClaveCifrado();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

async function setConfig(clave, valor) {
  await pool.query(
    `INSERT INTO configuracion (clave, valor) VALUES ($1, $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [clave, valor]
  );
}

async function getConfig(clave) {
  const r = await pool.query(`SELECT valor FROM configuracion WHERE clave = $1`, [clave]);
  return r.rows[0]?.valor ?? null;
}

/**
 * Guarda cert (base64 DER) y llave privada PEM cifrada en DB.
 * @param {string} certBase64 - Certificado en base64 DER
 * @param {string} privateKeyPem - Llave privada descifrada en PEM (se cifra antes de guardar)
 * @param {object} certInfo - Metadatos públicos: { serial, rfc, validFrom, validTo, subject }
 */
export async function guardarCredencialesSAT({ certBase64, privateKeyPem, certInfo }) {
  const { encrypted, iv } = cifrar(privateKeyPem);
  await Promise.all([
    setConfig('sat_cert_base64_db', certBase64),
    setConfig('sat_key_encrypted', encrypted),
    setConfig('sat_key_iv', iv),
    setConfig('sat_cert_info', JSON.stringify(certInfo)),
  ]);
}

/**
 * Carga cert y llave privada descifrada desde DB.
 * @returns {{ certBase64: string, privateKeyPem: string } | null}
 */
export async function cargarCredencialesSATdb() {
  const [certBase64, encrypted, iv] = await Promise.all([
    getConfig('sat_cert_base64_db'),
    getConfig('sat_key_encrypted'),
    getConfig('sat_key_iv'),
  ]);
  if (!certBase64 || !encrypted || !iv) return null;
  const privateKeyPem = descifrar(encrypted, iv);
  return { certBase64, privateKeyPem };
}

/**
 * Devuelve solo metadatos públicos del certificado (sin llave) para mostrar en panel.
 * @returns {object | null}
 */
export async function obtenerInfoCertSAT() {
  const val = await getConfig('sat_cert_info');
  return val ? JSON.parse(val) : null;
}

/**
 * Elimina todas las credenciales SAT guardadas en DB.
 */
export async function eliminarCredencialesSAT() {
  await pool.query(
    `DELETE FROM configuracion WHERE clave IN (
      'sat_cert_base64_db', 'sat_key_encrypted', 'sat_key_iv', 'sat_cert_info'
    )`
  );
}
