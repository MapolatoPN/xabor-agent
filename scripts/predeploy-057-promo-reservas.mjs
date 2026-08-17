// Pre-Deploy Command de Railway para la 057 exclusivamente.
//
// Aplica migrations/057_promo_reservas.sql: el ciclo de vida propio de la
// promoción (reservada → consumida | liberada), coordinado con el lifecycle
// financiero.
//
// Fail-closed: si tras migrar falta cualquiera de las garantías, se aborta el
// deploy con exit 1. Arrancar sin ellas significa volver al comportamiento
// viejo -- llegar al checkout gasta la promoción --, y el cupo de un cupón que
// nadie pagó queda quemado para siempre.
//
// Idempotente: se comprueba antes y el SQL es re-ejecutable.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '057_promo_reservas.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Se verifica la DEFINICIÓN, no solo el nombre: un CHECK que admita cualquier
// texto o un índice que cubra otras columnas pasarían un gate ingenuo y
// dejarían al sistema sin la garantía real.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='tienda_promocion_usos' AND column_name='estado'
           AND is_nullable='NO')::int AS col_estado,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='tienda_promocion_usos'
           AND column_name IN ('pedido_version','consumida_at'))::int AS col_version,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conname='chk_promo_uso_estado'
           AND pg_get_constraintdef(oid) LIKE '%reservada%'
           AND pg_get_constraintdef(oid) LIKE '%consumida%')::int AS chk_estado,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_promo_uso_reservada'
           AND indexdef LIKE '%reservada%')::int AS idx_reservada,
       -- El UNIQUE de identidad tiene que seguir ahi: es lo que impide dos
       -- reservas de la misma promocion para el mismo pedido, y con ello que
       -- cambiar de proveedor compita consigo mismo por el ultimo cupo.
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_promo_uso_unico'
           AND indexdef LIKE '%UNIQUE%')::int AS idx_identidad`);
  return {
    colEstado: r.col_estado === 1,
    colVersion: r.col_version === 2,
    chkEstado: r.chk_estado === 1,
    idxReservada: r.idx_reservada === 1,
    idxIdentidad: r.idx_identidad === 1,
  };
}

const FALTANTES = {
  colEstado: 'tienda_promocion_usos.estado (text NOT NULL)',
  colVersion: 'tienda_promocion_usos.pedido_version y .consumida_at',
  chkEstado: "chk_promo_uso_estado limitado a 'reservada'/'consumida'",
  idxReservada: 'idx_promo_uso_reservada (parcial sobre estado = reservada)',
  idxIdentidad: 'idx_promo_uso_unico debe seguir existiendo y ser UNIQUE',
};

try {
  const antes = await estado();
  if (Object.values(antes).every(Boolean)) {
    console.log('[predeploy-057] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-057] Aplicando migrations/057_promo_reservas.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    const faltan = Object.entries(despues).filter(([, ok]) => !ok).map(([k]) => FALTANTES[k]);
    if (faltan.length) throw new Error(`faltan garantias tras migrar: ${faltan.join(', ')}`);
    console.log('[predeploy-057] Verificacion OK: reservar y consumir son estados distintos.');
  }

  // Ninguna promocion puede haber entregado mas cupos de los que tiene. Se
  // comprueba de verdad contra los datos, no solo contra el esquema: si esto
  // saliera positivo, habria descuentos regalados y el deploy debe pararse.
  const { rows: [x] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tienda_promociones p
      WHERE p.limite_usos IS NOT NULL
        AND (SELECT COUNT(*) FROM tienda_promocion_usos u
              WHERE u.negocio_id = p.negocio_id AND u.promocion_id = p.id) > p.limite_usos`);
  if (x.n > 0) throw new Error(`${x.n} promocion(es) con mas usos registrados que su limite`);

  const { rows: [d] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE estado = 'reservada'`);
  console.log(`[predeploy-057] Reservas de promocion abiertas al arrancar: ${d.n}`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-057] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
