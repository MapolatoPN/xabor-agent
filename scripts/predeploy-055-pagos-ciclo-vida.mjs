// Pre-Deploy Command de Railway para la 055 exclusivamente.
//
// Aplica migrations/055_pagos_ciclo_vida.sql: la deuda durable de derivación
// que cierra la ventana de crash entre asentar el dinero y liberar el pedido.
//
// Fail-closed: si tras migrar falta cualquiera de las garantías, se aborta el
// deploy con exit 1. Arrancar sin esas columnas significa que la transición
// financiera no puede escribir su obligación, y un crash en el momento
// equivocado deja un pedido cobrado que nadie libera nunca.
//
// Idempotente: se comprueba antes y el SQL es re-ejecutable.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '055_pagos_ciclo_vida.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Se verifica la DEFINICIÓN de los índices, no solo su nombre: un índice que se
// llame igual pero cubra otras columnas o lleve otro predicado pasaría un gate
// que solo mirara el nombre, y dejaría al sistema sin la garantía real.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='pagos' AND column_name='derivacion_pendiente'
           AND data_type='boolean' AND is_nullable='NO')::int AS col_deuda,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='pagos' AND column_name='derivacion_saldada_at')::int AS col_saldada,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_pagos_derivacion_pendiente'
           AND indexdef LIKE '%negocio_id%' AND indexdef LIKE '%pedido_folio%'
           AND indexdef LIKE '%WHERE derivacion_pendiente%')::int AS idx_deuda,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_pagos_reconciliables'
           AND indexdef LIKE '%proveedor%'
           AND indexdef LIKE '%pagado%' AND indexdef LIKE '%reembolsado%'
           AND indexdef LIKE '%cancelado%')::int AS idx_reconc`);
  return {
    colDeuda: r.col_deuda === 1,
    colSaldada: r.col_saldada === 1,
    idxDeuda: r.idx_deuda === 1,
    idxReconc: r.idx_reconc === 1,
  };
}

const FALTANTES = {
  colDeuda: 'pagos.derivacion_pendiente (boolean NOT NULL)',
  colSaldada: 'pagos.derivacion_saldada_at',
  idxDeuda: 'idx_pagos_derivacion_pendiente sobre (negocio_id, pedido_folio) WHERE derivacion_pendiente',
  idxReconc: 'idx_pagos_reconciliables con el predicado de estados no cobrables',
};

try {
  const antes = await estado();
  if (Object.values(antes).every(Boolean)) {
    console.log('[predeploy-055] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-055] Aplicando migrations/055_pagos_ciclo_vida.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    const faltan = Object.entries(despues).filter(([, ok]) => !ok).map(([k]) => FALTANTES[k]);
    if (faltan.length) throw new Error(`faltan garantias tras migrar: ${faltan.join(', ')}`);
    console.log('[predeploy-055] Verificacion OK: deuda durable de derivacion y sus indices.');
  }

  // Visibilidad operativa: una deuda abierta al arrancar es un pedido cobrado
  // que todavia no se libero. El job de recuperacion las salda, pero conviene
  // verlas en el log del deploy.
  const { rows: [d] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pagos WHERE derivacion_pendiente`);
  console.log(`[predeploy-055] Deudas de derivacion abiertas: ${d.n}`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-055] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
