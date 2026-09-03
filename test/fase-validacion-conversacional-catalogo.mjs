// VALIDACIÓN CONVERSACIONAL DE CATÁLOGO.
//
// Smoke real que la motivó: "Quiero un licuado de mango grande" → el bot
// respondió "Un licuado de mango grande. ¿Qué complementos…?" aunque ese sabor
// no existe. Los logs mostraron CERO eventos: el modelo no emitió ningún
// marcador de orden, así que `validarOrdenPropuesta` nunca corrió. El backend
// impedía VENDER lo imposible, pero no impedía PROMETERLO en la charla.
//
// Aquí se cubre esa fase previa: un borrador incompleto se contrasta contra el
// catálogo REAL usando las MISMAS primitivas que protegen el preview
// (resolverProducto, resolverModificadoresLLM, validarCardinalidadGrupos), sin
// tocar nada económico y sin registrar nada.
//
// Multi-tenant: fixture genérico, sin nombres de negocio, producto ni sabor
// reales — los invariantes valen para pizza, café o hamburguesas igual.
//
// Uso: DATABASE_URL=... node test/fase-validacion-conversacional-catalogo.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { validarBorradorPedido, mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');
const { previsualizarPedido } = await import('../src/orders/orderManager.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture: producto con grupos requeridos + un opcional de máximo > 1 ─────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Validacion Conversacional','validacion-conv')
   ON CONFLICT (slug) DO UPDATE SET nombre='Validacion Conversacional' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [NEG]).catch(() => {});
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
const BEBIDA = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Bebida Preparada',55) RETURNING id`, [NEG, cat])).id;
const PLATO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Plato Base',195) RETURNING id`, [NEG, cat])).id;
const ROTO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Producto Sin Opciones',60) RETURNING id`, [NEG, cat])).id;
const grupo = async (prod, nombre, { requerido = false, minimo = 0, maximo = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`, [NEG, prod, nombre, requerido, minimo, maximo])).id;
const op = async (gid, nombre, extra = 0, disponible = true) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,$5,0) RETURNING id`, [NEG, gid, nombre, extra, disponible])).id;

const gTamano = await grupo(BEBIDA, 'Tamaño', { requerido: true, minimo: 1, maximo: 1 });
await op(gTamano, 'Chico'); await op(gTamano, 'Grande', 20);
const gVariante = await grupo(BEBIDA, 'Variante', { requerido: true, minimo: 1, maximo: 1 });
for (const v of ['Alfa', 'Beta', 'Gamma', 'Delta']) await op(gVariante, v);
const gLiquido = await grupo(BEBIDA, 'Líquido', { requerido: true, minimo: 1, maximo: 1 });
await op(gLiquido, 'Tipo Uno'); await op(gLiquido, 'Tipo Dos');
const gExtras = await grupo(BEBIDA, 'Extras', { requerido: false, minimo: 0, maximo: 3 });
for (const e of ['E1', 'E2', 'E3', 'E4']) await op(gExtras, e);
const gSalsa = await grupo(PLATO, 'Salsa', { requerido: true, minimo: 1, maximo: 1 });
await op(gSalsa, 'Verde'); await op(gSalsa, 'Roja');
// Producto con grupo obligatorio sin opciones utilizables.
const gImposible = await grupo(ROTO, 'Obligatorio Vacío', { requerido: true, minimo: 1, maximo: 1 });
await op(gImposible, 'Agotada', 0, false);

const draft = (items) => ({ items });
const item = (nombre, mods = [], extra = {}) => ({ nombre, cantidad: 1, modificadores: mods, ...extra });
const mod = (grupo, ...opciones) => ({ grupo, opciones });

// ═══ V1/V2/V3 — la opción inexistente se detecta ANTES del preview ══════════
const rcInvalida = await validarBorradorPedido(
  draft([item('Bebida Preparada', [mod('Variante', 'Omega'), mod('Tamaño', 'Grande')])]), NEG);
