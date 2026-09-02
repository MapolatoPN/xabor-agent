// IDENTIDAD DE GRUPO EN MODIFICADORES + COMANDA CON MODIFICADORES (XAB-0230).
//
// Dos bugs independientes del mismo pedido real ($450, Mapolato, WhatsApp):
//
// A) La identidad de una opción era su NOMBRE SUELTO. "Bistec en Salsa" y
//    "Queso Panela en Salsa" existen en DOS grupos del mismo producto
//    (Proteína y Guarniciones); el índice era nombre→PRIMER grupo hallado, así
//    que las guarniciones del cliente se registraron como proteínas: la línea
//    quedó con 3 proteínas y 0 guarniciones, las condiciones de la promo
//    fallaron y el backend explicó "elegiste 0 guarniciones".
// B) La comanda NUNCA imprimió los modificadores: el render del panel armaba
//    cada línea con cantidad/nombre/notas/precio y nada más.
//
// La regla económica NO cambia: la promo descuenta solo el precio BASE, los
// extras se cobran completos, y un extra con costo no invalida la promoción.
//
// Uso: DATABASE_URL=... node test/fase-modificadores-grupo-identidad.mjs
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

const { pool } = await import('../src/services/database.js');
const { guardarPromocion } = await import('../src/services/tiendaPromociones.js');
const { resolverModificadoresLLM, cargarGruposDeProductos } = await import('../src/services/modificadores.js');
const { previsualizarPedido, resumenPedidoOficial } = await import('../src/orders/orderManager.js');
const { validarOrdenPropuesta, RECHAZOS, mensajeRechazoParaCliente } = await import('../src/orders/validadorOrden.js');
const { explicarPromosNoAplicadas, evaluarElegibilidadLinea } = await import('../src/services/promoDiagnostico.js');
const { agruparItemsPorImpresora } = await import('../src/printing/routingEngine.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture: réplica del menú de Mapolato, CON nombres duplicados entre grupos ─
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Mods Identidad','mods-identidad')
   ON CONFLICT (slug) DO UPDATE SET nombre='Mods Identidad' RETURNING id`)).id;
for (const tabla of ['tienda_promociones', 'menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'CHILAQUILES',0) RETURNING id`, [NEG])).id;
const pChila = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Chilaquiles Sencillos',195) RETURNING id`, [NEG, cat])).id;
const pWaffles = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Waffles',160) RETURNING id`, [NEG, cat])).id;
const grupo = async (prod, nombre) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,FALSE,0,0,0) RETURNING id`, [NEG, prod, nombre])).id;
const opcion = async (gid, nombre, extra = 0) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [NEG, gid, nombre, extra])).id;

// Grupos en el MISMO orden que producción: Proteína ANTES que Guarniciones, para
// que el bug del "primer match" se reproduzca si volviera.
const gSalsa = await grupo(pChila, 'Salsa');
const oRoja = await opcion(gSalsa, 'Roja'), oSuiza = await opcion(gSalsa, 'Suiza'), oVerde = await opcion(gSalsa, 'Verde');
const gProte = await grupo(pChila, 'Proteína');
const oHuevoE = await opcion(gProte, 'Huevos Estrellados'), oHuevoR = await opcion(gProte, 'Huevos Revueltos');
const oPechuga = await opcion(gProte, 'Pechuga de pollo');
const oBistecProte = await opcion(gProte, 'Bistec en Salsa');            // ← duplicado
const oPanelaProte = await opcion(gProte, 'Queso Panela en Salsa');      // ← duplicado
const gGuarn = await grupo(pChila, 'Guarniciones');
const oBistecGuarn = await opcion(gGuarn, 'Bistec en Salsa', 30);        // ← duplicado, CON costo
const oPanelaGuarn = await opcion(gGuarn, 'Queso Panela en Salsa', 30);  // ← duplicado, CON costo
const oFrijoles = await opcion(gGuarn, 'Frijolitos naturales');
const oPapas = await opcion(gGuarn, 'Papas con chorizo');
// Producto con un extra de nombre ÚNICO (compatibilidad legacy).
const gExtrasW = await grupo(pWaffles, 'Extras');
await opcion(gExtrasW, 'Nutella', 30);

await guardarPromocion(NEG, {
  nombre: 'Miercoles de Chilaquiles', tipo: '2x1', automatica: true,
  cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], productos: [pChila],
  condicionesModificadores: [
    { productoId: pChila, grupoId: gSalsa, operador: 'una_de', optionIds: [oRoja, oVerde] },
    { productoId: pChila, grupoId: gProte, operador: 'una_de', optionIds: [oHuevoE, oHuevoR, oPechuga] },
    { productoId: pChila, grupoId: gGuarn, operador: 'cantidad', min: 2, max: 2 },
  ],
});
const gruposChila = (await cargarGruposDeProductos(NEG, [pChila])).get(pChila) || [];

// Orden estructurada por grupo: la forma que ahora emite el agente.
const item = (salsa, proteina, guarniciones) => ({
  nombre: 'Chilaquiles Sencillos', cantidad: 1,
  modificadores: [
    { grupo: 'Salsa', opciones: [salsa] },
    { grupo: 'Proteína', opciones: [proteina] },
    { grupo: 'Guarniciones', opciones: guarniciones },
  ],
});
const ordenXAB0230 = {
  cliente: { nombre: 'Mario Cantu', telefono: '8787899919' },
  modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp',
  items: [
    item('Verde', 'Huevos Estrellados', ['Bistec en Salsa', 'Queso Panela en Salsa']),
    item('Roja', 'Pechuga de pollo', ['Frijolitos naturales', 'Papas con chorizo']),
  ],
};

// ═══ CASO A — nombre duplicado entre grupos, con grupo explícito ═════════════
await t('A. grupo explícito resuelve DENTRO del grupo, nunca al primer match', () => {
  const r = resolverModificadoresLLM(gruposChila, [{ grupo: 'Guarniciones', opciones: ['Bistec en Salsa'] }]);
  assert.strictEqual(r.modificadores.length, 1);
  assert.strictEqual(r.modificadores[0].grupo, 'Guarniciones');
  assert.strictEqual(r.modificadores[0].opcion_id, oBistecGuarn, 'tomó la opción del grupo equivocado');
  assert.strictEqual(r.modificadores[0].precio_extra, 30);
});
await t('A2. el MISMO nombre en Proteína resuelve a Proteína (sin costo)', () => {
  const r = resolverModificadoresLLM(gruposChila, [{ grupo: 'Proteína', opciones: ['Bistec en Salsa'] }]);
  assert.strictEqual(r.modificadores[0].grupo, 'Proteína');
  assert.strictEqual(r.modificadores[0].opcion_id, oBistecProte);
  assert.strictEqual(r.modificadores[0].precio_extra, 0);
});
await t('A3. por IDs explícitos también resuelve sin ambigüedad', () => {
  const r = resolverModificadoresLLM(gruposChila, [{ grupo_id: gGuarn, opcion_id: oBistecGuarn }]);
  assert.strictEqual(r.modificadores[0].grupo, 'Guarniciones');
  assert.strictEqual(r.modificadores[0].opcion_id, oBistecGuarn);
});

// ═══ CASO B — ambigüedad sin grupo ══════════════════════════════════════════
await t('B. nombre duplicado SIN grupo → ambiguo, NO se adivina', () => {
  const r = resolverModificadoresLLM(gruposChila, ['Bistec en Salsa']);
  assert.strictEqual(r.modificadores.length, 0, 'no debía resolver nada');
  assert.strictEqual(r.ambiguos.length, 1);
  assert.strictEqual(r.ambiguos[0].nombre, 'Bistec en Salsa');
  assert.deepStrictEqual(r.ambiguos[0].grupos.sort(), ['Guarniciones', 'Proteína']);
});
await t('B2. la orden con un modificador ambiguo se DETIENE y pregunta', async () => {
  const v = await validarOrdenPropuesta({
    cliente: { nombre: 'A', telefono: '1' }, modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp',
    items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: ['Bistec en Salsa'] }],
  }, NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'debía rechazarse en vez de adivinar');
  assert.ok(v.rechazos.some((r) => r.codigo === RECHAZOS.MODIFICADOR_AMBIGUO));
  const msg = mensajeRechazoParaCliente(v.rechazos);
  assert.match(msg, /Bistec en Salsa/);
  assert.match(msg, /Proteína|Guarniciones/, 'el mensaje debe nombrar los grupos posibles');
});

// ═══ CASO C — legacy con nombre único ═══════════════════════════════════════
await t('C. nombre ÚNICO sin grupo sigue funcionando (compatibilidad legacy)', async () => {
  const gruposW = (await cargarGruposDeProductos(NEG, [pWaffles])).get(pWaffles) || [];
  const r = resolverModificadoresLLM(gruposW, ['Nutella']);
  assert.strictEqual(r.modificadores.length, 1);
  assert.strictEqual(r.modificadores[0].opcion, 'Nutella');
  assert.strictEqual(r.modificadores[0].precio_extra, 30);
  assert.strictEqual(r.ambiguos.length, 0);
});
await t('C2. formato legacy {opcion:"..."} sigue soportado', async () => {
  const gruposW = (await cargarGruposDeProductos(NEG, [pWaffles])).get(pWaffles) || [];
  const r = resolverModificadoresLLM(gruposW, [{ opcion: 'Nutella' }]);
  assert.strictEqual(r.modificadores.length, 1);
});
await t('C3. nombre inexistente CON grupo explícito → noDisponibles (fail-closed)', () => {
  // Cambió a propósito (XAB-0234): una selección estructurada que no existe ya
  // no se reporta como "no reconocida y seguimos", sino que detiene la orden con
  // las alternativas reales del grupo. Un texto libre SIN grupo conserva el
  // camino leniente — ver fase-fidelidad-catalogo-notas.
  const r = resolverModificadoresLLM(gruposChila, [{ grupo: 'Salsa', opciones: ['Queso mágico'] }]);
  assert.strictEqual(r.modificadores.length, 0);
  assert.strictEqual(r.noDisponibles.length, 1);
  assert.strictEqual(r.noDisponibles[0].solicitado, 'Queso mágico');
  assert.strictEqual(r.noDisponibles[0].grupo, 'Salsa');
  assert.ok(r.noDisponibles[0].alternativas.includes('Roja'), 'debe ofrecer las salsas reales');
});

// ═══ CASO D — economía de XAB-0230 ══════════════════════════════════════════
await t('D. XAB-0230: subtotal 450, descuento 195 (solo base), total 255', async () => {
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  assert.ok(v.ok, `el preview debía ser válido: ${JSON.stringify(v.rechazos || [])}`);
  assert.strictEqual(v.preview.subtotal, 450, 'subtotal = 195+30+30+195');
  assert.strictEqual(v.preview.descuento_total, 195, 'el 2x1 descuenta SOLO el precio base');
  assert.strictEqual(v.preview.total, 255);
});
await t('D2. los $60 de extras se siguen cobrando (no se descuentan)', async () => {
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  const conExtras = v.preview.items.find((i) => i.total_item === 255);
  assert.ok(conExtras, 'el primer chilaquil debe costar 195+30+30 = 255');
});
await t('D3. cada línea queda con la identidad correcta: 1 salsa, 1 proteína, 2 guarniciones', async () => {
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  for (const it of v.orden.items) {
    const porGrupo = {};
    for (const m of it.modificadores) porGrupo[m.grupo] = (porGrupo[m.grupo] || 0) + 1;
    assert.strictEqual(porGrupo['Salsa'], 1, `salsa mal: ${JSON.stringify(porGrupo)}`);
    assert.strictEqual(porGrupo['Proteína'], 1, `proteína mal: ${JSON.stringify(porGrupo)}`);
    assert.strictEqual(porGrupo['Guarniciones'], 2, `guarniciones mal: ${JSON.stringify(porGrupo)}`);
  }
});

// ═══ CASO E — explicación ═══════════════════════════════════════════════════
await t('E. XAB-0230 es ELEGIBLE: sin razones, sin "0 guarniciones"', async () => {
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  const promo = (await pool.query(`SELECT * FROM tienda_promociones WHERE negocio_id=$1 LIMIT 1`, [NEG])).rows[0];
  const gpp = await cargarGruposDeProductos(NEG, [pChila]);
  for (const it of v.orden.items) {
    const { elegible, razones } = evaluarElegibilidadLinea({ promo, item: it, gruposPorProd: gpp });
    assert.strictEqual(elegible, true, `debía ser elegible; razones: ${JSON.stringify(razones)}`);
    assert.strictEqual(razones.length, 0);
  }
  const exp = await explicarPromosNoAplicadas(NEG, v.orden, { canal: 'whatsapp', promosAplicadas: v.preview.promociones });
  assert.strictEqual(exp, '', `no debía explicar inelegibilidad: ${exp}`);
});
await t('E2. si NO es elegible, la razón cita el GRUPO correcto (Suiza en Salsa)', async () => {
  const orden = { ...ordenXAB0230, items: [
    item('Suiza', 'Huevos Estrellados', ['Bistec en Salsa', 'Queso Panela en Salsa']),
    item('Suiza', 'Huevos Revueltos', ['Frijolitos naturales', 'Papas con chorizo']),
  ] };
  const v = await previsualizarPedido(orden, NEG, { canal: 'whatsapp' });
  const exp = await explicarPromosNoAplicadas(NEG, v.orden, { canal: 'whatsapp', promosAplicadas: v.preview.promociones });
  assert.match(exp, /Suiza en salsa/i, `la razón debe ubicar Suiza en Salsa: ${exp}`);
  assert.ok(!/Suiza en prote/i.test(exp), 'no debe atribuir Suiza a la proteína');
  assert.ok(!/0 guarniciones/i.test(exp), 'las guarniciones sí estaban: no debe decir 0');
});

// ═══ CASO F — comanda ═══════════════════════════════════════════════════════
const PANEL = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
await t('F. el card y la comanda impresa renderizan los modificadores por grupo', () => {
  assert.match(PANEL, /function modsAgrupados\(item\)/, 'falta el agrupador de modificadores');
  // Card de comandas (renderComanda).
  assert.match(PANEL, /item-nombre-wrap[^`]*\$\{modsPorGrupoHTML\(item\)\}/, 'el card no pinta los modificadores');
  // Comanda IMPRESA (comandaHTML): debe recorrer los mismos grupos.
  const comanda = PANEL.slice(PANEL.indexOf('function comandaHTML'));
  assert.match(comanda.slice(0, 2000), /modsAgrupados\(item\)/, 'la comanda impresa no pinta los modificadores');
});
await t('F2. el agrupador consume la estructura canónica (no reinterpreta texto)', () => {
  const src = PANEL.slice(PANEL.indexOf('function modsAgrupados'), PANEL.indexOf('function modsPorGrupoHTML'));
  assert.match(src, /item\?\.modificadores/, 'debe leer item.modificadores');
  assert.ok(!/fetch|menu|buscar|parse/i.test(src), 'no debe volver a consultar el menú ni parsear texto');
});
await t('F3. render simulado del fixture XAB-0230 muestra las 8 opciones bajo su grupo', async () => {
  // Se ejecuta la MISMA función del panel contra los items canónicos reales.
  const fuente = PANEL.slice(PANEL.indexOf('function modsAgrupados'), PANEL.indexOf('function renderComanda'));
  const modsAgrupados = new Function(`${fuente}; return modsAgrupados;`)();
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  const render = v.orden.items.map((it) => modsAgrupados(it)
    .map(([g, ops]) => `${g}: ${ops.join(', ')}`).join(' | ')).join(' || ');
  for (const esperado of ['Verde', 'Huevos Estrellados', 'Bistec en Salsa', 'Queso Panela en Salsa',
                          'Roja', 'Pechuga de pollo', 'Frijolitos naturales', 'Papas con chorizo']) {
    assert.ok(render.includes(esperado), `la comanda no muestra "${esperado}": ${render}`);
  }
  assert.match(render, /Guarniciones: Bistec en Salsa, Queso Panela en Salsa/,
    `Bistec/Queso deben aparecer bajo Guarniciones: ${render}`);
});
await t('F4. la comanda imprime SOLO lo elegido: 4 selecciones por producto, 8 en total', async () => {
  // La cocina debe ver lo que el cliente pidió, NUNCA el catálogo del grupo.
  const fuente = PANEL.slice(PANEL.indexOf('function modsAgrupados'), PANEL.indexOf('function renderComanda'));
  const modsAgrupados = new Function(`${fuente}; return modsAgrupados;`)();
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  let totalSelecciones = 0;
  for (const it of v.orden.items) {
    const grupos = modsAgrupados(it);
    const n = grupos.reduce((s, [, ops]) => s + ops.length, 0);
    assert.strictEqual(n, 4, `cada producto debe imprimir 4 selecciones, imprimió ${n}: ${JSON.stringify(grupos)}`);
    totalSelecciones += n;
  }
  assert.strictEqual(totalSelecciones, 8, 'deben ser 8 selecciones en total');
  // Y NINGUNA opción disponible del menú que el cliente NO eligió.
  const render = v.orden.items.map((it) => modsAgrupados(it)
    .map(([g, ops]) => `${g}: ${ops.join(', ')}`).join(' | ')).join(' || ');
  for (const noElegida of ['Suiza', 'Mole', 'Chipotle', 'Huevos Revueltos']) {
    assert.ok(!render.includes(noElegida),
      `la comanda imprimió "${noElegida}", que el cliente NO eligió: ${render}`);
  }
  // Cada guarnición va con SU producto: no se mezclan entre líneas.
  const [it1, it2] = v.orden.items.map((it) => Object.fromEntries(modsAgrupados(it)));
  assert.deepStrictEqual(it1['Guarniciones'], ['Bistec en Salsa', 'Queso Panela en Salsa']);
  assert.deepStrictEqual(it2['Guarniciones'], ['Frijolitos naturales', 'Papas con chorizo']);
});

