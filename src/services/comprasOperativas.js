import { pool } from './database.js';
import { CATEGORIAS_COMPRA } from './ticketComprasIA.js';
import { CompraOperativaError, transaccion, compraBloqueada, versionActual, pagoEnTransaccion, fechaMovimiento, centavos, uuid } from './comprasFinanzas.js';
export { CompraOperativaError, registrarFondo, resumenCompras } from './comprasFinanzas.js';

const TIPOS_PAGO = new Set(['contado', 'credito']);
const ESTADOS_FACTURA = new Set(['no_facturado', 'pendiente', 'facturado']);
const ESTADOS = new Set(['borrador', 'confirmada', 'cancelada']);

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
  // pg puede devolver columnas DATE como Date según el parser/configuración.
  // Aceptamos ambos formatos para que validar una fila recién leída de DB no
  // convierta una fecha válida en null al momento de confirmar.
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}
function uuidOpcional(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

function validarCaptura(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CompraOperativaError('Compra inválida','COMPRA_INVALIDA');
  for (const key of ['total','subtotal','impuestos']) {
    const v=input[key];if(v===undefined||v===null||v==='')continue;
    if (!['string','number'].includes(typeof v) || !/^\d{1,10}(\.\d{1,2})?$/.test(String(v)))
      throw new CompraOperativaError('Revisa '+key+': usa un monto no negativo con hasta dos decimales','MONTO_INVALIDO');
  }
  if(input.fecha!==undefined&&input.fecha!==null&&input.fecha!==''&&!fecha(input.fecha))throw new CompraOperativaError('Fecha inválida','FECHA_REQUERIDA');
  if(input.tipo_pago!==undefined&&!TIPOS_PAGO.has(input.tipo_pago))throw new CompraOperativaError('Tipo de compra inválido','TIPO_PAGO_INVALIDO');
  if(input.estado_factura!==undefined&&!ESTADOS_FACTURA.has(input.estado_factura))throw new CompraOperativaError('Estado de factura inválido','FACTURA_INVALIDA');
  if(input.cfdi_uuid&&!uuidOpcional(input.cfdi_uuid))throw new CompraOperativaError('UUID de factura inválido','CFDI_INVALIDO');
  if (Array.isArray(input.items)) for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CompraOperativaError('Concepto inválido','ITEMS_INVALIDOS');
    for (const key of ['importe','precio_unitario','cantidad']) {
      const v=item[key];if(v===undefined||v===null||v==='')continue;
      const formato=key==='cantidad'? /^\d{1,9}(\.\d{1,3})?$/: /^\d{1,10}(\.\d{1,2})?$/;
      if (!['string','number'].includes(typeof v)||!formato.test(String(v)))
        throw new CompraOperativaError('Revisa '+key+' del concepto: el valor no es válido','MONTO_INVALIDO');
    }
  }
}

