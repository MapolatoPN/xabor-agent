// CUANDO EL BOT LE DICE QUE NO A UN CLIENTE QUE QUERÍA COMPRAR.
//
// Tres casos reales del mismo día, con el mismo síntoma comercial y tres
// causas distintas. Ninguno se ve como un error: parecen respuestas normales,
// y por eso son peores que un bucle.
//
//  1. "pollito"  → el cliente pide en diminutivo y el backend no lo reconoce.
//     El arreglo de concordancia (suizos→Suiza) recorta género y número, no
//     diminutivos: la raíz de "pollito" es "pollit" y la de "pollo" es "poll".
//  2. "bistec"   → lo pide como proteína de los chilaquiles. No es opción de
//     ese grupo, y el backend contestó "no tenemos Bistec en Salsa" cuando el
//     restaurante SÍ lo tiene, como platillo. Negar sin mirar el resto de la
//     carta es perder una venta hecha.
//  3. modo solicitud → la fase determinista le cotizaba un total y le pedía
//     confirmar a un negocio que por definición no confirma pedidos por chat.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-negaciones-injustas.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-negaciones';
process.env.PORT = process.env.PORT || '4241';

const { pool } = await import('../src/services/database.js');
const { validarBorradorPedido, mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');
const { buscarOpcionPorMencion } = await import('../src/services/modificadores.js');
const { tieneRespaldo, sinDiminutivo } = await import('../src/agent/mencionesComerciales.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewConfirmable } = await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Negaciones','negaciones-injustas')
   ON CONFLICT (slug) DO UPDATE SET nombre='Negaciones' RETURNING id`)).id;
for (const tb of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = async (n, o) => (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,$2,$3) RETURNING id`, [NEG, n, o])).id;
const prod = async (c, n, p) => (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,$3,$4) RETURNING id`, [NEG, c, n, p])).id;
const gr = async (pr, n, o) => (await q1(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,TRUE,1,1,$4) RETURNING id`, [NEG, pr, n, o])).id;
const op = async (g, n) => pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,0,TRUE,0)`, [NEG, g, n]);

const cDes = await cat('Desayunos', 0);
const COMBO = await prod(cDes, 'Combito de Chilaquiles', 195);
const gSal = await gr(COMBO, 'Salsa', 0);
for (const x of ['Suiza', 'Roja', 'Verde']) await op(gSal, x);
const gPro = await gr(COMBO, 'Proteína', 1);
for (const x of ['Pechuga de pollo', 'Huevos estrellados', 'Chicharrón prensado']) await op(gPro, x);
// El platillo que el bot negó teniéndolo: existe, pero en OTRA categoría.
const cFue = await cat('Fuertes', 1);
await prod(cFue, 'Bistec en Salsa', 165);

const GRUPOS = [{ id: gPro, nombre: 'Proteína', opciones: [
  { id: 1, nombre: 'Pechuga de pollo' }, { id: 2, nombre: 'Huevos estrellados' },
  { id: 3, nombre: 'Chicharrón prensado' }] }];
const mod = (g, ...o) => ({ grupo: g, opciones: o });
const val = (mods, texto) => validarBorradorPedido(
  { items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: mods }] },
  NEG, { textoCiclo: texto });

// ═══ DIMINUTIVOS ═══════════════════════════════════════════════════════════
await t('D1. "pollito" es Pechuga de pollo', () => {
  assert.strictEqual(buscarOpcionPorMencion(GRUPOS, 'pollito').modificador?.opcion, 'Pechuga de pollo');
  assert.strictEqual(buscarOpcionPorMencion(GRUPOS, 'huevitos').modificador?.opcion, 'Huevos estrellados');
});

await t('D2. y respalda la lectura del modelo, sin repreguntar', async () => {
  assert.strictEqual(tieneRespaldo('Pechuga de pollo', 'me das unos chilaquiles con pollito'), true);
  const rc = await val([mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo')],
    'unos chilaquiles con salsa suiza y pollito');
  assert.deepStrictEqual(rc.productos[0].sinRespaldo, [], 'el diminutivo es respaldo válido');
  assert.deepStrictEqual(rc.gruposPendientes, [], 'y por tanto nada queda pendiente');
});

await t('D3. media carta mexicana termina en -ito sin ser diminutivo', () => {
  // Si el catálogo dice "Carnitas", la comparación normal acierta ANTES de que
  // se intente leerlo como diminutivo. Sin ese orden, "carnitas" se volvería
  // "carn", que es también la raíz de "Carne asada".
  const g = [{ id: 9, nombre: 'Guiso', opciones: [{ id: 1, nombre: 'Carnitas' }, { id: 2, nombre: 'Carne asada' }] }];
  assert.strictEqual(buscarOpcionPorMencion(g, 'carnitas').modificador?.opcion, 'Carnitas');
  const b = [{ id: 8, nombre: 'Antojito', opciones: [{ id: 1, nombre: 'Burrito' }, { id: 2, nombre: 'Burra' }] }];
  assert.strictEqual(buscarOpcionPorMencion(b, 'burrito').modificador?.opcion, 'Burrito');
  assert.strictEqual(sinDiminutivo('pita'), null, 'una base de 3 letras ya no es la misma palabra');
});

// ═══ NEGAR ALGO QUE SÍ ESTÁ EN LA CARTA ════════════════════════════════════
await t('B1. el bistec se OFRECE, no se niega', async () => {
  const rc = await val([mod('Salsa', 'Suiza'), mod('Proteína', 'Bistec en Salsa')],
    'chilaquiles suizos con bistec');
  const msg = mensajeBorradorParaCliente(rc);
  assert.doesNotMatch(msg, /no tenemos Bistec/i, `lo tienen; decir que no es perder la venta — ${msg}`);
  assert.match(msg, /Bistec en Salsa/, msg);
  assert.match(msg, /aparte|agrego/i, `tiene que ofrecerlo: ${msg}`);
});

await t('B2. lo que de verdad NO existe se sigue negando', async () => {
  const rc = await val([mod('Salsa', 'Suiza'), mod('Proteína', 'Langosta')],
    'chilaquiles suizos con langosta');
  const msg = mensajeBorradorParaCliente(rc);
  assert.match(msg, /no tenemos Langosta/i, `inventar disponibilidad sería peor — ${msg}`);
  assert.match(msg, /Pechuga de pollo/, `con las opciones reales del grupo: ${msg}`);
});

// ═══ EL PRODUCTO MISMO: CALLARSE NO ES NEUTRAL ═════════════════════════════
// Cuando lo único malo era el producto, `mensajeBorradorParaCliente` devolvía
// null: rc.ok era false pero sin mensaje, así que el backend no tomaba el turno
// y la prosa del modelo salía intacta. El cliente pidió un Bowl marcado NO
// DISPONIBLE; el backend lo sabía y se calló; el modelo se inventó primero una
// regla de formato ("solo se sirven en plato") y luego una cotización de $225
// por algo que jamás se podía registrar, que el cliente llegó a confirmar.
await t('P1. un producto apagado en el catálogo se dice, no se calla', async () => {
  await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible)
    VALUES ($1,$2,'Bowl de Chilaquiles',225,FALSE)`, [NEG, cDes]);
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Bowl de Chilaquiles', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero un bowl de chilaquiles' });
  assert.strictEqual(rc.ok, false, 'el borrador es inválido');
  const msg = mensajeBorradorParaCliente(rc);
  assert.ok(msg, 'un rc.ok=false SIN mensaje deja el turno al modelo: ahí nace la invención');
  assert.match(msg, /Bowl de Chilaquiles/, msg);
  assert.match(msg, /no está disponible/i, msg);
});

