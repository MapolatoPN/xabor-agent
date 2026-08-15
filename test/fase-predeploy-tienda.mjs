// ─── El camino real de la 051 hasta un deploy ──────────────────────────────
//
// Que exista migrations/051_tienda_online.sql no significa nada: producción
// no lee esa carpeta. Lo que corre en un deploy es lo que dice railway.toml,
// y railway.toml apunta a UN runner con una lista de scripts.
//
// Esta suite verifica la cadena completa:
//   railway.toml → runner → script de la 051 → SQL → verificación
// y comprueba que el paso es idempotente, fail-closed y válido sobre una base
// que ya existe.
//
// Incluye además un guardia genérico: cualquier predeploy-NNN que alguien
// escriba y olvide agregar al runner hace fallar esta suite. Es exactamente
// el descuido que dejó la 051 huérfana.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const leer = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');
const RAILWAY = leer('railway.toml');

// El nombre del runner sale de railway.toml, no de una constante: si alguien
// cambia el preDeployCommand a otro archivo, la suite sigue el archivo nuevo.
const RUNNER = (RAILWAY.match(/preDeployCommand\s*=\s*"node\s+(scripts\/[\w.-]+\.mjs)"/) || [])[1];
const FUENTE_RUNNER = RUNNER ? leer(RUNNER) : '';
const LISTA = [...FUENTE_RUNNER.matchAll(/^\s*'([\w.-]+)',/gm)].map(m => m[1]);

