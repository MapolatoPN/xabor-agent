// FIDELIDAD DE CATÁLOGO (P0-A) + NOTAS DE PREPARACIÓN (P0-B).
//
// P0-A — caso real XAB-0234: el cliente pidió un licuado de un sabor que el
// negocio NO maneja. El resolutor era LENIENTE con todo lo no reconocido, así
// que el atributo se descartó en silencio y el pedido siguió sin sabor: se
// vendió algo que la cocina no podía preparar, y un humano tuvo que avisar
// después. Ahora una selección ESTRUCTURADA inexistente detiene la orden y el
// canal ofrece las opciones reales del catálogo.
//
// El matiz que hace segura la corrección: solo se rechaza lo que viene con
// GRUPO explícito (una selección comercial). Un texto libre sin grupo —"sin
// cebolla", "bien tostado"— sigue siendo leniente, porque es una NOTA de
// preparación y no una opción de menú. Convertir todo en estricto habría roto
// las notas.
//
// P0-B — caso real: "que no lleve cebolla" se entendía en la charla, se
// guardaba en el pedido y llegaba a la comanda… pero el preview oficial lo
// omitía, así que el cliente confirmaba un resumen donde su instrucción no
// aparecía.
//
// Multi-tenant: fixture genérico (producto con grupo de variantes), sin
// depender de ningún negocio, producto ni sabor concreto.
//
// Uso: DATABASE_URL=... node test/fase-fidelidad-catalogo-notas.mjs
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

const { pool, obtenerPedidosActivos } = await import('../src/services/database.js');
const { previsualizarPedido, registrarPedido, resumenPedidoOficial } = await import('../src/orders/orderManager.js');
const { validarOrdenPropuesta, RECHAZOS, mensajeRechazoParaCliente } = await import('../src/orders/validadorOrden.js');
const { resolverModificadoresLLM, cargarGruposDeProductos } = await import('../src/services/modificadores.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Fidelidad Catalogo','fidelidad-catalogo')
   ON CONFLICT (slug) DO UPDATE SET nombre='Fidelidad Catalogo' RETURNING id`)).id;
const OTRO = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Otro Negocio Cat','otro-negocio-cat')
   ON CONFLICT (slug) DO UPDATE SET nombre='Otro Negocio Cat' RETURNING id`)).id;
for (const n of [NEG, OTRO]) {
  for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
    await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [n]).catch(() => {});
  }
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [n]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
const BEBIDA = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Bebida Preparada',55) RETURNING id`, [NEG, cat])).id;
const PLATO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Plato Base',195) RETURNING id`, [NEG, cat])).id;
const grupo = async (prod, nombre, negocio = NEG) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,FALSE,0,0,0) RETURNING id`, [negocio, prod, nombre])).id;
const op = async (gid, nombre, extra = 0, negocio = NEG) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [negocio, gid, nombre, extra])).id;

// Grupo de VARIANTES con un catálogo cerrado (el equivalente a "Sabor").
const gVariante = await grupo(BEBIDA, 'Variante');
for (const v of ['Alfa', 'Beta', 'Gamma', 'Delta']) await op(gVariante, v);
const gMedida = await grupo(BEBIDA, 'Medida');
await op(gMedida, 'Chica'); await op(gMedida, 'Grande', 20);
// Otro grupo que contiene un nombre que NO pertenece a Variante (cross-group).
const gComplemento = await grupo(BEBIDA, 'Complemento');
await op(gComplemento, 'Omega', 10);
// Producto con grupos para las notas.
const gSalsa = await grupo(PLATO, 'Salsa');
await op(gSalsa, 'Verde'); await op(gSalsa, 'Roja');
// Negocio ajeno con una variante que aquí NO debe valer.
const catO = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'G',0) RETURNING id`, [OTRO])).id;
const bebidaO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Bebida Preparada',55) RETURNING id`, [OTRO, catO])).id;
const gVarO = await grupo(bebidaO, 'Variante', OTRO);
await op(gVarO, 'Epsilon', 0, OTRO);

