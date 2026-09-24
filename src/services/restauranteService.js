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
import { randomUUID } from 'node:crypto';
import { pool } from './database.js';
import { construirDesgloseDescuentos } from './descuentos.js';
import {
  UNO, CERO, fraccion, sumar, restar, comparar, esCero, textoFraccion, aCentavos, aPesos,
  netosDeRenglones, importeDePorcion, partesIgualesCentavos,
} from './divisionConsumo.js';

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
// suman; subtotal = consumo; total = subtotal - descuento de la cuenta
// (migración 082); el saldo es total - pagos (la propina va aparte, no
// reduce saldo). Fragmento de COLUMNAS (se interpola dentro de un SELECT
// existente que alias la cuenta como "c") -- nunca lleva su propio SELECT.
const SQL_SUBTOTAL = `COALESCE((SELECT SUM(i.cantidad * i.precio_unitario) FROM restaurante_cuenta_items i
              WHERE i.cuenta_id = c.id AND i.estado != 'cancelado'), 0)`;
const SQL_TOTALES = `
    ${SQL_SUBTOTAL} AS subtotal,
    c.descuento_monto AS descuento,
    ${SQL_SUBTOTAL} - c.descuento_monto AS total,
    COALESCE((SELECT SUM(p.monto) FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = c.id AND p.revertido_at IS NULL), 0) AS pagado,
    COALESCE((SELECT SUM(p.propina) FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = c.id AND p.revertido_at IS NULL), 0) AS propinas
`;
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
             (SELECT COUNT(*) FROM restaurante_cuenta_items i
              WHERE i.cuenta_id = c.id AND i.estado = 'pendiente') AS pendientes,
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
      // meseroUsuarioId: para que el tablero pueda separar "mis mesas" de
      // "todas" sin pedir la cuenta de cada mesa. pendientes: cuántos items
      // todavía no salieron a cocina -- lo que hace visible de un vistazo la
      // mesa que tiene comanda por enviar.
      mesero: c.mesero_nombre, meseroUsuarioId: c.mesero_usuario_id, abiertaAt: c.abierta_at,
      pendientes: Number(c.pendientes) || 0,
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
    SELECT c.*, u.nombre AS mesero_nombre, ud.nombre AS descuento_por_nombre, ${SQL_TOTALES}
    FROM restaurante_cuentas c JOIN usuarios u ON u.id = c.mesero_usuario_id
    LEFT JOIN usuarios ud ON ud.id = c.descuento_por
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
      SELECT p.id, p.metodo, p.monto, p.propina, p.cubre, p.referencia, p.recibido, p.cambio, p.created_at,
             p.cobro_id, p.tipo_cobro, p.revertido_at, p.motivo_reverso,
             u.nombre AS registrado_por_nombre, ur.nombre AS revertido_por_nombre
      FROM restaurante_cuenta_pagos p JOIN usuarios u ON u.id = p.registrado_por
      LEFT JOIN usuarios ur ON ur.id = p.revertido_por
      WHERE p.cuenta_id = $1 ORDER BY p.created_at
    `, [cuentaId]),
  ]);
  const subtotal = Number(cuenta.subtotal), total = Number(cuenta.total), pagado = Number(cuenta.pagado);
  // `pagos` son los VIGENTES (lo que cuenta para saldo, ticket y venta); los
  // revertidos (083) van aparte, con quién, cuándo y por qué.
  const pagosVigentes = pagos.rows.filter(p => !p.revertido_at);
  const pagosRevertidos = pagos.rows.filter(p => p.revertido_at);
  return {
    id: cuenta.id, mesa: cuenta.mesa_numero, personas: cuenta.personas, estado: cuenta.estado,
    mesero: { id: cuenta.mesero_usuario_id, nombre: cuenta.mesero_nombre },
    abiertaAt: cuenta.abierta_at, cerradaAt: cuenta.cerrada_at, comandasEmitidas: cuenta.comandas_emitidas,
    notas: cuenta.notas, subtotal, total, pagado, propinas: Number(cuenta.propinas), saldo: redondear(total - pagado),
    // Descuento de la cuenta (migración 082): monto ya calculado en pesos,
    // cómo se capturó (porcentaje o importe), motivo y quién/cuándo. null
    // cuando no hay descuento.
    descuento: Number(cuenta.descuento_monto) > 0 ? {
      tipo: cuenta.descuento_tipo, valor: Number(cuenta.descuento_valor), monto: Number(cuenta.descuento_monto),
      motivo: cuenta.descuento_motivo, por: cuenta.descuento_por, porNombre: cuenta.descuento_por_nombre || null,
      at: cuenta.descuento_at,
    } : null,
    ticketImpresiones: Number(cuenta.ticket_impresiones) || 0,
    // División del remanente en partes iguales (083): una vez formalizada,
    // la selección por producto queda cerrada.
    divisionRemanente: cuenta.division_remanente || null,
    // Contabilización (migración 040): folio de la venta consolidada en
    // reportes y su timestamp -- null mientras la cuenta no cierre.
    ventaFolio: cuenta.venta_folio || null, contabilizadaAt: cuenta.contabilizada_at || null,
    items: items.rows, pagos: pagosVigentes, pagosRevertidos,
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
  // Un renglón con cualquier porción cobrada es inmutable (083): primero se
  // revierte el cobro. La condición va en el propio UPDATE para que no haya
  // ventana entre comprobar y cancelar.
  const { rows } = await pool.query(
    `UPDATE restaurante_cuenta_items i SET estado = 'cancelado', cancelado_por = $4, motivo_cancelacion = $5, cancelado_at = NOW()
     FROM restaurante_cuentas c
     WHERE i.id = $1 AND i.cuenta_id = $2 AND c.id = i.cuenta_id AND c.negocio_id = $3
       AND c.estado = 'abierta' AND i.estado != 'cancelado'
       AND NOT EXISTS (SELECT 1 FROM restaurante_cuenta_porciones po WHERE po.item_id = i.id AND po.revertido_at IS NULL)
     RETURNING i.id, i.producto, i.cantidad, i.comanda_num, (i.comanda_num IS NOT NULL) AS ya_enviado`,
    [itemId, cuentaId, nid, usuarioId, String(motivo).trim()]
  );
  if (!rows.length) {
    if (await itemTieneCobro(itemId, cuentaId)) throw errorCodigo('Ese producto ya tiene un cobro: revierte el cobro antes de cancelarlo', 'ITEM_TIENE_COBRO');
    throw errorCodigo('Item no encontrado o no cancelable', 'ITEM_NO_CANCELABLE');
  }
  return rows[0]; // ya_enviado=true => el llamador imprime la comanda de cancelación
}

async function itemTieneCobro(itemId, cuentaId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM restaurante_cuenta_porciones WHERE item_id = $1 AND cuenta_id = $2 AND revertido_at IS NULL LIMIT 1`, [itemId, cuentaId]);
  return rows.length > 0;
}