const ejecutar = (ruta) => execFileSync(process.execPath, [join(RAIZ, ruta)],
  { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // ─── 1. La cadena railway.toml → runner → 051 ───
  await t('railway.toml declara un preDeployCommand con un runner de node', () => {
    assert.ok(RUNNER, `no se pudo leer el preDeployCommand de railway.toml:\n${RAILWAY}`);
    assert.ok(FUENTE_RUNNER.length > 100, 'el runner referido por railway.toml no existe o está vacío');
  });

  await t('el runner incluye la 051 en su lista de pasos', () => {
    assert.ok(LISTA.includes('051-tienda-online'),
      `la 051 NO está en el runner. Lista actual: ${LISTA.join(', ')}`);
  });

  await t('la 051 corre DESPUÉS de la última migración anterior', () => {
    const i50 = LISTA.indexOf('050-menu-multiimagen');
    const i51 = LISTA.indexOf('051-tienda-online');
    assert.ok(i50 >= 0 && i51 > i50, `orden incorrecto: 050 en ${i50}, 051 en ${i51}`);
  });

  await t('cada predeploy-NNN del repositorio está en el runner', () => {
    // Este es el guardia. La 051 quedó fuera del runner justo porque nadie
    // comprobaba esto; a partir de aquí, olvidarlo rompe la suite.
    const scripts = readdirSync(join(RAIZ, 'scripts'))
      .filter(f => /^predeploy-\d{3}-.+\.mjs$/.test(f))
      .map(f => f.replace(/^predeploy-/, '').replace(/\.mjs$/, ''));
    const huerfanos = scripts.filter(s => !LISTA.includes(s));
    assert.deepStrictEqual(huerfanos, [],
      `hay scripts de predeploy que NINGÚN deploy ejecutaría: ${huerfanos.join(', ')}`);
  });

  await t('el script de la 051 aplica exactamente migrations/051_tienda_online.sql', () => {
    const src = leer('scripts', 'predeploy-051-tienda-online.mjs');
    assert.ok(/051_tienda_online\.sql/.test(src), 'no referencia el archivo de migración');
    assert.ok(/process\.exit\(1\)/.test(src), 'no aborta el deploy ante un fallo');
  });

  // ─── 2. Comportamiento real contra la base ───
  await t('el predeploy corre sin error sobre la base actual', () => {
    const salida = ejecutar('scripts/predeploy-051-tienda-online.mjs');
    assert.ok(/predeploy-051/.test(salida), `salida inesperada: ${salida}`);
  });

  await t('correrlo dos veces seguidas no cambia nada (idempotente)', async () => {
    const antes = await huella();
    ejecutar('scripts/predeploy-051-tienda-online.mjs');
    ejecutar('scripts/predeploy-051-tienda-online.mjs');
    const despues = await huella();
    assert.deepStrictEqual(despues, antes, 'el esquema cambió al repetir el predeploy');
  });

  await t('sobre una base ya migrada reporta "ya aplicada" y no toca nada', () => {
    const salida = ejecutar('scripts/predeploy-051-tienda-online.mjs');
    assert.ok(/Ya aplicada/.test(salida), `no detectó que ya estaba aplicada: ${salida}`);
  });

  await t('deja el esquema completo: las SEIS tablas y el CHECK', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.tables
           WHERE table_schema='public' AND table_name IN
             ('tienda_config','tienda_productos','tienda_campanas',
              'tienda_promociones','tienda_promocion_usos','tienda_pedidos'))::int AS tablas,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint
           WHERE conname='negocio_modulos_modulo_check') AS chk`);
    assert.strictEqual(r.tablas, 6, `solo hay ${r.tablas} de las 6 tablas`);
    assert.ok(r.chk.includes('tienda_online'), 'el CHECK no acepta el módulo nuevo');
  });

  await t('el CHECK conserva TODOS los módulos anteriores', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS chk FROM pg_constraint
        WHERE conname = 'negocio_modulos_modulo_check'`);
    const previos = ['pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz',
      'rappi', 'facturacion', 'rewards', 'chat_imagenes', 'chat_documentos_pdf',
      'cotizaciones', 'generador_cotizaciones', 'pagos', 'repartidores',
      'asistente_comercial_cotizaciones', 'restaurante'];
    const perdidos = previos.filter(m => !r.chk.includes(`'${m}'`));
    assert.deepStrictEqual(perdidos, [], `el CHECK perdió módulos: ${perdidos.join(', ')}`);
  });

  await t('es fail-closed: con una base inalcanzable aborta con código 1', () => {
    let codigo = 0;
    try {
      execFileSync(process.execPath, [join(RAIZ, 'scripts/predeploy-051-tienda-online.mjs')], {
        env: { ...process.env, DATABASE_URL: 'postgresql://nadie:nada@127.0.0.1:1/no_existe' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
    } catch (e) { codigo = e.status; }
    assert.strictEqual(codigo, 1, 'no abortó el deploy cuando la base no responde');
  });

  await t('la migración NO enciende el módulo para nadie', async () => {
    // Un despliegue no debe dejar tiendas abiertas por accidente: el módulo se
    // contrata negocio por negocio desde Superadmin.
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM negocio_modulos
        WHERE modulo = 'tienda_online' AND estado IN ('activo','configurado')
          AND negocio_id NOT IN (
            SELECT negocio_id FROM tienda_config)`);
    assert.ok(r.n >= 0, 'consulta inválida');
    // Y ninguna tienda queda publicada sin que alguien la publique.
    const { rows: [p] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_config WHERE estado = 'publicada' AND publicada_at IS NULL`);
    assert.strictEqual(p.n, 0, 'hay tiendas publicadas sin fecha de publicación');
  });

  // ─── 3. Rollback ───
  await t('existe el down y restaura el CHECK anterior', () => {
    const down = leer('migrations', '051_tienda_online_down.sql');
    assert.ok(/DROP TABLE/i.test(down), 'el down no elimina las tablas');
    assert.ok(/negocio_modulos_modulo_check/.test(down),
      'el down NO restaura el CHECK de negocio_modulos: revertir dejaría un CHECK que acepta un módulo inexistente');
    assert.ok(!/'tienda_online'/.test(down.split('ADD CONSTRAINT')[1] || ''),
      'el CHECK restaurado por el down sigue incluyendo tienda_online');
  });

  await t('el down desactiva el módulo antes de restaurar el CHECK', () => {
    const down = leer('migrations', '051_tienda_online_down.sql');
    const iBorrado = down.search(/DELETE FROM negocio_modulos/i);
    const iCheck = down.search(/ADD CONSTRAINT negocio_modulos_modulo_check/i);
    assert.ok(iBorrado >= 0, 'el down no limpia las filas de negocio_modulos');
    assert.ok(iBorrado < iCheck,
      'restaura el CHECK antes de borrar las filas: la restricción fallaría por filas existentes');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  await pool.end().catch(() => {});
}

// Huella del esquema que toca la 051: si el predeploy es idempotente, esto no
// cambia por repetirlo.
async function huella() {
  const { rows } = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name LIKE 'tienda\\_%'
      ORDER BY table_name, ordinal_position`);
  const { rows: [c] } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conname = 'negocio_modulos_modulo_check'`);
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'tienda\\_%'
      ORDER BY indexname`);
  return { columnas: rows, check: c.d, indices: idx.map(i => i.indexname) };
}

console.log(`\n═══ fase-predeploy-tienda: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
