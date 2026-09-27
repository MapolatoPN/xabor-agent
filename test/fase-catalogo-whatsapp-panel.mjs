// PRODUCTOS PARA WHATSAPP DESDE EL PANEL, con el servidor y las sesiones REALES.
//
// Revisión Codex, hallazgo 3: la pantalla existía pero no se llegaba a ella
// desde el panel, y sus pruebas montaban las rutas con una sesión simulada.
// Aquí todo es de verdad: `src/server.js` como proceso hijo, cookies firmadas
// con `crearTokenSesion` y membresías reales del seed.
//
//   P1  la página se sirve;
//   P2  el administrador lista y publica, y la carta del agente cambia;
//   P3  staff: 403 al listar y al publicar, y no cambia nada;
//   P4  sin sesión: 401 en las APIs;
//   P5  el negocio sale SOLO de la sesión: negocioId en cuerpo o query, la
//       cabecera x-negocio-slug y el token legado no mueven de negocio;
//   P6  el administrador de B no puede alterar los productos de A;
//   P7  sin el módulo de WhatsApp: 403;
//   P8  navegación real (Puppeteer): Menú → «Productos para WhatsApp» abre la
//       pantalla con los productos del negocio; staff (P8b), un negocio sin el
//       módulo (P8c) y uno sin NINGÚN módulo (P8d) no ven el enlace. La
//       espera es el FIN de la carga de permisos, no «hay algún módulo».
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-catalogo-whatsapp-panel.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_CATALOGO_PANEL || '4731';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { obtenerCatalogoDelAgente } = await import('../src/services/catalogoWhatsapp.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const A = SEED.negocioA, B = SEED.negocioB;
const MARCA = 'CWP ';
const sesion = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

// ── Fixture: productos marcados en A y en B, y un administrador de B ──────
async function limpiar() {
  for (const neg of [A, B]) {
    await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE $2`, [neg, `${MARCA}%`]);
    await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE $2`, [neg, `${MARCA}%`]);
  }
}
await limpiar();
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cat = async (neg, n) => (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa)
  VALUES ($1,$2,990,TRUE) RETURNING id`, [neg, `${MARCA}${n}`])).id;
const prod = async (neg, c, n, precio) => (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio)
  VALUES ($1,$2,$3,$4) RETURNING id`, [neg, c, `${MARCA}${n}`, precio])).id;
const catA = await cat(A, 'Desayunos');
const WAFFLE = await prod(A, catA, 'Waffle', 120);
const INTERNO = await prod(A, catA, 'Pieza Interna', 5);
const catB = await cat(B, 'Pizzas');
const PIZZA_B = await prod(B, catB, 'Pizza de B', 180);

const correoAdminB = 'admin-b-carta-wa@test.local';
let adminB = (await pool.query(`SELECT id FROM usuarios WHERE email=$1`, [correoAdminB])).rows[0]?.id;
if (!adminB) {
  adminB = (await crearUsuarioConPassword({
    negocioId: B, nombre: 'Admin B Carta WA', email: correoAdminB, password: 'ClaveAdminBCarta123!', rol: 'admin',
  })).id;
}
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')
  ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol='admin', activo=TRUE`, [adminB, B]);

const cookieAdminA = sesion(SEED.adminNegocioAUsuarioId, A, 'admin');
const cookieStaffA = sesion(SEED.staffNegocioAUsuarioId, A, 'staff');
const cookieAdminB = sesion(adminB, B, 'admin');

const fila = async (neg, id) => (await pool.query(
  `SELECT publicado FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id=$2`, [neg, id])).rows[0] || null;
const nombresAgente = async (neg) => (await obtenerCatalogoDelAgente(neg)).carta
  .flatMap((c) => c.productos.map((p) => p.nombre)).filter((n) => n.startsWith(MARCA)).sort();

// Estado inicial conocido: nada marcado está publicado.
await pool.query(`DELETE FROM whatsapp_productos WHERE producto_id = ANY($1::int[])`, [[WAFFLE, INTERNO, PIZZA_B]]);
// Los módulos de A se fotografían TODOS y se restauran al final: P8c y P8d los
// apagan, y una corrida que muera a la mitad no puede dejarle a la siguiente
// un «original» equivocado. Se parte de WhatsApp activo (la prueba lo exige).
const modulosOriginalesA = (await pool.query(
  `SELECT modulo, estado FROM negocio_modulos WHERE negocio_id=$1`, [A])).rows;
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [A]);
const moduloOriginal = 'activo';
async function restaurarModulosA() {
  const originales = new Map(modulosOriginalesA.map((m) => [m.modulo, m.estado]));
  const { rows } = await pool.query(`SELECT modulo FROM negocio_modulos WHERE negocio_id=$1`, [A]);
  for (const { modulo } of rows) {
    if (originales.has(modulo)) {
      await pool.query(`UPDATE negocio_modulos SET estado=$3 WHERE negocio_id=$1 AND modulo=$2`, [A, modulo, originales.get(modulo)]);
    } else {
      await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo=$2`, [A, modulo]);
    }
  }
}

