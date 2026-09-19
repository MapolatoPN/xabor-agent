// Pre-Deploy Command de Railway para la 083 (división de cuenta por consumo).
//
// Aplica migrations/083_restaurante_division_consumo.sql bajo un advisory
// lock y verifica que ni las cuentas, ni los pagos, ni las ventas de mesa
// cambiaron de número ni de importe: la migración solo AÑADE columnas con
// default y una tabla vacía. Fail-closed: cualquier diferencia aborta.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const aplicada = async () => (await db.query(
  `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'restaurante_cuenta_pagos'
            AND column_name IN ('cobro_id','tipo_cobro','revertido_at','revertido_por','motivo_reverso'))::int
        + (SELECT count(*) FROM information_schema.tables WHERE table_name = 'restaurante_cuenta_porciones')::int
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'restaurante_cuentas' AND column_name = 'division_remanente')::int AS n`)).rows[0].n === 7;

const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM restaurante_cuentas)::int AS cuentas,
          (SELECT count(*) FROM restaurante_cuenta_pagos)::int AS pagos,
          (SELECT COALESCE(sum(monto), 0)::text FROM restaurante_cuenta_pagos) AS monto_pagos,
          (SELECT count(*) FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa')::int AS ventas_mesa,
          (SELECT COALESCE(sum((datos->>'total')::numeric), 0)::text FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa' AND estado <> 'cancelado') AS total_ventas_mesa`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('083-restaurante-division-consumo',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/083_restaurante_division_consumo.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('faltan columnas o la tabla de porciones tras aplicar la 083');
  const despues = await foto();
  for (const k of Object.keys(antes)) {
    if (String(antes[k]) !== String(despues[k])) throw new Error(`la 083 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
  }
  const { rows: [p] } = await db.query(
    `SELECT (SELECT count(*) FROM restaurante_cuenta_porciones)::int AS porciones,
            (SELECT count(*) FROM restaurante_cuenta_pagos WHERE tipo_cobro <> 'abono')::int AS pagos_no_abono`);
  await db.query('COMMIT');
  console.log(`[predeploy-083] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. Cuentas, pagos y ventas de mesa intactos (${despues.cuentas} cuentas, ${despues.pagos} pagos por $${despues.monto_pagos}, ${despues.ventas_mesa} ventas de mesa por $${despues.total_ventas_mesa}).`);
  console.log(`[predeploy-083] porciones: ${p.porciones} · pagos de consumo/partes: ${p.pagos_no_abono}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-083] FALLO:', e.message);
} finally { await db.end(); }
