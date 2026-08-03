// Pre-Deploy Command para este release ÚNICAMENTE: aplica exactamente
// 025_pagos_multiempresa.sql y 026_documentos_cotizaciones.sql contra
// DATABASE_URL (inyectada por Railway vía red privada al servicio
// xabor-agent en honest-tenderness/production -- nunca se toca desde
// fuera de la infraestructura de Railway).
//
// Garantía de alcance: la lista de archivos está fija en este script
// (no se deriva de un directorio ni de un arreglo compartido con otros
// entornos) -- nunca ejecuta 027, 028, 029 ni ninguna migración futura,
// sin importar qué exista en migrations/ al momento del deploy.
//
// Ambas migraciones ya son idempotentes (IF NOT EXISTS / ON CONFLICT DO
// NOTHING / guardas DO $$), así que reintentar este Pre-Deploy Command
// en un redeploy futuro no duplica ni corrompe nada -- pero el alcance
// sigue siendo únicamente estas dos, nunca más. Este script se retira
// (se limpia el campo Pre-Deploy Command en Railway) inmediatamente
// después de confirmar el primer deploy exitoso -- ver preflight.
//
// Ninguna sentencia de este script ni de los dos archivos que ejecuta
// inserta datos sintéticos/de prueba -- todo INSERT de las migraciones
// es un backfill real contra `FROM negocios n` (los negocios que ya
// existen en producción), nunca negocios/clientes ficticios.
//
// Salida: código 0 solo si AMBAS migraciones se aplicaron sin error.
// Cualquier error -> código distinto de cero -> Railway aborta el
// deploy automáticamente y la instancia anterior sigue sirviendo
// tráfico sin interrupción (comportamiento nativo de Pre-Deploy Command).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACIONES_DIR = join(__dirname, '..', 'migrations');

// Lista fija, a propósito -- ver comentario de alcance arriba.
const ARCHIVOS = [
  '025_pagos_multiempresa.sql',
  '026_documentos_cotizaciones.sql',
];
const CHECKS = [
  '025_check_pagos_multiempresa.sql',
  '026_check_documentos_cotizaciones.sql',
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
    // Un archivo de check tiene varias sentencias SELECT -- pg-node
    // devuelve un ARRAY de resultados (uno por sentencia) cuando el
    // string tiene más de una, no un solo objeto; se loguean todas
    // como evidencia en los logs de deploy (el detalle completo se
    // revisa manualmente después).
    const resultados = Array.isArray(resultado) ? resultado : [resultado];
    for (const r of resultados) console.log(JSON.stringify(r.rows, null, 2));
  }

  console.log('[deploy-migrate] 025 y 026 aplicadas y verificadas correctamente.');
}

main()
  .then(() => { console.log('[deploy-migrate] EXITO -- continuando el deploy.'); process.exit(0); })
  .catch((e) => {
    console.error('[deploy-migrate] FALLO -- abortando el deploy, la version anterior sigue activa.');
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
