// Pre-Deploy Command de Railway para la 061 exclusivamente.
//
// El ledger de claims de folio: la barrera deja de preguntar "aparece en alguna
// tabla" y pasa a "ya fue reclamado, y por quien". Cierra los dos huecos que la
// 060 dejaba: la excepcion de programados por folio a secas, y las 11 fuentes
// de folio que la barrera no miraba.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '061_folios_usados_claim.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('[predeploy-061] Aplicando migrations/061_folios_usados_claim.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_name='folios_pedido_usados')::int AS tabla,
       (SELECT COUNT(*) FROM pg_trigger
         WHERE tgname='trg_barrera_folio_historico' AND NOT tgisinternal)::int AS trg,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='pedidos_programados' AND column_name='programado_id')::int AS col`);
  if (e.tabla !== 1) throw new Error('folios_pedido_usados no quedo creada');
  if (e.trg !== 1) throw new Error('el trigger de la barrera no quedo instalado');
  if (e.col !== 1) throw new Error('pedidos_programados.programado_id no existe');

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE estado='reserva_programado')::int AS reservas
       FROM folios_pedido_usados`);
  const { rows: [b] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pedidos_programados p
      WHERE p.activado = FALSE AND p.folio ~ '^XAB-[0-9]+$'
        AND EXISTS (SELECT 1 FROM folios_pedido_usados f
                     WHERE f.folio = p.folio AND f.estado = 'usado')`);

  console.log(`[predeploy-061] Folios reclamados: ${c.total} (${c.reservas} son reservas de programados)`);
  if (b.n > 0) {
    // No aborta el deploy: son datos preexistentes, no un defecto del codigo.
    // Pero tiene que verse, porque esos programados NO podran activarse con su
    // folio actual y necesitan decision humana.
    console.warn(
      `[predeploy-061] ATENCION: ${b.n} programado(s) sin activar tienen un folio que YA pertenece ` +
      `a otro pedido. Quedan bloqueados a proposito (fail closed): reutilizar ese numero romperia ` +
      `panel, impresion, pagos y compras. Requieren reemision manual de folio.`);
  } else {
    console.log('[predeploy-061] Ningun programado pendiente choca con un folio ya usado.');
  }
  console.log('[predeploy-061] Verificacion OK: el folio se reclama de forma atomica.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-061] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
