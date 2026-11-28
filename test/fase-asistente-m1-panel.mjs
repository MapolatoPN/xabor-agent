// ASISTENTE DEL RESTAURANTE, Mejora 1: el botón de cada tarjeta, en un
// navegador real (puppeteer) contra el servidor de prueba y una Graph API
// SIMULADA en 127.0.0.1 (para las plantillas de Campañas).
//
// Negocio, usuarios, clientes, menú y avisos INVENTADOS, creados aquí y
// borrados al final. Cubre:
//   A. los archivos: las huellas ?v= de los tres archivos que cambian, que la
//      pestaña no arma HTML con texto y que no llama a Campañas, Tienda ni Menú;
//   B. en el navegador: cada tarjeta con su botón (y la de «cambiaron de
//      costumbre» sin él); «Preparar campaña» abre Campañas con el nombre, sus
//      clientes y el texto sugerido, y NO manda nada; «Abrir en Menú» abre el
//      platillo; Historial y Correcciones en las fechas del aviso; Reportes ›
//      Productos en su vista, fechas y categoría; «Crear promoción» con los
//      días, las categorías o el horario marcados y SIN guardar; cada botón
//      queda anotado; sin acceso a la pantalla, lo dice y no se mueve;
//      apagada la bandera, no hay botones; y en el celular caben y se tocan.
//
// La sucursal vive en una zona donde AHORA no son de las 5 a las 13: el
// servidor de prueba no le corre la revisión de la mañana (de 6 a 12).
import assert from 'assert';
import http from 'http';
import { readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

// ── Graph API simulada: solo plantillas (antes de arrancar el servidor) ─────
const META = { envios: 0 };
const PLANTILLA = {
  id: '111', name: 'regresa_m1', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, {{2}}', example: { body_text: [['Ana', 'te esperamos']] } },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pedir en línea', url: 'https://tienda.example/pedir' },
      { type: 'QUICK_REPLY', text: 'Detener promociones' }] },
  ],
};
// Una con un solo texto libre ({{1}}, el nombre): ahí la sugerencia no cabe.
const PLANTILLA_UNA = {
  id: '112', name: 'saludo_m1', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, te esperamos.', example: { body_text: [['Ana']] } },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Detener promociones' }] },
  ],
};
const servidorMeta = http.createServer(async (req, res) => {
  for await (const _ of req) { /* cuerpo */ }
  const json = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  const m = new URL(req.url, 'http://x').pathname.match(/^\/v\d+\.\d+\/([^/]+)(\/[a-z_]+)?$/);
  if (!m) return json(404, { error: { code: 100 } });
  if (m[2] === '/message_templates') return json(200, { data: [PLANTILLA, PLANTILLA_UNA] });
  if (m[2] === '/messages') { META.envios++; return json(200, { messages: [{ id: `wamid.prueba.${randomUUID()}` }] }); }
  if (!m[2]) return json(200, { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' });
  return json(404, {});
});
await new Promise((ok) => servidorMeta.listen(0, '127.0.0.1', ok));
process.env.META_GRAPH_BASE_URL = `http://127.0.0.1:${servidorMeta.address().port}`;

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const R = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const AC = await import('../src/asistenteRestaurante/acciones.js');
const { BANDERA_REPORTES_PRODUCTOS } = await import('../src/services/reporteProductos.js');

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

await t('A1. las huellas ?v= de los tres archivos; la pestaña no arma HTML con texto ni llama a Campañas, Tienda o Menú', () => {
  for (const f of ['asistente-pantalla.js', 'campanas-wa.js', 'reportes-productos.js']) {
    assert.ok(HTML.includes(`<script src="/${f}?v=${huella(f)}"></script>`), `la huella correcta de ${f} es ${huella(f)}`);
  }
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(JS), 'asistente-pantalla.js arma HTML con texto');
  assert.ok(!/\/api\/(admin\/)?(campanas-wa|tienda|menu|historial|ajustes-cierre|reportes)/.test(JS), 'la pestaña llama directo a otra pantalla');
  // Solo habla con su propia ruta: la lectura de «¿se ve la pestaña?» y sus dos
  // escrituras, la opinión y la nota del botón.
  const llamadas = [...JS.matchAll(/apiFetch\(`\$\{RUTA\}([^`]*)`/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(llamadas)].sort(),
    ['/avisos/${encodeURIComponent(t.id)}/accion', '/avisos/${encodeURIComponent(t.id)}/opinion', '?solo=estado'].sort());
  assert.strictEqual((JS.match(/method:\s*'POST'/g) || []).length, 2, 'la pestaña escribe en más lugares que la opinión y el botón');
});

// ═══ B. En un navegador real ══════════════════════════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h < 5 || (h >= 14 && h <= 21); }));
if (!TZ) { console.error('ninguna zona fuera de las 5 a las 13'); process.exit(2); }
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const SEMANA = { desde: R.sumarDias(AYER, -6), hasta: AYER };
const P4 = { desde: R.sumarDias(AYER, -27), hasta: AYER };

const TAG = 'AN' + (Date.now() % 1e8).toString(36).toUpperCase();
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
const ACC = 'asistente_restaurante_acciones';
async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-m1p-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del(`DELETE FROM ${ACC} WHERE negocio_id = $1`);
    await del('DELETE FROM campana_envios WHERE campana_id IN (SELECT id FROM campanas WHERE negocio_id = $1)');
    await del('DELETE FROM campanas WHERE negocio_id = $1');
    await del('DELETE FROM clientes_negocio WHERE negocio_id = $1');
    await del('DELETE FROM integraciones_canal WHERE negocio_id = $1');
    await del('DELETE FROM tienda_promociones WHERE negocio_id = $1');
    await del('DELETE FROM menu_productos WHERE negocio_id = $1');
    await del('DELETE FROM menu_categorias WHERE negocio_id = $1');
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}

let srv = null, navegador = null;
try {
  // La 166 (la plantilla de pruebas llega hasta la 165).
  if (!(await uno('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.${ACC}`])).hay) {
    await q(readFileSync(raiz('migrations/166_asistente_acciones.sql'), 'utf8'));
  }
  await limpiar();
  const A = (await uno('INSERT INTO negocios (nombre, slug, bot_whatsapp_activo) VALUES ($1, $2, true) RETURNING id', [`${TAG} Sucursal`, `${TAG.toLowerCase()}-asis-m1p-a`])).id;
  for (const m of ['pos', 'caja', 'whatsapp', 'menu']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [A, m]);
  const marca = randomUUID();
  await q(`INSERT INTO integraciones_canal(negocio_id,canal,proveedor,identificador,estado,activo,waba_id)
    VALUES($1,'whatsapp','meta',$2,'activo',true,$3)`, [A, `pn-${marca}`, `waba-${marca}`]);
  await actualizarConfiguracion({ timezone: TZ, int_wa_phone_id: `pn-${marca}`, int_wa_token: `token-${marca}`, whatsapp_trazabilidad_formularios_v1: 'true' }, A);
  async function usuario(nombre, rol) {
    const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
      [A, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
    await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, A, rol]);
    return u.id;
  }
  const ADMIN = await usuario(`${TAG} Dueño`, 'admin');
  async function cfg(clave, valor) {
    await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [A, clave]);
    if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [A, clave, valor]);
  }
  await cfg(AV.BANDERA, 'true');
  await cfg(AV.CLAVE_MODO, 'visible');
  await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));
  await cfg(AC.BANDERA_ACCIONES, 'true');
  await cfg(BANDERA_REPORTES_PRODUCTOS, 'true');

  // El menú: dos categorías y un platillo.
  const cat1 = (await uno('INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,0) RETURNING id', [A, `${TAG} Desayunos`])).id;
  const cat2 = (await uno('INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,1) RETURNING id', [A, `${TAG} Bebidas`])).id;
  const NOMBRE_PLATILLO = `${TAG} Chilaquiles`;
  const prod = (await uno(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible,agotado,orden)
    VALUES ($1,$2,$3,105,TRUE,FALSE,0) RETURNING id`, [A, cat1, NOMBRE_PLATILLO])).id;
  // Dos clientes en la Lista (los del aviso).
  // Teléfonos inventados (00 + 8 cifras), como en las suites de Campañas.
  const tel = () => `00${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
  const c1 = (await uno('INSERT INTO clientes_negocio(negocio_id,telefono,nombre) VALUES($1,$2,$3) RETURNING id::text AS id', [A, tel(), 'Ana Prueba'])).id;
  const c2 = (await uno('INSERT INTO clientes_negocio(negocio_id,telefono,nombre) VALUES($1,$2,$3) RETURNING id::text AS id', [A, tel(), 'Beto Prueba'])).id;

  // La revisión de hoy, con un aviso de cada destino.
  const corrida = (await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos, terminada_en)
                              VALUES ($1, $2, 'visible', 'lista', 9, 9, now()) RETURNING id`, [A, HOY])).id;
  const num = { detalle: { numeros: [{ etiqueta: 'Esta semana', valor: 900, formato: 'dinero' }, { etiqueta: 'Lo normal', valor: 300, formato: 'dinero' }] } };
  const H = {};
  for (const [clave, tipo, firma, impacto, accion] of [
    ['dejaron', 'clientes_dejaron', 'clientes_dejaron', 900, { clientes: [c1, c2] }],
    ['sinPago', 'ventas_sin_forma_pago', 'ventas_sin_forma_pago', 800, SEMANA],
    ['descuentos', 'descuentos_altos', 'descuentos_altos', 700, SEMANA],
    ['producto', 'producto_baja', `producto_baja:p:${prod}`, 600, { producto: prod }],
    ['categoria', 'categoria_baja', `categoria_baja:c:${cat1}`, 500, { categoria: `c:${cat1}`, ...P4 }],
    ['dia', 'dia_flojo', 'dia_flojo:2', 400, { dia: 2 }],
    ['combo', 'combinaciones', `combinaciones:c:${cat1}+c:${cat2}`, 300, { categorias: [`c:${cat1}`, `c:${cat2}`] }],
    ['franja', 'franja_floja', 'franja_floja:13-15', 200, { franja: '13-15' }],
    ['cambiaron', 'clientes_cambiaron', 'clientes_cambiaron', 100, null],
  ]) {
    H[clave] = (await uno(
      `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, 'elegido', true) RETURNING id::text AS id`,
      [A, corrida, tipo, firma, impacto, `Prueba ${tipo}.`, JSON.stringify({ ...num, sugerencia: `Qué hacer con ${tipo}.`, ...(accion ? { accion } : {}) })])).id;
  }

  const { crearTokenSesion } = await import('../src/services/session.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const SES = encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN, negocioId: A, rol: 'admin' }));

  let puppeteer = null;
  try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
  if (!puppeteer) {
    await t('B. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_M1_PANEL || '4752' }, { timeoutMs: 40000, omitir: ['XABOR_ASISTENTE_RESUMEN_WA'] });
    const BASE = srv.base;
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    async function abrirPanel({ ancho = 1280, alto = 800 } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: SES, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const p = { page, pedidas: [], errores: [], cerrar: () => ctxN.close() };
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) p.pedidas.push(`${r.method()} ${u.pathname}${u.search}`); });
      page.on('pageerror', (e) => p.errores.push(e.message));
      page.on('dialog', (d) => d.dismiss().catch(() => {}));
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof ROL !== 'undefined' && ROL === 'admin' && Array.isArray(MODULOS), { timeout: 25000 });
      return p;
    }
    async function asistente(p) {
      await p.page.evaluate(() => mostrarTab('ventas'));
      await p.page.waitForFunction(() => document.getElementById('pest-asistente').style.display !== 'none', { timeout: 15000 });
      // La primera vez la pestaña pide sus datos; las siguientes puede usar los que ya tiene.
      const datos = p.page.waitForResponse((r) => r.url().endsWith(RUTA) && r.request().method() === 'GET', { timeout: 15000 }).catch(() => null);
      await p.page.$eval('#pest-asistente', (e) => e.click());
      await p.page.waitForFunction(() => document.getElementById('vista-asistente')?.style.display === 'block', { timeout: 10000 });
      await Promise.race([datos, new Promise((x) => setTimeout(x, 2000))]);
      await p.page.waitForSelector('#reportes-asistente article.asp-tarjeta', { timeout: 15000 });
    }
    const tarjeta = (id) => `#reportes-asistente article.asp-tarjeta[data-aviso="${id}"]`;
    const pulsar = async (p, id) => {
      await p.page.waitForSelector(`${tarjeta(id)} .asp-ir`, { timeout: 10000 });
      await p.page.$eval(`${tarjeta(id)} .asp-ir`, (b) => b.click());
    };
    const vistaVisible = (page, v) => page.evaluate((x) => document.getElementById(`vista-${x}`)?.style.display === 'block', v);
    const anotadas = async () => (await q(`SELECT accion, COUNT(*)::int AS n FROM ${ACC} WHERE negocio_id = $1 AND paso = 'abrio' GROUP BY 1 ORDER BY 1`, [A])).rows;
    const escrituras = (p) => p.pedidas.filter((x) => !/^GET /.test(x) && !x.includes('/asistente-restaurante/pantalla/avisos/')
      && !x.startsWith('POST /api/admin/campanas-wa/vista-previa') && !/\/api\/(push|auth|presencia|sesion|telemetria)/.test(x));

    const p = await abrirPanel();
    try {
      await t('B1. cada tarjeta con su botón, con el nombre de su pantalla; «cambiaron de costumbre» no tiene', async () => {
        await asistente(p);
        const botones = await p.page.$$eval('#reportes-asistente article.asp-tarjeta', (els) => Object.fromEntries(els.map((e) => [e.dataset.aviso, e.querySelector('.asp-ir')?.textContent.trim() || null])));
        assert.deepStrictEqual(
          [H.dejaron, H.sinPago, H.descuentos, H.producto, H.categoria, H.dia, H.combo, H.franja, H.cambiaron].map((id) => botones[id]),
          ['Preparar campaña', 'Ver en Historial', 'Ver correcciones', 'Abrir en Menú', 'Ver en Reportes', 'Crear promoción', 'Crear promoción', 'Crear promoción', null]);
        assert.deepStrictEqual(p.errores, []);
      });

      await t('B2. «Preparar campaña» abre Campañas con el nombre, SUS clientes y el texto sugerido; revisar dice a cuántos; nada se manda', async () => {
        await pulsar(p, H.dejaron);
        await p.page.waitForFunction(() => document.getElementById('cwa-modal')?.style.display === 'flex'
          && document.getElementById('cwa-segmento')?.value === 'asistente', { timeout: 15000 });
        assert.ok(await vistaVisible(p.page, 'campanas'), 'no se abrió Campañas');
        const f = await p.page.evaluate(() => ({ nombre: document.getElementById('cwa-nombre').value,
          segmento: document.getElementById('cwa-segmento').selectedOptions[0].textContent,
          opciones: [...document.getElementById('cwa-segmento').options].map((o) => o.value) }));
        assert.strictEqual(f.nombre, 'Clientes frecuentes que no han vuelto');
        assert.strictEqual(f.segmento, 'Los 2 clientes del aviso del asistente');
        assert.ok(f.opciones.includes('todos') && f.opciones[0] === 'asistente', 'faltan los segmentos de siempre');
        // Al elegir la plantilla, el texto sugerido va en {{2}} y {{1}} sigue siendo el nombre.
        await p.page.select('#cwa-plantilla', '0');
        await p.page.waitForSelector('[data-ranura="cuerpo:2"] [data-texto]', { timeout: 5000 });
        const v = await p.page.evaluate(() => ({
          f1: document.querySelector('[data-ranura="cuerpo:1"] [data-fuente]').value,
          f2: document.querySelector('[data-ranura="cuerpo:2"] [data-fuente]').value,
          t2: document.querySelector('[data-ranura="cuerpo:2"] [data-texto]').value,
          visible: document.querySelector('[data-ranura="cuerpo:2"] [data-texto]').style.display !== 'none',
          mandar: document.getElementById('cwa-mandar').disabled,
        }));
        assert.deepStrictEqual(v, { f1: 'nombre', f2: 'fijo', t2: AC.MENSAJES_SUGERIDOS.clientes_dejaron, visible: true, mandar: true });
        const previa = p.page.waitForResponse((r) => r.url().endsWith('/api/admin/campanas-wa/vista-previa'), { timeout: 15000 });
        await p.page.$eval('[data-acc="revisar"]', (b) => b.click());
        const r = await previa;
        assert.strictEqual(r.status(), 200, await r.text());
        await p.page.waitForFunction(() => /Le llegaría a 2 clientes/.test(document.getElementById('cwa-resumen').textContent), { timeout: 10000 });
        const cuerpo = JSON.parse(r.request().postData());
        assert.strictEqual(cuerpo.segmento, 'asistente');
        assert.strictEqual(cuerpo.avisoAsistente, H.dejaron);
        assert.ok(!JSON.stringify(cuerpo).includes(c1), 'el navegador mandó los id de los clientes');
        assert.ok(!p.pedidas.some((x) => x === 'POST /api/admin/campanas-wa'), 'se creó la campaña sin pulsar «Mandar»');
        assert.strictEqual(META.envios, 0, 'salió un mensaje');
        assert.strictEqual((await uno('SELECT COUNT(*)::int AS n FROM campanas WHERE negocio_id = $1', [A])).n, 0);
        // Con una plantilla de un solo texto libre (el nombre) no se pisa nada: la sugerencia se enseña aparte.
        await p.page.select('#cwa-plantilla', '1');
        await p.page.waitForSelector('#cwa-sugerencia', { timeout: 5000 });
        const u = await p.page.evaluate(() => ({
          ranuras: [...document.querySelectorAll('#cwa-variables [data-ranura]')].map((x) => x.dataset.ranura),
          f1: document.querySelector('[data-ranura="cuerpo:1"] [data-fuente]').value,
          t1: document.querySelector('[data-ranura="cuerpo:1"] [data-texto]').value,
          nota: document.getElementById('cwa-sugerencia').textContent,
        }));
        assert.deepStrictEqual([u.ranuras, u.f1, u.t1], [['cuerpo:1'], 'nombre', '']);
        assert.ok(u.nota.includes(AC.MENSAJES_SUGERIDOS.clientes_dejaron), u.nota);
        await p.page.$eval('[data-acc="cerrar"]', (b) => b.click());
      });

      await t('B3. «Abrir en Menú» abre el platillo del aviso para editarlo (sin guardar nada)', async () => {
        await asistente(p);
        await pulsar(p, H.producto);
        await p.page.waitForSelector('#modal-producto #mp-nombre', { timeout: 15000 });
        assert.ok(await vistaVisible(p.page, 'menu'), 'no se abrió Menú');
        assert.strictEqual(await p.page.$eval('#mp-nombre', (e) => e.value), NOMBRE_PLATILLO);
        await p.page.evaluate(() => document.getElementById('modal-producto')?.remove());
      });

      await t('B4. «Ver en Historial» abre Historial en la semana del aviso', async () => {
        await asistente(p);
        const pide = p.page.waitForRequest((r) => r.url().includes('/api/historial?'), { timeout: 15000 });
        await pulsar(p, H.sinPago);
        const r = await pide;
        assert.strictEqual(new URL(r.url()).search, `?desde=${SEMANA.desde}&hasta=${SEMANA.hasta}`);
        assert.ok(await vistaVisible(p.page, 'historial'), 'no se abrió Historial');
        assert.deepStrictEqual(await p.page.evaluate(() => [HIST.periodo, HIST.desde, HIST.hasta, HIST.filtro,
          document.getElementById('hist-desde').value, document.getElementById('hist-hasta').value]),
        ['rango', SEMANA.desde, SEMANA.hasta, 'todas', SEMANA.desde, SEMANA.hasta]);
      });

      await t('B5. «Ver correcciones» abre Correcciones en la semana del último día del aviso', async () => {
        await asistente(p);
        const pide = p.page.waitForRequest((r) => r.url().includes('/api/admin/ajustes-cierre/semana'), { timeout: 15000 });
        await pulsar(p, H.descuentos);
        const r = await pide;
        assert.strictEqual(new URL(r.url()).searchParams.get('fecha'), SEMANA.hasta);
        assert.ok(await vistaVisible(p.page, 'ajustes'), 'no se abrió Correcciones');
      });

      await t('B6. «Ver en Reportes» abre Productos en Categorías, en las 4 semanas del aviso y con su categoría', async () => {
        await asistente(p);
        // La pestaña Productos aparece cuando el servidor confirma su bandera.
        await p.page.waitForFunction(() => document.getElementById('pest-productos')?.style.display !== 'none', { timeout: 10000 });
        const pide = p.page.waitForRequest((r) => /\/api\/reportes\/productos\?/.test(r.url()), { timeout: 15000 });
        await pulsar(p, H.categoria);
        const u = new URL((await pide).url());
        assert.deepStrictEqual([u.searchParams.get('desde'), u.searchParams.get('hasta'), u.searchParams.get('periodo'), u.searchParams.get('canal')],
          [P4.desde, P4.hasta, null, null]);
        assert.ok(await vistaVisible(p.page, 'productos'), 'no se abrió Productos');
        await p.page.waitForSelector('#reportes-productos [data-vista="categorias"].activa', { timeout: 10000 });
        assert.deepStrictEqual(await p.page.evaluate(() => [document.getElementById('fecha-desde').value, document.getElementById('fecha-hasta').value,
          document.querySelectorAll('.btn-periodo.activo').length]), [P4.desde, P4.hasta, 0]);
      });

      // `listo`: en qué se nota que ya marcó lo del aviso (se marca después de pintar el formulario).
      const promocion = async (id, listo) => {
        await asistente(p);
        // El formulario de una visita anterior sigue en la página hasta que Promociones se vuelve a pintar.
        await p.page.evaluate(() => { const v = document.getElementById('tnd-form-promo'); if (v) v.dataset.viejo = '1'; });
        await pulsar(p, id);
        await p.page.waitForFunction(() => document.querySelector('#tnd-form-promo:not([data-viejo]) #pr-participa'), { timeout: 20000 });
        await p.page.waitForFunction(listo, { timeout: 5000 }).catch(() => {});
        await new Promise((x) => setTimeout(x, 200));
        return p.page.evaluate(() => ({
          dias: [...document.querySelectorAll('#tnd-form-promo .pr-dia:checked')].map((e) => e.value),
          participa: document.getElementById('pr-participa').value,
          cats: [...document.querySelectorAll('#tnd-form-promo .pr-cat:checked')].map((e) => Number(e.value)),
          hini: document.getElementById('pr-hini').value, hfin: document.getElementById('pr-hfin').value,
        }));
      };
      await t('B7. «Crear promoción» abre una promoción nueva con el día, las categorías o el horario del aviso, y no la guarda', async () => {
        assert.deepStrictEqual(await promocion(H.dia, () => document.querySelectorAll('#tnd-form-promo .pr-dia:checked').length > 0),
          { dias: ['2'], participa: 'todo', cats: [], hini: '', hfin: '' });
        assert.ok(await vistaVisible(p.page, 'tienda'), 'no se abrió Promociones');
        assert.deepStrictEqual(await promocion(H.combo, () => document.getElementById('pr-participa')?.value === 'categorias'),
          { dias: [], participa: 'categorias', cats: [cat1, cat2].sort((x, y) => x - y), hini: '', hfin: '' });
        assert.deepStrictEqual(await promocion(H.franja, () => !!document.getElementById('pr-hini')?.value),
          { dias: [], participa: 'todo', cats: [], hini: '13:00', hfin: '15:00' });
        assert.strictEqual((await uno('SELECT COUNT(*)::int AS n FROM tienda_promociones WHERE negocio_id = $1', [A]).catch(() => ({ n: 0 }))).n, 0);
      });

      await t('B8. cada botón quedó anotado una vez, y en todo el recorrido no se guardó ni mandó nada', async () => {
        assert.deepStrictEqual(await anotadas(), [
          { accion: 'campana_clientes', n: 1 }, { accion: 'correcciones', n: 1 }, { accion: 'historial', n: 1 },
          { accion: 'menu_producto', n: 1 }, { accion: 'promocion', n: 3 }, { accion: 'reporte_categoria', n: 1 },
        ]);
        assert.deepStrictEqual(escrituras(p), [], 'el recorrido escribió algo');
        assert.strictEqual(META.envios, 0);
        assert.deepStrictEqual(p.errores, []);
      });

      await t('B9. sin acceso a la pantalla lo dice en la tarjeta y no se mueve de la pestaña', async () => {
        await asistente(p);
        await p.page.evaluate(() => { document.getElementById('pest-campanas').style.display = 'none'; });
        await pulsar(p, H.dejaron);
        await p.page.waitForSelector(`${tarjeta(H.dejaron)} .asp-error`, { timeout: 5000 });
        assert.match(await p.page.$eval(`${tarjeta(H.dejaron)} .asp-error`, (e) => e.textContent), /No tienes acceso a Campañas/);
        assert.ok(await vistaVisible(p.page, 'asistente'), 'se salió de la pestaña');
        assert.ok(!(await anotadas()).some((x) => x.accion === 'campana_clientes' && x.n > 1), 'se anotó un botón que no abrió nada');
      });
    } finally { await p.cerrar(); }

    await t('B10. en el celular los botones caben y se tocan (44 px), sin salirse de la pantalla', async () => {
      const m = await abrirPanel({ ancho: 375, alto: 812 });
      try {
        await asistente(m);
        const r = await m.page.evaluate(() => ({
          altos: [...document.querySelectorAll('#reportes-asistente .asp-ir')].map((b) => Math.round(b.getBoundingClientRect().height)),
          ancho: document.documentElement.scrollWidth, ventana: window.innerWidth,
          fuera: [...document.querySelectorAll('#reportes-asistente .asp-ir')].filter((b) => b.getBoundingClientRect().right > window.innerWidth + 1).length,
        }));
        assert.strictEqual(r.altos.length, 8);
        assert.ok(r.altos.every((h) => h >= 44), `botones de ${r.altos}`);
        assert.strictEqual(r.fuera, 0, 'un botón se sale de la pantalla');
        assert.ok(r.ancho <= r.ventana, `la página se desliza de lado (${r.ancho} > ${r.ventana})`);
      } finally { await m.cerrar(); }
    });

    await t('B11. apagada la bandera de la sucursal, las tarjetas no tienen botón', async () => {
      await cfg(AC.BANDERA_ACCIONES, undefined);
      const s = await abrirPanel();
      try {
        await asistente(s);
        assert.ok((await s.page.$$('#reportes-asistente article.asp-tarjeta')).length >= 9);
        assert.strictEqual((await s.page.$$('#reportes-asistente .asp-ir')).length, 0);
      } finally { await s.cerrar(); await cfg(AC.BANDERA_ACCIONES, 'true'); }
    });
  }
} finally {
  try { await navegador?.close(); } catch { /* ya cerrado */ }
  try { srv?.detener(); } catch { /* ya terminó */ }
  await limpiar().catch((e) => console.error('limpieza:', e.message));
  servidorMeta.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) console.log(fallos.map((f) => ` - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