// ═══ CASO G — multi-impresora ═══════════════════════════════════════════════
await t('G. los modificadores sobreviven al agrupamiento por impresora', async () => {
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  const items = v.orden.items.map((i) => ({ ...i, categoria: 'CHILAQUILES' }));
  const reglas = {
    categoria: new Map([['chilaquiles', [{ impresoraId: 'imp-1', impresoraNombre: 'Cocina' },
                                          { impresoraId: 'imp-2', impresoraNombre: 'Barra' }]]]),
    producto: new Map(), documento: new Map(), general: [],
  };
  const { grupos } = agruparItemsPorImpresora(items, reglas);
  assert.ok(grupos.length >= 1, 'debía rutear a alguna impresora');
  for (const g of grupos) {
    for (const it of g.items) {
      assert.ok(Array.isArray(it.modificadores) && it.modificadores.length === 4,
        `se perdieron modificadores al rutear a ${g.impresoraNombre}`);
      assert.ok(it.modificadores.every((m) => m.grupo), 'los modificadores perdieron su grupo');
    }
  }
});

// ═══ CASO H — preview de WhatsApp ═══════════════════════════════════════════
await t('H. el resumen oficial agrupa las opciones bajo su grupo', async () => {
  const v = await previsualizarPedido(ordenXAB0230, NEG, { canal: 'whatsapp' });
  const texto = resumenPedidoOficial(v.preview);
  assert.match(texto, /Salsa: Verde/, `falta la salsa agrupada:\n${texto}`);
  assert.match(texto, /Proteína: Huevos Estrellados/, `falta la proteína agrupada:\n${texto}`);
  assert.match(texto, /Guarniciones: Bistec en Salsa \$30, Queso Panela en Salsa \$30/,
    `las guarniciones deben ir juntas y con su precio:\n${texto}`);
  // Y NUNCA la lista plana que confundía proteína con guarnición.
  assert.ok(!/Proteína: Huevos Estrellados, Bistec/.test(texto), 'mezcló guarniciones en la proteína');
});

