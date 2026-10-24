// Factura global de Xabor (fase 3 de facturación; decisiones de Mario del
// 23-oct). Siempre a mano: el administrador elige el mes y los tickets, y
// Xabor timbra una global por forma de pago con exactamente esos recibos
// (POST /receipts/global-invoice).
//
// Qué no entra, con su motivo: pedidos de prueba, cancelados, ya facturados,
// ya en una global, sin cobro, en $0, con el recibo en error o con otro total,
// y los de forma de pago «por definir» (99), que el SAT no acepta en una
// global. Las ventas anteriores a `global_desde` (noviembre de 2026) las
// declara el contador: Xabor no arma globales de esos meses.
//
// Idempotencia:
//   - `solicitud` la genera el panel al abrir la pantalla: repetirla devuelve
//     las mismas globales y no timbra otra vez;
//   - un candado por negocio serializa la preparación, y un índice único
//     impide que un ticket esté en dos globales vivas;
//   - la global se guarda con sus recibos ANTES de llamar a Facturapi. Si la
//     respuesta se pierde queda «por conciliar» y nunca se reintenta a ciegas:
//     se concilia con lo que Facturapi dice del recibo.
import { pool } from './database.js';
import {
  crearFacturaGlobal, obtenerRecibo, obtenerFactura, puedeFacturar, FacturapiNoConfiguradoError,
} from './facturapi.js';
import { FacturapiRitmoError } from './facturapiRitmo.js';
import { FacturacionError, asegurarReciboPedido, obtenerConfiguracionFacturacion } from './facturacionService.js';
import { configPlazo } from './plazoFacturacion.js';
import { formaPagoLegado, formaPagoSatDeVenta, NOMBRES_FORMA_SAT } from './formaPagoSat.js';
import { registrarBitacoraFacturacion, actorDe } from './facturacionDocumentos.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const SOLICITUD = /^[A-Za-z0-9-]{8,64}$/;
const MAX_TICKETS = 5000;           // tope de Facturapi por global
const ESPERA_CONCILIAR_MIN = 10;    // antes de dar por no timbrada una global sin respuesta
const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;
const texto = (v) => String(v || '').trim().toLowerCase();

export const MOTIVOS_EXCLUSION = Object.freeze({
  PRUEBA: 'Pedido de prueba',
  CANCELADA: 'Venta cancelada',
  FACTURADA: 'Ya tiene su factura',
  EN_GLOBAL: 'Ya está en una factura global',
  SIN_COBRAR: 'Sin cobro confirmado',
  SIN_IMPORTE: 'Venta en $0',
  RECIBO_CON_ERROR: 'Su recibo requiere atención',
  TOTAL_CAMBIO: 'El total cambió después de crear su recibo',
  FORMA_POR_DEFINIR: 'Forma de pago por definir (99)',
});

/**
 * Mes de la global en la zona del negocio: fechas locales, instantes de
 * inicio y fin, y si ya se puede hacer (el mes terminó y no es del contador).
 */
export async function periodoGlobal(negocioId, { anio, mes }) {
  const a = Number.parseInt(anio, 10), m = Number.parseInt(mes, 10);
  if (!(a >= 2020 && a <= 2100) || !(m >= 1 && m <= 12)) {
    throw new FacturacionError('Elige el mes de la factura global.', 'PERIODO_INVALIDO');
  }
  const cfg = await configPlazo(negocioId);
  const desde = `${a}-${String(m).padStart(2, '0')}-01`;
  const { rows: [p] } = await pool.query(
    `SELECT to_char(($1::date + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD') AS hasta,
            ($1::date::timestamp AT TIME ZONE $2) AS inicio,
            (($1::date + interval '1 month')::timestamp AT TIME ZONE $2) AS fin,
            (now() AT TIME ZONE $2)::date >= ($1::date + interval '1 month')::date AS terminado,
            $1::date < $3::date AS del_contador`, [desde, cfg.tz, cfg.globalDesde]);
  return {
    anio: a, mes: String(m).padStart(2, '0'), nombre: `${MESES[m - 1]} de ${a}`,
    desde, hasta: p.hasta, inicio: p.inicio, fin: p.fin, tz: cfg.tz,
    terminado: p.terminado, delContador: p.del_contador, globalDesde: cfg.globalDesde,
  };
}

