// Pre-Deploy Command de Railway para este release exclusivamente.
//
// Aplica UNICAMENTE migrations/043_impresion_edge.sql (y su verificacion de
// solo lectura) contra DATABASE_URL. Mismo patron que predeploy-032..042.
//
// Puramente aditiva: crea tres tablas nuevas y no escribe una sola fila. No
// crea impresoras, no crea reglas de routing, no crea trabajos y no toca
// `terminales`, `sucursales` ni `negocios`. Un negocio que hoy no imprime
// sigue exactamente igual despues de esta migracion.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '043_impresion_edge.sql');
const CHECK = join(__dirname, '..', 'migrations', '043_check_impresion_edge.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TABLAS = ['impresoras', 'impresion_rutas', 'impresion_trabajos', 'edge_emparejamientos'];

async function yaAplicada() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ANY($1)`, [TABLAS]);
  return rows[0].n === TABLAS.length;
}

async function fotoDeLoQueNoDebeCambiar() {
  const { rows: [r] } = await pool.query(`
    SELECT (SELECT count(*) FROM terminales)::int  AS terminales,
           (SELECT count(*) FROM sucursales)::int  AS sucursales,
           (SELECT count(*) FROM negocios)::int    AS negocios,
           (SELECT count(token_hash) FROM terminales)::int AS terminales_con_credencial`);
  return r;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-043] Ya aplicada -- no se ejecuta nada.');
  } else {
    const antes = await fotoDeLoQueNoDebeCambiar();
    console.log('[predeploy-043] Aplicando migrations/043_impresion_edge.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));
    console.log('[predeploy-043] Aplicada. Corriendo verificación...');

    const { rows: checks } = await pool.query(readFileSync(CHECK, 'utf8'));
    const fallidos = checks.filter(c => c.ok !== true).map(c => c.check);
    if (fallidos.length) throw new Error(`verificación fallida: ${fallidos.join(', ')}`);

    const despues = await fotoDeLoQueNoDebeCambiar();
    for (const k of Object.keys(antes)) {
      if (antes[k] !== despues[k]) {
        throw new Error(`la migración alteró ${k} (antes ${antes[k]}, después ${despues[k]})`);
      }
    }

    // Las tres tablas tienen que nacer vacías: esta migración no siembra
    // configuración de impresión de nadie.
    for (const t of TABLAS) {
      const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (n !== 0) throw new Error(`${t} debe nacer vacía (hay ${n} filas)`);
    }

    console.log(`[predeploy-043] Verificación OK. ${despues.terminales} terminales y ${despues.sucursales} sucursales intactas, 4 tablas nuevas vacías.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-043] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