await t('V1. opción explícita inexistente → el backend la rechaza sin preview', () => {
  assert.strictEqual(rcInvalida.ok, false, 'un borrador con algo inexistente no puede pasar');
  assert.strictEqual(rcInvalida.productos[0].invalidos.length, 1);
});
await t('V2. el valor pedido NUNCA desaparece en silencio', () => {
  assert.strictEqual(rcInvalida.productos[0].invalidos[0].solicitado, 'Omega');
  assert.strictEqual(rcInvalida.productos[0].invalidos[0].grupo, 'Variante');
});
await t('V3. NO se convierte en otra opción válida', () => {
  const elegidas = rcInvalida.productos[0].elegidas.map((e) => e.opcion);
  assert.ok(!elegidas.some((o) => ['Alfa', 'Beta', 'Gamma', 'Delta'].includes(o)),
    `no puede sustituirse por una variante real: ${JSON.stringify(elegidas)}`);
  assert.deepStrictEqual(elegidas, ['Grande'], 'solo sobrevive lo que sí existe');
});
await t('V4. las alternativas salen del catálogo REAL', () => {
  assert.deepStrictEqual(rcInvalida.productos[0].invalidos[0].alternativas, ['Alfa', 'Beta', 'Gamma', 'Delta']);
  const msg = mensajeBorradorParaCliente(rcInvalida);
  assert.match(msg, /Omega/); assert.match(msg, /Alfa, Beta, Gamma y Delta/);
});

// ═══ V5 — el prompt marca opcional un grupo de máximo > 1 ══════════════════
await t('V5. un grupo opcional con máximo>1 se anuncia como OPCIONAL en el prompt', async () => {
  const { construirSystemPrompt } = await import('../src/agent/prompts.js');
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.match(prompt, /Extras \(opcionales, hasta 3\)/,
    'antes decía "hasta 3" y el bot los pedía como obligatorios');
  assert.match(prompt, /Variante \(elige 1\)/, 'los requeridos siguen anunciándose igual');
});

// ═══ V6/V7 — faltantes vs opcionales ═══════════════════════════════════════
const rcFalta = await validarBorradorPedido(
  draft([item('Bebida Preparada', [mod('Tamaño', 'Grande'), mod('Variante', 'Beta')])]), NEG);
await t('V6. con producto y variante válidos, el faltante es el grupo requerido restante', () => {
  assert.strictEqual(rcFalta.ok, false);
  const grupos = rcFalta.productos[0].faltantes.map((f) => f.grupo);
  assert.deepStrictEqual(grupos, ['Líquido'], `solo debe faltar Líquido: ${JSON.stringify(grupos)}`);
  const msg = mensajeBorradorParaCliente(rcFalta);
  assert.match(msg, /líquido/i); assert.match(msg, /Tipo Uno.*Tipo Dos/);
});
await t('V7. el grupo OPCIONAL nunca aparece como faltante', () => {
  assert.ok(!rcFalta.productos[0].faltantes.some((f) => f.grupo === 'Extras'),
    'Extras es opcional: jamás debe pedirse como requisito');
  assert.ok(!/extras/i.test(mensajeBorradorParaCliente(rcFalta)));
});

// ═══ V8 — "sin extras" es válido ═══════════════════════════════════════════
await t('V8. omitir por completo el grupo opcional es válido', async () => {
  const rc = await validarBorradorPedido(draft([item('Bebida Preparada', [
    mod('Tamaño', 'Grande'), mod('Variante', 'Beta'), mod('Líquido', 'Tipo Uno')])]), NEG);
  assert.strictEqual(rc.ok, true, 'con los requeridos completos, sin opcionales, debe pasar');
  assert.strictEqual(mensajeBorradorParaCliente(rc), null, 'no hay nada que preguntar');
});

// ═══ V9 — las notas libres no se validan contra catálogo ═══════════════════
await t('V9. una nota libre NO se trata como opción inválida', async () => {
  const rc = await validarBorradorPedido(
    draft([item('Plato Base', [mod('Salsa', 'Verde')], { notas: 'sin cebolla' })]), NEG);
  assert.strictEqual(rc.ok, true, 'la nota no puede bloquear el pedido');
  assert.strictEqual(rc.productos[0].invalidos.length, 0, '"sin cebolla" no es una opción de menú');
});

