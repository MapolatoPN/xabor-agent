// XECADOR · índice del PIN (migración 132): checar solo con el PIN.
//
// Para encontrar a un empleado solo con su PIN, sin su número, el servidor
// guarda junto al hash de siempre (scrypt, con sal propia: no se puede buscar
// por él) un índice: el HMAC-SHA-256 del PIN con una llave del servidor,
// atado al negocio. La base lo hace único por negocio, contando las bajas, así
// que dos empleados nunca comparten PIN.
//
// La llave se deriva del secreto de sesión del servidor (como la de las
// checadas sin conexión). Cada índice lleva la huella de la llave con que se
// calculó: si el secreto cambia, los índices viejos dejan de servir pero no se
// pierde nada — esos PIN quedan como «anteriores» y se verifican contra su
// hash, igual que los que se generaron antes de la 132, y el índice se repone
// la primera vez que el empleado checa.
import { createHmac } from 'node:crypto';

const SECRETO = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const LLAVE = createHmac('sha256', SECRETO).update('xecador-pin-indice-v1').digest();

/** Huella (8 hex) de la llave con la que se calculan los índices de hoy. */
export const HUELLA = createHmac('sha256', LLAVE).update('huella').digest('hex').slice(0, 8);

/** El índice del PIN de un empleado de ese negocio. */
export function indicePin(negocioId, pin) {
  // El negocio en minúsculas: el mismo UUID llega igual de la sesión y de la base.
  const h = createHmac('sha256', LLAVE).update(`xecador-pin|${String(negocioId).trim().toLowerCase()}|${pin}`).digest('base64url');
  return `${HUELLA}.${h}`;
}

/** ¿El índice se calculó con la llave de hoy? Si no, es de un PIN «anterior». */
export const indiceVigente = (indice) => typeof indice === 'string' && indice.startsWith(`${HUELLA}.`);

/**
 * El PIN y los que se teclean por error al querer escribirlo: un dígito
 * distinto en cualquier posición o dos dígitos vecinos volteados. Al generar
 * un PIN se descarta si cualquiera de estos ya es de alguien: así un dedazo da
 * «PIN incorrecto», nunca la checada de un compañero.
 */
export function pinesCercanos(pin) {
  const s = String(pin);
  const cercanos = new Set([s]);
  for (let i = 0; i < s.length; i++) {
    for (let d = 0; d <= 9; d++) cercanos.add(s.slice(0, i) + d + s.slice(i + 1));
  }
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] !== s[i + 1]) cercanos.add(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2));
  }
  return [...cercanos];
}
