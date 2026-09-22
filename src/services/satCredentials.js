/**
 * satCredentials.js — Almacenamiento cifrado de credenciales e.firma SAT
 *
 * SEGURIDAD:
 * - La llave privada se almacena cifrada (AES-256-CBC) en la tabla configuracion.
 * - La clave de cifrado se deriva de ADMIN_TOKEN (variable de entorno).
 * - La contraseña del .key NUNCA se almacena — solo se usa al subir para descifrar el .key.
 * - Nunca se loguea la llave privada ni la contraseña.
 *
 * ── POR NEGOCIO, y por qué esto quedó roto hasta ahora ───────────────────
 *
 * `configuracion` tiene `negocio_id` como parte de su llave primaria
 * COMPUESTA `(negocio_id, clave)` — no `clave` sola. Este archivo escribía
 * `INSERT INTO configuracion (clave, valor) ... ON CONFLICT (clave)`, que
 * nunca coincidió con esa restricción: cada llamada a `guardarCredencialesSAT`
 * lanzaba "no unique or exclusion constraint matching the ON CONFLICT
 * specification". La e.firma nunca llegó a guardarse en ningún negocio; lo
 * que sí funcionaba (y sigue funcionando, sin cambios aquí) es la Descarga
 * Masiva por variables de entorno (`SAT_CERT_BASE64`/`SAT_KEY_BASE64`), que
 * es de un solo negocio por diseño y vive en `satClient.js`.
 *
 * Todas las funciones de este archivo exigen `negocioId` ahora, con el mismo
 * contrato que Clip y Facturapi: sin negocio, no hay a quién servir.
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

function requerirNegocioId(negocioId, fn) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error(`${fn}: negocioId requerido`);
  }
  return negocioId.trim();
}

async function setConfig(negocioId, clave, valor) {
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [negocioId, clave, valor]
  );
}

async function getConfig(negocioId, clave) {
  const r = await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2`,
    [negocioId, clave]);
  return r.rows[0]?.valor ?? null;
}

/**
 * Guarda cert (base64 DER) y llave privada PEM cifrada en DB, para UN negocio.
 * @param {string} negocioId
 * @param {string} certBase64 - Certificado en base64 DER
 * @param {string} privateKeyPem - Llave privada descifrada en PEM (se cifra antes de guardar)
 * @param {object} certInfo - Metadatos públicos: { serial, rfc, validFrom, validTo, subject }
 */
export async function guardarCredencialesSAT(negocioId, { certBase64, privateKeyPem, certInfo }) {
  const nid = requerirNegocioId(negocioId, 'guardarCredencialesSAT');
  const { encrypted, iv } = cifrar(privateKeyPem);
  await Promise.all([
    setConfig(nid, 'sat_cert_base64_db', certBase64),
    setConfig(nid, 'sat_key_encrypted', encrypted),
    setConfig(nid, 'sat_key_iv', iv),
    setConfig(nid, 'sat_cert_info', JSON.stringify(certInfo)),
  ]);
}

/**
 * Carga cert y llave privada descifrada desde DB, para UN negocio.
 * @param {string} negocioId
 * @returns {{ certBase64: string, privateKeyPem: string } | null}
 */
export async function cargarCredencialesSATdb(negocioId) {
  const nid = requerirNegocioId(negocioId, 'cargarCredencialesSATdb');
  const [certBase64, encrypted, iv] = await Promise.all([
    getConfig(nid, 'sat_cert_base64_db'),
    getConfig(nid, 'sat_key_encrypted'),
    getConfig(nid, 'sat_key_iv'),
  ]);
  if (!certBase64 || !encrypted || !iv) return null;
  const privateKeyPem = descifrar(encrypted, iv);
  return { certBase64, privateKeyPem };
}

/**
 * Devuelve solo metadatos públicos del certificado (sin llave) para mostrar en panel.
 * @param {string} negocioId
 * @returns {object | null}
 */
export async function obtenerInfoCertSAT(negocioId) {
  const nid = requerirNegocioId(negocioId, 'obtenerInfoCertSAT');
  const val = await getConfig(nid, 'sat_cert_info');
  return val ? JSON.parse(val) : null;
}

/**
 * Elimina las credenciales SAT guardadas en DB de UN negocio. No toca las de
 * ningún otro — antes de la 087/088 esto ni siquiera podía distinguirlos.
 * @param {string} negocioId
 */
export async function eliminarCredencialesSAT(negocioId) {
  const nid = requerirNegocioId(negocioId, 'eliminarCredencialesSAT');
  await pool.query(
    `DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN (
      'sat_cert_base64_db', 'sat_key_encrypted', 'sat_key_iv', 'sat_cert_info'
    )`,
    [nid]
  );
}
