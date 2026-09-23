// Predeploy reejecutable de la 091. La migracion completa se manda en una sola
// llamada para que PostgreSQL la trate como una transaccion implicita.
//
// Solo se validan invariantes estables: estructura, default, nulabilidad,
// valores no vacios e indice de idempotencia. No se comparan conteos de filas:
// con trafico real una expiracion/cancelacion puede cambiarlos legítimamente.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '091_tienda_promocion_usos_canal.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 70_000,
  query_timeout: 75_000,
  allowExitOnIdle: true,
});

let salida = 0;
try {
  console.log('[predeploy-091] Aplicando migrations/091_tienda_promocion_usos_canal.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [columna] } = await pool.query(`
    SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tienda_promocion_usos'
       AND column_name = 'canal'`);
  if (!columna) throw new Error('public.tienda_promocion_usos.canal no quedo creada');
  if (columna.data_type !== 'text') throw new Error(`canal debe ser text, no ${columna.data_type}`);
  if (columna.is_nullable !== 'NO') throw new Error('canal debe quedar NOT NULL');
  if (!String(columna.column_default || '').includes('tienda_online')) {
    throw new Error(`canal no tiene DEFAULT 'tienda_online' (${columna.column_default || 'sin default'})`);
  }

  const { rows: [invalidas] } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM public.tienda_promocion_usos
     WHERE canal IS NULL OR btrim(canal) = ''`);
  if (invalidas.n !== 0) throw new Error(`quedaron ${invalidas.n} fila(s) con canal nulo/vacio`);

  const { rows: [indice] } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'tienda_promocion_usos'
       AND indexname = 'idx_promo_uso_unico'
       AND indexdef ILIKE '%(negocio_id, promocion_id, pedido_folio)%'`);
  if (indice.n !== 1) throw new Error('falta idx_promo_uso_unico para la idempotencia del registro');

  const { rows: canales } = await pool.query(`
    SELECT canal, COUNT(*)::int AS n
      FROM public.tienda_promocion_usos
     WHERE canal NOT IN ('tienda_online', 'pos', 'whatsapp')
     GROUP BY canal ORDER BY canal`);
  if (canales.length) {
    console.warn('[predeploy-091] Aviso: canales no conocidos (permitidos para evolucion futura):', canales);
  }

  console.log('[predeploy-091] Verificacion estructural OK.');
} catch (err) {
  salida = 1;
  console.error('[predeploy-091] FALLO:', err.message);
} finally {
  await pool.end().catch(() => {});
}

process.exitCode = salida;
