// 145: límites de intentos y sesiones cerradas en la base (Fase 1, bloque 2).
// Va ANTES del binario nuevo: el login, los PIN, el segundo factor, Temporada,
// la tienda y el cierre de sesión leen y escriben limites_acceso y
// sesiones_revocadas.
//
// Aditiva y fail-closed:
//   - "Ya aplicada" solo si están las dos tablas con sus columnas y los tres
//     índices: entonces no pide ningún candado.
//   - Si falta algo, aplica el SQL en una transacción y lo vuelve a verificar;
//     si no quedó completo, revierte.
//   - Las dos tablas son nuevas: no hay filas existentes que proteger.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['limites_acceso', 'id', 'bigint', 'NO'],
  ['limites_acceso', 'clave', 'text', 'NO'],
  ['limites_acceso', 'creado_at', 'timestamp with time zone', 'NO'],
  ['limites_acceso', 'vence_at', 'timestamp with time zone', 'NO'],
  ['sesiones_revocadas', 'huella', 'text', 'NO'],
  ['sesiones_revocadas', 'vence_at', 'timestamp with time zone', 'NO'],
  ['sesiones_revocadas', 'creado_at', 'timestamp with time zone', 'NO'],
];
const INDICES = ['limites_acceso_clave_idx', 'limites_acceso_vence_idx', 'sesiones_revocadas_vence_idx'];

async function faltantes() {
  const faltan = [];
  for (const [tabla, columna, tipo, nulo] of COLUMNAS) {
    const { rows: [c] } = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [tabla, columna]);
    if (!c) faltan.push(`${tabla}.${columna}`);
    else if (c.data_type !== tipo || c.is_nullable !== nulo) faltan.push(`${tabla}.${columna} con otro tipo`);
  }
  for (const i of INDICES) {
    const { rows: [r] } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS hay`, [`public.${i}`]);
    if (!r.hay) faltan.push(`índice ${i}`);
  }
  const { rows: [pk] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relname IN ('limites_acceso', 'sesiones_revocadas') AND c.contype = 'p'`);
  if (pk.n !== 2) faltan.push('llave primaria');
  return faltan;
}

try {
  await db.connect();
  const antes = await faltantes();
  if (!antes.length) {
    console.log('[predeploy-145] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-145] Falta: ${antes.join(', ')}. Se aplica.`);
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-145-limites-y-sesiones',0))");
    await db.query(await readFile(new URL('../migrations/145_limites_y_sesiones.sql', import.meta.url), 'utf8'));
    const despues = await faltantes();
    if (despues.length) throw Error(`La 145 no quedó completa (${despues.join(', ')}): se revierte`);
    await db.query('COMMIT');
    console.log('[predeploy-145] Límites de intentos y sesiones cerradas en la base: dos tablas nuevas y vacías.');
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
