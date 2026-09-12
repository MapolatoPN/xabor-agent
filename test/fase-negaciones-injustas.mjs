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
const { validarBorradorPedido, mensajeBorradorParaCliente, validarOrdenPropuesta } = await import('../src/orders/validadorOrden.js');
const { buscarOpcionPorMencion } = await import('../src/services/modificadores.js');
const { tieneRespaldo, sinDiminutivo, esFragmentoDeAtributo, sinConectorInicial, depurarMenciones } = await import('../src/agent/mencionesComerciales.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewConfirmable, datosDelPedido } = await import('../src/agent/session.js');

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

// ═══ D4/D5 — el diminutivo está en el CATÁLOGO, no en el cliente ═══════════
// Caso real (negocio 5de544d8…, 12:12): el menú dice "Frijolitos naturales" y
// el cliente escribió "solo frijol". El modelo lo resolvió bien, pero el
// respaldo solo recortaba el diminutivo del lado del CLIENTE, así que la
// selección se descartaba (SELECCION_SIN_RESPALDO), el grupo volvía a quedar
// vacío y el bot repreguntó la misma guarnición cinco veces sin salida.
const GUARN = await prod(cDes, 'Plato Con Guarnición', 150);
const gGua = (await q1(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,'Guarniciones',TRUE,1,2,5) RETURNING id`, [NEG, GUARN])).id;
for (const x of ['Frijolitos naturales', 'Papas a la mexicana']) await op(gGua, x);

await t('D4. catálogo en diminutivo, cliente en llano: "frijol" respalda Frijolitos naturales', async () => {
  assert.strictEqual(tieneRespaldo('Frijolitos naturales', 'quiero solo frijoles'), true,
    'sin esto se descarta lo que sí pidió y el bot repregunta sin fin');
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Plato Con Guarnición', cantidad: 1,
      modificadores: [{ grupo: 'Guarniciones', opciones: ['Frijolitos naturales'] }] }] },
    NEG, { textoCiclo: 'rojo pechuga de pollo y solo frijol' });
  assert.deepStrictEqual(rc.productos[0].sinRespaldo, [], 'la guarnición que sí pidió no se descarta');
  assert.deepStrictEqual(rc.productos[0].faltantes, [], 'y el grupo deja de estar pendiente');
});

await t('D5. la tolerancia NO se vuelve un sí para cualquier cosa', () => {
  assert.strictEqual(tieneRespaldo('Papas a la mexicana', 'quiero solo frijoles'), false,
    'una opción que el cliente nunca nombró sigue sin respaldo');
  assert.strictEqual(tieneRespaldo('Frijolitos naturales', 'quiero unos hotcakes'), false);
  assert.strictEqual(tieneRespaldo('', 'quiero frijoles'), false);
});

// ═══ EL CLIENTE CONTESTA REPITIENDO EL NOMBRE DEL GRUPO ════════════════════
// Caso de producción (negocio 5de544d8…, 2026-09-08 08:39 CDT, YA con 290ceda
// desplegado): `catalogo_conversacional_bloqueado` con
// invalidos=["mencion:proteína pollo"]. El cliente contestó repitiendo el
// nombre del grupo junto con su elección — que es exactamente como se lo
// preguntamos, "¿qué proteína llevan?" — y la mención no resolvió.
//
// "pollo" a secas SÍ resuelve. Lo que rompe es el nombre del grupo delante:
// `contienePalabra` exige que la mención ENTERA quepa dentro del nombre de la
// opción o al revés, y "proteina pollo" no cabe en "Pechuga de pollo" ni al
// revés. El nombre del grupo es contexto, no contenido.
const G2 = [
  { id: 20, nombre: 'Salsa', opciones: [{ id: 1, nombre: 'Suiza' }, { id: 2, nombre: 'Roja' }] },
  { id: 21, nombre: 'Proteína', opciones: [
    { id: 3, nombre: 'Pechuga de pollo' }, { id: 4, nombre: 'Huevos estrellados' }] },
];
await t('G1. "proteína pollo" es la Pechuga de pollo, no una mención inválida', () => {
  assert.strictEqual(buscarOpcionPorMencion(G2, 'proteína pollo').modificador?.opcion, 'Pechuga de pollo');
  assert.strictEqual(buscarOpcionPorMencion(G2, 'proteina pollo').modificador?.opcion, 'Pechuga de pollo');
  assert.strictEqual(buscarOpcionPorMencion(G2, 'proteína: pollo').modificador?.opcion, 'Pechuga de pollo');
  assert.strictEqual(buscarOpcionPorMencion(G2, 'salsa suiza').modificador?.opcion, 'Suiza');
  // Y sin el grupo delante se sigue resolviendo igual que siempre.
  assert.strictEqual(buscarOpcionPorMencion(G2, 'pollo').modificador?.opcion, 'Pechuga de pollo');
});

await t('G2. quitar el nombre del grupo no puede volverse una adivinanza', () => {
  // El grupo SOLO no elige por el cliente: no hay opción que deducir.
  assert.notStrictEqual(buscarOpcionPorMencion(G2, 'proteína').estado, 'resuelto');
  // Lo que no existe se sigue sin resolver, aunque venga con el grupo delante.
  assert.notStrictEqual(buscarOpcionPorMencion(G2, 'proteína pulpo').estado, 'resuelto');
  // Y si dentro del grupo sigue habiendo dos candidatos, se pregunta.
  const amb = [{ id: 30, nombre: 'Tamaño', opciones: [
    { id: 1, nombre: 'Grande 1 Litro' }, { id: 2, nombre: 'Grande 2 Litros' }] }];
  assert.notStrictEqual(buscarOpcionPorMencion(amb, 'tamaño grande').estado, 'resuelto');
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

// ═══ DOS COSAS PEGADAS EN UNA SOLA MENCIÓN ═════════════════════════════════
// Mensaje real: "Unos chilaquiles mixtos Salsa suiza y chipotle Prensado y
// panela en salsa si. Frijoles porfavor". El extractor devolvió "Prensado y
// panela en salsa" como UN solo span. Cada mitad casa con el catálogo; el
// pegote no casa con nada, y el backend respondió «no manejamos "Prensado y
// panela en salsa"» — bloqueando un pedido enteramente correcto.
const MIXTOS = await prod(cDes, 'Chilaquiles Mixtos', 205);
const gProM = await gr(MIXTOS, 'Proteína', 0);
for (const x of ['Huevos Estrellados', 'Chicharron Prensado', 'Bistec en Salsa',
  'Queso Panela en Salsa', 'Chicharron Cuerito en Salsa']) await op(gProM, x);
const gGuar = await gr(MIXTOS, 'Guarniciones', 1);
for (const x of ['Frijolitos naturales', 'Frijolitos con chorizo',
  'Papas a la mexicana', 'Miel y Mantequilla']) await op(gGuar, x);

const valM = (mods, texto, menciones) => validarBorradorPedido(
  { items: [{ nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: mods }] },
  NEG, { textoCiclo: texto, menciones });

await t('C1. "Prensado y panela en salsa" son DOS proteínas, no una inexistente', async () => {
  const rc = await valM(
    [mod('Proteína', 'Chicharron Prensado', 'Queso Panela en Salsa'),
      mod('Guarniciones', 'Papas a la mexicana')],
    'chilaquiles mixtos prensado y panela en salsa con papas a la mexicana',
    ['Prensado y panela en salsa']);
  const msg = mensajeBorradorParaCliente(rc);
  assert.doesNotMatch(String(msg || ''), /no manejamos/i,
    `las dos existen: no puede bloquear el pedido — ${msg}`);
  assert.deepStrictEqual(rc.mencionesNoResueltas || [], [],
    'la mención compuesta tiene que quedar resuelta');
});

await t('C2. una opción REAL con conector dentro no se parte', async () => {
  // "Frijolitos con chorizo" y "Miel y Mantequilla" llevan conector en su
  // nombre. Partir es el último recurso: resuelven enteras y nunca se cortan.
  const rc = await valM(
    [mod('Proteína', 'Chicharron Prensado'), mod('Guarniciones', 'Frijolitos con chorizo')],
    'chilaquiles mixtos con prensado y frijolitos con chorizo',
    ['Frijolitos con chorizo', 'Miel y Mantequilla']);
  assert.deepStrictEqual(rc.mencionesNoResueltas || [], [],
    'un nombre con "con" o "y" dentro sigue siendo un solo nombre');
});

await t('C3. el diminutivo también puede estar en el MENÚ', async () => {
  // Al revés que "pollito": aquí el catálogo dice "Frijolitos" y el cliente
  // escribe "Frijoles". Como hay DOS clases de frijolitos, lo correcto es
  // preguntar cuál — nunca decir que no se manejan.
  const rc = await valM(
    [mod('Proteína', 'Chicharron Prensado')],
    'chilaquiles mixtos con prensado y frijoles',
    ['Frijoles']);
  const msg = String(mensajeBorradorParaCliente(rc) || '');
  assert.doesNotMatch(msg, /no manejamos "?Frijoles/i, `los tienen: ${msg}`);
  assert.strictEqual((rc.mencionesNoResueltas || []).length, 0,
    '"Frijoles" no puede quedar como algo que el negocio no maneja');
});

await t('C4. lo que de verdad no existe se sigue diciendo, y sin el conector', async () => {
  const rc = await valM(
    [mod('Proteína', 'Chicharron Prensado'), mod('Guarniciones', 'Papas a la mexicana')],
    'chilaquiles mixtos con prensado y langosta, papas a la mexicana',
    ['Prensado y langosta']);
  const msg = String(mensajeBorradorParaCliente(rc) || '');
  assert.match(msg, /langosta/i, `hay que decirlo — ${msg}`);
  assert.doesNotMatch(msg, /Prensado y langosta/i,
    `se nombra la parte que no existe, no el pegote entero: ${msg}`);
});

// ═══ UN "SÍ" NO PUEDE COBRAR DOS VECES ═════════════════════════════════════
// XAB-0263, real y con dinero: el cliente registró su pedido (XAB-0262),
// preguntó otra cosa —"¿qué incluyen los desayunos sorpresa?"— y el modelo, con
// el resumen todavía en su contexto, reemitió el preview del pedido YA COBRADO.
// El backend construyó un snapshot confirmable NUEVO, reimprimió el resumen, el
// cliente dijo "Sí" y se registró un segundo folio idéntico de $170.
// El consumo atómico protegía contra dos "sí" sobre el MISMO snapshot; no
// contra un snapshot NUEVO del MISMO pedido.
await t('X1. tras registrar, reemitir el mismo pedido NO vuelve a cobrarlo', async () => {
  const SID = 'dup-cobro'; deleteSession(SID);
  const item = { nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Miel')] };
  const cuerpo = { items: [item], modalidad: 'recoger', forma_pago: 'efectivo',
    cliente: { nombre: 'Mario' } };
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify(cuerpo) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r1 = await procesarMensaje(SID, 'Un combito suizo con pollo, hotcakes con miel, recoger, efectivo, a nombre de Mario',
    null, 'whatsapp', NEG, '5210000000012');
  assert.match(r1.texto, /\$/, `debe cotizar la primera vez — ${r1.texto}`);
  assert.ok(verPreviewConfirmable(SID), 'y quedar confirmable');

  const r2 = await procesarMensaje(SID, 'Si', null, 'whatsapp', NEG, '5210000000012');
  assert.ok(r2.orden, 'el primer "sí" SÍ registra');

  // El cliente pregunta otra cosa y el modelo reemite el preview del pedido ya
  // cobrado, exactamente como pasó en producción.
  mock.encolarRespuesta('Con gusto.\n<ORDEN_PREVIEW>' + JSON.stringify(cuerpo) + '</ORDEN_PREVIEW>');
  const r3 = await procesarMensaje(SID, 'Que incluyen los desayunos sorpresa?',
    null, 'whatsapp', NEG, '5210000000012');
  assert.match(r3.texto, /ya quedó registrado/i, `hay que decírselo, no recotizar — ${r3.texto}`);
  assert.strictEqual(verPreviewConfirmable(SID), null,
    'y sobre todo: NADA confirmable, o el siguiente "sí" cobra de nuevo');

  // Sin preview confirmable, el "sí" es un turno normal: el modelo contesta.
  mock.encolarRespuesta('Perfecto, te aviso cuando esté.');
  const r4 = await procesarMensaje(SID, 'Si', null, 'whatsapp', NEG, '5210000000012');
  assert.strictEqual(r4.orden, null, 'un "sí" de cortesía no puede crear un segundo folio');
});

await t('X2. pero repetir un pedido a propósito SÍ se puede', async () => {
  const SID = 'dup-cobro';
  const item = { nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Miel')] };
  const cuerpo = { items: [item], modalidad: 'recoger', forma_pago: 'efectivo',
    cliente: { nombre: 'Mario' } };
  // La guarda es de UN SOLO USO: ya avisó una vez, así que este sí procede.
  mock.encolarRespuesta('Claro.\n<ORDEN_PREVIEW>' + JSON.stringify(cuerpo) + '</ORDEN_PREVIEW>');
  const r = await procesarMensaje(SID, 'Sí, quiero otro igual', null, 'whatsapp', NEG, '5210000000012');
  assert.match(r.texto, /\$/, `pedir otro igual es legítimo y frecuente — ${r.texto}`);
  assert.ok(verPreviewConfirmable(SID), 'y tiene que poder confirmarse');
});

// ═══ EL BACKEND LEE LA RESPUESTA A SU PROPIA PREGUNTA ══════════════════════
// Bucle real: el backend pidió la dirección, el cliente escribió "Boulevard
// Cbtis 34 #208 Col Guillén", y el backend la volvió a pedir. Y otra vez. El
// dato solo viajaba dentro del borrador del modelo; si el modelo no lo ponía,
// nadie lo veía y el cliente contestaba a una pregunta que nadie oía.
await t('A1. la dirección dicha NO se vuelve a pedir', async () => {
  const SID = 'dir-bucle'; deleteSession(SID);
  const item = { nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Miel')] };
  // Turno 1: pide a domicilio, sin dirección todavía.
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [item], modalidad: 'entrega a domicilio' }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r1 = await procesarMensaje(SID, 'Un combito suizo con pollo, hotcakes con miel, a domicilio',
    null, 'whatsapp', NEG, '5210000000013');
  assert.match(r1.texto, /direcci[óo]n/i, `el backend tiene que pedirla — ${r1.texto}`);

  // Turno 2: el cliente la da y el modelo NO la pone en su borrador.
  mock.encolarRespuesta('Perfecto.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [item], modalidad: 'entrega a domicilio' }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r2 = await procesarMensaje(SID, 'Boulevard Cbtis 34 #208 Col Guillén',
    null, 'whatsapp', NEG, '5210000000013');
  assert.doesNotMatch(r2.texto, /A qué dirección te lo enviamos/i,
    `la dijo: volver a pedirla es el bucle — ${r2.texto}`);
  assert.strictEqual(datosDelPedido(SID).direccion, 'Boulevard Cbtis 34 #208 Col Guillén',
    'el backend tiene que haberla capturado él mismo');
});

await t('A2. un "sí" o un "gracias" NO se toman por una dirección', async () => {
  const SID = 'dir-corta'; deleteSession(SID);
  const item = { nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Miel')] };
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [item], modalidad: 'entrega a domicilio' }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  await procesarMensaje(SID, 'Un combito a domicilio', null, 'whatsapp', NEG, '5210000000014');
  mock.encolarRespuesta('Claro.');
  await procesarMensaje(SID, 'Sí', null, 'whatsapp', NEG, '5210000000014');
  assert.strictEqual(datosDelPedido(SID).direccion, undefined,
    'guardar "Sí" como calle sería peor que preguntar otra vez');
});

await t('A3. la modalidad también se lee, contra las palabras de la pregunta', async () => {
  const SID = 'modalidad-lee'; deleteSession(SID);
  const item = { nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Miel')] };
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({ items: [item] }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r1 = await procesarMensaje(SID, 'Un combito suizo con pollo, hotcakes con miel',
    null, 'whatsapp', NEG, '5210000000015');
  assert.match(r1.texto, /recoger|domicilio/i, r1.texto);
  mock.encolarRespuesta('Perfecto.\n<PEDIDO_BORRADOR>' + JSON.stringify({ items: [item] }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r2 = await procesarMensaje(SID, 'Paso a recoger', null, 'whatsapp', NEG, '5210000000015');
  assert.strictEqual(datosDelPedido(SID).modalidad, 'recoger', 'la respuesta la lee el backend');
  assert.doesNotMatch(r2.texto, /recoger en tienda o prefieres/i,
    `no puede volver a preguntar lo contestado — ${r2.texto}`);
});

// ═══ LA MODALIDAD LA DECIDE EL CLIENTE, NO EL MODELO ═══════════════════════
// XAB-0271: el cliente nunca dijo si pasaba por su pedido o se lo llevaban. El
// modelo escribió "recoger en tienda" en su borrador y, como el guard solo
// preguntaba con el borrador VACÍO, la pregunta se saltó. El pedido quedó como
// recoger, con costo_envio 0. Si ese cliente esperaba su comida en casa, nadie
// se la iba a llevar.
const itemM = () => ({ nombre: 'Combito de Chilaquiles', cantidad: 1,
  modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Miel')] });

await t('M1. si el cliente no dijo modalidad, se le PREGUNTA aunque el modelo la invente', async () => {
  const SID = 'modalidad-inventada'; deleteSession(SID);
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [itemM()], modalidad: 'recoger en tienda', forma_pago: 'efectivo' }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Quiero un combito suizo con pollo, hotcakes con miel',
    null, 'whatsapp', NEG, '5210000000021');
  assert.match(r.texto, /recoger en tienda o prefieres/i,
    `el cliente no lo dijo: hay que preguntarlo — ${r.texto}`);
  assert.strictEqual(verPreviewConfirmable(SID), null, 'y nada puede quedar confirmable todavía');
});

await t('M2. si el cliente SÍ lo dijo, no se le pregunta de más', async () => {
  const SID = 'modalidad-dicha'; deleteSession(SID);
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [itemM()], modalidad: 'entrega a domicilio' }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Un combito suizo con pollo, hotcakes con miel, a domicilio',
    null, 'whatsapp', NEG, '5210000000022');
  assert.doesNotMatch(r.texto, /recoger en tienda o prefieres/i,
    `lo dijo: preguntarlo otra vez es el bucle — ${r.texto}`);
  assert.match(r.texto, /direcci[óo]n/i, `toca pedir la dirección — ${r.texto}`);
});

await t('M3. "para llevar" es que el cliente PASA por él, no que se lo lleven', async () => {
  // En México "para llevar" es para llevárselo uno. Leerlo como domicilio le
  // cobraría envío y mandaría un repartidor a alguien que iba a la tienda.
  const SID = 'para-llevar'; deleteSession(SID);
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({ items: [itemM()] }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Un combito suizo con pollo, hotcakes con miel, para llevar',
    null, 'whatsapp', NEG, '5210000000023');
  assert.doesNotMatch(r.texto, /direcci[óo]n/i,
    `nadie va a llevárselo a su casa: no se le pide dirección — ${r.texto}`);
});

await t('M4. la forma de pago tampoco se da por dicha', async () => {
  // Un pedido de tarjeta registrado como efectivo descuadra la caja.
  const SID = 'pago-inventado'; deleteSession(SID);
  mock.encolarRespuesta('Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [itemM()], modalidad: 'recoger', forma_pago: 'efectivo' }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Un combito suizo con pollo, hotcakes con miel, paso a recoger',
    null, 'whatsapp', NEG, '5210000000024');
  assert.match(r.texto, /forma de pago|c[óo]mo deseas pagar/i,
    `el cliente no eligió pago: hay que preguntarlo — ${r.texto}`);
  assert.strictEqual(verPreviewConfirmable(SID), null, 'sin pago elegido no hay nada que confirmar');
});

// ═══ FRAGMENTO COLGADO ═════════════════════════════════════════════════════
//
// Cuarto caso de la misma familia, y el más caro de ver porque el bot ya había
// contestado bien un turno antes.
//
// Obispado, 2026-09-10 18:19, clienta ***7552:
//
//   18:18:44  clienta  "4 platillos de hotkeis con fruta de 139"
//   18:18:54  bot      "...acompañadas de fruta fresca de temporada"   ✔
//   18:19:03  clienta  "un platillo de waffles con fruta de 149"
//   18:19:15  bot      'Una disculpa: no manejamos "con fruta".'       ✘
//   18:19:53  HUMANO   entra a rescatar el pedido
//
// El extractor partió "waffles con fruta de 149" en DOS artículos del
// borrador: `Waffles` y `con fruta`. El segundo no es un platillo, es la cola
// del primero. El validador lo buscó en la lista de productos, no lo encontró
// y acusó al negocio de no venderlo — cuando la descripción de Waffles dice
// literalmente "acompañados de fruta".
//
// Detalle que delata el camino: el mensaje dice `no manejamos "con fruta"` SIN
// nombre de producto. Los otros dicen `no manejamos "con pollo" en Chilaquiles
// Sencillos`. Esa rama sin producto es `productosNoExisten`, que se llena
// desde `borrador.items` — no desde las menciones.
const cWaf = await cat('Waffles y Hotcakes', 2);
const WAF = await prod(cWaf, 'Waffles', 159);
const gTopW = await gr(WAF, 'Topping', 1);
await op(gTopW, 'Miel y Mantequilla'); await op(gTopW, 'Nutella');
await pool.query(`UPDATE menu_productos SET descripcion=$2 WHERE id=$1`,
  [WAF, '2 piezas de waffle, acompañados de fruta y algún topping.']);
// Una opción REAL que empieza por la palabra que sigue al conector: sirve para
// comprobar que la recuperación de "de mango" no se pierde por el camino.
const LIC = await prod(cWaf, 'Licuado', 55);
const gSab = await gr(LIC, 'Sabor', 1);
await op(gSab, 'Mango'); await op(gSab, 'Fresa');

await t('F1. "con fruta" NO se declara producto inexistente', async () => {
  const rc = await validarBorradorPedido(
    { items: [
      { nombre: 'Waffles', cantidad: 1, modificadores: ['Nutella'] },
      { nombre: 'con fruta', cantidad: 1, modificadores: [] },
    ] },
    NEG, { textoCiclo: 'Y un platillo de waffles con fruta de 149' });
  const msg = mensajeBorradorParaCliente(rc) || '';
  assert.doesNotMatch(msg, /no manejamos/i,
    `el menú SÍ los incluye; acusar al negocio pierde la venta — ${msg}`);
  assert.doesNotMatch(msg, /con fruta/i, `no puede citar el fragmento como producto — ${msg}`);
  assert.ok(!(rc.productosNoExisten || []).some((x) => /con fruta/i.test(x?.nombre || x)),
    'el fragmento no puede acabar en productosNoExisten');
});

await t('F2. y el producto real del mismo artículo se conserva', async () => {
  const rc = await validarBorradorPedido(
    { items: [
      { nombre: 'Waffles', cantidad: 1, modificadores: ['Nutella'] },
      { nombre: 'con fruta', cantidad: 1, modificadores: [] },
    ] },
    NEG, { textoCiclo: 'Y un platillo de waffles con fruta de 149' });
  // `productos[].producto` es el NOMBRE de catálogo, ya canonizado.
  const nombres = (rc.productos || []).map((p) => p.producto);
  assert.ok(nombres.some((n) => /Waffles/i.test(String(n))),
    `descartar el fragmento no puede llevarse el platillo — ${JSON.stringify(nombres)}`);
});

await t('F3. la opción real se recupera cuando el fragmento la nombra', async () => {
  // "de mango" es fragmento; Mango es una opción REAL del Licuado. Descartar
  // el fragmento como PRODUCTO no puede impedir que la mención lo resuelva.
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Licuado', cantidad: 1, modificadores: [] },
      { nombre: 'de mango', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'un licuado de mango', menciones: ['de mango'] });
  const msg = mensajeBorradorParaCliente(rc) || '';
  assert.doesNotMatch(msg, /no manejamos/i, `"de mango" no es una acusación — ${msg}`);
  assert.strictEqual(buscarOpcionPorMencion(
    [{ id: gSab, nombre: 'Sabor', opciones: [{ nombre: 'Mango' }, { nombre: 'Fresa' }] }], 'mango').estado,
  'resuelto', 'y Mango se sigue resolviendo como la opción que es');
});

await t('F4. las demás variantes con conector inicial tampoco acusan', async () => {
  for (const fragmento of ['con fruta', 'de mango', 'en salsa']) {
    const rc = await validarBorradorPedido(
      { items: [
        { nombre: 'Waffles', cantidad: 1, modificadores: ['Nutella'] },
        { nombre: fragmento, cantidad: 1, modificadores: [] },
      ] },
      NEG, { textoCiclo: `unos waffles ${fragmento}` });
    const msg = mensajeBorradorParaCliente(rc) || '';
    assert.doesNotMatch(msg, /no manejamos/i, `"${fragmento}" produjo una negación — ${msg}`);
  }
});

await t('F5. lo que de verdad no existe SIGUE rechazándose', async () => {
  // La corrección no puede convertirse en una puerta para aceptar cualquier
  // texto: solo mira la PRIMERA palabra, y solo si es un conector de atributo.
  for (const invento of ['Sushi de Kobe', 'Pizza Hawaiana', 'fruta']) {
    const rc = await validarBorradorPedido(
      { items: [{ nombre: invento, cantidad: 1, modificadores: [] }] },
      NEG, { textoCiclo: `quiero ${invento}` });
    assert.strictEqual(rc.ok, false, `"${invento}" no existe y tiene que rechazarse`);
    assert.match(mensajeBorradorParaCliente(rc) || '', /no manejamos/i,
      `"${invento}" debía producir una negación honesta`);
  }
  // Y un conector suelto no basta para tragarse nada.
  assert.strictEqual(esFragmentoDeAtributo('de'), false, 'una palabra suelta no es fragmento');
  assert.strictEqual(esFragmentoDeAtributo('Frijolitos con chorizo'), false,
    'el conector INTERNO no cuenta: esa opción existe y se llama así');
  assert.strictEqual(esFragmentoDeAtributo('Miel y Mantequilla'), false);
});

// ═══ LA SEGUNDA PUERTA ═════════════════════════════════════════════════════
//
// El mismo fragmento, entrando como MENCIÓN en vez de como artículo. F1-F5
// taparon la puerta del borrador (`productosNoExisten`); estas tapan la de
// las menciones (`no manejamos "X" en PRODUCTO`).
//
// En 30 días de producción, el bot emitió 11 negaciones automáticas y CUATRO
// empezaban por preposición:
//
//   09-10  "con fruta"    → artículo  (la cubre F1)
//   09-05  "con bistec"   → mención
//   09-04  "con carne"    → mención, "en Chilaquiles Sencillos"
//   09-04  "con pollo"    → mención, "en Chilaquiles Sencillos"
//
// Las tres últimas son clientes que pidieron su platillo CON una proteína que
// el negocio sí tiene, y recibieron un "no manejamos". `sinConectorInicial`
// las convierte en "bistec", "carne" y "pollo", que es lo que el cliente dijo
// y lo que el catálogo sabe resolver.
await t('H1. "con pollo" entra como "pollo" y no como una acusación', () => {
  const r = depurarMenciones([{ texto_fuente: 'con pollo', tipo: 'atributo' }],
    'chilaquiles sencillos con pollo');
  assert.deepStrictEqual(r.atributos, ['pollo'],
    'el conector viaja DENTRO del span y esquiva las tres barreras');
  assert.strictEqual(r.descartadas.length, 0, 'y tampoco se pierde por el camino');
});

await t('H2. las tres variantes reales de producción quedan limpias', () => {
  const casos = [
    ['con pollo', 'chilaquiles sencillos con pollo', 'pollo'],
    ['con carne', 'unos chilaquiles con carne', 'carne'],
    ['con bistec', 'desayuno sorpresa con bistec', 'bistec'],
    ['de mango', 'un licuado de mango', 'mango'],
  ];
  for (const [span, texto, esperado] of casos) {
    const r = depurarMenciones([{ texto_fuente: span, tipo: 'atributo' }], texto);
    assert.deepStrictEqual(r.atributos, [esperado], `"${span}" → esperaba ["${esperado}"]`);
  }
});

await t('H3. y "con pollo" SÍ resuelve la proteína, no solo deja de acusar', async () => {
  // Quitar la acusación no basta: la selección del cliente tiene que llegar.
  // Contra el producto que SÍ tiene esa proteína: 'Combito de Chilaquiles'.
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'un combito de chilaquiles con pollo', menciones: ['pollo'] });
  const msg = mensajeBorradorParaCliente(rc) || '';
  assert.doesNotMatch(msg, /no manejamos/i, `"pollo" es una proteína real de ese platillo — ${msg}`);
});

