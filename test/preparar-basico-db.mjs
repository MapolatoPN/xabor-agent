// Solo una base LOCAL y desechable. No admite URLs de Railway ni datos reales.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const url = new URL(process.env.DATABASE_URL);
assert(['localhost','127.0.0.1','::1'].includes(url.hostname), 'Se exige PostgreSQL local');
assert.match(url.pathname, /^\/test_basico_[a-z0-9_]+$/);
assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/);
const { aplicarMigraciones } = await import('./aplicar-migraciones.mjs');
const { pool } = await import('../src/services/database.js');
try {
  const {rows:[r]} = await pool.query("SELECT to_regclass('public.negocios') AS tabla");
  assert.equal(r.tabla,null,'La preparación exige una base vacía, no reaplica migraciones antiguas');
  await aplicarMigraciones();
  const dir = new URL('../migrations/', import.meta.url);
  const archivos = readdirSync(dir).filter(f => /^\d{3}_/.test(f) &&
    Number(f.slice(0,3)) > 50 && !/_(down|check|seed)(_|\.)/.test(f)).sort();
  for (const f of archivos) {
    await pool.query(readFileSync(new URL(f,dir),'utf8'));
    console.log('OK  '+f);
  }
} finally { await pool.end(); }
