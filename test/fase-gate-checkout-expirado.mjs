import assert from 'node:assert/strict';
import { pool } from '../src/services/database.js';
import { checkoutsSinPedidoOperativo } from '../scripts/checkoutOperativo.mjs';
const url = new URL(process.env.DATABASE_URL);
assert(['localhost','127.0.0.1'].includes(url.hostname) && /^\/test_botones_/.test(url.pathname));
assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/);
const db = await pool.connect();
try {
  await db.query('BEGIN');
  // Las tablas temporales aíslan la consulta exacta del gate; no se crea una venta.
  await db.query(`CREATE TEMP TABLE tienda_pedidos (negocio_id text,pedido_folio text,created_at timestamptz DEFAULT now());
    CREATE TEMP TABLE pedidos_activos (negocio_id text,folio text);
    CREATE TEMP TABLE pedidos_programados (negocio_id text,folio text,programado_id text,activado boolean,datos jsonb);
    CREATE TEMP TABLE pagos (negocio_id text,pedido_folio text,estado text);`);
  await db.query(`INSERT INTO tienda_pedidos(negocio_id,pedido_folio) VALUES
    ('propio','activo'),('propio','perdido'),('propio','expirado'),('propio','pagado'),
    ('propio','sin-marca'),('propio','sin-identidad'),('propio','sin-cerrar'),('propio','otro-negocio');
    INSERT INTO pedidos_activos VALUES ('propio','activo');
    INSERT INTO pedidos_programados VALUES
    ('propio','expirado','identidad',true,'{"estado":"cancelado","expirado_por_pago":true}'),
    ('propio','pagado','identidad',true,'{"estado":"cancelado","expirado_por_pago":true}'),
    ('propio','sin-marca','identidad',true,'{"estado":"cancelado"}'),
    ('propio','sin-identidad',null,true,'{"estado":"cancelado","expirado_por_pago":true}'),
    ('propio','sin-cerrar','identidad',false,'{"estado":"cancelado","expirado_por_pago":true}'),
    ('ajeno','otro-negocio','identidad',true,'{"estado":"cancelado","expirado_por_pago":true}');
    INSERT INTO pagos VALUES ('propio','pagado','pagado');`);
  const faltantes = (await checkoutsSinPedidoOperativo(db, 'propio')).map(r => r.pedido_folio).sort();
  assert.deepEqual(faltantes, ['otro-negocio','pagado','perdido','sin-cerrar','sin-identidad','sin-marca']);
  console.log('OK gate: acepta activo y reserva durable cerrada por vencimiento sin pago.');
  console.log('OK gate: bloquea perdido, pago recibido, cierre incompleto y evidencia de otro negocio.');
  await db.query("INSERT INTO pagos VALUES ('propio','expirado','pagado')");
  assert((await checkoutsSinPedidoOperativo(db, 'propio')).some(r => r.pedido_folio === 'expirado'));
  console.log('OK gate: un pago posterior vuelve a bloquear la reserva; no oculta pedidos pagados.');
} finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
