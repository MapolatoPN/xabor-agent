// Rappi queda igual a la lista única: al subir el menú se APAGA por SKU lo que
// no va y se PRENDE lo que sí (rappiDisponibilidad.js).
//
// Por qué existe: POST /menu de Rappi crea o actualiza, pero no borra. El
// 2026-10-08 se subieron 60 productos y en Rappi siguieron los 34 de una
// subida anterior (envíos, extras, NONNA MAYE). Esta suite NO llama a Rappi:
// `fetch` se sustituye y se inspecciona cada petición.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const suf = Date.now().toString().slice(-6);
// La tienda GLOBAL existe a propósito: nada de esta suite debe ir a ella.
process.env.RAPPI_STORE_ID = `GLOBAL_${suf}`;

const { pool } = await import('../src/services/database.js');
const { construirCatalogoRappi, actualizarDisponibilidadTienda, MAX_SKUS_DISPONIBILIDAD } = await import('../src/services/rappi-api.js');
const { sincronizarDisponibilidadRappi, skusFueraDelCatalogo } = await import('../src/services/rappiDisponibilidad.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const STORE_A = `RD_A_${suf}`;
const P = `RD ${suf}`;

// ── Rappi falso ──────────────────────────────────────────────────────────
const peticiones = [];
let fallarCon = null;   // (cuerpo) => true para responder 500
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/token/login')) {
    return new Response(JSON.stringify({ access_token: 'token-prueba', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('/availability/stores/items')) {
    const cuerpo = JSON.parse(opts.body);
    peticiones.push({ metodo: opts.method, cuerpo });
    if (fallarCon && fallarCon(cuerpo)) return new Response('{"message":"falla de prueba"}', { status: 500 });
    return new Response('{"message":"Items successfully updated"}', { status: 200 });
  }
  throw new Error(`petición inesperada a ${u}`);
};

async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}
async function limpiar() {
  await del(`DELETE FROM menu_productos WHERE nombre LIKE 'RD %'`);
  await del(`DELETE FROM menu_categorias WHERE nombre LIKE 'RD %'`);
}

const ids = {};
try {
  await limpiar();
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,980) RETURNING id`, [NEG_A, `${P} Cat`]);
  const { rows: [catB] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,981) RETURNING id`, [NEG_B, `${P} Cat B`]);
  const prod = async (neg, c, clave, { codigo = null, agotado = false, opciones = null, tienda = true } = {}) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, precio, disponible, agotado, orden, opciones)
       VALUES ($1,$2,$3,$4,100,TRUE,$5,1,$6) RETURNING id`,
      [neg, c, codigo, `${P} ${clave}`, agotado, opciones ? JSON.stringify(opciones) : null]);
    if (tienda) await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [neg, r.id]);
    ids[clave] = r.id;
  };
  await prod(NEG_A, cat.id, 'publicado');
  await prod(NEG_A, cat.id, 'conCodigo', { codigo: `RDCOD${suf}` });
  await prod(NEG_A, cat.id, 'fueraDeTienda', { tienda: false });
  await prod(NEG_A, cat.id, 'agotado', { agotado: true });
  await prod(NEG_A, cat.id, 'envio', { opciones: { tipo_item: 'envio' } });
  await prod(NEG_B, catB.id, 'ajeno');

  const catalogo = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
  const skuDe = (clave) => (clave === 'conCodigo' ? `RDCOD${suf}` : `XB-${ids[clave]}`);
  const enviados = (clave) => peticiones.flatMap(p => p.cuerpo.flatMap(x => x.items[clave] || []));

  await t('1. apaga lo que NO va (fuera de la tienda, agotado, envío) y prende lo que sí', async () => {
    peticiones.length = 0;
    const r = await sincronizarDisponibilidadRappi(NEG_A, STORE_A, catalogo);
    const apagados = enviados('turn_off'), prendidos = enviados('turn_on');
    for (const c of ['fueraDeTienda', 'agotado', 'envio']) assert.ok(apagados.includes(skuDe(c)), `no apagó ${c}`);
    for (const c of ['publicado', 'conCodigo']) {
      assert.ok(prendidos.includes(skuDe(c)), `no prendió ${c}`);
      assert.ok(!apagados.includes(skuDe(c)), `apagó ${c}, que sí va en el catálogo`);
    }
    assert.deepStrictEqual(r.errores, []);
    assert.strictEqual(r.encendidos, catalogo.items.length);
  });

  await t('2. va a la tienda del NEGOCIO, nunca a la global, y nunca toca productos de otro negocio', async () => {
    assert.ok(peticiones.length > 0);
    for (const p of peticiones) {
      assert.strictEqual(p.metodo, 'PUT');
      assert.deepStrictEqual(p.cuerpo.map(x => x.store_integration_id), [STORE_A], 'fue a otra tienda');
    }
    assert.ok(!enviados('turn_off').includes(`XB-${ids.ajeno}`) && !enviados('turn_on').includes(`XB-${ids.ajeno}`),
      'tocó un producto de otro negocio');
    const fuera = await skusFueraDelCatalogo(NEG_A, catalogo);
    assert.ok(!fuera.includes(`XB-${ids.ajeno}`));
  });

  await t('3. apagar y prender van en peticiones separadas: si falla apagar, igual se prende (y se reporta)', async () => {
    for (const p of peticiones) {
      const claves = Object.keys(p.cuerpo[0].items);
      assert.strictEqual(claves.length, 1, `una petición mezcló ${claves.join('+')}`);
    }
    peticiones.length = 0;
    fallarCon = (cuerpo) => Boolean(cuerpo[0].items.turn_off);
    try {
      const r = await sincronizarDisponibilidadRappi(NEG_A, STORE_A, catalogo);
      assert.strictEqual(r.apagados, 0);
      assert.ok(r.errores.some(e => /^turn_off:/.test(e)), `no reportó el fallo: ${JSON.stringify(r.errores)}`);
      assert.strictEqual(r.encendidos, catalogo.items.length, 'el fallo de apagar frenó el prender');
    } finally { fallarCon = null; }
  });

  await t('4. lotes de hasta 100 SKUs por petición (tope de Rappi)', async () => {
    peticiones.length = 0;
    const skus = Array.from({ length: 250 }, (_, i) => `SKU-${i}`);
    const r = await actualizarDisponibilidadTienda(STORE_A, { apagar: skus });
    assert.strictEqual(MAX_SKUS_DISPONIBILIDAD, 100);
    assert.strictEqual(peticiones.length, 3);
    assert.ok(peticiones.every(p => p.cuerpo[0].items.turn_off.length <= 100));
    assert.strictEqual(r.apagados, 250);
    assert.deepStrictEqual(enviados('turn_off').sort(), [...skus].sort());
  });

  await t('5. «Subir menú»: sincroniza tras subir, avisa si Rappi rechaza, y traduce «blocked for processing»', async () => {
    const SERVER = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
    const ini = SERVER.indexOf("app.post('/api/admin/rappi/subir-menu'");
    const ruta = SERVER.slice(ini, SERVER.indexOf('\n});', ini));
    const subir = ruta.indexOf('await subirCatalogo(catalogo)');
    const sync = ruta.indexOf('await sincronizarDisponibilidadRappi(req.negocioId, storeId, catalogo)');
    assert.ok(subir > 0 && sync > subir, 'la ruta no sincroniza la disponibilidad después de subir');
    assert.ok(/if \(disponibilidad\.errores\.length\) \{\s*return res\.status\(502\)/.test(ruta),
      'un rechazo de Rappi al apagar no llega al panel');
    assert.ok(/blocked for processing[\s\S]{0,80}res\.status\(409\)/.test(ruta), 'no traduce el bloqueo de Rappi');
  });
} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-rappi-disponibilidad: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
