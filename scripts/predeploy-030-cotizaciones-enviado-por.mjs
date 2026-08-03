// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/030_cotizaciones_enviado_por.sql (y corre
// su verificacion de solo lectura, 030_check_cotizaciones_enviado_por.sql)
// contra DATABASE_URL -- nunca ninguna otra migracion. No recorre el
// directorio migrations/ ni usa una lista/orden como
// test/aplicar-migraciones.mjs: el nombre de archivo esta escrito
// literalmente abajo a proposito, para que este runner no pueda arrastrar
// ninguna migracion futura por accidente si el directorio migrations/
// crece antes de que este Pre-Deploy Command se retire.
//
// Idempotente: si la columna de 030 ya existe, no hace nada y termina con
// exit 0 (seguro de re-ejecutar en cada deploy mientras este comando siga
// configurado en Railway).
//
// Uso (Railway → Settings → Deploy → Pre-Deploy Command):
//   node scripts/predeploy-030-cotizaciones-enviado-por.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '030_cotizaciones_enviado_por.sql');
const CHECK = join(__dirname, '..', 'migrations', '030_check_cotizaciones_enviado_por.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function yaAplicada() {
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'cotizaciones' AND column_name = 'enviado_por'
  `);
  return cols.rows.length === 1;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-030] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log('[predeploy-030] Aplicando migrations/030_cotizaciones_enviado_por.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-030] Aplicada. Corriendo verificacion (030_check_cotizaciones_enviado_por.sql)...');
    await pool.query(readFileSync(CHECK, 'utf8'));
    if (!(await yaAplicada())) throw new Error('la verificacion post-migracion no encontro la columna esperada');
    console.log('[predeploy-030] Verificacion OK: columna enviado_por presente en cotizaciones.');
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-030] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