await t('H4. lo que lleva el conector DENTRO no se toca', () => {
  // "Frijolitos con chorizo" y "Miel y Mantequilla" son nombres de catálogo.
  // Solo cuenta la PRIMERA palabra.
  for (const intacto of ['Frijolitos con chorizo', 'Miel y Mantequilla', 'Queso panela en salsa']) {
    assert.strictEqual(sinConectorInicial(intacto), intacto, `"${intacto}" no se puede recortar`);
  }
  assert.strictEqual(sinConectorInicial('de'), 'de', 'un conector suelto no se come a sí mismo');
});

await t('H5. un invento con conector sigue pudiendo negarse, ya sin la preposición', () => {
  // La honestidad se conserva: si el cliente pide algo que no existe, el bot
  // puede decirlo. Lo que cambia es que cita lo que el cliente dijo de verdad.
  const r = depurarMenciones([{ texto_fuente: 'con unicornio', tipo: 'atributo' }],
    'unos chilaquiles con unicornio');
  assert.deepStrictEqual(r.atributos, ['unicornio'],
    'negar "unicornio" es honesto; negar "con unicornio" es un error de lectura');
});

// ═══ LA RESPUESTA A UNA PREGUNTA DE LOGÍSTICA NO ACUSA ═════════════════════
//
// Incidente ***9939, Obispado, 2026-09-08 20:54:
//
//   20:53:27  bot      "¿A qué dirección te lo enviamos? Necesito calle,
//                       número y colonia."
//   20:53:53  clienta  "Nogal 900 acoros ai"
//   20:54:05  bot      'Una disculpa: no manejamos "900" y "acoros" en Waffles.'
//   20:54:23  HUMANO   entra a rescatar
//
// El backend había preguntado la dirección y la consumió bien. Pero después
// mandó ESE MISMO texto al comparador de catálogo, porque el pedido ya tenía
// artículos. Las barreras del módulo son posicionales y léxicas; una
// dirección las cumple sin esfuerzo. Y `tieneRespaldo("900", ...)` es TRUE
// porque la clienta escribió "900": ese guard comprueba autoría, no
// pertinencia.
await t('I1. la dirección no puede producir "no manejamos"', async () => {
  const SID = 'neg-direccion'; deleteSession(SID);
  // Turno 1: pide el platillo y elige domicilio. El backend queda esperando
  // la dirección.
  mock.encolarRespuesta('Claro.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1,
      modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo')] }],
    modalidad: 'entrega a domicilio', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  await procesarMensaje(SID, 'Un combito suizo con pollo a domicilio, efectivo, a nombre de Ana',
    null, 'whatsapp', NEG, '5210000000091');

  // Turno 2: contesta la dirección. El extractor la lee como si fueran
  // atributos del menú — que es justo lo que pasó en producción.
  mock.encolarRespuesta('Perfecto.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1,
      modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo')] }],
    modalidad: 'entrega a domicilio', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } }) + '</PEDIDO_BORRADOR>');
  // Así lo clasificó el extractor en producción: 'Nogal' parece un nombre de
  // producto, se vuelve ANCLA, y '900' y 'acoros' se encadenan a ella como
  // atributos. Encadenados ya pueden acusar.
  mock.encolarRespuesta(JSON.stringify({ menciones: [
    { tipo: 'producto', texto_fuente: 'Nogal' },
    { tipo: 'atributo', texto_fuente: '900' },
    { tipo: 'atributo', texto_fuente: 'acoros' }] }));
  const r = await procesarMensaje(SID, 'Nogal 900 acoros ai', null, 'whatsapp', NEG, '5210000000091');

  assert.doesNotMatch(r.texto, /no manejamos/i,
    `una dirección no es una selección del menú — ${r.texto}`);
  assert.doesNotMatch(r.texto, /900|acoros/i,
    `no puede citar trozos de la dirección como si fueran platillos — ${r.texto}`);
});

