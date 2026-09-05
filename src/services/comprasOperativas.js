import { pool } from './database.js';
import { CATEGORIAS_COMPRA } from './ticketComprasIA.js';

const TIPOS_PAGO = new Set(['contado', 'credito']);
const ESTADOS_FACTURA = new Set(['no_facturado', 'pendiente', 'facturado']);
const ESTADOS = new Set(['borrador', 'confirmada', 'cancelada']);

export class CompraOperativaError extends Error {
  constructor(message, codigo = 'COMPRA_INVALIDA', status = 400) {
    super(message); this.name = 'CompraOperativaError'; this.codigo = codigo; this.status = status;
  }
}

function texto(v, max = 500) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
function dinero(v, { permitirCero = true } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!permitirCero && n <= 0)) return null;
  return Math.round(n * 100) / 100;
}
function cantidad(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000) / 1000;
}
function confianza(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}
function fecha(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}
function uuidOpcional(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

export function normalizarCompra(input = {}, { confirmar = false } = {}) {
  const tipoPago = TIPOS_PAGO.has(input.tipo_pago) ? input.tipo_pago : 'contado';
  const estadoFactura = ESTADOS_FACTURA.has(input.estado_factura) ? input.estado_factura : 'no_facturado';
  const items = (Array.isArray(input.items) ? input.items : []).map((it, i) => {
    const descripcion = texto(it?.descripcion, 250);
    if (!descripcion) return null;
    const categoria = texto(it?.categoria, 80);
    const sugerida = CATEGORIAS_COMPRA.includes(it?.categoria_sugerida) ? it.categoria_sugerida : null;
    return {
      descripcion,
      cantidad: cantidad(it?.cantidad),
      unidad: texto(it?.unidad, 40),
      precio_unitario: dinero(it?.precio_unitario),
      importe: dinero(it?.importe),
      categoria: categoria || sugerida,
      categoria_sugerida: sugerida,
      confianza: confianza(it?.confianza),
      orden: i,
    };
  }).filter(Boolean);

  const out = {
    proveedor: texto(input.proveedor, 250),
    fecha: fecha(input.fecha),
    subtotal: dinero(input.subtotal),
    impuestos: dinero(input.impuestos),
    total: dinero(input.total, { permitirCero: false }),
    tipo_pago: tipoPago,
    estado_factura: estadoFactura,
    cfdi_uuid: uuidOpcional(input.cfdi_uuid),
    notas: texto(input.notas, 2000),
    numero_ticket: texto(input.numero_ticket, 120),
    items,
  };

  if (confirmar) {
    if (!out.proveedor) throw new CompraOperativaError('Indica el proveedor antes de confirmar', 'PROVEEDOR_REQUERIDO');
    if (!out.fecha) throw new CompraOperativaError('Indica la fecha de la compra antes de confirmar', 'FECHA_REQUERIDA');
    if (!(out.total > 0)) throw new CompraOperativaError('Indica un total mayor a cero antes de confirmar', 'TOTAL_REQUERIDO');
  }
  return out;
}

async function reemplazarItems(client, compraId, items) {
  await client.query(`DELETE FROM compras_operativas_items WHERE compra_id = $1`, [compraId]);
  for (const it of items) {
    await client.query(
      `INSERT INTO compras_operativas_items
       (compra_id, descripcion, cantidad, unidad, precio_unitario, importe,
        categoria, categoria_sugerida, confianza, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [compraId, it.descripcion, it.cantidad, it.unidad, it.precio_unitario, it.importe,
       it.categoria, it.categoria_sugerida, it.confianza, it.orden]);
  }
}

export async function crearBorradorManual(negocioId, input = {}, createdBy = null) {
  const n = normalizarCompra(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [compra] } = await client.query(
      `INSERT INTO compras_operativas
       (negocio_id, proveedor, fecha, subtotal, impuestos, total, tipo_pago,
        estado_factura, cfdi_uuid, estado, origen, notas, numero_ticket, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'borrador','manual',$10,$11,$12)
       RETURNING *`,
      [negocioId, n.proveedor, n.fecha, n.subtotal, n.impuestos, n.total, n.tipo_pago,
       n.estado_factura, n.cfdi_uuid, n.notas, n.numero_ticket, createdBy]);
    await reemplazarItems(client, compra.id, n.items);
    await client.query('COMMIT');
    return obtenerCompra(negocioId, compra.id);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function crearBorradorDesdeTicket(negocioId, extraccion, ticket, createdBy = null) {
  const n = normalizarCompra({ ...extraccion, items: extraccion?.items || [] });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [compra] } = await client.query(
      `INSERT INTO compras_operativas
       (negocio_id, proveedor, fecha, subtotal, impuestos, total, tipo_pago,
        estado_factura, estado, origen, ticket_storage_key, ticket_mime,
        ticket_checksum, ticket_nombre, confidence, advertencias, numero_ticket, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'contado','no_facturado','borrador','ticket_ia',
               $7,$8,$9,$10,$11,$12::jsonb,$13,$14)
       RETURNING *`,
      [negocioId, n.proveedor, n.fecha, n.subtotal, n.impuestos, n.total,
       ticket.storageKey, ticket.mimeType, ticket.checksum, texto(ticket.nombre, 180),
       confianza(extraccion?.confianza), JSON.stringify(extraccion?.advertencias || []),
       n.numero_ticket, createdBy]);
    await reemplazarItems(client, compra.id, n.items);
    await client.query('COMMIT');
    return obtenerCompra(negocioId, compra.id);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e?.code === '23505' && e?.constraint === 'idx_compras_operativas_ticket_checksum') {
      throw new CompraOperativaError('Este ticket ya fue registrado en este negocio', 'TICKET_DUPLICADO', 409);
    }
    throw e;
  } finally { client.release(); }
}

export async function actualizarBorrador(negocioId, compraId, input = {}) {
  const n = normalizarCompra(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [actual] } = await client.query(
      `SELECT id, estado FROM compras_operativas WHERE id=$1 AND negocio_id=$2 FOR UPDATE`,
      [compraId, negocioId]);
    if (!actual) throw new CompraOperativaError('Compra no encontrada', 'COMPRA_NO_ENCONTRADA', 404);
    if (actual.estado !== 'borrador') throw new CompraOperativaError('Solo se puede editar un borrador', 'COMPRA_NO_EDITABLE', 409);
    await client.query(
      `UPDATE compras_operativas SET
       proveedor=$3, fecha=$4, subtotal=$5, impuestos=$6, total=$7, tipo_pago=$8,
       estado_factura=$9, cfdi_uuid=$10, notas=$11, numero_ticket=$12, updated_at=NOW()
       WHERE id=$1 AND negocio_id=$2`,
      [compraId, negocioId, n.proveedor, n.fecha, n.subtotal, n.impuestos, n.total,
       n.tipo_pago, n.estado_factura, n.cfdi_uuid, n.notas, n.numero_ticket]);
    await reemplazarItems(client, compraId, n.items);
    await client.query('COMMIT');
    return obtenerCompra(negocioId, compraId);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function confirmarCompra(negocioId, compraId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [fila] } = await client.query(
      `SELECT * FROM compras_operativas WHERE id=$1 AND negocio_id=$2 FOR UPDATE`, [compraId, negocioId]);
    if (!fila) throw new CompraOperativaError('Compra no encontrada', 'COMPRA_NO_ENCONTRADA', 404);
    if (fila.estado === 'confirmada') { await client.query('COMMIT'); return obtenerCompra(negocioId, compraId); }
    if (fila.estado !== 'borrador') throw new CompraOperativaError('La compra no puede confirmarse', 'COMPRA_NO_CONFIRMABLE', 409);
    normalizarCompra(fila, { confirmar: true });
    await client.query(
      `UPDATE compras_operativas SET estado='confirmada', confirmed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND negocio_id=$2`, [compraId, negocioId]);
    await client.query('COMMIT');
    return obtenerCompra(negocioId, compraId);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

export async function cancelarCompra(negocioId, compraId) {
  const { rows: [r] } = await pool.query(
    `UPDATE compras_operativas SET estado='cancelada', updated_at=NOW()
     WHERE id=$1 AND negocio_id=$2 AND estado <> 'cancelada' RETURNING id, estado`,
    [compraId, negocioId]);
  if (!r) {
    const { rows } = await pool.query(`SELECT id FROM compras_operativas WHERE id=$1 AND negocio_id=$2`, [compraId, negocioId]);
    if (!rows.length) throw new CompraOperativaError('Compra no encontrada', 'COMPRA_NO_ENCONTRADA', 404);
    return { id: compraId, estado: 'cancelada' };
  }
  return r;
}

export async function obtenerCompra(negocioId, compraId) {
  const { rows: [compra] } = await pool.query(
    `SELECT * FROM compras_operativas WHERE id=$1 AND negocio_id=$2`, [compraId, negocioId]);
  if (!compra) return null;
  const { rows: items } = await pool.query(
    `SELECT id, descripcion, cantidad, unidad, precio_unitario, importe, categoria,
            categoria_sugerida, confianza, orden
       FROM compras_operativas_items WHERE compra_id=$1 ORDER BY orden, created_at`, [compraId]);
  return { ...compra, items };
}

export async function listarCompras(negocioId, filtros = {}) {
  const desde = fecha(filtros.desde); const hasta = fecha(filtros.hasta);
  const estadoFactura = ESTADOS_FACTURA.has(filtros.estado_factura) ? filtros.estado_factura : null;
  const estado = ESTADOS.has(filtros.estado) ? filtros.estado : null;
  const q = texto(filtros.q, 120);
  const page = Math.max(1, parseInt(filtros.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(filtros.size, 10) || 50));
  const offset = (page - 1) * size;
  const args = [negocioId]; const where = ['negocio_id=$1'];
  if (desde) { args.push(desde); where.push(`fecha >= $${args.length}`); }
  if (hasta) { args.push(hasta); where.push(`fecha <= $${args.length}`); }
  if (estadoFactura) { args.push(estadoFactura); where.push(`estado_factura = $${args.length}`); }
  if (estado) { args.push(estado); where.push(`estado = $${args.length}`); }
  if (q) { args.push(`%${q}%`); where.push(`(proveedor ILIKE $${args.length} OR numero_ticket ILIKE $${args.length})`); }
  const base = where.join(' AND ');
  const { rows: [conteo] } = await pool.query(`SELECT COUNT(*)::int AS total FROM compras_operativas WHERE ${base}`, args);
  args.push(size, offset);
  const { rows } = await pool.query(
    `SELECT id, proveedor, fecha, total, tipo_pago, estado_factura, estado, origen,
            confidence, advertencias, numero_ticket, created_at, confirmed_at,
            (ticket_storage_key IS NOT NULL) AS tiene_ticket
       FROM compras_operativas WHERE ${base}
      ORDER BY COALESCE(fecha, created_at::date) DESC, created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
  return { compras: rows, total: conteo.total, page, size };
}

export async function registrarFondo(negocioId, input = {}, createdBy = null) {
  const f = fecha(input.fecha) || new Date().toISOString().slice(0, 10);
  const monto = dinero(input.monto, { permitirCero: false });
  if (!(monto > 0)) throw new CompraOperativaError('El monto transferido debe ser mayor a cero', 'MONTO_FONDO_INVALIDO');
  const { rows: [r] } = await pool.query(
    `INSERT INTO fondos_compras (negocio_id, fecha, monto, responsable, notas, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [negocioId, f, monto, texto(input.responsable, 180), texto(input.notas, 1000), createdBy]);
  return r;
}

export async function resumenCompras(negocioId, filtros = {}) {
  const hoy = new Date();
  const lunes = new Date(hoy); const dia = lunes.getUTCDay() || 7; lunes.setUTCDate(lunes.getUTCDate() - dia + 1);
  const desde = fecha(filtros.desde) || lunes.toISOString().slice(0, 10);
  const hasta = fecha(filtros.hasta) || hoy.toISOString().slice(0, 10);
  const [fondos, compras] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(monto),0)::float AS transferido
         FROM fondos_compras WHERE negocio_id=$1 AND fecha BETWEEN $2 AND $3`, [negocioId, desde, hasta]),
    pool.query(
      `SELECT COALESCE(SUM(total),0)::float AS comprobado,
              COUNT(*)::int AS compras,
              COALESCE(SUM(total) FILTER (WHERE estado_factura <> 'facturado'),0)::float AS sin_factura_monto,
              COUNT(*) FILTER (WHERE estado_factura <> 'facturado')::int AS sin_factura_count,
              COALESCE(SUM(total) FILTER (WHERE tipo_pago='credito'),0)::float AS credito_monto,
              COUNT(*) FILTER (WHERE tipo_pago='credito')::int AS credito_count
         FROM compras_operativas
        WHERE negocio_id=$1 AND estado='confirmada' AND fecha BETWEEN $2 AND $3`, [negocioId, desde, hasta]),
  ]);
  const transferido = Number(fondos.rows[0]?.transferido || 0);
  const comprobado = Number(compras.rows[0]?.comprobado || 0);
  return {
    desde, hasta, transferido, comprobado,
    saldo_por_comprobar: Math.max(0, Math.round((transferido - comprobado) * 100) / 100),
    excedente_compras: Math.max(0, Math.round((comprobado - transferido) * 100) / 100),
    compras: compras.rows[0]?.compras || 0,
    sin_factura_monto: Number(compras.rows[0]?.sin_factura_monto || 0),
    sin_factura_count: compras.rows[0]?.sin_factura_count || 0,
    credito_monto: Number(compras.rows[0]?.credito_monto || 0),
    credito_count: compras.rows[0]?.credito_count || 0,
  };
}

export async function obtenerTicketPrivado(negocioId, compraId) {
  const { rows: [r] } = await pool.query(
    `SELECT ticket_storage_key, ticket_mime, ticket_nombre FROM compras_operativas
      WHERE id=$1 AND negocio_id=$2`, [compraId, negocioId]);
  return r?.ticket_storage_key ? r : null;
}
