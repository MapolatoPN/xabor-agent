// Pre-Deploy Command de Railway para la 052 exclusivamente.
//
// Aplica migrations/052_impresion_legacy_idempotente.sql: la tabla que recuerda
// qué comandas ya salieron por el camino legacy. Sin ella, emitirTrabajoImpresion
// no puede deduplicar nada y cualquier reintento saca papel otra vez.
//
// Fail-closed: si la migración corre y la verificación posterior no ve la tabla
// CON su llave primaria compuesta, se aborta el deploy con exit 1. La llave es
// parte de la garantía, no un detalle: es lo que hace atómico el "reclamar"
// desde varios procesos a la vez.
//
// Idempotente: se comprueba antes y el SQL es re-ejecutable (CREATE TABLE /
// CREATE INDEX IF NOT EXISTS).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '052_impresion_legacy_idempotente.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Misma regla que el gate de la 051: comprueba TODO lo que la migración
// garantiza. Un gate que solo mira "existe la tabla" dejaría pasar una base
// donde la PK compuesta se perdió, y ahí la deduplicación sería una carrera.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'impresion_legacy_emitida')::int AS tabla,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = to_regclass('public.impresion_legacy_emitida')
           AND contype = 'p'
           AND pg_get_constraintdef(oid) LIKE '%negocio_id%print_job_id%')::int AS pk,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'idx_impresion_legacy_emitida_fecha')::int AS idx`);
  return { tabla: r.tabla === 1, pk: r.pk === 1, idx: r.idx === 1 };
}

async function yaAplicada() {
  const e = await estado();
  return e.tabla && e.pk && e.idx;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-052] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-052] Aplicando migrations/052_impresion_legacy_idempotente.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    if (!despues.tabla) {
      throw new Error('falta la tabla impresion_legacy_emitida tras migrar');
    }
    if (!despues.pk) {
      throw new Error(
        'impresion_legacy_emitida no tiene PK (negocio_id, print_job_id) -- ' +
        'sin ella, dos procesos podrian reclamar el mismo trabajo a la vez');
    }
    if (!despues.idx) {
      throw new Error('falta idx_impresion_legacy_emitida_fecha');
    }
    console.log('[predeploy-052] Verificacion OK: tabla, PK compuesta e indice por fecha.');
  }

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_legacy_emitida`);
  console.log(`[predeploy-052] Trabajos legacy ya registrados: ${c.n}`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-052] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
