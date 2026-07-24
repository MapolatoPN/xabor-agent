import pkg from 'pg';
import { createHmac, randomBytes } from 'crypto';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Inicializar tablas ───────────────────────────────────────────────────────
export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      telefono    VARCHAR(20) PRIMARY KEY,
      nombre      VARCHAR(100),
      ultima_visita TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id             SERIAL PRIMARY KEY,
      folio          VARCHAR(20),
      telefono       VARCHAR(20) REFERENCES clientes(telefono),
      nombre_cliente VARCHAR(100),
      items          JSONB,
      total          DECIMAL(10,2),
      costo_envio    DECIMAL(10,2) DEFAULT 0,
      modalidad      VARCHAR(50),
      canal          VARCHAR(20),
      forma_pago     VARCHAR(50),
      created_at     TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS folio VARCHAR(20);
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS nombre_cliente VARCHAR(100);
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio DECIMAL(10,2) DEFAULT 0;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS forma_pago VARCHAR(50);
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bot_pausado BOOLEAN DEFAULT FALSE;
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pedido_pago_pendiente VARCHAR(20) DEFAULT NULL;

    CREATE TABLE IF NOT EXISTS mensajes (
      id          SERIAL PRIMARY KEY,
      telefono    VARCHAR(20) NOT NULL,
      nombre      VARCHAR(100),
      direccion   VARCHAR(10) NOT NULL,
      texto       TEXT NOT NULL,
      timestamp   TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mensajes_telefono ON mensajes(telefono);
    CREATE INDEX IF NOT EXISTS idx_mensajes_timestamp ON mensajes(timestamp DESC);

    CREATE TABLE IF NOT EXISTS pedidos_activos (
      folio       VARCHAR(20) PRIMARY KEY,
      estado      VARCHAR(30) DEFAULT 'nuevo',
      datos       JSONB NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pedidos_programados (
      folio          VARCHAR(20) PRIMARY KEY,
      datos          JSONB NOT NULL,
      programado_para TIMESTAMP NOT NULL,
      activado       BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS configuracion (
      clave  VARCHAR(50) PRIMARY KEY,
      valor  TEXT NOT NULL
    );
    INSERT INTO configuracion (clave, valor) VALUES
      ('nombre',        'Restaurante Xabor'),
      ('nombre_corto',  'XABOR'),
      ('direccion',     'Lib. Manuel Perez Trevino 2416 Local 4'),
      ('ciudad',        'Col. Tecnologico, Piedras Negras, Coah.'),
      ('rfc',           'CAOM940122PTA'),
      ('telefono',      '(878) 109-1115'),
      ('whatsapp',      '(878) 109-1115'),
      ('horario',       'lunes a sabado 11am-10pm')
    ON CONFLICT (clave) DO NOTHING;

    CREATE TABLE IF NOT EXISTS caja_fondos (
      id          SERIAL PRIMARY KEY,
      fecha       DATE NOT NULL UNIQUE,
      fondo       DECIMAL(10,2) NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prompt_improvements (
      id          SERIAL PRIMARY KEY,
      semana      DATE NOT NULL,
      sugerencias JSONB NOT NULL,
      estado      VARCHAR(20) DEFAULT 'pendiente',
      aprobadas   JSONB,
      created_at  TIMESTAMP DEFAULT NOW(),
      applied_at  TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prompt_overrides (
      id          SERIAL PRIMARY KEY,
      seccion     VARCHAR(100) NOT NULL,
      contenido   TEXT NOT NULL,
      activo      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transcripciones_voz (
      id          SERIAL PRIMARY KEY,
      call_sid    VARCHAR(50) NOT NULL,
      from_num    VARCHAR(30),
      rol         VARCHAR(10) NOT NULL,
      texto       TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transcripciones_call_sid ON transcripciones_voz(call_sid);
    CREATE INDEX IF NOT EXISTS idx_transcripciones_created_at ON transcripciones_voz(created_at DESC);

    CREATE TABLE IF NOT EXISTS menu_categorias (
      id         SERIAL PRIMARY KEY,
      nombre     VARCHAR(100) NOT NULL,
      orden      INTEGER DEFAULT 0,
      activa     BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS menu_productos (
      id           SERIAL PRIMARY KEY,
      categoria_id INTEGER REFERENCES menu_categorias(id) ON DELETE CASCADE,
      codigo       VARCHAR(20) UNIQUE,
      nombre       VARCHAR(150) NOT NULL,
      descripcion  TEXT,
      precio       DECIMAL(10,2) NOT NULL,
      disponible   BOOLEAN DEFAULT TRUE,
      opciones     JSONB,
      orden        INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          SERIAL PRIMARY KEY,
      endpoint    TEXT NOT NULL UNIQUE,
      auth        TEXT NOT NULL,
      p256dh      TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS repartidores (
      id          SERIAL PRIMARY KEY,
      nombre      VARCHAR(100) NOT NULL,
      telefono    VARCHAR(20) NOT NULL UNIQUE,
      activo      BOOLEAN DEFAULT TRUE,
      token       VARCHAR(64) NOT NULL UNIQUE,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions_repartidor (
      id              SERIAL PRIMARY KEY,
      repartidor_id   INTEGER NOT NULL REFERENCES repartidores(id) ON DELETE CASCADE,
      endpoint        TEXT NOT NULL UNIQUE,
      auth            TEXT NOT NULL,
      p256dh          TEXT NOT NULL,
      created_at      TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] Tablas listas');
}

// ─── Menú — seed desde JSON ───────────────────────────────────────────────────
export async function seedMenuDesdeJSON(menuJSON) {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM menu_categorias');
    if (parseInt(rows[0].count) > 0) return; // Ya hay datos, no sobreescribir
    for (let i = 0; i < menuJSON.categorias.length; i++) {
      const cat = menuJSON.categorias[i];
      const { rows: [{ id: catId }] } = await pool.query(
        'INSERT INTO menu_categorias (nombre, orden) VALUES ($1, $2) RETURNING id',
        [cat.nombre, i]
      );
      for (let j = 0; j < cat.productos.length; j++) {
        const p = cat.productos[j];
        const opciones = p.opciones ? JSON.stringify(p.opciones) : null;
        await pool.query(
          `INSERT INTO menu_productos (categoria_id, codigo, nombre, descripcion, precio, disponible, opciones, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [catId, p.id, p.nombre, p.descripcion || '', p.precio, p.disponible !== false, opciones, j]
        );
      }
    }
    console.log('[DB] Menú importado desde JSON');
  } catch(e) {
    console.error('[DB] Error seedMenuDesdeJSON:', e.message);
  }
}

// ─── Menú — lectura ───────────────────────────────────────────────────────────
export async function obtenerMenuCompleto() {
  try {
    const cats = await pool.query(
      'SELECT * FROM menu_categorias WHERE activa = TRUE ORDER BY orden'
    );
    const prods = await pool.query(
      `SELECT p.* FROM menu_productos p
       JOIN menu_categorias c ON c.id = p.categoria_id
       WHERE c.activa = TRUE ORDER BY p.orden`
    );
    return cats.rows.map(c => ({
      ...c,
      productos: prods.rows.filter(p => p.categoria_id === c.id)
    }));
  } catch(e) {
    console.error('[DB] obtenerMenuCompleto:', e.message);
    return [];
  }
}

// ─── Menú — CRUD categorías ───────────────────────────────────────────────────
export async function crearCategoria(nombre) {
  const { rows } = await pool.query(
    'INSERT INTO menu_categorias (nombre, orden) VALUES ($1, (SELECT COALESCE(MAX(orden)+1,0) FROM menu_categorias)) RETURNING *',
    [nombre]
  );
  return rows[0];
}

export async function actualizarCategoria(id, campos) {
  const sets = [], vals = [];
  if (campos.nombre    !== undefined) { sets.push(`nombre=$${sets.length+1}`);  vals.push(campos.nombre); }
  if (campos.activa    !== undefined) { sets.push(`activa=$${sets.length+1}`);  vals.push(campos.activa); }
  if (campos.orden     !== undefined) { sets.push(`orden=$${sets.length+1}`);   vals.push(campos.orden); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE menu_categorias SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
}

// ─── Menú — CRUD productos ────────────────────────────────────────────────────
export async function crearProducto(datos) {
  const { categoria_id, nombre, descripcion, precio, disponible, opciones } = datos;
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (categoria_id, nombre, descripcion, precio, disponible, opciones, orden)
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(orden)+1,0) FROM menu_productos WHERE categoria_id=$1))
     RETURNING *`,
    [categoria_id, nombre, descripcion||'', precio, disponible!==false, opciones ? JSON.stringify(opciones) : null]
  );
  return rows[0];
}

export async function actualizarProducto(id, campos) {
  const sets = [], vals = [];
  if (campos.nombre       !== undefined) { sets.push(`nombre=$${sets.length+1}`);       vals.push(campos.nombre); }
  if (campos.descripcion  !== undefined) { sets.push(`descripcion=$${sets.length+1}`);  vals.push(campos.descripcion); }
  if (campos.precio       !== undefined) { sets.push(`precio=$${sets.length+1}`);       vals.push(campos.precio); }
  if (campos.disponible   !== undefined) { sets.push(`disponible=$${sets.length+1}`);   vals.push(campos.disponible); }
  if (campos.categoria_id !== undefined) { sets.push(`categoria_id=$${sets.length+1}`); vals.push(campos.categoria_id); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE menu_productos SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
}

export async function eliminarProducto(id) {
  await pool.query('DELETE FROM menu_productos WHERE id=$1', [id]);
}

export async function eliminarCategoria(id) {
  await pool.query('DELETE FROM menu_categorias WHERE id=$1', [id]);
}

// ─── Push Notifications ───────────────────────────────────────────────────────
export async function guardarSuscripcionPush({ endpoint, auth, p256dh }) {
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, auth, p256dh)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET auth=$2, p256dh=$3`,
    [endpoint, auth, p256dh]
  );
}

export async function obtenerSuscripcionesPush() {
  const { rows } = await pool.query('SELECT endpoint, auth, p256dh FROM push_subscriptions');
  return rows;
}

export async function eliminarSuscripcionPush(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
}

// ─── Obtener cliente por teléfono ─────────────────────────────────────────────
export async function obtenerCliente(telefono) {
  try {
    const result = await pool.query(
      'SELECT * FROM clientes WHERE telefono = $1',
      [telefono]
    );
    return result.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerCliente:', e.message);
    return null;
  }
}

// ─── Crear o actualizar cliente ───────────────────────────────────────────────
export async function upsertCliente(telefono, nombre) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, nombre, ultima_visita)
      VALUES ($1, $2, NOW())
      ON CONFLICT (telefono) DO UPDATE SET
        nombre = COALESCE(NULLIF($2, ''), clientes.nombre),
        ultima_visita = NOW()
    `, [telefono, nombre || null]);
  } catch (e) {
    console.error('[DB] Error upsertCliente:', e.message);
  }
}

// ─── Control manual del bot por conversación ──────────────────────────────────
export async function setBotPausado(telefono, pausado) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, bot_pausado)
      VALUES ($1, $2)
      ON CONFLICT (telefono) DO UPDATE SET bot_pausado = $2
    `, [telefono, pausado]);
  } catch (e) {
    console.error('[DB] Error setBotPausado:', e.message);
  }
}

export async function getBotPausado(telefono) {
  try {
    const result = await pool.query(
      'SELECT bot_pausado FROM clientes WHERE telefono = $1',
      [telefono]
    );
    return result.rows[0]?.bot_pausado || false;
  } catch (e) {
    console.error('[DB] Error getBotPausado:', e.message);
    return false;
  }
}

// ─── Link de pago pendiente (pedidos por voz) ────────────────────────────────
export async function setPagoPendiente(telefono, pedidoId) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, pedido_pago_pendiente)
      VALUES ($1, $2)
      ON CONFLICT (telefono) DO UPDATE SET pedido_pago_pendiente = $2
    `, [telefono, pedidoId]);
  } catch (e) {
    console.error('[DB] Error setPagoPendiente:', e.message);
  }
}

export async function getPagoPendiente(telefono) {
  try {
    const result = await pool.query(
      'SELECT pedido_pago_pendiente FROM clientes WHERE telefono = $1',
      [telefono]
    );
    return result.rows[0]?.pedido_pago_pendiente || null;
  } catch (e) {
    console.error('[DB] Error getPagoPendiente:', e.message);
    return null;
  }
}

export async function clearPagoPendiente(telefono) {
  try {
    await pool.query(
      'UPDATE clientes SET pedido_pago_pendiente = NULL WHERE telefono = $1',
      [telefono]
    );
  } catch (e) {
    console.error('[DB] Error clearPagoPendiente:', e.message);
  }
}

// ─── Guardar pedido ───────────────────────────────────────────────────────────
export async function guardarPedido(telefono, pedido) {
  try {
    await pool.query(`
      INSERT INTO pedidos (telefono, items, total, modalidad, canal, forma_pago, nombre_cliente, costo_envio, folio)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING
    `, [
      telefono,
      JSON.stringify(pedido.items),
      pedido.total,
      pedido.modalidad,
      pedido.canal,
      pedido.forma_pago || pedido.cliente?.forma_pago || null,
      pedido.cliente?.nombre || null,
      pedido.costo_envio || 0,
      pedido.id || null
    ]);
  } catch (e) {
    console.error('[DB] Error guardarPedido:', e.message);
  }
}

// ─── Historial de pedidos entregados ─────────────────────────────────────────
export async function obtenerPedidosEntregados(limite = 100) {
  try {
    const result = await pool.query(`
      SELECT folio, estado, datos, updated_at
      FROM pedidos_activos
      WHERE estado IN ('entregado', 'cancelado')
      ORDER BY updated_at DESC
      LIMIT $1
    `, [limite]);
    return result.rows.map(r => ({ ...r.datos, entregado_at: r.updated_at, _estado: r.estado }));
  } catch (e) {
    console.error('[DB] Error obtenerPedidosEntregados:', e.message);
    return [];
  }
}

// ─── Cancelar pedido activo ────────────────────────────────────────────────────
export async function cancelarPedidoActivo(folio, motivo) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET estado = 'cancelado',
          datos  = jsonb_set(datos, '{cancelacion}', $2::jsonb),
          updated_at = NOW()
      WHERE folio = $1 AND estado NOT IN ('entregado', 'cancelado')
    `, [folio, JSON.stringify({ motivo, timestamp: new Date().toISOString() })]);
    return true;
  } catch (e) {
    console.error('[DB] Error cancelarPedidoActivo:', e.message);
    return false;
  }
}

// ─── Registrar devolución en pedido entregado ─────────────────────────────────
export async function registrarDevolucion(folio, monto, motivo) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = jsonb_set(datos, '{devolucion}', $2::jsonb),
          updated_at = NOW()
      WHERE folio = $1 AND estado = 'entregado'
    `, [folio, JSON.stringify({ monto: parseFloat(monto), motivo, timestamp: new Date().toISOString() })]);
    return true;
  } catch (e) {
    console.error('[DB] Error registrarDevolucion:', e.message);
    return false;
  }
}

// ─── Consultas para POS ───────────────────────────────────────────────────────
export async function obtenerVentas(desde, hasta) {
  try {
    const result = await pool.query(`
      SELECT
        folio                                                              AS id,
        folio,
        estado,
        datos->'cliente'->>'telefono'                                      AS telefono,
        datos->'cliente'->>'nombre'                                        AS nombre_cliente,
        datos->'items'                                                     AS items,
        (datos->>'total')::decimal                                         AS total,
        datos->>'modalidad'                                                AS modalidad,
        datos->>'canal'                                                    AS canal,
        COALESCE(datos->>'forma_pago','no especificado')                   AS forma_pago,
        COALESCE((datos->>'costo_envio')::decimal, 0)                     AS costo_envio,
        COALESCE((datos->'devolucion'->>'monto')::decimal, 0)             AS devolucion_monto,
        datos->'devolucion'->>'motivo'                                     AS devolucion_motivo,
        datos->'cancelacion'->>'motivo'                                    AS cancelacion_motivo,
        created_at
      FROM pedidos_activos
      WHERE created_at >= $1 AND created_at <= $2
        AND estado != 'cancelado'
      ORDER BY created_at DESC
    `, [desde, hasta]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerVentas:', e.message);
    return [];
  }
}

export async function obtenerResumenVentas(desde, hasta) {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int                                                                              AS num_pedidos,
        COALESCE(SUM((datos->>'total')::decimal), 0)::float                                       AS total_ventas,
        COALESCE(SUM(COALESCE((datos->'devolucion'->>'monto')::decimal, 0)), 0)::float            AS total_devoluciones,
        COALESCE(AVG((datos->>'total')::decimal), 0)::float                                       AS promedio,
        COALESCE(SUM((datos->>'costo_envio')::decimal), 0)::float                                 AS total_envios,
        COUNT(*) FILTER (WHERE datos->>'modalidad' ILIKE '%domicilio%')::int                      AS domicilios,
        COUNT(*) FILTER (WHERE datos->>'modalidad' ILIKE '%recoger%'
                            OR datos->>'modalidad' ILIKE '%tienda%')::int                         AS recoger,
        COUNT(*) FILTER (WHERE estado = 'cancelado')::int                                         AS cancelados
      FROM pedidos_activos
      WHERE created_at >= $1 AND created_at <= $2
        AND estado != 'cancelado'
    `, [desde, hasta]);
    return result.rows[0];
  } catch (e) {
    console.error('[DB] Error obtenerResumenVentas:', e.message);
    return {};
  }
}

export async function actualizarFormaPago(folio, formaPago) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = jsonb_set(datos, '{forma_pago}', $2::jsonb), updated_at = NOW()
      WHERE folio = $1
    `, [folio, JSON.stringify(formaPago)]);
    return true;
  } catch (e) {
    console.error('[DB] Error actualizarFormaPago:', e.message);
    return false;
  }
}

// ─── Mensajes WhatsApp ───────────────────────────────────────────────────────
export async function guardarMensaje(telefono, nombre, direccion, texto) {
  try {
    const result = await pool.query(`
      INSERT INTO mensajes (telefono, nombre, direccion, texto)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [telefono, nombre || null, direccion, texto]);
    return result.rows[0];
  } catch (e) {
    console.error('[DB] Error guardarMensaje:', e.message);
    return null;
  }
}

export async function obtenerConversacion(telefono) {
  try {
    const result = await pool.query(`
      SELECT * FROM mensajes WHERE telefono = $1
      ORDER BY timestamp ASC
    `, [telefono]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerConversacion:', e.message);
    return [];
  }
}

export async function obtenerConversacionesRecientes(limite = 20) {
  try {
    const result = await pool.query(`
      SELECT
        t.telefono,
        (SELECT nombre FROM mensajes WHERE telefono = t.telefono AND nombre IS NOT NULL ORDER BY timestamp DESC LIMIT 1) AS nombre,
        t.texto,
        t.direccion,
        t.timestamp
      FROM (
        SELECT DISTINCT ON (telefono) telefono, texto, direccion, timestamp
        FROM mensajes
        ORDER BY telefono, timestamp DESC
      ) t
      ORDER BY t.timestamp DESC
      LIMIT $1
    `, [limite]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerConversacionesRecientes:', e.message);
    return [];
  }
}

// ─── Pedidos activos del panel (sobreviven reinicios) ────────────────────────
export async function guardarPedidoActivo(pedido) {
  try {
    await pool.query(`
      INSERT INTO pedidos_activos (folio, estado, datos)
      VALUES ($1, $2, $3)
      ON CONFLICT (folio) DO UPDATE SET datos = $3, updated_at = NOW()
    `, [pedido.id, pedido.estado || 'nuevo', JSON.stringify(pedido)]);
  } catch (e) {
    console.error('[DB] Error guardarPedidoActivo:', e.message);
  }
}

export async function actualizarEstadoPedidoDB(folio, estado) {
  try {
    await pool.query(`
      UPDATE pedidos_activos SET estado = $1, updated_at = NOW()
      WHERE folio = $2
    `, [estado, folio]);
  } catch (e) {
    console.error('[DB] Error actualizarEstadoPedidoDB:', e.message);
  }
}

export async function obtenerPedidosActivos() {
  try {
    const result = await pool.query(`
      SELECT datos FROM pedidos_activos
      WHERE estado != 'entregado'
      ORDER BY created_at ASC
    `);
    return result.rows.map(r => r.datos);
  } catch (e) {
    console.error('[DB] Error obtenerPedidosActivos:', e.message);
    return [];
  }
}

// Devuelve el número más alto de folio guardado (ej. 3 si el último es XAB-0003)
// Sirve para que el contador nunca repita un folio tras un reinicio
export async function obtenerMaxFolioNum() {
  try {
    const result = await pool.query(`
      SELECT COALESCE(MAX(CAST(REPLACE(folio, 'XAB-', '') AS INTEGER)), 0) AS max_num
      FROM pedidos_activos
    `);
    return result.rows[0]?.max_num || 0;
  } catch (e) {
    console.error('[DB] Error obtenerMaxFolioNum:', e.message);
    return 0;
  }
}

// Guarda el Clip payment_request_id en el pedido para reconciliación
export async function guardarLinkPago(folio, clipLinkId) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = datos || $2::jsonb, updated_at = NOW()
      WHERE folio = $1
    `, [folio, JSON.stringify({ clip_link_id: clipLinkId })]);
  } catch (e) {
    console.error('[DB] Error guardarLinkPago:', e.message);
  }
}

// Devuelve pedidos con pago pendiente que tienen un clip_link_id guardado
export async function obtenerPagosPendientesConLink() {
  try {
    const result = await pool.query(`
      SELECT folio, datos->>'clip_link_id' AS clip_link_id
      FROM pedidos_activos
      WHERE datos->>'forma_pago' = 'enlace de pago'
        AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        AND datos->>'clip_link_id' IS NOT NULL
        AND estado != 'entregado'
    `);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPagosPendientesConLink:', e.message);
    return [];
  }
}

export async function confirmarPagoPedido(folio) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = datos || '{"pago_confirmado": true}', updated_at = NOW()
      WHERE folio = $1
    `, [folio]);
  } catch (e) {
    console.error('[DB] Error confirmarPagoPedido:', e.message);
  }
}

export async function obtenerPedidoActivoPorFolio(folio) {
  try {
    const result = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio = $1 AND estado != 'entregado'`,
      [folio]
    );
    return result.rows[0]?.datos || null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoActivoPorFolio:', e.message);
    return null;
  }
}