// Comentario del mesero sobre un platillo, para la cocina.
//
// Solo sobre lo que AÚN NO salió: `comanda_num IS NULL`. Cambiar la nota de
// algo que la cocina ya tiene impreso sería mentirle al ticket — el papel diría
// una cosa y la pantalla otra, y nadie se enteraría. Para eso está cancelar.
//
// La cuenta tiene que estar abierta y el item vivo; el tope de 300 es el mismo
// que aplica `agregarItems` al crearlo, para que una nota no cambie de largo
// según por dónde entró.
export async function actualizarNotasItem(itemId, cuentaId, negocioId, notas, usuarioId) {
  const nid = validarNegocioId(negocioId);
  const texto = String(notas ?? '').trim().slice(0, 300);
  const { rows } = await pool.query(
    `UPDATE restaurante_cuenta_items i SET notas = $4
     FROM restaurante_cuentas c
     WHERE i.id = $1 AND i.cuenta_id = $2 AND c.id = i.cuenta_id AND c.negocio_id = $3
       AND c.estado = 'abierta' AND i.estado = 'pendiente' AND i.comanda_num IS NULL
     RETURNING i.id, i.producto, i.notas`,
    [itemId, cuentaId, nid, texto || null]
  );
  if (!rows.length) {
    throw errorCodigo('El platillo ya salió a cocina o no admite comentario', 'ITEM_NO_COMENTABLE');
  }
  return rows[0];
}

// ─── La ronda pendiente se comporta como un carrito ─────────────────────────
//
// Hasta aquí, tocar el producto equivocado dejaba al mesero atrapado: quitarlo
// exigía `cancelarItem`, que es de ADMIN y pide motivo. En hora pico eso
// significa llamar a alguien para deshacer un toque.
//
// Son dos cosas distintas y conviene no mezclarlas:
//   quitar    lo que NUNCA salió a cocina. No dejó rastro en ningún lado, así
//             que se borra y ya; lo puede hacer quien atiende la mesa.
//   cancelar  lo que la cocina YA tiene impreso. Eso sí es admin, pide motivo
//             y emite comanda de cancelación, porque hay comida en juego.
//
// Las dos funciones de abajo solo tocan lo pendiente (`comanda_num IS NULL`),
// igual que el comentario del mesero.

export async function cambiarCantidadItem(itemId, cuentaId, negocioId, cantidad) {
  const nid = validarNegocioId(negocioId);
  const n = parseInt(cantidad, 10);
  if (!Number.isFinite(n) || n < 1 || n > 99) {
    throw errorCodigo('La cantidad debe estar entre 1 y 99', 'CANTIDAD_INVALIDA');
  }
  const { rows } = await pool.query(
    `UPDATE restaurante_cuenta_items i SET cantidad = $4
     FROM restaurante_cuentas c
     WHERE i.id = $1 AND i.cuenta_id = $2 AND c.id = i.cuenta_id AND c.negocio_id = $3
       AND c.estado = 'abierta' AND i.estado = 'pendiente' AND i.comanda_num IS NULL
       AND NOT EXISTS (SELECT 1 FROM restaurante_cuenta_porciones po WHERE po.item_id = i.id AND po.revertido_at IS NULL)
     RETURNING i.id, i.producto, i.cantidad`,
    [itemId, cuentaId, nid, n]
  );
  if (!rows.length) {
    if (await itemTieneCobro(itemId, cuentaId)) throw errorCodigo('Ese producto ya tiene un cobro: revierte el cobro antes de cambiarlo', 'ITEM_TIENE_COBRO');
    throw errorCodigo('El platillo ya salió a cocina o no admite cambios', 'ITEM_NO_EDITABLE');
  }
  return rows[0];
}

export async function quitarItemPendiente(itemId, cuentaId, negocioId) {
  const nid = validarNegocioId(negocioId);
  const { rows } = await pool.query(
    `DELETE FROM restaurante_cuenta_items i
     USING restaurante_cuentas c
     WHERE i.id = $1 AND i.cuenta_id = $2 AND c.id = i.cuenta_id AND c.negocio_id = $3
       AND c.estado = 'abierta' AND i.estado = 'pendiente' AND i.comanda_num IS NULL
       AND NOT EXISTS (SELECT 1 FROM restaurante_cuenta_porciones po WHERE po.item_id = i.id AND po.revertido_at IS NULL)
     RETURNING i.id, i.producto`,
    [itemId, cuentaId, nid]
  );
  if (!rows.length) {
    if (await itemTieneCobro(itemId, cuentaId)) throw errorCodigo('Ese producto ya tiene un cobro: revierte el cobro antes de quitarlo', 'ITEM_TIENE_COBRO');
    throw errorCodigo('El platillo ya salió a cocina: usa cancelar', 'ITEM_NO_EDITABLE');
  }
  return rows[0];
}

