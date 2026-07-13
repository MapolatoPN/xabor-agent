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
