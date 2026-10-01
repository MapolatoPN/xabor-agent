// 112: bitácora de correcciones de caja. Va ANTES del binario nuevo porque
// corregir el fondo o un movimiento escribe aquí en la misma transacción.
// Aditiva: una tabla vacía. Aborta si cambia una sola fila de caja.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const CONTEO = `SELECT
  (SELECT COUNT(*) FROM caja_fondos)::int AS fondos,
  (SELECT COALESCE(SUM(fondo),0) FROM caja_fondos)::text AS suma_fondos,
  (SELECT COUNT(*) FROM movimientos_caja)::int AS movimientos,
  (SELECT COALESCE(SUM(monto),0) FROM movimientos_caja)::text AS suma_movimientos,
  (SELECT COUNT(*) FROM cortes_caja)::int AS cortes`;
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-112-caja-correcciones',0))");
  const { rows: [antes] } = await db.query(CONTEO);
  await db.query(await readFile(new URL('../migrations/112_caja_correcciones.sql', import.meta.url), 'utf8'));
  const { rows: [despues] } = await db.query(CONTEO);
  if (JSON.stringify(antes) !== JSON.stringify(despues)) throw Error('La 112 alteró datos de caja: se revierte');
  const { rows: [t] } = await db.query(`SELECT to_regclass('public.caja_correcciones') IS NOT NULL AS ok`);
  if (!t.ok) throw Error('caja_correcciones no quedó creada');
  await db.query('COMMIT'); console.log('[predeploy-112] Bitácora de correcciones de caja lista; ningún dato de caja cambió.');
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