export function normalizarCompra(input = {}, { confirmar = false } = {}) {
  const tipoPago = TIPOS_PAGO.has(input.tipo_pago) ? input.tipo_pago : 'contado';
  const estadoFactura = ESTADOS_FACTURA.has(input.estado_factura) ? input.estado_factura : 'no_facturado';
  if (input.items !== undefined && (!Array.isArray(input.items) || input.items.length > 300))
    throw new CompraOperativaError('Envía una lista de hasta 300 conceptos', 'ITEMS_INVALIDOS');
  const items = (input.items || []).map((it, i) => {
    const descripcion = texto(it?.descripcion, 250);
    if (!descripcion) throw new CompraOperativaError(`El concepto ${i + 1} necesita descripción`, 'DESCRIPCION_REQUERIDA');
    const categoria = texto(it?.categoria, 80);
    const sugerida = CATEGORIAS_COMPRA.includes(it?.categoria_sugerida) ? it.categoria_sugerida : null;
    return {
      ...(it.id ? { id: uuid(it.id) } : {}),
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
       (id, compra_id, descripcion, cantidad, unidad, precio_unitario, importe,
        categoria, categoria_sugerida, confianza, orden)
       VALUES (COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [it.id || null, compraId, it.descripcion, it.cantidad, it.unidad, it.precio_unitario, it.importe,
       it.categoria, it.categoria_sugerida, it.confianza, it.orden]);
  }
}

export async function crearBorradorManual(negocioId, input = {}, createdBy = null) {
  uuid(negocioId);
  validarCaptura(input);
  const n = normalizarCompra(input);
  if (n.items.some(i=>i.id)) throw new CompraOperativaError('Los conceptos nuevos no llevan identificador', 'ITEM_ID_INVALIDO');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [compra] } = await client.query(
      `INSERT INTO compras_operativas
       (negocio_id, proveedor, fecha, subtotal, impuestos, total, tipo_pago,
        estado_factura, cfdi_uuid, estado, origen, notas, numero_ticket, created_by, pagos_revisados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'borrador','manual',$10,$11,$12,true)
       RETURNING *`,
      [negocioId, n.proveedor, n.fecha, n.subtotal, n.impuestos, n.total, n.tipo_pago,
       n.estado_factura, n.cfdi_uuid, n.notas, n.numero_ticket, createdBy]);
    await reemplazarItems(client, compra.id, n.items);
    const items = (await client.query('SELECT * FROM compras_operativas_items WHERE compra_id=$1 ORDER BY orden', [compra.id])).rows;
    await client.query('COMMIT');
    return { ...compra, items, pagos: [], pagado:0, pendiente:null };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function crearBorradorDesdeTicket(negocioId, extraccion, ticket, createdBy = null) {
  uuid(negocioId);
  const n = normalizarCompra({ ...extraccion, items: extraccion?.items || [] });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [compra] } = await client.query(
      `INSERT INTO compras_operativas
       (negocio_id, proveedor, fecha, subtotal, impuestos, total, tipo_pago,
        estado_factura, estado, origen, ticket_storage_key, ticket_mime,
        ticket_checksum, ticket_nombre, confidence, advertencias, numero_ticket, created_by, pagos_revisados)
       VALUES ($1,$2,$3,$4,$5,$6,'contado','no_facturado','borrador','ticket_ia',
               $7,$8,$9,$10,$11,$12::jsonb,$13,$14,true)
       RETURNING *`,
      [negocioId, n.proveedor, n.fecha, n.subtotal, n.impuestos, n.total,
       ticket.storageKey, ticket.mimeType, ticket.checksum, texto(ticket.nombre, 180),
       confianza(extraccion?.confianza), JSON.stringify(extraccion?.advertencias || []),
       n.numero_ticket, createdBy]);
    await reemplazarItems(client, compra.id, n.items);
    const items = (await client.query('SELECT * FROM compras_operativas_items WHERE compra_id=$1 ORDER BY orden', [compra.id])).rows;
    await client.query('COMMIT');
    return { ...compra, items, pagos: [], pagado:0, pendiente:null };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e?.code === '23505' && e?.constraint === 'idx_compras_operativas_ticket_checksum') {
      throw new CompraOperativaError('Este ticket ya fue registrado en este negocio', 'TICKET_DUPLICADO', 409);
    }
    throw e;
  } finally { client.release(); }
}

export async function actualizarBorrador(negocioId, compraId, input = {}) {
  validarCaptura(input);
  await transaccion(negocioId, async client => {
    const actual = await compraBloqueada(client,negocioId,compraId);
    if (actual.estado !== 'borrador') throw new CompraOperativaError('Solo se puede editar un borrador', 'COMPRA_NO_EDITABLE', 409);
    versionActual(actual,input.version);
    let items;
    if (Object.hasOwn(input,'items')) {
      if (!Array.isArray(input.items)) throw new CompraOperativaError('Conceptos inválidos','ITEMS_INVALIDOS');
      const anteriores = (await client.query('SELECT * FROM compras_operativas_items WHERE compra_id=$1',[compraId])).rows;
      const seen = new Set();
      items = input.items.map(it=>{
        if (!it.id) return it;
        const id = uuid(it.id);
        const anterior = anteriores.find(a=>a.id===id);
        if (!anterior || seen.has(id)) throw new CompraOperativaError('Concepto ajeno o repetido','ITEM_ID_INVALIDO');
        seen.add(id);
        // Los campos omitidos se conservan por ID estable, nunca por posición.
        return { ...anterior, ...it, id };
      });
    }
    const n = normalizarCompra({ ...actual, ...input, items });
    await client.query(
      `UPDATE compras_operativas SET
       proveedor=$3, fecha=$4, subtotal=$5, impuestos=$6, total=$7, tipo_pago=$8,
       estado_factura=$9, cfdi_uuid=$10, notas=$11, numero_ticket=$12, updated_at=NOW(), version=version+1
       WHERE id=$1 AND negocio_id=$2`,
      [compraId, negocioId, n.proveedor, n.fecha, n.subtotal, n.impuestos, n.total,
       n.tipo_pago, n.estado_factura, n.cfdi_uuid, n.notas, n.numero_ticket]);
    if (items !== undefined) await reemplazarItems(client, compraId, n.items);
  });
  return obtenerCompra(negocioId,compraId);
}

