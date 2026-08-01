/**
 * cifradoIntegraciones.js — Cifrado autenticado de credenciales de
 * integración por negocio (Fase B de WhatsApp multiempresa).
 *
 * Algoritmo: AES-256-GCM (no AES-256-CBC como satCredentials.js) --
 * GCM da confidencialidad Y autenticidad (auth tag) en un solo paso,
 * requisito explícito de esta fase (un auth tag alterado o una clave
 * incorrecta deben fallar cerrado, nunca descifrar "basura" en
 * silencio -- CBC sin un MAC aparte no lo garantiza).
 *
 * Clave: exclusivamente INTEGRATIONS_ENCRYPTION_KEY (variable propia,
 * ya configurada en Railway producción -- ver AUTORIZACIÓN de esta
 * fase). Ya NO se deriva de PANEL_SECRET. Debe ser Base64 de
 * exactamente 32 bytes decodificados (256 bits, tamaño exacto de
 * clave que exige AES-256). Se usa tal cual, sin volver a hashear --
 * un valor de 32 bytes generado con un CSPRNG ya tiene la entropía
 * completa que requiere la clave.
 *
 * Fail-closed: si la variable falta, no es Base64 válido, o no decodifica
 * a exactamente 32 bytes, cada operación de cifrado/descifrado lanza de
 * inmediato -- nunca se genera ni se usa una clave "de emergencia" ni
 * un valor por defecto. Ningún mensaje de error de este módulo imprime
 * el valor de la clave ni de ningún secreto.
 */

import crypto from 'crypto';

const ALGORITMO = 'aes-256-gcm';
const FORMATO_VERSION_ACTUAL = 1;
const LONGITUD_CLAVE_BYTES = 32;
const NOMBRE_VARIABLE = 'INTEGRATIONS_ENCRYPTION_KEY';

function esBase64Valido(s) {
  if (typeof s !== 'string' || !s) return false;
  // Alfabeto Base64 estándar + relleno opcional, longitud múltiplo de 4.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  return true;
}

function obtenerClave() {
  const raw = process.env[NOMBRE_VARIABLE];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${NOMBRE_VARIABLE} no configurada -- no se puede cifrar/descifrar ninguna credencial de integración`);
  }
  const valor = raw.trim();
  if (!esBase64Valido(valor)) {
    throw new Error(`${NOMBRE_VARIABLE} no es Base64 válido`);
  }
  const key = Buffer.from(valor, 'base64');
  // Buffer.from(..., 'base64') es tolerante con basura al final del
  // string -- la validación de esBase64Valido() ya descarta eso, pero
  // el chequeo de longitud exacta es la garantía final: 32 bytes o
  // falla cerrado, nunca se trunca ni se rellena una clave corta/larga.
  if (key.length !== LONGITUD_CLAVE_BYTES) {
    throw new Error(`${NOMBRE_VARIABLE} inválida: se requieren exactamente ${LONGITUD_CLAVE_BYTES} bytes tras decodificar Base64 (se obtuvieron ${key.length})`);
  }
  return key;
}

/**
 * Cifra un texto plano (p. ej. un access_token de Meta).
 * @returns {{ cifrado: string, iv: string, authTag: string, version: number }} todo en base64 salvo version
 */
export function cifrarSecretoIntegracion(textoPlano) {
  if (typeof textoPlano !== 'string' || !textoPlano) {
    throw new Error('cifrarSecretoIntegracion: texto plano vacío o inválido');
  }
  const key = obtenerClave();
  const iv = crypto.randomBytes(12); // 96 bits, tamaño recomendado para GCM
  const cipher = crypto.createCipheriv(ALGORITMO, key, iv);
  const cifrado = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cifrado: cifrado.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    version: FORMATO_VERSION_ACTUAL,
  };
}

/**
 * Descifra. Lanza si el auth tag no valida (dato alterado) o si la
 * clave es incorrecta -- nunca devuelve un resultado parcial o
 * silenciosamente incorrecto.
 */
export function descifrarSecretoIntegracion({ cifrado, iv, authTag, version }) {
  if (!cifrado || !iv || !authTag) {
    throw new Error('descifrarSecretoIntegracion: faltan campos cifrado/iv/authTag');
  }
  if (version !== FORMATO_VERSION_ACTUAL) {
    // Punto de extensión para una futura migración de formato/clave --
    // hoy solo existe la versión 1, cualquier otra falla cerrado.
    throw new Error(`descifrarSecretoIntegracion: versión de formato no soportada (${version})`);
  }
  const key = obtenerClave();
  const decipher = crypto.createDecipheriv(ALGORITMO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  // Si el auth tag no valida o la clave es incorrecta, decipher.final()
  // lanza -- nunca devuelve texto parcial ni "basura" silenciosa.
  const textoPlano = Buffer.concat([
    decipher.update(Buffer.from(cifrado, 'base64')),
    decipher.final(),
  ]);
  return textoPlano.toString('utf8');
}
