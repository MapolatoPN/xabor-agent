// Plazo para facturar una venta (fase 2 de facturación, aprobada por Mario el
// 23-oct).
//
// Por omisión una venta se factura hasta el último día de su mes, en la zona
// del negocio; el negocio puede cambiarlo a N días. Vencido el plazo, la venta
// ya no se factura sola: va en la factura global. Las ventas anteriores a
// `global_desde` (noviembre de 2026) las declara el contador en su global.
//
// Las cuentas de fechas se hacen en SQL con la zona del negocio: así el último
// día del mes no depende de la zona del servidor ni del navegador.
import { pool } from './database.js';
import { zonaHorariaNegocio } from './cortesCaja.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const GLOBAL_DESDE_POR_OMISION = '2026-11-01';

/**
 * Expresión SQL con el instante (hora local, sin zona) en que vence el plazo
 * de una venta. `venta` es una expresión timestamptz; `tz`, `tipo` y `dias`
 * son los marcadores de parámetro ($n) con la zona y la configuración.
 */
export function sqlLimitePlazo(venta, { tz, tipo, dias }) {
  return `(CASE WHEN ${tipo} = 'dias' AND COALESCE(${dias}::int, 0) > 0
              THEN ((${venta}) AT TIME ZONE ${tz}) + make_interval(days => ${dias}::int)
              ELSE date_trunc('month', (${venta}) AT TIME ZONE ${tz}) + interval '1 month' END)`;
}

/** Zona y configuración del plazo de un negocio, con sus valores por omisión. */
export async function configPlazo(negocioId, { db = pool } = {}) {
  const [tz, { rows: [c] }] = await Promise.all([
    zonaHorariaNegocio(negocioId),
    db.query(`SELECT plazo_tipo, plazo_dias, to_char(global_desde, 'YYYY-MM-DD') AS global_desde
                FROM facturacion_configuracion WHERE negocio_id=$1`, [negocioId]),
  ]);
  return {
    tz,
    tipo: c?.plazo_tipo === 'dias' ? 'dias' : 'fin_de_mes',
    dias: c?.plazo_tipo === 'dias' ? Number(c.plazo_dias) || null : null,
    globalDesde: c?.global_desde || GLOBAL_DESDE_POR_OMISION,
  };
}

/**
 * Plazo de una venta: { ventaAt, ultimoDia ('AAAA-MM-DD'), vencido,
 * antesDeGlobalXabor }, o null si no hay venta con ese folio en el negocio.
 */
export async function plazoDeVenta(negocioId, folio, { db = pool } = {}) {
  const cfg = await configPlazo(negocioId, { db });
  const limite = sqlLimitePlazo('v.venta', { tz: '$3', tipo: '$4', dias: '$5' });
  const { rows: [r] } = await db.query(
    `WITH v AS (
       SELECT COALESCE(p.created_at, pp.created_at) AT TIME ZONE 'UTC' AS venta
         FROM (SELECT 1) x
         LEFT JOIN pedidos_activos p ON p.negocio_id=$1 AND upper(p.folio)=upper($2)
         LEFT JOIN pedidos_programados pp ON pp.negocio_id=$1 AND upper(pp.folio)=upper($2)
              AND pp.activado=FALSE AND p.folio IS NULL)
     SELECT v.venta, (now() AT TIME ZONE $3) >= l.limite AS vencido,
            to_char(l.limite - interval '1 microsecond', 'YYYY-MM-DD') AS ultimo_dia,
            ((v.venta AT TIME ZONE $3)::date < $6::date) AS antes_global
       FROM v CROSS JOIN LATERAL (SELECT ${limite} AS limite) l
      WHERE v.venta IS NOT NULL`,
    [negocioId, String(folio || ''), cfg.tz, cfg.tipo, cfg.dias, cfg.globalDesde]);
  if (!r) return null;
  return { ventaAt: r.venta, ultimoDia: r.ultimo_dia, vencido: r.vencido === true, antesDeGlobalXabor: r.antes_global === true };
}

/** 'AAAA-MM-DD' → '31 de octubre de 2026'. */
export function fechaLarga(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia || ''));
  if (!m) return String(dia || '');
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

export function mensajePlazoVencido(ultimoDia) {
  return `El plazo para facturar esta venta venció el ${fechaLarga(ultimoDia)}. Las ventas sin factura de ese periodo van en la factura global del negocio.`;
}

export const MENSAJE_EN_GLOBAL = 'Esta venta ya va en la factura global del negocio y no se puede facturar por separado.';
