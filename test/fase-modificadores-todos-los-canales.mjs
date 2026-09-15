// Selección de producto con modificadores — IGUAL EN TODOS LOS CANALES.
//
// El bug: al capturar un pedido a DOMICILIO, un producto con grupos de
// modificadores se agregaba directo, sin abrir el configurador. En mostrador
// y en mesa sí preguntaba.
//
// La causa no era el producto ni el negocio: la captura de Envíos (que sirve
// a domicilio Y a recoger) tenía su propio catálogo y su propio carrito.
// `envCargarMenu()` recortaba cada producto a { id, nombre, precio,
// disponible } y tiraba `modificadores`, y `envAgregar()` empujaba la línea
// al carrito sin preguntarle nada a nadie. Con los grupos fuera del catálogo
// ya no había forma de saber que había que preguntar. Además `envCrearPedido`
// mandaba `items: [{producto_id, cantidad}]`, así que aunque alguien hubiera
// elegido opciones no habrían llegado al servidor.
//
// Consecuencia real, según el grupo:
//   · grupos OPCIONALES → el pedido se creaba sin opciones y la cocina recibía
//     una comanda incompleta, en silencio;
//   · grupos OBLIGATORIOS → el backend lo rechazaba con GRUPO_REQUERIDO y el
//     operador no podía capturar el pedido de ninguna manera.
//
// La corrección no es un caso especial de domicilio: es un punto ÚNICO de
// selección (XaborModificadores.elegirLinea) por el que entran los cuatro
// canales. Esta suite lo prueba donde se rompió — en la pantalla, con un
// navegador de verdad — y luego sigue la selección hasta el pedido guardado
// y la comanda.
//
// Fixtures propios y genéricos a propósito: NADA aquí depende de "Chilaquiles
// Mixtos" ni del menú de un negocio concreto.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_MODCANAL || '4761';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const fijarModulo = (negocioId, modulo, estado = 'activo') => pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);

const A = SEED.negocioA;
const MARCA = 'Cat canales mods';

// ── Fixture: un producto con grupo OBLIGATORIO + grupo OPCIONAL con precio
//    extra, y uno simple sin ningún grupo. Genérico: cualquier negocio.
async function crearCatalogo(negocioId) {
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`,
    [negocioId, MARCA]);
  const prod = async (nombre, precio) => (await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
     VALUES ($1,$2,$3,$4,'',$5,TRUE,0) RETURNING id, nombre, precio`,
    [negocioId, cat.id, 'C' + Math.floor(Math.random() * 1e9).toString(36), nombre, precio])).rows[0];
  const grupo = async (productoId, nombre, requerido, minimo, maximo) => (await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`,
    [negocioId, productoId, nombre, requerido, minimo, maximo])).rows[0];
  const opcion = async (grupoId, nombre, extra = 0) => (await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`,
    [negocioId, grupoId, nombre, extra])).rows[0];

  const configurable = await prod('Plato configurable prueba', 120);
  const simple = await prod('Bebida simple prueba', 40);

  const termino = await grupo(configurable.id, 'Término', true, 1, 1);      // OBLIGATORIO
  const suave = await opcion(termino.id, 'Suave');
  const cocido = await opcion(termino.id, 'Bien cocido');

  const extras = await grupo(configurable.id, 'Extras', false, 0, 2);       // OPCIONAL, con precio
  const queso = await opcion(extras.id, 'Queso', 15);
  const tocino = await opcion(extras.id, 'Tocino', 25);

  return { catId: cat.id, configurable, simple,
    grupos: { termino: termino.id, extras: extras.id },
    op: { suave: suave.id, cocido: cocido.id, queso: queso.id, tocino: tocino.id } };
}

async function limpiar() {
  await pool.query(`DELETE FROM menu_categorias WHERE nombre = $1 AND negocio_id = $2`, [MARCA, A]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->'cliente'->>'nombre' LIKE 'Canales %'`, [A]);
  await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id = $1`, [A]);
}

