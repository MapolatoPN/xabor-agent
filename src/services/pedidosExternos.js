// Ledger de pedidos que nacen en una plataforma externa (hoy: Rappi).
//
// Responde UNA pregunta con memoria en Postgres: "¿esta orden de esta
// plataforma ya entró a este negocio, y en qué quedó?". Es la única
// deduplicación válida para pedidos externos -- la memoria del tablero
// (obtenerPedidos) no cuenta, porque se vacía al entregar y no sobrevive a dos
// procesos.
//
// Contrato de `reclamar`:
//   { accion: 'procesar',  registro }  -- esta llamada es dueña de la orden.
//   { accion: 'duplicado', registro }  -- ya existe un pedido (o se canceló):
//                                        no se crea nada, no se llama al
//                                        proveedor.
//   { accion: 'en_curso',  registro }  -- otro proceso la está creando ahora
//                                        mismo: no se toca.
//
// La exclusividad la da UNIQUE (negocio_id, canal, id_externo) más una
// actualización condicional por estado: dos procesos nunca pueden obtener
// 'procesar' para la misma orden al mismo tiempo, ni aunque lleguen en el
// mismo milisegundo.
import { pool } from './database.js';

// Un reclamo más viejo que esto sin terminar significa que el proceso murió
// (un pedido se crea en segundos, no en minutos). El reconciliador lo retoma.
export const RECLAMO_CADUCA_MS = 3 * 60 * 1000;
export const MAX_INTENTOS = 5;

function exigir(valor, nombre) {
  if (typeof valor !== 'string' || !valor.trim()) {
    const e = new Error(`pedidosExternos: ${nombre} requerido`);
    e.code = 'TENANT_CONTEXT_REQUIRED';
    throw e;
  }
  return valor.trim();
}

export async function reclamarPedidoExterno({ negocioId, canal, idExterno, payload }, db = pool) {
  const nid = exigir(negocioId, 'negocioId');
  const c = exigir(canal, 'canal');
  const ext = exigir(String(idExterno ?? ''), 'idExterno');

  // `xmax = 0` distingue una fila recién insertada de una ya existente que el
  // ON CONFLICT actualizó -- sin una segunda consulta y sin carrera.
  const { rows: [r] } = await db.query(
    `INSERT INTO pedidos_externos (negocio_id, canal, id_externo, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (negocio_id, canal, id_externo) DO UPDATE
       SET reentregas = pedidos_externos.reentregas + 1
     RETURNING id, estado, folio, intentos, reentregas, recibido_at, actualizado_at,
               aceptado_en_proveedor, listo_notificado_at, (xmax = 0) AS insertado`,
    [nid, c, ext, JSON.stringify(payload ?? {})]
  );
  if (r.insertado) return { accion: 'procesar', registro: r };
  if (r.estado === 'creado' || r.estado === 'cancelado') return { accion: 'duplicado', registro: r };

  // 'fallido', o 'reclamado' caducado: se vuelve a tomar de forma ATÓMICA.
  // El WHERE repite la condición: si otro proceso la tomó entre la lectura
  // y esta línea, la actualización no afecta filas y se responde en_curso.
  const { rows: [tomada] } = await db.query(
    `UPDATE pedidos_externos
        SET estado = 'reclamado', intentos = intentos + 1, payload = $2, actualizado_at = NOW()
      WHERE id = $1
        AND intentos < $3
        AND (estado = 'fallido' OR (estado = 'reclamado' AND actualizado_at < NOW() - ($4::int * interval '1 millisecond')))
      RETURNING id, estado, folio, intentos, reentregas, recibido_at, actualizado_at, aceptado_en_proveedor, listo_notificado_at`,
    [r.id, JSON.stringify(payload ?? {}), MAX_INTENTOS, RECLAMO_CADUCA_MS]
  );
  if (tomada) return { accion: 'procesar', registro: tomada };
  return { accion: 'en_curso', registro: r };
}

// Reconciliación: vuelve a tomar UNA fila pendiente (fallida o reclamada y
// caducada) con la misma condición atómica que `reclamar`, sin contar una
// reentrega. Devuelve la fila si este llamador la ganó; null si otro la tomó
// antes o ya no está pendiente.
export async function retomarPedidoExterno(id, db = pool) {
  const { rows: [tomada] } = await db.query(
    `UPDATE pedidos_externos
        SET estado = 'reclamado', intentos = intentos + 1, actualizado_at = NOW()
      WHERE id = $1
        AND intentos < $2
        AND (estado = 'fallido' OR (estado = 'reclamado' AND actualizado_at < NOW() - ($3::int * interval '1 millisecond')))
      RETURNING id, negocio_id, canal, id_externo, estado, folio, payload, intentos, reentregas, recibido_at, actualizado_at`,
    [id, MAX_INTENTOS, RECLAMO_CADUCA_MS]
  );
  return tomada || null;
}

