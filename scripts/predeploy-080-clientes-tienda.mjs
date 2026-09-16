// Pre-Deploy Command de Railway para la 080 (cliente canónico de la tienda).
//
// Aplica migrations/080_clientes_tienda.sql bajo un advisory lock (dos
// instancias arrancando a la vez no la corren dos veces) y verifica el
// resultado. La migración es aditiva e idempotente: crea cinco tablas,
// agrega tres columnas nullables/apagadas y hace un backfill que SOLO crea
// clientes y pone punteros -- nunca mueve puntos ni cambia pedidos.
//
// Fail-closed: si al terminar falta cualquier tabla o columna, o si algún
// saldo de Rewards cambió, sale con 1 y Railway aborta el deploy.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TABLAS = ['clientes_negocio', 'cliente_direcciones', 'cliente_otp', 'cliente_sesiones', 'cliente_consentimientos'];
const COLUMNAS = [['rewards_accounts', 'cliente_id'], ['pedidos_activos', 'cliente_id'], ['tienda_config', 'cuentas_clientes']];

async function existe() {
  for (const t of TABLAS) {
    const { rows } = await db.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [t]);
    if (!rows.length) return false;
  }
  for (const [t, c] of COLUMNAS) {
    const { rows } = await db.query('SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', [t, c]);
    if (!rows.length) return false;
  }
  return true;
}

// Los saldos son lo que esta migración tiene PROHIBIDO tocar: se fotografían
// antes y se comparan después, dentro de la misma transacción.
const fotoSaldos = async () => (await db.query(
  `SELECT count(*)::int AS cuentas, COALESCE(sum(puntos_balance),0)::bigint AS balance,
          COALESCE(sum(puntos_acumulados_total),0)::bigint AS acumulado,
          (SELECT count(*) FROM rewards_movements)::int AS movimientos
     FROM rewards_accounts`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await existe();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('080-clientes-tienda',0))");
  const antes = await fotoSaldos();
  await db.query(await readFile(new URL('../migrations/080_clientes_tienda.sql', import.meta.url), 'utf8'));
  if (!(await existe())) throw new Error('la verificación post-migración no encontró las tablas o columnas de la 080');
  const despues = await fotoSaldos();
  for (const k of ['cuentas', 'balance', 'acumulado', 'movimientos']) {
    if (String(antes[k]) !== String(despues[k])) {
      throw new Error(`la 080 alteró Rewards (${k}: antes ${antes[k]}, después ${despues[k]}) -- se aborta`);
    }
  }
  const { rows: [r] } = await db.query(
    `SELECT (SELECT count(*) FROM clientes_negocio)::int AS clientes,
            (SELECT count(*) FROM clientes_negocio WHERE origen = 'rewards')::int AS desde_rewards,
            (SELECT count(*) FROM rewards_accounts WHERE cliente_id IS NOT NULL)::int AS cuentas_vinculadas,
            (SELECT count(*) FROM rewards_accounts WHERE cliente_id IS NULL)::int AS cuentas_sin_vincular,
            (SELECT count(*) FROM (SELECT cliente_id FROM rewards_accounts WHERE cliente_id IS NOT NULL
                                    GROUP BY cliente_id HAVING count(*) > 1) x)::int AS clientes_con_varias_cuentas,
            (SELECT count(*) FROM tienda_config WHERE cuentas_clientes)::int AS tiendas_con_cuentas`);
  await db.query('COMMIT');
  console.log(`[predeploy-080] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. Rewards intacto (${despues.cuentas} cuentas, ${despues.balance} pts, ${despues.movimientos} movimientos).`);
  console.log(`[predeploy-080] clientes=${r.clientes} (desde Rewards: ${r.desde_rewards}) · cuentas vinculadas=${r.cuentas_vinculadas} · sin vincular=${r.cuentas_sin_vincular} · con varias cuentas (formatos distintos del mismo teléfono)=${r.clientes_con_varias_cuentas} · tiendas con cuentas encendidas=${r.tiendas_con_cuentas}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1; console.error('[predeploy-080] FALLO:', e.message);
} finally { await db.end(); }