await limpiar();
for (const m of ['pos', 'menu', 'restaurante']) await fijarModulo(A, m);
for (const tipo of ['efectivo', 'terminal']) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,0)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [A, tipo]);
}
const fx = await crearCatalogo(A);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const token = crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: A, rol: 'admin' });
const cookieAdmin = `xabor_sesion=${encodeURIComponent(token)}`;

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 1 — LA PANTALLA (navegador real)
//  Un test estático no habría visto este bug: el backend siempre supo validar
//  modificadores; lo que fallaba era que la pantalla de domicilio nunca los
//  preguntaba. Por eso aquí se hace clic de verdad.
// ═══════════════════════════════════════════════════════════════════════════
const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function nuevaPagina(ruta) {
  const pagina = await navegador.newPage();
  const errores = [];
  pagina.on('pageerror', e => errores.push(e.message));
  pagina.on('dialog', d => d.accept().catch(() => {}));
  await pagina.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });
  await pagina.goto(base + ruta, { waitUntil: 'networkidle0' });
  return { pagina, errores };
}

// Clic sobre el botón cuyo texto contiene `texto` — como lo haría el operador,
// que busca el producto por su nombre y lo toca.
async function clicPorTexto(pagina, selector, texto) {
  const handle = await pagina.evaluateHandle((sel, txt) => {
    return [...document.querySelectorAll(sel)].find(b => b.textContent.includes(txt)) || null;
  }, selector, texto);
  const el = handle.asElement();
  if (!el) throw new Error(`no se encontró el botón "${texto}" (${selector})`);
  await el.click();
}

const modalAbierto = (pagina, id = 'xb-mods-dlg') =>
  pagina.evaluate(i => !!document.getElementById(i)?.open, id);