const gruposBebida = (await cargarGruposDeProductos(NEG, [BEBIDA])).get(BEBIDA) || [];
const base = (items) => ({ cliente: { nombre: 'C', telefono: '5550000009' },
  modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp', items });
const folios = [];

// ═══ A1/A2/A3 — la opción inexistente BLOQUEA y ofrece alternativas reales ══
await t('A1. grupo real + opción inexistente → NO hay preview (orden rechazada)', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Bebida Preparada', cantidad: 1,
    modificadores: [{ grupo: 'Variante', opciones: ['Sigma'] }, { grupo: 'Medida', opciones: ['Grande'] }] }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'no puede haber preview de algo que no se puede preparar');
  assert.ok(v.rechazos.some((r) => r.codigo === RECHAZOS.MODIFICADOR_NO_DISPONIBLE));
});
await t('A2. el valor solicitado NUNCA desaparece en silencio', () => {
  const r = resolverModificadoresLLM(gruposBebida, [{ grupo: 'Variante', opciones: ['Sigma'] }]);
  assert.strictEqual(r.modificadores.length, 0, 'no debe resolverse a otra cosa');
  assert.strictEqual(r.noDisponibles.length, 1, 'debe reportarse explícitamente');
  assert.strictEqual(r.noDisponibles[0].solicitado, 'Sigma');
  assert.strictEqual(r.noDisponibles[0].grupo, 'Variante');
});
await t('A3. el rechazo trae las alternativas REALES del catálogo (no del prompt)', async () => {
  const v = await validarOrdenPropuesta(base([{ nombre: 'Bebida Preparada', cantidad: 1,
    modificadores: [{ grupo: 'Variante', opciones: ['Sigma'] }] }]), NEG, { canal: 'whatsapp' });
  const r = v.rechazos.find((x) => x.codigo === RECHAZOS.MODIFICADOR_NO_DISPONIBLE);
  assert.deepStrictEqual(r.alternativas, ['Alfa', 'Beta', 'Gamma', 'Delta']);
  const msg = mensajeRechazoParaCliente(v.rechazos);
  assert.match(msg, /Sigma/, 'debe nombrar lo que pidió');
  assert.match(msg, /Alfa, Beta, Gamma y Delta/, 'debe ofrecer las opciones reales');
  assert.ok(!/plátano|platano/i.test(msg), 'jamás una lista escrita a mano en el prompt');
});
await t('A4. un typo NO se convierte arbitrariamente en otra opción válida', () => {
  const r = resolverModificadoresLLM(gruposBebida, [{ grupo: 'Variante', opciones: ['Alffa'] }]);
  assert.strictEqual(r.modificadores.length, 0, 'no debe "corregir" a Alfa por su cuenta');
  assert.strictEqual(r.noDisponibles[0].solicitado, 'Alffa');
  assert.deepStrictEqual(r.noDisponibles[0].alternativas, ['Alfa', 'Beta', 'Gamma', 'Delta']);
});

// ═══ A5 — LA NOTA LIBRE NO SE ROMPE ═════════════════════════════════════════
await t('A5. una nota libre NO se trata como opción inexistente (sigue siendo leniente)', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Plato Base', cantidad: 1,
    modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }], notas: 'sin cebolla' }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, 'una nota de preparación jamás debe bloquear el pedido');
});
await t('A5b. texto suelto sin grupo sigue el camino leniente, no el de rechazo', () => {
  const r = resolverModificadoresLLM(gruposBebida, ['bien frío']);
  assert.strictEqual(r.noDisponibles.length, 0, 'sin grupo no es una selección comercial');
  assert.deepStrictEqual(r.noReconocidos, ['bien frío']);
});

