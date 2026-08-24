/**
 * cortesCaja.js — Cortes de caja como CIERRES HISTÓRICOS.
 *
 * Antes "Corte" era un resumen vivo: se recalculaba en cada carga. Eso hacía
 * que el corte de ayer pudiera cambiar hoy, y no dejaba constancia de cuánto
 * se contó ni de cuánto faltó. Un arqueo que se recalcula no es un arqueo.
 *
 * DOS INVARIANTES QUE GOBIERNAN TODO ESTE ARCHIVO
 *
 * 1. UN CORTE CERRADO NUNCA SE RECALCULA. Al cerrar se congela todo en
 *    columnas + snapshot_json. El ticket se arma SIEMPRE desde ahí; ninguna
 *    función de lectura de un corte cerrado vuelve a consultar pedidos.
 *
 * 2. VENTAS DEL PERIODO ≠ DINERO FÍSICO EN CAJA. Una venta con tarjeta o por
 *    enlace suma a las ventas del día y NO suma un peso al efectivo. El
 *    efectivo esperado es:
 *
 *      fondo inicial
 *      + ventas en efectivo
 *      + entradas
 *      - retiros
 *      - gastos
 *      - devoluciones en efectivo
 *
 * DÍA OPERATIVO: es el día en la zona horaria DEL NEGOCIO, no un día UTC.
 * Un pedido de las 23:40 hora local pertenece a ese día aunque en UTC ya sea
 * el siguiente; si no, todos los cortes nocturnos saldrían partidos.
 *
 * RECONOCIMIENTO DE LA VENTA (regla de pagos tardíos):
 *   - Cobro inmediato (efectivo, terminal, transferencia…): la venta se
 *     reconoce el día en que se creó el pedido.
 *   - Enlace de pago: la venta se reconoce el día de la CONFIRMACIÓN
 *     financiera (`pagos.paid_at`), no el de la creación del pedido.
 *   Por eso un pedido creado ayer y pagado hoy aparece en el corte de HOY,
 *   en su propia sección "cobrado de días anteriores", con su folio y su
 *   fecha original. El corte de ayer, si ya está cerrado, no se toca jamás.
 */
import { pool } from './database.js';

const TZ_POR_DEFECTO = 'America/Matamoros';

// Clasificación por naturaleza del dinero, no por nombre comercial. Solo
// 'efectivo' incrementa el dinero físico de la caja.
const FORMAS_EFECTIVO = new Set(['efectivo']);
const FORMAS_TARJETA = new Set(['terminal', 'tarjeta']);
const FORMAS_ENLACE = new Set(['enlace_pago', 'enlace', 'pago_online', 'clip', 'mercadopago', 'mercado_pago']);

export function clasificarFormaPago(forma) {
  const f = String(forma || '').trim().toLowerCase();
  if (FORMAS_EFECTIVO.has(f)) return 'efectivo';
  if (FORMAS_TARJETA.has(f)) return 'tarjeta';
  if (FORMAS_ENLACE.has(f)) return 'enlace';
  return 'otros';
}

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─── Día operativo en la zona horaria del negocio ───────────────────────────

