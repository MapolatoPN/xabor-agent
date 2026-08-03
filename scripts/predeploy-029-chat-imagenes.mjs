// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/029_chat_imagenes.sql (y corre su
// verificacion de solo lectura, 029_check_chat_imagenes.sql) contra
// DATABASE_URL -- nunca ninguna otra migracion. No recorre el
// directorio migrations/ ni usa una lista/orden como
// test/aplicar-migraciones.mjs: los dos nombres de archivo estan
// escritos literalmente abajo a proposito, para que este runner no
// pueda arrastrar ninguna migracion futura por accidente si el
// directorio migrations/ crece antes de que este Pre-Deploy Command
// se retire.
//
// Idempotente: si las columnas/constraint de 029 ya existen, no hace
// nada y termina con exit 0 (seguro de re-ejecutar en cada deploy
// mientras este comando siga configurado en Railway).
//
// Uso (Railway → Settings → Deploy → Pre-Deploy Command):
//   node scripts/predeploy-029-chat-imagenes.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '029_chat_imagenes.sql');
const CHECK = join(__dirname, '..', 'migrations', '029_check_chat_imagenes.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'documentos' AND column_name IN ('categoria','media_id','checksum')
  `);
  if (cols.rows.length < 3) return false;
  const check = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname = 'mensajes_tipo_check'
  `);
  return check.rows.some((r) => r.def.includes("'imagen'"));
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-029] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-029] Aplicando migrations/029_chat_imagenes.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-029] Aplicada. Corriendo verificacion (029_check_chat_imagenes.sql)...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro las columnas/constraint esperadas');
    console.log('[predeploy-029] Verificacion OK: columnas y constraint de 029 presentes.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-029] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
