// Pre-Deploy Command de Railway para la 081 (CRM sobre clientes_negocio).
//
// Aplica migrations/081_crm_clientes_negocio.sql bajo un advisory lock y
// verifica: el índice de expresión existe y ni pedidos ni Rewards cambiaron
// (la migración solo INSERTA en clientes_negocio). Fail-closed.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const indice = async () => (await db.query(
  `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pedidos_activos_negocio_tel10'`)).rows.length === 1;
const foto = async () => (await db.query(
  `SELECT (SELECT count(*) FROM pedidos_activos)::int AS pedidos,
          (SELECT count(*) FROM rewards_accounts)::int AS cuentas,
          (SELECT COALESCE(sum(puntos_balance), 0) FROM rewards_accounts)::bigint AS pts,
          (SELECT count(*) FROM clientes)::int AS clientes_legado`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await indice();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('081-crm-clientes-negocio',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/081_crm_clientes_negocio.sql', import.meta.url), 'utf8'));
  if (!(await indice())) throw new Error('no se creó idx_pedidos_activos_negocio_tel10');
  const despues = await foto();
  for (const k of ['pedidos', 'cuentas', 'pts', 'clientes_legado']) {
    if (String(antes[k]) !== String(despues[k])) throw new Error(`la 081 alteró ${k} (antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
  }
  const { rows } = await db.query(
    `SELECT origen, count(*)::int AS n FROM clientes_negocio GROUP BY origen ORDER BY n DESC`);
  await db.query('COMMIT');
  console.log(`[predeploy-081] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. Pedidos y Rewards intactos (${despues.pedidos} pedidos, ${despues.cuentas} cuentas, ${despues.pts} pts).`);
  console.log(`[predeploy-081] clientes_negocio por origen: ${rows.map(r => `${r.origen}=${r.n}`).join(' · ') || '(vacío)'}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-081] FALLO:', e.message);
} finally { await db.end(); }
