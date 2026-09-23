// Aplica la 087 de manera transaccional y comprueba sus invariantes.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });

const foto = async () => (await db.query(`
  SELECT (SELECT count(*) FROM pedidos_activos)::int AS pedidos,
         -- Las ventas durables del esquema actual viven en pedidos_activos;
         -- no existe una tabla "ventas" versionada que pueda consultarse aquí.
         (SELECT count(*) FROM pedidos_activos WHERE estado <> 'cancelado')::int AS ventas,
         (SELECT count(*) FROM negocios)::int AS negocios`)).rows[0];

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('087-facturacion',0))");
  const antes = await foto();
  await db.query(await readFile(new URL('../migrations/087_clientes_fiscales.sql', import.meta.url), 'utf8'));
  const despues = await foto();
  for (const campo of Object.keys(antes)) {
    if (String(antes[campo]) !== String(despues[campo])) {
      throw new Error(`la 087 alteró ${campo} (antes ${antes[campo]}, después ${despues[campo]})`);
    }
  }
  for (const tabla of ['clientes_fiscales', 'facturacion_configuracion', 'facturacion_recibos', 'facturacion_whatsapp_estado']) {
    const { rows: [r] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS existe', [`public.${tabla}`]);
    if (!r.existe) throw new Error(`no se creó ${tabla}`);
  }
  const { rows: [u] } = await db.query(`SELECT count(*)::int AS n FROM pg_indexes
    WHERE tablename='facturacion_recibos' AND indexdef ILIKE '%UNIQUE%negocio_id, folio%'`);
  if (u.n < 1) throw new Error('falta unicidad negocio+folio en facturacion_recibos');
  await db.query('COMMIT');
  console.log(`[predeploy-087] Aplicada. Camino crítico intacto (${despues.pedidos} pedidos, ${despues.ventas} ventas).`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  process.exitCode = 1;
  console.error('[predeploy-087] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
