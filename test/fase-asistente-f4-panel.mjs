// ASISTENTE DEL RESTAURANTE, Fase 4: la pestaña «Asistente» de Reportes, en
// un navegador real (puppeteer) contra el servidor de prueba.
//
// Negocio, usuarios, ventas y hallazgos INVENTADOS, creados aquí y borrados al
// final. Cubre:
//   A. los archivos: la huella ?v= de panel/asistente-pantalla.js, que no arma
//      HTML con texto, y que la pestaña va primero en Reportes y nace oculta;
//   B. en el navegador: entrar a Reportes sigue abriendo Ventas y la pestaña
//      aparece solo si el servidor deja (sin pedir todavía las recomendaciones);
//      «Cómo va el día» con las ventas de hoy contra el mismo día de la semana
//      pasada; las tarjetas en su orden (control primero), con su cifra y su
//      gráfica, sin lo no elegido ni lo callado; el texto de la base se pinta
//      como texto; «Ver números» abre y cierra; Útil / No útil se guardan por
//      persona y se ven al volver; «No avisar de esto» quita la tarjeta; el
//      error del servidor se ve y «Reintentar» funciona; la liga directa
//      #reportes/asistente; en ensayo, otro administrador o el operador no ven
//      la pestaña ni piden nada; la campanita no pide nada del asistente; y en
//      el celular nada se sale de la pantalla.
//
// La sucursal vive en una zona donde AHORA son de las 14 a las 21: las ventas
// de hoy (10:15 y 12:30) ya pasaron, y el servidor de prueba no le corre la
// revisión de la mañana (de 6 a 12). El resumen por WhatsApp va apagado (sin
// XABOR_ASISTENTE_RESUMEN_WA, como en producción).
import assert from 'assert';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool } = await import('../src/services/database.js');
const { instanteLocal, fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const R = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const AP = await import('../src/services/avisosPanel.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const RUTA = '/api/admin/asistente-restaurante/pantalla';

// ═══ A. Los archivos ═══════════════════════════════════════════════════════
const HTML = readFileSync(raiz('panel/index.html'), 'utf8');
const JS = readFileSync(raiz('panel/asistente-pantalla.js'), 'utf8');
const huella = (f) => createHash('sha256').update(readFileSync(raiz(`panel/${f}`))).digest('hex').slice(0, 8);

await t('A1. la huella ?v= de asistente-pantalla.js; no arma HTML con texto; la pestaña va primero en Reportes y nace oculta', () => {
  assert.ok(HTML.includes(`<script src="/asistente-pantalla.js?v=${huella('asistente-pantalla.js')}"></script>`),
    `la huella correcta de asistente-pantalla.js es ${huella('asistente-pantalla.js')}`);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(JS), 'asistente-pantalla.js arma HTML con texto');
  const barra = HTML.slice(HTML.indexOf('id="pestanas-reportes"'), HTML.indexOf('</nav>', HTML.indexOf('id="pestanas-reportes"')));
  const ids = [...barra.matchAll(/<button[^>]*\bid="(pest-[a-z]+)"/g)].map((m) => m[1]);
  assert.strictEqual(ids[0], 'pest-asistente', `la primera pestaña de Reportes es ${ids[0]}`);
  assert.match(barra, /id="pest-asistente" style="display:none"/, 'la pestaña no nace oculta');
  assert.match(HTML, /<div id="vista-asistente" style="display:none;[^"]*">\s*<div id="reportes-asistente"><\/div>/);
});

// ═══ B. En un navegador real ══════════════════════════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h >= 14 && h <= 21; }));
if (!TZ) { console.error('ninguna zona entre las 14 y las 21'); process.exit(2); }
const HOY = fechaOperativaDe(new Date(), TZ);
const PASADA = R.sumarDias(HOY, -7);
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };

const TAG = 'AQ' + (Date.now() % 1e8).toString(36).toUpperCase();
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f4p-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}
await limpiar();

const A = (await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [`${TAG} Sucursal`, `${TAG.toLowerCase()}-asis-f4p-a`])).id;
for (const m of ['pos', 'caja', 'whatsapp', 'menu']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [A, m]);
async function usuario(nombre, rol) {
  const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
    [A, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
  await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, A, rol]);
  return u.id;
}
const ADMIN = await usuario(`${TAG} Dueño`, 'admin');
const ADMIN2 = await usuario(`${TAG} Gerente`, 'admin');
const STAFF = await usuario(`${TAG} Cajera`, 'staff');
async function cfg(clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [A, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [A, clave, valor]);
}
await cfg('timezone', TZ);
await cfg(AV.BANDERA, 'true');
await cfg(AV.CLAVE_MODO, 'visible');
await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));

