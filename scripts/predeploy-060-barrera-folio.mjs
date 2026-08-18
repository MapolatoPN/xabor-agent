// Pre-Deploy Command de Railway para la 060 exclusivamente.
//
// La barrera que hace SEGURA la ventana de cutover y el rollback: ningun folio
// que ya pertenecio a un pedido puede volver a entrar a `pedidos_activos`,
// salvo que sea un programado sin activar.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '060_barrera_folio_historico.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const estado = async () => (await pool.query(
  `SELECT
     (SELECT COUNT(*) FROM pg_trigger
       WHERE tgname='trg_barrera_folio_historico' AND NOT tgisinternal)::int AS trg,
     (SELECT COUNT(*) FROM pg_proc WHERE proname='xabor_barrera_folio_historico')::int AS fn,
     (SELECT COUNT(*) FROM pg_indexes WHERE indexname='idx_pedidos_folio_barrera')::int AS idx`)).rows[0];

try {
  console.log('[predeploy-060] Aplicando migrations/060_barrera_folio_historico.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const e = await estado();
  if (e.trg !== 1) throw new Error('el trigger trg_barrera_folio_historico no quedo instalado');
  if (e.fn < 1) throw new Error('la funcion xabor_barrera_folio_historico no existe');
  if (e.idx !== 1) throw new Error('falta idx_pedidos_folio_barrera: la barrera haria seq scan por pedido');

  // Cuantos folios historicos quedan protegidos, y cuantos programados podrian
  // seguir activandose pese a la barrera.
  const { rows: [c] } = await pool.query(
    `SELECT (SELECT COUNT(DISTINCT folio)::int FROM pedidos WHERE folio ~ '^XAB-[0-9]+$') AS historicos,
            (SELECT COUNT(*)::int FROM pedidos_programados WHERE activado = FALSE) AS programados_pendientes`);
  console.log(`[predeploy-060] Folios historicos protegidos: ${c.historicos}`);
  console.log(`[predeploy-060] Programados sin activar (exentos de la barrera): ${c.programados_pendientes}`);
  console.log('[predeploy-060] Verificacion OK: la ventana de cutover y el rollback quedan cubiertos.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-060] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
