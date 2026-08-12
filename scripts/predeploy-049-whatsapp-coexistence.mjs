// Pre-Deploy Command de Railway para la 049 exclusivamente.
//
// Aplica UNICAMENTE migrations/049_whatsapp_coexistence.sql (y su
// verificacion de solo lectura) contra DATABASE_URL. Mismo patron que
// predeploy-032..036: idempotente, si las columnas ya existen no hace nada
// y termina con exit 0.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '049_whatsapp_coexistence.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'integraciones_canal' AND column_name = 'connection_mode')::int AS a,
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'clientes' AND column_name IN ('human_takeover_until','last_business_app_message_at'))::int AS b,
      (SELECT COUNT(*) FROM pg_constraint
        WHERE conname = 'mensajes_tipo_check'
          AND pg_get_constraintdef(oid) LIKE '%texto_historico%')::int AS c,
      (SELECT COUNT(*) FROM pg_constraint
        WHERE conname = 'integraciones_canal_estado_check'
          AND pg_get_constraintdef(oid) LIKE '%desconectado%')::int AS d
  `);
  return rows[0].a === 1 && rows[0].b === 2 && rows[0].c === 1 && rows[0].d === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-049] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-049] Aplicando migrations/049_whatsapp_coexistence.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro las columnas esperadas');
    console.log('[predeploy-049] Verificacion OK.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-049] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
