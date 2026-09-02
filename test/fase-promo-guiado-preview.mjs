// GUIADO POR CONDICIONES + AUTORIDAD DEL PREVIEW (caso XAB-0229).
//
// Bug real de producción: la promo "Miércoles de Chilaquiles" (2x1 en
// Chilaquiles Sencillos, con salsa Roja/Verde, proteína entre Huevos
// Estrellados/Revueltos/Pechuga, y exactamente 2 guarniciones) NO aplicó — y
// el motor tuvo razón: el cliente eligió Suiza y Bistec. Lo que falló fue la
// conversación: el bot no explicó los requisitos, guió al cliente hacia
// opciones que invalidaban la promo, siguió afirmando que participaba y, tras
// el preview de $510, prometió que "el sistema ajustará el total con el
// descuento". Esta suite protege los invariantes que corrigen eso.
//
// NO toca el motor económico: los totales que verifica los produce el pipeline
// real (previsualizarPedido → validarOrdenPropuesta → calcularPromociones).
//
// Uso: DATABASE_URL=... node test/fase-promo-guiado-preview.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { guardarPromocion, describirPromocionesVigentes } = await import('../src/services/tiendaPromociones.js');
const { condicionesEstructuradas, evaluarElegibilidadLinea, explicarInelegibilidad,
        explicarPromosNoAplicadas, opcionInvalidaPromo, fraseCondicionEstructurada }
  = await import('../src/services/promoDiagnostico.js');
const { cargarGruposDeProductos } = await import('../src/services/modificadores.js');
const { previsualizarPedido } = await import('../src/orders/orderManager.js');
const { construirSystemPrompt } = await import('../src/agent/prompts.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture: réplica del menú/promoción de Mapolato ─────────────────────────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = await montarNegocio('promo-guiado-a', 'Promo Guiado A');
for (const tabla of ['tienda_promociones', 'menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'CHILAQUILES',0) RETURNING id`, [NEG])).id;
// $255 c/u ⇒ 2 unidades = $510, el total canónico del pedido real XAB-0229.
const pChila = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Chilaquiles Sencillos',255) RETURNING id`, [NEG, cat])).id;
const grupo = async (nombre) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,FALSE,0,0,0) RETURNING id`, [NEG, pChila, nombre])).id;
const opcion = async (gid, nombre) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,0,TRUE,0) RETURNING id`, [NEG, gid, nombre])).id;

const gSalsa = await grupo('Salsa');
const oRoja = await opcion(gSalsa, 'Roja'), oSuiza = await opcion(gSalsa, 'Suiza'), oVerde = await opcion(gSalsa, 'Verde');
await opcion(gSalsa, 'Mole'); await opcion(gSalsa, 'Chipotle');
const gProte = await grupo('Proteína');
const oHuevoE = await opcion(gProte, 'Huevos Estrellados'), oHuevoR = await opcion(gProte, 'Huevos Revueltos');
const oPechuga = await opcion(gProte, 'Pechuga de pollo'), oBistec = await opcion(gProte, 'Bistec en Salsa');
const gGuarn = await grupo('Guarniciones');
const oFrijoles = await opcion(gGuarn, 'Frijoles'), oPanela = await opcion(gGuarn, 'Queso Panela'), oPapa = await opcion(gGuarn, 'Papa');

// Promo SIN restricción de día/hora: el fixture debe ser determinista (el bug
// era conversacional, no de vigencia). Las condiciones son las reales.
const CONDS = [
  { productoId: pChila, grupoId: gSalsa, operador: 'una_de', optionIds: [oRoja, oVerde] },
  { productoId: pChila, grupoId: gProte, operador: 'una_de', optionIds: [oHuevoE, oHuevoR, oPechuga] },
  { productoId: pChila, grupoId: gGuarn, operador: 'cantidad', min: 2, max: 2 },
];
await guardarPromocion(NEG, {
  nombre: 'Miercoles de Chilaquiles', tipo: '2x1', automatica: true,
  cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], productos: [pChila], condicionesModificadores: CONDS,
});

const gruposPorProd = await cargarGruposDeProductos(NEG, [pChila]);
const promoCruda = (await pool.query(`SELECT * FROM tienda_promociones WHERE negocio_id=$1 LIMIT 1`, [NEG])).rows[0];

