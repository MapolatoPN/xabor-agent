import { pool } from './database.js';

export class CompraOperativaError extends Error {
  constructor(message, codigo = 'COMPRA_INVALIDA', status = 400) {
    super(message); this.name = 'CompraOperativaError'; this.codigo = codigo; this.status = status;
  }
}
export const fallo = (message, codigo, status) => { throw new CompraOperativaError(message, codigo, status); };
export const texto = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) || null : null;
export function fecha(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}
export function uuid(v) {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    fallo('Identificador inválido', 'ID_INVALIDO');
  return v.toLowerCase();
}
export function centavos(v) {
  // Rechaza redondeos silenciosos, exponentes, booleanos y valores fuera de numeric(12,2).
  if (!['string','number'].includes(typeof v) || !/^\d{1,10}(\.\d{1,2})?$/.test(String(v)))
    fallo('Indica un monto válido con hasta dos decimales', 'MONTO_INVALIDO');
  const [entero, decimal = ''] = String(v).split('.');
  const n = Number(entero) * 100 + Number(decimal.padEnd(2, '0'));
  if (n <= 0) fallo('El monto debe ser mayor a cero', 'MONTO_INVALIDO');
  return n;
}
export function versionActual(fila, version) {
  if (!Number.isInteger(version) || version !== fila.version)
    fallo('La compra cambió. Vuelve a abrirla antes de guardar.', 'VERSION_DESFASADA', 409);
}

export async function transaccion(negocioId, fn) {
  uuid(negocioId);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Un único orden de locks por negocio evita sobrepagos, duplicados concurrentes
    // y carreras entre devolución de fondo y pago. Nunca se llama la IA bajo este lock.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['compras:' + negocioId]);
    const result = await fn(db);
    await db.query('COMMIT'); return result;
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
export async function compraBloqueada(db, negocioId, id) {
  const { rows: [fila] } = await db.query('SELECT * FROM compras_operativas WHERE negocio_id=$1 AND id=$2 FOR UPDATE', [uuid(negocioId), uuid(id)]);
  if (!fila) fallo('Compra no encontrada', 'COMPRA_NO_ENCONTRADA', 404);
  return fila;
}
export async function hoyNegocio(db, negocioId, now = new Date()) {
  const { rows } = await db.query("SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='timezone' LIMIT 1", [negocioId]);
  let tz = rows[0]?.valor || 'America/Matamoros';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }).format(now); }
  catch { tz = 'America/Matamoros'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export async function fechaMovimiento(db, negocioId, value) {
  const f = fecha(value);
  if (!f) fallo('Indica una fecha válida', 'FECHA_REQUERIDA');
  if (f > await hoyNegocio(db, negocioId)) fallo('Un movimiento real no puede tener fecha futura', 'FECHA_FUTURA');
  return f;
}
async function responsablePropio(db, negocioId, id) {
  const { rows: [r] } = await db.query('SELECT * FROM compras_responsables WHERE negocio_id=$1 AND id=$2', [negocioId, uuid(id)]);
  if (!r) fallo('Responsable no encontrado', 'RESPONSABLE_NO_ENCONTRADO', 404);
  return r;
}

export async function listarResponsables(negocioId) {
  return (await pool.query('SELECT id,nombre FROM compras_responsables WHERE negocio_id=$1 ORDER BY nombre', [uuid(negocioId)])).rows;
}
export async function crearResponsable(negocioId, input) {
  const nombre = texto(input?.nombre, 180);
  if (!nombre) fallo('Indica el nombre del responsable', 'NOMBRE_REQUERIDO');
  return transaccion(negocioId, async db => {
    await db.query('INSERT INTO compras_responsables (negocio_id,nombre) VALUES ($1,$2) ON CONFLICT DO NOTHING', [negocioId,nombre]);
    return (await db.query('SELECT id,nombre FROM compras_responsables WHERE negocio_id=$1 AND lower(trim(nombre))=lower($2)', [negocioId,nombre])).rows[0];
  });
}

// Verifica TODOS los saldos diarios: un gasto retroactivo no puede dejar en
// negativo un día anterior aunque una transferencia posterior tape el hueco.
async function validarSaldos(db, negocioId, responsableId) {
  const { rows: [r] } = await db.query(`WITH movimientos AS (
    SELECT fecha, CASE WHEN tipo='entrega' THEN monto ELSE -monto END AS monto FROM fondos_compras
      WHERE negocio_id=$1 AND responsable_id=$2 AND revertido_at IS NULL
    UNION ALL SELECT fecha,-monto FROM compras_pagos
      WHERE negocio_id=$1 AND responsable_id=$2 AND origen='fondo' AND revertido_at IS NULL
  ), dias AS (SELECT fecha,SUM(monto) AS monto FROM movimientos GROUP BY fecha),
  saldos AS (SELECT SUM(monto) OVER (ORDER BY fecha) AS saldo FROM dias)
  SELECT MIN(saldo)::numeric AS minimo FROM saldos`, [negocioId,responsableId]);
  if (Number(r.minimo) < 0) fallo('El fondo no alcanza en esa fecha. Registra la entrega faltante o elige otra cuenta.', 'FONDO_INSUFICIENTE', 409);
}
function mismaOperacion(row, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === 'fecha' ? fecha(row[key]) : key === 'monto' ? Number(row[key]) : row[key];
    if (actual !== value) fallo('Ese intento ya se usó con otros datos. Revisa el movimiento registrado.', 'OPERACION_REUTILIZADA', 409);
  }
}

