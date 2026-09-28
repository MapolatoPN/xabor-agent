// Historial de pedidos cerrados (entregados y cancelados) por días del negocio.
//
// Antes el panel pedía «los últimos 100 por última edición»: sin fechas, y un
// pedido viejo al que se le corregía la forma de pago saltaba al principio con
// la hora de la corrección. Ahora se pide un rango de días operativos (en la
// zona del negocio, igual que la Caja) y se ordena por la hora de la venta.
//
// El servidor solo agrega lo que el navegador no puede saber por su cuenta:
//   · _creado_at: la hora de la venta, en UTC con zona (la columna es
//     timestamp sin zona y guarda UTC; leída en otra zona se corre).
//   · _cancelado_por_nombre: quién canceló, cuando el pedido lo registró.
//   · _cuenta: renglones de la cuenta de mesa detrás de una venta RM-, para
//     distinguir «sin consumo» de «se cancelaron los productos» sin tener que
//     adivinar desde datos.items (que ya viene sin los cancelados).
// Cómo se agrupa y se rotula cada renglón lo decide el panel.
import { pool } from './database.js';
import { rangoUtcDeFecha, esFechaValida } from './cortesCaja.js';

export const HISTORIAL_MAX_DIAS = 62;
export const HISTORIAL_MAX_FILAS = 1000;

const DIA_MS = 24 * 60 * 60 * 1000;

export function diasDelRango(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS) + 1;
}

function sumarDias(fecha, dias) {
  const d = new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * Rango de días de un periodo con nombre, a partir del «hoy» operativo del
 * negocio (que decide el servidor con la zona del negocio, no el navegador).
 * Devuelve null si el periodo no existe.
 */
export function rangoDePeriodo(periodo, hoy) {
  switch (String(periodo)) {
    case 'hoy': return { desde: hoy, hasta: hoy };
    case 'ayer': { const a = sumarDias(hoy, -1); return { desde: a, hasta: a }; }
    case '7': return { desde: sumarDias(hoy, -6), hasta: hoy };
    case '30': return { desde: sumarDias(hoy, -29), hasta: hoy };
    default: return null;
  }
}

/** Valida el rango pedido; devuelve un mensaje de error o null. */
export function errorDeRango(desde, hasta) {
  if (!esFechaValida(desde) || !esFechaValida(hasta)) return 'Fechas inválidas: usa AAAA-MM-DD';
  if (desde > hasta) return 'La fecha inicial es posterior a la final';
  if (diasDelRango(desde, hasta) > HISTORIAL_MAX_DIAS) return `El rango máximo es de ${HISTORIAL_MAX_DIAS} días`;
  return null;
}

export async function obtenerHistorialPedidos({ negocioId, desde = null, hasta = null, tz = null, limite = HISTORIAL_MAX_FILAS } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const nid = negocioId.trim();
  const tope = Math.max(1, Math.min(Number(limite) || HISTORIAL_MAX_FILAS, HISTORIAL_MAX_FILAS));
  const params = [nid, tope];
  let filtroFechas = '';
  if (desde && hasta && tz) {
    const inicio = rangoUtcDeFecha(desde, tz).inicio;
    const fin = rangoUtcDeFecha(hasta, tz).fin;
    // Cadenas ISO, nunca Date: contra una columna sin zona, node-pg mandaría
    // la hora local de la máquina y el rango se correría.
    params.push(inicio.toISOString(), fin.toISOString());
    filtroFechas = 'AND pa.created_at >= $3 AND pa.created_at < $4';
  }
  const { rows } = await pool.query(`
    SELECT pa.folio, pa.estado, pa.datos, pa.updated_at,
           (pa.created_at AT TIME ZONE 'UTC') AS creado_at,
           u.nombre AS cancelado_por_nombre,
           ci.n, ci.cancelados, ci.monto_cancelado
      FROM pedidos_activos pa
      LEFT JOIN usuarios u ON u.id::text = pa.datos->'cancelacion'->>'por'
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE i.estado = 'cancelado')::int AS cancelados,
               COALESCE(SUM(i.cantidad * i.precio_unitario) FILTER (WHERE i.estado = 'cancelado'), 0)::float AS monto_cancelado
          FROM restaurante_cuentas c
          JOIN restaurante_cuenta_items i ON i.cuenta_id = c.id
         WHERE pa.folio LIKE 'RM-%' AND c.negocio_id = pa.negocio_id AND c.venta_folio = pa.folio
      ) ci ON TRUE
     WHERE pa.negocio_id = $1
       AND pa.estado IN ('entregado', 'cancelado')
       ${filtroFechas}
     ORDER BY pa.created_at DESC
     LIMIT $2
  `, params);
  return rows.map(r => ({
    ...r.datos,
    entregado_at: r.updated_at,
    _estado: r.estado,
    _creado_at: r.creado_at,
    ...(r.cancelado_por_nombre ? { _cancelado_por_nombre: r.cancelado_por_nombre } : {}),
    ...(String(r.folio).startsWith('RM-') ? { _cuenta: { n: r.n, cancelados: r.cancelados, monto_cancelado: r.monto_cancelado } } : {}),
  }));
}
