// Pre-Deploy Command de Railway para la 062 exclusivamente.
//
// La transicion atomica pedido-activo -> reserva-programada, con el filtro por
// origen (P0-15D: solo se convierte un claim 'usado' con origen='pedido_activo',
// nunca uno historico) y en una sola funcion de punta a punta (P0-15E).
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
       (SELECT COUNT(*) FROM pg_proc WHERE proname='xabor_activo_a_programado')::int AS fn_transicion,
       (SELECT COUNT(*) FROM pg_proc WHERE proname='xabor_convertir_claim_a_reserva')::int AS fn_nucleo,
       (SELECT COUNT(*) FROM pg_trigger
         WHERE tgname='trg_reserva_al_retirar_activo' AND NOT tgisinternal)::int AS trg`);
  if (e.fn_transicion < 1) throw new Error('xabor_activo_a_programado no quedo creada');
  if (e.fn_nucleo < 1) throw new Error('xabor_convertir_claim_a_reserva no quedo creada');
  if (e.trg !== 1) throw new Error('el trigger de conversion al retirar del tablero no quedo instalado');

  // LA GARANTIA (P0-15C): ningun programado pendiente puede quedarse con su
  // claim en 'usado' -- eso significa que nunca podria activarse.
  const { rows: [huerf] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pedidos_programados p
       JOIN folios_pedido_usados f ON f.folio = p.folio
      WHERE p.activado = FALSE AND f.estado = 'usado'`);

  // LOS AMBIGUOS (P0-15D): programados cuyo folio nunca puede demostrar
  // pertenencia -- fail closed a proposito, requieren reemision manual.
  const { rows: ambiguos } = await pool.query(
    `SELECT p.folio, f.estado, f.origen FROM pedidos_programados p
       LEFT JOIN folios_pedido_usados f ON f.folio = p.folio
      WHERE p.activado = FALSE
        AND (f.folio IS NULL
             OR NOT (f.estado = 'reserva_programado' AND f.programado_id = p.programado_id))
      ORDER BY p.folio`);

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS reservas FROM folios_pedido_usados WHERE estado='reserva_programado'`);
  console.log(`[predeploy-062] Reservas de programados en el ledger: ${c.reservas}`);

  if (ambiguos.length > 0) {
    console.warn(`[predeploy-062] ATENCION: ${ambiguos.length} programado(s) pendiente(s) con folio ambiguo/bloqueado -- no se pudieron reservar automaticamente y requieren reemision manual de folio:`);
    for (const a of ambiguos) {
      console.warn(`    ${a.folio} -- claim: ${a.estado || '(ninguno)'} / origen: ${a.origen || '(ninguno)'}`);
    }
  } else {
    console.log('[predeploy-062] Ningun programado pendiente queda ambiguo.');
  }

  // Fail closed real: si el ledger dice que hay un programado inactivable Y
  // NO está entre los ambiguos reportados (es decir, la reparacion deberia
  // haberlo resuelto y no lo hizo), aborta el deploy.
  if (huerf.n > ambiguos.length) {
    throw new Error(
      `${huerf.n} programado(s) con claim 'usado' pero solo ${ambiguos.length} quedaron ` +
      `explicados como ambiguos: hay un caso sin clasificar`);
  }

  console.log('[predeploy-062] Verificacion OK.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-062] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
