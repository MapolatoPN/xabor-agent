// LA CARTA PUBLICADA GOBIERNA TAMBIÉN AL BOT LEGACY DE WHATSAPP.
//
// Revisión Codex, hallazgo 2: el Agente v1 ya vendía solo lo publicado en
// `whatsapp_productos` (098), pero el bot legacy (brain.js/prompts.js) seguía
// armando su prompt, sus promociones, su menú de respaldo y su validación con
// el menú OPERATIVO completo: extras sueltos, artículos internos de cocina.
// Un negocio que ocultaba un producto en el panel lo seguía viendo ofrecido
// por el bot legacy.
//
// Lo que esta suite exige, con el camino REAL de cada pieza (sin dobles del
// catálogo):
//   L1  un producto publicado se puede ver, cotizar y registrar;
//   L2  un producto oculto no está en el prompt de WhatsApp ni del simulador;
//   L3  una promoción no revela un producto oculto (prompt y consulta);
//   L4  pedir explícitamente un producto oculto no lo mete al pedido
//       (borrador, preview y registro; por nombre y por id);
//   L5  una categoría EXTRAS oculta entera no se ofrece (prompt y respaldo);
//   L6  otro negocio nunca aparece ni se puede publicar cruzado;
//   L7  si la publicación no se puede leer, todo cierra (sin menú completo);
//   L8  turno real de brain.js: el prompt que recibe el modelo ya viene
//       filtrado, la petición de un oculto no deja nada confirmable y el
//       candado de negativas no «corrige» un «no tenemos» revelando un oculto;
//   L9  el Agente v1 y el legacy usan EXACTAMENTE la misma selección;
//   L10 el POS, la tienda en línea y la voz no cambian;
//   L11 catálogo operativo lleno y CERO publicados: ni el legacy ni el agente
//       llaman al modelo ni contestan (ni promociones); al publicar, vuelven
//       a atender solo con lo publicado.
//
// Uso: DATABASE_URL=<local, con 098> node test/fase-carta-publicada-legacy-db.mjs
// L7 renombra `whatsapp_productos` un instante: la suite se niega a correr
// contra un host que no sea local.
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { publicarCartaWhatsapp, retirarDeWhatsapp } from './lib-carta-whatsapp.mjs';

const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`FALLO: esta suite renombra una tabla un instante; solo corre contra Postgres local (host="${host}").`);
  process.exit(1);
}

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-carta-legacy';

const { pool, obtenerMenuCompleto } = await import('../src/services/database.js');
const { construirSystemPrompt } = await import('../src/agent/prompts.js');
const { validarBorradorPedido, validarOrdenPropuesta, mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');
const { previsualizarPedido, registrarPedido } = await import('../src/orders/orderManager.js');
const { guardarPromocion, responderConsultaPromos } = await import('../src/services/tiendaPromociones.js');
const { menuTextualDesdeCatalogo } = await import('../src/services/menuAutomatico.js');
const { obtenerCatalogoDelAgente, cartaDelCanal, publicarProductosWhatsapp } = await import('../src/services/catalogoWhatsapp.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewConfirmable } = await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const { rows: [esquema] } = await pool.query(`SELECT to_regclass('public.whatsapp_productos') IS NOT NULL AS ok`);
if (!esquema.ok) {
  console.error('FALLO: falta whatsapp_productos (migración 098). Aplica scripts/predeploy-098-catalogo-whatsapp.mjs.');
  await pool.end(); mock.detener(); process.exit(1);
}

// ── Fixture: dos negocios, carta parcial, EXTRAS ocultos, promociones ─────
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
async function negocio(slug, nombre) {
  return (await q1(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug])).id;
}
async function limpiar(neg) {
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [neg]).catch(() => {});
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [neg]).catch(() => {});
  for (const tb of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
    await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [neg]).catch(() => {});
  }
}
const categoria = async (neg, nombre, orden) => (await q1(
  `INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,$2,$3,TRUE) RETURNING id`, [neg, nombre, orden])).id;
