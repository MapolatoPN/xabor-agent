// Pre-Deploy de la migracion 044. Mismo patron que 032..043.
//
// Puramente aditiva: crea cuatro tablas nuevas y no escribe una sola fila en
// las existentes. Un negocio que hoy opera sigue igual despues de aplicarla.
//
// Sin este script la 044 NUNCA se aplica en un deploy: railway.toml invoca
// scripts/predeploy-run-032-033.mjs, y ese runner solo corre lo que este en
// su lista SCRIPTS. Es el paso que faltaba para que el hotfix de WhatsApp sea
// desplegable de verdad.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '044_resiliencia_sync_whatsapp.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TABLAS = ['sync_operaciones', 'sync_dispositivos', 'whatsapp_inbox', 'whatsapp_outbox'];

async function yaAplicada() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ANY($1)`, [TABLAS]);
  return rows[0].n === TABLAS.length;
}

async function foto() {
  const { rows: [r] } = await pool.query(`
    SELECT (SELECT count(*) FROM negocios)::int  AS negocios,
           (SELECT count(*) FROM usuarios)::int  AS usuarios,
           (SELECT count(*) FROM pedidos)::int   AS pedidos,
           (SELECT count(*) FROM mensajes)::int  AS mensajes`);
  return r;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-044] Ya aplicada -- no se ejecuta nada.');
  } else {
    const antes = await foto();
    console.log('[predeploy-044] Aplicando migrations/044_resiliencia_sync_whatsapp.sql...');
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await foto();
    for (const k of Object.keys(antes)) {
      if (antes[k] !== despues[k]) {
        throw new Error(`la migracion altero ${k} (antes ${antes[k]}, despues ${despues[k]})`);
      }
    }
    // Las cuatro tablas tienen que nacer vacias: esta migracion no siembra
    // nada de nadie.
    for (const t of TABLAS) {
      const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (n !== 0) throw new Error(`${t} debe nacer vacia (hay ${n} filas)`);
    }
    console.log(`[predeploy-044] OK. ${despues.mensajes} mensajes y ${despues.pedidos} pedidos intactos, 4 tablas nuevas vacias.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-044] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
