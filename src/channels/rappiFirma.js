// Firma del webhook de Rappi. Función pura: sin red, sin base, sin reloj
// propio (el "ahora" se inyecta para poder probar la ventana de tiempo).
//
// Contrato documentado por Rappi (dev-portal, 2026-09-18):
//   Header  Rappi-Signature: t=<timestamp>,sign=<hex>
//   Firma   HMAC-SHA256( secret, `${t}.${payload crudo}` )
//   "Make sure you are taking the payload string in the same format that it
//    arrives in order to avoid any differences in the signature"
//
// Por eso se firma sobre req.rawBody (bytes tal cual llegaron), nunca sobre
// JSON.stringify(req.body): una re-serialización cambia espacios y orden de
// claves y la firma deja de coincidir sin que nada lo explique.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Tolerancia entre el sello del header y el reloj del servidor. Rappi no la
// documenta; cinco minutos es lo habitual para HMAC con timestamp y cubre
// desfases razonables de reloj sin permitir reproducir un webhook viejo.
export const VENTANA_MS = 5 * 60 * 1000;

export function parsearHeaderFirma(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const partes = {};
  for (const trozo of header.split(',')) {
    const i = trozo.indexOf('=');
    if (i <= 0) continue;
    partes[trozo.slice(0, i).trim().toLowerCase()] = trozo.slice(i + 1).trim();
  }
  if (!partes.t || !partes.sign) return null;
  return { t: partes.t, sign: partes.sign.toLowerCase() };
}

export function calcularFirmaRappi(secret, t, rawBody) {
  const cuerpo = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return createHmac('sha256', String(secret))
    .update(`${t}.`)
    .update(cuerpo)
    .digest('hex');
}

/**
 * @returns {{ valida: boolean, motivo: string }}
 *   motivos: 'ok' | 'sin_secreto' | 'sin_header' | 'header_invalido' |
 *            'sin_cuerpo' | 'fuera_de_ventana' | 'no_coincide'
 */
export function verificarFirmaRappi({ header, rawBody, secret, ahoraMs = Date.now(), ventanaMs = VENTANA_MS }) {
  if (typeof secret !== 'string' || !secret) return { valida: false, motivo: 'sin_secreto' };
  if (!header) return { valida: false, motivo: 'sin_header' };
  const p = parsearHeaderFirma(header);
  if (!p) return { valida: false, motivo: 'header_invalido' };
  if (!rawBody || (Buffer.isBuffer(rawBody) && rawBody.length === 0)) return { valida: false, motivo: 'sin_cuerpo' };

  // Rappi manda el sello en segundos o en milisegundos según la versión;
  // se acepta cualquiera de los dos sin adivinar más allá de eso.
  const n = Number(p.t);
  if (!Number.isFinite(n)) return { valida: false, motivo: 'header_invalido' };
  const selloMs = n > 1e12 ? n : n * 1000;
  if (Math.abs(ahoraMs - selloMs) > ventanaMs) return { valida: false, motivo: 'fuera_de_ventana' };

  const esperada = calcularFirmaRappi(secret, p.t, rawBody);
  const a = Buffer.from(esperada, 'hex');
  const b = Buffer.from(p.sign, 'hex');
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) return { valida: false, motivo: 'no_coincide' };
  return { valida: true, motivo: 'ok' };
}
