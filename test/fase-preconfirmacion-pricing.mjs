// PRECONFIRMACIÓN CON PRICING OFICIAL DEL BACKEND.
//
// Invariante: el total que ve el cliente antes de confirmar = el que confirma =
// el registrado. El LLM NUNCA calcula subtotal/descuento/total/extras; el bot
// solo presenta lo que devuelve previsualizarPedido (mismo pipeline que el
// registro: validarOrdenPropuesta → modificadores canónicos → calcularPromociones).
//
// Uso: DATABASE_URL=... node test/fase-preconfirmacion-pricing.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool } = await import('../src/services/database.js');
const { guardarPromocion } = await import('../src/services/tiendaPromociones.js');
const { previsualizarPedido, resumenPedidoOficial, registrarPedido } = await import('../src/orders/orderManager.js');
const { decidirConfirmacion } = await import('../src/agent/confirmacionPolicy.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixtures (negocio efímero para preview) ─────────────────────────────────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre])).rows[0].id;
}
async function producto(negocioId, catId, nombre, precio) {
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`, [negocioId, catId, nombre, precio]);
  return rows[0].id;
}
async function grupo(negocioId, productoId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,FALSE,0,0,0) RETURNING id`, [negocioId, productoId, nombre]);
  return rows[0].id;
}
async function opcion(negocioId, grupoId, nombre, precioExtra) {
  await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,0)`, [negocioId, grupoId, nombre, precioExtra]);
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG = await montarNegocio('preconf-a', 'Preconf A');
await limpiar(NEG);
const cat = await categoria(NEG, 'DESAYUNOS');
const pHot = await producto(NEG, cat, 'Hotcakes Tradicionales', 149);
const pAlm = await producto(NEG, cat, 'Almuerzo Americano', 189);
const gHot = await grupo(NEG, pHot, 'Toppings'); await opcion(NEG, gHot, 'Nutella', 30);
const gAlm = await grupo(NEG, pAlm, 'Extras');   await opcion(NEG, gAlm, 'Salchicha americana', 40);
let promoId = (await guardarPromocion(NEG, {
  nombre: 'Martes 2x1', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], productos: [pHot, pAlm],
})).id;

const orden = (items, extra = {}) => ({ canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo', items, ...extra });
const prev = (items, extra = {}) => previsualizarPedido(orden(items, extra), NEG, { canal: 'whatsapp' });

// ═══════════ TESTS ═══════════

await t('TEST 1 · CASO BASE: Hotcakes+Almuerzo → subtotal 338, desc 149, total 189', async () => {
  const v = await prev([{ nombre: 'Hotcakes Tradicionales', cantidad: 1 }, { nombre: 'Almuerzo Americano', cantidad: 1 }]);
  assert.ok(v.ok);
  assert.strictEqual(v.preview.subtotal, 338);
  assert.strictEqual(v.preview.descuento_total, 149);
  assert.strictEqual(v.preview.total, 189);
});

await t('TEST 2 · + Salchicha → subtotal 378, desc 149, total 229', async () => {
  const v = await prev([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  assert.strictEqual(v.preview.subtotal, 378);
  assert.strictEqual(v.preview.total, 229);
  const alm = v.preview.items.find(i => i.nombre === 'Almuerzo Americano');
  assert.strictEqual(alm.total_item, 229);
  // El preview lleva también el GRUPO de cada opción (XAB-0230): sin él el
  // resumen no puede separar proteínas de guarniciones.
  assert.deepStrictEqual(alm.modificadores, [{ grupo: 'Extras', nombre: 'Salchicha americana', precio: 40 }]);
});

await t('TEST 3 · dos modificadores (Nutella 30 + Salchicha 40) → subtotal 408, desc 149, total 259', async () => {
  const v = await prev([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Nutella'] },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  assert.strictEqual(v.preview.subtotal, 408);
  assert.strictEqual(v.preview.descuento_total, 149);
  assert.strictEqual(v.preview.total, 259);
});

await t('TEST 4 · GPT INVENTA total: la orden trae total 189 pero backend calcula 259', async () => {
  const v = await previsualizarPedido(orden([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Nutella'] },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ], { subtotal: 149, descuento: 149, total: 189 }), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.preview.total, 259, 'ignora el total del modelo; usa el oficial');
  const resumen = resumenPedidoOficial(v.preview);
  assert.ok(resumen.includes('Total: $259'), 'el resumen presenta el oficial');
  // El fake del modelo era el TOTAL 189; jamás debe presentarse como total.
  // (La base $189 del Almuerzo sí aparece legítimamente en el desglose.)
  assert.ok(!/Total:\s*\$189/.test(resumen), 'nunca el total inventado por el modelo');
});

await t('TEST 5 · modificador inventado → no se cobra; se reporta; total sigue oficial', async () => {
  const v = await prev([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Queso mágico'] },
  ]);
  assert.strictEqual(v.preview.total, 189, 'el extra inexistente no cambia el total');
  assert.ok((v.ajustes || []).some(a => a.tipo === 'modificador_no_reconocido'), 'se reporta el no reconocido');
});

await t('TEST 6 · cambio antes de confirmar: preview 259 → cambia promo → nuevo preview distinto', async () => {
  const items = [
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Nutella'] },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ];
  const p1 = await prev(items); assert.strictEqual(p1.preview.total, 259);
  // La promo deja de aplicar (se desactiva) ANTES de confirmar.
  await pool.query(`UPDATE tienda_promociones SET activa=FALSE WHERE id=$1`, [promoId]);
  const p2 = await prev(items);
  assert.notStrictEqual(p2.preview.total, p1.preview.total, 'el total cambió → brain pediría reconfirmar');
  assert.strictEqual(p2.preview.total, 408, 'sin promo: subtotal completo');
  await pool.query(`UPDATE tienda_promociones SET activa=TRUE WHERE id=$1`, [promoId]); // restaurar
});

await t('TEST 7 · quitar modificador: 229 → 189', async () => {
  const con = await prev([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  assert.strictEqual(con.preview.total, 229);
  const sin = await prev([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1 },
  ]);
  assert.strictEqual(sin.preview.total, 189);
});

await t('TEST 8 · presentación: subtotal/descuento/total del backend; promo como descuento, nunca "gratis"', async () => {
  const v = await prev([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Nutella'] },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  const txt = resumenPedidoOficial(v.preview);
  assert.ok(txt.includes('Subtotal: $408'));
  assert.ok(txt.includes('Martes 2x1: -$149'));
  assert.ok(txt.includes('Total: $259'));
  assert.ok(!/gratis/i.test(txt), 'no debe decir "gratis" (engañoso con extras)');
  assert.ok(/Nutella/.test(txt) && /Salchicha americana/.test(txt), 'lista los extras');
});

await t('TEST 9 · promo deja de estar activa entre preview y confirmación → nuevo total, sin promo', async () => {
  const items = [{ nombre: 'Hotcakes Tradicionales', cantidad: 1 }, { nombre: 'Almuerzo Americano', cantidad: 1 }];
  const p1 = await prev(items); assert.strictEqual(p1.preview.total, 189);
  await pool.query(`UPDATE tienda_promociones SET activa=FALSE WHERE id=$1`, [promoId]);
  const p2 = await prev(items);
  assert.strictEqual(p2.preview.promociones.length, 0, 'sin promociones aplicadas');
  assert.strictEqual(p2.preview.total, 338, 'total sin descuento');
  await pool.query(`UPDATE tienda_promociones SET activa=TRUE WHERE id=$1`, [promoId]);
});

await t('TEST 12 · los campos numéricos del LLM NO son autoridad (subtotal/descuento inventados se ignoran)', async () => {
  const v = await previsualizarPedido(orden(
    [{ nombre: 'Hotcakes Tradicionales', cantidad: 1 }, { nombre: 'Almuerzo Americano', cantidad: 1 }],
    { subtotal: 5, descuento: 0, total: 5 }), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.preview.subtotal, 338);
  assert.strictEqual(v.preview.descuento_total, 149);
  assert.strictEqual(v.preview.total, 189);
});

// ── ENFORCEMENT: WhatsApp exige preview oficial antes de registrar ──────────
await t('ENF 1 · WhatsApp + ORDEN_CONFIRMADA sin preview previo → NO registra, exige preview', async () => {
  // El total oficial se calcula igual (backend), pero la decisión es no registrar.
  const v = await prev([{ nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Nutella'] },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] }]);
  const d = decidirConfirmacion({ canal: 'whatsapp', prevTotal: undefined, nuevoTotal: v.preview.total });
  assert.strictEqual(d.accion, 'preview_requerido', 'sin preview previo no se registra en WhatsApp');
});

await t('ENF 2 · cliente confirma después (preview == confirmación) → registra', async () => {
  const d = decidirConfirmacion({ canal: 'whatsapp', prevTotal: 259, nuevoTotal: 259 });
  assert.strictEqual(d.accion, 'registrar');
});

await t('ENF 3 · LLM total falso 189 pero backend 259 → se muestra 259 y NO registra hasta confirmar', async () => {
  const v = await previsualizarPedido(orden(
    [{ nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Nutella'] },
     { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] }],
    { total: 189 }), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.preview.total, 259, 'total oficial, no el del modelo');
  const d = decidirConfirmacion({ canal: 'whatsapp', prevTotal: undefined, nuevoTotal: v.preview.total });
  assert.strictEqual(d.accion, 'preview_requerido', 'no registra el 189; exige confirmar el 259');
  assert.ok(resumenPedidoOficial(v.preview).includes('Total: $259'));
  // Tras mostrar el preview (prevTotal=259) y confirmar → registra el 259.
  assert.strictEqual(decidirConfirmacion({ canal: 'whatsapp', prevTotal: 259, nuevoTotal: 259 }).accion, 'registrar');
});

await t('ENF 4 · preview perdido por reinicio (prevTotal null) → NO registra silenciosamente; re-preview', async () => {
  assert.strictEqual(decidirConfirmacion({ canal: 'whatsapp', prevTotal: null, nuevoTotal: 259 }).accion, 'preview_requerido');
});

await t('ENF 5 · canal NO-WhatsApp (voz/test/api) conserva confirmación directa', async () => {
  for (const canal of ['voz', 'test', 'api']) {
    assert.strictEqual(decidirConfirmacion({ canal, prevTotal: undefined, nuevoTotal: 259 }).accion, 'registrar', `${canal} directo`);
  }
});

await t('ENF 6 · cambio de total entre preview y confirmación (cualquier canal) → reconfirmar', async () => {
  assert.strictEqual(decidirConfirmacion({ canal: 'whatsapp', prevTotal: 259, nuevoTotal: 269 }).accion, 'reconfirmar_cambio');
  assert.strictEqual(decidirConfirmacion({ canal: 'voz', prevTotal: 259, nuevoTotal: 269 }).accion, 'reconfirmar_cambio');
});

// ── TEST 10 + 11: persistencia real (SEED negocioA) — preview == registrado ──
const NEG_S = SEED.negocioA;
let snapMetodos, snapModo, catS, prodHotS, prodAlmS;
async function setupSeed() {
  snapMetodos = (await pool.query(`SELECT * FROM metodos_pago WHERE negocio_id=$1`, [NEG_S])).rows;
  snapModo = (await pool.query(`SELECT valor FROM configuracion WHERE clave='modo_pedidos' AND negocio_id=$1`, [NEG_S])).rows;
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id=$1`, [NEG_S]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id,tipo,habilitado,orden,disponible_para_bot) VALUES ($1,'efectivo',TRUE,1,TRUE)`, [NEG_S]);
  await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'modo_pedidos','transaccional')
    ON CONFLICT (negocio_id,clave) DO UPDATE SET valor='transaccional'`, [NEG_S]);
  const { rows: [c] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,'PP Cat (test)',TRUE,991) RETURNING id`, [NEG_S]);
  catS = c.id;
  prodHotS = await producto(NEG_S, catS, 'PP Hotcakes', 149);
  prodAlmS = await producto(NEG_S, catS, 'PP Almuerzo', 189);
  const g = await grupo(NEG_S, prodAlmS, 'PP Extras'); await opcion(NEG_S, g, 'PP Salchicha', 40);
  await guardarPromocion(NEG_S, { nombre: 'PP 2x1', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp', 'pos'], productos: [prodHotS, prodAlmS] });
}
async function teardownSeed() {
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG_S, '8990001111']).catch(()=>{});
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1 AND nombre='PP 2x1'`, [NEG_S]).catch(()=>{});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1 AND nombre LIKE 'PP %'`, [NEG_S]).catch(()=>{});
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1 AND nombre LIKE 'PP %'`, [NEG_S]).catch(()=>{});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'PP %'`, [NEG_S]).catch(()=>{});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'PP %'`, [NEG_S]).catch(()=>{});
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id=$1`, [NEG_S]).catch(()=>{});
  for (const m of (snapMetodos||[])) await pool.query(
    `INSERT INTO metodos_pago (negocio_id,tipo,habilitado,orden,disponible_para_bot,disponible_para_operador,instrucciones,integracion_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (negocio_id,tipo) DO NOTHING`,
    [m.negocio_id,m.tipo,m.habilitado,m.orden,m.disponible_para_bot,m.disponible_para_operador,m.instrucciones,m.integracion_id]).catch(()=>{});
  await pool.query(`DELETE FROM configuracion WHERE clave='modo_pedidos' AND negocio_id=$1`, [NEG_S]).catch(()=>{});
  if ((snapModo||[]).length) await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'modo_pedidos',$2)`, [NEG_S, snapModo[0].valor]).catch(()=>{});
}

