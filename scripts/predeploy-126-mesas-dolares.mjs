// 126: dólares en Mesas. Va ANTES del binario nuevo porque el cobro de mesa
// en dólares escribe usd/tipo_cambio/pesos_mxn y metodo = 'dolares'.
// Aditiva: amplía un CHECK y agrega tres columnas vacías. Aborta si cambia un
// solo pago de mesa, cuenta o pedido.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const CONTEO = `SELECT
  (SELECT COUNT(*) FROM restaurante_cuenta_pagos)::int AS pagos,
  (SELECT COALESCE(SUM(monto),0) FROM restaurante_cuenta_pagos)::text AS suma_pagos,
  (SELECT COUNT(*) FROM restaurante_cuentas)::int AS cuentas,
  (SELECT COUNT(*) FROM pedidos_activos)::int AS pedidos`;
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-126-mesas-dolares',0))");
  const { rows: [antes] } = await db.query(CONTEO);
  await db.query(await readFile(new URL('../migrations/126_mesas_dolares.sql', import.meta.url), 'utf8'));
  const { rows: [despues] } = await db.query(CONTEO);
  if (JSON.stringify(antes) !== JSON.stringify(despues)) throw Error('La 126 alteró pagos, cuentas o pedidos: se revierte');
  await db.query('SELECT usd, tipo_cambio, pesos_mxn FROM restaurante_cuenta_pagos LIMIT 0');
  const { rows: [chk] } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'restaurante_cuenta_pagos'::regclass AND conname = 'restaurante_cuenta_pagos_metodo_check'`);
  if (!chk || !chk.def.includes("'dolares'")) throw Error('restaurante_cuenta_pagos no quedó aceptando dolares');
  const { rows: [usd] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM restaurante_cuenta_pagos WHERE metodo = 'dolares'`);
  await db.query('COMMIT');
  console.log(`[predeploy-126] Dólares en Mesas: columnas listas; pagos de mesa en dólares registrados: ${usd.n}.`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
