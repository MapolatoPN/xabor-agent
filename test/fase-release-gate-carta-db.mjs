// LA LIBERACIÓN SE DETIENE SI UN BOT DE WHATSAPP ENCENDIDO NO TIENE CARTA.
//
// Revisión Codex, hallazgo 4: «un negocio con el agente habilitado y carta
// vacía debe bloquear la liberación». Desde la revisión 2 el bot legacy
// también vende solo la carta publicada, así que la barrera cubre a los dos.
//
// Se ejecuta el `scripts/release-gate.mjs` REAL, como proceso hijo y con los
// mismos argumentos que usa el Pre-Deploy de Railway (`--db-only
// --all-agent-businesses`), sobre una copia DESECHABLE de la base de la suite
// en la que solo existen los bots que la prueba enciende. Se mira el código de
// salida: 1 conserva el despliegue anterior.
//
//   G1  agente encendido, menú con productos y nada publicado  → exit 1
//   G2  el mismo negocio publica un producto                   → exit 0
//   G2b bot legacy encendido sin productos ni carta             → exit 1 (en runtime no contestaría)
//   G2c el dueño apaga ese bot                                  → exit 0
//   G3  bot legacy encendido, con menú y sin carta              → exit 1 (legacy)
//   G4  lo único publicado está en una categoría inactiva       → exit 1
//   G5  lo único publicado está agotado                         → exit 1
//   G6  el negocio del bot está inactivo                        → no bloquea
//   G7  el legacy publica un producto disponible                → exit 0
//
// Uso: DATABASE_URL=<local, con 098> node test/fase-release-gate-carta-db.mjs
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import assert from 'assert';
import pkg from 'pg';

