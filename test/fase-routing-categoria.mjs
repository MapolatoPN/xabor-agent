// Routing multiestación CATEGORY-FIRST: enriquecimiento de categoría + su
// integración con el pipeline real de trabajos.
//
// El motor de routing (categoría/producto/documento, precedencia, dedup) ya
// está cubierto por test/fase-print-routing.mjs y fase-comanda-edge-exclusiva.
// AQUÍ se prueba lo NUEVO: `adjuntarCategorias` (deriva item.categoria de
// producto_id / nombre único, tenant-scoped, sin adivinar) y que un pedido cuyo
// snapshot NO trae categoría termine ruteado por estación tras el enrich.
//
// Uso: DATABASE_URL=... node test/fase-routing-categoria.mjs
import { randomUUID } from 'crypto';
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { crearEdge } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta, crearTrabajosDePedido, adjuntarCategorias } =
  await import('../src/services/impresionService.js');
const { DESTINOS } = await import('../src/services/impresionSelfService.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Fixtures: negocio + sucursal + menú + 4 impresoras + rutas ───────────────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`, [nombre, slug]);
  const { rows: [s] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [n.id]);
  return { negocioId: n.id, sucursalId: s.id };
}
async function limpiarNegocio(neg) {
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [neg.negocioId]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [neg.negocioId]).catch(() => {});
  await pool.query(`DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`, [neg.negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1`, [neg.negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1`, [neg.negocioId]).catch(() => {});
}
const catCache = new Map();
async function asegurarCategoria(negocioId, nombre) {
  const k = `${negocioId}:${nombre}`;
  if (catCache.has(k)) return catCache.get(k);
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0)
     ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  let id = rows[0]?.id;
  if (!id) { const r = await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre]); id = r.rows[0].id; }
  catCache.set(k, id); return id;
}
async function sembrarProducto(negocioId, categoriaNombre, productoNombre, precio = 100) {
  const catId = await asegurarCategoria(negocioId, categoriaNombre);
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`,
    [negocioId, catId, productoNombre, precio]);
  return rows[0].id;
}

const A = await montarNegocio('routing-cat-a', 'Obispado Routing Demo');
const B = await montarNegocio('routing-cat-b', 'Otro Negocio Demo');
await limpiarNegocio(A); await limpiarNegocio(B); catCache.clear();

// Menú de A: Chilaquiles Mixtos (CHILAQUILES), Café Americano (BEBIDAS), Waffle (DESAYUNOS)
const pidChila = await sembrarProducto(A.negocioId, 'CHILAQUILES', 'Chilaquiles Mixtos', 205);
const pidCafe  = await sembrarProducto(A.negocioId, 'BEBIDAS', 'Café Americano', 25);
const pidWaffle = await sembrarProducto(A.negocioId, 'DESAYUNOS', 'Waffle', 159);
// Nombre DUPLICADO en dos categorías → ambiguo por nombre
await sembrarProducto(A.negocioId, 'DESAYUNOS', 'Combo', 90);
await sembrarProducto(A.negocioId, 'BEBIDAS', 'Combo', 90);

// 4 impresoras + rutas (category-first + fallback comanda + caja)
const edgeA = await crearEdge(A.negocioId, { nombre: 'PC OBISPADO' });
const mkImp = (nombre) => crearImpresora(A.negocioId, { terminalId: edgeA.id, nombre, transporte: 'mock' });
const impChila = await mkImp('CHILAQUILES');
const impBebidas = await mkImp('BEBIDAS');
const impGeneral = await mkImp('COCINA GENERAL');
const impCaja = await mkImp('CAJA');
await crearRuta(A.negocioId, { impresoraId: impChila.id, ambito: 'categoria', clave: 'CHILAQUILES', modo: 'agregar' });
await crearRuta(A.negocioId, { impresoraId: impBebidas.id, ambito: 'categoria', clave: 'BEBIDAS', modo: 'agregar' });
await crearRuta(A.negocioId, { impresoraId: impGeneral.id, ambito: 'documento', clave: DESTINOS.cocina.clave }); // fallback
await crearRuta(A.negocioId, { impresoraId: impCaja.id, ambito: 'documento', clave: DESTINOS.caja.clave });

// ═══════════ A · adjuntarCategorias (enrich) ═══════════
await t('ENRICH', '1. producto_id válido → categoria correcta', async () => {
  const [i] = await adjuntarCategorias(A.negocioId, [{ producto_id: pidChila, nombre: 'lo que sea', cantidad: 1 }]);
  assert.strictEqual(i.categoria, 'CHILAQUILES');
  assert.strictEqual(i.nombre, 'lo que sea', 'no toca el nombre del snapshot');
});
await t('ENRICH', '2. producto_id de OTRO tenant → NO se adjunta categoria', async () => {
  const [i] = await adjuntarCategorias(B.negocioId, [{ producto_id: pidChila, nombre: 'X', cantidad: 1 }]);
  assert.strictEqual(i.categoria, undefined, 'un producto_id ajeno nunca revela su categoría cross-tenant');
});
await t('ENRICH', '3. sin producto_id + nombre único → categoria por nombre', async () => {
  const [i] = await adjuntarCategorias(A.negocioId, [{ nombre: 'Waffle', cantidad: 1 }]);
  assert.strictEqual(i.categoria, 'DESAYUNOS');
});
await t('ENRICH', '4. sin producto_id + nombre DUPLICADO → NO categoria (ambiguo)', async () => {
  const [i] = await adjuntarCategorias(A.negocioId, [{ nombre: 'Combo', cantidad: 1 }]);
  assert.strictEqual(i.categoria, undefined, '>1 producto con ese nombre → no se adivina');
});
await t('ENRICH', '5. producto inexistente → NO categoria (cae a Cocina General)', async () => {
  const [i] = await adjuntarCategorias(A.negocioId, [{ nombre: 'No Existe Nada', cantidad: 1 }]);
  assert.strictEqual(i.categoria, undefined);
});

// ═══════════ C · Pedido real → 3 trabajos por estación ═══════════
function pedidoBase(items) {
  return { negocioId: A.negocioId, canal: 'pos', modalidad: 'recoger',
    cliente: { nombre: 'Cliente Prueba', telefono: '8781234567' }, items, total: 264,
    id: `XAB-CAT${Date.now()}-${Math.floor(pasadas * 7 + fallidas)}` };
}
function porImpresora(resumen) {
  const m = {};
  for (const tr of resumen.creados) m[tr.impresora_nombre] = (tr.payload.items || []).map(i => i.producto);
  return m;
}

await t('PEDIDO', '12. Chilaquiles + Waffle + 2 Cafés → 3 trabajos separados por estación', async () => {
  const r = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido: pedidoBase([
    { producto_id: pidChila, nombre: 'Chilaquiles Mixtos', cantidad: 1 },
    { producto_id: pidWaffle, nombre: 'Waffle', cantidad: 1 },
    { producto_id: pidCafe, nombre: 'Café Americano', cantidad: 2 },
  ]) });
  const m = porImpresora(r);
  assert.strictEqual(r.creados.length, 3, `se esperaban 3 trabajos; hubo ${r.creados.length}: ${r.avisos.join(' | ')}`);
  assert.deepStrictEqual(m['CHILAQUILES'], ['Chilaquiles Mixtos']);
  assert.deepStrictEqual(m['BEBIDAS'], ['Café Americano']);
  assert.deepStrictEqual(m['COCINA GENERAL'], ['Waffle'], 'Waffle (DESAYUNOS, sin ruta) cae al fallback comanda');
});
await t('PEDIDO', '13. Caja NO recibe comanda de preparación', async () => {
  const r = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido: pedidoBase([
    { producto_id: pidChila, nombre: 'Chilaquiles Mixtos', cantidad: 1 },
    { producto_id: pidCafe, nombre: 'Café Americano', cantidad: 2 },
  ]) });
  const m = porImpresora(r);
  assert.ok(!('CAJA' in m), 'la impresora de Caja jamás recibe comanda de cocina');
});

// ═══════════ D · mismos productos, distintos orígenes → mismo routing ═══════════
await t('ORIGENES', '14-18. POS/presencial/api/voz/mesa con los mismos producto_id → mismo reparto', async () => {
  // Forma POS (producto_id+nombre) y forma canónica LLM (producto_id+nombre) son
  // equivalentes para el enrich: lo único que importa es producto_id.
  const formas = [
    { canal: 'pos',        items: [{ producto_id: pidChila, nombre: 'Chilaquiles Mixtos', cantidad: 1 }, { producto_id: pidCafe, nombre: 'Café Americano', cantidad: 2 }] },
    { canal: 'presencial', items: [{ producto_id: pidChila, nombre: 'CHILA', cantidad: 1 }, { producto_id: pidCafe, nombre: 'CAFE', cantidad: 2 }] },
    { canal: 'api',        items: [{ producto_id: pidChila, precio_unitario: 205, cantidad: 1 }, { producto_id: pidCafe, precio_unitario: 25, cantidad: 2 }] },
    { canal: 'voz',        items: [{ producto_id: pidChila, cantidad: 1 }, { producto_id: pidCafe, cantidad: 2 }] },
  ];
  for (const f of formas) {
    const r = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido: { ...pedidoBase(f.items), canal: f.canal, id: `XAB-${f.canal}${Date.now()}` } });
    const destinos = r.creados.map(tr => tr.impresora_nombre).sort();
    assert.deepStrictEqual(destinos, ['BEBIDAS', 'CHILAQUILES'], `${f.canal}: se esperaban Chilaquiles→CHILAQUILES y Café→BEBIDAS; hubo ${destinos.join(',')} | ${r.avisos.join(' | ')}`);
  }
});

// ═══════════ E · regresión mínima: enrich no rompe el caso sin menú ═══════════
await t('COMPAT', '19. items sin producto_id ni menú → sin categoria → fallback comanda intacto', async () => {
  // B no tiene menú ni impresoras; el enrich no debe romper ni inventar.
  const salida = await adjuntarCategorias(B.negocioId, [{ nombre: 'Cualquiera', cantidad: 1 }]);
  assert.strictEqual(salida[0].categoria, undefined);
  assert.strictEqual(salida.length, 1);
});
await t('COMPAT', '20. lista vacía → devuelve vacío sin tocar DB de más', async () => {
  const salida = await adjuntarCategorias(A.negocioId, []);
  assert.deepStrictEqual(salida, []);
});

// ── Limpieza ────────────────────────────────────────────────────────────────
await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = ANY($1)`, [[A.negocioId, B.negocioId]]).catch(() => {});
await limpiarNegocio(A); await limpiarNegocio(B);

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end?.().catch(() => {});
process.exit(fallidas ? 1 : 0);
