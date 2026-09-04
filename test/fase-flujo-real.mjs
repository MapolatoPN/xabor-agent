// EL FLUJO REAL, DE PUNTA A PUNTA, CONTRA LA FASE DETERMINISTA.
//
// Reproduce la conversación que terminó en el folio XAB-0250 —la primera que
// salió bien en dos días— para que ese camino quede fijado: dos artículos con
// modificadores distintos, un sabor inexistente rechazado a media conversación,
// una abreviación ("pollo" por "Pechuga de pollo"), una respuesta pelada
// ("Leche entera"), un grupo opcional aceptado sin insistir, y el cierre con
// UNA confirmación y UN folio.
//
// Antes de la fase determinista esa conversación necesitaba que el modelo
// acertara en cada turno; de hecho falló en uno (repitió la pregunta de la
// leche). Ahora el backend escribe cada paso del pedido, así que el camino es
// el mismo aunque el modelo improvise.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-flujo-real.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-flujo';
process.env.PORT = process.env.PORT || '4197';

const { pool } = await import('../src/services/database.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewConfirmable } = await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Catálogo del caso real ─────────────────────────────────────────────────
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Flujo Real','flujo-real')
   ON CONFLICT (slug) DO UPDATE SET nombre='Flujo Real' RETURNING id`)).id;
for (const tb of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = async (n, o) => (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,$2,$3) RETURNING id`, [NEG, n, o])).id;
const prod = async (c, n, p) => (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,$3,$4) RETURNING id`, [NEG, c, n, p])).id;
const gr = async (pr, n, { req = true, min = 1, max = 1, o = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [NEG, pr, n, req, min, max, o])).id;
const op = async (g, n, e = 0) => pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0)`, [NEG, g, n, e]);

const cA = await cat('Combitos', 0);
const COMBITO = await prod(cA, 'Combito de Chilaquiles', 195);
const g1 = await gr(COMBITO, 'Salsa', { o: 0 }); for (const x of ['Suiza', 'Roja', 'Verde']) await op(g1, x);
const g2 = await gr(COMBITO, 'Proteína', { o: 1 }); for (const x of ['Pechuga de pollo', 'Huevos estrellados']) await op(g2, x);
const g3 = await gr(COMBITO, 'Hotcakes o Waffles', { o: 2 }); for (const x of ['Hotcakes', 'Waffles']) await op(g3, x);
const g4 = await gr(COMBITO, 'Topping', { o: 3 }); await op(g4, 'Miel'); await op(g4, 'Nutella', 30);

const cB = await cat('BEBIDAS', 1);
const LIC = await prod(cB, 'Licuado', 55);
const l1 = await gr(LIC, 'Medida', { o: 0 }); await op(l1, 'Chico'); await op(l1, 'Grande 1 Litro', 20);
const l2 = await gr(LIC, 'Sabor', { o: 1 }); for (const x of ['Platáno', 'Fresa', 'Melón']) await op(l2, x);
const l3 = await gr(LIC, 'Leche', { o: 2 }); await op(l3, 'Entera'); await op(l3, 'Deslactosada');
const l4 = await gr(LIC, 'Complementos', { req: false, min: 0, max: 3, o: 3 });
for (const x of ['Vainilla', 'Chocolate', 'Avena']) await op(l4, x);

