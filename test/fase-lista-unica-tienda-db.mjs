// Una sola lista de productos publicados: Tienda en línea = WhatsApp = Rappi.
//
// Decisión del 2026-10-07: lo publicado en la tienda es lo que ofrece el bot
// de WhatsApp y lo que sube a Rappi; si difieren, manda la tienda. WhatsApp
// sigue leyendo `whatsapp_productos`, que ahora es ESPEJO: toda escritura de
// publicación cambia las dos tablas en la misma sentencia (publicacionUnica.js).
//
// Esta suite fija: el espejo desde las tres puertas (tienda, página de
// WhatsApp por producto y por categoría, y la edición de un producto de la
// tienda), que es atómico, que no reescribe lo que no cambió (la huella de la
// carta no se mueve y la revisión del menú no caduca en falso), el
// aislamiento entre negocios, y el script de emparejamiento con su reversa.
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const OPS = join(__dirname, '..', 'scripts', 'ops', 'lista-unica-2026-10');

const { pool } = await import('../src/services/database.js');
const { publicarProductos, actualizarProductoTienda } = await import('../src/services/tiendaOnline.js');
const { publicarProductosWhatsapp, publicarCategoriaWhatsapp } = await import('../src/services/catalogoWhatsapp.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const P = `LU ${suf}`;
const SLUG_SOLO_WA = `lu-solo-whatsapp-${suf}`;
const respaldo = mkdtempSync(join(tmpdir(), 'lista-unica-'));

const estado = async (neg, id) => {
  const { rows: [r] } = await pool.query(
    `SELECT tp.publicado AS tienda, wp.publicado AS whatsapp, wp.origen, wp.actualizado_por, wp.updated_at::text AS wp_updated
       FROM menu_productos p
       LEFT JOIN tienda_productos tp ON tp.negocio_id = p.negocio_id AND tp.producto_id = p.id
       LEFT JOIN whatsapp_productos wp ON wp.negocio_id = p.negocio_id AND wp.producto_id = p.id
      WHERE p.negocio_id = $1 AND p.id = $2`, [neg, id]);
  return r;
};
const huella = async (neg) => (await pool.query('SELECT huella_carta_whatsapp($1::uuid) AS h', [neg])).rows[0].h;
const script = (nombre, args) => {
  const r = spawnSync(process.execPath, [join(OPS, nombre), ...args],
    { env: process.env, encoding: 'utf8', timeout: 60000 });
  return { codigo: r.status, salida: (r.stdout || '') + (r.stderr || '') };
};

async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}
async function limpiar() {
  // tienda_productos y whatsapp_productos caen en cascada con el producto.
  await del(`DELETE FROM menu_productos WHERE nombre LIKE 'LU %'`);
  await del(`DELETE FROM menu_categorias WHERE nombre LIKE 'LU %'`);
  await del(`DELETE FROM negocios WHERE slug LIKE 'lu-solo-whatsapp-%'`);
}