await setupSeed();
await t('TEST 10 · PERSISTENCIA: el pedido registrado == preview (total, descuento, modificador)', async () => {
  const ord = {
    cliente: { nombre: 'Cliente PP', telefono: '8990001111', calle: null, colonia: null, entre_calles: null },
    modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp', negocioId: NEG_S,
    items: [
      { nombre: 'PP Hotcakes', cantidad: 1 },
      { nombre: 'PP Almuerzo', cantidad: 1, modificadores: ['PP Salchicha'] },
    ],
  };
  const pv = await previsualizarPedido(ord, NEG_S, { canal: 'whatsapp' });
  assert.ok(pv.ok); assert.strictEqual(pv.preview.total, 229);
  const pedido = await registrarPedido(ord, 'whatsapp');
  const folio = pedido.folio || pedido.id;
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG_S]);
  assert.ok(rows[0], `el pedido ${folio} debe estar persistido`);
  const datos = rows[0].datos;
  assert.strictEqual(datos.total, pv.preview.total, 'total registrado == preview');
  assert.strictEqual(datos.descuento, pv.preview.descuento_total, 'descuento registrado == preview');
  assert.strictEqual(datos.subtotal, pv.preview.subtotal, 'subtotal registrado == preview');
  const alm = datos.items.find(i => i.nombre === 'PP Almuerzo');
  assert.ok(alm.modificadores?.some(m => m.opcion === 'PP Salchicha'), 'el modificador se persiste');
  assert.ok(Array.isArray(datos.promociones) && datos.promociones.length === 1, 'snapshot de promoción');
});

await t('TEST 11 · E2E de pipeline: preview y confirmación producen el MISMO total (registrable)', async () => {
  const ord = {
    cliente: { nombre: 'Cliente PP', telefono: '8990001111', calle: null, colonia: null, entre_calles: null },
    modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp', negocioId: NEG_S,
    items: [{ nombre: 'PP Hotcakes', cantidad: 1 }, { nombre: 'PP Almuerzo', cantidad: 1, modificadores: ['PP Salchicha'] }],
  };
  const preview = await previsualizarPedido(ord, NEG_S, { canal: 'whatsapp' });   // turno preview
  const confirm = await previsualizarPedido(ord, NEG_S, { canal: 'whatsapp' });   // turno confirmación (re-preview)
  assert.strictEqual(preview.preview.total, confirm.preview.total, 'sin cambios: mismo total → se registra sin reconfirmar');
  assert.strictEqual(confirm.preview.total, 229);
});
await teardownSeed();

// ═══════════ RESUMEN ═══════════
await limpiar(NEG);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
