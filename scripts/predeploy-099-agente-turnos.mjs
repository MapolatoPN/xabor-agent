// Predeploy 099: traza durable de turnos del agente y respuestas en el outbox.
//
// Aplica la migración y verifica la unicidad del turno (la que impide aplicar
// dos veces el mismo lote de wamids), el CHECK de modo y las columnas nuevas
// del outbox. Aditiva e idempotente: no toca filas existentes.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-099-agente-turnos',0))");
  await db.query(await readFile(new URL('../migrations/099_agente_turnos.sql', import.meta.url), 'utf8'));
  await db.query(`SELECT id, negocio_id, conversacion_id, turno_clave, modo, wamids, fase_antes, fase_despues,
                         version_antes, version_despues, pendiente_antes, pendiente_despues, acciones,
                         rechazos, folio, outbox_claves, motivo_handoff, cierre, recuperacion, latencias,
                         errores_proveedor, created_at
                    FROM agente_turnos LIMIT 0`);
  const { rows: [uq] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'agente_turnos'::regclass AND conname = 'uq_agente_turnos_clave' AND contype = 'u'`);
  exigir(Number(uq.n) === 1, 'falta la unicidad (negocio, conversación, turno_clave)');
  const { rows: [modo] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'agente_turnos'::regclass AND conname = 'agente_turnos_modo_check'`);
  exigir(Number(modo.n) === 1, 'falta el CHECK de modo');
  await db.query('SELECT conversacion_id, turno_clave FROM agente_outbox LIMIT 0');
  const { rows: [idx] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_agente_outbox_respuestas_pendientes'`);
  exigir(Number(idx.n) === 1, 'falta el índice de respuestas pendientes del outbox');
  // Entrega sin doble envío: arrendamiento, aceptación de Meta y estados.
  await db.query('SELECT wamid_salida, reclamado_at, reclamado_por FROM agente_outbox LIMIT 0');
  const { rows: [chk] } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'agente_outbox'::regclass AND conname = 'agente_outbox_estado_check'`);
  for (const estado of ['pendiente', 'enviando', 'entregado', 'incierto', 'fallido', 'descartado']) {
    exigir(String(chk?.def || '').includes(`'${estado}'`), `el CHECK de estados del outbox no admite '${estado}'`);
  }
  // Una respuesta que no llegó pasa a una persona, una sola vez.
  await db.query(`SELECT humano_motivo, humano_solicitado_at, humano_reclamado_at, humano_confirmado_at
                    FROM agente_outbox LIMIT 0`);
  const { rows: [idxHumano] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_agente_outbox_humano_por_confirmar'`);
  exigir(Number(idxHumano.n) === 1, 'falta el índice de pasos a persona por confirmar');
  await db.query('COMMIT');
  console.log('[predeploy-099] Traza de turnos y respuestas del outbox verificadas.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[predeploy-099] FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