export async function zonaHorariaNegocio(negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'timezone' LIMIT 1`,
      [negocioId]);
    const tz = String(rows[0]?.valor || '').trim();
    if (!tz) return TZ_POR_DEFECTO;
    // Una zona inválida haría estallar toda la pantalla de corte: se valida
    // antes de devolverla y se cae a la de siempre si no sirve.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return TZ_POR_DEFECTO;
  }
}

function partesEnZona(instante, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instante).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function desfaseMs(instante, tz) {
  const p = partesEnZona(instante, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - instante.getTime();
}

/** Instante UTC que corresponde a una hora local de esa zona. */
function instanteLocal(y, mo, d, h, mi, s, tz) {
  const objetivo = Date.UTC(y, mo - 1, d, h, mi, s);
  // Dos pasadas: la primera estima el desfase, la segunda lo corrige en los
  // bordes de horario de verano.
  let ts = objetivo;
  for (let i = 0; i < 2; i++) ts = objetivo - desfaseMs(new Date(ts), tz);
  return new Date(ts);
}

/** 'YYYY-MM-DD' del día operativo al que pertenece un instante. */
export function fechaOperativaDe(instante, tz) {
  const p = partesEnZona(instante, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function fechaOperativaHoy(tz) {
  return fechaOperativaDe(new Date(), tz);
}

/** Rango [inicio, fin) en UTC del día operativo indicado. */
export function rangoUtcDeFecha(fecha, tz) {
  const [y, mo, d] = String(fecha).split('-').map(Number);
  const inicio = instanteLocal(y, mo, d, 0, 0, 0, tz);
  const siguiente = new Date(Date.UTC(y, mo - 1, d) + 24 * 60 * 60 * 1000);
  const p = { y: siguiente.getUTCFullYear(), mo: siguiente.getUTCMonth() + 1, d: siguiente.getUTCDate() };
  const fin = instanteLocal(p.y, p.mo, p.d, 0, 0, 0, tz);
  return { inicio, fin };
}

export function esFechaValida(fecha) {
  return typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha) &&
    !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`));
}

// ─── Movimientos de caja ────────────────────────────────────────────────────

export const TIPOS_MOVIMIENTO = Object.freeze(['entrada', 'retiro', 'gasto']);