// ═══ CASO I — POS equivale a WhatsApp ═══════════════════════════════════════
await t('I. POS produce la MISMA estructura canónica que WhatsApp', async () => {
  // El POS manda IDs (resolverSeleccion); WhatsApp manda grupo+nombre. El
  // resultado canónico debe coincidir en identidad de grupo/opción.
  const porIds = resolverModificadoresLLM(gruposChila, [
    { grupo_id: gSalsa, opcion_id: oVerde },
    { grupo_id: gProte, opcion_id: oHuevoE },
    { grupo_id: gGuarn, opcion_id: oBistecGuarn },
    { grupo_id: gGuarn, opcion_id: oPanelaGuarn },
  ]);
  const porNombres = resolverModificadoresLLM(gruposChila, [
    { grupo: 'Salsa', opciones: ['Verde'] },
    { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
    { grupo: 'Guarniciones', opciones: ['Bistec en Salsa', 'Queso Panela en Salsa'] },
  ]);
  const clave = (r) => r.modificadores.map((m) => `${m.grupo_id}:${m.opcion_id}:${m.precio_extra}`).join('|');
  assert.strictEqual(clave(porIds), clave(porNombres), 'POS y WhatsApp deben producir lo mismo');
  assert.strictEqual(porIds.precioExtras, 60);
});

// ── Limpieza ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
