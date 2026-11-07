// XECADOR · Checador sin conexión (Parte B3): la hora del servidor firmada y
// el PIN cifrado para el servidor.
//
// ── La hora sin conexión (decisión del dueño, 6-nov-2026) ─────────────────
// No se confía en el reloj de la tablet. Mientras hay internet, cada respuesta
// del servidor trae una REFERENCIA firmada: la hora del servidor, atada a esa
// tablet. La tablet guarda la última y, al perder la conexión, mide el tiempo
// transcurrido con su reloj monotónico (performance.now(), que no se puede
// adelantar ni atrasar a mano). Al sincronizar manda la referencia y el
// transcurrido; el servidor comprueba la firma y calcula la hora oficial. La
// hora del reloj de la tablet viaja aparte, solo para compararla.
//
// ── El PIN sin conexión ────────────────────────────────────────────────────
// Se verifica al sincronizar. Para no guardar PINs legibles en la tablet, la
// tablet lo cifra en el momento con la llave PÚBLICA del servidor (ECDH P-256
// efímero + HKDF-SHA-256 + AES-256-GCM, con la clave de la checada como datos
// asociados): solo el servidor lo puede abrir, y no sirve para otra checada.
// La llave privada no se guarda en ningún lado: se deriva del secreto de
// sesión del servidor. Si ese secreto cambia, los PINs pendientes ya no se
// pueden abrir y esas checadas llegan marcadas «PIN no válido» (no se pierden).
import { createECDH, createHmac, createDecipheriv, hkdfSync, timingSafeEqual } from 'node:crypto';

const SECRETO = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const ORDEN_P256 = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
export const HKDF_SAL = 'xecador';
export const HKDF_INFO = 'xecador-pin-v1';

function escalarPrivado() {
  for (let i = 0; ; i++) {
    const h = createHmac('sha256', SECRETO).update(`xecador-sin-conexion-v1|${i}`).digest();
    const v = BigInt(`0x${h.toString('hex')}`);
    if (v > 0n && v < ORDEN_P256) return h;
  }
}
const ecdh = createECDH('prime256v1');
ecdh.setPrivateKey(escalarPrivado());

/** La llave pública del servidor (punto P-256 sin comprimir, 65 bytes) en base64. */
export const LLAVE_PUBLICA = ecdh.getPublicKey().toString('base64');

/**
 * Abre el PIN que cifró la tablet. Devuelve el texto o null si no se puede
 * (llave equivocada, datos alterados, otra clave de checada).
 */
export function descifrarPin(cifrado, clave) {
  try {
    if (!cifrado || typeof cifrado !== 'object') return null;
    const epk = Buffer.from(String(cifrado.epk || ''), 'base64');
    const iv = Buffer.from(String(cifrado.iv || ''), 'base64');
    const datos = Buffer.from(String(cifrado.ct || ''), 'base64');
    if (epk.length !== 65 || iv.length !== 12 || datos.length < 17 || datos.length > 64) return null;
    const compartido = ecdh.computeSecret(epk);
    const llave = Buffer.from(hkdfSync('sha256', compartido, Buffer.from(HKDF_SAL), Buffer.from(HKDF_INFO), 32));
    const d = createDecipheriv('aes-256-gcm', llave, iv);
    d.setAAD(Buffer.from(String(clave)));
    d.setAuthTag(datos.subarray(datos.length - 16));
    const pin = Buffer.concat([d.update(datos.subarray(0, datos.length - 16)), d.final()]).toString('utf8');
    return /^\d{4,6}$/.test(pin) ? pin : null;
  } catch {
    return null;
  }
}

// ── Referencia de hora firmada ─────────────────────────────────────────────
const firmar = (datos) => createHmac('sha256', SECRETO).update(`xecador-ref|${datos}`).digest('base64url');

/** «<ms>.<firma>»: la hora del servidor ahora, atada a esta tablet. */
export function firmarReferencia(dispositivoId, ahoraMs = Date.now()) {
  return `${ahoraMs}.${firmar(`${dispositivoId}|${ahoraMs}`)}`;
}

/** La hora (ms) de una referencia válida de ESTA tablet, o null. */
export function leerReferencia(dispositivoId, ref) {
  if (typeof ref !== 'string' || ref.length > 120) return null;
  const [ms, firma] = ref.split('.');
  if (!/^\d{12,14}$/.test(ms || '') || !firma) return null;
  const esperada = firmar(`${dispositivoId}|${ms}`);
  if (firma.length !== esperada.length || !timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
  const t = Number(ms);
  return t <= Date.now() + 60000 ? t : null;
}