await t('P2. "se acabó hoy" y "está apagado" no se dicen igual', async () => {
  await pool.query(`UPDATE menu_productos SET disponible=TRUE, agotado=TRUE
    WHERE negocio_id=$1 AND nombre='Bowl de Chilaquiles'`, [NEG]);
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Bowl de Chilaquiles', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero un bowl' });
  assert.match(mensajeBorradorParaCliente(rc), /se nos acab/i,
    'lo de hoy se dice como lo de hoy: el cliente puede volver mañana');
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre='Bowl de Chilaquiles'`, [NEG]);
});

await t('P3. lo que no existe se sigue diciendo como lo que no existe', async () => {
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Sushi de Kobe', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero sushi de kobe' });
  const msg = mensajeBorradorParaCliente(rc);
  assert.match(msg, /no manejamos/i, msg);
  assert.doesNotMatch(msg, /disponible por ahora|se nos acab/i,
    'no insinuar que existe algo que nunca existió');
});

// ═══ MODO SOLICITUD ════════════════════════════════════════════════════════
await t('S1. un negocio en modo solicitud NO recibe total ni "¿confirmas?"', async () => {
  const NS = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Solo Solicitud','negaciones-solicitud')
     ON CONFLICT (slug) DO UPDATE SET nombre='Solo Solicitud' RETURNING id`)).id;
  await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='modo_pedidos'`, [NS]);
  await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'modo_pedidos','solicitud')`, [NS]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [NS]).catch(() => {});
  const c = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'Catalogo',0) RETURNING id`, [NS])).id;
  await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Arreglo Floral',450)`, [NS, c]);

  const SID = 'neg-solicitud'; deleteSession(SID);
  mock.encolarRespuesta('Con gusto lo anoto.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [{ nombre: 'Arreglo Floral', cantidad: 1, modificadores: [] }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Quiero un arreglo floral, paso por el, efectivo, a nombre de Ana',
    null, 'whatsapp', NS, '5210000000009');
  assert.doesNotMatch(r.texto, /total/i, `este negocio no promete precios finales — ${r.texto}`);
  assert.doesNotMatch(r.texto, /confirmas/i, `ni pide confirmar lo que no puede confirmar — ${r.texto}`);
  assert.strictEqual(verPreviewConfirmable(SID), null, 'y nada queda confirmable');
});

await t('S2. el negocio transaccional de al lado SÍ cotiza', async () => {
  const SID = 'neg-transaccional'; deleteSession(SID);
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1,
      modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo')] }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Luis' } }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Un combito con salsa suiza y pollo, recoger, efectivo, a nombre de Luis',
    null, 'whatsapp', NEG, '5210000000010');
  assert.match(r.texto, /\$/, `el guard no puede apagar el camino normal — ${r.texto}`);
  assert.ok(verPreviewConfirmable(SID), 'aquí sí queda confirmable');
});

mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
