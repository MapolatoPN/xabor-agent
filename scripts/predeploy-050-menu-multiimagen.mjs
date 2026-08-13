// Pre-Deploy Command de Railway para la 050 exclusivamente.
// Aplica migrations/050_menu_multiimagen.sql (tabla hija + backfill de la
// imagen única como Página 1 + drop del CHECK v1). Idempotente: si la
// tabla ya existe, el propio SQL es re-ejecutable (IF NOT EXISTS + backfill
// condicionado), pero se corta antes para no re-correr nada.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '050_menu_multiimagen.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'whatsapp_menu_imagenes')::int AS t,
      (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'whatsapp_menu_activo_exige_imagen')::int AS c
  `);
  return rows[0].t === 1 && rows[0].c === 0;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-050] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-050] Aplicando migrations/050_menu_multiimagen.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion fallo');
    const { rows: [r] } = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_menu_imagenes`);
    console.log(`[predeploy-050] Verificacion OK. Paginas tras backfill: ${r.n}`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-050] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
