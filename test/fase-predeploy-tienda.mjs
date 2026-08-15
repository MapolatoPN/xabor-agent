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

  // Scripts anteriores al runner actual. Se ejecutaron como preDeployCommand
  // sueltos en los releases de su época y llevan mucho aplicados en
  // producción; el runner nació con la 032. Están aquí por nombre, no por un
  // "ignora todo lo viejo", para que la lista sea revisable: si alguien
  // agrega uno nuevo fuera del runner, el guardia lo caza igual.
  const ANTERIORES_AL_RUNNER = [
    '029-chat-imagenes',
    '030-cotizaciones-enviado-por',
    '031-sesiones-comerciales-error-recuperable',
  ];

  await t('cada predeploy-NNN del repositorio está en el runner', () => {
    // Este es el guardia. La 051 quedó fuera del runner justo porque nadie
    // comprobaba esto; a partir de aquí, olvidarlo rompe la suite.
    const scripts = readdirSync(join(RAIZ, 'scripts'))
      .filter(f => /^predeploy-\d{3}-.+\.mjs$/.test(f))
      .map(f => f.replace(/^predeploy-/, '').replace(/\.mjs$/, ''));
    const huerfanos = scripts
      .filter(s => !LISTA.includes(s))
      .filter(s => !ANTERIORES_AL_RUNNER.includes(s));
    assert.deepStrictEqual(huerfanos, [],
      `hay scripts de predeploy que NINGÚN deploy ejecutaría: ${huerfanos.join(', ')}`);
  });

  await t('la migración MÁS ALTA del repositorio está cubierta por el runner', () => {
    // Complemento del guardia anterior desde el otro lado: aunque alguien no
    // escriba script, la migración más reciente tiene que tener quien la corra.
    const nums = readdirSync(join(RAIZ, 'migrations'))
      .map(f => (f.match(/^(\d{3})_/) || [])[1]).filter(Boolean).map(Number);
    const ultima = String(Math.max(...nums)).padStart(3, '0');
    assert.ok(LISTA.some(s => s.startsWith(ultima + '-')),
      `la migración ${ultima} es la más alta del repo y NADIE la ejecuta en un deploy`);
  });

  await t('el script de la 051 aplica exactamente migrations/051_tienda_online.sql', () => {
    const src = leer('scripts', 'predeploy-051-tienda-online.mjs');
    assert.ok(/051_tienda_online\.sql/.test(src), 'no referencia el archivo de migración');
    assert.ok(/process\.exit\(1\)/.test(src), 'no aborta el deploy ante un fallo');
  });

  await t('el runner incluye la 052 y va DESPUÉS de la 051', () => {
    const i51 = LISTA.indexOf('051-tienda-online');
    const i52 = LISTA.indexOf('052-impresion-legacy-idempotente');
    assert.ok(i52 > i51 && i51 >= 0, `orden incorrecto: 051 en ${i51}, 052 en ${i52}`);
  });

  await t('el script de la 052 aplica exactamente migrations/052_impresion_legacy_idempotente.sql', () => {
    const src = leer('scripts', 'predeploy-052-impresion-legacy-idempotente.mjs');
    assert.ok(/052_impresion_legacy_idempotente\.sql/.test(src), 'no referencia el archivo de migración');
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

  // ─── 1bis. La 052: memoria de impresión legacy ───
  await t('el predeploy de la 052 corre sin error y es idempotente', async () => {
    const primera = ejecutar('scripts/predeploy-052-impresion-legacy-idempotente.mjs');
    assert.ok(/predeploy-052/.test(primera), `salida inesperada: ${primera}`);
    const antes = await huellaLegacy();
    ejecutar('scripts/predeploy-052-impresion-legacy-idempotente.mjs');
    const segunda = ejecutar('scripts/predeploy-052-impresion-legacy-idempotente.mjs');
    assert.ok(/Ya aplicada/.test(segunda), `no detectó que ya estaba aplicada: ${segunda}`);
    assert.deepStrictEqual(await huellaLegacy(), antes, 'el esquema cambió al repetir el predeploy');
  });

  await t('la 052 deja la tabla con PK COMPUESTA (negocio, printJobId)', async () => {
    // La PK no es decoración: es lo que hace atómico el "reclamar" cuando dos
    // procesos intentan emitir el mismo trabajo. Sin ella la deduplicación
    // sería una carrera con otro nombre.
    const { rows: [r] } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = to_regclass('public.impresion_legacy_emitida') AND contype = 'p'`);
    assert.ok(r?.d, 'impresion_legacy_emitida no tiene llave primaria');
    assert.ok(/negocio_id/.test(r.d) && /print_job_id/.test(r.d),
      `la PK no es (negocio_id, print_job_id): ${r.d}`);
  });

  await t('la BASE rechaza registrar dos veces el mismo trabajo legacy', async () => {
    const { rows: [n] } = await pool.query(`SELECT id FROM negocios LIMIT 1`);
    const jobId = 'PRUEBA-PREDEPLOY-052:comanda';
    await pool.query(`DELETE FROM impresion_legacy_emitida WHERE print_job_id = $1`, [jobId]);
    await pool.query(
      `INSERT INTO impresion_legacy_emitida (negocio_id, print_job_id) VALUES ($1,$2)`, [n.id, jobId]);
    let rechazado = false;
    try {
      await pool.query(
        `INSERT INTO impresion_legacy_emitida (negocio_id, print_job_id) VALUES ($1,$2)`, [n.id, jobId]);
    } catch (e) { rechazado = e.code === '23505'; }
    await pool.query(`DELETE FROM impresion_legacy_emitida WHERE print_job_id = $1`, [jobId]);
    assert.ok(rechazado, 'la base ACEPTÓ dos registros del mismo trabajo: no habría deduplicación');
  });

  await t('existe el down de la 052 y solo borra lo que la 052 creó', () => {
    const down = leer('migrations', '052_impresion_legacy_idempotente_down.sql');
    assert.ok(/DROP TABLE IF EXISTS impresion_legacy_emitida/.test(down), 'el down no borra la tabla');
    assert.ok(!/ALTER TABLE (?!.*impresion_legacy)/.test(down),
      'el down toca tablas que la 052 no creó');
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

  // ─── 3. Aislamiento impuesto por el esquema ───
  await t('las relaciones del módulo son COMPUESTAS con negocio_id', async () => {
    const { rows } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
      [['tienda_productos_negocio_producto_fkey',
        'tienda_promociones_negocio_campania_fkey',
        'tienda_promocion_usos_negocio_promocion_fkey',
        'tienda_promocion_usos_negocio_campania_fkey']]);
    assert.strictEqual(rows.length, 4,
      `solo ${rows.length}/4 FKs llevan negocio_id: un servicio equivocado podría cruzar negocios`);
  });

  await t('la BASE rechaza ligar una promoción a la campaña de OTRO negocio', async () => {
    // No se prueba que el servicio valide (eso ya está en la suite E2E): se
    // prueba que aunque el servicio fallara, Postgres lo impide.
    const SEED = JSON.parse(readFileSync(join(RAIZ, 'test', '.datos-prueba.json'), 'utf8'));
    const { rows: [campB] } = await pool.query(
      `INSERT INTO tienda_campanas (negocio_id, nombre) VALUES ($1, $2) RETURNING id`,
      [SEED.negocioB, 'Campaña cruzada ' + Date.now()]);
    let rechazado = false;
    try {
      await pool.query(
        `INSERT INTO tienda_promociones (negocio_id, nombre, tipo, automatica, valor, campania_id)
         VALUES ($1,'Promo cruzada','porcentaje',TRUE,10,$2)`,
        [SEED.negocioA, campB.id]);
    } catch (e) { rechazado = e.code === '23503'; }
    await pool.query(`DELETE FROM tienda_promociones WHERE nombre = 'Promo cruzada'`).catch(() => {});
    await pool.query(`DELETE FROM tienda_campanas WHERE id = $1`, [campB.id]).catch(() => {});
    assert.ok(rechazado,
      'la base ACEPTÓ una promoción ligada a la campaña de otro negocio');
  });

  await t('la BASE rechaza publicar en una tienda el producto de OTRO negocio', async () => {
    const SEED = JSON.parse(readFileSync(join(RAIZ, 'test', '.datos-prueba.json'), 'utf8'));
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
       VALUES ($1,'Cruce (test)',TRUE,999) RETURNING id`, [SEED.negocioB]);
    const { rows: [prod] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
       VALUES ($1,$2,'Producto de B',10,TRUE,1) RETURNING id`, [SEED.negocioB, cat.id]);
    let rechazado = false;
    try {
      await pool.query(
        `INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`,
        [SEED.negocioA, prod.id]);
    } catch (e) { rechazado = e.code === '23503'; }
    await pool.query(`DELETE FROM tienda_productos WHERE producto_id = $1`, [prod.id]).catch(() => {});
    await pool.query(`DELETE FROM menu_productos WHERE id = $1`, [prod.id]).catch(() => {});
    await pool.query(`DELETE FROM menu_categorias WHERE id = $1`, [cat.id]).catch(() => {});
    assert.ok(rechazado, 'la base ACEPTÓ publicar el producto de otro negocio');
  });

  // ─── 4. Rollback ───
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

// Huella del esquema que toca la 052.
async function huellaLegacy() {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'impresion_legacy_emitida'
      ORDER BY ordinal_position`);
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'impresion_legacy_emitida'
      ORDER BY indexname`);
  return { columnas: rows, indices: idx.map(i => i.indexname) };
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
