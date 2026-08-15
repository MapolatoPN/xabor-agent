// Pre-Deploy Command de Railway para la 053 exclusivamente.
//
// Aplica migrations/053_impresion_legacy_pendientes.sql: el estado que
// distingue "se emitió" de "alguien lo recibió". Sin él, un trabajo emitido
// mientras el agente estaba desconectado se perdía sin dejar rastro.
//
// Fail-closed: si tras migrar no están la columna `estado` CON su CHECK y el
// índice de pendientes, se aborta el deploy con exit 1.
//
// Idempotente: se comprueba antes y el SQL es re-ejecutable.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '053_impresion_legacy_pendientes.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Misma regla que los gates anteriores: comprobar TODO lo que la migración
// garantiza. El CHECK es parte de la garantía -- sin él, un estado escrito mal
// dejaría trabajos invisibles para la cola de reconexión.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'impresion_legacy_emitida'
           AND column_name IN ('estado', 'entregado_at'))::int AS columnas,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conname = 'chk_impresion_legacy_estado')::int AS chk,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'idx_impresion_legacy_pendiente')::int AS idx`);
  return { columnas: r.columnas === 2, chk: r.chk === 1, idx: r.idx === 1 };
}

async function yaAplicada() {
  const e = await estado();
  return e.columnas && e.chk && e.idx;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-053] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-053] Aplicando migrations/053_impresion_legacy_pendientes.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    if (!despues.columnas) throw new Error('faltan las columnas estado/entregado_at tras migrar');
    if (!despues.chk) {
      throw new Error(
        'falta el CHECK de estado -- un valor invalido dejaria trabajos invisibles ' +
        'para la cola de reconexion');
    }
    if (!despues.idx) throw new Error('falta idx_impresion_legacy_pendiente');
    console.log('[predeploy-053] Verificacion OK: columnas, CHECK e indice de pendientes.');
  }

  // El camino legacy solo existe mientras QUEDE un negocio en ese modo. Se
  // reporta para que cada deploy deje constancia de cuantos faltan por migrar
  // a Edge: cuando llegue a cero, la ruta "/" se cierra sola.
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM configuracion
      WHERE clave = 'print_agent_legacy_activo' AND valor = 'true'`);
  const { rows: [p] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_legacy_emitida WHERE estado = 'pendiente'`);
  console.log(`[predeploy-053] Negocios aun en modo legacy: ${c.n}. Trabajos pendientes de entregar: ${p.n}.`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-053] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
