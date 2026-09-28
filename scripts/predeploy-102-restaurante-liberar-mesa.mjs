// Pre-Deploy Command de Railway para la 102 (liberar una mesa sin consumo).
//
// Aplica migrations/102_restaurante_liberar_mesa.sql bajo un advisory lock y
// verifica que ni las cuentas (por estado), ni los pagos, ni las ventas de
// mesa cambiaron: la migración solo AÑADE dos columnas nullables y un CHECK
// sobre una de ellas. Fail-closed: cualquier diferencia aborta.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const aplicada = async () => (await db.query(
  `SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'restaurante_cuentas' AND column_name IN ('liberada_motivo_codigo','liberada_motivo')`)).rows[0].n === 2;

const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM restaurante_cuentas)::int AS cuentas,
          (SELECT count(*) FROM restaurante_cuentas WHERE estado = 'abierta')::int AS abiertas,
          (SELECT count(*) FROM restaurante_cuentas WHERE estado = 'cerrada')::int AS cerradas,
          (SELECT count(*) FROM restaurante_cuentas WHERE estado = 'cancelada')::int AS canceladas,
          (SELECT count(*) FROM restaurante_cuenta_pagos)::int AS pagos,
          (SELECT COALESCE(sum(monto), 0)::text FROM restaurante_cuenta_pagos) AS monto_pagos,
          (SELECT count(*) FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa')::int AS ventas_mesa,
          (SELECT COALESCE(sum((datos->>'total')::numeric), 0)::text FROM pedidos_activos WHERE datos->>'canal' = 'restaurante_mesa' AND estado <> 'cancelado') AS total_ventas_mesa`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('102-restaurante-liberar-mesa',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/102_restaurante_liberar_mesa.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('faltan columnas tras aplicar la 102');
  const despues = await foto();
  for (const k of Object.keys(antes)) {
    if (String(antes[k]) !== String(despues[k])) throw new Error(`la 102 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
  }
  await db.query('COMMIT');
  console.log(`[predeploy-102] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. Cuentas, pagos y ventas de mesa intactos (${despues.cuentas} cuentas: ${despues.abiertas} abiertas, ${despues.cerradas} cerradas, ${despues.canceladas} canceladas).`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-102] FALLO:', e.message);
} finally { await db.end(); }
