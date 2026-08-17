// Pre-Deploy Command de Railway para la 056 exclusivamente.
//
// Aplica migrations/056_pagos_expiracion.sql: la deuda durable de derivación
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
const MIGRACION = join(__dirname, '..', 'migrations', '056_pagos_expiracion.sql');

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
         WHERE table_name='pagos' AND column_name='xabor_espera_hasta'
           AND data_type LIKE 'timestamp%')::int AS col_deadline,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_pagos_espera_vencida'
           AND indexdef LIKE '%xabor_espera_hasta%'
           AND indexdef LIKE '%creando%' AND indexdef LIKE '%pendiente%')::int AS idx_deadline,
       -- expires_at tiene que SEGUIR existiendo y ser otra columna: el diseño
       -- depende de que el deadline interno y la expiracion del proveedor no
       -- compartan campo.
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='pagos' AND column_name='expires_at')::int AS col_proveedor`);
  return {
    colDeadline: r.col_deadline === 1,
    idxDeadline: r.idx_deadline === 1,
    colProveedor: r.col_proveedor === 1,
  };
}

const FALTANTES = {
  colDeadline: 'pagos.xabor_espera_hasta (timestamptz)',
  idxDeadline: 'idx_pagos_espera_vencida sobre xabor_espera_hasta con estados vivos',
  colProveedor: 'pagos.expires_at debe seguir existiendo y ser una columna DISTINTA',
};

try {
  const antes = await estado();
  if (Object.values(antes).every(Boolean)) {
    console.log('[predeploy-056] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-056] Aplicando migrations/056_pagos_expiracion.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    const faltan = Object.entries(despues).filter(([, ok]) => !ok).map(([k]) => FALTANTES[k]);
    if (faltan.length) throw new Error(`faltan garantias tras migrar: ${faltan.join(', ')}`);
    console.log('[predeploy-056] Verificacion OK: deadline interno separado de la expiracion del proveedor.');
  }

  // Visibilidad operativa: una deuda abierta al arrancar es un pedido cobrado
  // que todavia no se libero. El job de recuperacion las salda, pero conviene
  // verlas en el log del deploy.
  const { rows: [d] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pagos
      WHERE xabor_espera_hasta IS NOT NULL AND xabor_espera_hasta < NOW()
        AND estado IN ('creando','pendiente','requiere_revision')`);
  console.log(`[predeploy-056] Pagos con la espera vencida al arrancar: ${d.n}`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-056] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