const { Pool, Client } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const BASE = process.env.DATABASE_URL;
const host = (() => { try { return new URL(BASE).hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`FALLO: esta suite crea y borra una base; solo corre contra Postgres local (host="${host}").`);
  process.exit(1);
}
const DESECHABLE = 'xabor_gate_carta';
const urlDesechable = BASE.replace(/\/[^/?]+(\?|$)/, `/${DESECHABLE}$1`);
const nombreOrigen = (BASE.match(/\/([^/?]+)(\?|$)/) || [])[1];
const urlAdmin = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

/** El gate REAL, como lo corre el runner del predeploy. */
function gate() {
  try {
    const salida = execFileSync(process.execPath,
      [join(RAIZ, 'scripts', 'release-gate.mjs'), '--db-only', '--all-agent-businesses'],
      { cwd: RAIZ, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: urlDesechable, DATABASE_PUBLIC_URL: '' } });
    return { code: 0, salida };
  } catch (e) {
    return { code: e.status ?? 1, salida: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

let admin = null, db = null;
try {
  admin = new Client({ connectionString: urlAdmin });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DESECHABLE} WITH (FORCE)`);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()`, [nombreOrigen]);
  await admin.query(`CREATE DATABASE ${DESECHABLE} TEMPLATE ${nombreOrigen}`);
  db = new Pool({ connectionString: urlDesechable });
  const { rows: [esq] } = await db.query(`SELECT to_regclass('public.whatsapp_productos') IS NOT NULL AS ok,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='pedidos_activos'::regclass
      AND tgname='trg_pedidos_activos_estado_json' AND NOT tgisinternal) AS con_086`);
  if (!esq.ok) throw new Error('la base no tiene whatsapp_productos (migración 098)');
  // Una base local armada sin la 086 reprobaría el gate por su esquema, no por
  // la carta. En la copia se aplica con su propio predeploy, como el runner.
  if (!esq.con_086) {
    execFileSync(process.execPath, [join(RAIZ, 'scripts', 'predeploy-086-estado-pedidos.mjs')],
      { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: urlDesechable } });
  }

  // En la copia solo existen los bots que enciende esta prueba.
  await db.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE bot_whatsapp_activo IS TRUE`);
  await db.query(`DELETE FROM configuracion WHERE clave = 'mesero_agente_v1'`);

  const q1 = async (s, p) => (await db.query(s, p)).rows[0];
  const negocio = async (slug, nombre) => (await q1(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
    ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug])).id;
  const AG = await negocio('gate-carta-agente', 'Gate Carta Agente');
  const LG = await negocio('gate-carta-legacy', 'Gate Carta Legacy');
  for (const n of [AG, LG]) {
    await db.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [n]);
    await db.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [n]);
  }
  const cat = async (n, nombre, activa = true) => (await q1(
    `INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,$2,0,$3) RETURNING id`, [n, nombre, activa])).id;
  const prod = async (n, c, nombre, { agotado = false } = {}) => (await q1(
    `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible,agotado) VALUES ($1,$2,$3,100,TRUE,$4) RETURNING id`,
    [n, c, nombre, agotado])).id;
  const publicar = (n, id, publicado = true) => db.query(
    `INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado, origen) VALUES ($1,$2,$3,'panel')
     ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = EXCLUDED.publicado`, [n, id, publicado]);

  const catAG = await cat(AG, 'Desayunos');
  const WAFFLE = await prod(AG, catAG, 'Waffle');
  await prod(AG, catAG, 'Extra Interno');

  const base = gate();
  await t('G0. sin bots encendidos en la copia, la barrera pasa', () => {
    assert.strictEqual(base.code, 0, base.salida.slice(-1500));
  });

  await db.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'mesero_agente_v1','true')
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor='true'`, [AG]);
  await t('G1. agente encendido con menú y NADA publicado → la liberación se detiene', () => {
    const r = gate();
    assert.strictEqual(r.code, 1, `debía bloquear:\n${r.salida.slice(-1500)}`);
    assert.match(r.salida, /Gate Carta Agente.*sin carta publicada para WhatsApp/);
    assert.match(r.salida, /\(agente\)/);
  });

  await publicar(AG, WAFFLE);
  await t('G2. el mismo negocio publica un producto → la barrera pasa', () => {
    const r = gate();
    assert.strictEqual(r.code, 0, r.salida.slice(-1500));
    assert.match(r.salida, /carta publicada para WhatsApp \(1 categorías, 1 productos\)/);
  });

  // Un bot legacy encendido SIN un solo producto en su menú. Antes solo se
  // avisaba («hoy tampoco vende nada»). Con la guarda de runtime, sin carta
  // ningún bot contesta: liberar dejaría a sus clientes en espera sin que el
  // dueño lo decidiera. Se detiene, y lo dice.
  const LV = await negocio('gate-carta-legacy-vacio', 'Gate Carta Legacy Vacio');
  await db.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [LV]);
  await db.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE, activo = TRUE WHERE id = $1`, [LV]);
  await t('G2b. bot legacy sin productos ni carta → la liberación se detiene y lo explica', () => {
    const r = gate();
    assert.strictEqual(r.code, 1, `debía bloquear:\n${r.salida.slice(-1500)}`);
    assert.match(r.salida, /FALLO  Gate Carta Legacy Vacio .*\(legacy\) sin carta publicada para WhatsApp \(y sin productos en su menú/);
  });
  // La transición documentada para ese caso: el dueño apaga su bot.
  await db.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [LV]);
  await t('G2c. el dueño apaga ese bot → la barrera vuelve a pasar', () => {
    const r = gate();
    assert.strictEqual(r.code, 0, r.salida.slice(-1500));
  });

  const catLG = await cat(LG, 'Comidas');
  const catInactiva = await cat(LG, 'Temporada', false);
  const PLATO = await prod(LG, catLG, 'Plato del Día');
  const DE_TEMPORADA = await prod(LG, catInactiva, 'Plato de Temporada');
  const AGOTADO = await prod(LG, catLG, 'Plato Agotado', { agotado: true });
  await db.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE, activo = TRUE WHERE id = $1`, [LG]);

  await t('G3. bot legacy encendido sin carta → la liberación se detiene y lo dice', () => {
    const r = gate();
    assert.strictEqual(r.code, 1, `debía bloquear:\n${r.salida.slice(-1500)}`);
    assert.match(r.salida, /Gate Carta Legacy.*\(legacy\) sin carta publicada para WhatsApp/);
  });

  await publicar(LG, DE_TEMPORADA);
  await t('G4. lo único publicado está en una categoría inactiva → sigue detenida', () => {
    const r = gate();
    assert.strictEqual(r.code, 1, r.salida.slice(-1500));
    assert.match(r.salida, /Gate Carta Legacy/);
  });

  await publicar(LG, AGOTADO);
  await t('G5. lo único publicado y activo está agotado → sigue detenida', () => {
    const r = gate();
    assert.strictEqual(r.code, 1, r.salida.slice(-1500));
    assert.match(r.salida, /Gate Carta Legacy/);
  });

  await db.query(`UPDATE negocios SET activo = FALSE WHERE id = $1`, [LG]);
  await t('G6. si el negocio está inactivo, su bot no bloquea', () => {
    const r = gate();
    assert.strictEqual(r.code, 0, r.salida.slice(-1500));
  });
  await db.query(`UPDATE negocios SET activo = TRUE WHERE id = $1`, [LG]);

  await publicar(LG, PLATO);
  await t('G7. el legacy publica un producto disponible → la barrera pasa', () => {
    const r = gate();
    assert.strictEqual(r.code, 0, r.salida.slice(-1500));
    assert.match(r.salida, /todo negocio con un bot de WhatsApp encendido tiene carta publicada/);
  });
} catch (e) {
  console.log(`FALLO preparación: ${e.message}`); fallidas++; fallos.push(`preparación: ${e.message}`);
} finally {
  if (db) await db.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DESECHABLE} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
process.exit(0);
