// Script temporal para correr la migración desde Node.js
// Uso: node migrations/run.js
import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '001_memory_engine.sql'), 'utf8');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  await pool.query(sql);
  console.log('✅ Migración completada exitosamente');
} catch (e) {
  console.error('❌ Error en migración:', e.message);
} finally {
  await pool.end();
}
