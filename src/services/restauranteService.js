// ─── Módulo de restaurante: mesas, meseros, comandas y pagos divididos ──────
// (Frente C del MVP de escala). Sin mapa visual ni reservaciones: lista de
// mesas numeradas, apertura atómica, comandas incrementales (solo lo nuevo
// va a cocina), UNA cuenta por mesa con divisiones/pagos/saldo, y cierre
// que exige saldo cero.
//
// Toda operación exige negocio_id y lo verifica contra la fila (una cuenta
// de otro negocio se comporta idéntica a inexistente). La concurrencia se
// resuelve en la base de datos, nunca en memoria:
//   - apertura/movimiento de mesa: índice único parcial (una cuenta
//     'abierta' por mesa y negocio) -- dos dispositivos: exactamente uno gana.
//   - comandas/pagos/cierre: SELECT ... FOR UPDATE sobre la cuenta --
//     dobles clics y cajas simultáneas se serializan.
// Los pagos NUNCA llaman a un proveedor: registran cobros ya realizados por
// los métodos habilitados del negocio (metodos_pago, migración 025).
import { pool } from './database.js';

function errorCodigo(mensaje, code) {
  return Object.assign(new Error(mensaje), { code });
}

function validarNegocioId(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw errorCodigo('negocioId requerido', 'TENANT_CONTEXT_REQUIRED');
  }
  return negocioId.trim();
}

// Totales de una cuenta a partir de sus filas -- items cancelados nunca
// suman; el saldo es consumo - pagos (la propina va aparte, no reduce saldo).
// Fragmento de COLUMNAS (se interpola dentro de un SELECT existente que
// alias la cuenta como "c") -- nunca lleva su propio SELECT.
const SQL_TOTALES = `
    COALESCE((SELECT SUM(i.cantidad * i.precio_unitario) FROM restaurante_cuenta_items i
              WHERE i.cuenta_id = c.id AND i.estado != 'cancelado'), 0) AS total,
    COALESCE((SELECT SUM(p.monto) FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = c.id), 0) AS pagado,
    COALESCE((SELECT SUM(p.propina) FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = c.id), 0) AS propinas
`;

// ─── Mesas ──────────────────────────────────────────────────────────────────
// El número de mesas del negocio vive en configuracion
// ('restaurante_num_mesas', default 12) -- sin tabla de mesas: una mesa sin
// cuenta abierta ES una mesa disponible, no una fila.
export async function listarMesas(negocioId) {
  const nid = validarNegocioId(negocioId);
  const [cfg, abiertas] = await Promise.all([
    pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [nid]),
    pool.query(`
      SELECT c.id, c.mesa_numero, c.personas, c.abierta_at, u.nombre AS mesero_nombre, c.mesero_usuario_id,
             ${SQL_TOTALES}
      FROM restaurante_cuentas c
      JOIN usuarios u ON u.id = c.mesero_usuario_id
      WHERE c.negocio_id = $1 AND c.estado = 'abierta'
      ORDER BY c.mesa_numero
    `, [nid]),
  ]);
  const numMesas = Math.min(Math.max(parseInt(cfg.rows[0]?.valor, 10) || 12, 1), 500);
  const porMesa = new Map(abiertas.rows.map(r => [r.mesa_numero, r]));
  const mesas = [];
  for (let n = 1; n <= numMesas; n++) {
    const c = porMesa.get(n);
    mesas.push(c ? {
      mesa: n, ocupada: true, cuentaId: c.id, personas: c.personas,
      mesero: c.mesero_nombre, abiertaAt: c.abierta_at,
      total: Number(c.total), pagado: Number(c.pagado), saldo: Number(c.total) - Number(c.pagado),
    } : { mesa: n, ocupada: false });
  }
  return { numMesas, mesas };
}