// Elegir una opción del modal por su nombre. El modal se repinta entero en
// cada cambio, así que siempre se vuelve a buscar.
async function elegirOpcionModal(pagina, nombre) {
  const ok = await pagina.evaluate((n) => {
    const label = [...document.querySelectorAll('#xb-mods-body .xb-op')].find(l => l.textContent.includes(n));
    if (!label) return false;
    const input = label.querySelector('input');
    if (!input || input.disabled) return false;
    input.checked = input.type === 'radio' ? true : !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, nombre);
  if (!ok) throw new Error(`no se pudo elegir la opción "${nombre}" en el modal`);
}

const botonAgregarDeshabilitado = (pagina) =>
  pagina.evaluate(() => !!document.getElementById('xb-mods-agregar')?.disabled);

// ─── DOMICILIO — el canal donde se reportó el bug ──────────────────────────
{
  const { pagina, errores } = await nuevaPagina('/app');
  const irADomicilio = async () => {
    await pagina.evaluate(() => nuevoPedidoModalidad('domicilio'));
    await pagina.waitForFunction(
      () => document.querySelectorAll('#env-lista-productos button').length > 0, { timeout: 10000 });
  };
  const carrito = () => pagina.evaluate(() => JSON.parse(JSON.stringify(ENV_CARRITO)));

  await t('DOMICILIO', '1. el catálogo de domicilio CONSERVA los grupos del menú (no los recorta)', async () => {
    await irADomicilio();
    const prod = await pagina.evaluate(n => {
      const p = ENV_PRODUCTOS.find(x => x.nombre === n);
      return p ? { nombre: p.nombre, grupos: (p.modificadores || []).map(g => g.nombre) } : null;
    }, fx.configurable.nombre);
    assert.ok(prod, 'el producto debe estar en el catálogo de Envíos');
    assert.deepStrictEqual(prod.grupos, ['Término', 'Extras'],
      'si el catálogo pierde los grupos, la pantalla ya no puede saber que debe preguntar');
  });

  await t('DOMICILIO', '2. tipo de pedido = domicilio y producto SIN modificadores → se agrega directo', async () => {
    assert.strictEqual(await pagina.evaluate(() => ENV_TIPO), 'domicilio');
    await clicPorTexto(pagina, '#env-lista-productos button', fx.simple.nombre);
    assert.strictEqual(await modalAbierto(pagina), false, 'un producto sin grupos no abre nada');
    const c = await carrito();
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].nombre, fx.simple.nombre);
    assert.strictEqual(c[0].cantidad, 1);
    assert.strictEqual(c[0].precio, 40);
  });

  await t('DOMICILIO', '3. producto CON modificadores → abre el configurador y NO agrega nada todavía', async () => {
    await clicPorTexto(pagina, '#env-lista-productos button', fx.configurable.nombre);
    await pagina.waitForFunction(() => !!document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    assert.strictEqual(await modalAbierto(pagina), true, 'ESTE es el bug reportado: en domicilio no se abría');
    const c = await carrito();
    assert.strictEqual(c.length, 1, 'el producto NO entra al carrito mientras se configura');
    const grupos = await pagina.evaluate(() =>
      [...document.querySelectorAll('#xb-mods-body .xb-grupo h4')].map(h => h.textContent));
    assert.deepStrictEqual(grupos, ['Término *', 'Extras'], 'muestra obligatorio y opcional');
  });

  await t('DOMICILIO', '4. modificador OBLIGATORIO sin elegir → no permite agregar', async () => {
    assert.strictEqual(await botonAgregarDeshabilitado(pagina), true, 'el botón Agregar está bloqueado');
    await pagina.evaluate(() => document.getElementById('xb-mods-agregar').click());
    assert.strictEqual(await modalAbierto(pagina), true, 'el configurador sigue abierto');
    const c = await carrito();
    assert.strictEqual(c.length, 1, 'no se agregó nada al carrito');
  });

  await t('DOMICILIO', '5. modificadores completos → agrega la línea con sus opciones y su precio extra', async () => {
    await elegirOpcionModal(pagina, 'Suave');   // obligatorio
    await elegirOpcionModal(pagina, 'Queso');   // opcional, +15
    assert.strictEqual(await botonAgregarDeshabilitado(pagina), false, 'con lo obligatorio elegido ya se puede agregar');
    await pagina.evaluate(() => document.getElementById('xb-mods-agregar').click());
    await pagina.waitForFunction(() => !document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    const c = await carrito();
    assert.strictEqual(c.length, 2);
    const linea = c[1];
    assert.strictEqual(linea.precio, 135, '120 base + 15 del extra');
    assert.deepStrictEqual([...linea.modificadores].sort((a, b) => a - b),
      [fx.op.suave, fx.op.queso].sort((a, b) => a - b), 'la línea guarda los ids elegidos');
    assert.match(linea.texto, /Término: Suave/);
    assert.match(linea.texto, /Extras: Queso/);
  });

  await t('DOMICILIO', '6. el resumen muestra las opciones elegidas, no solo el nombre', async () => {
    const texto = await pagina.$eval('#env-carrito', el => el.textContent);
    assert.match(texto, /Término: Suave/, 'el operador ve lo que va a cocinar');
    assert.match(texto, /Extras: Queso/);
  });

  await t('DOMICILIO', '7. el MISMO producto con otra configuración es OTRA línea (no se fusiona)', async () => {
    await clicPorTexto(pagina, '#env-lista-productos button', fx.configurable.nombre);
    await pagina.waitForFunction(() => !!document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    await elegirOpcionModal(pagina, 'Bien cocido');
    await pagina.evaluate(() => document.getElementById('xb-mods-agregar').click());
    await pagina.waitForFunction(() => !document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    const c = await carrito();
    assert.strictEqual(c.length, 3, 'tres líneas: bebida, Suave+Queso, Bien cocido');
    assert.strictEqual(c[2].precio, 120, 'sin extras, precio base');
    assert.notStrictEqual(c[1].texto, c[2].texto);
  });

  await t('DOMICILIO', '8. cancelar el configurador no agrega nada', async () => {
    await clicPorTexto(pagina, '#env-lista-productos button', fx.configurable.nombre);
    await pagina.waitForFunction(() => !!document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    await pagina.evaluate(() => document.getElementById('xb-mods-cancelar').click());
    await pagina.waitForFunction(() => !document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    assert.strictEqual((await carrito()).length, 3, 'sigue habiendo tres líneas');
  });

  await t('DOMICILIO', '8b. además de las opciones, la línea admite una nota libre', async () => {
    const escrito = await pagina.evaluate(() => {
      const inputs = [...document.querySelectorAll('#env-carrito input[type="text"]')];
      if (inputs.length < 2) return null;
      inputs[1].value = 'sin cebolla';
      inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      return ENV_CARRITO[1].notas;
    });
    assert.strictEqual(escrito, 'sin cebolla', 'la nota queda en la línea, junto a los modificadores');
  });

  // ─── De la pantalla al pedido guardado y a la comanda ────────────────────
  let folioDomicilio = null;
  await t('DOMICILIO', '9. crear el pedido desde la pantalla: las opciones llegan al servidor', async () => {
    await pagina.evaluate(() => {
      const v = (id, val) => { document.getElementById(id).value = val; };
      v('env-nombre', 'Canales Domicilio');
      v('env-telefono', '8781119001');
      v('env-calle', 'Av. Siempre Viva');
      v('env-numext', '742');
      v('env-colonia', 'Centro');
      v('env-costo-envio', '0');
    });
    await pagina.evaluate(() => envCrearPedido());
    await pagina.waitForFunction(() => ENV_CARRITO.length === 0, { timeout: 15000 });

    const { rows } = await pool.query(
      `SELECT folio, datos FROM pedidos_activos
        WHERE negocio_id = $1 AND datos->'cliente'->>'nombre' = 'Canales Domicilio'
        ORDER BY created_at DESC LIMIT 1`, [A]);
    assert.strictEqual(rows.length, 1, 'el pedido se creó (antes moría con GRUPO_REQUERIDO)');
    folioDomicilio = rows[0].folio;
    const datos = rows[0].datos;
    assert.strictEqual(datos.modalidad, 'entrega a domicilio');
    assert.strictEqual(datos.items.length, 3, 'las tres líneas sobreviven al guardado');
    const conQueso = datos.items.find(i => (i.modificadores || []).some(m => m.opcion === 'Queso'));
    assert.ok(conQueso, 'la selección viaja en el pedido guardado');
    assert.strictEqual(Number(conQueso.precio_unitario), 135, 'el precio extra se conserva');
    assert.ok(conQueso.modificadores.some(m => m.grupo === 'Término' && m.opcion === 'Suave'));
    assert.strictEqual(Number(conQueso.modificadores.find(m => m.opcion === 'Queso').precio_extra), 15);
  });

  await t('COMANDA', '10. la comanda de cocina del pedido a domicilio conserva los modificadores', async () => {
    const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [folioDomicilio]);
    const items = rows[0].datos.items;
    // La comanda (panel: comandaHTML) imprime `modificadores` agrupados y
    // `notas`. Se comprueban las dos fuentes que llegan al papel.
    const conQueso = items.find(i => (i.modificadores || []).some(m => m.opcion === 'Queso'));
    assert.match(conQueso.notas || '', /Término: Suave/, 'la línea de la comanda dice el término');
    assert.match(conQueso.notas || '', /Extras: Queso/);
    assert.match(conQueso.notas || '', /sin cebolla/, 'la nota libre convive con los modificadores');
    const cocido = items.find(i => (i.modificadores || []).some(m => m.opcion === 'Bien cocido'));
    assert.match(cocido.notas || '', /Término: Bien cocido/, 'cada línea lleva LA SUYA, no la de al lado');
    const bebida = items.find(i => i.nombre === fx.simple.nombre);
    assert.deepStrictEqual(bebida.modificadores, [], 'el producto simple no inventa opciones');
  });

  await t('DOMICILIO', '11. la pantalla no lanzó errores de JavaScript', async () => {
    assert.deepStrictEqual(errores, []);
  });
  await pagina.close();
}

// ─── RECOGER — misma captura que domicilio, mismo requisito ────────────────
{
  const { pagina } = await nuevaPagina('/app');
  await t('RECOGER', '12. recoger usa la misma pantalla y también abre el configurador', async () => {
    await pagina.evaluate(() => nuevoPedidoModalidad('recoger'));
    await pagina.waitForFunction(
      () => document.querySelectorAll('#env-lista-productos button').length > 0, { timeout: 10000 });
    assert.strictEqual(await pagina.evaluate(() => ENV_TIPO), 'recoger');
    await clicPorTexto(pagina, '#env-lista-productos button', fx.configurable.nombre);
    await pagina.waitForFunction(() => !!document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    assert.strictEqual(await modalAbierto(pagina), true);
    assert.strictEqual(await botonAgregarDeshabilitado(pagina), true, 'el obligatorio también manda aquí');
    await pagina.evaluate(() => document.getElementById('xb-mods-cancelar').click());
  });
  await pagina.close();
}

// ─── PARA LLEVAR / MOSTRADOR — comportamiento actual, intacto ──────────────
{
  const { pagina, errores } = await nuevaPagina('/app');
  const carrito = () => pagina.evaluate(() => JSON.parse(JSON.stringify(posCarrito)));

  await t('LLEVAR', '13. para llevar conserva su comportamiento: simple directo, configurable pregunta', async () => {
    await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
    await pagina.waitForFunction(
      () => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
    await clicPorTexto(pagina, '.pos-producto', fx.simple.nombre);
    assert.strictEqual(await modalAbierto(pagina), false);
    assert.strictEqual((await carrito()).length, 1);

    await clicPorTexto(pagina, '.pos-producto', fx.configurable.nombre);
    await pagina.waitForFunction(() => !!document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    assert.strictEqual(await botonAgregarDeshabilitado(pagina), true);
    assert.strictEqual((await carrito()).length, 1, 'nada entra mientras se configura');
  });

  await t('LLEVAR', '14. para llevar: selección completa entra con su precio y su texto', async () => {
    await elegirOpcionModal(pagina, 'Bien cocido');
    await elegirOpcionModal(pagina, 'Tocino'); // +25
    await pagina.evaluate(() => document.getElementById('xb-mods-agregar').click());
    await pagina.waitForFunction(() => !document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
    const c = await carrito();
    assert.strictEqual(c.length, 2);
    assert.strictEqual(c[1].precio_unitario, 145, '120 + 25');
    assert.match(c[1].textoModificadores, /Término: Bien cocido/);
    assert.match(c[1].textoModificadores, /Extras: Tocino/);
    assert.deepStrictEqual(errores, [], 'sin errores de JavaScript');
  });
  await pagina.close();
}

// ─── MESA — comportamiento actual (wizard secuencial), intacto ─────────────
{
  const abrir = await api(base, '/api/restaurante/mesas/abrir', { cookie: cookieAdmin, method: 'POST',
    body: { mesa: 7, personas: 2, meseroUsuarioId: SEED.adminNegocioAUsuarioId } });
  const cuentaId = abrir.body?.cuenta?.id;
  const { pagina, errores } = await nuevaPagina('/restaurante');

  // La UI sigue mandando el item al servidor después de cerrar el wizard:
  // se espera a que la cuenta lo tenga, no al cierre del diálogo.
  async function esperarItems(n, ms = 10000) {
    const fin = Date.now() + ms;
    let ultima = null;
    while (Date.now() < fin) {
      const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: cookieAdmin });
      ultima = c.body?.items || [];
      if (ultima.length >= n) return ultima;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`la cuenta no llegó a ${n} items: ${JSON.stringify(ultima)}`);
  }

  await t('MESA', '15. mesa conserva su wizard: producto simple directo, configurable por pasos', async () => {
    assert.ok(cuentaId, 'la mesa debe abrirse: ' + JSON.stringify(abrir.body));
    await pagina.evaluate(id => abrirCuenta(id), cuentaId);
    await pagina.waitForFunction(() => document.querySelectorAll('#prods .prod').length > 0, { timeout: 10000 });

    await pagina.click(`.prod[data-producto="${fx.simple.id}"]`);
    await esperarItems(1);
    assert.strictEqual(await modalAbierto(pagina, 'xb-wiz-dlg'), false, 'sin grupos no abre el wizard');

    await pagina.click(`.prod[data-producto="${fx.configurable.id}"]`);
    await pagina.waitForFunction(() => !!document.getElementById('xb-wiz-dlg')?.open, { timeout: 5000 });
    assert.strictEqual(await modalAbierto(pagina, 'xb-wiz-dlg'), true, 'con grupos abre el wizard, no el modal');
    assert.strictEqual(await modalAbierto(pagina, 'xb-mods-dlg'), false, 'mesa NO cambia al formulario largo');
    const paso = await pagina.$eval('#xb-wiz-paso', el => el.textContent);
    assert.strictEqual(paso, 'Paso 1 de 2', 'sigue siendo un grupo por pantalla');
  });

  await t('MESA', '16. mesa: el wizard completo agrega la línea con sus opciones al servidor', async () => {
    await clicPorTexto(pagina, '#xb-wiz-body .xb-wiz-op', 'Suave');        // avanza solo (max 1)
    await clicPorTexto(pagina, '#xb-wiz-body .xb-wiz-op', 'Queso');        // opcional, +15
    await pagina.evaluate(() => document.getElementById('xb-wiz-seguir').click()); // → resumen
    assert.strictEqual(await pagina.$eval('#xb-wiz-paso', el => el.textContent), 'Resumen');
    await pagina.evaluate(() => document.getElementById('xb-wiz-seguir').click()); // → agregar
    await pagina.waitForFunction(() => !document.getElementById('xb-wiz-dlg')?.open, { timeout: 5000 });

    const items = await esperarItems(2);
    const item = items.find(i => i.producto === fx.configurable.nombre || i.nombre === fx.configurable.nombre);
    assert.ok(item, 'la línea llegó a la cuenta: ' + JSON.stringify(items));
    assert.strictEqual(Number(item.precio_unitario), 135, '120 + 15, precio del servidor');
    const texto = [item.notas, ...(item.modificadores || [])].filter(Boolean).join(' ');
    assert.match(texto, /Suave/);
    assert.match(texto, /Queso/);
    assert.deepStrictEqual(errores, [], 'sin errores de JavaScript');
  });
  await pagina.close();
  await pool.query(`DELETE FROM restaurante_cuentas WHERE id = $1`, [cuentaId]).catch(() => {});
}

await navegador.close();

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 2 — EL PUNTO COMÚN ES UNO SOLO
//  La garantía de fondo no es "domicilio ya pregunta": es que la decisión de
//  preguntar existe UNA vez y los cuatro canales la llaman. Si alguien vuelve
//  a escribir su propia versión en una captura nueva, esto lo caza.
// ═══════════════════════════════════════════════════════════════════════════
const traer = async (ruta) => (await fetch(base + ruta)).text();

await t('PUNTO-COMUN', '17. el módulo compartido expone el punto único de selección', async () => {
  const js = await traer('/modificadores.js');
  assert.match(js, /function elegirLinea\(/, 'la decisión vive en el módulo compartido');
  assert.match(js, /function firmaLinea\(/, 'la identidad de línea también');
  assert.match(js, /elegirLinea,\s*firmaLinea/, 'y ambas se exportan');
});

await t('PUNTO-COMUN', '18. las tres capturas del panel entran por elegirLinea, ninguna decide por su cuenta', async () => {
  const panel = await traer('/index.html');
  const mesas = await traer('/mesas.html');
  for (const [pantalla, fuente, fn] of [
    ['mostrador', panel, 'elegirProductoPOS'],
    ['envíos (domicilio y recoger)', panel, 'envAgregar'],
    ['mesa', mesas, 'elegirProducto'],
  ]) {
    const cuerpo = fuente.slice(fuente.indexOf(`function ${fn}(`));
    assert.ok(cuerpo.includes('XaborModificadores.elegirLinea'),
      `${pantalla}: ${fn} debe seleccionar por el punto común`);
  }
  // Nadie vuelve a llamar al configurador por su cuenta desde una captura:
  // el modo (modal o wizard) se pide, no se elige llamando a otra función.
  assert.ok(!panel.includes('XaborModificadores.abrirModal('),
    'el panel ya no abre el modal salteándose el punto común');
  assert.ok(!mesas.includes('XaborModificadores.abrirWizard('),
    'mesas ya no abre el wizard salteándose el punto común');
});

await t('PUNTO-COMUN', '19. envíos manda los modificadores al servidor (antes solo producto_id y cantidad)', async () => {
  const panel = await traer('/index.html');
  const cuerpo = panel.slice(panel.indexOf('async function envCrearPedido('), panel.indexOf('async function cargarEnviosActivos('));
  assert.match(cuerpo, /modificadores:\s*it\.modificadores/, 'la selección viaja en el pedido');
  const carga = panel.slice(panel.indexOf('async function envCargarMenu('), panel.indexOf('function envFiltrarProductos('));
  assert.match(carga, /modificadores:\s*p\.modificadores/, 'y el catálogo la conserva al cargarse');
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 2b — EL PANEL Y SU MÓDULO NO PUEDEN LLEGAR DESPAREJOS
//
//  Esto no es teoría. El 2026-09-15 la captura de pedidos se cayó en
//  producción sin que fallara una sola prueba: el panel nuevo llamaba a
//  `elegirLinea`, función NUEVA del módulo, y al navegador le llegó el módulo
//  VIEJO de su caché — Cloudflare sirve los .js con max-age=14400, cuatro
//  horas sin preguntar, mientras que /app se revalida en cada carga.
//  Resultado: «elegirLinea is not a function» al primer clic y ningún producto
//  se podía agregar, en NINGUNA modalidad.
//
//  Las suites no lo vieron porque el navegador de pruebas arranca sin caché y
//  siempre recibe los dos archivos del mismo commit. Estas dos comprobaciones
//  son estáticas a propósito: miran la PAREJA, que es lo único que el navegador
//  de un operador sí puede recibir desparejo.
// ═══════════════════════════════════════════════════════════════════════════
const { createHash } = await import('crypto');

await t('CACHE', '20. la etiqueta del módulo lleva la huella de su contenido, en las dos pantallas', async () => {
  const modulo = readFileSync(join(__dirname, '..', 'panel', 'modificadores.js'));
  const huella = createHash('sha256').update(modulo).digest('hex').slice(0, 8);
  for (const [pantalla, ruta] of [['panel', '/index.html'], ['mesas', '/mesas.html']]) {
    const html = await traer(ruta);
    const refs = [...html.matchAll(/src="\/modificadores\.js(\?v=([0-9a-f]{8}))?"/g)];
    assert.ok(refs.length >= 1, `${pantalla}: debe cargar el módulo`);
    for (const r of refs) {
      assert.ok(r[2], `${pantalla}: hay un <script src="/modificadores.js"> SIN ?v= — la caché de 4 h lo puede servir viejo`);
      assert.strictEqual(r[2], huella,
        `${pantalla}: el ?v= dice "${r[2]}" pero el módulo tiene huella "${huella}". ` +
        `Si acabas de editar modificadores.js, pon "${huella}" en el ?v= de index.html y de mesas.html.`);
    }
  }
});

await t('CACHE', '21. toda función del módulo que una pantalla invoca EXISTE en el módulo', async () => {
  // La comprobación de fondo: aunque alguien olvidara el ?v=, esto caza el
  // momento exacto en que una pantalla empieza a depender de algo que el
  // módulo no ofrece. Es la forma de la caída de producción, en estático.
  const js = await traer('/modificadores.js');
  const expuestas = new Set(
    (js.match(/global\.XaborModificadores\s*=\s*\{([^}]*)\}/)?.[1] || '')
      .split(',').map(s => s.split(':')[0].trim()).filter(Boolean));
  assert.ok(expuestas.size >= 4, 'se debe poder leer lo que el módulo expone: ' + [...expuestas]);
  for (const ruta of ['/index.html', '/mesas.html']) {
    const html = await traer(ruta);
    const usadas = new Set([...html.matchAll(/XaborModificadores\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    assert.ok(usadas.size > 0, `${ruta} debe usar el módulo`);
    for (const fn of usadas) {
      assert.ok(expuestas.has(fn),
        `${ruta} llama a XaborModificadores.${fn}, que el módulo NO expone ` +
        `(expone: ${[...expuestas].join(', ')}). Así se cayó producción el 2026-09-15.`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 3 — EL SERVIDOR SIGUE SIENDO LA AUTORIDAD
//  La pantalla evita pedir algo inválido; el servidor lo impide. Ninguna de
//  las dos capas sustituye a la otra.
// ═══════════════════════════════════════════════════════════════════════════
const pedidoDom = (items) => ({
  tipo: 'domicilio', cliente: { nombre: 'Canales Servidor', telefono: '8781119002' },
  direccion: { calle: 'Av. Prueba', numero_exterior: '1', colonia: 'Centro' },
  items, formaPago: 'efectivo', costoEnvio: 0,
});

await t('SERVIDOR', '20. domicilio + obligatorio sin elegir → 400, el pedido NO nace', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdmin, method: 'POST',
    body: pedidoDom([{ producto_id: fx.configurable.id, cantidad: 1 }]) });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.codigo, 'GRUPO_REQUERIDO');
});

await t('SERVIDOR', '21. domicilio + sin modificadores en un producto simple → 200 directo', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdmin, method: 'POST',
    body: pedidoDom([{ producto_id: fx.simple.id, cantidad: 2 }]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.total, 80);
});

await t('SERVIDOR', '22. domicilio + completos → 200 con el precio real de la base, no el del frontend', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdmin, method: 'POST',
    body: pedidoDom([{ producto_id: fx.configurable.id, cantidad: 2, precio_unitario: 1,
      modificadores: [fx.op.cocido, fx.op.queso, fx.op.tocino] }]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.total, 320, '(120 + 15 + 25) × 2');
  assert.strictEqual(r.body.pedido.items[0].precio_unitario, 160);
});

await t('SERVIDOR', '23. el máximo del grupo opcional también se impone en domicilio', async () => {
  const { rows: [extra] } = await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,'Aguacate',10,TRUE,9) RETURNING id`, [A, fx.grupos.extras]);
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdmin, method: 'POST',
    body: pedidoDom([{ producto_id: fx.configurable.id, cantidad: 1,
      modificadores: [fx.op.suave, fx.op.queso, fx.op.tocino, extra.id] }]) });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.codigo, 'MAXIMO_EXCEDIDO', 'Extras admite 2, no 3');
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE id = $1`, [extra.id]);
});

await t('SERVIDOR', '24. para llevar (presencial) mantiene exactamente las mismas reglas', async () => {
  const falta = await api(base, '/api/pedido-presencial', { cookie: cookieAdmin, method: 'POST',
    body: { items: [{ producto_id: fx.configurable.id, cantidad: 1 }], nombre: 'Canales Llevar', forma_pago: 'efectivo' } });
  assert.strictEqual(falta.status, 400);
  assert.strictEqual(falta.body.codigo, 'GRUPO_REQUERIDO');

  const ok = await api(base, '/api/pedido-presencial', { cookie: cookieAdmin, method: 'POST',
    body: { items: [{ producto_id: fx.configurable.id, cantidad: 1, modificadores: [fx.op.suave, fx.op.tocino] }],
      nombre: 'Canales Llevar', forma_pago: 'efectivo' } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.pedido.items[0].precio_unitario, 145);
  assert.match(ok.body.pedido.items[0].notas, /Término: Suave/);
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
