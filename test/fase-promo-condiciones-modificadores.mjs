// PROMOCIONES CONDICIONADAS POR MODIFICADORES.
//
// Una promoción por productos específicos puede exigir además que ciertos
// GRUPOS de modificadores cumplan condiciones (Salsa Roja/Verde, Proteína
// Pollo, 2 guarniciones). La elegibilidad se evalúa POR UNIDAD sobre los
// modificadores CANÓNICOS (IDs reales del negocio); la IA nunca decide. Caso
// real: "Miércoles Chilaquiles — segundo al 50%".
//
// Uso: DATABASE_URL=... node test/fase-promo-condiciones-modificadores.mjs
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool } = await import('../src/services/database.js');
const { guardarPromocion, listarPromociones, calcularPromociones, cumpleCondicionesModificadores,
        describirPromocionesVigentes, eliminarPromocion } = await import('../src/services/tiendaPromociones.js');
const { previsualizarPedido, registrarPedido } = await import('../src/orders/orderManager.js');
const { recalcularItemsDesdeMenu } = await import('../src/services/posEnvios.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
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
async function opcion(negocioId, grupoId, nombre, precioExtra = 0) {
  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [negocioId, grupoId, nombre, precioExtra]);
  return rows[0].id;
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG = await montarNegocio('promo-cond-a', 'Promo Cond A');
const NEG_B = await montarNegocio('promo-cond-b', 'Promo Cond B');
await limpiar(NEG); await limpiar(NEG_B);

const cat = await categoria(NEG, 'FUERTES');
const pChila = await producto(NEG, cat, 'Chilaquiles', 180);
const gSalsa = await grupo(NEG, pChila, 'Salsa');
const oRoja = await opcion(NEG, gSalsa, 'Roja');
const oVerde = await opcion(NEG, gSalsa, 'Verde');
const oSuiza = await opcion(NEG, gSalsa, 'Suiza');
const gProte = await grupo(NEG, pChila, 'Proteína');
const oPollo = await opcion(NEG, gProte, 'Pollo');
const oRes = await opcion(NEG, gProte, 'Res');
const gGuarn = await grupo(NEG, pChila, 'Guarniciones sencillas');
const oFrijoles = await opcion(NEG, gGuarn, 'Frijoles');
const oPapa = await opcion(NEG, gGuarn, 'Papa');
const oArroz = await opcion(NEG, gGuarn, 'Arroz');
const oQueso = await opcion(NEG, gGuarn, 'Queso extra', 30); // guarnición con costo (extra)

// Negocio B: producto/grupo/opción ajenos (para aislamiento).
const catB = await categoria(NEG_B, 'OTROS');
const pChilaB = await producto(NEG_B, catB, 'Chilaquiles B', 180);
const gSalsaB = await grupo(NEG_B, pChilaB, 'Salsa B');
const oRojaB = await opcion(NEG_B, gSalsaB, 'Roja B');

// Condiciones del caso Mapolato (Salsa una_de Roja/Verde; Proteína incluye
// Pollo; Guarniciones exactamente 2).
const CONDS = [
  { productoId: pChila, grupoId: gSalsa, operador: 'una_de', optionIds: [oRoja, oVerde] },
  { productoId: pChila, grupoId: gProte, operador: 'incluye', optionIds: [oPollo] },
  { productoId: pChila, grupoId: gGuarn, operador: 'cantidad', min: 2, max: 2 },
];
// Forma NORMALIZADA (snake_case) tal como la persiste guardarPromocion y la lee
// el motor — es lo que recibe cumpleCondicionesModificadores.
const CONDS_SNAKE = [
  { producto_id: pChila, grupo_id: gSalsa, operador: 'una_de', option_ids: [oRoja, oVerde] },
  { producto_id: pChila, grupo_id: gProte, operador: 'incluye', option_ids: [oPollo] },
  { producto_id: pChila, grupo_id: gGuarn, operador: 'cantidad', min: 2, max: 2 },
];
async function crearPromoChila(over = {}) {
  return (await guardarPromocion(NEG, {
    nombre: 'Miércoles Chilaquiles 50%', tipo: 'segundo_descuento', valor: 50, automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp', 'pos'], productos: [pChila],
    condicionesModificadores: over.condiciones || CONDS,
    ...over.promo,
  })).id;
}
// Item canónico de un Chilaquiles con ciertas opciones (modificadores canónicos).
const mod = (grupoId, opcionId, precio = 0) => ({ grupo_id: grupoId, opcion: String(opcionId), opcion_id: opcionId, precio_extra: precio });
const chila = (mods, { extra = 0, cantidad = 1, base = 180 } = {}) => ({
  producto_id: pChila, categoria_id: cat, precio_base: base, precio_unitario: base + extra, cantidad, modificadores: mods,
});
const elegibleRoja = () => chila([mod(gSalsa, oRoja), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
const elegibleVerde = () => chila([mod(gSalsa, oVerde), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
const calc = (items) => calcularPromociones({
  negocioId: NEG, subtotal: items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0),
  items, canal: 'whatsapp', modalidad: 'recoger', timezone: 'UTC', ahora: new Date('2024-01-03T10:00:00Z'),
});
async function borra() { await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG]); }

// ═══════════ CONDICIONES POR UNIDAD (cumpleCondicionesModificadores) ═══════════
await t('1 · una_de Roja → elegible', () => {
  assert.strictEqual(cumpleCondicionesModificadores(elegibleRoja(), CONDS_SNAKE).eligible, true);
});
await t('2 · una_de Verde → elegible', () => {
  assert.strictEqual(cumpleCondicionesModificadores(elegibleVerde(), CONDS_SNAKE).eligible, true);
});
await t('3 · Suiza → NO elegible', () => {
  const it = chila([mod(gSalsa, oSuiza), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
  assert.strictEqual(cumpleCondicionesModificadores(it, CONDS_SNAKE).eligible, false);
});
await t('4 · Pollo requerido presente → pasa', () => {
  const it = chila([mod(gSalsa, oRoja), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
  assert.strictEqual(cumpleCondicionesModificadores(it, [{ grupo_id: gProte, operador: 'incluye', option_ids: [oPollo] }]).eligible, true);
});
await t('5 · Pollo ausente → falla', () => {
  const it = chila([mod(gSalsa, oRoja), mod(gProte, oRes), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
  assert.strictEqual(cumpleCondicionesModificadores(it, CONDS_SNAKE).eligible, false);
});
await t('6 · cantidad exacta 2 guarniciones → pasa', () => {
  const it = chila([mod(gSalsa, oRoja), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
  assert.strictEqual(cumpleCondicionesModificadores(it, [{ grupo_id: gGuarn, operador: 'cantidad', min: 2, max: 2 }]).eligible, true);
});
await t('7 · 1 guarnición → falla (cantidad exacta 2)', () => {
  const it = chila([mod(gSalsa, oRoja), mod(gProte, oPollo), mod(gGuarn, oFrijoles)]);
  assert.strictEqual(cumpleCondicionesModificadores(it, [{ grupo_id: gGuarn, operador: 'cantidad', min: 2, max: 2 }]).eligible, false);
});
await t('8 · condiciones múltiples AND: falla si una sola no se cumple', () => {
  const conds = CONDS_SNAKE;
  const casiOk = chila([mod(gSalsa, oRoja), mod(gProte, oPollo), mod(gGuarn, oFrijoles)]); // solo 1 guarnición
  const r = cumpleCondicionesModificadores(casiOk, conds);
  assert.strictEqual(r.eligible, false);
  assert.ok(r.failedConditions.some(f => Number(f.grupo_id) === Number(gGuarn)), 'reporta la condición fallida');
});

// ═══════════ MOTOR (calcularPromociones con condiciones) ═══════════
await t('9 · dos unidades elegibles (Roja + Verde) → segundo al 50% (90)', async () => {
  await crearPromoChila();
  const r = await calc([elegibleRoja(), elegibleVerde()]);
  assert.strictEqual(r.descuento, 90, `50% de 180 = 90; fue ${r.descuento}`);
  assert.strictEqual(r.aplicadas[0]?.tipo, 'segundo_descuento');
  await borra();
});
await t('10 · una elegible (Roja) + una NO (Suiza) → descuento 0 (no hay pareja)', async () => {
  await crearPromoChila();
  const noeleg = chila([mod(gSalsa, oSuiza), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)]);
  const r = await calc([elegibleRoja(), noeleg]);
  assert.strictEqual(r.descuento, 0);
  await borra();
});
await t('11 · extras NO reciben descuento (50% solo sobre precio base)', async () => {
  await crearPromoChila();
  // Uno con Queso extra (+30) pero sigue cumpliendo (2 guarniciones: Frijoles+Queso).
  const conExtra = chila([mod(gSalsa, oRoja), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oQueso, 30)], { extra: 30 });
  const r = await calc([elegibleVerde(), conExtra]);
  assert.strictEqual(r.descuento, 90, '50% de la base 180 = 90, jamás sobre 210');
  await borra();
});
await t('12 · 3 unidades elegibles → un solo beneficio (buy2/benefit1)', async () => {
  await crearPromoChila();
  const r = await calc([elegibleRoja(), elegibleVerde(), elegibleRoja()]);
  assert.strictEqual(r.descuento, 90, 'floor(3/2)=1 beneficio');
  await borra();
});
await t('13 · 4 unidades elegibles → dos beneficios (180)', async () => {
  await crearPromoChila();
  const r = await calc([elegibleRoja(), elegibleVerde(), elegibleRoja(), elegibleVerde()]);
  assert.strictEqual(r.descuento, 180, 'floor(4/2)=2 beneficios × 90');
  await borra();
});

// ═══════════ GUARDAR: validación y aislamiento (fail-closed) ═══════════
await t('14 · option_id AJENO (de otro negocio) → imposible guardar (CONDICION_OPCION_AJENA)', async () => {
  await assert.rejects(() => guardarPromocion(NEG, {
    nombre: 'X', tipo: 'segundo_descuento', valor: 50, automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp'], productos: [pChila],
    condicionesModificadores: [{ productoId: pChila, grupoId: gSalsa, operador: 'una_de', optionIds: [oRojaB] }],
  }), (e) => e.codigo === 'CONDICION_OPCION_AJENA');
  assert.strictEqual((await listarPromociones(NEG)).length, 0);
});
await t('15 · grupo AJENO → imposible guardar (CONDICION_GRUPO_AJENO)', async () => {
  await assert.rejects(() => guardarPromocion(NEG, {
    nombre: 'X', tipo: 'segundo_descuento', valor: 50, automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp'], productos: [pChila],
    condicionesModificadores: [{ productoId: pChila, grupoId: gSalsaB, operador: 'una_de', optionIds: [oRoja] }],
  }), (e) => e.codigo === 'CONDICION_GRUPO_AJENO');
});
await t('16 · producto de la condición que NO participa → imposible (CONDICION_PRODUCTO_AJENO)', async () => {
  await assert.rejects(() => guardarPromocion(NEG, {
    nombre: 'X', tipo: 'segundo_descuento', valor: 50, automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp'], productos: [pChila],
    condicionesModificadores: [{ productoId: pChilaB, grupoId: gSalsaB, operador: 'una_de', optionIds: [oRojaB] }],
  }), (e) => e.codigo === 'CONDICION_PRODUCTO_AJENO');
});
await t('extra · guardar OK persiste condiciones y se releen al editar', async () => {
  const id = await crearPromoChila();
  const p = (await listarPromociones(NEG)).find(x => x.id === id);
  assert.ok(Array.isArray(p.condicionesModificadores) && p.condicionesModificadores.length === 3);
  const salsa = p.condicionesModificadores.find(c => Number(c.grupo_id) === Number(gSalsa));
  assert.strictEqual(salsa.operador, 'una_de');
  assert.deepStrictEqual([...salsa.option_ids].map(Number).sort(), [oRoja, oVerde].sort());
  await eliminarPromocion(NEG, id); await borra();
});

// ═══════════ PREVIEW + descripción + oportunidad (E2E path LLM) ═══════════
const ordenChila = (items) => ({ canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo', items });
await t('17 · PREVIEW oficial refleja la promo condicionada (2 elegibles → -90)', async () => {
  await crearPromoChila();
  const v = await previsualizarPedido(ordenChila([
    { nombre: 'Chilaquiles', cantidad: 1, modificadores: ['Roja', 'Pollo', 'Frijoles', 'Papa'] },
    { nombre: 'Chilaquiles', cantidad: 1, modificadores: ['Verde', 'Pollo', 'Frijoles', 'Papa'] },
  ]), NEG, { canal: 'whatsapp' });
  assert.ok(v.ok);
  assert.strictEqual(v.preview.subtotal, 360);
  assert.strictEqual(v.preview.descuento_total, 90, 'segundo al 50% sobre base');
  assert.strictEqual(v.preview.total, 270);
  await borra();
});
await t('18 · PREVIEW no aplica si un Chilaquiles no cumple (Suiza) → sin descuento', async () => {
  await crearPromoChila();
  const v = await previsualizarPedido(ordenChila([
    { nombre: 'Chilaquiles', cantidad: 1, modificadores: ['Roja', 'Pollo', 'Frijoles', 'Papa'] },
    { nombre: 'Chilaquiles', cantidad: 1, modificadores: ['Suiza', 'Pollo', 'Frijoles', 'Papa'] },
  ]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.preview.descuento_total, 0, 'solo 1 elegible → sin pareja');
  await borra();
});
await t('19 · descripción informativa incluye Roja/Verde, Pollo y guarniciones', async () => {
  await crearPromoChila();
  const promos = await describirPromocionesVigentes(NEG, { canal: 'whatsapp', ahora: new Date('2024-01-03T10:00:00Z'), timezone: 'UTC' });
  const p = promos.find(x => x.nombre === 'Miércoles Chilaquiles 50%');
  assert.ok(p, 'la promo aparece (miércoles)');
  const txt = p.condicionesTexto + ' ' + p.participantesTexto;
  assert.ok(/Roja/.test(txt) && /Verde/.test(txt), 'salsas');
  assert.ok(/Pollo/.test(txt), 'proteína');
  assert.ok(/Guarniciones sencillas/.test(txt), 'guarniciones');
  await borra();
});
await t('20 · oportunidad SOLO si la unidad actual es elegible', async () => {
  await crearPromoChila();
  // 1 elegible → sugiere agregar 1 más.
  const rOk = await calc([elegibleRoja()]);
  assert.ok(rOk.oportunidades.some(o => o.codigo === 'ADD_ONE_MORE_ELIGIBLE_ITEM'), 'elegible → oportunidad');
  // 1 no elegible (Suiza) → NO sugiere (ni siquiera es participante)
  const rNo = await calc([chila([mod(gSalsa, oSuiza), mod(gProte, oPollo), mod(gGuarn, oFrijoles), mod(gGuarn, oPapa)])]);
  assert.strictEqual(rNo.oportunidades.length, 0, 'no elegible → sin oportunidad');
  await borra();
});

// ═══════════ POS: MISMA regla que WhatsApp (transversal) ═══════════
// El endpoint POS arma los items con recalcularItemsDesdeMenu (modificadores
// canónicos por IDs) y los pasa al MISMO calcularPromociones. Cero duplicación.
async function posDesc(crudos) {
  const { items, subtotal } = await recalcularItemsDesdeMenu(NEG, crudos);
  const promo = await calcularPromociones({ negocioId: NEG, subtotal, items, canal: 'pos', modalidad: 'recoger', timezone: 'UTC', ahora: new Date('2024-01-03T10:00:00Z') });
  return { subtotal, descuento: promo.descuento, total: subtotal - promo.descuento };
}
const cRoja = { producto_id: pChila, cantidad: 1, modificadores: [oRoja, oPollo, oFrijoles, oPapa] };
const cVerde = { producto_id: pChila, cantidad: 1, modificadores: [oVerde, oPollo, oFrijoles, oPapa] };

await t('POS 1 · 2 Chilaquiles elegibles (Roja+Verde) → segundo al 50% (90)', async () => {
  await crearPromoChila();
  const r = await posDesc([cRoja, cVerde]);
  assert.strictEqual(r.subtotal, 360); assert.strictEqual(r.descuento, 90); assert.strictEqual(r.total, 270);
  await borra();
});
await t('POS 2 · Roja válido + Suiza → descuento 0', async () => {
  await crearPromoChila();
  const r = await posDesc([cRoja, { producto_id: pChila, cantidad: 1, modificadores: [oSuiza, oPollo, oFrijoles, oPapa] }]);
  assert.strictEqual(r.descuento, 0);
  await borra();
});
await t('POS 3 · falta Pollo → descuento 0', async () => {
  await crearPromoChila();
  const r = await posDesc([cRoja, { producto_id: pChila, cantidad: 1, modificadores: [oVerde, oRes, oFrijoles, oPapa] }]);
  assert.strictEqual(r.descuento, 0);
  await borra();
});
await t('POS 4 · solo 1 guarnición → descuento 0', async () => {
  await crearPromoChila();
  const r = await posDesc([cRoja, { producto_id: pChila, cantidad: 1, modificadores: [oVerde, oPollo, oFrijoles] }]);
  assert.strictEqual(r.descuento, 0);
  await borra();
});
await t('POS 5 · con extras → 50% solo sobre precio base (90, no sobre 210)', async () => {
  await crearPromoChila();
  // Segundo con Queso extra (+30) como 2ª guarnición: sigue elegible (2 guarniciones).
  const r = await posDesc([cVerde, { producto_id: pChila, cantidad: 1, modificadores: [oRoja, oPollo, oFrijoles, oQueso] }]);
  assert.strictEqual(r.subtotal, 390, '180 + 210');
  assert.strictEqual(r.descuento, 90, '50% de la base 180');
  await borra();
});
await t('PARIDAD · WhatsApp y POS con los MISMOS items → mismo subtotal/descuento/total', async () => {
  await crearPromoChila();
  const wa = await previsualizarPedido({ canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo', items: [
    { nombre: 'Chilaquiles', cantidad: 1, modificadores: ['Roja', 'Pollo', 'Frijoles', 'Papa'] },
    { nombre: 'Chilaquiles', cantidad: 1, modificadores: ['Verde', 'Pollo', 'Frijoles', 'Papa'] },
  ] }, NEG, { canal: 'whatsapp' });
  const pos = await posDesc([cRoja, cVerde]);
  assert.strictEqual(wa.preview.subtotal, pos.subtotal, 'subtotal igual');
  assert.strictEqual(wa.preview.descuento_total, pos.descuento, 'descuento igual');
  assert.strictEqual(wa.preview.total, pos.total, 'total igual');
  assert.strictEqual(pos.total, 270);
  await borra();
});

// ═══════════ REGISTRO == PREVIEW (persistencia real, SEED negocioA) ═══════════
const NEG_S = SEED.negocioA;
let snapMetodos, snapModo, ppChila;
await t('CASO-REGISTRO · registro conserva total del preview y snapshot de promo', async () => {
  snapMetodos = (await pool.query(`SELECT * FROM metodos_pago WHERE negocio_id=$1`, [NEG_S])).rows;
  snapModo = (await pool.query(`SELECT valor FROM configuracion WHERE clave='modo_pedidos' AND negocio_id=$1`, [NEG_S])).rows;
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id=$1`, [NEG_S]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id,tipo,habilitado,orden,disponible_para_bot) VALUES ($1,'efectivo',TRUE,1,TRUE)`, [NEG_S]);
  await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'modo_pedidos','transaccional')
    ON CONFLICT (negocio_id,clave) DO UPDATE SET valor='transaccional'`, [NEG_S]);
  const { rows: [c] } = await pool.query(`INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,'CC Cat (test)',TRUE,993) RETURNING id`, [NEG_S]);
  ppChila = await producto(NEG_S, c.id, 'CC Chilaquiles', 180);
  const g = await grupo(NEG_S, ppChila, 'CC Salsa'); const r = await opcion(NEG_S, g, 'CC Roja'); await opcion(NEG_S, g, 'CC Suiza');
  const gp = await grupo(NEG_S, ppChila, 'CC Proteina'); const po = await opcion(NEG_S, gp, 'CC Pollo');
  await guardarPromocion(NEG_S, {
    nombre: 'CC Miércoles 50%', tipo: 'segundo_descuento', valor: 50, automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp', 'pos'], productos: [ppChila],
    condicionesModificadores: [
      { productoId: ppChila, grupoId: g, operador: 'una_de', optionIds: [r] },
      { productoId: ppChila, grupoId: gp, operador: 'incluye', optionIds: [po] },
    ],
  });
  const ord = {
    cliente: { nombre: 'Cli CC', telefono: '8990002222', calle: null, colonia: null, entre_calles: null },
    modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp', negocioId: NEG_S,
    items: [
      { nombre: 'CC Chilaquiles', cantidad: 1, modificadores: ['CC Roja', 'CC Pollo'] },
      { nombre: 'CC Chilaquiles', cantidad: 1, modificadores: ['CC Roja', 'CC Pollo'] },
    ],
  };
  const pv = await previsualizarPedido(ord, NEG_S, { canal: 'whatsapp' });
  assert.strictEqual(pv.preview.total, 270, 'preview: 360 - 90');
  const pedido = await registrarPedido(ord, 'whatsapp');
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [pedido.folio || pedido.id, NEG_S]);
  const datos = rows[0].datos;
  assert.strictEqual(datos.total, pv.preview.total, 'registro == preview');
  assert.strictEqual(datos.descuento, 90);
  assert.ok(Array.isArray(datos.promociones) && datos.promociones.length === 1, 'snapshot de promoción');
});
// limpieza SEED
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'='8990002222'`, [NEG_S]).catch(()=>{});
await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1 AND nombre='CC Miércoles 50%'`, [NEG_S]).catch(()=>{});
await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1 AND nombre LIKE 'CC %'`, [NEG_S]).catch(()=>{});
await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1 AND nombre LIKE 'CC %'`, [NEG_S]).catch(()=>{});
await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'CC %'`, [NEG_S]).catch(()=>{});
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'CC %'`, [NEG_S]).catch(()=>{});
await pool.query(`DELETE FROM metodos_pago WHERE negocio_id=$1`, [NEG_S]).catch(()=>{});
for (const m of (snapMetodos||[])) await pool.query(
  `INSERT INTO metodos_pago (negocio_id,tipo,habilitado,orden,disponible_para_bot,disponible_para_operador,instrucciones,integracion_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (negocio_id,tipo) DO NOTHING`,
  [m.negocio_id,m.tipo,m.habilitado,m.orden,m.disponible_para_bot,m.disponible_para_operador,m.instrucciones,m.integracion_id]).catch(()=>{});
await pool.query(`DELETE FROM configuracion WHERE clave='modo_pedidos' AND negocio_id=$1`, [NEG_S]).catch(()=>{});
if ((snapModo||[]).length) await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'modo_pedidos',$2)`, [NEG_S, snapModo[0].valor]).catch(()=>{});

// ═══════════ RESUMEN ═══════════
await limpiar(NEG); await limpiar(NEG_B);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
