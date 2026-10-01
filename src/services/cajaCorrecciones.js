// Correcciones de caja: fondo inicial y movimientos (entrada, retiro, gasto)
// capturados por error.
//
// REGLAS
// - Solo con el día ABIERTO. Un corte cerrado es un arqueo firmado y nada de
//   aquí lo reescribe (mismo criterio que registrarMovimiento y cerrarCorte).
// - Toda corrección pide motivo y deja antes/después/usuario en
//   caja_correcciones (migración 112), en la MISMA transacción que el cambio.
// - Toma el mismo cerrojo por negocio que cerrarCorte: una corrección y un
//   cierre simultáneos se serializan, y la corrección vuelve a mirar si el
//   día ya quedó cerrado antes de tocar nada.
// - Anular borra el movimiento; su copia íntegra queda en `antes`.

import { pool } from './database.js';
import {
  TIPOS_MOVIMIENTO, zonaHorariaNegocio, fechaOperativaHoy, esFechaValida,
} from './cortesCaja.js';

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tope de cordura, no de negocio: atrapa un dedo que se fue y deja pasar
// cualquier fondo o gasto real de un restaurante.
const MONTO_MAXIMO = 10_000_000;

function error(code, message) {
  const e = new Error(message); e.code = code; return e;
}

function motivoValido(motivo) {
  if (typeof motivo !== 'string' || !motivo.trim()) {
    throw error('MOTIVO_REQUERIDO', 'Escribe el motivo de la corrección');
  }
  return motivo.trim().slice(0, 200);
}

function montoValido(monto, { permitirCero }) {
  // Number(null) y Number('') son 0: un campo vacío no puede volverse un
  // fondo de $0 sin que nadie lo haya escrito.
  const vacio = monto === null || monto === undefined || typeof monto === 'boolean' || String(monto).trim() === '';
  const m = vacio ? NaN : Number(monto);
  if (!Number.isFinite(m) || m < 0 || (!permitirCero && m === 0)) {
    throw error('MONTO_INVALIDO', permitirCero ? 'Monto inválido' : 'El monto debe ser mayor que cero');
  }
  if (m > MONTO_MAXIMO) throw error('MONTO_INVALIDO', 'El monto es demasiado grande');
  return dinero(m);
}

// Abre la transacción con el cerrojo de cortes del negocio y rechaza si el
// día ya está cerrado. Devuelve el cliente con la transacción abierta.
async function transaccionDiaAbierto(negocioId, fecha) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('cortes_caja'), hashtext($1))`, [negocioId]);
    const { rows } = await client.query(
      `SELECT folio FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [negocioId, fecha]);
    if (rows[0]) {
      throw error('CORTE_CERRADO', `El corte del ${fecha} ya está cerrado (${rows[0].folio}): no se puede corregir`);
    }
    return client;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
}