function exigirPeriodoDisponible(periodo) {
  if (periodo.delContador) {
    throw new FacturacionError(`La global de ${periodo.nombre} la hace tu contador: Xabor las hace desde ${periodo.globalDesde}.`, 'PERIODO_DEL_CONTADOR', 409);
  }
  if (!periodo.terminado) {
    throw new FacturacionError(`${periodo.nombre[0].toUpperCase()}${periodo.nombre.slice(1)} todavía no termina.`, 'PERIODO_ABIERTO', 409);
  }
}

const pagada = (estado, d) => d.origen === 'restaurante' || d.pago_confirmado === true
  || (estado === 'entregado' && d.forma_pago !== 'por_cobrar');
const esRappi = (d) => texto(d.canal) === 'rappi' || texto(d.forma_pago) === 'rappi';

/** Por qué una venta no puede entrar, o null si puede. Mismo orden siempre. */
export function motivoExclusion(v) {
  const d = v.datos || {};
  if (['prueba_admin', 'test'].includes(texto(d.canal))) return 'PRUEBA';
  if (v.estado === 'cancelado' || (v.recibo_estado === 'cancelado' && !v.facturada)) return 'CANCELADA';
  if (v.facturada || v.recibo_estado === 'facturado') return 'FACTURADA';
  if (v.recibo_estado === 'global' || v.global_viva) return 'EN_GLOBAL';
  if (!pagada(v.estado, d)) return 'SIN_COBRAR';
  if (!(Number(d.total) > 0)) return 'SIN_IMPORTE';
  if (v.recibo_estado === 'error' && v.recibo_id) return 'RECIBO_CON_ERROR';
  if (v.recibo_total !== null && v.recibo_total !== undefined && Math.abs(Number(v.recibo_total) - Number(d.total)) > 0.005) return 'TOTAL_CAMBIO';
  if (v.forma === '99') return 'FORMA_POR_DEFINIR';
  return null;
}

// Ventas del periodo: las del tablero y las programadas que aún no se
// activan (pagadas por adelantado). Fecha = la de la venta, no la del recibo.
const VENTAS_PERIODO_SQL = `
  WITH ventas AS (
    SELECT DISTINCT ON (upper(folio)) folio, estado, datos, venta_at FROM (
      SELECT folio, estado, datos, created_at AT TIME ZONE 'UTC' AS venta_at, 0 AS prioridad
        FROM pedidos_activos WHERE negocio_id=$1
      UNION ALL
      SELECT folio, COALESCE(NULLIF(datos->>'estado',''),'nuevo'), datos, created_at AT TIME ZONE 'UTC', 1
        FROM pedidos_programados WHERE negocio_id=$1 AND activado=FALSE
    ) x
    WHERE venta_at >= $2 AND venta_at < $3
    ORDER BY upper(folio), prioridad)
  SELECT v.folio, v.estado, v.datos, v.venta_at,
         r.recibo_id, r.estado AS recibo_estado, r.total AS recibo_total, r.forma_pago AS recibo_forma,
         EXISTS (SELECT 1 FROM facturas_pedido f WHERE f.negocio_id=$1 AND upper(f.folio)=upper(v.folio)
                   AND f.factura_id IS NOT NULL AND f.cancelada_at IS NULL) AS facturada,
         (SELECT g.global_id FROM facturacion_global_recibos g
           WHERE g.negocio_id=$1 AND upper(g.folio)=upper(v.folio) AND g.vivo LIMIT 1) AS global_viva
    FROM ventas v
    LEFT JOIN facturacion_recibos r ON r.negocio_id=$1 AND upper(r.folio)=upper(v.folio)
   ORDER BY v.venta_at, v.folio`;

/**
 * Lo que la pantalla de la global necesita: cada venta del mes con su forma
 * de pago SAT, si puede entrar y por qué no, y si va marcada por omisión.
 */
