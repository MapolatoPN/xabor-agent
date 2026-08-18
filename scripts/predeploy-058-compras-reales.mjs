// Pre-Deploy Command de Railway para la 058 exclusivamente.
//
// Aplica migrations/058_compras_reales.sql: el ledger durable de qué pedidos
// fueron COMPRAS REALES, que es lo que sostiene "solo primera compra" cuando el
// tablero se purga.
//
// Fail-closed: sin estas garantías, la elegibilidad volvería a deducirse de
// `pedidos` menos `pedidos_activos` -- y un intento nunca pagado que se purgue
// del tablero se convertiría en compra.
//
// Idempotente: se comprueba antes y el SQL es re-ejecutable.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '058_compras_reales.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Se verifica la DEFINICIÓN, no solo el nombre: un índice que se llame igual
// pero no sea UNIQUE dejaría pasar dos marcas por pedido, y un CHECK abierto
// admitiría vocabulario inventado.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_name='compras_reales')::int AS tabla,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='compras_reales'
           AND column_name IN ('negocio_id','folio','pedido_creado_at',
                               'cliente_telefono','origen','confirmada_at'))::int AS cols,
       -- pedido_creado_at en el UNIQUE no es opcional: sin el, un folio
       -- reciclado hace que la compra del cliente nuevo choque con la del
       -- anterior y se pierda -- regalando la promocion de primera compra.
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_compra_real_pedido'
           AND indexdef LIKE '%UNIQUE%'
           AND indexdef LIKE '%negocio_id%' AND indexdef LIKE '%folio%'
           AND indexdef LIKE '%pedido_creado_at%')::int AS idx_unico,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_compra_real_cliente'
           AND indexdef LIKE '%cliente_telefono%')::int AS idx_cliente,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conname='chk_compra_origen'
           AND pg_get_constraintdef(oid) LIKE '%pago_online%'
           AND pg_get_constraintdef(oid) LIKE '%operacion%'
           AND pg_get_constraintdef(oid) LIKE '%legacy_desconocido%')::int AS chk`);
  return {
    tabla: r.tabla === 1, cols: r.cols === 6, idxUnico: r.idx_unico === 1,
    idxCliente: r.idx_cliente === 1, chk: r.chk === 1,
  };
}

const FALTANTES = {
  tabla: 'tabla compras_reales',
  cols: 'columnas negocio_id, folio, pedido_creado_at, cliente_telefono, origen, confirmada_at',
  idxUnico: 'idx_compra_real_pedido UNIQUE (negocio_id, folio, pedido_creado_at)',
  idxCliente: 'idx_compra_real_cliente sobre (negocio_id, cliente_telefono)',
  chk: 'chk_compra_origen con el vocabulario de orígenes',
};

try {
  const antes = await estado();
  if (Object.values(antes).every(Boolean)) {
    console.log('[predeploy-058] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-058] Aplicando migrations/058_compras_reales.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    const despues = await estado();
    const faltan = Object.entries(despues).filter(([, ok]) => !ok).map(([k]) => FALTANTES[k]);
    if (faltan.length) throw new Error(`faltan garantias tras migrar: ${faltan.join(', ')}`);
    console.log('[predeploy-058] Verificacion OK: la compra real es durable e independiente del tablero.');
  }

  // Nunca puede haber dos marcas del mismo pedido: eso significaria que el
  // doble cobro o dos caminos de settlement contaron dos compras.
  const { rows: [dup] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT negocio_id, folio, pedido_creado_at FROM compras_reales
        GROUP BY negocio_id, folio, pedido_creado_at HAVING COUNT(*) > 1) d`);
  if (dup.n > 0) throw new Error(`${dup.n} pedido(s) con mas de una compra real registrada`);

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE origen = 'legacy_desconocido')::int AS legacy
       FROM compras_reales`);
  console.log(`[predeploy-058] Compras reales: ${c.total} (de ellas ${c.legacy} del backfill legacy).`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-058] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