export async function registrarFondo(negocioId, input = {}, actor = null) {
  return transaccion(negocioId, async db => {
    const r = await responsablePropio(db, negocioId, input.responsable_id);
    const f = await fechaMovimiento(db, negocioId, input.fecha);
    const monto = centavos(input.monto) / 100;
    const clave = uuid(input.clave_operacion);
    if (!['entrega','devolucion'].includes(input.tipo)) fallo('Elige entrega o devolución', 'TIPO_FONDO_INVALIDO');
    const expected = { responsable_id:r.id, fecha:f, monto, tipo:input.tipo, notas:texto(input.notas,1000) };
    const { rows:[prev] } = await db.query('SELECT * FROM fondos_compras WHERE negocio_id=$1 AND clave_operacion=$2', [negocioId,clave]);
    if (prev) { mismaOperacion(prev,expected); return prev; }
    const { rows:[row] } = await db.query(`INSERT INTO fondos_compras
      (negocio_id,responsable_id,responsable,fecha,monto,tipo,notas,created_by,clave_operacion)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [negocioId,r.id,r.nombre,f,monto,input.tipo,expected.notas,actor,clave]);
    await validarSaldos(db,negocioId,r.id); return row;
  });
}

export async function pagoEnTransaccion(db, negocioId, compra, input, actor) {
  const f = await fechaMovimiento(db,negocioId,input.fecha);
  if (f < fecha(compra.fecha)) fallo('El pago no puede ser anterior a la compra', 'PAGO_ANTERIOR_COMPRA');
  const monto = centavos(input.monto) / 100;
  const clave = uuid(input.clave_operacion);
  let responsableId = null, cuenta = null;
  if (input.origen === 'fondo') responsableId = (await responsablePropio(db,negocioId,input.responsable_id)).id;
  else if (input.origen === 'otra_cuenta') {
    cuenta = texto(input.cuenta,180);
    if (!cuenta) fallo('Indica desde qué cuenta o recurso se pagó', 'CUENTA_REQUERIDA');
  } else fallo('Elige el origen del dinero', 'ORIGEN_REQUERIDO');
  const expected = { compra_id:compra.id, fecha:f, monto, origen:input.origen, responsable_id:responsableId,
    cuenta, referencia:texto(input.referencia,180), notas:texto(input.notas,1000) };
  const { rows:[prev] } = await db.query('SELECT * FROM compras_pagos WHERE negocio_id=$1 AND clave_operacion=$2', [negocioId,clave]);
  if (prev) { mismaOperacion(prev,expected); return prev; }
  if (compra.estado !== 'confirmada') fallo('Confirma la compra antes de registrar pagos', 'COMPRA_NO_CONFIRMADA',409);
  if (!compra.pagos_revisados) fallo('Revisa primero los pagos de esta compra histórica', 'PAGOS_HISTORICOS_SIN_REVISAR',409);
  const { rows:[sum] } = await db.query('SELECT COALESCE(SUM(monto),0) AS pagado FROM compras_pagos WHERE negocio_id=$1 AND compra_id=$2 AND revertido_at IS NULL', [negocioId,compra.id]);
  if (Math.round(Number(sum.pagado)*100) + centavos(input.monto) > centavos(compra.total))
    fallo('El pago supera lo pendiente de esta compra', 'SOBREPAGO',409);
  const { rows:[row] } = await db.query(`INSERT INTO compras_pagos
    (negocio_id,compra_id,fecha,monto,origen,responsable_id,cuenta,referencia,notas,clave_operacion,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [negocioId,compra.id,f,monto,input.origen,responsableId,cuenta,expected.referencia,expected.notas,clave,actor]);
  if (responsableId) await validarSaldos(db,negocioId,responsableId);
  return row;
}
export async function registrarPagoCompra(negocioId, id, input, actor = null) {
  return transaccion(negocioId, async db => pagoEnTransaccion(db,negocioId,await compraBloqueada(db,negocioId,id),input,actor));
}
export async function revertirMovimiento(negocioId, clase, id, input, actor = null) {
  // El nombre de tabla nunca viene del request.
  const table = clase === 'pago' ? 'compras_pagos' : clase === 'fondo' ? 'fondos_compras' : null;
  if (!table) fallo('Movimiento inválido','MOVIMIENTO_INVALIDO');
  const motivo = texto(input?.motivo,1000);
  if (!motivo) fallo('Indica el motivo de la corrección','MOTIVO_REQUERIDO');
  return transaccion(negocioId,async db => {
    const { rows:[row] } = await db.query(`SELECT * FROM ${table} WHERE negocio_id=$1 AND id=$2 FOR UPDATE`,[negocioId,uuid(id)]);
    if (!row) fallo('Movimiento no encontrado','MOVIMIENTO_NO_ENCONTRADO',404);
    if (row.revertido_at) return row;
    const { rows:[result] } = await db.query(`UPDATE ${table} SET revertido_at=now(),revertido_por=$3,motivo_reversion=$4 WHERE negocio_id=$1 AND id=$2 RETURNING *`,[negocioId,id,actor,motivo]);
    if (row.responsable_id) await validarSaldos(db,negocioId,row.responsable_id);
    return result;
  });
}

export async function resumenCompras(negocioId, filtros = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const hoy = await hoyNegocio(db,uuid(negocioId));
    const lunes = new Date(hoy+'T00:00:00Z'); lunes.setUTCDate(lunes.getUTCDate()-((lunes.getUTCDay()+6)%7));
    const desde = filtros.desde === undefined ? lunes.toISOString().slice(0,10) : fecha(filtros.desde);
    const hasta = filtros.hasta === undefined ? hoy : fecha(filtros.hasta);
    if (!desde || !hasta || desde > hasta || hasta > hoy) fallo('Revisa el periodo del resumen','PERIODO_INVALIDO');
    const args=[negocioId,desde,hasta];
    const { rows:[comp] } = await db.query(`SELECT COUNT(*)::int AS compras,COALESCE(SUM(total),0)::float AS comprobado,
      COALESCE(SUM(total) FILTER (WHERE estado_factura<>'facturado'),0)::float AS sin_factura_monto,
      COUNT(*) FILTER (WHERE estado_factura<>'facturado')::int AS sin_factura_count
      FROM compras_operativas WHERE negocio_id=$1 AND estado='confirmada' AND fecha BETWEEN $2 AND $3`,args);
    const { rows:deudas } = await db.query(`SELECT c.id,c.proveedor,c.fecha,c.total,c.pagos_revisados,
      COALESCE((SELECT SUM(p.monto) FROM compras_pagos p WHERE p.negocio_id=c.negocio_id AND p.compra_id=c.id AND p.revertido_at IS NULL AND p.fecha<=$2),0)::float AS pagado
      FROM compras_operativas c WHERE c.negocio_id=$1 AND c.estado='confirmada' AND c.fecha<=$2 ORDER BY c.fecha,c.created_at`,[negocioId,hasta]);
    const pendientes = deudas.filter(c=>c.pagos_revisados && Math.round(Number(c.total)*100)>Math.round(c.pagado*100)).map(c=>({...c,total:Number(c.total),pendiente:Math.round((Number(c.total)-c.pagado)*100)/100}));
    const { rows:responsables } = await db.query(`WITH mov AS (
      SELECT responsable_id,fecha,CASE WHEN tipo='entrega' THEN monto ELSE -monto END AS monto,
        CASE WHEN tipo='entrega' THEN monto ELSE 0 END AS entregado,
        CASE WHEN tipo='devolucion' THEN monto ELSE 0 END AS devuelto,0::numeric AS pagado
      FROM fondos_compras WHERE negocio_id=$1 AND revertido_at IS NULL AND responsable_id IS NOT NULL
      UNION ALL SELECT responsable_id,fecha,-monto,0,0,monto FROM compras_pagos
        WHERE negocio_id=$1 AND origen='fondo' AND revertido_at IS NULL
    ) SELECT r.id,r.nombre,
      COALESCE(SUM(m.monto) FILTER (WHERE m.fecha<$2),0)::float AS saldo_anterior,
      COALESCE(SUM(m.entregado) FILTER (WHERE m.fecha BETWEEN $2 AND $3),0)::float AS entregado,
      COALESCE(SUM(m.devuelto) FILTER (WHERE m.fecha BETWEEN $2 AND $3),0)::float AS devuelto,
      COALESCE(SUM(m.pagado) FILTER (WHERE m.fecha BETWEEN $2 AND $3),0)::float AS pagado,
      COALESCE(SUM(m.monto) FILTER (WHERE m.fecha<=$3),0)::float AS saldo
      FROM compras_responsables r LEFT JOIN mov m ON m.responsable_id=r.id WHERE r.negocio_id=$1 GROUP BY r.id ORDER BY r.nombre`,args);
    const { rows:[pagos] } = await db.query(`SELECT COALESCE(SUM(monto),0)::float AS pagado_periodo,
      COALESCE(SUM(monto) FILTER (WHERE origen='otra_cuenta'),0)::float AS pagado_otra_cuenta
      FROM compras_pagos WHERE negocio_id=$1 AND revertido_at IS NULL AND fecha BETWEEN $2 AND $3`,args);
    const { rows:fondos } = await db.query(`SELECT f.*,r.nombre FROM fondos_compras f LEFT JOIN compras_responsables r ON r.id=f.responsable_id AND r.negocio_id=f.negocio_id
      WHERE f.negocio_id=$1 AND f.fecha BETWEEN $2 AND $3 ORDER BY f.fecha DESC,f.created_at DESC LIMIT 100`,args);
    const { rows:[legacy] } = await db.query('SELECT COUNT(*)::int AS fondos_sin_responsable FROM fondos_compras WHERE negocio_id=$1 AND responsable_id IS NULL AND revertido_at IS NULL AND fecha<=$2',[negocioId,hasta]);
    await db.query('COMMIT');
    const sum = key=>Math.round(responsables.reduce((s,r)=>s+r[key],0)*100)/100;
    return { desde,hasta,hoy,...comp,...pagos,...legacy,responsables,fondos,pendientes,
      compras_sin_revisar:deudas.filter(c=>!c.pagos_revisados).length,
      deuda_proveedores:Math.round(pendientes.reduce((s,c)=>s+c.pendiente,0)*100)/100,
      transferido:sum('entregado'),saldo_anterior:sum('saldo_anterior'),saldo_fondo:sum('saldo'),devuelto:sum('devuelto'),pagado_fondo:sum('pagado') };
  } catch(e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