const ids = {};
let catA, catB, negSoloWa;
try {
  await limpiar();
  ({ rows: [catA] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,970) RETURNING id`, [NEG_A, `${P} Cat A`]));
  ({ rows: [catB] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,971) RETURNING id`, [NEG_B, `${P} Cat B`]));
  const prod = async (neg, cat, nombre) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,100,TRUE,FALSE,1) RETURNING id`, [neg, cat, `${P} ${nombre}`]);
    ids[nombre] = r.id;
  };
  for (const n of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho']) await prod(NEG_A, catA.id, n);
  await prod(NEG_B, catB.id, 'ajeno');
  const { rows: [usuario] } = await pool.query(
    `SELECT id FROM usuarios WHERE negocio_id = $1 ORDER BY created_at LIMIT 1`, [NEG_A]);

  await t('1. publicar en la TIENDA publica en WhatsApp; retirar retira (la fila de WhatsApp queda en FALSE)', async () => {
    const r = await publicarProductos(NEG_A, [ids.uno, ids.dos], true);
    assert.strictEqual(r.actualizados, 2);
    for (const k of ['uno', 'dos']) {
      const e = await estado(NEG_A, ids[k]);
      assert.strictEqual(e.tienda, true); assert.strictEqual(e.whatsapp, true, `${k} no llegó a WhatsApp`);
    }
    await publicarProductos(NEG_A, [ids.dos], false);
    const e = await estado(NEG_A, ids.dos);
    assert.strictEqual(e.tienda, false);
    assert.strictEqual(e.whatsapp, false, 'retirar de la tienda no lo retiró de WhatsApp (o borró la fila)');
  });

  await t('2. publicar en la página de WhatsApp publica en la TIENDA, con el autor registrado', async () => {
    await publicarProductosWhatsapp(NEG_A, [ids.tres], true, { actor: usuario?.id || null });
    let e = await estado(NEG_A, ids.tres);
    assert.strictEqual(e.whatsapp, true);
    assert.strictEqual(e.tienda, true, 'publicar en WhatsApp no lo publicó en la tienda');
    if (usuario) assert.strictEqual(e.actualizado_por, usuario.id, 'se perdió el autor del cambio');
    await publicarProductosWhatsapp(NEG_A, [ids.tres], false);
    e = await estado(NEG_A, ids.tres);
    assert.strictEqual(e.tienda, false, 'retirar en WhatsApp no lo retiró de la tienda');
    assert.strictEqual(e.whatsapp, false);
  });

  await t('3. una CATEGORÍA entera desde WhatsApp cambia la tienda de todos sus productos', async () => {
    await publicarCategoriaWhatsapp(NEG_A, catA.id, true);
    for (const k of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho']) {
      const e = await estado(NEG_A, ids[k]);
      assert.ok(e.tienda === true && e.whatsapp === true, `${k}: tienda=${e.tienda} whatsapp=${e.whatsapp}`);
    }
    await publicarCategoriaWhatsapp(NEG_A, catA.id, false);
    for (const k of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho']) {
      const e = await estado(NEG_A, ids[k]);
      assert.ok(e.tienda === false && e.whatsapp === false, `${k}: tienda=${e.tienda} whatsapp=${e.whatsapp}`);
    }
  });

  await t('4. editar un producto de la tienda: fila nueva publica en ambas; uno retirado sigue retirado en ambas', async () => {
    await pool.query('DELETE FROM tienda_productos WHERE negocio_id = $1 AND producto_id = $2', [NEG_A, ids.cuatro]);
    await pool.query('DELETE FROM whatsapp_productos WHERE negocio_id = $1 AND producto_id = $2', [NEG_A, ids.cuatro]);
    await actualizarProductoTienda(NEG_A, ids.cuatro, { badge: 'Nuevo' });
    let e = await estado(NEG_A, ids.cuatro);
    assert.strictEqual(e.tienda, true);
    assert.strictEqual(e.whatsapp, true, 'la fila nueva de la tienda no se reflejó en WhatsApp');
    await actualizarProductoTienda(NEG_A, ids.cinco, { badge: 'Oferta' });   // cinco está retirado (caso 3)
    e = await estado(NEG_A, ids.cinco);
    assert.strictEqual(e.tienda, false, 'editar el badge publicó un producto retirado');
    assert.strictEqual(e.whatsapp, false, 'editar el badge lo publicó en WhatsApp');
  });

  await t('5. sin cambio real no se reescribe WhatsApp: ni la fila ni la huella de la carta se mueven', async () => {
    await publicarProductos(NEG_A, [ids.seis], true);
    const antes = await estado(NEG_A, ids.seis);
    const hAntes = await huella(NEG_A);
    await new Promise(r => setTimeout(r, 30));
    await publicarProductos(NEG_A, [ids.seis], true);
    await actualizarProductoTienda(NEG_A, ids.seis, { destacado: true });
    const despues = await estado(NEG_A, ids.seis);
    assert.strictEqual(String(despues.wp_updated), String(antes.wp_updated), 'se reescribió una fila de WhatsApp que no cambió');
    assert.strictEqual(await huella(NEG_A), hAntes, 'la huella de la carta cambió sin cambiar la carta');
    // Y un cambio real sí la mueve (la revisión del menú debe caducar).
    await publicarProductos(NEG_A, [ids.siete], true);
    assert.notStrictEqual(await huella(NEG_A), hAntes, 'publicar un producto nuevo no movió la huella');
  });

  await t('6. aislamiento: ids de otro negocio no se escriben en ninguna de las dos tablas', async () => {
    const r1 = await publicarProductos(NEG_A, [ids.ajeno], true);
    const r2 = await publicarProductosWhatsapp(NEG_A, [ids.ajeno], true);
    const r3 = await publicarCategoriaWhatsapp(NEG_A, catB.id, true);
    assert.deepStrictEqual([r1.actualizados, r2.actualizados, r3.actualizados], [0, 0, 0]);
    const e = await estado(NEG_B, ids.ajeno);
    assert.ok(e.tienda == null && e.whatsapp == null, `se escribió en el otro negocio: ${JSON.stringify(e)}`);
  });

  await t('7. atómico: si el espejo de WhatsApp falla, la tienda tampoco cambia', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION lu_falla_espejo() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.producto_id = ${Number(ids.ocho)} THEN RAISE EXCEPTION 'espejo caído (prueba)'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER lu_falla_espejo BEFORE INSERT OR UPDATE ON whatsapp_productos
      FOR EACH ROW EXECUTE FUNCTION lu_falla_espejo()`);
    try {
      let error = null;
      try { await publicarProductos(NEG_A, [ids.ocho], true); } catch (e) { error = e; }
      assert.ok(error, 'la publicación no reportó el fallo del espejo');
      const e = await estado(NEG_A, ids.ocho);
      assert.strictEqual(e.tienda, false, 'la tienda quedó publicada con WhatsApp sin cambiar');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS lu_falla_espejo ON whatsapp_productos');
      await pool.query('DROP FUNCTION IF EXISTS lu_falla_espejo()');
    }
  });

  const { rows: [{ slug: SLUG_A }] } = await pool.query('SELECT slug FROM negocios WHERE id = $1', [NEG_A]);
  const diferencias = async () => (await pool.query(
    `SELECT p.id, COALESCE(tp.publicado, FALSE) AS tienda, COALESCE(wp.publicado, FALSE) AS whatsapp
       FROM menu_productos p
       LEFT JOIN tienda_productos tp ON tp.negocio_id = p.negocio_id AND tp.producto_id = p.id
       LEFT JOIN whatsapp_productos wp ON wp.negocio_id = p.negocio_id AND wp.producto_id = p.id
      WHERE p.negocio_id = $1 AND COALESCE(tp.publicado, FALSE) <> COALESCE(wp.publicado, FALSE)
      ORDER BY p.id`, [NEG_A])).rows;

  await t('8. emparejar: simulacro no cambia nada; --aplicar deja WhatsApp = tienda y guarda respaldo', async () => {
    // Desacuerdo como el de producción, escrito por fuera del espejo:
    // uno solo en WhatsApp, otro solo en la tienda (sin fila en WhatsApp).
    await pool.query(`UPDATE whatsapp_productos SET publicado = TRUE, origen = 'panel' WHERE negocio_id = $1 AND producto_id = $2`, [NEG_A, ids.dos]);
    await pool.query(`UPDATE tienda_productos SET publicado = TRUE WHERE negocio_id = $1 AND producto_id = $2`, [NEG_A, ids.tres]);
    await pool.query(`DELETE FROM whatsapp_productos WHERE negocio_id = $1 AND producto_id = $2`, [NEG_A, ids.tres]);
    const antes = await diferencias();
    assert.ok(antes.length >= 2, `el escenario no quedó en desacuerdo: ${JSON.stringify(antes)}`);

    const sim = script('alinear-whatsapp-con-tienda.mjs', [`--negocio=${SLUG_A}`, `--respaldo=${respaldo}`]);
    assert.strictEqual(sim.codigo, 0, sim.salida);
    assert.ok(/SIMULACRO/.test(sim.salida) && /salen de WhatsApp/.test(sim.salida) && /entran a WhatsApp/.test(sim.salida), sim.salida);
    assert.deepStrictEqual(await diferencias(), antes, 'el simulacro cambió la base');
    assert.strictEqual(readdirSync(respaldo).length, 0, 'el simulacro escribió un respaldo');

    const ap = script('alinear-whatsapp-con-tienda.mjs', [`--negocio=${SLUG_A}`, `--respaldo=${respaldo}`, '--aplicar']);
    assert.strictEqual(ap.codigo, 0, ap.salida);
    assert.deepStrictEqual(await diferencias(), [], 'quedaron diferencias tras emparejar');
    assert.strictEqual((await estado(NEG_A, ids.dos)).whatsapp, false, 'lo que no está en la tienda siguió en WhatsApp');
    assert.strictEqual((await estado(NEG_A, ids.tres)).whatsapp, true, 'lo publicado en la tienda no entró a WhatsApp');
    assert.strictEqual(readdirSync(respaldo).length, 1, 'no quedó el respaldo');
  });

  await t('9. revertir: simulacro no cambia nada; --aplicar devuelve WhatsApp exactamente a como estaba', async () => {
    const archivo = join(respaldo, readdirSync(respaldo)[0]);
    const guardado = JSON.parse(readFileSync(archivo, 'utf8'));
    const sim = script('revertir.mjs', [archivo]);
    assert.strictEqual(sim.codigo, 0, sim.salida);
    assert.deepStrictEqual(await diferencias(), [], 'el simulacro de reversa cambió la base');
    const ap = script('revertir.mjs', [archivo, '--aplicar']);
    assert.strictEqual(ap.codigo, 0, ap.salida);
    for (const f of guardado.filas) {
      const { rows } = await pool.query(
        `SELECT publicado, origen, actualizado_por FROM whatsapp_productos WHERE negocio_id = $1 AND producto_id = $2`,
        [f.negocio_id, f.producto_id]);
      if (!f.existia) { assert.strictEqual(rows.length, 0, `quedó la fila creada para ${f.producto_id}`); continue; }
      // updated_at no: lo fija el trigger set_updated_at en todo UPDATE.
      assert.strictEqual(rows[0].publicado, f.publicado);
      assert.strictEqual(rows[0].origen, f.origen);
      assert.strictEqual(rows[0].actualizado_por, f.actualizado_por);
    }
    assert.strictEqual((await estado(NEG_A, ids.dos)).whatsapp, true, 'no volvió el producto que solo estaba en WhatsApp');
  });

  await t('10. freno: un negocio con carta de WhatsApp y tienda vacía NO se empareja sin --forzar', async () => {
    ({ rows: [negSoloWa] } = await pool.query(
      `INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [`${P} Solo WhatsApp`, SLUG_SOLO_WA]));
    const { rows: [c] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,1) RETURNING id`, [negSoloWa.id, `${P} Cat Solo`]);
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,50,TRUE,FALSE,1) RETURNING id`, [negSoloWa.id, c.id, `${P} solo wa`]);
    await pool.query(`INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [negSoloWa.id, p.id]);
    const r = script('alinear-whatsapp-con-tienda.mjs', [`--negocio=${SLUG_SOLO_WA}`, `--respaldo=${respaldo}`, '--aplicar']);
    assert.notStrictEqual(r.codigo, 0, 'emparejó un negocio que se quedaría sin carta');
    assert.ok(/SIN carta/.test(r.salida), r.salida);
    assert.strictEqual((await estado(negSoloWa.id, p.id)).whatsapp, true, 'el freno dejó cambios a medias');
  });
} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  await limpiar();
  rmSync(respaldo, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-lista-unica-tienda-db: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