const producto = async (neg, cat, nombre, precio) => (await q1(
  `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,$3,$4) RETURNING id`, [neg, cat, nombre, precio])).id;

const NEG = await negocio('carta-legacy-a', 'Carta Legacy A');
const OTRO = await negocio('carta-legacy-b', 'Carta Legacy B');
await limpiar(NEG); await limpiar(OTRO);
await pool.query(`DELETE FROM metodos_pago WHERE negocio_id=$1`, [NEG]);
await pool.query(`INSERT INTO metodos_pago (negocio_id,tipo,habilitado,orden,disponible_para_bot) VALUES ($1,'efectivo',TRUE,1,TRUE)`, [NEG]);
await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'modo_pedidos','transaccional')
  ON CONFLICT (negocio_id,clave) DO UPDATE SET valor='transaccional'`, [NEG]);

const cDes = await categoria(NEG, 'Desayunos', 0);
const cBeb = await categoria(NEG, 'Bebidas', 1);
const cExt = await categoria(NEG, 'EXTRAS', 2);
const WAFFLE = await producto(NEG, cDes, 'Waffle Clásico', 120);
const HOTCAKES = await producto(NEG, cDes, 'Hotcakes de Avena', 110);
const INTERNO = await producto(NEG, cDes, 'Plato Interno Staff', 1);
const CAFE = await producto(NEG, cBeb, 'Café de Olla', 35);
const EXTRA_QUESO = await producto(NEG, cExt, 'Extra Queso Gratinado', 15);
const EXTRA_TOCINO = await producto(NEG, cExt, 'Extra Tocino Crujiente', 20);
const cAjena = await categoria(OTRO, 'Especiales', 0);
const AJENO = await producto(OTRO, cAjena, 'Producto Ajeno Exclusivo', 99);

// La tienda en línea de A: una fila que NO debe moverse con nada de esto.
await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]);
await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [NEG, INTERNO]);
const tiendaAntes = (await pool.query(
  `SELECT producto_id, publicado FROM tienda_productos WHERE negocio_id=$1 ORDER BY producto_id`, [NEG])).rows;
assert.strictEqual(tiendaAntes.length, 1, 'fixture: la tienda de A debe tener su fila');

// La carta publicada: exactamente la que el dueño eligió en el panel.
const PUBLICADOS = [WAFFLE, HOTCAKES, CAFE];
const OCULTOS = ['Plato Interno Staff', 'Extra Queso Gratinado', 'Extra Tocino Crujiente'];
await publicarCartaWhatsapp(pool, NEG, PUBLICADOS);
await publicarCartaWhatsapp(pool, OTRO, [AJENO]);

const PROMO_VISIBLE = 'Promo Waffle Doble';
const PROMO_OCULTA = 'Promo Staff Secreta';
const PROMO_EXTRAS = 'Promo Extras Gratis';
const PROMO_MIXTA = 'Promo Desayuno Completo';
const promo = (nombre, extra) => guardarPromocion(NEG, {
  nombre, tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], ...extra,
});
await promo(PROMO_VISIBLE, { productos: [WAFFLE] });
await promo(PROMO_OCULTA, { productos: [INTERNO] });
await promo(PROMO_EXTRAS, { categorias: [cExt] });
await promo(PROMO_MIXTA, { productos: [HOTCAKES, EXTRA_QUESO] });

const nombresDeCarta = (carta) => carta.flatMap((c) => (c.productos || []).map((p) => p.nombre)).sort();
const seccionPromos = (prompt) => (prompt.match(/## PROMOCIONES ACTIVAS AHORA\n([\s\S]*?)\n## /) || ['', ''])[1];
const seccionMenu = (prompt) => (prompt.match(/## MENÚ ACTUAL\n([\s\S]*?)\n## /) || ['', ''])[1];
const orden = (items, extra = {}) => ({
  negocioId: NEG, canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo',
  cliente: { nombre: 'Cliente Carta', telefono: '5218990007001' }, items, ...extra,
});
const pedidosDeA = async () => Number((await q1(
  `SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1`, [NEG])).n);

// ═══ L1 — lo publicado se puede ver, cotizar y registrar ═══════════════════
await t('L1. un producto publicado está en el prompt legacy, se cotiza y se registra', async () => {
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  for (const n of ['Waffle Clásico', 'Hotcakes de Avena', 'Café de Olla']) {
    assert.ok(prompt.includes(n), `el prompt de WhatsApp debe ofrecer "${n}"`);
  }
  const rc = await validarBorradorPedido({ items: [{ nombre: 'Waffle Clásico', cantidad: 1, modificadores: [] }] },
    NEG, { canal: 'whatsapp' });
  assert.strictEqual(rc.ok, true, `el borrador de un publicado es válido: ${JSON.stringify(rc.productosNoExisten)}`);
  const pv = await previsualizarPedido(orden([{ nombre: 'Waffle Clásico', cantidad: 1 }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(pv.ok, true, `se cotiza: ${JSON.stringify(pv.rechazos)}`);
  assert.strictEqual(pv.preview.total, 120);
  const antes = await pedidosDeA();
  const pedido = await registrarPedido(orden([{ nombre: 'Waffle Clásico', cantidad: 1 }]), 'whatsapp');
  assert.ok(pedido?.folio || pedido?.id, 'el registro devuelve folio');
  assert.strictEqual(await pedidosDeA(), antes + 1, 'y el pedido queda persistido');
});

// ═══ L2 — lo oculto no llega al contexto del modelo ═══════════════════════
await t('L2. el prompt de WhatsApp y el del simulador no nombran nada oculto', async () => {
  for (const canal of ['whatsapp', 'simulador']) {
    const prompt = await construirSystemPrompt(null, canal, NEG);
    for (const n of OCULTOS) assert.ok(!prompt.includes(n), `[${canal}] el prompt nombra el oculto "${n}"`);
    assert.ok(!prompt.includes('Producto Ajeno Exclusivo'), `[${canal}] el prompt nombra un producto de OTRO negocio`);
  }
});

// ═══ L3 — una promoción no revela lo oculto ═══════════════════════════════
await t('L3. promociones: la de un oculto desaparece y la mixta solo nombra lo publicado', async () => {
  const promos = seccionPromos(await construirSystemPrompt(null, 'whatsapp', NEG));
  assert.ok(promos.includes(PROMO_VISIBLE), 'la promoción de un publicado sigue informándose');
  assert.ok(promos.includes(PROMO_MIXTA), 'la mixta sigue, porque tiene un participante publicado');
  assert.ok(!promos.includes(PROMO_OCULTA), 'una promoción cuyo único participante está oculto no puede anunciarse');
  assert.ok(!promos.includes(PROMO_EXTRAS), 'una promoción sobre una categoría sin publicados no puede anunciarse');
  for (const n of OCULTOS) assert.ok(!promos.includes(n), `la sección de promociones nombra "${n}"`);
  const consulta = String(await responderConsultaPromos(NEG, 'hoy', { canal: 'whatsapp' }) || '');
  assert.ok(consulta.includes(PROMO_VISIBLE), `la consulta por fecha informa la visible: ${consulta}`);
  for (const n of [PROMO_OCULTA, PROMO_EXTRAS, ...OCULTOS]) {
    assert.ok(!consulta.includes(n), `la consulta de promociones del bot revela "${n}"`);
  }
});

// ═══ L4 — pedir un oculto explícitamente no lo mete al pedido ═════════════
await t('L4. borrador, preview y registro rechazan un oculto por nombre y por id', async () => {
  const rc = await validarBorradorPedido({ items: [{ nombre: 'Plato Interno Staff', cantidad: 1, modificadores: [] }] },
    NEG, { canal: 'whatsapp' });
  assert.strictEqual(rc.ok, false, 'el borrador de WhatsApp no puede aceptar un oculto');
  const msg = String(mensajeBorradorParaCliente(rc) || '');
  for (const n of ['Extra Queso Gratinado', 'Extra Tocino Crujiente']) {
    assert.ok(!msg.includes(n), `el mensaje al cliente sugiere el oculto "${n}": ${msg}`);
  }
  for (const item of [
    { nombre: 'Extra Queso Gratinado', cantidad: 1 },
    { id: INTERNO, nombre: 'Plato Interno Staff', cantidad: 1 },
    { nombre: `[P${EXTRA_TOCINO}]`, cantidad: 1 },
  ]) {
    const pv = await previsualizarPedido(orden([item]), NEG, { canal: 'whatsapp' });
    assert.strictEqual(pv.ok, false, `el preview cotizó un oculto: ${JSON.stringify(item)}`);
    const antes = await pedidosDeA();
    await assert.rejects(() => registrarPedido(orden([item]), 'whatsapp'), /ORDEN_INVALIDA/,
      `el registro aceptó un oculto: ${JSON.stringify(item)}`);
    assert.strictEqual(await pedidosDeA(), antes, 'un pedido rechazado no deja fila');
  }
});

// ═══ L5 — EXTRAS oculto entero no se ofrece ═══════════════════════════════
await t('L5. la categoría EXTRAS oculta entera no aparece en el prompt ni en el menú de respaldo', async () => {
  // Se mira la sección del menú: el texto fijo de instrucciones dice
  // «MODIFICADORES Y EXTRAS» y eso no es la categoría.
  const menu = seccionMenu(await construirSystemPrompt(null, 'whatsapp', NEG));
  assert.ok(menu.includes('Desayunos') && menu.includes('Bebidas'), `el menú del prompt lista las categorías publicadas: ${menu}`);
  assert.ok(!/EXTRAS/.test(menu), `el menú del prompt anuncia la categoría EXTRAS, que no tiene nada publicado: ${menu}`);
  const textual = String(await menuTextualDesdeCatalogo(NEG) || '');
  assert.ok(textual.includes('Waffle Clásico') && textual.includes('Café de Olla'), `el respaldo lista lo publicado: ${textual}`);
  assert.ok(!/EXTRAS/.test(textual), 'el menú de respaldo en texto anuncia EXTRAS');
  for (const n of OCULTOS) assert.ok(!textual.includes(n), `el menú de respaldo lista "${n}"`);
});

// ═══ L6 — otro negocio ════════════════════════════════════════════════════
await t('L6. el producto de otro negocio no aparece, no se registra y no se puede publicar cruzado', async () => {
  const carta = nombresDeCarta(await cartaDelCanal(NEG, 'whatsapp'));
  assert.ok(!carta.includes('Producto Ajeno Exclusivo'));
  await assert.rejects(() => registrarPedido(orden([{ id: AJENO, nombre: 'Producto Ajeno Exclusivo', cantidad: 1 }]), 'whatsapp'),
    /ORDEN_INVALIDA/);
  const r = await publicarProductosWhatsapp(NEG, [AJENO], true, { db: pool });
  assert.strictEqual(r.actualizados, 0, 'un id de otro negocio no se publica en este');
  const { rows } = await pool.query(`SELECT 1 FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id=$2`, [NEG, AJENO]);
  assert.strictEqual(rows.length, 0);
});

// ═══ L7 — la publicación no se puede leer ═════════════════════════════════
await t('L7. sin tabla de publicación: prompt sin productos, registro rechazado, respaldo y promos vacíos', async () => {
  await pool.query('ALTER TABLE whatsapp_productos RENAME TO whatsapp_productos_l7');
  try {
    const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
    for (const n of ['Waffle Clásico', 'Hotcakes de Avena', 'Café de Olla', ...OCULTOS]) {
      assert.ok(!prompt.includes(n), `con la lectura caída el prompt cayó al menú completo: nombra "${n}"`);
    }
    assert.ok(!seccionPromos(prompt).includes(PROMO_VISIBLE), 'con la lectura caída no se informa ninguna promoción');
    // Y la consulta de promociones no dice «no tenemos promociones» (un error
    // presentado como hecho): lanza, y quien llama responde como lo que es.
    await assert.rejects(() => responderConsultaPromos(NEG, 'hoy', { canal: 'whatsapp' }), /carta_publicada_ilegible/,
      'con la carta ilegible, la consulta de promociones respondió como si no hubiera');
    await assert.rejects(() => validarBorradorPedido({ items: [{ nombre: 'Waffle Clásico', cantidad: 1 }] },
      NEG, { canal: 'whatsapp' }), 'el borrador no puede validarse contra el menú completo');
    const antes = await pedidosDeA();
    await assert.rejects(() => registrarPedido(orden([{ nombre: 'Waffle Clásico', cantidad: 1 }]), 'whatsapp'));
    assert.strictEqual(await pedidosDeA(), antes, 'sin publicación legible no nace ningún pedido');
    assert.strictEqual(await menuTextualDesdeCatalogo(NEG), null, 'el respaldo en texto no cae al menú completo');
    const agente = await obtenerCatalogoDelAgente(NEG);
    assert.deepStrictEqual(agente.carta, [], 'el Agente v1 tampoco');
    assert.strictEqual(agente.error, 'lectura_publicacion');
    // Fuera de WhatsApp nada depende de la tabla: el POS sigue validando.
    const pos = await validarOrdenPropuesta(orden([{ nombre: 'Plato Interno Staff', cantidad: 1 }], { canal: 'pos' }),
      NEG, { canal: 'pos' });
    assert.strictEqual(pos.ok, true, `el POS no puede caerse por la carta de WhatsApp: ${JSON.stringify(pos.rechazos)}`);
  } finally {
    await pool.query('ALTER TABLE whatsapp_productos_l7 RENAME TO whatsapp_productos');
  }
});

// ═══ L8 — turno real de brain.js ══════════════════════════════════════════
await t('L8. turno real: el system prompt que recibe el modelo ya viene filtrado', async () => {
  const SID = 'carta-legacy-l8'; deleteSession(SID); mock.drenar();
  let sistema = null;
  mock.encolarRespuesta((payload) => {
    sistema = typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system);
    return 'Tenemos Waffle Clásico, Hotcakes de Avena y Café de Olla.';
  });
  const r = await procesarMensaje(SID, 'Hola, ¿qué tienen de desayuno?', null, 'whatsapp', NEG, '5218990007008');
  assert.ok(sistema, 'el modelo no recibió system prompt');
  assert.ok(sistema.includes('Waffle Clásico'), 'el prompt real ofrece lo publicado');
  for (const n of OCULTOS) assert.ok(!sistema.includes(n), `el prompt REAL enviado al modelo nombra "${n}"`);
  assert.ok(!sistema.includes('Producto Ajeno Exclusivo'), 'el prompt real nombra un producto de otro negocio');
  assert.ok(r?.texto, 'hay respuesta al cliente');
});

await t('L8b. turno real: pedir un oculto no deja nada confirmable ni ofrece otro oculto', async () => {
  const SID = 'carta-legacy-l8b'; deleteSession(SID); mock.drenar();
  mock.encolarRespuesta('Claro.\n<PEDIDO_BORRADOR>' + JSON.stringify({
    items: [{ nombre: 'Extra Queso Gratinado', cantidad: 1, modificadores: [] }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } }) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'Quiero un extra queso gratinado para recoger, efectivo, a nombre de Ana',
    null, 'whatsapp', NEG, '5218990007009');
  mock.drenar();
  assert.strictEqual(verPreviewConfirmable(SID), null, 'un oculto dejó un resumen confirmable');
  assert.ok(!r?.orden, 'un oculto produjo una orden');
  const texto = String(r?.texto || '');
  assert.ok(!/confirm/i.test(texto), `se le pidió confirmar un oculto: ${texto}`);
  assert.ok(!texto.includes('$15'), `se cotizó el oculto: ${texto}`);
  for (const n of ['Extra Tocino Crujiente', 'Plato Interno Staff', 'EXTRAS']) {
    assert.ok(!texto.includes(n), `la respuesta ofrece otro oculto "${n}": ${texto}`);
  }
});

await t('L8c. turno real: «no tenemos» un oculto es VERDAD en WhatsApp; el candado no lo revela', async () => {
  // El candado de negativas «corrige» un «no tenemos X» cuando X existe en el
  // catálogo. Si comparara contra el menú operativo, respondería «Sí tenemos
  // Extra Queso Gratinado» y ofrecería un artículo interno.
  const SID = 'carta-legacy-l8c'; deleteSession(SID); mock.drenar();
  mock.encolarRespuesta('No tenemos extra queso gratinado, pero te recomiendo el Waffle Clásico.');
  mock.encolarRespuesta(JSON.stringify({ items: [] }));   // extracción forzada: es una consulta
  const r = await procesarMensaje(SID, '¿tienen extra queso gratinado?', null, 'whatsapp', NEG, '5218990007010');
  mock.drenar();
  const texto = String(r?.texto || '');
  assert.ok(!r?.negativaInterceptada, `el candado «corrigió» una negativa verdadera: ${texto}`);
  assert.doesNotMatch(texto, /S[ií] (tenemos|manejamos)/i, `se ofreció un oculto: ${texto}`);
  assert.match(texto, /Waffle Clásico/, `la respuesta del modelo debía salir tal cual: ${texto}`);
});

// ═══ L9 — el Agente v1 y el legacy usan la misma selección ════════════════
await t('L9. Agente v1 y legacy: misma carta, misma validación final, mismo efecto al retirar', async () => {
  const agente = nombresDeCarta((await obtenerCatalogoDelAgente(NEG)).carta);
  const legacy = nombresDeCarta(await cartaDelCanal(NEG, 'whatsapp'));
  assert.deepStrictEqual(legacy, agente, 'las dos cartas deben ser idénticas');
  assert.deepStrictEqual(legacy, ['Café de Olla', 'Hotcakes de Avena', 'Waffle Clásico']);
  for (const [nombre, esperado] of [['Waffle Clásico', true], ['Plato Interno Staff', false], ['Extra Queso Gratinado', false]]) {
    const items = [{ nombre, cantidad: 1 }];
    const delAgente = await validarOrdenPropuesta(orden(items, { canal: undefined, catalogo_publicado: 'whatsapp' }), NEG, {});
    const delLegacy = await validarOrdenPropuesta(orden(items), NEG, { canal: 'whatsapp' });
    assert.strictEqual(delAgente.ok, esperado, `agente/${nombre}`);
    assert.strictEqual(delLegacy.ok, esperado, `legacy/${nombre}`);
  }
  // El dueño retira el Waffle en el panel: desaparece de los DOS a la vez.
  await retirarDeWhatsapp(pool, NEG, [WAFFLE]);
  try {
    assert.ok(!nombresDeCarta((await obtenerCatalogoDelAgente(NEG)).carta).includes('Waffle Clásico'));
    assert.ok(!(await construirSystemPrompt(null, 'whatsapp', NEG)).includes('Waffle Clásico'));
    const v = await validarOrdenPropuesta(orden([{ nombre: 'Waffle Clásico', cantidad: 1 }]), NEG, { canal: 'whatsapp' });
    assert.strictEqual(v.ok, false, 'retirado del panel, el legacy ya no lo registra');
  } finally {
    await publicarCartaWhatsapp(pool, NEG, [WAFFLE]);
  }
});

// ═══ L10 — POS, tienda en línea y voz no cambian ══════════════════════════
await t('L10. el POS, la tienda y la voz conservan el menú operativo', async () => {
  const pos = nombresDeCarta(await obtenerMenuCompleto(NEG));
  for (const n of OCULTOS) assert.ok(pos.includes(n), `el menú del POS perdió "${n}"`);
  const v = await validarOrdenPropuesta(orden([{ nombre: 'Plato Interno Staff', cantidad: 1 }], { canal: 'pos' }),
    NEG, { canal: 'pos' });
  assert.strictEqual(v.ok, true, `la validación fuera de WhatsApp no filtra: ${JSON.stringify(v.rechazos)}`);
  const tiendaDespues = (await pool.query(
    `SELECT producto_id, publicado FROM tienda_productos WHERE negocio_id=$1 ORDER BY producto_id`, [NEG])).rows;
  assert.deepStrictEqual(tiendaDespues, tiendaAntes, 'publicar o retirar en WhatsApp tocó la tienda en línea');
  // Voz: `whatsapp_productos` es la carta de WhatsApp; la voz sigue con el
  // menú operativo hasta que el dueño decida otra cosa (ver el documento).
  const voz = await construirSystemPrompt(null, 'voz', NEG);
  assert.ok(voz.includes('Plato Interno Staff'), 'la voz cambió de carta sin decisión del dueño');
});

// ═══ L11 — catálogo operativo lleno y CERO productos publicados ════════════
//
// Sin carta publicada ningún bot de WhatsApp conversa: ni el legacy ni el
// agente llaman al modelo, nada del menú operativo sale como respaldo y la
// señal que reciben el canal y el panel es «pasa a una persona».
const VACIO = await negocio('carta-legacy-vacio', 'Carta Legacy Vacío');
await limpiar(VACIO);
await pool.query(`DELETE FROM whatsapp_productos WHERE negocio_id=$1`, [VACIO]);
const cVacio = await categoria(VACIO, 'Desayunos', 0);
const cVacioExt = await categoria(VACIO, 'EXTRAS', 1);
const HOTCAKE_V = await producto(VACIO, cVacio, 'Hotcake de cumpleaños', 150);
await producto(VACIO, cVacio, 'Pieza de Hotcake', 30);
await producto(VACIO, cVacioExt, 'Extra Queso', 15);
await guardarPromocion(VACIO, {
  nombre: 'Promo Hotcake Secreta', tipo: 'porcentaje', valor: 10, productos: [HOTCAKE_V],
  canales: ['whatsapp'], activa: true,
}).catch(() => {});

await t('L11a. estado de la carta: operativo lleno + nada publicado = SIN carta; ilegible = SIN carta', async () => {
  const { estadoCartaWhatsapp } = await import('../src/services/catalogoWhatsapp.js');
  const vacio = await estadoCartaWhatsapp(VACIO);
  assert.deepStrictEqual([vacio.publicada, vacio.productos], [false, 0]);
  assert.ok((await obtenerMenuCompleto(VACIO)).length > 0, 'fixture: el menú operativo tiene productos');
  const conCarta = await estadoCartaWhatsapp(NEG);
  assert.strictEqual(conCarta.publicada, true, JSON.stringify(conCarta));
  await pool.query('ALTER TABLE whatsapp_productos RENAME TO whatsapp_productos_l11');
  try {
    const caida = await estadoCartaWhatsapp(NEG);
    assert.deepStrictEqual([caida.publicada, caida.error], [false, 'lectura_publicacion'],
      `una carta ilegible se tomó como publicada: ${JSON.stringify(caida)}`);
  } finally {
    await pool.query('ALTER TABLE whatsapp_productos_l11 RENAME TO whatsapp_productos');
  }
});

await t('L11b. legacy: sin carta NO llama al modelo, no contesta nada y pide una persona', async () => {
  const SID = 'carta-legacy-l11b'; deleteSession(SID); mock.drenar();
  let llamado = false;
  mock.encolarRespuesta(() => { llamado = true; return 'Tenemos Hotcake de cumpleaños y Pieza de Hotcake.'; });
  for (const mensaje of ['hola, ¿qué tienen?', 'quiero un hotcake de cumpleaños', '¿qué promociones tienen hoy?']) {
    const r = await procesarMensaje(SID, mensaje, null, 'whatsapp', VACIO, '5218990007111');
    assert.strictEqual(r?.sinCartaWhatsapp, true, `«${mensaje}»: ${JSON.stringify(r)}`);
    assert.strictEqual(String(r?.texto || ''), '', `«${mensaje}»: el legacy contestó sin carta: ${r?.texto}`);
    assert.ok(!r?.orden, 'sin carta nació una orden');
  }
  assert.strictEqual(llamado, false, 'el legacy llamó al modelo sin carta publicada');
  assert.strictEqual(mock.pendientes(), 1);
  mock.drenar();
});

await t('L11d. agente: sin carta sale ANTES de cualquier atajo (promociones incluidas), sin estado ni outbox', async () => {
  const { atenderConAgente } = await import('../src/mesero-agente/canalDelAgente.js');
  const TEL = '5218990007112';
  let llamadas = 0;
  const llamarModelo = async () => { llamadas += 1; throw new Error('el agente no debía llamar al modelo'); };
  for (const [i, mensaje] of ['¿qué promociones tienen hoy?', 'quiero un hotcake de cumpleaños', 'hola'].entries()) {
    const r = await atenderConAgente({ negocioId: VACIO, telefono: TEL, mensaje, canal: 'whatsapp',
      llamarModelo, wamids: [`wamid.l11d.${i}`] });
    assert.deepStrictEqual([r.ok, r.motivo], [false, 'sin_catalogo'], `«${mensaje}»: ${JSON.stringify(r).slice(0, 300)}`);
  }
  assert.strictEqual(llamadas, 0);
  const { rows: [conteo] } = await pool.query(
    `SELECT (SELECT count(*) FROM agente_outbox WHERE negocio_id=$1)::int AS outbox,
            (SELECT count(*) FROM conversacion_estado WHERE negocio_id=$1)::int AS estado`, [VACIO]);
  assert.deepStrictEqual(conteo, { outbox: 0, estado: 0 }, 'sin carta el agente comprometió un turno');
});

await t('L11e. al publicar un producto, los dos motores vuelven a atender (con SOLO lo publicado)', async () => {
  const { estadoCartaWhatsapp } = await import('../src/services/catalogoWhatsapp.js');
  await publicarCartaWhatsapp(pool, VACIO, [HOTCAKE_V]);
  try {
    assert.strictEqual((await estadoCartaWhatsapp(VACIO)).publicada, true);
    const SID = 'carta-legacy-l11e'; deleteSession(SID); mock.drenar();
    let sistema = null;
    mock.encolarRespuesta((payload) => {
      sistema = typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system);
      return 'Tenemos Hotcake de cumpleaños.';
    });
    const r = await procesarMensaje(SID, '¿qué tienen?', null, 'whatsapp', VACIO, '5218990007113');
    mock.drenar();
    assert.ok(!r?.sinCartaWhatsapp, 'con carta publicada el legacy siguió sin contestar');
    assert.ok(sistema && sistema.includes('Hotcake de cumpleaños'), 'el prompt no trae lo publicado');
    for (const n of ['Pieza de Hotcake', 'Extra Queso']) assert.ok(!sistema.includes(n), `el prompt nombra "${n}"`);
  } finally {
    await retirarDeWhatsapp(pool, VACIO, [HOTCAKE_V]);
  }
});

// ═══ RESUMEN ═══════════════════════════════════════════════════════════════
await pool.query(`DELETE FROM agente_outbox WHERE negocio_id=$1`, [VACIO]).catch(() => {});
await pool.query(`DELETE FROM conversacion_estado WHERE negocio_id=$1`, [VACIO]).catch(() => {});
await pool.query(`DELETE FROM whatsapp_productos WHERE negocio_id=$1`, [VACIO]).catch(() => {});
await limpiar(VACIO);
await limpiar(NEG); await limpiar(OTRO);
await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]).catch(() => {});
await pool.end();
mock.detener();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
process.exit(0);