// Orden propuesta (forma que emite el agente) con opciones por NOMBRE.
const ordenCon = (salsa, proteina, guarniciones) => ({
  cliente: { nombre: 'Mario', telefono: '8787899919' },
  modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp',
  items: [{
    nombre: 'Chilaquiles Sencillos', cantidad: 2,
    modificadores: [salsa, proteina, ...guarniciones].map((n) => ({ opcion: n })),
  }],
});
const itemCanonico = (salsaId, protId, guarnIds) => ({
  producto_id: pChila, categoria_id: cat, cantidad: 2, precio_unitario: 255,
  modificadores: [
    { grupo_id: gSalsa, opcion_id: salsaId, opcion: salsaId === oSuiza ? 'Suiza' : salsaId === oVerde ? 'Verde' : 'Roja' },
    { grupo_id: gProte, opcion_id: protId, opcion: protId === oBistec ? 'Bistec en Salsa' : protId === oPechuga ? 'Pechuga de pollo' : 'Huevos Estrellados' },
    ...guarnIds.map((id) => ({ grupo_id: gGuarn, opcion_id: id, opcion: id === oFrijoles ? 'Frijoles' : id === oPanela ? 'Queso Panela' : 'Papa' })),
  ],
});

// ═══ CASO A — ELEGIBLE ═══════════════════════════════════════════════════════
await t('A. cumple condiciones → el motor SÍ aplica el 2x1 y el total baja', async () => {
  const v = await previsualizarPedido(ordenCon('Verde', 'Pechuga de pollo', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  assert.ok(v.ok, 'el preview debería ser válido');
  assert.ok(v.preview.descuento_total > 0, `esperaba descuento > 0, hubo ${v.preview.descuento_total}`);
  assert.strictEqual(v.preview.total, 255, `2x1 sobre 2x$255 debe dejar $255, dio ${v.preview.total}`);
  assert.ok((v.preview.promociones || []).some((p) => /Miercoles/i.test(p.nombre)), 'la promo debe aparecer en el preview');
});
await t('A2. cumpliendo, NO se genera explicación de inelegibilidad', async () => {
  const v = await previsualizarPedido(ordenCon('Verde', 'Pechuga de pollo', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  const exp = await explicarPromosNoAplicadas(NEG, v.orden, { canal: 'whatsapp', promosAplicadas: v.preview.promociones });
  assert.strictEqual(exp, '', `no debía explicar nada y dijo: ${exp}`);
});

// ═══ CASO B — XAB-0229 ═══════════════════════════════════════════════════════
await t('B. XAB-0229: Suiza + Bistec → NO aplica y el total es el canónico $510', async () => {
  const v = await previsualizarPedido(ordenCon('Suiza', 'Bistec en Salsa', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  assert.ok(v.ok);
  assert.strictEqual(v.preview.descuento_total, 0, 'no debía haber descuento');
  assert.strictEqual(v.preview.total, 510, `esperaba $510 (el total real de XAB-0229), dio ${v.preview.total}`);
});
await t('B2. XAB-0229: el backend explica POR QUÉ no aplicó (salsa y proteína)', async () => {
  const v = await previsualizarPedido(ordenCon('Suiza', 'Bistec en Salsa', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  const exp = await explicarPromosNoAplicadas(NEG, v.orden, { canal: 'whatsapp', promosAplicadas: v.preview.promociones });
  assert.ok(exp, 'debía explicar por qué no aplicó');
  assert.match(exp, /Suiza/, 'debe nombrar la salsa elegida');
  assert.match(exp, /Bistec/, 'debe nombrar la proteína elegida');
  assert.match(exp, /Roja|Verde/, 'debe decir qué salsas sí participan');
  assert.match(exp, /Pechuga|Huevos/, 'debe decir qué proteínas sí participan');
  // Y JAMÁS insinuar un ajuste posterior (el bug original).
  assert.ok(!/ajustar|despu[eé]s|m[aá]s tarde|al validar/i.test(exp),
    `la explicación no debe prometer ajustes futuros: ${exp}`);
});
await t('B3. XAB-0229: razones ESTRUCTURADAS, no texto libre', async () => {
  const { elegible, razones } = evaluarElegibilidadLinea({
    promo: promoCruda, item: itemCanonico(oSuiza, oBistec, [oFrijoles, oPanela]), gruposPorProd });
  assert.strictEqual(elegible, false);
  assert.strictEqual(razones.length, 2, `esperaba 2 razones (salsa y proteína), hubo ${razones.length}`);
  const salsa = razones.find((r) => r.grupo === 'Salsa');
  assert.strictEqual(salsa.tipo, 'opcion_no_permitida');
  assert.deepStrictEqual(salsa.seleccion, ['Suiza']);
  assert.deepStrictEqual(salsa.permitidas, ['Roja', 'Verde']);
  const prote = razones.find((r) => r.grupo === 'Proteína');
  assert.deepStrictEqual(prote.permitidas, ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo']);
});
await t('B4. las guarniciones correctas (2) NO se reportan como falla', async () => {
  const { razones } = evaluarElegibilidadLinea({
    promo: promoCruda, item: itemCanonico(oSuiza, oBistec, [oFrijoles, oPanela]), gruposPorProd });
  assert.ok(!razones.some((r) => r.grupo === 'Guarniciones'), 'las 2 guarniciones sí cumplían');
});
await t('B5. cantidad incorrecta de guarniciones → razón de cantidad con el número exacto', async () => {
  const { razones } = evaluarElegibilidadLinea({
    promo: promoCruda, item: itemCanonico(oVerde, oPechuga, [oFrijoles]), gruposPorProd });
  const g = razones.find((r) => r.grupo === 'Guarniciones');
  assert.ok(g, 'debía detectar que falta una guarnición');
  assert.strictEqual(g.tipo, 'cantidad_incorrecta');
  assert.strictEqual(g.exacto, 2);
  assert.match(explicarInelegibilidad('X', razones), /exactamente 2 guarniciones/i);
});

// ═══ CASOS C y D — opción inválida durante el armado ═════════════════════════
await t('C. "Suiza" se detecta como opción que invalida la promo (con alternativas)', () => {
  const r = opcionInvalidaPromo({ promo: promoCruda, productoId: pChila, grupoId: gSalsa, opcionNombre: 'Suiza', gruposPorProd });
  assert.ok(r, 'Suiza debía marcarse como inválida');
  assert.strictEqual(r.grupo, 'Salsa');
  assert.deepStrictEqual(r.permitidas, ['Roja', 'Verde']);
});
await t('C2. "Verde" NO se marca como inválida', () => {
  assert.strictEqual(opcionInvalidaPromo({ promo: promoCruda, productoId: pChila, grupoId: gSalsa, opcionNombre: 'Verde', gruposPorProd }), null);
});
await t('D. "Bistec en Salsa" se detecta como proteína que invalida la promo', () => {
  const r = opcionInvalidaPromo({ promo: promoCruda, productoId: pChila, grupoId: gProte, opcionNombre: 'Bistec en Salsa', gruposPorProd });
  assert.ok(r);
  assert.deepStrictEqual(r.permitidas, ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo']);
});

// ═══ CASO E — cumplía y luego cambia ════════════════════════════════════════
await t('E. cambiar Verde→Suiza quita el descuento y cambia el total oficial', async () => {
  const antes = await previsualizarPedido(ordenCon('Verde', 'Pechuga de pollo', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  const despues = await previsualizarPedido(ordenCon('Suiza', 'Pechuga de pollo', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  assert.strictEqual(antes.preview.total, 255);
  assert.strictEqual(despues.preview.total, 510);
  assert.notStrictEqual(antes.preview.total, despues.preview.total,
    'un cambio que invalida la promo DEBE producir un preview distinto (obliga a reconfirmar)');
  const exp = await explicarPromosNoAplicadas(NEG, despues.orden, { canal: 'whatsapp', promosAplicadas: despues.preview.promociones });
  assert.match(exp, /Suiza/);
});

// ═══ CASO F + §2/§3 — el prompt lleva la estructura autoritativa ════════════
await t('F. el prompt informa la promo con TODOS sus requisitos por grupo', async () => {
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.match(prompt, /Miercoles de Chilaquiles/, 'la promo debe aparecer en el prompt');
  assert.match(prompt, /Chilaquiles Sencillos/, 'debe nombrar el producto participante');
  assert.match(prompt, /REQUISITO salsa: Roja o Verde/i, 'faltan los requisitos de salsa por grupo');
  assert.match(prompt, /REQUISITO proteína: Huevos Estrellados, Huevos Revueltos o Pechuga de pollo/i, 'faltan los requisitos de proteína');
  assert.match(prompt, /REQUISITO guarniciones: exactamente 2/i, 'falta el requisito de cantidad');
});
await t('F2. el prompt prohíbe prometer ajustes futuros y guiar contra los requisitos', async () => {
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.match(prompt, /PREVIEW AUTHORITY RULE/, 'falta la regla de autoridad del preview');
  assert.match(prompt, /se aplicará después/i, 'la regla debe prohibir explícitamente esa frase');
  assert.match(prompt, /el sistema lo ajustará/i, 'la regla debe prohibir explícitamente esa frase');
  assert.match(prompt, /PROMOTION GUIDANCE RULE/, 'falta la regla de guiado por requisitos');
  assert.match(prompt, /no participa/i, 'debe instruir a advertir que una opción no participa');
});
await t('F3. describirPromocionesVigentes expone las condiciones estructuradas', async () => {
  const [p] = await describirPromocionesVigentes(NEG, { canal: 'whatsapp' });
  assert.ok(p, 'debía haber una promo vigente');
  assert.ok(Array.isArray(p.condiciones) && p.condiciones.length === 3, 'faltan las condiciones estructuradas');
  const salsa = p.condiciones.find((c) => c.grupo === 'Salsa');
  assert.deepStrictEqual(salsa.permitidas, ['Roja', 'Verde']);
  assert.strictEqual(salsa.operador, 'una_de');
  // El texto legible previo sigue existiendo (regresión: lo usan otras suites).
  assert.ok(p.participantesTexto.includes('Chilaquiles Sencillos'));
  assert.match(fraseCondicionEstructurada(salsa), /salsa: Roja o Verde/);
});

// ═══ Aislamiento / robustez ═════════════════════════════════════════════════
await t('G. promo SIN condiciones nunca genera explicación (no rompe lo existente)', async () => {
  const NEG2 = await montarNegocio('promo-guiado-b', 'Promo Guiado B');
  for (const tabla of ['tienda_promociones', 'menu_productos', 'menu_categorias']) {
    await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG2]).catch(() => {});
  }
  const c2 = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'X',0) RETURNING id`, [NEG2])).id;
  const p2 = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Simple',100) RETURNING id`, [NEG2, c2])).id;
  await guardarPromocion(NEG2, { nombre: 'Sin condiciones', tipo: '2x1', automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1, canales: ['whatsapp'], productos: [p2] });
  const v = await previsualizarPedido({ cliente: { nombre: 'A', telefono: '1' }, modalidad: 'recoger',
    forma_pago: 'efectivo', canal: 'whatsapp', items: [{ nombre: 'Simple', cantidad: 1 }] }, NEG2, { canal: 'whatsapp' });
  const exp = await explicarPromosNoAplicadas(NEG2, v.orden, { canal: 'whatsapp', promosAplicadas: v.preview.promociones });
  assert.strictEqual(exp, '', `una promo sin condiciones no se explica así: ${exp}`);
});
await t('H. un producto que no participa no genera explicación irrelevante', async () => {
  const otro = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Cafe',50) RETURNING id`, [NEG, cat])).id;
  const v = await previsualizarPedido({ cliente: { nombre: 'A', telefono: '1' }, modalidad: 'recoger',
    forma_pago: 'efectivo', canal: 'whatsapp', items: [{ nombre: 'Cafe', cantidad: 1 }] }, NEG, { canal: 'whatsapp' });
  const exp = await explicarPromosNoAplicadas(NEG, v.orden, { canal: 'whatsapp', promosAplicadas: v.preview.promociones });
  assert.strictEqual(exp, '', `no debía explicar nada para un producto ajeno a la promo: ${exp}`);
  await pool.query(`DELETE FROM menu_productos WHERE id=$1`, [otro]).catch(() => {});
});
await t('I. la capa explicativa NO altera importes (mismo preview antes y después)', async () => {
  const v1 = await previsualizarPedido(ordenCon('Suiza', 'Bistec en Salsa', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  await explicarPromosNoAplicadas(NEG, v1.orden, { canal: 'whatsapp', promosAplicadas: v1.preview.promociones });
  const v2 = await previsualizarPedido(ordenCon('Suiza', 'Bistec en Salsa', ['Frijoles', 'Queso Panela']), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v1.preview.total, v2.preview.total, 'explicar no puede cambiar el total');
  assert.strictEqual(v2.preview.descuento_total, 0);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