// Busca en activos Y en programados — útil para enlace de pago anticipado
export async function obtenerPedidoPorFolioAmplio(folio) {
  try {
    // Primero en activos
    const activo = await pool.query(
      `SELECT datos, 'activo' AS origen FROM pedidos_activos WHERE folio = $1 AND estado != 'entregado'`,
      [folio]
    );
    if (activo.rows[0]) return { ...activo.rows[0].datos, _origen: 'activo' };

    // Si no, en programados
    const prog = await pool.query(
      `SELECT datos, programado_para FROM pedidos_programados WHERE folio = $1 AND activado = FALSE`,
      [folio]
    );
    if (prog.rows[0]) return { ...prog.rows[0].datos, _origen: 'programado', programado_para: prog.rows[0].programado_para };

    return null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoPorFolioAmplio:', e.message);
    return null;
  }
}

// Busca pedidos activos por número de teléfono del cliente
export async function obtenerPedidosActivosPorTelefono(telefono) {
  try {
    const result = await pool.query(
      `SELECT folio, estado, datos, created_at
       FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' = $1
         AND estado NOT IN ('entregado', 'cancelado')
       ORDER BY created_at DESC
       LIMIT 3`,
      [telefono]
    );
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPedidosActivosPorTelefono:', e.message);
    return [];
  }
}