export async function confirmarCompra(negocioId, compraId, input = {}, actor = null) {
  await transaccion(negocioId,async client=>{
    const fila = await compraBloqueada(client,negocioId,compraId);
    // Repetir confirmar no registra otro pago ni modifica la compra.
    if (fila.estado === 'confirmada') return;
    if (fila.estado !== 'borrador') throw new CompraOperativaError('La compra no puede confirmarse', 'COMPRA_NO_CONFIRMABLE', 409);
    versionActual(fila,input.version);
    // WhatsApp elige el tipo y registra el pago en esta misma transacción.
    if (input.tipo_pago !== undefined) {
      if (!TIPOS_PAGO.has(input.tipo_pago)) throw new CompraOperativaError('Tipo de compra inválido','TIPO_PAGO_INVALIDO');
      fila.tipo_pago = input.tipo_pago;
      await client.query('UPDATE compras_operativas SET tipo_pago=$3 WHERE id=$1 AND negocio_id=$2',[compraId,negocioId,fila.tipo_pago]);
    }
    normalizarCompra(fila, { confirmar: true });
    centavos(fila.total);
    await fechaMovimiento(client,negocioId,fecha(fila.fecha));
    if (fila.tipo_pago === 'contado' && !input.pago_inicial)
      throw new CompraOperativaError('Indica desde dónde se pagó o cambia a crédito','PAGO_INICIAL_REQUERIDO');
    if (fila.tipo_pago === 'credito' && input.pago_inicial)
      throw new CompraOperativaError('Confirma a crédito y registra el abono por separado','PAGO_INICIAL_INVALIDO');
    await client.query(
      `UPDATE compras_operativas SET estado='confirmada', pagos_revisados=true, confirmed_at=NOW(), updated_at=NOW(), version=version+1
       WHERE id=$1 AND negocio_id=$2`, [compraId, negocioId]);
    if (input.pago_inicial) await pagoEnTransaccion(client,negocioId,{...fila,estado:'confirmada',pagos_revisados:true},
      {...input.pago_inicial,monto:fila.total,fecha:fecha(fila.fecha)},actor);
  });
  return obtenerCompra(negocioId,compraId);
}

export async function cancelarCompra(negocioId, compraId, input = {}, actor = null) {
  await transaccion(negocioId,async client=>{
    const fila = await compraBloqueada(client,negocioId,compraId);
    if (fila.estado==='cancelada') return;
    versionActual(fila,input.version);
    const motivo = texto(input.motivo,1000);
    if (!motivo) throw new CompraOperativaError('Indica el motivo de cancelación','MOTIVO_REQUERIDO');
    if (fila.estado==='confirmada' && !fila.pagos_revisados) throw new CompraOperativaError('Revisa los pagos históricos antes de cancelar','PAGOS_HISTORICOS_SIN_REVISAR',409);
    const {rows} = await client.query('SELECT id FROM compras_pagos WHERE negocio_id=$1 AND compra_id=$2 AND revertido_at IS NULL LIMIT 1',[negocioId,compraId]);
    if (rows.length) throw new CompraOperativaError('La compra tiene pagos. Revisa y corrige los registros de pago antes de cancelar.','COMPRA_CON_PAGOS',409);
    await client.query(`UPDATE compras_operativas SET estado='cancelada',cancelacion_motivo=$3,cancelado_por=$4,cancelado_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND negocio_id=$2`,[compraId,negocioId,motivo,actor]);
  });
  return obtenerCompra(negocioId,compraId);
}