const srv = await arrancarServidor({ PORT: PUERTO });
const api = async (ruta, { cookie, metodo = 'GET', cuerpo, headers = {} } = {}) => {
  const r = await fetch(srv.base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null), texto: '' };
};
const LISTA = '/api/admin/whatsapp/productos';
const PUBLICAR = '/api/admin/whatsapp/productos/publicar';

let navegador = null;
try {
  await t('P1. /catalogo-whatsapp sirve la pantalla', async () => {
    const r = await fetch(`${srv.base}/catalogo-whatsapp`);
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /Productos para WhatsApp/);
  });

  await t('P2. el administrador lista y publica; la carta del agente cambia', async () => {
    const lista = await api(LISTA, { cookie: cookieAdminA });
    assert.strictEqual(lista.status, 200, JSON.stringify(lista.body));
    const mios = lista.body.productos.filter((p) => p.nombre.startsWith(MARCA)).map((p) => p.nombre).sort();
    assert.deepStrictEqual(mios, [`${MARCA}Pieza Interna`, `${MARCA}Waffle`], 'la lista del admin es la de su negocio');
    const r = await api(PUBLICAR, { cookie: cookieAdminA, metodo: 'POST', cuerpo: { productoIds: [WAFFLE], publicado: true } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.actualizados, 1);
    assert.deepStrictEqual(await fila(A, WAFFLE), { publicado: true });
    assert.deepStrictEqual(await nombresAgente(A), [`${MARCA}Waffle`], 'lo publicado desde el panel es lo que vende el bot');
  });

  await t('P3. staff: 403 al listar y al publicar, sin efecto', async () => {
    assert.strictEqual((await api(LISTA, { cookie: cookieStaffA })).status, 403);
    const r = await api(PUBLICAR, { cookie: cookieStaffA, metodo: 'POST', cuerpo: { productoIds: [INTERNO], publicado: true } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(await fila(A, INTERNO), null, 'un staff publicó');
  });

  await t('P4. sin sesión: 401 en las APIs', async () => {
    assert.strictEqual((await api(LISTA)).status, 401);
    assert.strictEqual((await api(PUBLICAR, { metodo: 'POST', cuerpo: { productoIds: [INTERNO], publicado: true } })).status, 401);
    assert.strictEqual(await fila(A, INTERNO), null);
  });

  await t('P5. el negocio sale solo de la sesión: cuerpo, query, cabecera y token legado no lo cambian', async () => {
    const { rows: [slugB] } = await pool.query(`SELECT slug FROM negocios WHERE id=$1`, [B]);
    // Sesión de A pidiendo, por todas las puertas, operar sobre B.
    const r = await api(`${PUBLICAR}?negocioId=${B}`, {
      cookie: cookieAdminA, metodo: 'POST', headers: { 'x-negocio-slug': slugB.slug, 'x-negocio-id': B },
      cuerpo: { negocioId: B, negocio_id: B, productoIds: [PIZZA_B], publicado: true },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.actualizados, 0, 'se publicó un producto de otro negocio');
    assert.strictEqual(await fila(B, PIZZA_B), null);
    const lista = await api(`${LISTA}?negocioId=${B}`, { cookie: cookieAdminA, headers: { 'x-negocio-slug': slugB.slug } });
    assert.ok(!lista.body.productos.some((p) => p.id === PIZZA_B), 'la lista de A mostró productos de B');
    // El token estático legado + x-negocio-slug elige el negocio por CABECERA.
    // Control positivo: el mismo token sí abre una ruta legada; el catálogo no.
    const legado = createHmac('sha256', process.env.PANEL_SECRET || 'xabor-secret-key')
      .update(process.env.ADMIN_PASSWORD || 'xabor-admin').digest('hex');
    const cabeceras = { Authorization: `Bearer ${legado}`, 'x-negocio-slug': slugB.slug };
    const control = await api('/api/config/pagos', { headers: cabeceras });
    assert.strictEqual(control.status, 200, `el control no prueba nada: el token legado no es válido (${control.status})`);
    const rl = await api(PUBLICAR, { metodo: 'POST', headers: cabeceras, cuerpo: { productoIds: [PIZZA_B], publicado: true } });
    assert.strictEqual(rl.status, 401, `el token legado + slug operó el catálogo de otro negocio (status ${rl.status})`);
    assert.strictEqual((await api(LISTA, { headers: cabeceras })).status, 401);
    assert.strictEqual(await fila(B, PIZZA_B), null);
  });

  await t('P6. el administrador de B no altera los productos de A', async () => {
    const r = await api(PUBLICAR, { cookie: cookieAdminB, metodo: 'POST', cuerpo: { productoIds: [WAFFLE, INTERNO], publicado: false } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.actualizados, 0);
    assert.deepStrictEqual(await fila(A, WAFFLE), { publicado: true }, 'B retiró un producto de A');
    const c = await api('/api/admin/whatsapp/categorias/publicar', { cookie: cookieAdminB, metodo: 'POST',
      cuerpo: { categoriaId: catA, publicado: true } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.actualizados, 0, 'B publicó una categoría de A');
    assert.strictEqual(await fila(A, INTERNO), null);
  });

  await t('P7. sin el módulo de WhatsApp: 403', async () => {
    await pool.query(`UPDATE negocio_modulos SET estado='no_contratado' WHERE negocio_id=$1 AND modulo='whatsapp'`, [A]);
    try {
      assert.strictEqual((await api(LISTA, { cookie: cookieAdminA })).status, 403);
      assert.strictEqual((await api(PUBLICAR, { cookie: cookieAdminA, metodo: 'POST',
        cuerpo: { productoIds: [INTERNO], publicado: true } })).status, 403);
    } finally {
      await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='whatsapp'`, [A, moduloOriginal || 'activo']);
    }
    assert.strictEqual(await fila(A, INTERNO), null);
  });

  // ── P8: navegación real ────────────────────────────────────────────────
  navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const abrirPanel = async (cookie) => {
    const ctx = await navegador.createBrowserContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const [nombre, ...resto] = cookie.split('=');
    await page.setCookie({ name: nombre, value: resto.join('='), url: srv.base });
    // El panel pide /api/auth/me mientras corre su <script>, antes de
    // DOMContentLoaded: la espera se arma ANTES de navegar o se pierde. Sirve
    // para fallar rápido con una cookie inválida.
    const me = page.waitForResponse((r) => { try { return new URL(r.url()).pathname === '/api/auth/me'; } catch { return false; } },
      { timeout: 20000 });
    await page.goto(`${srv.base}/app#menu`, { waitUntil: 'domcontentloaded' });
    const rMe = await me;
    assert.strictEqual(rMe.status(), 200, `/api/auth/me respondió ${rMe.status()}: la cookie de sesión no vale`);
    // Los permisos se aplican al volver /api/auth/me. La señal de que esa
    // carga TERMINÓ no puede ser «MODULOS tiene algo»: un negocio sin módulos
    // (P8c, P8d) la deja vacía para siempre. `ROL` tampoco sirve, porque nace
    // en 'staff'. `NEGOCIO_ID` nace en null y se asigna en el MISMO bloque
    // síncrono que MODULOS, el ocultado de admin-only y aplicarModulosUI()
    // (sin await entre ellos); `navTabActual` lo fija la navegación inicial
    // al final de ese bloque. El sondeo corre en otra tarea: nunca ve el
    // bloque a medias. Con los dos, los permisos ya se aplicaron, vacíos o no.
    await page.waitForFunction(() => typeof NEGOCIO_ID !== 'undefined' && NEGOCIO_ID !== null
      && typeof navTabActual !== 'undefined' && navTabActual !== null
      && Array.isArray(MODULOS) && document.getElementById('vista-menu') !== null,
    { timeout: 20000 });
    return { ctx, page };
  };
  const permisosDe = (page) => page.evaluate(() => ({ negocio: NEGOCIO_ID, rol: ROL, modulos: [...MODULOS] }));
  const enlaceVisible = (page) => page.evaluate(() => {
    const a = document.getElementById('btn-carta-whatsapp');
    if (!a) return { existe: false };
    const bloque = document.getElementById('menu-carta-whatsapp');
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    return { existe: true, visible: visible(a) && visible(bloque),
      // Control positivo: la vista que lo contiene SÍ se ve; si no, un «no se
      // ve el enlace» no probaría ninguna compuerta.
      contenedorVisible: visible(bloque.parentElement),
      // 'none' = lo ocultó SU propia compuerta (admin-only o data-modulo).
      displayPropio: bloque.style.display,
      href: a.getAttribute('href'), target: a.getAttribute('target') };
  });
  const forzarVistaMenu = (page) => page.evaluate(() => {
    document.getElementById('vistas-extra').style.display = '';
    document.getElementById('vista-menu').style.display = 'block';
  });

  await t('P8. admin: Menú → «Productos para WhatsApp» abre la pantalla con sus productos', async () => {
    const { ctx, page } = await abrirPanel(cookieAdminA);
    try {
      // Control positivo de la misma espera que usa P8c: con el módulo, la
      // lista que cargó el panel lo trae.
      const p = await permisosDe(page);
      assert.strictEqual(p.negocio, A, `el panel cargó otro negocio: ${p.negocio}`);
      assert.ok(p.modulos.includes('whatsapp'), `con el módulo contratado no llegó 'whatsapp': ${JSON.stringify(p.modulos)}`);
      await page.evaluate(() => mostrarTab('menu'));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('vista-menu')).display !== 'none');
      const e = await enlaceVisible(page);
      assert.ok(e.existe, 'no existe el enlace en la sección Menú');
      assert.ok(e.visible, 'el administrador no ve el enlace');
      assert.strictEqual(e.href, '/catalogo-whatsapp');
      assert.strictEqual(e.target, '_blank', 'abrir en la misma pestaña cerraría el panel que imprime comandas');
      // Se espera la PESTAÑA de la pantalla, no cualquier destino nuevo: el
      // panel registra un service worker que también crea destinos.
      const nueva = ctx.waitForTarget((d) => d.type() === 'page' && d.url().endsWith('/catalogo-whatsapp'),
        { timeout: 20000 });
      await page.click('#btn-carta-whatsapp');
      const pantalla = await (await nueva).page();
      await pantalla.waitForFunction((m) => document.body.innerText.includes(`${m}Waffle`), { timeout: 20000 }, MARCA);
      const texto = await pantalla.evaluate(() => document.body.innerText);
      assert.ok(pantalla.url().endsWith('/catalogo-whatsapp'), pantalla.url());
      assert.ok(texto.includes(`${MARCA}Pieza Interna`), 'la pantalla no lista los productos del negocio');
      assert.ok(!texto.includes(`${MARCA}Pizza de B`), 'la pantalla de A lista productos de B');
    } finally { await ctx.close(); }
  });

  await t('P8b. staff no ve el enlace, ni aunque la vista Menú quede a la vista', async () => {
    const { ctx, page } = await abrirPanel(cookieStaffA);
    try {
      // La pestaña Menú ya es solo de administrador, así que para un staff la
      // vista entera está oculta. Se fuerza visible para probar la compuerta
      // PROPIA del enlace, que es la que tiene que sostenerse sola.
      const p = await permisosDe(page);
      assert.strictEqual(p.rol, 'staff', `se esperaba staff: ${p.rol}`);
      assert.ok(p.modulos.includes('whatsapp'), 'sin el módulo lo ocultaría data-modulo, no admin-only: el caso no probaría nada');
      await forzarVistaMenu(page);
      const e = await enlaceVisible(page);
      assert.ok(e.existe, 'no existe el enlace en la sección Menú');
      assert.ok(e.contenedorVisible, 'la vista Menú no quedó a la vista: el caso no prueba nada');
      assert.ok(!e.visible, 'un staff ve el enlace a Productos para WhatsApp');
      assert.strictEqual(e.displayPropio, 'none', 'lo ocultó otra cosa, no su propia compuerta');
    } finally { await ctx.close(); }
  });

  // P8c y P8d: la carga de permisos TERMINA con la lista sin 'whatsapp' (o
  // vacía): la ausencia del enlace no es una carrera contra /api/auth/me.
  const sinEnlaceTrasCargar = async (esperaVacia) => {
    const { ctx, page } = await abrirPanel(cookieAdminA);
    try {
      const p = await permisosDe(page);
      assert.strictEqual(p.negocio, A, `el panel cargó otro negocio: ${p.negocio}`);
      assert.strictEqual(p.rol, 'admin', 'sin admin, admin-only lo ocultaría igual: el caso no probaría data-modulo');
      assert.ok(!p.modulos.includes('whatsapp'), `sin contratar, el panel recibió 'whatsapp': ${JSON.stringify(p.modulos)}`);
      if (esperaVacia) assert.deepStrictEqual(p.modulos, [], `se esperaba un negocio sin módulos: ${JSON.stringify(p.modulos)}`);
      // Igual que P8b: se fuerza la vista Menú para probar la compuerta PROPIA
      // del enlace (data-modulo), no la de la pestaña.
      await forzarVistaMenu(page);
      const e = await enlaceVisible(page);
      assert.ok(e.existe, 'no existe el enlace en la sección Menú');
      assert.ok(e.contenedorVisible, 'la vista Menú no quedó a la vista: el caso no prueba nada');
      assert.ok(!e.visible, 'sin el módulo, el enlace sigue a la vista');
      assert.strictEqual(e.displayPropio, 'none', 'lo ocultó otra cosa, no data-modulo="whatsapp"');
    } finally { await ctx.close(); }
  };

  await t('P8c. un negocio sin el módulo de WhatsApp no ve el enlace', async () => {
    await pool.query(`UPDATE negocio_modulos SET estado='no_contratado' WHERE negocio_id=$1 AND modulo='whatsapp'`, [A]);
    try {
      await sinEnlaceTrasCargar(false);
    } finally {
      await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='whatsapp'`, [A, moduloOriginal]);
    }
  });

  await t('P8d. un negocio SIN NINGÚN módulo: la carga de permisos termina y el enlace no se ve', async () => {
    await pool.query(`UPDATE negocio_modulos SET estado='no_contratado' WHERE negocio_id=$1`, [A]);
    try {
      await sinEnlaceTrasCargar(true);
    } finally {
      await restaurarModulosA();
      await pool.query(`UPDATE negocio_modulos SET estado='activo' WHERE negocio_id=$1 AND modulo='whatsapp'`, [A]);
    }
  });
} finally {
  if (navegador) await navegador.close().catch(() => {});
  srv.detener();
  await limpiar().catch(() => {});
  await restaurarModulosA().catch((e) => console.log(`FALLO al restaurar los módulos de A: ${e.message}`));
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
process.exit(0);
