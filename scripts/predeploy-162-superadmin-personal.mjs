// Aditiva: añade un permiso apagado por omisión. Nunca concede superadmin,
// membresías ni acceso a Empleados a una cuenta existente.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const estado = async () => (await db.query(`SELECT data_type, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema='public'
    AND table_name='administradores_plataforma' AND column_name='personal_en_negocios_propios'`)).rows[0];
const validar = (r) => {
  if (r?.data_type !== 'boolean' || r.is_nullable !== 'NO' || r.column_default !== 'false') {
    throw Error('El permiso de Personal no tiene el tipo y valor predeterminado seguros');
  }
};
try {
  await db.connect();
  const existente = await estado();
  if (existente) validar(existente);
  else {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-162-superadmin-personal',0))");
    await db.query(await readFile(new URL('../migrations/162_superadmin_personal_propio.sql', import.meta.url), 'utf8'));
    validar(await estado());
    await db.query('COMMIT');
  }
  console.log('[predeploy-162] Permiso explícito de Personal listo; no se modificaron accesos.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally { await db.end().catch(() => {}); }