export async function obtenerCompra(negocioId, compraId) {
  uuid(negocioId); uuid(compraId);
  // Una sola sentencia: cabecera, conceptos y pagos pertenecen al mismo snapshot.
  const { rows: [compra] } = await pool.query(
    `SELECT c.*,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.orden,i.created_at) FROM compras_operativas_items i WHERE i.compra_id=c.id),'[]'::jsonb) AS items,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('responsable',r.nombre) ORDER BY p.fecha,p.created_at)
        FROM compras_pagos p LEFT JOIN compras_responsables r ON r.negocio_id=p.negocio_id AND r.id=p.responsable_id
        WHERE p.negocio_id=c.negocio_id AND p.compra_id=c.id),'[]'::jsonb) AS pagos
      FROM compras_operativas c WHERE c.id=$1 AND c.negocio_id=$2`, [compraId, negocioId]);
  if (!compra) return null;
  const { items,pagos }=compra;
  const pagado = Math.round(pagos.filter(p=>!p.revertido_at).reduce((s,p)=>s+Number(p.monto),0)*100)/100;
  return { ...compra, items, pagos, pagado, pendiente:compra.estado==='confirmada' && compra.pagos_revisados ? Math.round((Number(compra.total)-pagado)*100)/100 : null };
}

export async function actualizarFacturaCompra(negocioId, compraId, input = {}, actor = null) {
  validarCaptura(input);
  if (!ESTADOS_FACTURA.has(input.estado_factura)) throw new CompraOperativaError('Elige el estado de la factura','FACTURA_INVALIDA');
  if(input.cfdi_uuid&&input.estado_factura!=='facturado')throw new CompraOperativaError('Un UUID requiere estado facturada','FACTURA_INVALIDA');
  await transaccion(negocioId,async db=>{
    const c=await compraBloqueada(db,negocioId,compraId);
    if(c.estado!=='confirmada')throw new CompraOperativaError('Esta acción corresponde a una compra confirmada','COMPRA_NO_CONFIRMADA',409);
    versionActual(c,input.version);
    const anterior={estado_factura:c.estado_factura,cfdi_uuid:c.cfdi_uuid};
    const nuevo={estado_factura:input.estado_factura,cfdi_uuid:uuidOpcional(input.cfdi_uuid)};
    await db.query('UPDATE compras_operativas SET estado_factura=$3,cfdi_uuid=$4,version=version+1,updated_at=now() WHERE negocio_id=$1 AND id=$2',[negocioId,compraId,nuevo.estado_factura,nuevo.cfdi_uuid]);
    await db.query('INSERT INTO compras_factura_cambios(negocio_id,compra_id,anterior,nuevo,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[negocioId,compraId,JSON.stringify(anterior),JSON.stringify(nuevo),actor]);
  });
  return obtenerCompra(negocioId,compraId);
}

export async function listarCompras(negocioId, filtros = {}) {
  uuid(negocioId);
  const desde = fecha(filtros.desde); const hasta = fecha(filtros.hasta);
  if ((filtros.desde&&!desde)||(filtros.hasta&&!hasta)||(desde&&hasta&&desde>hasta))throw new CompraOperativaError('Revisa las fechas del filtro','PERIODO_INVALIDO');
  const estadoFactura = ESTADOS_FACTURA.has(filtros.estado_factura) ? filtros.estado_factura : null;
  const estado = ESTADOS.has(filtros.estado) ? filtros.estado : null;
  const q = texto(filtros.q, 120);
  const page = Math.max(1, parseInt(filtros.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(filtros.size, 10) || 50));
  const offset = (page - 1) * size;
  const args = [negocioId]; const where = ['negocio_id=$1'];
  if (desde) { args.push(desde); where.push(`(fecha >= $${args.length} OR (estado='borrador' AND fecha IS NULL))`); }
  if (hasta) { args.push(hasta); where.push(`(fecha <= $${args.length} OR (estado='borrador' AND fecha IS NULL))`); }
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

export async function obtenerTicketPrivado(negocioId, compraId) {
  uuid(negocioId);uuid(compraId);
  const { rows: [r] } = await pool.query(
    `SELECT ticket_storage_key, ticket_mime, ticket_nombre FROM compras_operativas
      WHERE id=$1 AND negocio_id=$2`, [compraId, negocioId]);
  return r?.ticket_storage_key ? r : null;
}