await t('I2. y la dirección SÍ se guarda: el turno no se pierde', async () => {
  const d = datosDelPedido('neg-direccion') || {};
  assert.match(String(d.direccion || ''), /Nogal/i,
    `el dato que se preguntó tiene que quedar registrado — ${JSON.stringify(d)}`);
});

// ═══ Q — EL PLATILLO QUE EXISTE TRES VECES ═════════════════════════════════
//
// Incidente 2026-09-11, 6:40 p.m., prueba del dueño:
//
//   cliente  'Si quiero unos chilaquiles suizos con pollo, bistec en salsa y
//             queso panela Además una orden de hotcakes de sartén'
//   bot      'Una disculpa: no manejamos "Chilaquiles".'            ✘
//
// El menú de Obispado tiene TRES: Chilaquiles Sencillos, Chilaquiles Mixtos y
// Bowl de Chilaquiles. Los tres contienen la palabra, la búsqueda devolvía tres
// candidatos, y un `candidatos.length !== 1` los mandaba al mismo cajón que un
// producto inexistente.
//
// No resolver estaba BIEN: entre tres platillos no se adivina. Lo que estaba
// mal era el mensaje. Ambigüedad y ausencia son cosas distintas y el cliente
// merece la pregunta, no la negativa.
const cAmb = await cat('Chilaquiles (ambigüedad)', 40);
await prod(cAmb, 'Chilaquiles Sencillos', 175);
await prod(cAmb, 'Chilaquiles Mixtos', 195);