// ─── Apertura atómica (C3) ──────────────────────────────────────────────────
export async function abrirMesa(negocioId, { mesaNumero, personas, meseroUsuarioId, abiertaPor }) {
  const nid = validarNegocioId(negocioId);
  const mesa = parseInt(mesaNumero, 10);
  const pers = parseInt(personas, 10) || 1;
  if (!Number.isInteger(mesa) || mesa < 1 || mesa > 500) throw errorCodigo('Número de mesa inválido', 'MESA_INVALIDA');
  // El mesero debe ser un usuario ACTIVO de este negocio -- nunca de otro.
  const mesero = await pool.query(
    `SELECT u.id, u.nombre FROM usuarios u JOIN usuario_negocios un ON un.usuario_id = u.id
     WHERE u.id = $1 AND un.negocio_id = $2 AND un.activo = true`,
    [meseroUsuarioId, nid]
  );
  if (!mesero.rows.length) throw errorCodigo('El mesero no pertenece a este negocio', 'MESERO_INVALIDO');
  try {
    const { rows } = await pool.query(
      `INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, personas, mesero_usuario_id, abierta_por)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, mesa_numero, personas, abierta_at`,
      [nid, mesa, pers, meseroUsuarioId, abiertaPor]
    );
    return { ...rows[0], mesero_nombre: mesero.rows[0].nombre };
  } catch (e) {
    // 23505 = el índice único parcial detectó otra cuenta abierta en esta
    // mesa: exactamente un dispositivo gana la carrera, este pierde.
    if (e.code === '23505') throw errorCodigo(`La mesa ${mesa} ya tiene una cuenta abierta`, 'MESA_OCUPADA');
    throw e;
  }
}

export async function obtenerCuenta(cuentaId, negocioId) {
  const nid = validarNegocioId(negocioId);
  const { rows } = await pool.query(`
    SELECT c.*, u.nombre AS mesero_nombre, ${SQL_TOTALES}
    FROM restaurante_cuentas c JOIN usuarios u ON u.id = c.mesero_usuario_id
    WHERE c.id = $1 AND c.negocio_id = $2
  `, [cuentaId, nid]);
  if (!rows.length) return null;
  const cuenta = rows[0];
  const [items, pagos] = await Promise.all([
    pool.query(`
      SELECT i.id, i.producto, i.cantidad, i.precio_unitario, i.modificadores, i.notas, i.estado,
             i.comanda_num, i.motivo_cancelacion, i.created_at,
             ua.nombre AS agregado_por_nombre, uc.nombre AS cancelado_por_nombre
      FROM restaurante_cuenta_items i
      JOIN usuarios ua ON ua.id = i.agregado_por
      LEFT JOIN usuarios uc ON uc.id = i.cancelado_por
      WHERE i.cuenta_id = $1 ORDER BY i.created_at
    `, [cuentaId]),
    pool.query(`
      SELECT p.id, p.metodo, p.monto, p.propina, p.cubre, p.referencia, p.created_at, u.nombre AS registrado_por_nombre
      FROM restaurante_cuenta_pagos p JOIN usuarios u ON u.id = p.registrado_por
      WHERE p.cuenta_id = $1 ORDER BY p.created_at
    `, [cuentaId]),
  ]);
  const total = Number(cuenta.total), pagado = Number(cuenta.pagado);
  return {
    id: cuenta.id, mesa: cuenta.mesa_numero, personas: cuenta.personas, estado: cuenta.estado,
    mesero: { id: cuenta.mesero_usuario_id, nombre: cuenta.mesero_nombre },
    abiertaAt: cuenta.abierta_at, cerradaAt: cuenta.cerrada_at, comandasEmitidas: cuenta.comandas_emitidas,
    notas: cuenta.notas, total, pagado, propinas: Number(cuenta.propinas), saldo: total - pagado,
    // Contabilización (migración 040): folio de la venta consolidada en
    // reportes y su timestamp -- null mientras la cuenta no cierre.
    ventaFolio: cuenta.venta_folio || null, contabilizadaAt: cuenta.contabilizada_at || null,
    items: items.rows, pagos: pagos.rows,
  };
}

