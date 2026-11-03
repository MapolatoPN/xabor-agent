// 125: dólares en el mostrador. Va ANTES del binario nuevo porque el cobro en
// dólares y Configuración › Pagos leen y escriben dolares_tipo_cambio. Sin
// renglones ningún negocio acepta dólares: desplegar no enciende nada.
// Aditiva: una tabla vacía y la clave 'dolares' reservada en formas_cobro.
// Aborta si cambia una sola forma de cobro, pedido o corte.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const CONTEO = `SELECT
  (SELECT COUNT(*) FROM formas_cobro)::int AS formas,
  (SELECT COUNT(*) FROM pedidos_activos)::int AS pedidos,
  (SELECT COUNT(*) FROM cortes_caja)::int AS cortes`;
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-125-pos-dolares',0))");
  const { rows: [antes] } = await db.query(CONTEO);
  await db.query(await readFile(new URL('../migrations/125_pos_dolares.sql', import.meta.url), 'utf8'));
  const { rows: [despues] } = await db.query(CONTEO);
  if (JSON.stringify(antes) !== JSON.stringify(despues)) throw Error('La 125 alteró formas de cobro, pedidos o cortes: se revierte');
  await db.query('SELECT negocio_id, activo, tipo_cambio, usuario_id, created_at FROM dolares_tipo_cambio LIMIT 0');
  const { rows: [chk] } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'formas_cobro'::regclass AND conname = 'formas_cobro_clave_check'`);
  if (!chk || !chk.def.includes("'dolares'")) throw Error('formas_cobro no quedó con la clave dolares reservada');
  // El estado real, no un texto fijo: este script corre en cada despliegue.
  const { rows: [usd] } = await db.query(
    `SELECT COUNT(*)::int AS activos FROM (
       SELECT DISTINCT ON (negocio_id) activo FROM dolares_tipo_cambio
        ORDER BY negocio_id, created_at DESC, id DESC) u WHERE activo`);
  await db.query('COMMIT'); console.log(`[predeploy-125] Dólares del mostrador: bitácora lista; negocios que aceptan dólares: ${usd.activos}.`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