const pedirChilaquiles = (nombre = 'Chilaquiles') => validarBorradorPedido(
  { items: [{ nombre, cantidad: 1, modificadores: [] }] },
  NEG, { textoCiclo: 'quiero unos chilaquiles suizos con pollo' });

await t('Q1. un platillo con varias variantes NO se declara inexistente', async () => {
  const rc = await pedirChilaquiles();
  const msg = mensajeBorradorParaCliente(rc) || '';
  assert.doesNotMatch(msg, /no manejamos/i,
    `el menú tiene tres chilaquiles; negarlos pierde la venta — ${msg}`);
  const marcado = (rc.productosNoExisten || []).find((x) => /chilaquiles/i.test(x?.nombre || x));
  assert.ok(marcado, 'el artículo sigue sin resolverse (correcto: no se adivina)');
  assert.strictEqual(marcado.estado, 'ambiguo',
    'debe distinguirse de un producto que de verdad no existe');
});

await t('Q2. se le ofrecen las variantes por su nombre y se le pregunta', async () => {
  const msg = mensajeBorradorParaCliente(await pedirChilaquiles()) || '';
  assert.match(msg, /Chilaquiles Sencillos/, `falta una variante — ${msg}`);
  assert.match(msg, /Chilaquiles Mixtos/, `falta una variante — ${msg}`);
  assert.match(msg, /¿Cuál prefieres\?/, `tiene que preguntar, no informar — ${msg}`);
  assert.doesNotMatch(msg, /Una disculpa/i,
    `pedirle que elija entre platillos que sí tenemos no es una mala noticia — ${msg}`);
});

