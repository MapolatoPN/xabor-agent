// Pre-Deploy de la 048. Mismo patrón que 032..046.
//
// Aditiva pura: crea una tabla nueva. No toca ni una fila existente, no
// altera ninguna tabla previa. Si la tabla ya existe, no hace nada.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '048_whatsapp_menu_automatico.sql');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  const { rows: [ya] } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'whatsapp_menu_automatico'`);

  if (ya.n === 1) {
    console.log('[predeploy-048] Ya aplicada -- no se ejecuta nada.');
  } else {
    // set_updated_at() es la función del proyecto (no trigger_set_updated_at).
    // Si faltara, el CREATE TRIGGER fallaría a mitad y el deploy quedaría a
    // medias: se comprueba antes.
    const { rows: [fn] } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'set_updated_at'`);
    if (fn.n === 0) throw new Error('falta la función set_updated_at(): el trigger de la 048 no se puede crear');

    console.log('[predeploy-048] Aplicando migrations/048_whatsapp_menu_automatico.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const { rows: [creada] } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = 'whatsapp_menu_automatico'`);
    if (creada.n !== 1) throw new Error('la tabla whatsapp_menu_automatico no quedó creada');
    console.log('[predeploy-048] OK. Tabla whatsapp_menu_automatico lista (0 filas, 0 datos tocados).');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-048] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