export async function archivarPedidoActivo(folio) {
  try {
    await pool.query(`
      UPDATE pedidos_activos SET estado = 'entregado', updated_at = NOW()
      WHERE folio = $1
    `, [folio]);
  } catch (e) {
    console.error('[DB] Error archivarPedidoActivo:', e.message);
  }
}

export async function eliminarPedido(folio) {
  try {
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [folio]);
    await pool.query(`DELETE FROM pedidos WHERE folio = $1`, [folio]);
  } catch (e) {
    console.error('[DB] Error eliminarPedido:', e.message);
    throw e;
  }
}

// ─── Pedidos programados ──────────────────────────────────────────────────────
export async function guardarPedidoProgramado(folio, datos, programadoPara) {
  try {
    await pool.query(`
      INSERT INTO pedidos_programados (folio, datos, programado_para)
      VALUES ($1, $2, $3)
      ON CONFLICT (folio) DO NOTHING
    `, [folio, JSON.stringify(datos), programadoPara]);
  } catch (e) {
    console.error('[DB] Error guardarPedidoProgramado:', e.message);
  }
}

// Devuelve pedidos cuya hora de activación ya llegó (programado_para <= ahora + 1h) y no han sido activados
export async function obtenerPedidosPorActivar() {
  try {
    const result = await pool.query(`
      SELECT folio, datos, programado_para FROM pedidos_programados
      WHERE activado = FALSE
        AND programado_para <= NOW() + INTERVAL '1 hour'
      ORDER BY programado_para ASC
    `);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPedidosPorActivar:', e.message);
    return [];
  }
}