async function ventasDelPeriodo(negocioId, periodo, cfg) {
  const { rows } = await pool.query(VENTAS_PERIODO_SQL, [negocioId, periodo.inicio, periodo.fin]);
  return rows.map((r) => {
    const d = r.datos || {};
    // Un recibo ya creado conserva su forma; uno por crear usa la regla de hoy.
    const forma = r.recibo_forma || (r.recibo_id ? formaPagoLegado(d) : formaPagoSatDeVenta(d, cfg));
    const motivo = motivoExclusion({ ...r, forma });
    return {
      folio: r.folio,
      venta_at: r.venta_at,
      cliente: d.cliente?.nombre || d.nombre_cliente || d.nombre || null,
      canal: d.canal || null,
      forma_texto: d.forma_pago || null,
      forma,
      forma_nombre: NOMBRES_FORMA_SAT[forma] || forma,
      total: dinero(d.total),
      elegible: !motivo,
      motivo,
      motivo_texto: motivo ? MOTIVOS_EXCLUSION[motivo] : null,
      sin_recibo: !motivo && !r.recibo_id,
      marcado: !motivo && !(esRappi(d) && cfg.global_incluir_rappi === false),
    };
  });
}

export async function candidatosGlobal(negocioId, { anio, mes }) {
  if (!negocioId) throw new FacturacionError('Falta el contexto del negocio.', 'NEGOCIO_REQUERIDO', 400);
  const periodo = await periodoGlobal(negocioId, { anio, mes });
  const cfg = await obtenerConfiguracionFacturacion(negocioId);
  const ventas = await ventasDelPeriodo(negocioId, periodo, cfg);
  return {
    periodo: {
      anio: periodo.anio, mes: periodo.mes, nombre: periodo.nombre, desde: periodo.desde, hasta: periodo.hasta,
      disponible: periodo.terminado && !periodo.delContador,
      del_contador: periodo.delContador, terminado: periodo.terminado, global_desde: periodo.globalDesde,
    },
    iva_tasa: cfg.iva_tasa === null || cfg.iva_tasa === undefined ? null : Number(cfg.iva_tasa),
    incluir_rappi: cfg.global_incluir_rappi !== false,
    ventas,
  };
}

async function globalesDeSolicitud(negocioId, solicitud) {
  const { rows } = await pool.query(
    `SELECT * FROM facturacion_globales WHERE negocio_id=$1 AND solicitud=$2 ORDER BY forma_pago`, [negocioId, solicitud]);
  return rows;
}

function vistaGlobal(g) {
  return {
    id: g.id, estado: g.estado, periodicidad: g.periodicidad, mes: g.mes, anio: g.anio,
    desde: g.desde instanceof Date ? g.desde.toISOString().slice(0, 10) : g.desde,
    hasta: g.hasta instanceof Date ? g.hasta.toISOString().slice(0, 10) : g.hasta,
    forma_pago: g.forma_pago, forma_nombre: NOMBRES_FORMA_SAT[g.forma_pago] || g.forma_pago,
    tickets: g.tickets, total: Number(g.total), factura_id: g.factura_id, uuid: g.uuid,
    serie: g.serie, folio_numero: g.folio_numero,
    error_codigo: g.error_codigo, error_detalle: g.error_detalle ? String(g.error_detalle).slice(0, 300) : null,
    created_at: g.created_at, timbrada_at: g.timbrada_at,
  };
}

/**
 * Guarda las globales (una por forma de pago) con sus recibos, bajo el
 * candado del negocio y revalidando cada ticket. La base rechaza repetir la
 * solicitud y meter un ticket en dos globales vivas.
 */
