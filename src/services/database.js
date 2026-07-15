import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
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
      id          SERIAL PRIMARY KEY,
      telefono    VARCHAR(20) REFERENCES clientes(telefono),
      items       JSONB,
      total       DECIMAL(10,2),
      modalidad   VARCHAR(50),
      canal       VARCHAR(20),
      created_at  TIMESTAMP DEFAULT NOW()
    );

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
  `);
  console.log('[DB] Tablas listas');
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

// ─── Guardar pedido ───────────────────────────────────────────────────────────
export async function guardarPedido(telefono, pedido) {
  try {
    await pool.query(`
      INSERT INTO pedidos (telefono, items, total, modalidad, canal)
      VALUES ($1, $2, $3, $4, $5)
    `, [telefono, JSON.stringify(pedido.items), pedido.total, pedido.modalidad, pedido.canal]);
  } catch (e) {
    console.error('[DB] Error guardarPedido:', e.message);
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

export async function obtenerConversacion(telefono, limite = 50) {
  try {
    const result = await pool.query(`
      SELECT * FROM mensajes WHERE telefono = $1
      ORDER BY timestamp ASC LIMIT $2
    `, [telefono, limite]);
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