// ═══ A6/A7/A8 — camino feliz, cross-group y cross-tenant ═══════════════════
await t('A6. una opción válida real continúa normalmente', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Bebida Preparada', cantidad: 1,
    modificadores: [{ grupo: 'Variante', opciones: ['Gamma'] }, { grupo: 'Medida', opciones: ['Grande'] }] }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.preview.total, 75, '55 + 20 de Grande');
  assert.strictEqual(v.orden.items[0].modificadores.length, 2);
});
await t('A7. una opción de OTRO grupo no satisface el grupo pedido', () => {
  // "Omega" existe en Complemento, no en Variante: no puede colarse.
  const r = resolverModificadoresLLM(gruposBebida, [{ grupo: 'Variante', opciones: ['Omega'] }]);
  assert.strictEqual(r.modificadores.length, 0);
  assert.strictEqual(r.noDisponibles[0].grupo, 'Variante');
  assert.ok(!r.noDisponibles[0].alternativas.includes('Omega'));
});
await t('A8. una opción de OTRO negocio no es válida aquí (aislamiento)', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Bebida Preparada', cantidad: 1,
    modificadores: [{ grupo: 'Variante', opciones: ['Epsilon'] }] }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'una variante de otro tenant no existe para este negocio');
  assert.ok(v.rechazos.some((r) => r.codigo === RECHAZOS.MODIFICADOR_NO_DISPONIBLE));
});

// ═══ B1–B7 — la NOTA sobrevive de punta a punta ════════════════════════════
const ordenNotas = base([
  { nombre: 'Plato Base', cantidad: 1, modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }], notas: 'Sin cebolla' },
  { nombre: 'Plato Base', cantidad: 1, modificadores: [{ grupo: 'Salsa', opciones: ['Roja'] }] },
]);
const vNotas = await previsualizarPedido(ordenNotas, NEG, { canal: 'whatsapp' });
await t('B1. la nota está en la orden canónica del item correcto', () => {
  assert.ok(vNotas.ok);
  assert.strictEqual(vNotas.orden.items[0].notas, 'Sin cebolla');
  assert.strictEqual(vNotas.orden.items[1].notas, undefined, 'el segundo item NO la hereda');
});
await t('B2. la nota APARECE en el preview oficial, bajo su item', () => {
  assert.strictEqual(vNotas.preview.items[0].notas, 'Sin cebolla', 'el preview debe llevarla');
  const texto = resumenPedidoOficial(vNotas.preview);
  assert.match(texto, /NOTA: Sin cebolla/, `el resumen debe mostrarla:\n${texto}`);
  // Y solo una vez: pertenece a un item, no al pedido.
  assert.strictEqual((texto.match(/NOTA:/g) || []).length, 1);
});
await t('B3/B4. la nota sobrevive al snapshot y al registro', async () => {
  // El snapshot ES la orden canónica; se registra tal cual.
  const p = await registrarPedido({ ...vNotas.orden, negocioId: NEG, canal: 'whatsapp' }, 'whatsapp');
  folios.push(p.id);
  assert.strictEqual(p.items[0].notas, 'Sin cebolla');
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1`, [p.id]);
  assert.strictEqual(rows[0].datos.items[0].notas, 'Sin cebolla', 'debe quedar persistida');
  assert.ok(!rows[0].datos.items[1].notas, 'el segundo item sigue sin nota');
});
await t('B5/B6. la nota llega al card y a la comanda tras RELEER de persistencia', async () => {
  const folio = folios[folios.length - 1];
  const releido = (await obtenerPedidosActivos()).find((p) => p.id === folio);
  assert.strictEqual(releido.items[0].notas, 'Sin cebolla');
  // El panel pinta item.notas en el card y en la comanda impresa.
  const PANEL = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
  assert.match(PANEL, /item\.notas \? `<small class="item-nota">/, 'el card debe pintar la nota');
  const comanda = PANEL.slice(PANEL.indexOf('function comandaHTML'));
  assert.match(comanda.slice(0, 2500), /item\.notas/, 'la comanda impresa debe pintar la nota');
});
await t('B7. la nota pertenece SOLO a su item (no se propaga)', async () => {
  const folio = folios[folios.length - 1];
  const releido = (await obtenerPedidosActivos()).find((p) => p.id === folio);
  assert.strictEqual(releido.items[0].notas, 'Sin cebolla');
  assert.ok(!releido.items[1].notas, 'el segundo item jamás debe heredar la nota');
});

// ── Limpieza ────────────────────────────────────────────────────────────────
for (const f of folios) await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [f]).catch(() => {});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
