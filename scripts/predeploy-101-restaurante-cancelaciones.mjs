// Pre-Deploy Command de Railway para la 101 (quitar o cambiar platillos con
// autorización).
//
// Aplica migrations/101_restaurante_cancelaciones_autorizadas.sql bajo un
// advisory lock y verifica que ni los renglones de las cuentas, ni los pagos,
// ni las ventas de mesa cambiaron de número ni de importe: la migración solo
// AÑADE columnas nullables, un CHECK sobre una columna nueva y una tabla
// vacía. Fail-closed: cualquier diferencia aborta.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const aplicada = async () => (await db.query(
  `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'restaurante_cuenta_items'
            AND column_name IN ('autorizado_por','motivo_codigo','reemplaza_item_id'))::int
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'pin_autorizacion_hash')::int
        + (SELECT count(*) FROM information_schema.tables WHERE table_name = 'restaurante_item_eventos')::int AS n`)).rows[0].n === 5;

const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM restaurante_cuenta_items)::int AS items,
          (SELECT count(*) FROM restaurante_cuenta_items WHERE estado = 'cancelado')::int AS items_cancelados,
          (SELECT COALESCE(sum(cantidad * precio_unitario), 0)::text FROM restaurante_cuenta_items WHERE estado <> 'cancelado') AS importe_items,
          (SELECT count(*) FROM restaurante_cuenta_pagos)::int AS pagos,
          (SELECT COALESCE(sum(monto), 0)::text FROM restaurante_cuenta_pagos) AS monto_pagos,
          (SELECT count(*) FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa')::int AS ventas_mesa,
          (SELECT COALESCE(sum((datos->>'total')::numeric), 0)::text FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa' AND estado <> 'cancelado') AS total_ventas_mesa,
          (SELECT count(*) FROM usuarios WHERE pin_hash IS NOT NULL)::int AS pines_mesero`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('101-restaurante-cancelaciones',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/101_restaurante_cancelaciones_autorizadas.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('faltan columnas o la bitácora tras aplicar la 101');
  const despues = await foto();
  for (const k of Object.keys(antes)) {
    if (String(antes[k]) !== String(despues[k])) throw new Error(`la 101 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
  }
  // El CHECK de motivo_codigo no puede rechazar filas viejas: todas nacen NULL.
  const { rows: [c] } = await db.query(
    `SELECT (SELECT count(*) FROM restaurante_cuenta_items WHERE motivo_codigo IS NOT NULL)::int AS con_codigo,
            (SELECT count(*) FROM restaurante_item_eventos)::int AS eventos`);
  await db.query('COMMIT');
  console.log(`[predeploy-101] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. Renglones, pagos y ventas de mesa intactos (${despues.items} renglones, ${despues.pagos} pagos por $${despues.monto_pagos}, ${despues.ventas_mesa} ventas de mesa por $${despues.total_ventas_mesa}).`);
  console.log(`[predeploy-101] renglones con motivo por código: ${c.con_codigo} · eventos en bitácora: ${c.eventos}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-101] FALLO:', e.message);
} finally { await db.end(); }