// ─── Comanda (C4) ───────────────────────────────────────────────────────────
export async function agregarItems(cuentaId, negocioId, items, usuarioId) {
  const nid = validarNegocioId(negocioId);
  if (!Array.isArray(items) || !items.length) throw errorCodigo('Sin items que agregar', 'SIN_ITEMS');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 FOR UPDATE`,
      [cuentaId, nid]
    );
    if (!rows.length) { throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA'); }
    if (rows[0].estado !== 'abierta') throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    const agregados = [];
    for (const it of items) {
      const cantidad = parseInt(it.cantidad, 10) || 1;
      const precio = Number(it.precio_unitario);
      if (!it.producto || typeof it.producto !== 'string') throw errorCodigo('Item sin producto', 'ITEM_INVALIDO');
      if (!Number.isFinite(precio) || precio < 0) throw errorCodigo('Precio inválido', 'ITEM_INVALIDO');
      const { rows: [fila] } = await client.query(
        `INSERT INTO restaurante_cuenta_items (cuenta_id, negocio_id, producto, cantidad, precio_unitario, modificadores, notas, agregado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, producto, cantidad, precio_unitario, estado`,
        [cuentaId, nid, it.producto.trim(), cantidad, precio, JSON.stringify(it.modificadores || []), it.notas || null, usuarioId]
      );
      agregados.push(fila);
    }
    await client.query('UPDATE restaurante_cuentas SET updated_at = NOW() WHERE id = $1', [cuentaId]);
    await client.query('COMMIT');
    return agregados;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Envía a cocina SOLO los items pendientes, numerándolos con la comanda
// recién emitida. Doble clic / doble envío: el segundo llamador serializa
// tras el FOR UPDATE, ya no encuentra pendientes y recibe
// SIN_ITEMS_PENDIENTES -- nunca una segunda comanda con los mismos
// productos, nunca reimpresión de lo anterior.
export async function enviarComanda(cuentaId, negocioId, usuarioId) {
  const nid = validarNegocioId(negocioId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado, comandas_emitidas, mesa_numero, personas, mesero_usuario_id
       FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 FOR UPDATE`,
      [cuentaId, nid]
    );
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    if (rows[0].estado !== 'abierta') throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    const numComanda = rows[0].comandas_emitidas + 1;
    const { rows: enviados } = await client.query(
      `UPDATE restaurante_cuenta_items SET estado = 'enviado', comanda_num = $2
       WHERE cuenta_id = $1 AND estado = 'pendiente'
       RETURNING id, producto, cantidad, precio_unitario, modificadores, notas`,
      [cuentaId, numComanda]
    );
    if (!enviados.length) throw errorCodigo('No hay items pendientes por enviar', 'SIN_ITEMS_PENDIENTES');
    await client.query(
      `UPDATE restaurante_cuentas SET comandas_emitidas = $2, updated_at = NOW() WHERE id = $1`,
      [cuentaId, numComanda]
    );
    const { rows: [mesero] } = await client.query('SELECT nombre FROM usuarios WHERE id = $1', [rows[0].mesero_usuario_id]);
    await client.query('COMMIT');
    return {
      comanda: numComanda,
      tipo: numComanda === 1 ? 'inicial' : 'adicional',
      mesa: rows[0].mesa_numero,
      personas: rows[0].personas,
      mesero: mesero?.nombre || null,
      items: enviados, // SOLO los de esta comanda -- contrato de impresión C8
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function cancelarItem(itemId, cuentaId, negocioId, usuarioId, motivo) {
  const nid = validarNegocioId(negocioId);
  if (!motivo || !String(motivo).trim()) throw errorCodigo('El motivo de cancelación es obligatorio', 'MOTIVO_REQUERIDO');
  const { rows } = await pool.query(
    `UPDATE restaurante_cuenta_items i SET estado = 'cancelado', cancelado_por = $4, motivo_cancelacion = $5, cancelado_at = NOW()
     FROM restaurante_cuentas c
     WHERE i.id = $1 AND i.cuenta_id = $2 AND c.id = i.cuenta_id AND c.negocio_id = $3
       AND c.estado = 'abierta' AND i.estado != 'cancelado'
     RETURNING i.id, i.producto, i.cantidad, i.comanda_num, (i.comanda_num IS NOT NULL) AS ya_enviado`,
    [itemId, cuentaId, nid, usuarioId, String(motivo).trim()]
  );
  if (!rows.length) throw errorCodigo('Item no encontrado o no cancelable', 'ITEM_NO_CANCELABLE');
  return rows[0]; // ya_enviado=true => el llamador imprime la comanda de cancelación
}

// ─── Pagos y división (C5/C6) ───────────────────────────────────────────────
export async function registrarPago(cuentaId, negocioId, { metodo, monto, propina = 0, cubre = null, referencia = null }, usuarioId) {
  const nid = validarNegocioId(negocioId);
  const montoNum = Number(monto);
  const propinaNum = Number(propina) || 0;
  if (!Number.isFinite(montoNum) || montoNum <= 0) throw errorCodigo('El monto debe ser mayor a cero', 'MONTO_INVALIDO');
  if (propinaNum < 0) throw errorCodigo('La propina no puede ser negativa', 'MONTO_INVALIDO');
  // Solo métodos HABILITADOS por el negocio (metodos_pago, migración 025).
  const met = await pool.query(
    `SELECT 1 FROM metodos_pago WHERE negocio_id = $1 AND tipo = $2 AND habilitado = true`,
    [nid, metodo]
  );
  if (!met.rows.length) throw errorCodigo(`Método de pago no habilitado: ${metodo}`, 'METODO_NO_HABILITADO');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE: dos cajas cobrando a la vez se serializan. El saldo se
    // calcula en una consulta SEPARADA DESPUÉS de obtener el lock -- si
    // estuviera como subquery del propio SELECT FOR UPDATE, la transacción
    // que esperó el lock lo evaluaría con su snapshot viejo (EvalPlanQual
    // solo re-verifica la fila bloqueada, no las subqueries a otras tablas)
    // y un pago repetido concurrente podría colarse. Con la consulta
    // posterior (snapshot nuevo por statement en READ COMMITTED), la
    // segunda caja ve el saldo ya reducido y el pago que rebasa pierde.
    const { rows } = await client.query(
      `SELECT c.id, c.estado FROM restaurante_cuentas c WHERE c.id = $1 AND c.negocio_id = $2 FOR UPDATE`,
      [cuentaId, nid]
    );
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    if (rows[0].estado !== 'abierta') throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    const { rows: [tot] } = await client.query(
      `SELECT ${SQL_TOTALES} FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]
    );
    const saldo = Number(tot.total) - Number(tot.pagado);
    // Regla explícita: nunca se registra un pago mayor al saldo. El cambio
    // de efectivo se maneja fuera del registro (el pago registrado es lo
    // que la cuenta consume, no el billete recibido).
    if (montoNum > saldo + 0.005) {
      throw errorCodigo(`El pago ($${montoNum}) excede el saldo pendiente ($${saldo.toFixed(2)})`, 'PAGO_EXCEDE_SALDO');
    }
    const { rows: [pago] } = await client.query(
      `INSERT INTO restaurante_cuenta_pagos (cuenta_id, negocio_id, metodo, monto, propina, cubre, referencia, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, metodo, monto, propina, created_at`,
      [cuentaId, nid, metodo, montoNum, propinaNum, cubre, referencia, usuarioId]
    );
    await client.query('UPDATE restaurante_cuentas SET updated_at = NOW() WHERE id = $1', [cuentaId]);
    await client.query('COMMIT');
    return { pago, saldoRestante: Math.round((saldo - montoNum) * 100) / 100 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// División en partes iguales: helper de SOLO cálculo (el cobro real sigue
// siendo registrarPago por cada parte). Reparte los centavos sobrantes en
// las primeras partes para que la suma cierre exacta.
export function dividirEnPartesIguales(saldo, partes) {
  const n = parseInt(partes, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw errorCodigo('Número de partes inválido', 'PARTES_INVALIDAS');
  const centavos = Math.round(Number(saldo) * 100);
  const basePorParte = Math.floor(centavos / n);
  const sobrantes = centavos - basePorParte * n;
  return Array.from({ length: n }, (_, i) => (basePorParte + (i < sobrantes ? 1 : 0)) / 100);
}

// ─── Cierre y movimiento ────────────────────────────────────────────────────
// Cierre CONTABLE (integración caja/reportes): en la MISMA transacción se
// cierra la cuenta Y se inserta exactamente UNA venta consolidada en
// pedidos_activos -- la fuente de verdad real de /api/ventas y el resumen.
// Garantías:
//   - Atómico: si falla el insert de la venta, la cuenta NO queda cerrada
//     (rollback de todo); si falla el UPDATE, la venta tampoco queda.
//   - Exactly-once: folio DETERMINISTA por cuenta+reversos ('RM-' + 8 hex
//     del id + '-' + reversos) con UNIQUE en la cuenta y ON CONFLICT
//     (folio) DO NOTHING en pedidos_activos -- un reintento tras timeout
//     re-produce el mismo folio y no duplica nada.
//   - Reintento tras respuesta perdida: si la cuenta YA está cerrada y
//     contabilizada, responde idempotente ({ok, yaCerrada:true,
//     ventaFolio}) en vez de error.
//   - La fila de venta nace estado='entregado' + entregado_at: el tablero
//     de comandas (obtenerPedidosActivos filtra != 'entregado') y el
//     arranque del OrderManager JAMÁS la cargan; la impresión de cocina no
//     se dispara (solo pasa vía emitirPedido); métricas D.1 y la red la
//     ignoran (modalidad 'mesa', canal 'restaurante_mesa'); el prefijo RM-
//     nunca toca el contador XAB-.
//   - Dinero: importes recalculados aquí (SUM en SQL sobre NUMERIC); jamás
//     se confía en totales del cliente. La propina viaja SEPARADA
//     (datos.propinas y datos.pagos[].propina) y NO se suma al total.
export async function cerrarCuenta(cuentaId, negocioId, usuarioId) {
  const nid = validarNegocioId(negocioId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.id, c.estado, c.mesa_numero, c.personas, c.mesero_usuario_id, c.abierta_at,
              c.venta_folio, c.reversos
       FROM restaurante_cuentas c WHERE c.id = $1 AND c.negocio_id = $2 FOR UPDATE`,
      [cuentaId, nid]
    );
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    const cta = rows[0];
    if (cta.estado !== 'abierta') {
      if (cta.estado === 'cerrada' && cta.venta_folio) {
        await client.query('COMMIT');
        return { ok: true, yaCerrada: true, ventaFolio: cta.venta_folio };
      }
      throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    }
    const { rows: [tot] } = await client.query(
      `SELECT ${SQL_TOTALES} FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]
    );
    const saldo = Number(tot.total) - Number(tot.pagado);
    if (Math.abs(saldo) > 0.005) {
      throw errorCodigo(`No se puede cerrar con saldo pendiente ($${saldo.toFixed(2)})`, 'SALDO_PENDIENTE');
    }
    // Secuencial a propósito: un client de pg no admite queries en paralelo
    // dentro de la misma transacción.
    const itemsQ = await client.query(
      `SELECT producto AS nombre, cantidad, precio_unitario, modificadores, notas
       FROM restaurante_cuenta_items WHERE cuenta_id = $1 AND estado != 'cancelado' ORDER BY created_at`,
      [cuentaId]
    );
    const pagosQ = await client.query(
      `SELECT metodo, SUM(monto)::numeric(12,2) AS monto, SUM(propina)::numeric(12,2) AS propina
       FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 GROUP BY metodo ORDER BY metodo`,
      [cuentaId]
    );
    const meseroQ = await client.query('SELECT nombre FROM usuarios WHERE id = $1', [cta.mesero_usuario_id]);
    const items = itemsQ.rows, pagos = pagosQ.rows, mesero = meseroQ.rows[0];
    const metodos = pagos.map(pg => pg.metodo);
    const formaPago = metodos.length === 0 ? 'sin pago' : (metodos.length === 1 ? metodos[0] : 'mixto');
    const ventaFolio = `RM-${String(cta.id).replace(/-/g, '').slice(0, 8).toUpperCase()}-${cta.reversos}`;
    const datosVenta = {
      id: ventaFolio,
      origen: 'restaurante',
      canal: 'restaurante_mesa',
      modalidad: 'mesa',
      mesa: cta.mesa_numero,
      personas: cta.personas,
      mesero: mesero ? mesero.nombre : null,
      cuenta_id: cta.id,
      abierta_at: cta.abierta_at,
      cliente: { nombre: `Mesa ${cta.mesa_numero}` },
      items: items.map(i => ({
        nombre: i.nombre, cantidad: i.cantidad, precio_unitario: Number(i.precio_unitario),
        notas: [i.notas, ...(Array.isArray(i.modificadores) ? i.modificadores : [])].filter(Boolean).join(', ') || undefined,
      })),
      total: Number(tot.total),
      propinas: Number(tot.propinas),
      costo_envio: 0,
      forma_pago: formaPago,
      pagos: pagos.map(pg => ({ metodo: pg.metodo, monto: Number(pg.monto), propina: Number(pg.propina) })),
      estado: 'entregado',
    };
    await client.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, entregado_at)
       VALUES ($1, 'entregado', $2, $3, NOW())
       ON CONFLICT (folio) DO NOTHING`,
      [ventaFolio, JSON.stringify(datosVenta), nid]
    );
    await client.query(
      `UPDATE restaurante_cuentas
       SET estado = 'cerrada', cerrada_por = $2, cerrada_at = NOW(),
           venta_folio = $3, contabilizada_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [cuentaId, usuarioId, ventaFolio]
    );
    await client.query('COMMIT');
    return { ok: true, total: Number(tot.total), propinas: Number(tot.propinas), ventaFolio, pagos: datosVenta.pagos };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Reverso de la venta consolidada (SOLO admin, en la ruta): marca la fila
// de pedidos_activos como 'cancelado' con motivo (deja de contar en ventas,
// conserva historial), reabre la cuenta e incrementa `reversos` para que un
// nuevo cierre genere un folio NUEVO. Nunca borra pagos ni items.
export async function revertirVentaCuenta(cuentaId, negocioId, usuarioId, motivo) {
  const nid = validarNegocioId(negocioId);
  if (!motivo || !String(motivo).trim()) throw errorCodigo('El motivo del reverso es obligatorio', 'MOTIVO_REQUERIDO');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado, venta_folio, reversos FROM restaurante_cuentas
       WHERE id = $1 AND negocio_id = $2 FOR UPDATE`,
      [cuentaId, nid]
    );
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    const cta = rows[0];
    if (cta.estado !== 'cerrada' || !cta.venta_folio) {
      throw errorCodigo('La cuenta no tiene una venta contabilizada que revertir', 'SIN_VENTA_QUE_REVERTIR');
    }
    const { rowCount } = await client.query(
      `UPDATE pedidos_activos
       SET estado = 'cancelado',
           datos = jsonb_set(jsonb_set(datos, '{estado}', '"cancelado"'),
                             '{cancelacion}', jsonb_build_object('motivo', $3::text, 'por', $4::text, 'at', NOW()::text)),
           updated_at = NOW()
       WHERE folio = $1 AND negocio_id = $2 AND estado != 'cancelado'`,
      [cta.venta_folio, nid, String(motivo).trim(), String(usuarioId)]
    );
    // La reapertura respeta el índice único de mesa abierta: si la mesa ya
    // fue tomada por otra cuenta, el reverso falla completo (rollback) con
    // MESA_OCUPADA -- mover la otra cuenta primero.
    await client.query(
      `UPDATE restaurante_cuentas
       SET estado = 'abierta', cerrada_por = NULL, cerrada_at = NULL,
           venta_folio = NULL, contabilizada_at = NULL, reversos = reversos + 1, updated_at = NOW()
       WHERE id = $1`,
      [cuentaId]
    );
    await client.query('COMMIT');
    return { ok: true, ventaRevertida: cta.venta_folio, ventaCancelada: rowCount === 1 };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw errorCodigo('La mesa ya tiene otra cuenta abierta — mueve esa cuenta antes de revertir', 'MESA_OCUPADA');
    throw e;
  } finally {
    client.release();
  }
}

export async function moverMesa(cuentaId, negocioId, nuevaMesa) {
  const nid = validarNegocioId(negocioId);
  const mesa = parseInt(nuevaMesa, 10);
  if (!Number.isInteger(mesa) || mesa < 1 || mesa > 500) throw errorCodigo('Número de mesa inválido', 'MESA_INVALIDA');
  try {
    const { rows } = await pool.query(
      `UPDATE restaurante_cuentas SET mesa_numero = $3, updated_at = NOW()
       WHERE id = $1 AND negocio_id = $2 AND estado = 'abierta'
       RETURNING id, mesa_numero`,
      [cuentaId, nid, mesa]
    );
    if (!rows.length) throw errorCodigo('Cuenta no encontrada o no abierta', 'CUENTA_NO_ENCONTRADA');
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw errorCodigo(`La mesa ${mesa} ya está ocupada`, 'MESA_OCUPADA');
    throw e;
  }
}

// Reapertura (solo admin en la ruta): vuelve a 'abierta' -- el índice único
// parcial vuelve a aplicar, así que si la mesa ya fue ocupada por otra
// cuenta nueva, la reapertura pierde con MESA_OCUPADA.
export async function reabrirCuenta(cuentaId, negocioId) {
  const nid = validarNegocioId(negocioId);
  try {
    // Una cuenta con venta CONTABILIZADA nunca se reabre en silencio: la
    // venta ya vive en reportes -- reabrirla sin reverso duplicaría el
    // ingreso al volver a cerrar. El camino correcto es el reverso
    // explícito de admin (revertirVentaCuenta).
    const { rows } = await pool.query(
      `UPDATE restaurante_cuentas SET estado = 'abierta', cerrada_por = NULL, cerrada_at = NULL, updated_at = NOW()
       WHERE id = $1 AND negocio_id = $2 AND estado = 'cerrada' AND venta_folio IS NULL
       RETURNING id, mesa_numero`,
      [cuentaId, nid]
    );
    if (!rows.length) {
      const { rows: chk } = await pool.query(
        `SELECT venta_folio FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 AND estado = 'cerrada'`,
        [cuentaId, nid]
      );
      if (chk.length && chk[0].venta_folio) {
        throw errorCodigo('La cuenta tiene una venta contabilizada — usa el reverso de venta (admin) en vez de reabrir', 'VENTA_CONTABILIZADA');
      }
    }
    if (!rows.length) throw errorCodigo('Cuenta no encontrada o no cerrada', 'CUENTA_NO_ENCONTRADA');
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw errorCodigo('La mesa ya tiene otra cuenta abierta', 'MESA_OCUPADA');
    throw e;
  }
}

// ─── Indicadores para el onboarding (C10) ───────────────────────────────────
export async function indicadoresRestaurante(negocioId) {
  const nid = validarNegocioId(negocioId);
  const { rows: [r] } = await pool.query(`
    SELECT
      EXISTS (SELECT 1 FROM negocio_modulos nm WHERE nm.negocio_id = $1 AND nm.modulo = 'restaurante' AND nm.estado = 'activo') AS modulo_mesas_activo,
      EXISTS (SELECT 1 FROM configuracion c WHERE c.negocio_id = $1 AND c.clave = 'restaurante_num_mesas') AS mesas_configuradas,
      (SELECT count(*) FROM usuario_negocios un WHERE un.negocio_id = $1 AND un.activo = true) > 0 AS meseros_configurados,
      (SELECT count(*) FROM metodos_pago mp WHERE mp.negocio_id = $1 AND mp.habilitado = true) > 0 AS pagos_listos,
      EXISTS (SELECT 1 FROM restaurante_cuentas rc WHERE rc.negocio_id = $1 AND rc.estado = 'cerrada') AS prueba_mesa_completada
  `, [nid]);
  return { ...r, impresion_revisada: null }; // impresion_revisada: confirmación manual (checklist operativo), no derivable
}