async function prepararGlobales(negocioId, periodo, folios, solicitud, actor) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(`SELECT pg_advisory_xact_lock(hashtextextended('factura-global:' || $1, 0))`, [negocioId]);
    const { rows } = await cliente.query(
      `SELECT r.folio, r.recibo_id, r.estado, r.total, r.forma_pago,
              COALESCE(p.datos, pp.datos) AS datos,
              EXISTS (SELECT 1 FROM facturas_pedido f WHERE f.negocio_id=$1 AND upper(f.folio)=upper(r.folio)
                        AND f.factura_id IS NOT NULL AND f.cancelada_at IS NULL) AS facturada
         FROM facturacion_recibos r
         LEFT JOIN pedidos_activos p ON p.negocio_id=$1 AND upper(p.folio)=upper(r.folio)
         LEFT JOIN pedidos_programados pp ON pp.negocio_id=$1 AND upper(pp.folio)=upper(r.folio) AND pp.activado=FALSE
        WHERE r.negocio_id=$1 AND upper(r.folio) = ANY($2::text[])
        FOR UPDATE OF r`, [negocioId, folios.map((f) => f.toUpperCase())]);
    const porForma = new Map();
    const fallan = [];
    for (const folio of folios) {
      const r = rows.find((x) => x.folio.toUpperCase() === folio.toUpperCase());
      const forma = r ? (r.forma_pago || formaPagoLegado(r.datos || {})) : null;
      if (!r || !r.recibo_id || r.estado !== 'abierto' || r.facturada || !(Number(r.total) > 0) || forma === '99') {
        fallan.push(folio);
        continue;
      }
      if (!porForma.has(forma)) porForma.set(forma, []);
      porForma.get(forma).push(r);
    }
    if (fallan.length) {
      throw Object.assign(new FacturacionError(`Estos tickets cambiaron y ya no pueden entrar: ${fallan.slice(0, 10).join(', ')}${fallan.length > 10 ? '…' : ''}. Vuelve a cargar la lista.`, 'SELECCION_CAMBIO', 409), { rechazos: fallan });
    }
    const globales = [];
    for (const [forma, recibos] of [...porForma.entries()].sort()) {
      const total = dinero(recibos.reduce((s, r) => s + Number(r.total), 0));
      const { rows: [g] } = await cliente.query(
        `INSERT INTO facturacion_globales (negocio_id, solicitud, periodicidad, desde, hasta, mes, anio, forma_pago,
                                           tickets, total, usuario_id, rol)
         VALUES ($1,$2,'month',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [negocioId, solicitud, periodo.desde, periodo.hasta, periodo.mes, periodo.anio, forma,
          recibos.length, total, actor.usuarioId ? String(actor.usuarioId).slice(0, 80) : null, actor.rol || null]);
      for (const r of recibos) {
        await cliente.query(
          `INSERT INTO facturacion_global_recibos (global_id, negocio_id, folio, recibo_id, total) VALUES ($1,$2,$3,$4,$5)`,
          [g.id, negocioId, r.folio, r.recibo_id, r.total]);
      }
      globales.push(g);
    }
    await cliente.query('COMMIT');
    return globales;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505') {
      throw new FacturacionError('Uno de los tickets ya entró en otra factura global. Vuelve a cargar la lista.', 'TICKET_EN_OTRA_GLOBAL', 409);
    }
    throw e;
  } finally {
    cliente.release();
  }
}

/** La global quedó timbrada: guarda el CFDI y deja sus tickets «en global». */
async function marcarTimbrada(negocioId, g, factura, actor) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [hecha] } = await cliente.query(
      `UPDATE facturacion_globales SET estado='timbrada', factura_id=$3, uuid=$4, serie=$5, folio_numero=$6,
              error_codigo=NULL, error_detalle=NULL, timbrada_at=now(), updated_at=now()
        WHERE id=$1 AND negocio_id=$2 AND estado IN ('timbrando','por_conciliar') RETURNING *`,
      [g.id, negocioId, factura.id, factura.uuid || null, factura.series || null,
        Number.isInteger(factura.folio_number) ? factura.folio_number : null]);
    if (hecha) {
      await cliente.query(
        `UPDATE facturacion_recibos r SET estado='global', factura_id=$3, error_codigo=NULL, error_detalle=NULL, updated_at=now()
           FROM facturacion_global_recibos gr
          WHERE gr.global_id=$1 AND gr.vivo AND r.negocio_id=$2 AND upper(r.folio)=upper(gr.folio)
            AND r.estado IN ('abierto','creando','error')`, [g.id, negocioId, factura.id]);
      await registrarBitacoraFacturacion({
        negocioId, ...actor, accion: 'timbrar_global', facturaId: factura.id,
        detalle: { global_id: g.id, forma_pago: g.forma_pago, tickets: g.tickets, total: Number(g.total),
          total_cfdi: Number(factura.total) || null, mes: g.mes, anio: g.anio },
      }, { db: cliente });
    }
    await cliente.query('COMMIT');
    return hecha || null;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/** Facturapi no la timbró: la global queda en error y sus tickets, libres. */
async function marcarError(negocioId, g, codigo, detalle, actor) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [fallida] } = await cliente.query(
      `UPDATE facturacion_globales SET estado='error', error_codigo=$3, error_detalle=$4, updated_at=now()
        WHERE id=$1 AND negocio_id=$2 AND estado IN ('preparada','timbrando','por_conciliar') RETURNING *`,
      [g.id, negocioId, String(codigo || 'FACTURAPI_ERROR').slice(0, 80), String(detalle || '').slice(0, 500)]);
    if (fallida) {
      await cliente.query(`UPDATE facturacion_global_recibos SET vivo=false WHERE global_id=$1`, [g.id]);
      await registrarBitacoraFacturacion({
        negocioId, ...actor, accion: 'global_rechazada',
        detalle: { global_id: g.id, forma_pago: g.forma_pago, tickets: g.tickets, codigo: fallida.error_codigo },
      }, { db: cliente });
    }
    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// ¿Pudo Facturapi haberla timbrado aunque no llegó la respuesta?
const respuestaPerdida = (e) => !(e instanceof FacturapiRitmoError)
  && (['FACTURAPI_TIMEOUT', 'FACTURAPI_NO_DISPONIBLE'].includes(e?.codigo) || Number(e?.status) >= 500);

async function timbrarGlobal(negocioId, globalId, actor) {
  const { rows: [g] } = await pool.query(
    `UPDATE facturacion_globales SET estado='timbrando', timbrando_at=now(), updated_at=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='preparada' RETURNING *`, [globalId, negocioId]);
  if (!g) return; // ya la está timbrando otra petición
  const { rows: recibos } = await pool.query(
    `SELECT recibo_id FROM facturacion_global_recibos WHERE global_id=$1 AND vivo ORDER BY folio`, [g.id]);
  const periodo = await periodoGlobal(negocioId, { anio: g.anio, mes: Number(g.mes) });
  const cfg = await obtenerConfiguracionFacturacion(negocioId);
  try {
    const factura = await crearFacturaGlobal(negocioId, {
      recibos: recibos.map((r) => r.recibo_id),
      desde: new Date(periodo.inicio).toISOString(),
      hasta: new Date(new Date(periodo.fin).getTime() - 1000).toISOString(),
      periodicidad: g.periodicidad, mes: g.mes, formaPago: g.forma_pago, serie: cfg.serie,
    });
    if (!factura?.id) {
      await marcarError(negocioId, g, 'SIN_RECIBOS_ABIERTOS', 'Facturapi no encontró recibos abiertos en la selección.', actor);
      return;
    }
    await marcarTimbrada(negocioId, g, factura, actor);
  } catch (e) {
    if (respuestaPerdida(e)) {
      await pool.query(
        `UPDATE facturacion_globales SET estado='por_conciliar', error_codigo=$3, error_detalle=$4, updated_at=now()
          WHERE id=$1 AND negocio_id=$2 AND estado='timbrando'`,
        [g.id, negocioId, e.codigo || 'FACTURAPI_ERROR', String(e.message || e).slice(0, 500)]);
      return;
    }
    await marcarError(negocioId, g, e.codigo || 'FACTURAPI_RECHAZO', e.message, actor);
  }
}

/**
 * Prepara y timbra la global del mes con los tickets elegidos. Devuelve las
 * globales de la solicitud (una por forma de pago) con su estado.
 */
export async function emitirGlobal(negocioId, { anio, mes, folios, solicitud } = {}, actor = {}) {
  if (!negocioId) throw new FacturacionError('Falta el contexto del negocio.', 'NEGOCIO_REQUERIDO', 400);
  const sol = String(solicitud || '').trim();
  if (!SOLICITUD.test(sol)) throw new FacturacionError('Vuelve a abrir la pantalla de la factura global.', 'SOLICITUD_INVALIDA');
  if (!Array.isArray(folios) || !folios.length) throw new FacturacionError('Elige al menos un ticket.', 'SELECCION_VACIA');
  const elegidos = [...new Set(folios.map((f) => String(f || '').trim().toUpperCase()).filter(Boolean))];
  if (elegidos.length !== folios.length) throw new FacturacionError('Hay tickets repetidos en la selección.', 'SELECCION_INVALIDA');
  if (elegidos.length > MAX_TICKETS) throw new FacturacionError(`Una global admite hasta ${MAX_TICKETS} tickets.`, 'SELECCION_INVALIDA');
  if (!(await puedeFacturar(negocioId))) throw new FacturapiNoConfiguradoError();

  let globales;
  try {
    globales = await prepararSeleccion(negocioId, { anio, mes, elegidos, solicitud: sol }, actor);
  } catch (e) {
    // La misma solicitud ya preparó sus globales (un doble clic, un reintento
    // o una petición en paralelo): sus tickets ya no pasan la revisión, o la
    // base rechaza repetir la solicitud. Entonces vale lo que se preparó.
    globales = await globalesDeSolicitud(negocioId, sol);
    if (!globales.length) throw e;
  }
  for (const g of globales.filter((x) => x.estado === 'preparada')) await timbrarGlobal(negocioId, g.id, actor);
  return { globales: (await globalesDeSolicitud(negocioId, sol)).map(vistaGlobal) };
}

async function prepararSeleccion(negocioId, { anio, mes, elegidos, solicitud }, actor) {
  const periodo = await periodoGlobal(negocioId, { anio, mes });
  exigirPeriodoDisponible(periodo);
  const ventas = await ventasDelPeriodo(negocioId, periodo, await obtenerConfiguracionFacturacion(negocioId));
  const porFolio = new Map(ventas.map((v) => [v.folio.toUpperCase(), v]));
  const rechazos = [];
  const seleccion = [];
  for (const folio of elegidos) {
    const v = porFolio.get(folio);
    if (!v) rechazos.push({ folio, motivo: 'FUERA_DEL_PERIODO', motivo_texto: `No es una venta de ${periodo.nombre}` });
    else if (!v.elegible) rechazos.push({ folio: v.folio, motivo: v.motivo, motivo_texto: v.motivo_texto });
    else seleccion.push(v);
  }
  if (rechazos.length) {
    throw Object.assign(new FacturacionError('Hay tickets que no pueden entrar en la global. Vuelve a cargar la lista.', 'SELECCION_NO_ELEGIBLE', 409), { errores: rechazos });
  }
  // Recibos que faltan, con la fecha de la venta para que caigan en el mes.
  for (const v of seleccion.filter((x) => x.sin_recibo)) {
    try { await asegurarReciboPedido(negocioId, v.folio, { fecha: v.venta_at }); }
    catch (e) { rechazos.push({ folio: v.folio, motivo: 'RECIBO_NO_CREADO', motivo_texto: e.message }); }
  }
  if (rechazos.length) {
    throw Object.assign(new FacturacionError('No se pudo crear el recibo de algunos tickets; no se timbró nada.', 'RECIBOS_NO_CREADOS', 409), { errores: rechazos });
  }
  return prepararGlobales(negocioId, periodo, seleccion.map((v) => v.folio), solicitud, actor);
}

/**
 * Una global sin respuesta de Facturapi: si sus recibos ya están en una
 * global (por el aviso de Facturapi o al consultar uno), queda timbrada; si
 * siguen abiertos pasado el margen, queda en error y sus tickets, libres.
 */
export async function conciliarGlobal(negocioId, globalId, actor = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(globalId || ''))) {
    throw new FacturacionError('No encontré esa factura global.', 'GLOBAL_NO_ENCONTRADA', 404);
  }
  const { rows: [g] } = await pool.query(
    `SELECT *, timbrando_at < now() - make_interval(mins => $3) AS vencida
       FROM facturacion_globales WHERE id=$1 AND negocio_id=$2`, [globalId, negocioId, ESPERA_CONCILIAR_MIN]);
  if (!g) throw new FacturacionError('No encontré esa factura global.', 'GLOBAL_NO_ENCONTRADA', 404);
  if (!['por_conciliar', 'timbrando'].includes(g.estado)) return vistaGlobal(g);
  const { rows: locales } = await pool.query(
    `SELECT gr.recibo_id, r.estado, r.factura_id FROM facturacion_global_recibos gr
       LEFT JOIN facturacion_recibos r ON r.negocio_id=gr.negocio_id AND upper(r.folio)=upper(gr.folio)
      WHERE gr.global_id=$1 AND gr.vivo ORDER BY gr.folio`, [g.id]);
  let facturaId = locales.length && locales.every((r) => r.estado === 'global' && r.factura_id && r.factura_id === locales[0].factura_id)
    ? locales[0].factura_id : null;
  let abierto = false;
  if (!facturaId && locales.length) {
    const remoto = await obtenerRecibo(negocioId, locales[0].recibo_id);
    const factura = typeof remoto?.invoice === 'string' ? remoto.invoice : remoto?.invoice?.id || null;
    if (remoto?.status === 'invoiced_globally' && factura) facturaId = factura;
    else abierto = remoto?.status === 'open';
  }
  if (facturaId) {
    const factura = await obtenerFactura(negocioId, facturaId);
    await marcarTimbrada(negocioId, g, { ...factura, id: factura?.id || facturaId }, actor);
  } else if (!g.vencida) {
    throw new FacturacionError('Facturapi todavía la está procesando. Revisa en unos minutos.', 'GLOBAL_EN_PROCESO', 409);
  } else {
    await marcarError(negocioId, g,
      abierto ? 'SIN_TIMBRAR' : 'RECIBO_YA_NO_ABIERTO',
      abierto ? 'Facturapi no timbró la global; sus tickets quedaron libres.' : 'Un recibo de la global ya no está abierto en Facturapi.', actor);
  }
  const { rows: [actual] } = await pool.query(`SELECT * FROM facturacion_globales WHERE id=$1`, [g.id]);
  return vistaGlobal(actual);
}

export async function listarGlobales(negocioId, { limite = 24 } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limite, 10) || 24, 1), 100);
  const { rows } = await pool.query(
    `SELECT * FROM facturacion_globales WHERE negocio_id=$1 ORDER BY created_at DESC, forma_pago LIMIT $2`, [negocioId, n]);
  return rows.map(vistaGlobal);
}

/** Rutas de la global: solo el administrador del negocio. */
export function registrarRutasFacturaGlobal(app, { requireAdminSeguro, requireModulo, responderError }) {
  const admin = [requireAdminSeguro, requireModulo('facturacion')];
  app.get('/api/admin/facturacion/global/candidatos', ...admin, async (req, res) => {
    try { res.json({ ok: true, ...(await candidatosGlobal(req.negocioId, { anio: req.query.anio, mes: req.query.mes })) }); }
    catch (e) { responderError(res, e); }
  });
  app.post('/api/admin/facturacion/global', ...admin, async (req, res) => {
    try { res.json({ ok: true, ...(await emitirGlobal(req.negocioId, req.body || {}, actorDe(req))) }); }
    catch (e) { responderError(res, e); }
  });
  app.get('/api/admin/facturacion/globales', ...admin, async (req, res) => {
    try { res.json({ ok: true, globales: await listarGlobales(req.negocioId, { limite: req.query.limite }) }); }
    catch (e) { responderError(res, e); }
  });
  app.post('/api/admin/facturacion/globales/:id/conciliar', ...admin, async (req, res) => {
    try { res.json({ ok: true, global: await conciliarGlobal(req.negocioId, req.params.id, actorDe(req)) }); }
    catch (e) { responderError(res, e); }
  });
}
