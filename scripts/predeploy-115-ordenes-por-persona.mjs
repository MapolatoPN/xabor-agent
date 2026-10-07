// Ejecutar explícitamente antes de servir esta versión. No activa la función.
import { readFileSync } from 'node:fs';
import pkg from 'pg';
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(readFileSync(new URL('../migrations/115_ordenes_por_persona.sql', import.meta.url), 'utf8'));
  const { rows } = await pool.query(`SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='restaurante_cuenta_items' AND column_name='persona'`);
  if (rows[0]?.data_type !== 'jsonb' || rows[0]?.is_nullable !== 'YES') throw new Error('No se creó persona JSONB nullable');
  console.log('[predeploy-115] OK: persona JSONB nullable; activación independiente por negocio.');
} catch (e) {
  console.error('[predeploy-115]', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