export async function registrarMovimiento(negocioId, { tipo, monto, motivo, usuarioId = null, fecha = null }) {
  if (!TIPOS_MOVIMIENTO.includes(tipo)) {
    const e = new Error(`Tipo de movimiento inválido: ${tipo}`); e.code = 'TIPO_INVALIDO'; throw e;
  }
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) {
    const e = new Error('El monto debe ser mayor que cero'); e.code = 'MONTO_INVALIDO'; throw e;
  }
  if (typeof motivo !== 'string' || !motivo.trim()) {
    const e = new Error('El motivo es obligatorio'); e.code = 'MOTIVO_REQUERIDO'; throw e;
  }
  const tz = await zonaHorariaNegocio(negocioId);
  const fechaOperativa = fecha && esFechaValida(fecha) ? fecha : fechaOperativaHoy(tz);

  // Un movimiento no puede entrar a un día ya cerrado: eso reescribiría un
  // arqueo firmado. Se rechaza con un motivo claro en vez de aceptarlo y
  // dejarlo colgando fuera de todo corte.
  const { rows: cerrado } = await pool.query(
    `SELECT folio FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`,
    [negocioId, fechaOperativa]);
  if (cerrado[0]) {
    const e = new Error(`El corte del ${fechaOperativa} ya está cerrado (${cerrado[0].folio}): no admite movimientos nuevos`);
    e.code = 'CORTE_CERRADO'; throw e;
  }

  const { rows: [mov] } = await pool.query(
    `INSERT INTO movimientos_caja (negocio_id, fecha_operativa, tipo, monto, motivo, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [negocioId, fechaOperativa, tipo, dinero(m), motivo.trim().slice(0, 200), usuarioId]);
  return mov;
}

export async function listarMovimientos(negocioId, fecha) {
  const { rows } = await pool.query(
    `SELECT m.id, m.tipo, m.monto, m.motivo, m.created_at, m.corte_id, u.nombre AS usuario
       FROM movimientos_caja m LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.negocio_id = $1 AND m.fecha_operativa = $2
      ORDER BY m.created_at`,
    [negocioId, fecha]);
  return rows;
}

// ─── Cálculo del corte vivo ─────────────────────────────────────────────────

/**
 * Arma el corte del día indicado a partir de las fuentes vivas. Es lo que se
 * muestra mientras el día está abierto y lo que se congela al cerrar.
 * NUNCA se usa para leer un corte ya cerrado.
 */
export async function calcularCorteVivo(negocioId, fecha = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  const nid = negocioId.trim();
  const tz = await zonaHorariaNegocio(nid);
  const fechaOperativa = fecha && esFechaValida(fecha) ? fecha : fechaOperativaHoy(tz);
  const { inicio, fin } = rangoUtcDeFecha(fechaOperativa, tz);

  const [pedidosRes, cancelRes, tardiosRes, movs, fondoRes] = await Promise.all([
    // Ventas del día: pedidos creados dentro del rango, sin cancelados.
    pool.query(
      `SELECT folio, estado, created_at,
              datos->>'forma_pago'                                     AS forma_pago,
              COALESCE((datos->>'pago_confirmado')::boolean, false)    AS pago_confirmado,
              COALESCE((datos->>'total')::decimal, 0)                  AS total,
              COALESCE((datos->'devolucion'->>'monto')::decimal, 0)    AS devolucion_monto,
              datos->'cliente'->>'nombre'                              AS cliente
         FROM pedidos_activos
        WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3 AND estado <> 'cancelado'
        ORDER BY created_at`,
      [nid, inicio.toISOString(), fin.toISOString()]),
    pool.query(
      `SELECT COUNT(*)::int AS n
         FROM pedidos_activos
        WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3 AND estado = 'cancelado'`,
      [nid, inicio.toISOString(), fin.toISOString()]),
    // Pagos por enlace CONFIRMADOS hoy de pedidos creados ANTES de hoy: se
    // reconocen aquí, porque su día original ya pasó (y puede estar cerrado).
    pool.query(
      `SELECT p.pedido_folio AS folio, p.monto, p.paid_at, p.proveedor, pa.created_at AS pedido_creado_at
         FROM pagos p
         LEFT JOIN pedidos_activos pa ON pa.folio = p.pedido_folio AND pa.negocio_id = p.negocio_id
        WHERE p.negocio_id = $1 AND p.estado = 'pagado'
          AND p.paid_at >= $2 AND p.paid_at < $3
          AND (pa.created_at IS NULL OR pa.created_at < $2)
        ORDER BY p.paid_at`,
      [nid, inicio.toISOString(), fin.toISOString()]),
    listarMovimientos(nid, fechaOperativa),
    pool.query(`SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2`, [nid, fechaOperativa]),
  ]);

  const porForma = { efectivo: 0, tarjeta: 0, enlace: 0, otros: 0 };
  const detallePorForma = {};
  const pedidos = [];
  let pendienteNum = 0, pendienteTotal = 0, devolucionesTotal = 0, pedidosCobrados = 0;

  for (const v of pedidosRes.rows) {
    const total = dinero(v.total);
    devolucionesTotal += dinero(v.devolucion_monto);
    // Un pedido abierto (por_cobrar sin confirmar) todavía no tiene forma de
    // pago real: no entra a ninguna categoría ni al efectivo esperado.
    const abierto = String(v.forma_pago || '') === 'por_cobrar' && v.pago_confirmado !== true;
    if (abierto) {
      pendienteNum++; pendienteTotal += total;
      continue;
    }
    const clase = clasificarFormaPago(v.forma_pago);
    porForma[clase] += total;
    const clave = v.forma_pago || 'no especificado';
    if (!detallePorForma[clave]) detallePorForma[clave] = { count: 0, total: 0, clase };
    detallePorForma[clave].count++;
    detallePorForma[clave].total = dinero(detallePorForma[clave].total + total);
    pedidosCobrados++;
    pedidos.push({
      folio: v.folio, hora: v.created_at, cliente: v.cliente || null,
      forma_pago: clave, clase, total,
    });
  }

  // Cobros tardíos: dinero electrónico (enlace), nunca efectivo.
  const tardios = tardiosRes.rows.map(p => ({
    folio: p.folio, monto: dinero(p.monto), proveedor: p.proveedor,
    confirmado_at: p.paid_at,
    pedido_creado_at: p.pedido_creado_at,
    fecha_original: p.pedido_creado_at ? fechaOperativaDe(new Date(p.pedido_creado_at), tz) : null,
  }));
  const totalTardios = dinero(tardios.reduce((s, p) => s + p.monto, 0));
  porForma.enlace = dinero(porForma.enlace + totalTardios);

  const entradas = dinero(movs.filter(m => m.tipo === 'entrada').reduce((s, m) => s + Number(m.monto), 0));
  const retiros = dinero(movs.filter(m => m.tipo === 'retiro').reduce((s, m) => s + Number(m.monto), 0));
  const gastos = dinero(movs.filter(m => m.tipo === 'gasto').reduce((s, m) => s + Number(m.monto), 0));

  // Devoluciones EN EFECTIVO: solo las de pedidos que se habían cobrado en
  // efectivo salen del cajón. Una devolución de un pago con tarjeta se
  // reembolsa por el mismo medio y no toca el dinero físico.
  let devolucionesEfectivo = 0;
  for (const v of pedidosRes.rows) {
    const monto = dinero(v.devolucion_monto);
    if (monto > 0 && clasificarFormaPago(v.forma_pago) === 'efectivo') devolucionesEfectivo += monto;
  }
  devolucionesEfectivo = dinero(devolucionesEfectivo);

  const fondoInicial = dinero(fondoRes.rows[0]?.fondo || 0);
  const ventasEfectivo = dinero(porForma.efectivo);
  const efectivoEsperado = dinero(
    fondoInicial + ventasEfectivo + entradas - retiros - gastos - devolucionesEfectivo);

  return {
    negocio_id: nid,
    fecha_operativa: fechaOperativa,
    timezone: tz,
    rango_utc: { inicio: inicio.toISOString(), fin: fin.toISOString() },
    fondo_inicial: fondoInicial,
    ventas_totales: dinero(porForma.efectivo + porForma.tarjeta + porForma.enlace + porForma.otros),
    ventas_efectivo: ventasEfectivo,
    ventas_tarjeta: dinero(porForma.tarjeta),
    ventas_enlace: dinero(porForma.enlace),
    ventas_otros: dinero(porForma.otros),
    entradas, retiros, gastos,
    devoluciones_efectivo: devolucionesEfectivo,
    efectivo_esperado: efectivoEsperado,
    pedidos_count: pedidosCobrados,
    cancelaciones_count: cancelRes.rows[0]?.n || 0,
    devoluciones_total: dinero(devolucionesTotal),
    pendiente: { num: pendienteNum, total: dinero(pendienteTotal) },
    detalle_formas: detallePorForma,
    pedidos,
    movimientos: movs.map(m => ({
      tipo: m.tipo, monto: dinero(m.monto), motivo: m.motivo,
      usuario: m.usuario || null, created_at: m.created_at,
    })),
    cobros_dias_anteriores: tardios,
  };
}

// ─── Cierre ─────────────────────────────────────────────────────────────────

function calcularDiferencia(esperado, contado) {
  if (contado === null || contado === undefined) return 0;
  return dinero(Number(contado) - Number(esperado));
}

/**
 * Cierra el corte del día. IDEMPOTENTE: si ya existe uno para ese negocio y
 * fecha, devuelve el existente con `yaExistia: true` y NO recalcula nada. La
 * garantía real es el índice único (negocio_id, fecha_operativa) -- dos
 * peticiones simultáneas no pueden crear dos cortes ni aunque la aplicación
 * se equivoque.
 */
export async function cerrarCorte(negocioId, { fecha = null, efectivoContado = null, nota = null, usuarioId = null } = {}) {
  const vivo = await calcularCorteVivo(negocioId, fecha);
  const fechaOperativa = vivo.fecha_operativa;

  const existente = await obtenerCorteCerrado(negocioId, fechaOperativa);
  if (existente) return { corte: existente, yaExistia: true };

  const contado = efectivoContado === null || efectivoContado === undefined || efectivoContado === ''
    ? null : dinero(efectivoContado);
  if (contado !== null && (!Number.isFinite(contado) || contado < 0)) {
    const e = new Error('El efectivo contado no puede ser negativo'); e.code = 'CONTADO_INVALIDO'; throw e;
  }
  const diferencia = calcularDiferencia(vivo.efectivo_esperado, contado);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [corte] } = await client.query(
      `INSERT INTO cortes_caja (
         negocio_id, fecha_operativa, estado, folio, usuario_id, cerrado_at,
         fondo_inicial, ventas_totales, ventas_efectivo, ventas_tarjeta, ventas_enlace, ventas_otros,
         entradas, retiros, gastos, devoluciones_efectivo,
         efectivo_esperado, efectivo_contado, diferencia, nota,
         pedidos_count, cancelaciones_count, devoluciones_total, snapshot_json)
       VALUES ($1,$2,'cerrado',
         'COR-' || LPAD(((SELECT COUNT(*) FROM cortes_caja c WHERE c.negocio_id = $1) + 1)::text, 6, '0'),
         $3, NOW(),
         $4,$5,$6,$7,$8,$9,
         $10,$11,$12,$13,
         $14,$15,$16,$17,
         $18,$19,$20,$21::jsonb)
       ON CONFLICT (negocio_id, fecha_operativa) DO NOTHING
       RETURNING *`,
      [negocioId, fechaOperativa, usuarioId,
       vivo.fondo_inicial, vivo.ventas_totales, vivo.ventas_efectivo, vivo.ventas_tarjeta, vivo.ventas_enlace, vivo.ventas_otros,
       vivo.entradas, vivo.retiros, vivo.gastos, vivo.devoluciones_efectivo,
       vivo.efectivo_esperado, contado, diferencia, nota ? String(nota).slice(0, 500) : null,
       vivo.pedidos_count, vivo.cancelaciones_count, vivo.devoluciones_total,
       JSON.stringify(vivo)]);

    if (!corte) {
      // Otra petición ganó la carrera: no es un error, es exactamente lo que
      // el índice único debe hacer. Se devuelve el corte que sí quedó.
      await client.query('ROLLBACK');
      const ganador = await obtenerCorteCerrado(negocioId, fechaOperativa);
      return { corte: ganador, yaExistia: true };
    }

    // Sellar los movimientos del día: quedan atados a este corte y ya no
    // pueden contarse en otro.
    await client.query(
      `UPDATE movimientos_caja SET corte_id = $1
        WHERE negocio_id = $2 AND fecha_operativa = $3 AND corte_id IS NULL`,
      [corte.id, negocioId, fechaOperativa]);

    await client.query('COMMIT');
    return { corte, yaExistia: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function obtenerCorteCerrado(negocioId, fecha) {
  const { rows } = await pool.query(
    `SELECT c.*, u.nombre AS usuario_nombre
       FROM cortes_caja c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.negocio_id = $1 AND c.fecha_operativa = $2`,
    [negocioId, fecha]);
  return rows[0] || null;
}

export async function listarCortes(negocioId, { limite = 60 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.fecha_operativa, c.folio, c.estado, c.cerrado_at,
            c.ventas_totales, c.ventas_efectivo, c.ventas_tarjeta, c.ventas_enlace, c.ventas_otros,
            c.efectivo_esperado, c.efectivo_contado, c.diferencia, c.pedidos_count,
            u.nombre AS usuario_nombre
       FROM cortes_caja c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.negocio_id = $1
      ORDER BY c.fecha_operativa DESC
      LIMIT $2`,
    [negocioId, Math.min(Math.max(Number(limite) || 60, 1), 400)]);
  return rows;
}