// ── Utilidades ─────────────────────────────────────────────────────────────
const TEL = '5218787899919';
const mod = (g, ...o) => ({ grupo: g, opciones: o });
const draft = (items, extra = {}) => `Enseguida.\n<PEDIDO_BORRADOR>${JSON.stringify({ items, ...extra })}</PEDIDO_BORRADOR>`;
const menc = (...ms) => JSON.stringify({ menciones: ms.map((x) => ({ tipo: 'atributo', texto_fuente: x })) });
const turno = (sid, msg) => procesarMensaje(sid, msg, null, 'whatsapp', NEG, TEL);
const COMB_OK = [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
  mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Nutella')];
const LIC_OK = [mod('Medida', 'Grande 1 Litro'), mod('Sabor', 'Fresa'),
  mod('Complementos', 'Chocolate', 'Vainilla')];

const SID = 'real';
deleteSession(SID);

await t('R1. "con pollo" se entiende como Pechuga de pollo, y se pide solo lo que falta', async () => {
  mock.encolarRespuesta(draft([{ nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pollo')] }]));
  mock.encolarRespuesta(menc('suiza', 'pollo'));
  const r = await turno(SID, 'Quiero un combito de chilaquiles con salsa Suiza y pollo');
  assert.doesNotMatch(r.texto, /no tenemos Pollo|no manejamos "pollo"/i,
    `"pollo" es "Pechuga de pollo": no puede negarse — ${r.texto}`);
  assert.match(r.texto, /falta saber/i, r.texto);
  assert.match(r.texto, /hotcakes o waffles/i, r.texto);
  assert.match(r.texto, /topping/i, r.texto);
  assert.doesNotMatch(r.texto, /guarnici/i, `ningún grupo prestado del vecino: ${r.texto}`);
});

await t('R2. el sabor inexistente se rechaza con las opciones REALES', async () => {
  mock.encolarRespuesta(draft([
    { nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: COMB_OK },
    { nombre: 'Licuado', cantidad: 1, modificadores: [mod('Medida', 'Grande 1 Litro'), mod('Sabor', 'Mango')] }]));
  mock.encolarRespuesta(menc('hotcakes', 'nutella', 'mango', 'grande'));
  const r = await turno(SID, 'Hotcakes Nutella. Me agregas un licuado de mango grande');
  assert.match(r.texto, /Mango/i, r.texto);
  assert.match(r.texto, /Fresa/, `con los sabores reales del grupo: ${r.texto}`);
  assert.strictEqual(verPreviewConfirmable(SID), null, 'nada confirmable con algo imposible dentro');
});

await t('R3. corregido el sabor, el grupo opcional se acepta sin insistir', async () => {
  mock.encolarRespuesta(draft([
    { nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: COMB_OK },
    { nombre: 'Licuado', cantidad: 1, modificadores: LIC_OK }]));
  mock.encolarRespuesta(menc('fresa', 'chocolate', 'vainilla'));
  const r = await turno(SID, 'Ok sería fresa, con chocolate y vainilla');
  assert.match(r.texto, /falta saber/i, r.texto);
  assert.match(r.texto, /leche/i, `lo único obligatorio pendiente: ${r.texto}`);
  assert.doesNotMatch(r.texto, /complementos/i, `un opcional ya elegido no se vuelve a pedir: ${r.texto}`);
});

await t('R4. la respuesta pelada "Leche entera" NO se vuelve a preguntar', async () => {
  // El modelo OMITE la leche en su borrador: el rescate depende de la mención.
  // En el smoke real ese turno repitió la pregunta y el cliente tuvo que
  // contestar dos veces.
  mock.encolarRespuesta(draft([
    { nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: COMB_OK },
    { nombre: 'Licuado', cantidad: 1, modificadores: LIC_OK }]));
  mock.encolarRespuesta(menc('leche entera'));
  const r = await turno(SID, 'Leche entera');
  assert.doesNotMatch(r.texto, /falta saber[\s\S]*leche/i, `ya la dijo: no se repite — ${r.texto}`);
  assert.match(r.texto, /recoger|domicilio/i, `avanza al siguiente dato: ${r.texto}`);
});

await t('R5. con modalidad y pago → resumen oficial, con el total del backend', async () => {
  mock.encolarRespuesta(draft([
    { nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: COMB_OK },
    { nombre: 'Licuado', cantidad: 1, modificadores: [...LIC_OK, mod('Leche', 'Entera')] }],
  { modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Mario', telefono: TEL } }));
  mock.encolarRespuesta(menc());
  const r = await turno(SID, 'Paso a recoger a nombre de Mario. Efectivo');
  assert.match(r.texto, /Combito de Chilaquiles/, r.texto);
  assert.match(r.texto, /Licuado/, r.texto);
  assert.match(r.texto, /\$/, `el total lo pone el backend: ${r.texto}`);
  assert.ok(verPreviewConfirmable(SID), 'y el pedido queda confirmable');
});

await t('R6. "Si" registra UNA vez; un segundo "Si" ya no', async () => {
  const r = await turno(SID, 'Si');
  assert.ok(r.orden, 'el "sí" produce la orden canónica para registrar');
  assert.strictEqual(r.texto, '', 'brain no afirma éxito: lo redacta el canal tras la escritura real');
  mock.encolarRespuesta('Tu pedido ya está en cocina.');
  const r2 = await turno(SID, 'Si');
  assert.strictEqual(r2.orden, null, 'un segundo "sí" no puede crear otro folio');
});

mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