// ═══ V10 — una consulta no muta el pedido ══════════════════════════════════
await t('V10. un borrador vacío (consulta informativa) no produce nada', async () => {
  const rc = await validarBorradorPedido(draft([]), NEG);
  assert.strictEqual(rc.ok, true);
  assert.deepStrictEqual(rc.productos, []);
  assert.strictEqual(mensajeBorradorParaCliente(rc), null, 'preguntar no debe generar respuesta de pedido');
});

// ═══ V11 — catálogo imposible ══════════════════════════════════════════════
await t('V11. producto con grupo obligatorio sin opciones → fail-closed', async () => {
  const rc = await validarBorradorPedido(draft([item('Producto Sin Opciones')]), NEG);
  assert.strictEqual(rc.ok, false);
  assert.strictEqual(rc.productos[0].inconsistentes.length, 1);
  const msg = mensajeBorradorParaCliente(rc);
  assert.match(msg, /no está disponible para pedir/i);
  assert.ok(!/falta/i.test(msg), 'no puede pedirle al cliente que elija de una lista vacía');
});

// ═══ V12 — la validación del borrador no crea nada ═════════════════════════
await t('V12. validar un borrador NO genera preview, folio ni persistencia', async () => {
  const antes = (await pool.query(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [NEG])).rows[0].n;
  const rc = await validarBorradorPedido(
    draft([item('Bebida Preparada', [mod('Variante', 'Omega')])]), NEG);
  assert.strictEqual(rc.ok, false);
  assert.strictEqual(rc.preview, undefined, 'no existe preview en la validación de borrador');
  assert.strictEqual(rc.total, undefined, 'no calcula nada económico');
  const despues = (await pool.query(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [NEG])).rows[0].n;
  assert.strictEqual(despues, antes, 'no debe persistir nada');
});

// ═══ V13 — prioridad determinista ══════════════════════════════════════════
await t('V13. lo INVÁLIDO se responde antes que lo faltante', () => {
  // El mismo borrador tiene a la vez una opción inexistente y grupos sin elegir.
  const p = rcInvalida.productos[0];
  assert.ok(p.invalidos.length > 0 && p.faltantes.length > 0, 'el fixture debe tener ambos');
  const msg = mensajeBorradorParaCliente(rcInvalida);
  assert.match(msg, /Omega/, 'primero se corrige lo imposible');
  assert.ok(!/me falta saber/i.test(msg), 'no se pregunta por lo que falta mientras algo sea inválido');
});
await t('V13b. tampoco se pregunta por el grupo opcional mientras haya inválidos', () => {
  assert.ok(!/extras/i.test(mensajeBorradorParaCliente(rcInvalida)));
});

// ═══ V14 — al corregir el sabor, avanza al siguiente faltante ══════════════
await t('V14. elegida una opción válida, el siguiente paso es el grupo requerido restante', async () => {
  const rc = await validarBorradorPedido(draft([item('Bebida Preparada', [
    mod('Tamaño', 'Grande'), mod('Variante', 'Gamma')])]), NEG);
  const msg = mensajeBorradorParaCliente(rc);
  assert.ok(!/Omega/.test(msg), 'ya no hay nada inválido');
  assert.match(msg, /líquido/i, 'ahora sí toca preguntar el requerido que falta');
});

// ═══ Coherencia con el pipeline económico ══════════════════════════════════
await t('coherencia: lo que el borrador acepta, el preview también lo acepta', async () => {
  const items = [item('Bebida Preparada', [
    mod('Tamaño', 'Grande'), mod('Variante', 'Beta'), mod('Líquido', 'Tipo Uno')])];
  const rc = await validarBorradorPedido(draft(items), NEG);
  assert.strictEqual(rc.ok, true);
  const v = await previsualizarPedido({ cliente: { nombre: 'C', telefono: '5550000011' },
    modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp', items }, NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, 'no puede haber divergencia entre borrador y preview');
  assert.strictEqual(v.preview.total, 75, '55 + 20 de Grande');
});
await t('coherencia: lo que el borrador rechaza, el preview también lo rechaza', async () => {
  const items = [item('Bebida Preparada', [mod('Variante', 'Omega')])];
  assert.strictEqual((await validarBorradorPedido(draft(items), NEG)).ok, false);
  const v = await previsualizarPedido({ cliente: { nombre: 'C', telefono: '5550000012' },
    modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp', items }, NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'una sola fuente de verdad para ambas capas');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
