// Número consecutivo por sucursal (migración 136): OB-152, además del folio
// XAB-, que sale de una secuencia compartida por todos los negocios.
//
// El número lo pone el trigger trg_zz_numero_sucursal al insertar en
// pedidos_activos; aquí solo se LEE, para que la Caja pueda decir qué números
// se dieron en el día y explicar cada uno que no aparezca en la lista.
//
// Nada de esto puede tumbar el corte: ante cualquier error se devuelve null
// (o la parte que sí se pudo leer) y el corte sigue igual que sin numeración.
import { pool } from './database.js';

export const CLAVE_ACTIVO = 'numero_sucursal_activo';
export const CLAVE_PREFIJO = 'numero_sucursal_prefijo';
// Tope de renglones que se explican: un día normal tiene 0 o 1.
const LIMITE = 50;

/** Letras del prefijo: solo A-Z y dígitos, hasta 4. Vacío → null. */
export function normalizarPrefijo(valor) {
  const p = String(valor ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return p || null;
}

/** El número de la fila, solo si es un entero positivo. */
export function numeroDeFila(v) {
  const n = Number(v?.numero_sucursal);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Lo que la Caja necesita de la numeración del día.
 *
 * `filas` son todas las filas de pedidos_activos del día (las que se listan:
 * cobradas, por cobrar y canceladas), con `folio` y `numero_sucursal`.
 *
 * Los números del día son los que se ASIGNARON ese día (ledger). No se usa el
 * created_at del pedido: un programado conserva la fecha de su reserva y se
 * numera al activarse, días después.
 *
 * Devuelve null si la sucursal no tiene la numeración encendida ni dio números
 * ese día (no hay nada que enseñar).
 */
export async function numeracionDelDia(negocioId, { inicio, fin, tz, filas }) {
  let config;
  try {
    const { rows } = await pool.query(
      `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2::text[])`,
      [negocioId, [CLAVE_ACTIVO, CLAVE_PREFIJO]]);
    config = new Map(rows.map(r => [r.clave, r.valor]));
  } catch (e) {
    console.error('[Corte] No se pudo leer la configuración de la numeración:', e.message);
    return null;
  }
  const activa = String(config.get(CLAVE_ACTIVO) ?? '').trim().toLowerCase() === 'true';
  const prefijo = normalizarPrefijo(config.get(CLAVE_PREFIJO));

  let asignados;
  try {
    ({ rows: asignados } = await pool.query(
      `SELECT l.numero, l.folio,
              (pa.folio IS NOT NULL) AS existe,
              pa.estado,
              -- La fecha del día en que SÍ aparece, en la zona del negocio.
              -- created_at no tiene zona: guarda la hora UTC.
              to_char((pa.created_at AT TIME ZONE 'UTC') AT TIME ZONE $4, 'YYYY-MM-DD') AS fecha_pedido
         FROM pedido_numeros_sucursal l
         LEFT JOIN pedidos_activos pa ON pa.folio = l.folio AND pa.negocio_id = l.negocio_id
        WHERE l.negocio_id = $1 AND l.asignado_at >= $2 AND l.asignado_at < $3
        ORDER BY l.numero`,
      [negocioId, inicio.toISOString(), fin.toISOString(), tz]));
  } catch (e) {
    // Sin la 136 la tabla no existe: es lo mismo que no tener numeración.
    console.error('[Corte] No se pudo leer la numeración por sucursal:', e.message);
    return null;
  }
  if (!activa && !asignados.length) return null;

  const foliosDelDia = new Set((filas || []).map(f => f.folio));
  const resultado = {
    activa, prefijo,
    desde: null, hasta: null, asignados: asignados.length,
    faltantes: [], faltantes_total: 0,
    sin_numero: [], sin_numero_total: 0,
  };

  if (asignados.length) {
    resultado.desde = asignados[0].numero;
    resultado.hasta = asignados[asignados.length - 1].numero;
    const porNumero = new Map(asignados.map(a => [a.numero, a]));
    const faltan = [];
    for (let n = resultado.desde; n <= resultado.hasta; n++) {
      const a = porNumero.get(n);
      // Un número sin renglón en el ledger no debería existir (contador y
      // ledger se escriben en la misma transacción): si aparece, se enseña.
      if (!a) { faltan.push({ numero: n, folio: null, motivo: 'sin_registro' }); continue; }
      if (foliosDelDia.has(a.folio)) continue;
      faltan.push(a.existe
        // Está, pero en la lista de otro día: un programado conserva la fecha
        // de su reserva.
        ? { numero: n, folio: a.folio, motivo: 'otro_dia', fecha: a.fecha_pedido || null }
        // Ya no está en pedidos_activos: se borró.
        : { numero: n, folio: a.folio, motivo: 'eliminado' });
    }
    resultado.faltantes_total = faltan.length;
    resultado.faltantes = faltan.slice(0, LIMITE);
  }

  // Pedidos del día que se quedaron SIN número con la numeración encendida (el
  // trigger nunca rechaza un pedido: si algo falla, lo guarda sin número). Solo
  // los posteriores a encenderla: los de antes no se numeran, a propósito.
  if (activa) {
    try {
      const { rows } = await pool.query(
        `SELECT pa.folio
           FROM pedidos_activos pa
          WHERE pa.negocio_id = $1 AND pa.created_at >= $2 AND pa.created_at < $3
            AND (to_jsonb(pa)->>'numero_sucursal') IS NULL
            AND pa.created_at >= (SELECT c.updated_at AT TIME ZONE 'UTC' FROM configuracion c
                                   WHERE c.negocio_id = $1 AND c.clave = $4)
          ORDER BY pa.created_at`,
        [negocioId, inicio.toISOString(), fin.toISOString(), CLAVE_ACTIVO]);
      resultado.sin_numero_total = rows.length;
      resultado.sin_numero = rows.slice(0, LIMITE).map(r => r.folio);
    } catch (e) {
      console.error('[Corte] No se pudo revisar los pedidos sin número:', e.message);
    }
  }
  return resultado;
}