export async function marcarPedidoExternoCreado(id, { folio, aceptado = null, aceptacionError = null }, db = pool) {
  await db.query(
    `UPDATE pedidos_externos
        SET estado = 'creado', folio = $2, aceptado_en_proveedor = $3, aceptacion_error = $4,
            ultimo_error = NULL, actualizado_at = NOW()
      WHERE id = $1`,
    [id, folio, aceptado, aceptacionError ? String(aceptacionError).slice(0, 500) : null]
  );
}

export async function marcarAceptacionProveedor(id, { aceptado, error = null }, db = pool) {
  await db.query(
    `UPDATE pedidos_externos
        SET aceptado_en_proveedor = $2, aceptacion_error = $3, actualizado_at = NOW()
      WHERE id = $1`,
    [id, aceptado, error ? String(error).slice(0, 500) : null]
  );
}

export async function marcarPedidoExternoFallido(id, error, db = pool) {
  await db.query(
    `UPDATE pedidos_externos
        SET estado = 'fallido', ultimo_error = $2, actualizado_at = NOW()
      WHERE id = $1 AND estado = 'reclamado'`,
    [id, String(error?.message || error || 'error').slice(0, 500)]
  );
}

export async function marcarPedidoExternoCancelado(id, cancelacion, db = pool) {
  await db.query(
    `UPDATE pedidos_externos
        SET estado = 'cancelado', cancelacion = $2, actualizado_at = NOW()
      WHERE id = $1`,
    [id, JSON.stringify(cancelacion ?? {})]
  );
}

// Marca "listo" notificado UNA sola vez: devuelve true solo para el llamador
// que ganó la marca. Rappi corta después de tres ready-for-pickup por orden;
// aquí nunca se manda más de uno.
export async function marcarListoNotificado(negocioId, canal, folio, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE pedidos_externos
        SET listo_notificado_at = NOW(), actualizado_at = NOW()
      WHERE negocio_id = $1 AND canal = $2 AND folio = $3 AND listo_notificado_at IS NULL`,
    [exigir(negocioId, 'negocioId'), exigir(canal, 'canal'), exigir(folio, 'folio')]
  );
  return rowCount > 0;
}

export async function obtenerPedidoExterno({ negocioId, canal, idExterno }, db = pool) {
  const { rows } = await db.query(
    `SELECT id, negocio_id, canal, id_externo, estado, folio, intentos, reentregas,
            aceptado_en_proveedor, aceptacion_error, listo_notificado_at, cancelacion, ultimo_error,
            recibido_at, actualizado_at
       FROM pedidos_externos WHERE negocio_id = $1 AND canal = $2 AND id_externo = $3`,
    [exigir(negocioId, 'negocioId'), exigir(canal, 'canal'), exigir(String(idExterno ?? ''), 'idExterno')]
  );
  return rows[0] || null;
}

export async function obtenerPedidoExternoPorFolio({ negocioId, canal, folio }, db = pool) {
  const { rows } = await db.query(
    `SELECT id, negocio_id, canal, id_externo, estado, folio, aceptado_en_proveedor, listo_notificado_at
       FROM pedidos_externos WHERE negocio_id = $1 AND canal = $2 AND folio = $3`,
    [exigir(negocioId, 'negocioId'), exigir(canal, 'canal'), exigir(folio, 'folio')]
  );
  return rows[0] || null;
}

// Lo que un crash o un fallo dejó sin pedido: reclamos caducados y fallidos
// con intentos disponibles. Se devuelven con su payload para reprocesarlos por
// el MISMO camino que el webhook (nunca uno paralelo).
export async function pedidosExternosPendientes(canal, { limite = 20 } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT id, negocio_id, canal, id_externo, estado, payload, intentos, recibido_at, actualizado_at
       FROM pedidos_externos
      WHERE canal = $1
        AND intentos < $3
        AND (estado = 'fallido' OR (estado = 'reclamado' AND actualizado_at < NOW() - ($4::int * interval '1 millisecond')))
      ORDER BY recibido_at ASC
      LIMIT $2`,
    [exigir(canal, 'canal'), limite, MAX_INTENTOS, RECLAMO_CADUCA_MS]
  );
  return rows;
}