// ─── Pagos y división (C5/C6) ───────────────────────────────────────────────
//
// Tres cantidades distintas, y solo una es venta:
//   monto     lo que se ABONA a la cuenta (la venta; nunca rebasa el saldo);
//   recibido  el efectivo que entregó el cliente (informativo);
//   cambio    recibido - monto - propina, lo que se le devuelve.
// La propina va aparte: no reduce el saldo ni entra a la venta, y con
// efectivo sale del billete recibido (por eso el recibido debe cubrirla).
// Un pago parcial es un abono menor al saldo; cada uno lleva su propio
// recibido y su propio cambio.
export async function registrarPago(cuentaId, negocioId, { metodo, monto, propina = 0, cubre = null, referencia = null, recibido = null }, usuarioId) {
  const nid = validarNegocioId(negocioId);
  const montoNum = redondear(Number(monto));
  const propinaNum = redondear(Number(propina) || 0);
  if (!Number.isFinite(montoNum) || montoNum <= 0) throw errorCodigo('El monto debe ser mayor a cero', 'MONTO_INVALIDO');
  if (propinaNum < 0) throw errorCodigo('La propina no puede ser negativa', 'MONTO_INVALIDO');
  let recibidoNum = null, cambioNum = null;
  if (recibido !== null && recibido !== undefined && recibido !== '') {
    recibidoNum = redondear(Number(recibido));
    if (!Number.isFinite(recibidoNum) || recibidoNum < 0) throw errorCodigo('El efectivo recibido no es válido', 'MONTO_INVALIDO');
    if (metodo !== 'efectivo') throw errorCodigo('El efectivo recibido solo aplica a pagos en efectivo', 'MONTO_INVALIDO');
    if (recibidoNum + 0.005 < montoNum + propinaNum) {
      throw errorCodigo(
        `El efectivo recibido ($${recibidoNum.toFixed(2)}) no cubre el abono ($${montoNum.toFixed(2)})${propinaNum > 0 ? ` más la propina ($${propinaNum.toFixed(2)})` : ''}`,
        'EFECTIVO_INSUFICIENTE');
    }
    cambioNum = redondear(recibidoNum - montoNum - propinaNum);
  }
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
    // Un abono suelto es su propio cobro (083): se agrupa con cobro_id para
    // poder revertirlo con auditoría, y es una asignación GENÉRICA: desde que
    // existe, lo que queda se cobra como remanente, no por producto.
    const { rows: [pago] } = await client.query(
      `INSERT INTO restaurante_cuenta_pagos (cuenta_id, negocio_id, metodo, monto, propina, cubre, referencia, registrado_por, recibido, cambio, cobro_id, tipo_cobro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'abono') RETURNING id, metodo, monto, propina, recibido, cambio, cobro_id, created_at`,
      [cuentaId, nid, metodo, montoNum, propinaNum, cubre, referencia, usuarioId, recibidoNum, cambioNum, randomUUID()]
    );
    await client.query('UPDATE restaurante_cuentas SET updated_at = NOW() WHERE id = $1', [cuentaId]);
    await client.query('COMMIT');
    return { pago, saldoRestante: redondear(saldo - montoNum), cambio: cambioNum, recibido: recibidoNum };
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

// ─── Descuento de la cuenta (migración 082) ─────────────────────────────────
//
// Un solo descuento por cuenta, sobre el consumo completo, con motivo
// obligatorio y auditoría (quién, cuándo, cuánto y cómo se capturó). La
// autorización es la MISMA del POS (services/descuentos.js): staff hasta el
// 10 % del subtotal, admin sin límite. Se aplica bajo FOR UPDATE, así que
// dos cajas no lo pisan a la vez y el saldo que ve el pago siguiente ya lo
// incluye. Nunca deja el total por debajo de lo ya cobrado: con pagos
// registrados, el descuento que los rebasaría se rechaza.
export async function aplicarDescuentoCuenta(cuentaId, negocioId, { tipo, valor, motivo }, { usuarioId, rol }) {
  const nid = validarNegocioId(negocioId);
  const t = String(tipo || '').trim();
  if (!['porcentaje', 'importe'].includes(t)) throw errorCodigo('El descuento es por porcentaje o por importe', 'DESCUENTO_INVALIDO');
  const v = redondear(Number(valor));
  if (!Number.isFinite(v) || v <= 0) throw errorCodigo('El descuento debe ser mayor a cero', 'DESCUENTO_INVALIDO');
  if (t === 'porcentaje' && v > 100) throw errorCodigo('El porcentaje no puede pasar de 100', 'DESCUENTO_INVALIDO');
  const { autorizarDescuento, calcularMontoDescuento } = await import('./descuentos.js');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.id, c.estado FROM restaurante_cuentas c WHERE c.id = $1 AND c.negocio_id = $2 FOR UPDATE`, [cuentaId, nid]);
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    if (rows[0].estado !== 'abierta') throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    const { rows: [tot] } = await client.query(`SELECT ${SQL_TOTALES} FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]);
    const subtotal = Number(tot.subtotal), pagado = Number(tot.pagado);
    // Descuento CONGELADO (083): con cualquier pago vigente ya no se agrega,
    // cambia ni quita. Lo cobrado se calculó con el descuento que había; para
    // cambiarlo se revierten primero los cobros.
    if (pagado > 0.005) {
      throw errorCodigo(`La cuenta ya tiene pagos por $${pagado.toFixed(2)}: el descuento está congelado. Revierte los cobros para cambiarlo.`, 'DESCUENTO_CONGELADO');
    }
    if (subtotal <= 0) throw errorCodigo('La cuenta no tiene consumo que descontar', 'DESCUENTO_INVALIDO');
    const monto = calcularMontoDescuento({ tipo: t, valor: v, subtotal });
    if (monto <= 0) throw errorCodigo('El descuento debe ser mayor a cero', 'DESCUENTO_INVALIDO');
    const autorizacion = autorizarDescuento({ rol, subtotal, descuento: monto, motivo });
    if (!autorizacion.ok) throw errorCodigo(autorizacion.mensaje, autorizacion.codigo);
    const total = redondear(subtotal - monto);
    if (total + 0.005 < pagado) {
      throw errorCodigo(
        `Ya hay pagos por $${pagado.toFixed(2)}: con este descuento el total quedaría en $${total.toFixed(2)}, por debajo de lo cobrado`,
        'DESCUENTO_INCOMPATIBLE');
    }
    await client.query(
      `UPDATE restaurante_cuentas
          SET descuento_tipo = $2, descuento_valor = $3, descuento_monto = $4, descuento_motivo = $5,
              descuento_por = $6, descuento_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [cuentaId, t, v, monto, autorizacion.motivo, usuarioId]);
    await client.query('COMMIT');
    return {
      descuento: { tipo: t, valor: v, monto, motivo: autorizacion.motivo, por: usuarioId },
      subtotal, total, pagado, saldo: redondear(total - pagado),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Quitar el descuento deja la cuenta como estaba: el total vuelve al
// consumo completo. Solo sobre cuentas abiertas; con pagos registrados el
// saldo simplemente sube, nunca queda negativo.
export async function quitarDescuentoCuenta(cuentaId, negocioId) {
  const nid = validarNegocioId(negocioId);
  const { rows } = await pool.query(
    `UPDATE restaurante_cuentas
        SET descuento_tipo = NULL, descuento_valor = NULL, descuento_monto = 0, descuento_motivo = NULL,
            descuento_por = NULL, descuento_at = NULL, updated_at = NOW()
      WHERE id = $1 AND negocio_id = $2 AND estado = 'abierta'
        AND NOT EXISTS (SELECT 1 FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = restaurante_cuentas.id AND p.revertido_at IS NULL)
      RETURNING id`, [cuentaId, nid]);
  if (!rows.length) {
    const { rows: chk } = await pool.query(
      `SELECT 1 FROM restaurante_cuentas c WHERE c.id = $1 AND c.negocio_id = $2 AND c.estado = 'abierta'
          AND EXISTS (SELECT 1 FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = c.id AND p.revertido_at IS NULL)`, [cuentaId, nid]);
    if (chk.length) throw errorCodigo('La cuenta ya tiene pagos: el descuento está congelado. Revierte los cobros para cambiarlo.', 'DESCUENTO_CONGELADO');
    throw errorCodigo('Cuenta no encontrada o no abierta', 'CUENTA_NO_ABIERTA');
  }
  return { ok: true };
}

// ─── Ticket de cuenta pagada ────────────────────────────────────────────────
//
// El snapshot que se imprime al cerrar y en cada reimpresión: dice PAGADO,
// folio de la venta, productos, subtotal, descuento (con motivo), propina,
// total, pagos por método, efectivo recibido y cambio. Es una función pura
// sobre la cuenta ya leída: quien la imprime (Edge o navegador) recibe
// exactamente lo mismo.
export function construirTicketCuenta(cuenta, {
  negocio = null,
  reimpresion = false,
  numero = null,
  autofacturaUrl = null,
  autofacturaQr = null,
} = {}) {
  const pagos = (cuenta.pagos || []).map(p => ({
    metodo: p.metodo,
    monto: Number(p.monto) || 0,
    propina: Number(p.propina) || 0,
    recibido: p.recibido == null ? null : Number(p.recibido),
    cambio: p.cambio == null ? null : Number(p.cambio),
  }));
  const efectivoRecibido = redondear(pagos.reduce((s, p) => s + (p.recibido || 0), 0));
  const cambio = redondear(pagos.reduce((s, p) => s + (p.cambio || 0), 0));
  const descuento = cuenta.descuento && Number(cuenta.descuento.monto) > 0 ? cuenta.descuento : null;
  return {
    ticketPagado: true,
    leyenda: 'PAGADO',
    negocio: negocio || null,
    mesa: cuenta.mesa,
    personas: cuenta.personas,
    mesero: cuenta.mesero?.nombre || null,
    folio: cuenta.ventaFolio || null,
    fecha: cuenta.cerradaAt || null,
    items: (cuenta.items || []).filter(i => i.estado !== 'cancelado').map(i => ({
      producto: i.producto,
      cantidad: i.cantidad,
      precioUnitario: Number(i.precio_unitario),
      modificadores: Array.isArray(i.modificadores) ? i.modificadores : [],
      notas: i.notas || null,
    })),
    subtotal: redondear(cuenta.subtotal),
    descuento: descuento ? descuento.monto : 0,
    descuentoMotivo: descuento ? descuento.motivo : null,
    descuentoTipo: descuento ? descuento.tipo : null,
    descuentoValor: descuento ? descuento.valor : null,
    // `promocion` es el rótulo que el renderer del Edge ya sabía imprimir
    // junto al descuento; llevar ahí el motivo hace que un Edge anterior a
    // esta versión también lo muestre.
    promocion: descuento ? descuento.motivo : null,
    propina: redondear(cuenta.propinas),
    total: redondear(cuenta.total),
    pagado: redondear(cuenta.pagado),
    pagos,
    efectivoRecibido: efectivoRecibido > 0 ? efectivoRecibido : null,
    cambio: cambio > 0 ? cambio : null,
    // La matriz ya calculada viaja en el snapshot para que tanto Edge como
    // el fallback del navegador impriman el mismo QR sin consultar la red.
    autofacturaUrl: autofacturaUrl || null,
    autofacturaQr: autofacturaQr || null,
    reimpresion: reimpresion === true,
    reimpresionNumero: numero,
  };
}

// Reimprimir el ticket es una intención nueva cada vez: se numera para que
// cada reimpresión tenga su propia clave de idempotencia en Edge y quede
// contada. Solo cuentas cerradas con venta contabilizada; nunca vuelve a
// cerrar, cobrar ni registrar nada más.
export async function registrarImpresionTicket(cuentaId, negocioId) {
  const nid = validarNegocioId(negocioId);
  const { rows } = await pool.query(
    `UPDATE restaurante_cuentas SET ticket_impresiones = ticket_impresiones + 1
      WHERE id = $1 AND negocio_id = $2 AND estado = 'cerrada' AND venta_folio IS NOT NULL
      RETURNING ticket_impresiones, venta_folio`, [cuentaId, nid]);
  if (!rows.length) throw errorCodigo('La cuenta no tiene un ticket pagado que reimprimir', 'TICKET_NO_DISPONIBLE');
  return { numero: Number(rows[0].ticket_impresiones), ventaFolio: rows[0].venta_folio };
}

// ─── División por consumo real (migración 083) ──────────────────────────────
//
// La cuenta sigue siendo UNA cuenta con UNA venta al cierre. Lo que cambia es
// cómo se cobra por partes: cada cobro (una persona) puede cubrir renglones
// reales de la cuenta -- completos, por unidades o por fracción de un
// renglón compartido -- y eso queda en restaurante_cuenta_porciones, nunca
// en texto. Reglas:
//   · el importe de la selección lo calcula el servidor en centavos con el
//     descuento prorrateado (divisionConsumo.js); los pagos que la cubren
//     deben sumar exactamente eso (MONTO_NO_COINCIDE): jamás se acepta un
//     total del navegador;
//   · bajo FOR UPDATE de la cuenta se releen las porciones vigentes: si otra
//     caja ya cobró lo que se pide, CONSUMO_YA_PAGADO con el detalle para
//     refrescar la pantalla. Un doble clic es el mismo caso;
//   · un pago suelto (abono) o una parte igual son asignaciones GENÉRICAS:
//     desde que existe una, la selección por producto queda cerrada
//     (REMANENTE_DIVIDIDO). Al revés sí: cobrar productos y luego dividir el
//     remanente en partes iguales;
//   · con cualquier pago vigente el descuento queda congelado y un renglón
//     con porción cobrada es inmutable; para cambiarlos se revierte el cobro
//     (revertirCobro: nunca borra, deja quién, cuándo y por qué).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function metodosHabilitados(nid) {
  const { rows } = await pool.query(`SELECT tipo FROM metodos_pago WHERE negocio_id = $1 AND habilitado = true`, [nid]);
  return new Set(rows.map(r => r.tipo));
}

// Normaliza y valida las líneas de pago de un cobro con las MISMAS reglas de
// registrarPago (abono > 0, propina ≥ 0, efectivo recibido solo con efectivo
// y cubriendo abono más propina). Todo en centavos enteros.
function normalizarPagos(lineas, metodos) {
  const lista = Array.isArray(lineas) ? lineas : [];
  if (!lista.length) throw errorCodigo('Indica al menos un pago', 'MONTO_INVALIDO');
  return lista.map(p => {
    const metodo = String(p?.metodo || '');
    if (!metodos.has(metodo)) throw errorCodigo(`Método de pago no habilitado: ${metodo || '(vacío)'}`, 'METODO_NO_HABILITADO');
    const monto = aCentavos(p?.monto);
    const propina = p?.propina === undefined || p?.propina === null || p?.propina === '' ? 0 : aCentavos(p.propina);
    if (!Number.isFinite(monto) || monto <= 0) throw errorCodigo('El monto debe ser mayor a cero', 'MONTO_INVALIDO');
    if (!Number.isFinite(propina) || propina < 0) throw errorCodigo('La propina no puede ser negativa', 'MONTO_INVALIDO');
    let recibido = null, cambio = null;
    if (p?.recibido !== null && p?.recibido !== undefined && p?.recibido !== '') {
      recibido = aCentavos(p.recibido);
      if (!Number.isFinite(recibido) || recibido < 0) throw errorCodigo('El efectivo recibido no es válido', 'MONTO_INVALIDO');
      if (metodo !== 'efectivo') throw errorCodigo('El efectivo recibido solo aplica a pagos en efectivo', 'MONTO_INVALIDO');
      if (recibido < monto + propina) {
        throw errorCodigo(
          `El efectivo recibido ($${aPesos(recibido).toFixed(2)}) no cubre el abono ($${aPesos(monto).toFixed(2)})${propina > 0 ? ` más la propina ($${aPesos(propina).toFixed(2)})` : ''}`,
          'EFECTIVO_INSUFICIENTE');
      }
      cambio = recibido - monto - propina;
    }
    return {
      metodo, monto, propina, recibido, cambio,
      cubre: p?.cubre ? String(p.cubre).slice(0, 200) : null,
      referencia: p?.referencia ? String(p.referencia).slice(0, 200) : null,
    };
  });
}

async function insertarPagosDeCobro(client, { cuentaId, nid, cobroId, tipo, pagos, usuarioId, cubreDefault = null }) {
  const filas = [];
  for (const p of pagos) {
    const { rows: [fila] } = await client.query(
      `INSERT INTO restaurante_cuenta_pagos (cuenta_id, negocio_id, metodo, monto, propina, cubre, referencia, registrado_por, recibido, cambio, cobro_id, tipo_cobro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, metodo, monto, propina, recibido, cambio, cubre, cobro_id, tipo_cobro, created_at`,
      [cuentaId, nid, p.metodo, aPesos(p.monto), aPesos(p.propina), p.cubre || cubreDefault, p.referencia, usuarioId,
       p.recibido == null ? null : aPesos(p.recibido), p.cambio == null ? null : aPesos(p.cambio), cobroId, tipo]);
    filas.push({ ...fila, monto: Number(fila.monto), propina: Number(fila.propina), recibido: fila.recibido == null ? null : Number(fila.recibido), cambio: fila.cambio == null ? null : Number(fila.cambio) });
  }
  return filas;
}

// Lee (con el pool o dentro de la transacción) todo lo que la división
// necesita: renglones vivos con su neto prorrateado y sus porciones
// vigentes, pagos vigentes y el modo de la cuenta.
async function leerDivision(q, cuentaId, cta) {
  const { rows: items } = await q.query(
    `SELECT id, producto, cantidad, precio_unitario, modificadores, notas, estado, comanda_num, created_at
       FROM restaurante_cuenta_items WHERE cuenta_id = $1 AND estado != 'cancelado' ORDER BY created_at, id`, [cuentaId]);
  const { rows: porciones } = await q.query(
    `SELECT id, item_id, cobro_id, numerador, denominador, importe_centavos, registrado_por, created_at
       FROM restaurante_cuenta_porciones WHERE cuenta_id = $1 AND revertido_at IS NULL ORDER BY created_at, id`, [cuentaId]);
  const { rows: pagos } = await q.query(
    `SELECT p.id, p.metodo, p.monto, p.propina, p.recibido, p.cambio, p.cubre, p.cobro_id, p.tipo_cobro, p.registrado_por, p.created_at,
            u.nombre AS registrado_por_nombre
       FROM restaurante_cuenta_pagos p JOIN usuarios u ON u.id = p.registrado_por
      WHERE p.cuenta_id = $1 AND p.revertido_at IS NULL ORDER BY p.created_at, p.id`, [cuentaId]);
  const descuentoCentavos = aCentavos(cta.descuento_monto || 0) || 0;
  const netos = netosDeRenglones(
    items.map(i => ({ id: i.id, brutoCentavos: aCentavos(Number(i.cantidad) * Number(i.precio_unitario)) })), descuentoCentavos);
  const netoPorId = new Map(netos.map(n => [n.id, n]));
  const porItem = new Map();
  for (const p of porciones) { if (!porItem.has(p.item_id)) porItem.set(p.item_id, []); porItem.get(p.item_id).push(p); }
  const renglones = items.map(i => {
    const n = netoPorId.get(i.id);
    const propias = porItem.get(i.id) || [];
    let cobrada = CERO, cobradoCentavos = 0;
    for (const p of propias) { cobrada = sumar(cobrada, fraccion(p.numerador, p.denominador)); cobradoCentavos += p.importe_centavos; }
    if (comparar(cobrada, UNO) > 0) cobrada = UNO;   // defensa: nunca más de un renglón
    const pendiente = restar(UNO, cobrada);
    return {
      id: i.id, producto: i.producto, cantidad: i.cantidad, precioUnitario: Number(i.precio_unitario),
      modificadores: Array.isArray(i.modificadores) ? i.modificadores : [], notas: i.notas, estadoItem: i.estado, comandaNum: i.comanda_num,
      brutoCentavos: n.brutoCentavos, descuentoCentavos: n.descuentoCentavos, netoCentavos: n.netoCentavos,
      cobradoCentavos, pendienteCentavos: Math.max(0, n.netoCentavos - cobradoCentavos),
      fraccionCobrada: cobrada, fraccionPendiente: pendiente,
      estado: esCero(cobrada) ? 'pendiente' : (esCero(pendiente) ? 'pagado' : 'parcial'),
      porciones: propias.map(p => ({ cobroId: p.cobro_id, numerador: p.numerador, denominador: p.denominador, importeCentavos: p.importe_centavos })),
    };
  });
  const genericos = pagos.filter(p => p.tipo_cobro !== 'consumo');
  const remanente = cta.division_remanente || null;
  const consumoBloqueado = Boolean(remanente) || genericos.length > 0;
  const motivoBloqueo = !consumoBloqueado ? null
    : (remanente ? `El remanente ya se dividió en ${remanente.partes} partes iguales: ya no se eligen productos`
      : 'Ya hay un pago suelto sobre la cuenta: lo que queda se cobra como remanente, no por producto');
  return { renglones, porciones, pagos, genericos, remanente, consumoBloqueado, motivoBloqueo, descuentoCentavos };
}

function resumenCobros(div) {
  const porCobro = new Map();
  for (const p of div.pagos) {
    const k = p.cobro_id || `pago:${p.id}`;
    if (!porCobro.has(k)) {
      porCobro.set(k, { cobroId: p.cobro_id, tipo: p.tipo_cobro, pagos: [], porciones: [], total: 0, propina: 0, at: p.created_at, registradoPor: p.registrado_por_nombre });
    }
    const c = porCobro.get(k);
    c.pagos.push({
      id: p.id, metodo: p.metodo, monto: Number(p.monto), propina: Number(p.propina) || 0,
      recibido: p.recibido == null ? null : Number(p.recibido), cambio: p.cambio == null ? null : Number(p.cambio), cubre: p.cubre,
    });
    c.total = redondear(c.total + Number(p.monto));
    c.propina = redondear(c.propina + (Number(p.propina) || 0));
  }
  const nombre = new Map(div.renglones.map(r => [r.id, r.producto]));
  for (const p of div.porciones) {
    const c = porCobro.get(p.cobro_id);
    if (c) c.porciones.push({ itemId: p.item_id, producto: nombre.get(p.item_id) || null, fraccion: textoFraccion(fraccion(p.numerador, p.denominador)), importe: aPesos(p.importe_centavos) });
  }
  return [...porCobro.values()];
}

// Estado completo de la división para la pantalla: renglones con lo cobrado
// y lo pendiente (fracción y centavos), cobros vigentes, si la selección por
// producto está abierta o bloqueada, y las partes iguales del remanente.
export async function estadoDivision(cuentaId, negocioId, { partes = null } = {}) {
  const nid = validarNegocioId(negocioId);
  const cuenta = await obtenerCuenta(cuentaId, nid);
  if (!cuenta) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
  const { rows: [cta] } = await pool.query(`SELECT descuento_monto, division_remanente FROM restaurante_cuentas WHERE id = $1`, [cuentaId]);
  const div = await leerDivision(pool, cuentaId, cta);
  const saldoCentavos = Math.max(0, aCentavos(cuenta.total) - aCentavos(cuenta.pagado));
  const N = div.remanente ? Number(div.remanente.partes) : (parseInt(partes, 10) || cuenta.personas || 1);
  const pagadas = new Set(div.pagos.filter(p => p.tipo_cobro === 'parte').map(p => p.cobro_id)).size;
  const restantes = Math.max(0, N - pagadas);
  const montos = (restantes > 0 && saldoCentavos > 0) ? partesIgualesCentavos(saldoCentavos, restantes).map(aPesos) : [];
  return {
    cuentaId, estado: cuenta.estado, subtotal: cuenta.subtotal, descuento: cuenta.descuento, total: cuenta.total,
    pagado: cuenta.pagado, propinas: cuenta.propinas, saldo: aPesos(saldoCentavos),
    modo: div.consumoBloqueado ? 'generico' : 'consumo',
    consumoBloqueado: div.consumoBloqueado, motivoBloqueo: div.motivoBloqueo, remanente: div.remanente,
    renglones: div.renglones.map(r => ({
      id: r.id, producto: r.producto, cantidad: r.cantidad, precioUnitario: r.precioUnitario, modificadores: r.modificadores, notas: r.notas,
      estadoItem: r.estadoItem, comandaNum: r.comandaNum,
      bruto: aPesos(r.brutoCentavos), descuento: aPesos(r.descuentoCentavos), neto: aPesos(r.netoCentavos),
      cobrado: aPesos(r.cobradoCentavos), pendiente: aPesos(r.pendienteCentavos),
      brutoCentavos: r.brutoCentavos, netoCentavos: r.netoCentavos, cobradoCentavos: r.cobradoCentavos, pendienteCentavos: r.pendienteCentavos,
      fraccionCobrada: textoFraccion(r.fraccionCobrada), fraccionPendiente: textoFraccion(r.fraccionPendiente),
      pendienteNum: r.fraccionPendiente.num, pendienteDen: r.fraccionPendiente.den,
      estado: r.estado, porciones: r.porciones,
    })),
    cobros: resumenCobros(div),
    partesIguales: { partes: N, pagadas, restantes, montos, fijas: Boolean(div.remanente) },
  };
}

// Cobrar una selección de consumo (o 'resto': todo lo pendiente) para UNA
// persona, con uno o varios pagos que suman exactamente el importe que el
// servidor calcula. `cobroId` opcional (uuid del cliente) hace el reintento
// idempotente: el mismo cobro no se registra dos veces.
export async function cobrarConsumo(cuentaId, negocioId, { seleccion, pagos, cobroId = null, nota = null } = {}, usuarioId) {
  const nid = validarNegocioId(negocioId);
  if (cobroId !== null && cobroId !== undefined && !UUID_RE.test(String(cobroId))) throw errorCodigo('cobroId inválido', 'COBRO_INVALIDO');
  const cobro = cobroId ? String(cobroId).toLowerCase() : randomUUID();
  const metodos = await metodosHabilitados(nid);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado, descuento_monto, division_remanente FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [cuentaId, nid]);
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    const cta = rows[0];
    if (cta.estado !== 'abierta') throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    const { rows: previos } = await client.query(`SELECT 1 FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND cobro_id = $2 LIMIT 1`, [cuentaId, cobro]);
    if (previos.length) {
      const div = await leerDivision(client, cuentaId, cta);
      await client.query('COMMIT');
      const existente = resumenCobros(div).find(c => c.cobroId === cobro) || null;
      return { cobroId: cobro, repetido: true, importe: existente?.total ?? null, pagos: existente?.pagos || [], porciones: existente?.porciones || [], cambio: null, saldoRestante: null };
    }
    const div = await leerDivision(client, cuentaId, cta);
    if (div.consumoBloqueado) throw errorCodigo(div.motivoBloqueo, 'REMANENTE_DIVIDIDO');
    const porId = new Map(div.renglones.map(r => [r.id, r]));

    // La selección: 'resto' = todo lo pendiente; o {itemId, numerador, denominador} | {itemId, cantidad}.
    const pedidas = new Map();
    if (seleccion === 'resto') {
      for (const r of div.renglones) if (!esCero(r.fraccionPendiente)) pedidas.set(r.id, r.fraccionPendiente);
    } else {
      for (const s of (Array.isArray(seleccion) ? seleccion : [])) {
        const r = porId.get(String(s?.itemId || ''));
        if (!r) throw errorCodigo('Un producto de la selección no está en la cuenta', 'ITEM_INVALIDO');
        let f;
        if (s.cantidad !== undefined && s.cantidad !== null) {
          const n = Number(s.cantidad);
          if (!Number.isInteger(n) || n < 1 || n > r.cantidad) throw errorCodigo(`Cantidad inválida para ${r.producto}`, 'FRACCION_INVALIDA');
          f = fraccion(n, r.cantidad);
        } else {
          f = fraccion(s.numerador, s.denominador);
        }
        if (esCero(f)) continue;
        pedidas.set(r.id, pedidas.has(r.id) ? sumar(pedidas.get(r.id), f) : f);
      }
    }
    if (!pedidas.size) throw errorCodigo('La selección está vacía', 'SELECCION_VACIA');

    // Disponibilidad e importes, releídos bajo el lock: lo que otra caja ya
    // cobró no se vuelve a cobrar.
    const elegidas = [];
    let importe = 0;
    for (const [id, f] of pedidas) {
      const r = porId.get(id);
      if (comparar(f, r.fraccionPendiente) > 0) {
        const e = errorCodigo(
          `${r.producto}: ya se cobró ${textoFraccion(r.fraccionCobrada)} y solo queda ${textoFraccion(r.fraccionPendiente)}`, 'CONSUMO_YA_PAGADO');
        e.detalle = { itemId: r.id, producto: r.producto, solicitado: textoFraccion(f), pendiente: textoFraccion(r.fraccionPendiente), pendienteCentavos: r.pendienteCentavos };
        throw e;
      }
      const centavos = importeDePorcion({ netoCentavos: r.netoCentavos, cobradoCentavos: r.cobradoCentavos, pendiente: r.fraccionPendiente, fraccion: f });
      elegidas.push({ renglon: r, fraccion: f, centavos });
      importe += centavos;
    }
    if (importe <= 0) throw errorCodigo('La selección no tiene importe que cobrar', 'SELECCION_VACIA');

    // Los pagos cubren EXACTAMENTE la selección: el total lo dice el servidor.
    const lineas = normalizarPagos(pagos, metodos);
    const suma = lineas.reduce((s, p) => s + p.monto, 0);
    if (suma !== importe) {
      const e = errorCodigo(`Los pagos suman $${aPesos(suma).toFixed(2)} y la selección vale $${aPesos(importe).toFixed(2)}`, 'MONTO_NO_COINCIDE');
      e.detalle = { importeEsperado: aPesos(importe), pagos: aPesos(suma) };
      throw e;
    }

    for (const el of elegidas) {
      await client.query(
        `INSERT INTO restaurante_cuenta_porciones (cuenta_id, negocio_id, item_id, cobro_id, numerador, denominador, importe_centavos, registrado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [cuentaId, nid, el.renglon.id, cobro, el.fraccion.num, el.fraccion.den, el.centavos, usuarioId]);
    }
    const filas = await insertarPagosDeCobro(client, {
      cuentaId, nid, cobroId: cobro, tipo: 'consumo', pagos: lineas, usuarioId,
      cubreDefault: nota ? String(nota).slice(0, 200) : elegidas.map(el => `${textoFraccion(el.fraccion)} ${el.renglon.producto}`).join(', ').slice(0, 200),
    });
    await client.query('UPDATE restaurante_cuentas SET updated_at = NOW() WHERE id = $1', [cuentaId]);
    const { rows: [tot] } = await client.query(`SELECT ${SQL_TOTALES} FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]);
    await client.query('COMMIT');
    const conCambio = lineas.some(p => p.cambio != null);
    return {
      cobroId: cobro, repetido: false, importe: aPesos(importe),
      porciones: elegidas.map(el => ({ itemId: el.renglon.id, producto: el.renglon.producto, fraccion: textoFraccion(el.fraccion), importe: aPesos(el.centavos) })),
      pagos: filas,
      cambio: conCambio ? aPesos(lineas.reduce((s, p) => s + (p.cambio || 0), 0)) : null,
      saldoRestante: redondear(Number(tot.total) - Number(tot.pagado)),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Cobrar UNA parte igual del remanente. La primera parte formaliza la
// división (division_remanente): desde entonces N queda fijo y la selección
// por producto se cierra. Las partes que faltan se recalculan sobre el saldo
// pendiente; los pagos deben sumar exactamente una de ellas.
export async function cobrarParteIgual(cuentaId, negocioId, { partes, pagos, cobroId = null } = {}, usuarioId) {
  const nid = validarNegocioId(negocioId);
  if (cobroId !== null && cobroId !== undefined && !UUID_RE.test(String(cobroId))) throw errorCodigo('cobroId inválido', 'COBRO_INVALIDO');
  const cobro = cobroId ? String(cobroId).toLowerCase() : randomUUID();
  const metodos = await metodosHabilitados(nid);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado, descuento_monto, division_remanente FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [cuentaId, nid]);
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    const cta = rows[0];
    if (cta.estado !== 'abierta') throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    const { rows: previos } = await client.query(`SELECT 1 FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND cobro_id = $2 LIMIT 1`, [cuentaId, cobro]);
    if (previos.length) {
      const div = await leerDivision(client, cuentaId, cta);
      await client.query('COMMIT');
      const existente = resumenCobros(div).find(c => c.cobroId === cobro) || null;
      return { cobroId: cobro, repetido: true, monto: existente?.total ?? null, pagos: existente?.pagos || [], cambio: null, saldoRestante: null };
    }
    const div = await leerDivision(client, cuentaId, cta);
    let N;
    if (div.remanente) {
      N = Number(div.remanente.partes);
      if (partes !== undefined && partes !== null && parseInt(partes, 10) !== N) {
        throw errorCodigo(`El remanente ya se dividió en ${N} partes: no se cambia a medias`, 'PARTES_YA_FIJADAS');
      }
    } else {
      N = parseInt(partes, 10);
      if (!Number.isInteger(N) || N < 1 || N > 100) throw errorCodigo('Número de partes inválido', 'PARTES_INVALIDAS');
    }
    const { rows: [tot] } = await client.query(`SELECT ${SQL_TOTALES} FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]);
    const saldoCentavos = aCentavos(tot.total) - aCentavos(tot.pagado);
    if (saldoCentavos <= 0) throw errorCodigo('La cuenta no tiene saldo pendiente', 'NADA_QUE_COBRAR');
    const pagadas = new Set(div.pagos.filter(p => p.tipo_cobro === 'parte').map(p => p.cobro_id)).size;
    const restantes = N - pagadas;
    if (restantes <= 0) throw errorCodigo(`Las ${N} partes ya están cobradas`, 'PARTES_AGOTADAS');
    const montos = partesIgualesCentavos(saldoCentavos, restantes);
    const lineas = normalizarPagos(pagos, metodos);
    const suma = lineas.reduce((s, p) => s + p.monto, 0);
    if (!montos.includes(suma)) {
      const e = errorCodigo(`La parte vale $${aPesos(montos[0]).toFixed(2)} y los pagos suman $${aPesos(suma).toFixed(2)}`, 'MONTO_NO_COINCIDE');
      e.detalle = { partes: montos.map(aPesos), pagos: aPesos(suma) };
      throw e;
    }
    if (!div.remanente) {
      await client.query(`UPDATE restaurante_cuentas SET division_remanente = $2::jsonb WHERE id = $1`,
        [cuentaId, JSON.stringify({ partes: N, iniciado_at: new Date().toISOString(), iniciado_por: usuarioId, saldo_centavos: saldoCentavos })]);
    }
    const filas = await insertarPagosDeCobro(client, {
      cuentaId, nid, cobroId: cobro, tipo: 'parte', pagos: lineas, usuarioId, cubreDefault: `Parte ${pagadas + 1} de ${N}`,
    });
    await client.query('UPDATE restaurante_cuentas SET updated_at = NOW() WHERE id = $1', [cuentaId]);
    const { rows: [tot2] } = await client.query(`SELECT ${SQL_TOTALES} FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]);
    await client.query('COMMIT');
    const conCambio = lineas.some(p => p.cambio != null);
    return {
      cobroId: cobro, repetido: false, partes: N, parte: pagadas + 1, restantes: restantes - 1, monto: aPesos(suma), pagos: filas,
      cambio: conCambio ? aPesos(lineas.reduce((s, p) => s + (p.cambio || 0), 0)) : null,
      saldoRestante: redondear(Number(tot2.total) - Number(tot2.pagado)),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Reverso de un cobro (admin, motivo obligatorio): marca sus pagos y sus
// porciones como revertidos con quién, cuándo y por qué. Nunca borra. Las
// porciones vuelven a estar disponibles para cobrarse; si ya no queda ninguna
// parte igual vigente, la división del remanente se libera. Una cuenta con
// venta contabilizada exige antes el reverso de la venta.
export async function revertirCobro(cuentaId, negocioId, cobroId, { usuarioId, motivo } = {}) {
  const nid = validarNegocioId(negocioId);
  if (!UUID_RE.test(String(cobroId || ''))) throw errorCodigo('cobroId inválido', 'COBRO_INVALIDO');
  const texto = String(motivo || '').trim();
  if (!texto) throw errorCodigo('El motivo del reverso es obligatorio', 'MOTIVO_REQUERIDO');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado, venta_folio FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [cuentaId, nid]);
    if (!rows.length) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    if (rows[0].estado !== 'abierta') {
      if (rows[0].venta_folio) throw errorCodigo('La cuenta tiene una venta contabilizada: revierte la venta antes que el cobro', 'VENTA_CONTABILIZADA');
      throw errorCodigo('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    }
    const { rows: pagos } = await client.query(
      `UPDATE restaurante_cuenta_pagos SET revertido_at = NOW(), revertido_por = $3, motivo_reverso = $4
        WHERE cuenta_id = $1 AND cobro_id = $2 AND revertido_at IS NULL RETURNING id, monto, tipo_cobro`,
      [cuentaId, cobroId, usuarioId, texto]);
    if (!pagos.length) throw errorCodigo('Cobro no encontrado o ya revertido', 'COBRO_NO_ENCONTRADO');
    const { rows: porciones } = await client.query(
      `UPDATE restaurante_cuenta_porciones SET revertido_at = NOW(), revertido_por = $3, motivo_reverso = $4
        WHERE cuenta_id = $1 AND cobro_id = $2 AND revertido_at IS NULL RETURNING id, item_id`,
      [cuentaId, cobroId, usuarioId, texto]);
    const { rows: [quedan] } = await client.query(
      `SELECT count(*)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND tipo_cobro = 'parte' AND revertido_at IS NULL`, [cuentaId]);
    if (quedan.n === 0) await client.query(`UPDATE restaurante_cuentas SET division_remanente = NULL WHERE id = $1`, [cuentaId]);
    await client.query('UPDATE restaurante_cuentas SET updated_at = NOW() WHERE id = $1', [cuentaId]);
    await client.query('COMMIT');
    return {
      ok: true, cobroId: String(cobroId).toLowerCase(), pagosRevertidos: pagos.length, porcionesLiberadas: porciones.length,
      montoRevertido: redondear(pagos.reduce((s, p) => s + Number(p.monto), 0)),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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
  const { construirDesgloseDescuentos } = await import('./descuentos.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.id, c.estado, c.mesa_numero, c.personas, c.mesero_usuario_id, c.abierta_at,
              c.venta_folio, c.reversos,
              c.descuento_tipo, c.descuento_valor, c.descuento_monto, c.descuento_motivo, c.descuento_por
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
      `SELECT metodo, SUM(monto)::numeric(12,2) AS monto, SUM(propina)::numeric(12,2) AS propina,
              SUM(recibido)::numeric(12,2) AS recibido, SUM(cambio)::numeric(12,2) AS cambio
       FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND revertido_at IS NULL GROUP BY metodo ORDER BY metodo`,
      [cuentaId]
    );
    const meseroQ = await client.query('SELECT nombre FROM usuarios WHERE id = $1', [cta.mesero_usuario_id]);
    const items = itemsQ.rows, pagos = pagosQ.rows, mesero = meseroQ.rows[0];
    const metodos = pagos.map(pg => pg.metodo);
    const formaPago = metodos.length === 0 ? 'sin pago' : (metodos.length === 1 ? metodos[0] : 'mixto');
    const ventaFolio = `RM-${String(cta.id).replace(/-/g, '').slice(0, 8).toUpperCase()}-${cta.reversos}`;
    const descuentoMonto = Number(cta.descuento_monto) || 0;
    const efectivoRecibido = redondear(pagos.reduce((s, pg) => s + (Number(pg.recibido) || 0), 0));
    const cambio = redondear(pagos.reduce((s, pg) => s + (Number(pg.cambio) || 0), 0));
    // `subtotal`, `descuento` y `motivo_descuento` llevan los MISMOS nombres
    // que una venta del POS: el historial, ventas y el corte los leen igual.
    // `total` es el neto (subtotal - descuento), que es lo que se cobró.
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
      subtotal: Number(tot.subtotal),
      descuento: descuentoMonto,
      motivo_descuento: descuentoMonto > 0 ? cta.descuento_motivo : null,
      ...(descuentoMonto > 0 ? {
        descuento_tipo: cta.descuento_tipo, descuento_valor: Number(cta.descuento_valor), descuento_por: cta.descuento_por,
      } : {}),
      // Fase 2 -- bloque normalizado DUAL-WRITE. Restaurante es el único
      // canal con `tipo` (porcentaje/importe) Y `autorizadoPor` reales de
      // verdad (aplicarDescuentoCuenta los exige y audita). Sin promociones
      // ni Rewards: ninguno de los dos existe todavía en el flujo de mesas.
      descuentos: construirDesgloseDescuentos({
        manual: descuentoMonto > 0
          ? { monto: descuentoMonto, tipo: cta.descuento_tipo, motivo: cta.descuento_motivo, autorizadoPor: cta.descuento_por }
          : null,
        promociones: [],
        rewards: null,
      }),
      total: Number(tot.total),
      propinas: Number(tot.propinas),
      costo_envio: 0,
      forma_pago: formaPago,
      pagos: pagos.map(pg => ({
        metodo: pg.metodo, monto: Number(pg.monto), propina: Number(pg.propina),
        ...(pg.recibido != null ? { recibido: Number(pg.recibido), cambio: Number(pg.cambio) || 0 } : {}),
      })),
      ...(efectivoRecibido > 0 ? { efectivo_recibido: efectivoRecibido, cambio } : {}),
      estado: 'entregado',
      descuentos: construirDesgloseDescuentos({
        manual: descuentoMonto > 0 ? {
          monto: descuentoMonto, tipo: cta.descuento_tipo,
          motivo: cta.descuento_motivo, autorizadoPor: cta.descuento_por,
        } : null,
        promociones: [],
        rewards: null,
      }),
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
    return {
      ok: true, total: Number(tot.total), subtotal: Number(tot.subtotal), descuento: descuentoMonto,
      propinas: Number(tot.propinas), ventaFolio, pagos: datosVenta.pagos,
      ...(efectivoRecibido > 0 ? { efectivoRecibido, cambio } : {}),
    };
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
