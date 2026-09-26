/**
 * formasCobro.js — Formas de cobro configurables del mostrador (POS y Mesas).
 *
 * Diseño aprobado por Mario el 25-sep-2026 («Formas de pago configurables —
 * diseño»). Se entrega en tres fases, cada una desplegable sola:
 *   1. (esta) la tabla y su siembra; la Caja clasifica con la lista y la
 *      ruta de cobro la acepta. Nada visible cambia.
 *   2. la pantalla en Configuración › Pagos y el POS pintando sus botones
 *      desde aquí.
 *   3. Mesas.
 *
 * FIJAS y CONFIGURABLES
 *   Efectivo, terminal, mixto y enlace de pago son fijas: viven en código
 *   porque cada una hace algo más que poner una etiqueta (cambio y arqueo,
 *   reparto del mixto, conciliación con Clip). Las demás son renglones de
 *   `formas_cobro` (migración 097) y se guardan en el pedido por su `clave`.
 *
 * El bot y la tienda en línea NO leen esta lista: una forma que el negocio
 * dé de alta para su mostrador jamás se le ofrece a un cliente.
 */
import { pool } from './database.js';

export const TARJETAS_CAJA = Object.freeze(['tarjeta', 'enlace', 'plataformas', 'otros']);

/**
 * La siembra de la 097, idéntica. Es la lista de un negocio que todavía no
 * tiene renglones (creado entre dos despliegues) y el respaldo si la tabla no
 * se puede leer. Transferencia en Mesas se siembra según metodos_pago; aquí
 * queda en false porque Mesas todavía no lee esta lista (Fase 3).
 */
export const FORMAS_COBRO_INICIALES = Object.freeze([
  Object.freeze({ clave: 'rappi', nombre: 'Rappi', tarjeta_caja: 'plataformas', clave_sat: null,
    en_pos: true, en_mesas: false, activo: true, orden: 10 }),
  Object.freeze({ clave: 'transferencia', nombre: 'Transferencia', tarjeta_caja: 'otros', clave_sat: '03',
    en_pos: true, en_mesas: false, activo: true, orden: 20 }),
  Object.freeze({ clave: 'uber_eats', nombre: 'Uber Eats', tarjeta_caja: 'plataformas', clave_sat: null,
    en_pos: true, en_mesas: false, activo: false, orden: 30 }),
  Object.freeze({ clave: 'didi_food', nombre: 'DiDi Food', tarjeta_caja: 'plataformas', clave_sat: null,
    en_pos: true, en_mesas: false, activo: false, orden: 40 }),
]);

/**
 * Lo que la ruta de cobro acepta SIEMPRE, con lista o sin ella: un cajero
 * nunca se queda sin poder cobrar porque la lista no se pudo leer.
 */
export const FORMAS_COBRO_FIJAS = Object.freeze(['efectivo', 'terminal (tarjeta presente)', 'mixto']);

const copiaInicial = () => FORMAS_COBRO_INICIALES.map(f => ({ ...f }));

/**
 * Todas las formas configurables del negocio, activas o no, en su orden.
 * `origen` dice de dónde salió la lista: 'tabla', 'iniciales' (el negocio
 * aún no tiene renglones) o 'respaldo' (la tabla no se pudo leer).
 */
export async function listarFormasCobro(negocioId, { ejecutor = pool } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  try {
    const { rows } = await ejecutor.query(
      `SELECT clave, nombre, tarjeta_caja, clave_sat, en_pos, en_mesas, activo, orden
         FROM formas_cobro
        WHERE negocio_id = $1
        ORDER BY orden, clave`, [negocioId.trim()]);
    return rows.length ? { filas: rows, origen: 'tabla' } : { filas: copiaInicial(), origen: 'iniciales' };
  } catch (e) {
    console.error('[FormasCobro] No se pudo leer la lista; se usa la inicial:', e.message);
    return { filas: copiaInicial(), origen: 'respaldo' };
  }
}

/**
 * clave → forma, para clasificar ventas (la Caja). Incluye las inactivas:
 * desactivar una forma no le cambia la tarjeta a lo que ya se vendió con ella.
 */
export async function catalogoFormasCobro(negocioId, opciones) {
  const { filas } = await listarFormasCobro(negocioId, opciones);
  return new Map(filas.map(f => [String(f.clave).trim().toLowerCase(), f]));
}

/**
 * Lo que acepta la ruta de cobro del POS: las fijas más las configurables
 * activas con POS. `filas` va de vuelta para explicar un rechazo.
 */
export async function formasCobroDelPOS(negocioId, opciones) {
  const { filas, origen } = await listarFormasCobro(negocioId, opciones);
  const aceptadas = [...FORMAS_COBRO_FIJAS, ...filas.filter(f => f.activo && f.en_pos).map(f => f.clave)];
  return { aceptadas, filas, origen };
}
