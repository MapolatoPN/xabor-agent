// Pre-Deploy Command de Railway para la 082 (cobro de Restaurante:
// descuento de cuenta, efectivo recibido y cambio, reimpresiones del ticket).
//
// Aplica migrations/082_restaurante_cobro.sql bajo un advisory lock y
// verifica que ni las cuentas, ni los pagos, ni las ventas cambiaron de
// número ni de importe: la migración solo AÑADE columnas con default.
// Fail-closed: cualquier diferencia aborta con ROLLBACK.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const COLUMNAS = ['descuento_tipo', 'descuento_valor', 'descuento_monto', 'descuento_motivo', 'descuento_por', 'descuento_at', 'ticket_impresiones'];
const aplicada = async () => (await db.query(
  `SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'restaurante_cuentas' AND column_name = ANY($1::text[])`, [COLUMNAS])).rows[0].n === COLUMNAS.length
  && (await db.query(
  `SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'restaurante_cuenta_pagos' AND column_name IN ('recibido','cambio')`)).rows[0].n === 2;

const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM restaurante_cuentas)::int AS cuentas,
          (SELECT count(*) FROM restaurante_cuenta_pagos)::int AS pagos,
          (SELECT COALESCE(sum(monto), 0)::text FROM restaurante_cuenta_pagos) AS monto_pagos,
          (SELECT COALESCE(sum(propina), 0)::text FROM restaurante_cuenta_pagos) AS propinas,
          (SELECT count(*) FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa')::int AS ventas_mesa,
          (SELECT COALESCE(sum((datos->>'total')::numeric), 0)::text FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa' AND estado <> 'cancelado') AS total_ventas_mesa`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('082-restaurante-cobro',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/082_restaurante_cobro.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('faltan columnas de la 082 tras aplicarla');
  const despues = await foto();
  for (const k of Object.keys(antes)) {
    if (String(antes[k]) !== String(despues[k])) throw new Error(`la 082 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
  }
  const { rows: [d] } = await db.query(
    `SELECT count(*) FILTER (WHERE descuento_monto > 0)::int AS con_descuento, count(*)::int AS cuentas FROM restaurante_cuentas`);
  await db.query('COMMIT');
  console.log(`[predeploy-082] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. Cuentas, pagos y ventas de mesa intactos (${despues.cuentas} cuentas, ${despues.pagos} pagos por $${despues.monto_pagos}, ${despues.ventas_mesa} ventas de mesa por $${despues.total_ventas_mesa}).`);
  console.log(`[predeploy-082] cuentas con descuento: ${d.con_descuento} de ${d.cuentas}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-082] FALLO:', e.message);
} finally { await db.end(); }