// ─── Ticket térmico ─────────────────────────────────────────────────────────

const ANCHO = 32;
const linea = (car = '-') => car.repeat(ANCHO);
const centrar = (t) => {
  const s = String(t).slice(0, ANCHO);
  const pad = Math.max(0, Math.floor((ANCHO - s.length) / 2));
  return ' '.repeat(pad) + s;
};
const pesos = (n) => `$${(Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fila = (etiqueta, valor) => {
  const v = pesos(valor);
  const e = String(etiqueta).slice(0, ANCHO - v.length - 1);
  return e + ' '.repeat(Math.max(1, ANCHO - e.length - v.length)) + v;
};

/**
 * Arma el ticket DESDE EL SNAPSHOT del corte cerrado. No consulta ventas ni
 * pedidos: si lo hiciera, reimprimir un corte de hace un mes podría dar un
 * papel distinto al original, que es justo lo que este módulo evita.
 */
export function ticketCorte(corte, { negocioNombre = 'XABOR' } = {}) {
  const s = corte.snapshot_json && typeof corte.snapshot_json === 'object' ? corte.snapshot_json : {};
  const tz = s.timezone || TZ_POR_DEFECTO;
  const cerrado = corte.cerrado_at ? new Date(corte.cerrado_at) : new Date();
  const hora = new Intl.DateTimeFormat('es-MX', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(cerrado);
  const fechaCorta = String(corte.fecha_operativa).slice(0, 10).split('-').reverse().join('/');
  const dif = Number(corte.diferencia) || 0;
  const etiquetaDif = dif > 0 ? 'SOBRANTE' : dif < 0 ? 'FALTANTE' : 'CUADRADO';

  const L = [];
  L.push(centrar(String(negocioNombre).toUpperCase()));
  L.push(centrar('CORTE DE CAJA'));
  L.push(centrar(corte.folio));
  L.push('');
  L.push(`Fecha operativa: ${fechaCorta}`);
  L.push(`Cierre: ${hora}`);
  L.push(`Usuario: ${corte.usuario_nombre || 'Sistema'}`);
  L.push('');
  L.push(linea());
  L.push('VENTAS');
  L.push(linea());
  L.push(`Pedidos: ${corte.pedidos_count}`);
  L.push('');
  L.push(fila('Efectivo', corte.ventas_efectivo));
  L.push(fila('Tarjeta', corte.ventas_tarjeta));
  L.push(fila('Clip / enlace', corte.ventas_enlace));
  L.push(fila('Otros', corte.ventas_otros));
  L.push(linea());
  L.push(fila('TOTAL', corte.ventas_totales));
  L.push('');
  L.push(linea());
  L.push('CAJA');
  L.push(linea());
  L.push(fila('Fondo inicial', corte.fondo_inicial));
  L.push(fila('Ventas efectivo', corte.ventas_efectivo));
  L.push(fila('Entradas', corte.entradas));
  L.push(fila('Retiros', corte.retiros));
  L.push(fila('Gastos', corte.gastos));
  L.push(fila('Devoluciones', corte.devoluciones_efectivo));
  L.push(linea());
  L.push(fila('ESPERADO', corte.efectivo_esperado));
  L.push(fila('CONTADO', corte.efectivo_contado === null ? 0 : corte.efectivo_contado));
  L.push(fila('DIFERENCIA', dif));
  if (dif !== 0) L.push(centrar(etiquetaDif));
  L.push('');
  L.push(`Cancelaciones: ${corte.cancelaciones_count}`);
  if (Array.isArray(s.cobros_dias_anteriores) && s.cobros_dias_anteriores.length) {
    // Trazabilidad de la regla de pagos tardíos: se ve en el papel de qué
    // día venía cada peso que se reconoció hoy.
    L.push('');
    L.push('Cobrado de dias anteriores:');
    for (const c of s.cobros_dias_anteriores.slice(0, 12)) {
      L.push(fila(`  ${c.folio} (${c.fecha_original || '?'})`, c.monto));
    }
  }
  if (corte.nota) { L.push(''); L.push(`Nota: ${String(corte.nota).slice(0, 120)}`); }
  L.push('');
  L.push(centrar('CORTE CERRADO'));
  L.push(centrar(`${fechaCorta} ${hora}`));
  return L.join('\n');
}
