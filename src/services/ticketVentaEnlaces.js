import { createHmac, timingSafeEqual } from 'node:crypto';

export const DIAS_ENLACE_TICKET = 30;
const VIDA = DIAS_ENLACE_TICKET * 86400;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const folioTicketValido = f => typeof f === 'string' && f.length > 0 && f.length <= 160 && !/[\x00-\x1f\x7f]/.test(f);
export const correoTicketValido = e => typeof e === 'string' && e.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e);
const firma = (texto, secreto) => createHmac('sha256', secreto).update('xabor:ticket-venta:v1\n' + texto).digest();
const clave = env => {
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 24) throw Error('TICKET_SECRETO_NO_DISPONIBLE');
  return env.SESSION_SECRET;
};

// Autoriza exclusivamente un ticket; no es una sesión ni permite consultar
// otros folios. La URL no contiene correo, teléfono, dirección ni importes.
export function crearTokenTicket({ negocioId, folio }, { env = process.env, ahora = Date.now() } = {}) {
  if (!UUID.test(negocioId || '') || !folioTicketValido(folio)) throw Error('TICKET_INVALIDO');
  const iat = Math.floor(ahora / 1000);
  const datos = { v: 1, negocioId, folio, iat, exp: iat + VIDA };
  const texto = Buffer.from(JSON.stringify(datos)).toString('base64url');
  return { token: texto + '.' + firma(texto, clave(env)).toString('base64url'), vence: new Date(datos.exp * 1000).toISOString() };
}

export function verificarTokenTicket(token, { env = process.env, ahora = Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 1024 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
    const [texto, sig] = token.split('.');
    const recibida = Buffer.from(sig, 'base64url'), esperada = firma(texto, clave(env));
    if (recibida.toString('base64url') !== sig || recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;
    const d = JSON.parse(Buffer.from(texto, 'base64url').toString());
    const t = Math.floor(ahora / 1000);
    if (d.v !== 1 || !UUID.test(d.negocioId || '') || !folioTicketValido(d.folio) ||
        !Number.isSafeInteger(d.iat) || !Number.isSafeInteger(d.exp) ||
        d.iat > t + 60 || d.exp <= t || d.exp <= d.iat || d.exp - d.iat > VIDA) return null;
    return d;
  } catch { return null; }
}

export function enlacePublicoTicket(token, env = process.env) {
  const base = new URL(env.PUBLIC_URL || 'https://xabor.mx');
  if (base.username || base.password || (base.protocol !== 'https:' &&
      !(env.NODE_ENV !== 'production' && base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) {
    throw Error('TICKET_URL_NO_DISPONIBLE');
  }
  return new URL('/ticket-compartido/' + encodeURIComponent(token), base.origin).href;
}

export function enlaceWhatsAppTicket({ negocio, folio, enlace }) {
  return 'https://wa.me/?text=' + encodeURIComponent(`Tu ticket de ${negocio}\nFolio: ${folio}\n${enlace}`);
}

export function claveEnvioTicket({ negocioId, folio, email, solicitudId, token }, env = process.env) {
  return 'ticket/' + createHmac('sha256', clave(env)).update(JSON.stringify([negocioId,folio,email,solicitudId,token])).digest('hex');
}