export async function marcarPedidoProgramadoActivado(folio) {
  try {
    await pool.query(`UPDATE pedidos_programados SET activado = TRUE WHERE folio = $1`, [folio]);
  } catch (e) {
    console.error('[DB] Error marcarPedidoProgramadoActivado:', e.message);
  }
}

export async function obtenerPedidosProgramadosPendientes() {
  try {
    const result = await pool.query(`
      SELECT folio, datos, programado_para FROM pedidos_programados
      WHERE activado = FALSE
      ORDER BY programado_para ASC
    `);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPedidosProgramadosPendientes:', e.message);
    return [];
  }
}

// Último pedido entregado de un teléfono — para generarle factura
export async function obtenerUltimoPedidoEntregadoPorTelefono(telefono) {
  try {
    const result = await pool.query(
      `SELECT folio, datos FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' = $1
         AND estado = 'entregado'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [telefono]
    );
    if (!result.rows[0]) return null;
    return { folio: result.rows[0].folio, ...result.rows[0].datos };
  } catch (e) {
    console.error('[DB] Error obtenerUltimoPedidoEntregadoPorTelefono:', e.message);
    return null;
  }
}

// ─── Transcripciones de voz ───────────────────────────────────────────────────
export async function guardarTranscripcionVoz(callSid, fromNum, rol, texto) {
  try {
    await pool.query(`
      INSERT INTO transcripciones_voz (call_sid, from_num, rol, texto)
      VALUES ($1, $2, $3, $4)
    `, [callSid, fromNum || null, rol, texto]);
  } catch (e) {
    console.error('[DB] Error guardarTranscripcionVoz:', e.message);
  }
}

export async function obtenerTranscripcionPorLlamada(callSid) {
  try {
    const result = await pool.query(`
      SELECT rol, texto, created_at FROM transcripciones_voz
      WHERE call_sid = $1
      ORDER BY created_at ASC
    `, [callSid]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerTranscripcionPorLlamada:', e.message);
    return [];
  }
}

export async function obtenerLlamadasRecientes(limite = 20) {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (call_sid)
        call_sid, from_num,
        MIN(created_at) OVER (PARTITION BY call_sid) AS inicio,
        MAX(created_at) OVER (PARTITION BY call_sid) AS fin,
        COUNT(*) OVER (PARTITION BY call_sid) AS num_mensajes
      FROM transcripciones_voz
      ORDER BY call_sid, created_at DESC
      LIMIT $1
    `, [limite]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerLlamadasRecientes:', e.message);
    return [];
  }
}

// ─── Prompt improvements ─────────────────────────────────────────────────────
export async function guardarSugerencias(semana, sugerencias) {
  try {
    const result = await pool.query(`
      INSERT INTO prompt_improvements (semana, sugerencias)
      VALUES ($1, $2) RETURNING id
    `, [semana, JSON.stringify(sugerencias)]);
    return result.rows[0].id;
  } catch (e) {
    console.error('[DB] Error guardarSugerencias:', e.message);
    return null;
  }
}

export async function obtenerSugerenciasPendientes() {
  try {
    const result = await pool.query(`
      SELECT * FROM prompt_improvements
      WHERE estado = 'pendiente'
      ORDER BY created_at DESC LIMIT 1
    `);
    return result.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerSugerenciasPendientes:', e.message);
    return null;
  }
}

export async function aprobarSugerencias(id, indices) {
  try {
    await pool.query(`
      UPDATE prompt_improvements
      SET estado = 'aprobado', aprobadas = $2, applied_at = NOW()
      WHERE id = $1
    `, [id, JSON.stringify(indices)]);
  } catch (e) {
    console.error('[DB] Error aprobarSugerencias:', e.message);
  }
}

export async function guardarOverride(seccion, contenido) {
  try {
    // Desactivar overrides anteriores de la misma sección
    await pool.query(`UPDATE prompt_overrides SET activo = FALSE WHERE seccion = $1`, [seccion]);
    await pool.query(`
      INSERT INTO prompt_overrides (seccion, contenido) VALUES ($1, $2)
    `, [seccion, contenido]);
  } catch (e) {
    console.error('[DB] Error guardarOverride:', e.message);
  }
}

export async function obtenerOverridesActivos() {
  try {
    const result = await pool.query(`
      SELECT seccion, contenido FROM prompt_overrides WHERE activo = TRUE
    `);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerOverridesActivos:', e.message);
    return [];
  }
}

export async function obtenerMensajesRango(desde, hasta) {
  try {
    const result = await pool.query(`
      SELECT telefono, nombre, direccion, texto, timestamp
      FROM mensajes
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY telefono, timestamp ASC
    `, [desde, hasta]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerMensajesRango:', e.message);
    return [];
  }
}

// ─── Obtener últimos pedidos de un cliente ────────────────────────────────────
export async function obtenerUltimosPedidos(telefono, limite = 3) {
  try {
    const result = await pool.query(`
      SELECT items, total, modalidad, created_at
      FROM pedidos
      WHERE telefono = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [telefono, limite]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerUltimosPedidos:', e.message);
    return [];
  }
}

// ─── Fondo de caja ────────────────────────────────────────────────────────────
// Guarda el fondo inicial del día (una sola vez por fecha MX)
// ─── Configuración del negocio ───────────────────────────────────────────────
export async function obtenerConfiguracion() {
  try {
    const result = await pool.query('SELECT clave, valor FROM configuracion');
    const config = {};
    result.rows.forEach(r => { config[r.clave] = r.valor; });
    return config;
  } catch (e) {
    console.error('[DB] Error obtenerConfiguracion:', e.message);
    return {};
  }
}

export async function actualizarConfiguracion(cambios) {
  try {
    for (const [clave, valor] of Object.entries(cambios)) {
      await pool.query(
        'INSERT INTO configuracion (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = $2',
        [clave, valor]
      );
    }
    return true;
  } catch (e) {
    console.error('[DB] Error actualizarConfiguracion:', e.message);
    return false;
  }
}

// ─── Repartidores ─────────────────────────────────────────────────────────────
// Normaliza teléfonos mexicanos a formato local 10 dígitos (sin prefijo 52/521)
function normalizarTelefono(tel) {
  tel = String(tel).replace(/\D/g, ''); // solo dígitos
  if (tel.startsWith('521') && tel.length === 13) return tel.slice(3); // 521XXXXXXXXXX → XXXXXXXXXX
  if (tel.startsWith('52') && tel.length === 12) return tel.slice(2);  // 52XXXXXXXXXX → XXXXXXXXXX
  return tel;
}

export async function registrarRepartidor(nombre, telefono) {
  const token = randomBytes(16).toString('hex');
  const telNorm = normalizarTelefono(telefono);
  try {
    const result = await pool.query(
      `INSERT INTO repartidores (nombre, telefono, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (telefono) DO UPDATE SET nombre = $1, activo = TRUE
       RETURNING *`,
      [nombre, telNorm, token]
    );
    return result.rows[0];
  } catch (e) {
    console.error('[DB] Error registrarRepartidor:', e.message);
    return null;
  }
}

export async function obtenerRepartidorPorToken(token) {
  try {
    const r = await pool.query('SELECT * FROM repartidores WHERE token = $1 AND activo = TRUE', [token]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

export async function obtenerRepartidorPorTelefono(telefono) {
  try {
    const telNorm = normalizarTelefono(telefono);
    const r = await pool.query('SELECT * FROM repartidores WHERE telefono = $1', [telNorm]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

export async function obtenerRepartidores() {
  try {
    const r = await pool.query(`
      SELECT r.*,
        COALESCE((
          SELECT COUNT(*) FROM pedidos_activos
          WHERE datos->>'repartidor_id' = r.id::text
            AND estado = 'entregado'
        ), 0)::int AS pedidos_entregados
      FROM repartidores r
      ORDER BY r.activo DESC, r.nombre ASC
    `);
    return r.rows;
  } catch (e) { return []; }
}

export async function guardarPushRepartidor(repartidorId, subscription) {
  try {
    await pool.query(
      `INSERT INTO push_subscriptions_repartidor (repartidor_id, endpoint, auth, p256dh)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET auth = $3, p256dh = $4`,
      [repartidorId, subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh]
    );
  } catch (e) { console.error('[DB] Error guardarPushRepartidor:', e.message); }
}

export async function obtenerPushRepartidores() {
  try {
    const r = await pool.query(
      `SELECT p.endpoint, p.auth, p.p256dh
       FROM push_subscriptions_repartidor p
       JOIN repartidores rep ON rep.id = p.repartidor_id
       WHERE rep.activo = TRUE`
    );
    return r.rows.map(r => ({ endpoint: r.endpoint, keys: { auth: r.auth, p256dh: r.p256dh } }));
  } catch (e) { return []; }
}

export async function asignarRepartidor(folio, repartidorId, nombreRepartidor) {
  try {
    // Asignación atómica — solo si aún no tiene repartidor
    const result = await pool.query(
      `UPDATE pedidos_activos
       SET datos = jsonb_set(jsonb_set(datos, '{repartidor_id}', $2::jsonb), '{repartidor_nombre}', $3::jsonb),
           updated_at = NOW()
       WHERE folio = $1
         AND (datos->>'repartidor_id') IS NULL
         AND estado NOT IN ('entregado','cancelado')
       RETURNING folio`,
      [folio, JSON.stringify(repartidorId), JSON.stringify(nombreRepartidor)]
    );
    return result.rows.length > 0; // true = asignado, false = ya lo tomó otro
  } catch (e) {
    console.error('[DB] Error asignarRepartidor:', e.message);
    return false;
  }
}

export async function obtenerPedidosParaRepartidor() {
  try {
    const r = await pool.query(
      `SELECT folio, datos, estado FROM pedidos_activos
       WHERE estado IN ('nuevo','en_preparacion','listo')
         AND datos->>'modalidad' = 'entrega a domicilio'
         AND (datos->>'repartidor_id') IS NULL
       ORDER BY created_at ASC`
    );
    return r.rows;
  } catch (e) { return []; }
}

export async function obtenerPedidosAsignadosARepartidor(repartidorId) {
  try {
    const r = await pool.query(
      `SELECT folio, datos, estado FROM pedidos_activos
       WHERE estado NOT IN ('entregado','cancelado')
         AND datos->>'modalidad' = 'entrega a domicilio'
         AND datos->>'repartidor_id' = $1
       ORDER BY created_at ASC`,
      [String(repartidorId)]
    );
    return r.rows;
  } catch (e) { return []; }
}

export async function eliminarRepartidor(id) {
  try {
    await pool.query('DELETE FROM repartidores WHERE id = $1', [id]);
    return true;
  } catch(e) { return false; }
}

export async function obtenerCandidatosRepartidor() {
  try {
    const r = await pool.query(`
      SELECT DISTINCT ON (telefono) telefono, nombre, texto, timestamp
      FROM mensajes
      WHERE LOWER(texto) LIKE '%repartidor%'
        AND direccion = 'entrante'
        AND timestamp > NOW() - INTERVAL '72 hours'
      ORDER BY telefono, timestamp DESC
    `);
    return r.rows;
  } catch(e) { return []; }
}

export async function guardarFondoCaja(fechaMX, monto) {
  try {
    await pool.query(`
      INSERT INTO caja_fondos (fecha, fondo)
      VALUES ($1, $2)
      ON CONFLICT (fecha) DO NOTHING
    `, [fechaMX, monto]);
    return true;
  } catch (e) {
    console.error('[DB] Error guardarFondoCaja:', e.message);
    return false;
  }
}

// Obtiene el fondo registrado para una fecha MX (formato 'YYYY-MM-DD')
export async function obtenerFondoCaja(fechaMX) {
  try {
    const result = await pool.query(
      `SELECT fondo, created_at FROM caja_fondos WHERE fecha = $1`,
      [fechaMX]
    );
    return result.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerFondoCaja:', e.message);
    return null;
  }
}
