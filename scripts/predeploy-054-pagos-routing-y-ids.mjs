// Pre-Deploy Command de Railway para la 054 exclusivamente.
//
// Aplica migrations/054_pagos_routing_y_ids.sql: separa preference_id de
// payment_id (dos espacios de identificadores distintos que antes compartían
// campo) y agrega el token opaco con el que un webhook resuelve su integración.
//
// Fail-closed: si tras migrar falta CUALQUIERA de las seis garantías, se aborta
// el deploy con exit 1. Un webhook que no puede resolver su integración, o un
// payment_id sin índice único, son formas de cobrar mal.
//
// Idempotente: se comprueba antes y el SQL es re-ejecutable.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '054_pagos_routing_y_ids.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Misma regla que los gates anteriores: comprobar TODO lo que la migración
// garantiza. Si se agrega algo a la 054, se agrega aquí.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'pagos' AND column_name = 'preference_id')::int AS col_pref,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'pagos' AND column_name = 'payment_id')::int AS col_pay,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_pagos_payment_id')::int AS idx_pay,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_pagos_preference_id')::int AS idx_pref,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'integraciones_canal' AND column_name = 'webhook_routing_token')::int AS col_token,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_integraciones_routing_token')::int AS idx_token,
       -- El índice de payment_id tiene que ser ÚNICO: sin eso, dos filas
       -- podrían reclamar el mismo cobro y una estaría cobrando lo ajeno.
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_pagos_payment_id'
           AND indexdef LIKE 'CREATE UNIQUE%')::int AS pay_unico,
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname='idx_integraciones_routing_token'
           AND indexdef LIKE 'CREATE UNIQUE%')::int AS token_unico`);
  return {
    colPref: r.col_pref === 1, colPay: r.col_pay === 1,
    idxPay: r.idx_pay === 1, idxPref: r.idx_pref === 1,
    colToken: r.col_token === 1, idxToken: r.idx_token === 1,
    payUnico: r.pay_unico === 1, tokenUnico: r.token_unico === 1,
  };
}

const FALTANTES = {
  colPref: 'pagos.preference_id',
  colPay: 'pagos.payment_id',
  idxPay: 'idx_pagos_payment_id',
  idxPref: 'idx_pagos_preference_id',
  colToken: 'integraciones_canal.webhook_routing_token',
  idxToken: 'idx_integraciones_routing_token',
  payUnico: 'idx_pagos_payment_id debe ser UNIQUE',
  tokenUnico: 'idx_integraciones_routing_token debe ser UNIQUE',
};

async function yaAplicada() {
  const e = await estado();
  return Object.values(e).every(Boolean);
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-054] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-054] Aplicando migrations/054_pagos_routing_y_ids.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    const faltan = Object.entries(despues).filter(([, ok]) => !ok).map(([k]) => FALTANTES[k]);
    if (faltan.length) {
      throw new Error(`faltan garantias tras migrar: ${faltan.join(', ')}`);
    }
    console.log('[predeploy-054] Verificacion OK: columnas de identificadores, token de ruteo y sus indices unicos.');
  }

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM integraciones_canal
      WHERE canal = 'pagos' AND webhook_routing_token IS NOT NULL`);
  console.log(`[predeploy-054] Integraciones de pago con token de ruteo: ${c.n}`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-054] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
