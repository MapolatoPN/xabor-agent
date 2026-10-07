// 116: segundo factor de Superadmin e IP en la bitácora de plataforma. Va
// ANTES del binario nuevo: requireSuperadmin lee superadmin_totp y
// registrarAuditoriaPlataforma escribe la columna ip. Aditiva: una tabla
// vacía y una columna nullable. Aborta si la 116 cambia un solo superadmin o
// una fila de la bitácora.
//
// Mismo patrón que la 113: REPEATABLE READ (una sola foto para los dos
// conteos aunque el binario viejo siga escribiendo en la bitácora),
// lock_timeout corto (el ALTER de auditoria_plataforma pide ACCESS EXCLUSIVE;
// si no lo obtiene en 3 s se aborta y se reintenta, nunca hace fila delante
// de las escrituras vivas) y candado consultivo.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const CONTEO = `SELECT
  (SELECT COUNT(*) FROM administradores_plataforma)::int AS superadmins,
  (SELECT COUNT(*) FROM administradores_plataforma WHERE activo)::int AS superadmins_activos,
  (SELECT COUNT(*) FROM auditoria_plataforma)::int AS bitacora`;
try {
  await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-116-superadmin-2fa',0))");
  const { rows: [antes] } = await db.query(CONTEO);
  await db.query(await readFile(new URL('../migrations/116_superadmin_2fa.sql', import.meta.url), 'utf8'));
  const { rows: [despues] } = await db.query(CONTEO);
  if (JSON.stringify(antes) !== JSON.stringify(despues)) throw Error('La 116 alteró superadmins o la bitácora: se revierte');
  const { rows: [t] } = await db.query(`SELECT to_regclass('public.superadmin_totp') IS NOT NULL AS tabla,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='auditoria_plataforma' AND column_name='ip') AS ip`);
  if (!t.tabla || !t.ip) throw Error('superadmin_totp o auditoria_plataforma.ip no quedaron creadas');
  await db.query('COMMIT');
  console.log(`[predeploy-116] Segundo factor de Superadmin listo; ${antes.superadmins_activos} superadmins activos y ${antes.bitacora} filas de bitácora intactas.`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