// Las ventas: hoy $300 y $200 (antes de esta hora); el mismo día de la semana
// pasada, $100 y $150. Todas debajo del piso de «pedido grande».
const F = (s) => `ACP-${TAG}-${s}`;
async function venta(folio, instante, total) {
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, 'entregado', JSON.stringify({ id: folio, canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: total, total,
      items: [{ nombre: 'Café', cantidad: 1, precio_unitario: total }] }), A, instante.toISOString()]);
}
await venta(F('H1'), a(HOY, 10, 15), 300);
await venta(F('H2'), a(HOY, 12, 30), 200);
await venta(F('P1'), a(PASADA, 10), 100);
await venta(F('P2'), a(PASADA, 12, 59), 150);

const XSS = '<img src=x onerror="window.__xss=1">';
const REVISAR_EL = R.sumarDias(HOY, 7);
// La revisión de hoy: tres elegidos (uno de control, uno de ventas y uno de
// clientes redactado por la IA), uno NO elegido y uno elegido pero callado.
async function sembrar() {
  await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [A]);
  await q('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A]);
  const c = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos, terminada_en)
                       VALUES ($1, $2, 'visible', 'lista', 5, 4, now()) RETURNING id`, [A, HOY]);
  const h = async (tipo, firma, impacto, titulo, contenido, elegido = true) => (await uno(
    `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, false) RETURNING id::text AS id`,
    [A, c.id, tipo, firma, impacto, titulo, JSON.stringify(contenido), elegido, elegido ? 'elegido' : 'no_paso_minimo'])).id;
  const venta1 = await h('producto_baja', 'producto_baja:p1', 4200, `«${XSS}» vendió 30 % menos que las 4 semanas anteriores (−$4,200).`, {
    pantalla: { encabezado: `«${XSS}» vende menos` },
    detalle: {
      numeros: [{ etiqueta: 'Venta de las últimas 4 semanas', valor: 9800, formato: 'dinero' }, { etiqueta: 'Las 4 semanas antes', valor: 14000, formato: 'dinero' }],
      tabla: { columnas: ['Producto', 'Tickets', 'Venta'], formatos: ['texto', 'entero', 'dinero'], filas: [[XSS, 1520, 9800.4], ['Café', 300, 1200]] },
      nota: 'Sin pedidos grandes.',
    },
    sugerencia: 'Revisa que el platillo esté a la vista en el menú y en la tienda.',
    revisar: { numero: 'Venta semanal del platillo', valor: 2450, formato: 'dinero', el: REVISAR_EL },
  });
  const control = await h('ventas_sin_forma_pago', 'ventas_sin_forma_pago', 600, '3 ventas de la semana no tienen forma de pago ($600).', {
    pantalla: { encabezado: '3 ventas sin forma de pago' },
    detalle: { numeros: [{ etiqueta: 'Ventas', valor: 3, formato: 'entero' }, { etiqueta: 'Monto', valor: 600, formato: 'dinero' }] },
    sugerencia: 'Captura la forma de pago de esas ventas para que el corte cuadre.',
  });
  const clientes = await h('clientes_dejaron', 'clientes_dejaron', 900, '2 clientes frecuentes no han vuelto en 30 días.', {
    pantalla: { encabezado: '2 clientes frecuentes no han vuelto' },
    detalle: {
      numeros: [{ etiqueta: 'Clientes', valor: 2, formato: 'entero' }, { etiqueta: 'Dejaban al mes', valor: 900, formato: 'dinero' }],
      tabla: { columnas: ['Cliente', 'Gasto al mes'], formatos: ['texto', 'dinero'], filas: [['Ana López', 500], ['Beto Ruiz', 400]] },
    },
    sugerencia: 'Texto de Xabor que la IA reemplaza.',
    ia: { titulo: 'Dos clientes de siempre no han regresado.', sugerencia: 'Escríbeles para invitarlos de vuelta.', explicacion: `Venían cada semana ${XSS}.` },
  });
  const noElegido = await h('canal_baja', 'canal_baja:tienda', 99999, 'La tienda vendió menos (NO ELEGIDO).', { pantalla: { encabezado: 'NO ELEGIDO' } }, false);
  const callado = await h('cortesias_altas', 'cortesias_altas', 77777, 'Cortesías altas (CALLADO).', { pantalla: { encabezado: 'CALLADO' } });
  await q('INSERT INTO asistente_restaurante_silenciados (negocio_id, firma) VALUES ($1, $2)', [A, 'cortesias_altas']);
  return { venta1, control, clientes, noElegido, callado };
}

const { crearTokenSesion } = await import('../src/services/session.js');
const { arrancarServidor } = await import('./lib-servidor.mjs');
const ses = (u, rol) => encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: A, rol }));
const SES = { admin: ses(ADMIN, 'admin'), admin2: ses(ADMIN2, 'admin'), staff: ses(STAFF, 'staff') };

let puppeteer = null;
try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
let srv = null, navegador = null;
try {
  if (!puppeteer) {
    await t('B. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_F4_PANEL || '4742' }, { timeoutMs: 40000, omitir: ['XABOR_ASISTENTE_RESUMEN_WA'] });
    const BASE = srv.base;
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    // `fallar(url)`: true para responder 500 a esa petición (solo la ruta completa).
    async function abrirPanel(sesion, { ancho = 1280, alto = 800, hash = '', rol = 'admin', fallar = null } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: sesion, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const p = { page, pedidas: [], errores: [], cerrar: () => ctxN.close() };
      if (fallar) await page.setRequestInterception(true);
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith('/api/admin/asistente-restaurante/')) p.pedidas.push(`${r.method()} ${u.pathname}${u.search}`);
        if (!fallar) return;
        if (fallar(u, r)) r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Falla inventada de prueba' }) });
        else r.continue();
      });
      page.on('pageerror', (e) => p.errores.push(e.message));
      page.on('dialog', (d) => d.dismiss().catch(() => {}));
      await page.evaluateOnNewDocument(() => { window.__xss = 0; });
      await page.goto(`${BASE}/app${hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((r) => typeof ROL !== 'undefined' && ROL === r && Array.isArray(MODULOS), { timeout: 25000 }, rol);
      return p;
    }
    const pantalla = (p) => p.pedidas.filter((x) => x.includes('/asistente-restaurante/pantalla'));
    const completa = (p) => pantalla(p).filter((x) => x === `GET ${RUTA}`);
    const pestanaVisible = (page) => page.$eval('#pest-asistente', (e) => e.style.display !== 'none');
    const vista = (page) => page.evaluate(() => ['ventas', 'asistente'].filter((v) => document.getElementById(`vista-${v}`).style.display === 'block'));
    // Entrar a Reportes como desde el menú, y esperar la respuesta de «¿se ve la pestaña?».
    async function reportes(p) {
      const estado = p.page.waitForResponse((r) => r.url().endsWith(`${RUTA}?solo=estado`), { timeout: 15000 }).catch(() => null);
      await p.page.evaluate(() => mostrarTab('ventas'));
      const r = await estado;
      await new Promise((x) => setTimeout(x, 300));
      return r;
    }
    async function abrirPestana(p) {
      await p.page.waitForFunction(() => document.getElementById('pest-asistente').style.display !== 'none', { timeout: 10000 });
      const datos = p.page.waitForResponse((r) => r.url().endsWith(RUTA) && r.request().method() === 'GET', { timeout: 15000 });
      await p.page.$eval('#pest-asistente', (e) => e.click());
      await datos;
      await p.page.waitForSelector('#reportes-asistente .asp-titulo', { timeout: 10000 });
    }
    const tarjetas = (page) => page.$$eval('#reportes-asistente article.asp-tarjeta', (els) => els.map((e) => ({
      id: e.dataset.aviso, clase: e.className, etiqueta: e.querySelector('.asp-etiqueta').textContent, encabezado: e.querySelector('.asp-que h3').textContent,
      cifra: e.querySelector('.asp-cifra b')?.textContent ?? null, sub: e.querySelector('.asp-cifra span')?.textContent ?? null,
      grafica: ['asp-serie', 'asp-aa', 'asp-caras'].find((c) => e.querySelector(`.${c}`)) || null,
      caras: [...e.querySelectorAll('.asp-caras span')].map((s) => s.textContent),
      hacer: e.querySelector('.asp-hacer').textContent, ver: e.querySelector('.asp-ver').textContent,
    })));
    const tarjeta = (id) => `#reportes-asistente article.asp-tarjeta[data-aviso="${id}"]`;
    const opiniones = async (id) => (await q('SELECT usuario_id::text AS u, opinion FROM asistente_restaurante_opiniones WHERE hallazgo_id = $1 ORDER BY usuario_id', [id])).rows;

    let ids = await sembrar();

    await t('B1. entrar a Reportes sigue abriendo Ventas; la pestaña aparece primero y todavía no se piden las recomendaciones', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        assert.strictEqual(await pestanaVisible(p.page), false, 'la pestaña se ve antes de preguntar');
        const r = await reportes(p);
        assert.ok(r && r.status() === 200, 'no preguntó si se ve la pestaña');
        await p.page.waitForFunction(() => document.getElementById('pest-asistente').style.display !== 'none', { timeout: 10000 });
        assert.deepStrictEqual(await vista(p.page), ['ventas'], 'Reportes ya no abre Ventas');
        const visibles = await p.page.$$eval('#pestanas-reportes .seccion-pestana', (els) => els.filter((e) => e.style.display !== 'none').map((e) => e.id));
        assert.strictEqual(visibles[0], 'pest-asistente', `la primera pestaña visible es ${visibles[0]}`);
        assert.ok(visibles.includes('pest-ventas'));
        assert.strictEqual(await p.page.$eval('#pestanas-reportes', (e) => e.hidden), false, 'la barra de Reportes no se ve');
        assert.deepStrictEqual(completa(p), [], 'pidió las recomendaciones sin abrir la pestaña');
        assert.deepStrictEqual(pantalla(p), [`GET ${RUTA}?solo=estado`]);
        assert.ok(!p.pedidas.some((x) => x.includes('/asistente-restaurante/avisos')), `la campanita pidió algo del asistente: ${p.pedidas}`);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B2. la pestaña: «Cómo va el día» y las tarjetas en su orden, con su cifra y su gráfica; lo de la base se pinta como texto', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await reportes(p);
        await abrirPestana(p);
        assert.deepStrictEqual(await vista(p.page), ['asistente']);
        assert.strictEqual(await p.page.evaluate(() => location.hash), '#reportes/asistente');
        const dia = await p.page.$eval('#reportes-asistente .asp-dia', (c) => ({
          rotulo: c.querySelector('.asp-rotulo').textContent,
          venta: c.querySelector('.asp-venta-num').textContent,
          pildora: c.querySelector('.asp-pildora')?.className, pildoraTxt: c.querySelector('.asp-pildora')?.textContent,
          antes: c.querySelector('.asp-antes').textContent,
          mini: [...c.querySelectorAll('.asp-mini > div')].map((d) => [...d.children].map((x) => x.textContent)),
          barras: c.querySelectorAll('.asp-graf-horas .asp-par').length,
          horas: [...c.querySelectorAll('.asp-etiquetas-horas span')].map((s) => s.textContent),
        }));
        assert.match(dia.rotulo, /^Cómo va el día · hasta las \d{2}:\d{2}$/);
        assert.strictEqual(dia.venta, '$500');
        assert.strictEqual(dia.pildora, 'asp-pildora sube');
        assert.strictEqual(dia.pildoraTxt, '100 %');
        assert.match(dia.antes, /^El \S+ pasado a esta hora: \$250$/);
        assert.deepStrictEqual(dia.mini, [['Tickets', '2', 'antes 2'], ['Ticket promedio', '$250', 'antes $125']]);
        assert.strictEqual(dia.barras, 3, 'la venta por hora va de las 10 a las 12');
        assert.deepStrictEqual(dia.horas, ['10', '11', '12']);

        const ts = await tarjetas(p.page);
        assert.deepStrictEqual(ts.map((x) => x.id), [ids.control, ids.venta1, ids.clientes], 'el de control no va primero (o salió lo no elegido / lo callado)');
        const [c, v, cl] = ts;
        assert.match(c.clase, /asp-g-control/); assert.strictEqual(c.etiqueta, 'Control');
        assert.strictEqual(c.encabezado, '3 ventas sin forma de pago');
        assert.strictEqual(c.cifra, '$600'); assert.strictEqual(c.sub, '3 ventas de la semana'); assert.strictEqual(c.grafica, null);
        assert.strictEqual(c.hacer, 'Captura la forma de pago de esas ventas para que el corte cuadre.');
        assert.match(v.clase, /asp-g-ventas/); assert.strictEqual(v.etiqueta, 'Ventas');
        assert.strictEqual(v.encabezado, `«${XSS}» vende menos`, 'el título corto no se ve tal cual');
        assert.strictEqual(v.cifra, '−30 %'); assert.strictEqual(v.sub, '−$4,200 en 4 semanas'); assert.strictEqual(v.grafica, 'asp-aa');
        assert.strictEqual(v.ver, 'Ver números');
        assert.match(cl.clase, /asp-g-clientes/); assert.strictEqual(cl.etiqueta, 'Clientes');
        assert.strictEqual(cl.cifra, '2'); assert.strictEqual(cl.sub, 'dejaban ~$900 al mes');
        assert.strictEqual(cl.grafica, 'asp-caras'); assert.deepStrictEqual(cl.caras, ['AL', 'BR']);
        assert.strictEqual(cl.hacer, 'Escríbeles para invitarlos de vuelta.', 'no usa la sugerencia de la IA');
        assert.strictEqual(cl.ver, 'Ver quiénes');
        const cab = await p.page.$eval('#reportes-asistente .asp', (r) => ({
          fecha: r.querySelector('.asp-fecha').textContent, chips: [...r.querySelectorAll('.asp-chip')].map((x) => x.textContent),
          titulo: r.querySelector('.asp-titulo h2').textContent, nota: r.querySelector('.asp-titulo .asp-nota').textContent,
          pie: r.querySelector('.asp-pie').textContent, todo: r.textContent,
        }));
        assert.match(cab.fecha, new RegExp(`^\\S+ ${Number(HOY.slice(8))} de \\S+$`));
        assert.strictEqual(cab.chips.length, 2);
        assert.match(cab.chips[0], /^Revisado hoy a las \d{2}:\d{2}$/);
        assert.strictEqual(cab.chips[1], 'Redactado con IA');
        assert.strictEqual(cab.titulo, 'Lo que vi para hoy');
        assert.strictEqual(cab.nota, '3 de 5 cosas revisadas · las de control van primero');
        assert.match(cab.pie, /^Solo consulta: el asistente nunca cambia nada\./);
        assert.ok(!/NO ELEGIDO|CALLADO/.test(cab.todo), 'salió lo no elegido o lo callado');
        assert.strictEqual(await p.page.$('#reportes-asistente img'), null, 'un texto de la base se volvió etiqueta');
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        assert.strictEqual(await p.page.$$eval('#asp-estilos', (e) => e.length), 1);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B3. «Ver números» abre y cierra el detalle: el texto largo, los números y la tabla formateados', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await reportes(p);
        await abrirPestana(p);
        const sel = tarjeta(ids.venta1);
        assert.strictEqual(await p.page.$eval(`${sel} .asp-ver`, (e) => e.getAttribute('aria-expanded')), 'false');
        assert.strictEqual(await p.page.$(`${sel} .asp-detalle`), null);
        await p.page.$eval(`${sel} .asp-ver`, (e) => e.click());
        await p.page.waitForSelector(`${sel} .asp-detalle`, { timeout: 5000 });
        assert.strictEqual(await p.page.$eval(`${sel} .asp-ver`, (e) => e.getAttribute('aria-expanded')), 'true');
        assert.strictEqual(await p.page.$eval(`${sel} .asp-ver`, (e) => e.getAttribute('aria-controls')), `asp-det-${ids.venta1}`);
        const d = await p.page.$eval(`${sel} .asp-detalle`, (e) => ({
          id: e.id,
          parrafos: [...e.querySelectorAll(':scope > p')].map((x) => x.textContent),
          numeros: [...e.querySelectorAll('.asp-numeros > div')].map((x) => [x.children[0].textContent, x.children[1].textContent]),
          cabeza: [...e.querySelectorAll('thead th')].map((x) => x.textContent),
          celdas: [...e.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
          callar: e.querySelector('.asp-callar')?.textContent,
        }));
        assert.strictEqual(d.id, `asp-det-${ids.venta1}`);
        assert.deepStrictEqual(d.numeros, [['Venta de las últimas 4 semanas', '$9,800'], ['Las 4 semanas antes', '$14,000']]);
        assert.deepStrictEqual(d.cabeza, ['Producto', 'Tickets', 'Venta']);
        assert.deepStrictEqual(d.celdas, [[XSS, '1,520', '$9,800'], ['Café', '300', '$1,200']]);
        assert.strictEqual(d.parrafos[0], `«${XSS}» vendió 30 % menos que las 4 semanas anteriores (−$4,200).`);
        assert.ok(d.parrafos.includes('Sin pedidos grandes.'));
        const [, mes] = [null, ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(REVISAR_EL.slice(5, 7)) - 1]];
        assert.ok(d.parrafos.includes(`Para revisar el ${Number(REVISAR_EL.slice(8))} ${mes}: Venta semanal del platillo (hoy: $2,450).`), d.parrafos.join(' | '));
        assert.strictEqual(d.callar, 'No avisar de esto');
        assert.strictEqual(await p.page.$('#reportes-asistente img'), null);
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        // El de la IA: su texto, su explicación (como texto) y la nota de que lo redactó.
        await p.page.$eval(`${tarjeta(ids.clientes)} .asp-ver`, (e) => e.click());
        await p.page.waitForSelector(`${tarjeta(ids.clientes)} .asp-detalle`, { timeout: 5000 });
        const ia = await p.page.$eval(`${tarjeta(ids.clientes)} .asp-detalle`, (e) => [...e.querySelectorAll(':scope > p')].map((x) => x.textContent));
        assert.deepStrictEqual(ia.slice(0, 2), ['Dos clientes de siempre no han regresado.', `Venían cada semana ${XSS}.`]);
        assert.strictEqual(ia[ia.length - 1], 'El texto lo redactó la IA; los números son los de Xabor.');
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        // Se cierra otra vez.
        await p.page.$eval(`${sel} .asp-ver`, (e) => e.click());
        await p.page.waitForFunction((s) => !document.querySelector(`${s} .asp-detalle`), { timeout: 5000 }, sel);
        assert.strictEqual(await p.page.$eval(`${sel} .asp-ver`, (e) => e.getAttribute('aria-expanded')), 'false');
        assert.ok(await p.page.$(`${tarjeta(ids.clientes)} .asp-detalle`), 'cerrar uno cerró el otro');
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B4. Útil / No útil: queda marcado, se guarda por persona y se ve al volver', async () => {
      const sel = tarjeta(ids.venta1);
      const p = await abrirPanel(SES.admin);
      try {
        await reportes(p);
        await abrirPestana(p);
        const presionados = () => p.page.$$eval(`${sel} .asp-op`, (els) => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('aria-pressed')]));
        assert.deepStrictEqual(await presionados(), [['Útil', 'false'], ['No útil', 'false']]);
        await p.page.$eval(`${sel} .asp-op[aria-label="Útil"]`, (e) => e.click());
        await p.page.waitForFunction((s) => document.querySelector(`${s} .asp-op[aria-label="Útil"]`)?.getAttribute('aria-pressed') === 'true', { timeout: 10000 }, sel);
        assert.deepStrictEqual(await opiniones(ids.venta1), [{ u: ADMIN, opinion: 'util' }]);
        await p.page.$eval(`${sel} .asp-op[aria-label="No útil"]`, (e) => e.click());
        await p.page.waitForFunction((s) => document.querySelector(`${s} .asp-op[aria-label="No útil"]`)?.getAttribute('aria-pressed') === 'true', { timeout: 10000 }, sel);
        assert.deepStrictEqual(await presionados(), [['Útil', 'false'], ['No útil', 'true']]);
        assert.deepStrictEqual(await opiniones(ids.venta1), [{ u: ADMIN, opinion: 'no_util' }], 'la última opinión no ganó');
        assert.ok(await p.page.$(sel), '«No útil» quitó la tarjeta');
        assert.strictEqual(await p.page.$(`${sel} .asp-error`), null);
        assert.ok(p.pedidas.includes(`POST ${RUTA}/avisos/${ids.venta1}/opinion`), p.pedidas.join(' | '));
      } finally { await p.cerrar(); }
      const p2 = await abrirPanel(SES.admin);
      try {
        await reportes(p2);
        await abrirPestana(p2);
        assert.strictEqual(await p2.page.$eval(`${sel} .asp-op[aria-label="No útil"]`, (e) => e.getAttribute('aria-pressed')), 'true', 'al volver no se ve lo que opinó');
        assert.strictEqual(await p2.page.$eval(`${tarjeta(ids.control)} .asp-op[aria-label="Útil"]`, (e) => e.getAttribute('aria-pressed')), 'false');
      } finally { await p2.cerrar(); }
    });

    await t('B5. si el servidor no guarda la opinión, la tarjeta lo dice y no queda marcada', async () => {
      const sel = tarjeta(ids.control);
      const p = await abrirPanel(SES.admin);
      try {
        await reportes(p);
        await abrirPestana(p);
        await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN2])); // ya no lo ve: el servidor rechaza
        await p.page.$eval(`${sel} .asp-op[aria-label="Útil"]`, (e) => e.click());
        await p.page.waitForSelector(`${sel} .asp-error[role="alert"]`, { timeout: 10000 });
        assert.match(await p.page.$eval(`${sel} .asp-error`, (e) => e.textContent), /^No se guardó: /);
        assert.strictEqual(await p.page.$eval(`${sel} .asp-op[aria-label="Útil"]`, (e) => e.getAttribute('aria-pressed')), 'false');
        assert.deepStrictEqual(await opiniones(ids.control), []);
      } finally { await p.cerrar(); await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN])); }
    });

    await t('B6. «No avisar de esto» cambia la tarjeta por «Listo…», calla el aviso en la sucursal y ya no vuelve', async () => {
      const sel = tarjeta(ids.control);
      const p = await abrirPanel(SES.admin);
      try {
        await reportes(p);
        await abrirPestana(p);
        await p.page.$eval(`${sel} .asp-ver`, (e) => e.click());
        await p.page.waitForSelector(`${sel} .asp-callar`, { timeout: 5000 });
        await p.page.$eval(`${sel} .asp-callar`, (e) => e.click());
        await p.page.waitForFunction((s) => !document.querySelector(s), { timeout: 10000 }, sel);
        const aviso = await p.page.$eval('#reportes-asistente [role="status"]', (e) => e.textContent);
        assert.match(aviso, /^Listo: no te volveré a avisar de esto\. Si cambias de idea, lo vuelves a encender en Configuración › Asistente\.$/);
        const { rows } = await q('SELECT firma, usuario_id::text AS u FROM asistente_restaurante_silenciados WHERE negocio_id = $1 ORDER BY firma', [A]);
        assert.deepStrictEqual(rows.map((r) => r.firma), ['cortesias_altas', 'ventas_sin_forma_pago']);
        assert.deepStrictEqual(await opiniones(ids.control), [{ u: ADMIN, opinion: 'no_avisar' }]);
        assert.strictEqual((await tarjetas(p.page)).length, 2, 'callar uno quitó otros');
      } finally { await p.cerrar(); }
      const p2 = await abrirPanel(SES.admin);
      try {
        await reportes(p2);
        await abrirPestana(p2);
        assert.deepStrictEqual((await tarjetas(p2.page)).map((x) => x.id), [ids.venta1, ids.clientes], 'lo callado volvió a salir');
        assert.strictEqual(await p2.page.$eval('#reportes-asistente .asp-titulo .asp-nota', (e) => e.textContent), '2 de 5 cosas revisadas · las de control van primero');
      } finally { await p2.cerrar(); }
    });

    await t('B7. si el servidor falla, la pestaña lo dice y «Reintentar» la carga', async () => {
      ids = await sembrar();
      let fallarAun = true;
      const p = await abrirPanel(SES.admin, { fallar: (u, r) => fallarAun && r.method() === 'GET' && u.pathname === RUTA && u.search === '' });
      try {
        await reportes(p);
        await p.page.waitForFunction(() => document.getElementById('pest-asistente').style.display !== 'none', { timeout: 10000 });
        await p.page.$eval('#pest-asistente', (e) => e.click());
        await p.page.waitForSelector('#reportes-asistente .asp-reintentar', { timeout: 10000 });
        assert.match(await p.page.$eval('#reportes-asistente .asp-vacio', (e) => e.textContent), /^Falla inventada de prueba/);
        assert.strictEqual(await p.page.$('#reportes-asistente .asp-tarjeta'), null);
        assert.strictEqual(await pestanaVisible(p.page), true, 'un error del servidor escondió la pestaña');
        fallarAun = false;
        await p.page.$eval('#reportes-asistente .asp-reintentar', (e) => e.click());
        await p.page.waitForSelector('#reportes-asistente .asp-tarjeta', { timeout: 10000 });
        assert.strictEqual((await tarjetas(p.page)).length, 3);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B8. la liga directa #reportes/asistente abre la pestaña (y a quien no la ve lo deja en Ventas)', async () => {
      const p = await abrirPanel(SES.admin, { hash: '#reportes/asistente' });
      try {
        await p.page.waitForSelector('#reportes-asistente .asp-tarjeta', { timeout: 20000 });
        assert.deepStrictEqual(await vista(p.page), ['asistente']);
        assert.strictEqual(await p.page.evaluate(() => location.hash), '#reportes/asistente');
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
      const o = await abrirPanel(SES.admin2, { hash: '#reportes/asistente' });
      try {
        await o.page.waitForFunction(() => document.getElementById('vista-ventas').style.display === 'block', { timeout: 20000 });
        await o.page.waitForResponse((r) => r.url().endsWith(`${RUTA}?solo=estado`), { timeout: 15000 }).catch(() => null);
        await new Promise((x) => setTimeout(x, 800));
        assert.deepStrictEqual(await vista(o.page), ['ventas']);
        assert.strictEqual(await pestanaVisible(o.page), false);
        assert.deepStrictEqual(completa(o), [], 'otro administrador pidió las recomendaciones');
      } finally { await o.cerrar(); }
    });

    await t('B9. en ensayo, otro administrador o el operador: sin pestaña y sin pedir las recomendaciones', async () => {
      await cfg(AV.CLAVE_MODO, 'ensayo');
      try {
        const p = await abrirPanel(SES.admin);
        try {
          const r = await reportes(p);
          assert.ok(r, 'en ensayo ni preguntó');
          assert.deepStrictEqual(await r.json(), { activo: false });
          assert.strictEqual(await pestanaVisible(p.page), false, 'en ensayo se ve la pestaña');
          assert.deepStrictEqual(completa(p), []);
          assert.deepStrictEqual(await vista(p.page), ['ventas']);
        } finally { await p.cerrar(); }
      } finally { await cfg(AV.CLAVE_MODO, 'visible'); }
      const o = await abrirPanel(SES.admin2);
      try {
        await reportes(o);
        assert.strictEqual(await pestanaVisible(o.page), false, 'otro administrador ve la pestaña');
        assert.deepStrictEqual(completa(o), []);
      } finally { await o.cerrar(); }
      const s = await abrirPanel(SES.staff, { rol: 'staff' });
      try {
        await s.page.evaluate(() => mostrarTab('ventas'));
        await new Promise((x) => setTimeout(x, 2000));
        assert.strictEqual(await pestanaVisible(s.page), false, 'el operador ve la pestaña');
        assert.deepStrictEqual(pantalla(s), [], 'el operador preguntó por el asistente');
      } finally { await s.cerrar(); }
    });

    await t('B10. la campanita encendida cuenta lo suyo y no pide nada del asistente', async () => {
      ids = await sembrar();
      await cfg(AP.BANDERA_AVISOS_PANEL, 'true');
      await AP.registrarAvisoPanel(A, 'fallas_bot', { datos: { errores: 3 } });
      const p = await abrirPanel(SES.admin);
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.textContent === '1', { timeout: 10000 });
        await reportes(p);
        await abrirPestana(p);
        assert.strictEqual(await p.page.$eval('#btn-avisos .av-contador', (e) => e.textContent), '1', 'abrir el asistente cambió la campanita');
        assert.ok(!p.pedidas.some((x) => x.includes('/asistente-restaurante/avisos') && !x.includes('/pantalla/')), p.pedidas.join(' | '));
      } finally { await p.cerrar(); await cfg(AP.BANDERA_AVISOS_PANEL, undefined); }
    });

    await t('B11. en el celular «Cómo va el día», las tarjetas y la tabla no se salen de la pantalla', async () => {
      const p = await abrirPanel(SES.admin, { ancho: 375, alto: 812 });
      try {
        await reportes(p);
        await abrirPestana(p);
        await p.page.$eval(`${tarjeta(ids.venta1)} .asp-ver`, (e) => e.click());
        await p.page.waitForSelector(`${tarjeta(ids.venta1)} .asp-detalle`, { timeout: 5000 });
        const medidas = await p.page.$$eval('#reportes-asistente .asp-dia, #reportes-asistente .asp-tarjeta, #reportes-asistente .asp-op, #reportes-asistente .asp-ver',
          (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { c: e.className, izq: Math.round(r.left), der: Math.round(r.right), alto: Math.round(r.height) }; }));
        for (const m of medidas) assert.ok(m.izq >= 0 && m.der <= 375, `se sale: ${JSON.stringify(m)}`);
        for (const m of medidas.filter((x) => /asp-op|asp-ver/.test(x.c))) assert.ok(m.alto >= 44, `botón chico para el dedo: ${JSON.stringify(m)}`);
        const ancho = await p.page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(ancho <= 376, `la página se desborda: ${ancho}px`);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });
  }
} finally {
  if (navegador) await navegador.close().catch(() => {});
  if (srv) { try { srv.detener(); } catch { /* ya terminó */ } }
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} OK, ${fallidas} FALLO`);
if (fallos.length) console.log(fallos.map((f) => `  - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
