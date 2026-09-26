// Predeploy 097: formas de cobro configurables del mostrador (POS y Mesas).
// Crea la tabla y siembra las cuatro formas de hoy (Rappi, Transferencia,
// Uber Eats y DiDi Food inactivas) en cada negocio que aún no tenga ninguna.
// Corre en cada despliegue: un negocio con su lista nunca se toca, y uno
// creado desde el despliegue anterior recibe la siembra. No toca pedidos,
// cortes ni la tabla del bot (metodos_pago).
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-097-formas-cobro',0))");
  await db.query(await readFile(new URL('../migrations/097_formas_cobro.sql', import.meta.url), 'utf8'));
  await db.query(`SELECT id, negocio_id, clave, nombre, tarjeta_caja, clave_sat, en_pos, en_mesas,
                         activo, orden, creado_por, created_at, updated_at
                    FROM formas_cobro LIMIT 0`);
  const { rows: [idx] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname='public' AND indexname IN ('uq_formas_cobro_clave', 'uq_formas_cobro_nombre')`);
  exigir(Number(idx.n) === 2, 'falta la unicidad por clave o por nombre');
  const { rows: [chk] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'formas_cobro'::regclass
        AND conname IN ('formas_cobro_clave_check','formas_cobro_nombre_check',
                        'formas_cobro_tarjeta_check','formas_cobro_sat_check')`);
  exigir(Number(chk.n) === 4, 'faltan CHECK de formas_cobro');
  // Ningún negocio se queda sin lista.
  const { rows: faltan } = await db.query(
    `SELECT n.id FROM negocios n
      WHERE NOT EXISTS (SELECT 1 FROM formas_cobro f WHERE f.negocio_id = n.id)`);
  exigir(faltan.length === 0, `${faltan.length} negocio(s) sin formas de cobro sembradas`);
  await db.query('COMMIT');
  const { rows: [t] } = await db.query('SELECT count(*)::int AS n FROM formas_cobro');
  console.log(`[predeploy-097] Formas de cobro verificadas (${t.n} renglones).`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[predeploy-097] FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
