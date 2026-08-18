// Pre-Deploy Command de Railway para la 062 exclusivamente.
//
// La transicion atomica pedido-activo -> reserva-programada, y su equivalente
// en la base para que el binario VIEJO --que no conoce el helper-- tampoco deje
// programados inactivables durante la ventana de cutover.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '062_conversion_reserva_programada.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('[predeploy-062] Aplicando migrations/062_conversion_reserva_programada.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM pg_proc WHERE proname='xabor_convertir_a_reserva_programada')::int AS fn,
       (SELECT COUNT(*) FROM pg_trigger
         WHERE tgname='trg_reserva_al_retirar_activo' AND NOT tgisinternal)::int AS trg`);
  if (e.fn < 1) throw new Error('la funcion de conversion no quedo creada');
  if (e.trg !== 1) throw new Error('el trigger de conversion al retirar del tablero no quedo instalado');

  // LA GARANTIA: ningun programado pendiente puede quedarse con su claim en
  // 'usado', porque eso significa que nunca podra activarse.
  const { rows: [huerf] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pedidos_programados p
       JOIN folios_pedido_usados f ON f.folio = p.folio
      WHERE p.activado = FALSE AND f.estado = 'usado'`);
  if (huerf.n > 0) {
    throw new Error(
      `${huerf.n} pedido(s) programado(s) pendientes con el claim en 'usado': no podrian activarse`);
  }

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS reservas FROM folios_pedido_usados WHERE estado='reserva_programado'`);
  console.log(`[predeploy-062] Reservas de programados en el ledger: ${c.reservas}`);
  console.log('[predeploy-062] Verificacion OK: ningun programado pendiente queda inactivable.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-062] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