await t('Q3. seguir sin adivinar: el pedido NO queda confirmable', async () => {
  const rc = await pedirChilaquiles();
  assert.strictEqual(rc.ok, false, 'un nombre que apunta a tres platillos no puede pasar');
  const nombres = (rc.productos || []).map((p) => p.producto);
  assert.deepStrictEqual(nombres.filter((n) => /chilaquiles/i.test(n)), [],
    'no puede elegir una variante por su cuenta');
});

await t('Q4. y el registro REAL lo rechaza con la misma dureza', async () => {
  // La puerta de atrás: validarOrden es la que registra el pedido de verdad, y
  // ahí un estado nuevo sin su corte habría seguido de largo hasta el código
  // que lee `r.producto`, que en un ambiguo no existe.
  const v = await validarOrdenPropuesta({
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 175, modificadores: [] }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Prueba' },
  }, NEG);
  assert.strictEqual(v.ok, false, 'un nombre ambiguo jamás puede registrarse');
  assert.ok((v.rechazos || []).some((r) => /PRODUCTO_NO_EXISTE|no_existe/i.test(r.codigo || '')),
    `debe rechazarse explícitamente — ${JSON.stringify(v.rechazos)}`);
});

await t('Q5. un producto que de verdad no existe SIGUE recibiendo la negativa', async () => {
  // La red de seguridad: relajar la ambigüedad no puede volver mudo el caso
  // legítimo. "Sushi de Kobe" no está en la carta y hay que decirlo.
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Sushi de Kobe', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero sushi de kobe' });
  const msg = mensajeBorradorParaCliente(rc) || '';
  assert.match(msg, /no manejamos/i, `lo que no existe se dice — ${msg}`);
  assert.match(msg, /Sushi de Kobe/i, `y se nombra — ${msg}`);
});

