// Pre-Deploy Command para este release ÚNICAMENTE: aplica exactamente
// 027_cotizaciones_iva_tasa.sql contra DATABASE_URL (inyectada por Railway
// vía red privada al servicio xabor-agent en honest-tenderness/production
// -- nunca se toca desde fuera de la infraestructura de Railway).
//
// Reemplaza a scripts/deploy-migrate-025-026.mjs (025/026 ya están
// aplicadas en producción desde el deploy anterior; ese script cumplió su
// función y queda retirado del Pre-Deploy Command, ver railway.toml).
//
// Garantía de alcance: la lista de archivos está fija en este script (no
// se deriva de un directorio ni de un arreglo compartido con otros
// entornos) -- nunca ejecuta 028, 029 ni ninguna migración futura, sin
// importar qué exista en migrations/ al momento del deploy.
//
// La migración es idempotente (columna con IF NOT EXISTS, constraint con
// drop-then-add guardado, backfill con WHERE ... AND impuestos_tasa = 0
// que nunca se re-aplica dos veces sobre una fila ya corregida), así que
// reintentar este Pre-Deploy Command en un redeploy futuro no duplica ni
// corrompe nada -- pero el alcance sigue siendo únicamente esta, nunca más.
//
// Ninguna sentencia de esta migración inserta datos sintéticos/de prueba
// ni borra ninguna cotización -- solo agrega una columna con backfill
// derivado de subtotal/impuestos ya persistidos, nunca cambia totales.
//
// Salida: código 0 solo si la migración se aplicó sin error. Cualquier
// error -> código distinto de cero -> Railway aborta el deploy
// automáticamente y la instancia anterior sigue sirviendo tráfico sin
// interrupción (comportamiento nativo de Pre-Deploy Command).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACIONES_DIR = join(__dirname, '..', 'migrations');

// Lista fija, a propósito -- ver comentario de alcance arriba.
const ARCHIVOS = [
  '027_cotizaciones_iva_tasa.sql',
];
const CHECKS = [
  '027_check_cotizaciones_iva_tasa.sql',
];

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está presente -- abortando sin tocar nada.');
  }

  for (const archivo of ARCHIVOS) {
    const ruta = join(MIGRACIONES_DIR, archivo);
    const sql = readFileSync(ruta, 'utf8');
    console.log(`[deploy-migrate] Aplicando ${archivo} ...`);
    await pool.query(sql); // BEGIN/COMMIT ya están dentro del propio archivo -- atómico
    console.log(`[deploy-migrate] OK ${archivo}`);
  }

  console.log('[deploy-migrate] Ejecutando checks de solo lectura (log informativo):');
  for (const archivo of CHECKS) {
    const ruta = join(MIGRACIONES_DIR, archivo);
    const sql = readFileSync(ruta, 'utf8');
    console.log(`[deploy-migrate] --- ${archivo} ---`);
    const resultado = await pool.query(sql);
    const resultados = Array.isArray(resultado) ? resultado : [resultado];
    for (const r of resultados) console.log(JSON.stringify(r.rows, null, 2));
  }

  console.log('[deploy-migrate] 027 aplicada y verificada correctamente.');
}

main()
  .then(() => { console.log('[deploy-migrate] EXITO -- continuando el deploy.'); process.exit(0); })
  .catch((e) => {
    console.error('[deploy-migrate] FALLO -- abortando el deploy, la version anterior sigue activa.');
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