async function terminar(client, fn) {
  try {
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function asentar(client, { negocioId, fecha, objeto, accion, movimientoId = null, antes, despues = null, motivo, usuarioId }) {
  await client.query(
    `INSERT INTO caja_correcciones
       (negocio_id, fecha_operativa, objeto, accion, movimiento_id, antes, despues, motivo, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [negocioId, fecha, objeto, accion, movimientoId, JSON.stringify(antes),
     despues === null ? null : JSON.stringify(despues), motivo, usuarioId]);
}

/**
 * Registra el fondo del día o lo corrige.
 * - Sin fondo: lo registra (no pide motivo).
 * - Mismo monto: no hace nada.
 * - Monto distinto: pide motivo, lo reemplaza y lo asienta en la bitácora.
 */
export async function fijarFondoCaja(negocioId, { monto, fecha = null, motivo = null, usuarioId = null }) {
  const nuevo = montoValido(monto, { permitirCero: true });
  const tz = await zonaHorariaNegocio(negocioId);
  const dia = esFechaValida(fecha) ? fecha : fechaOperativaHoy(tz);
  const client = await transaccionDiaAbierto(negocioId, dia);
  return terminar(client, async () => {
    const { rows } = await client.query(
      `SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2 FOR UPDATE`, [negocioId, dia]);
    if (!rows[0]) {
      await client.query(
        `INSERT INTO caja_fondos (fecha, fondo, negocio_id) VALUES ($1,$2,$3)`, [dia, nuevo, negocioId]);
      return { accion: 'registrado', fecha: dia, fondo: nuevo, anterior: null };
    }
    const anterior = dinero(rows[0].fondo);
    if (anterior === nuevo) return { accion: 'sin_cambio', fecha: dia, fondo: nuevo, anterior };
    const razon = motivoValido(motivo);
    await client.query(
      `UPDATE caja_fondos SET fondo = $1 WHERE negocio_id = $2 AND fecha = $3`, [nuevo, negocioId, dia]);
    await asentar(client, {
      negocioId, fecha: dia, objeto: 'fondo', accion: 'corregir',
      antes: { fondo: anterior }, despues: { fondo: nuevo }, motivo: razon, usuarioId });
    return { accion: 'corregido', fecha: dia, fondo: nuevo, anterior };
  });
}

// Lee el movimiento antes de abrir la transacción: su fecha decide qué día
// hay que comprobar abierto. Dentro se vuelve a leer con FOR UPDATE.
async function fechaDelMovimiento(negocioId, id) {
  if (!UUID_RE.test(String(id || ''))) throw error('NO_ENCONTRADO', 'Movimiento no encontrado');
  const { rows } = await pool.query(
    `SELECT to_char(fecha_operativa, 'YYYY-MM-DD') AS fecha FROM movimientos_caja WHERE id = $1 AND negocio_id = $2`,
    [id, negocioId]);
  if (!rows[0]) throw error('NO_ENCONTRADO', 'Movimiento no encontrado');
  return rows[0].fecha;
}

async function movimientoBloqueado(client, negocioId, id) {
  const { rows } = await client.query(
    `SELECT id, tipo, monto, motivo, usuario_id, corte_id,
            to_char(fecha_operativa, 'YYYY-MM-DD') AS fecha_operativa, created_at
       FROM movimientos_caja WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [id, negocioId]);
  const mov = rows[0];
  if (!mov) throw error('NO_ENCONTRADO', 'Movimiento no encontrado');
  if (mov.corte_id) throw error('CORTE_CERRADO', 'Ese movimiento ya entró a un corte cerrado: no se puede corregir');
  return mov;
}

const copia = (m) => ({ tipo: m.tipo, monto: dinero(m.monto), motivo: m.motivo });

/** Cambia tipo, monto o descripción de un movimiento del día abierto. */
export async function corregirMovimiento(negocioId, id, { tipo, monto, descripcion, motivo, usuarioId = null }) {
  const fecha = await fechaDelMovimiento(negocioId, id);
  const client = await transaccionDiaAbierto(negocioId, fecha);
  return terminar(client, async () => {
    const mov = await movimientoBloqueado(client, negocioId, id);
    const antes = copia(mov);
    const despues = {
      tipo: tipo === undefined || tipo === null || tipo === '' ? antes.tipo : tipo,
      monto: monto === undefined || monto === null || monto === '' ? antes.monto : montoValido(monto, { permitirCero: false }),
      motivo: typeof descripcion === 'string' && descripcion.trim() ? descripcion.trim().slice(0, 200) : antes.motivo,
    };
    if (!TIPOS_MOVIMIENTO.includes(despues.tipo)) throw error('TIPO_INVALIDO', `Tipo de movimiento inválido: ${despues.tipo}`);
    if (JSON.stringify(antes) === JSON.stringify(despues)) return { accion: 'sin_cambio', movimiento: { ...mov, ...despues } };
    const razon = motivoValido(motivo);
    const { rows: [actualizado] } = await client.query(
      `UPDATE movimientos_caja SET tipo = $1, monto = $2, motivo = $3
        WHERE id = $4 AND negocio_id = $5 RETURNING *`,
      [despues.tipo, despues.monto, despues.motivo, id, negocioId]);
    await asentar(client, {
      negocioId, fecha, objeto: 'movimiento', accion: 'corregir', movimientoId: id,
      antes, despues, motivo: razon, usuarioId });
    return { accion: 'corregido', movimiento: actualizado };
  });
}

/** Anula (borra) un movimiento del día abierto; la bitácora guarda la copia. */
export async function anularMovimiento(negocioId, id, { motivo, usuarioId = null }) {
  const razon = motivoValido(motivo);
  const fecha = await fechaDelMovimiento(negocioId, id);
  const client = await transaccionDiaAbierto(negocioId, fecha);
  return terminar(client, async () => {
    const mov = await movimientoBloqueado(client, negocioId, id);
    await asentar(client, {
      negocioId, fecha, objeto: 'movimiento', accion: 'anular', movimientoId: id,
      antes: { ...copia(mov), usuario_id: mov.usuario_id, created_at: mov.created_at },
      motivo: razon, usuarioId });
    await client.query(`DELETE FROM movimientos_caja WHERE id = $1 AND negocio_id = $2`, [id, negocioId]);
    return { accion: 'anulado', movimiento: copia(mov) };
  });
}

/**
 * Correcciones de un día, para mostrarlas junto al corte. Sin la tabla
 * (binario nuevo antes que la 112) devuelve [] en vez de tumbar el corte.
 */
export async function listarCorreccionesCaja(negocioId, fecha) {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.objeto, c.accion, c.movimiento_id, c.antes, c.despues, c.motivo, c.created_at,
              u.nombre AS usuario
         FROM caja_correcciones c LEFT JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.negocio_id = $1 AND c.fecha_operativa = $2
        ORDER BY c.created_at`, [negocioId, fecha]);
    return rows;
  } catch (e) {
    if (e.code !== '42P01') console.warn('[Caja] correcciones:', e.message);
    return [];
  }
}

export const CODIGOS_HTTP_CORRECCION = Object.freeze({
  TIPO_INVALIDO: 400, MONTO_INVALIDO: 400, MOTIVO_REQUERIDO: 400, NO_ENCONTRADO: 404, CORTE_CERRADO: 409,
});