await t('Q6. una variante apagada no se ofrece entre las opciones', async () => {
  await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible)
    VALUES ($1,$2,'Chilaquiles Divorciados',215,FALSE)`, [NEG, cAmb]);
  const msg = mensajeBorradorParaCliente(await pedirChilaquiles()) || '';
  assert.doesNotMatch(msg, /Divorciados/,
    `ofrecer algo apagado promete lo que no se puede entregar — ${msg}`);
  assert.match(msg, /Chilaquiles Sencillos/, `las que sí van se siguen ofreciendo — ${msg}`);
});


// ═══ R — SEÑALAR EN VEZ DE ESCRIBIR ═══════════════════════════════════════
//
// La raíz de los nueve incidentes de esta familia: el prompt le PROHIBÍA al
// modelo mapear las palabras del cliente contra la carta ("incluye lo que pidió
// TAL CUAL, no lo arregles tú") y el código tenía que averiguarlo comparando
// cadenas de texto. El modelo no podía identificar y el código no sabía.
//
// Ahora el menú del prompt lleva "[P78]" delante de cada platillo y el modelo
// señala el que reconoció. La autoridad no se mueve: precio, disponibilidad,
// grupos y totales se siguen leyendo del catálogo. Lo único que cambia es quién
// decide A CUÁL se refería el cliente.
const cIds = await cat('Señalar (ids)', 50);
const ID_SENCILLOS = await prod(cIds, 'Chilaquiles Coloniales', 175);
const ID_MIXTOS = await prod(cIds, 'Chilaquiles Coloniales Mixtos', 195);

await t('R1. con el id señalado se resuelve exacto, sin comparar texto', async () => {
  // El nombre va deliberadamente MAL escrito: si el id no mandara, esto no
  // resolvería nada.
  const rc = await validarBorradorPedido(
    { items: [{ id: `P${ID_SENCILLOS}`, nombre: 'chilakiles', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero unos chilakiles' });
  const nombres = (rc.productos || []).map((p) => p.producto);
  assert.ok(nombres.includes('Chilaquiles Coloniales'),
    `el id tenía que resolverlo pese al nombre mal escrito — ${JSON.stringify(nombres)}`);
});

await t('R2. el id desempata lo que el texto no puede', async () => {
  // "Coloniales" está contenido en los DOS platillos: por nombre hay que
  // preguntar cuál. Señalando el id, no hay nada que preguntar.
  //
  // (Con el nombre COMPLETO no habría duda: la igualdad exacta gana antes de
  // llegar a la contención. La ambigüedad aparece cuando el cliente nombra de
  // menos, que es como habla la gente.)
  const porNombre = await validarBorradorPedido(
    { items: [{ nombre: 'Coloniales', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero unos coloniales' });
  const dudoso = (porNombre.productosNoExisten || []).find((x) => /^coloniales$/i.test(x?.nombre || ''));
  assert.ok(dudoso, 'por nombre solo, tiene que quedar sin resolver');
  assert.strictEqual(dudoso.estado, 'ambiguo', 'y la razón es la ambigüedad, no la ausencia');

  const porId = await validarBorradorPedido(
    { items: [{ id: `P${ID_MIXTOS}`, nombre: 'Chilaquiles Coloniales', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero los mixtos' });
  assert.ok((porId.productos || []).map((p) => p.producto).includes('Chilaquiles Coloniales Mixtos'),
    'señalando el id no hay nada que preguntar');
});

await t('R3. un id inventado NO inventa un platillo: se cae al nombre', async () => {
  // La prueba de que señalar es más seguro que escribir. Un id que no existe no
  // se parece a nada, así que no puede emparejar con el platillo equivocado.
  const rc = await validarBorradorPedido(
    { items: [{ id: 'P99999999', nombre: 'Chilaquiles Coloniales Mixtos', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero los mixtos' });
  assert.ok((rc.productos || []).map((p) => p.producto).includes('Chilaquiles Coloniales Mixtos'),
    'con el id muerto tiene que seguir el camino del nombre, como siempre');
});

await t('R4. un id de OTRO negocio no cruza la frontera', async () => {
  // El catálogo que se consulta ya está filtrado por negocio, así que un id
  // ajeno simplemente no está ahí. Se comprueba de frente porque un
  // identificador que saltara de negocio sería mucho peor que un nombre.
  const ajeno = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Ajeno Ids','ajeno-ids')
    ON CONFLICT (slug) DO UPDATE SET nombre='Ajeno Ids' RETURNING id`)).id;
  const catAjena = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'Ajena',1) RETURNING id`, [ajeno])).id;
  const prodAjeno = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Secreto Ajeno',999) RETURNING id`, [ajeno, catAjena])).id;
  const rc = await validarBorradorPedido(
    { items: [{ id: `P${prodAjeno}`, nombre: 'Secreto Ajeno', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero el secreto ajeno' });
  const nombres = (rc.productos || []).map((p) => p.producto);
  assert.ok(!nombres.includes('Secreto Ajeno'), 'un id de otro negocio JAMÁS puede resolver');
});

await t('R5. el menú del prompt trae los identificadores', async () => {
  const { construirSystemPrompt } = await import('../src/agent/prompts.js');
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.match(prompt, new RegExp(`\\[P${ID_SENCILLOS}\\] Chilaquiles Coloniales`),
    'sin el id en el menú, el modelo no tiene qué señalar');
  assert.match(prompt, /EL CAMPO "id" ES EL DEL MENÚ DE ARRIBA/,
    'y tiene que estar dicho cómo usarlo');
  assert.match(prompt, /SI NO ESTÁS SEGURO DE CUÁL ES, OMITE EL "id"/,
    'omitir ante la duda es la mitad que evita que elija por el cliente');
});

await t('R6. idSenalado acepta lo que el modelo escribe de verdad, y nada más', async () => {
  const { idSenalado } = await import('../src/orders/validadorOrden.js');
  for (const [entrada, esperado] of [
    ['P78', '78'], ['p78', '78'], ['78', '78'], ['[P78]', '78'],
    ['[P78] Chilaquiles Sencillos', '78'],
    ['Chilaquiles Sencillos', null], ['', null], [null, null], [undefined, null],
    ['P', null], ['PABC', null], ['DROP TABLE', null],
  ]) {
    assert.strictEqual(idSenalado(entrada), esperado, `idSenalado(${JSON.stringify(entrada)})`);
  }
});


// ═══ T — LO QUE EL CLIENTE YA DIJO SIRVE PARA NO VOLVER A PREGUNTAR ═══════
//
// Incidente 2026-09-11, 11:26 p.m., con la ambigüedad ya arreglada:
//
//   cliente  'Quiero unos chilaquiles'
//   bot      'De "Chilaquiles" tenemos Bowl, Combito, Sencillos o Mixtos.
//             ¿Cuál prefieres?'                                          OK
//   cliente  'Quiero unos chilaquiles en salsa Suiza con huevos estrellados
//             y le pones frijoles y papas a la mexicana'
//   bot      (la MISMA pregunta, palabra por palabra)                     MAL
//
// El cliente contestó con todo el detalle y recibió la misma pregunta. El
// sistema tenía razón --nunca dijo "Sencillos"-- pero ignoró que las
// guarniciones que nombró ya descartaban una variante: un Bowl no tiene grupo
// de guarniciones y los frijoles no caben ahí.
//
// Descartar no es elegir por el cliente: es dejar de ofrecerle lo que no puede
// pedir.
const cVar = await cat('Variantes por lo pedido', 60);
const V_BOWL = await prod(cVar, 'Tazon Sencillo', 140);
const V_PLATO = await prod(cVar, 'Tazon Sencillo Completo', 195);
// El Bowl solo tiene Salsa y Proteína. El Completo agrega Guarniciones.
const gsB = await gr(V_BOWL, 'Salsa', 0); for (const x of ['Suiza', 'Roja']) await op(gsB, x);
const gpB = await gr(V_BOWL, 'Proteína', 1); for (const x of ['Huevos Estrellados', 'Pechuga de pollo']) await op(gpB, x);
const gsP = await gr(V_PLATO, 'Salsa', 0); for (const x of ['Suiza', 'Roja']) await op(gsP, x);
const gpP = await gr(V_PLATO, 'Proteína', 1); for (const x of ['Huevos Estrellados', 'Pechuga de pollo']) await op(gpP, x);
const ggP = await q1(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
  VALUES ($1,$2,'Guarniciones',TRUE,1,2,2) RETURNING id`, [NEG, V_PLATO]);
for (const x of ['Frijolitos naturales', 'Papas a la mexicana']) await op(ggP.id, x);

// El nombre CORTO, que es como habla la gente. Con el nombre completo la
// igualdad exacta gana antes de llegar a la ambiguedad y no habria nada que
// estrechar.
const pedirTazon = (mods) => validarBorradorPedido(
  { items: [{ nombre: 'Tazon', cantidad: 1, modificadores: mods }] },
  NEG, { textoCiclo: 'quiero un tazon con '+mods.flatMap(m=>m.opciones||[]).join(', ') });

await t('T1. sin detalle, se pregunta entre las dos (como antes)', async () => {
  const rc = await validarBorradorPedido(
    { items: [{ nombre: 'Tazon', cantidad: 1, modificadores: [] }] },
    NEG, { textoCiclo: 'quiero un tazon' });
  const amb = (rc.productosNoExisten || []).find((x) => /^tazon$/i.test(x?.nombre || ''));
  assert.ok(amb && amb.estado === 'ambiguo', 'sin nada que lo distinga, hay que preguntar');
  assert.strictEqual((amb.candidatos || []).length, 2);
});

await t('T2. las guarniciones descartan la variante que no las tiene', async () => {
  // Frijoles y papas solo caben en el Completo. Queda UNA: no hay que preguntar.
  const rc = await pedirTazon([
    { grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
    { grupo: 'Guarniciones', opciones: ['Frijolitos naturales', 'Papas a la mexicana'] },
  ]);
  const nombres = (rc.productos || []).map((p) => p.producto);
  assert.ok(nombres.includes('Tazon Sencillo Completo'),
    `lo pedido solo cabe en el Completo — ${JSON.stringify(nombres)} / ${JSON.stringify(rc.productosNoExisten)}`);
});

await t('T3. si sigue habiendo varias, se pregunta SOLO entre las que sirven', async () => {
  // Solo salsa y proteína: caben en las dos. La pregunta se mantiene, con las dos.
  const rc = await pedirTazon([
    { grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
  ]);
  const amb = (rc.productosNoExisten || []).find((x) => /^tazon$/i.test(x?.nombre || ''));
  assert.ok(amb, 'sigue sin poder resolverse');
  assert.strictEqual((amb.candidatos || []).length, 2, 'las dos siguen siendo posibles');
});

await t('T4. el mensaje le devuelve al cliente lo que ya dijo', async () => {
  // La otra mitad del incidente: recibir DOS VECES la misma pregunta, palabra
  // por palabra, es lo que hace que el cliente abandone.
  const rc = await pedirTazon([
    { grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
  ]);
  const msg = mensajeBorradorParaCliente(rc) || '';
  assert.match(msg, /Ya anoté/, `tiene que acusar lo que ya dijo — ${msg}`);
  assert.match(msg, /Suiza/, `y nombrarlo — ${msg}`);
  assert.match(msg, /¿Cuál prefieres\?/, 'y seguir preguntando lo que falta');
});

await t('T5. una opción que no es de ninguna variante no descarta ninguna', async () => {
  // El extractor recoge palabras de más. Si una palabra suelta pudiera dejar
  // fuera a todas, el cliente se quedaría sin opciones por un ruido del modelo.
  const rc = await pedirTazon([{ grupo: 'Salsa', opciones: ['Suiza', 'Con mucho amor'] }]);
  const amb = (rc.productosNoExisten || []).find((x) => /^tazon$/i.test(x?.nombre || ''));
  assert.ok(amb && (amb.candidatos || []).length === 2,
    'una palabra que no pertenece a ningún grupo no puede descartar variantes');
});

await t('T6. si NADA cabe en ninguna, se ofrecen todas igual', async () => {
  const { variantesCompatibles } = await import('../src/orders/variantePorLoPedido.js');
  const candidatos = [{ id: 1, nombre: 'A' }, { id: 2, nombre: 'B' }];
  const grupos = new Map([[1, [{ nombre: 'G', maximo: 1, opciones: [{ nombre: 'x' }] }]],
                          [2, [{ nombre: 'G', maximo: 1, opciones: [{ nombre: 'x' }] }]]]);
  // Dos "x" no caben en un grupo de tope 1: ninguna variante sirve.
  const r = variantesCompatibles(candidatos, grupos, ['x', 'x']);
  assert.strictEqual(r.length, 2,
    'quedarse sin opciones que ofrecer es peor que ofrecerlas todas');
});


mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
