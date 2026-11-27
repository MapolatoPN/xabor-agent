// ASISTENTE DEL RESTAURANTE, Fase 2: su tarjeta en Configuración, en un
// navegador real (puppeteer) contra el servidor local de prueba.
//
// Negocio, usuarios y avisos INVENTADOS. Cubre: la huella ?v= y los enganches
// en index.html; el formato de los números; quien recibe los avisos ve la
// tarjeta (con su estado) y la sección completa; el texto de la base se pinta
// como texto; guardar se queda al recargar; el error del servidor se muestra y
// no cambia nada; «Volver a avisar»; «Mostrar los avisos» pide confirmación;
// otro administrador no ve la tarjeta y el operador ni pregunta; con el
// asistente apagado no aparece; y en el celular no se sale de la pantalla.
import assert from 'assert';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool } = await import('../src/services/database.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const C = await import('../src/asistenteRestaurante/configuracion.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ A. Los archivos ═══════════════════════════════════════════════════════
const HTML = readFileSync(raiz('panel/index.html'), 'utf8');
const JS = readFileSync(raiz('panel/asistente-config.js'), 'utf8');
const huella = (f) => createHash('sha256').update(readFileSync(raiz(`panel/${f}`))).digest('hex').slice(0, 8);

await t('A1. huella ?v= correcta, después de los avisos del asistente, y los enganches de Configuración', () => {
  const s = `<script src="/asistente-config.js?v=${huella('asistente-config.js')}"></script>`;
  assert.ok(HTML.includes(s), `la huella correcta de asistente-config.js es ${huella('asistente-config.js')}`);
  assert.strictEqual(HTML.split('/asistente-config.js?v=').length - 1, 1, 'el archivo se carga dos veces');
  assert.ok(HTML.indexOf('/asistente-avisos.js?v=') < HTML.indexOf(s));
  assert.match(HTML, /<button class="cfg-card" id="cfg-card-asistente" style="display:none" onclick="cfgIr\('asistente'\)">/, 'la tarjeta debe nacer oculta');
  assert.match(HTML, /<div class="cfg-sec" id="cfg-sec-asistente">[\s\S]{0,400}<div id="asistente-config"><\/div>/);
  assert.ok(HTML.includes(`if (sec === 'asistente' && window.XaborAsistenteConfig) window.XaborAsistenteConfig.abrir(document.getElementById('asistente-config'));`));
  const portada = HTML.slice(HTML.indexOf('async function cargarConfigPortada()'));
  const iBasico = portada.indexOf('if (typeof ES_BASICO !== \'undefined\' && ES_BASICO) return;');
  const iTarjeta = portada.indexOf('window.XaborAsistenteConfig.revisarTarjeta()');
  assert.ok(iBasico > 0 && iTarjeta > iBasico, 'la tarjeta se revisa antes de cortar el plan Básico');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(JS), 'el módulo arma HTML con texto');
  assert.ok(JS.includes("if (rol !== 'admin' || basico || !modulos.includes('pos')) { tarjeta.style.display = 'none'; return; }"),
    'la tarjeta pregunta al servidor sin ser administrador con POS');
});

await t('A2. los números de la tarjeta se escriben como los lee el dueño', () => {
  const ctx = {}; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(JS, ctx);
  const f = ctx.XaborAsistenteConfig.formato;
  assert.strictEqual(f(1000, 'pesos'), '$1,000');
  assert.strictEqual(f(15, '%'), '15 %');
  assert.strictEqual(f(3, 'avisos'), '3 avisos');
  assert.strictEqual(f(21, 'días'), '21 días');
  assert.strictEqual(f('x', 'pesos'), '—');
});

// ═══ B. En un navegador real ══════════════════════════════════════════════
const ZONAS = ['America/Matamoros', 'Asia/Tokyo', 'Europe/Madrid', 'America/Los_Angeles', 'Australia/Sydney'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h < 5 || h >= 13; }));

const TAG = 'AQ' + (Date.now() % 1e8).toString(36).toUpperCase();
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f2p-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
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
await limpiar();
const A = (await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [`${TAG} Sucursal`, `${TAG.toLowerCase()}-asis-f2p-a`])).id;
// Con 'menu': el panel pide /api/menu al arrancar y, sin el módulo, levanta una ventana
// de aviso que no es de esta tarjeta (la prueba exige que no haya ninguna).
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
const claves = async () => Object.fromEntries((await q(
  `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave LIKE 'asistente_restaurante_%'`, [A])).rows.map((r) => [r.clave, r.valor]));
await cfg('timezone', TZ);

const XSS = '<img src=x onerror="window.__xss=1">';
const FIRMA = 'producto_baja:molletes';
async function callar() {
  await q('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A]);
  await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [A]);
  const c = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado) VALUES ($1, '2000-01-03', 'ensayo', 'lista') RETURNING id`, [A]);
  await q(`INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, elegido, motivo)
           VALUES ($1, $2, 'producto_baja', $3, 900, $4, true, 'elegido')`, [A, c.id, FIRMA, `«${XSS}» vendió 20 % menos (−$900).`]);
  await q('INSERT INTO asistente_restaurante_silenciados (negocio_id, firma, usuario_id) VALUES ($1, $2, $3)', [A, FIRMA, ADMIN]);
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
    srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_CFG_PANEL || '4798' }, { timeoutMs: 40000 });
    const BASE = srv.base;
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    async function abrirPanel(sesion, { ancho = 1280, alto = 800, rol = 'admin' } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: sesion, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const p = { page, pedidas: [], errores: [], dialogos: [], responder: 'dismiss', cerrar: () => ctxN.close() };
      page.on('request', (r) => { if (r.url().includes('/api/admin/asistente-restaurante/configuracion')) p.pedidas.push(`${r.method()} ${r.url()}`); });
      page.on('pageerror', (e) => p.errores.push(e.message));
      page.on('response', (r) => { if (r.status() === 403 && process.env.DEPURAR_403) console.log('403', r.request().method(), r.url()); });
      page.on('dialog', (d) => { p.dialogos.push(d.message()); (p.responder === 'accept' ? d.accept() : d.dismiss()).catch(() => {}); });
      await page.evaluateOnNewDocument(() => { window.__xss = 0; });
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((r) => typeof ROL !== 'undefined' && ROL === r && Array.isArray(MODULOS) && MODULOS.includes('pos'), { timeout: 25000 }, rol);
      return p;
    }
    const RESP = (r) => r.url().includes('/api/admin/asistente-restaurante/configuracion') && r.request().method() === 'GET';
    async function portada(p) {
      const respuesta = p.page.waitForResponse(RESP, { timeout: 15000 });
      await p.page.evaluate(() => mostrarTab('config'));
      await respuesta;
      await new Promise((r) => setTimeout(r, 300));
    }
    const tarjetaVisible = (page) => page.$eval('#cfg-card-asistente', (e) => getComputedStyle(e).display !== 'none');
    async function seccion(p) {
      await portada(p);
      assert.strictEqual(await tarjetaVisible(p.page), true, 'la tarjeta no aparece');
      await p.page.click('#cfg-card-asistente');
      await p.page.waitForSelector('#asistente-config .ascfg h2', { timeout: 10000 });
    }
    const estado = (page) => page.$eval('#asistente-config .ascfg-estado', (e) => e.textContent);
    const esperarEstado = (page, patron) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#asistente-config .ascfg-estado')?.textContent || ''), { timeout: 10000 }, patron.source);
    const poner = (page, sel, valor) => page.$eval(sel, (e, v) => { e.value = v; }, valor);

    await cfg(AV.BANDERA, 'true');
    await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));
    await callar();

    await t('B1. quien recibe los avisos ve la tarjeta «En ensayo» y la sección completa; el texto de la base es texto', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await seccion(p);
        assert.strictEqual(await p.page.$eval('#cfgst-asistente', (e) => e.textContent), '● En ensayo');
        const d = await p.page.$eval('#asistente-config', (c) => ({
          titulo: c.querySelector('h2').textContent,
          visible: c.querySelector('#ascfg-visible').checked,
          tipos: [...c.querySelectorAll('input[data-tipo]')].map((i) => [i.dataset.tipo, i.checked]),
          ajustes: Object.fromEntries([...c.querySelectorAll('input[data-ajuste]')].map((i) => [i.dataset.ajuste, i.value])),
          admins: [...c.querySelectorAll('input[data-admin]')].map((i) => ({ id: i.dataset.admin, marcado: i.checked, fijo: i.disabled, texto: i.closest('label').textContent })),
          silencio: [...c.querySelectorAll('.ascfg-silencio')].map((s) => ({ firma: s.dataset.silencio, texto: s.textContent })),
          imgs: c.querySelectorAll('img').length,
        }));
        assert.strictEqual(d.titulo, '🤖 Asistente del restaurante');
        assert.strictEqual(d.visible, false);
        assert.strictEqual(d.tipos.length, 20);
        assert.ok(d.tipos.every(([, x]) => x), 'algún tipo nace apagado');
        assert.deepStrictEqual(d.ajustes, Object.fromEntries(Object.entries(C.AJUSTES_DE_SIEMPRE).map(([k, v]) => [k, String(v)])));
        assert.deepStrictEqual(d.admins.map((a) => a.id).sort(), [ADMIN, ADMIN2].sort(), 'el operador o alguien de fuera está en «Quién ve»');
        const yo = d.admins.find((a) => a.id === ADMIN);
        assert.ok(yo.marcado && yo.fijo && yo.texto.endsWith('— tú'), JSON.stringify(yo));
        const otro = d.admins.find((a) => a.id === ADMIN2);
        assert.ok(!otro.marcado && !otro.fijo);
        assert.strictEqual(d.silencio.length, 1);
        assert.strictEqual(d.silencio[0].firma, FIRMA);
        assert.ok(d.silencio[0].texto.includes(`«${XSS}» vendió 20 % menos`), 'el texto del aviso no se ve tal cual');
        assert.ok(d.silencio[0].texto.includes(`Lo calló ${TAG} Dueño`));
        assert.strictEqual(d.imgs, 0, 'el texto de la base se volvió una etiqueta');
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        assert.deepStrictEqual(p.errores, []);
        assert.deepStrictEqual(p.dialogos, []);
      } finally { await p.cerrar(); }
    });

    await t('B2. guardar: se guarda lo que se ve y sigue igual al recargar', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await seccion(p);
        await p.page.click('#asistente-config input[data-tipo="producto_sube"]');
        await poner(p.page, '#ascfg-aj-avisosPorDia', '2');
        await poner(p.page, '#ascfg-aj-diasSinVenir', '30');
        await p.page.click(`#asistente-config input[data-admin="${ADMIN2}"]`);
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperarEstado(p.page, /^Guardado\. La revisión de mañana ya lo usa\.$/);
        const k = await claves();
        assert.deepStrictEqual(JSON.parse(k[C.CLAVE_TIPOS_APAGADOS]), ['producto_sube']);
        assert.deepStrictEqual(JSON.parse(k[C.CLAVE_UMBRALES]), { ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 2, diasSinVenir: 30 });
        assert.deepStrictEqual(JSON.parse(k[AV.CLAVE_DESTINATARIOS]).sort(), [ADMIN, ADMIN2].sort());
        assert.strictEqual(k[AV.CLAVE_MODO], 'ensayo');
        assert.deepStrictEqual(p.dialogos, [], 'guardar sin cambiar el estado no debe pedir confirmación');
      } finally { await p.cerrar(); }
      const r = await abrirPanel(SES.admin);
      try {
        await seccion(r);
        const d = await r.page.$eval('#asistente-config', (c) => ({
          sube: c.querySelector('input[data-tipo="producto_sube"]').checked,
          baja: c.querySelector('input[data-tipo="producto_baja"]').checked,
          porDia: c.querySelector('#ascfg-aj-avisosPorDia').value,
          dias: c.querySelector('#ascfg-aj-diasSinVenir').value,
        }));
        assert.deepStrictEqual(d, { sube: false, baja: true, porDia: '2', dias: '30' });
        assert.strictEqual(await r.page.$eval(`#asistente-config input[data-admin="${ADMIN2}"]`, (e) => e.checked), true);
      } finally { await r.cerrar(); }
    });

    await t('B3. un valor fuera de rango: el error del servidor se ve y no se guarda nada', async () => {
      const antes = await claves();
      const p = await abrirPanel(SES.admin);
      try {
        await seccion(p);
        await poner(p.page, '#ascfg-aj-cambioPct', '5');
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperarEstado(p.page, /Cambio mínimo.*entre 10 y 50/);
        assert.strictEqual(await p.page.$eval('#asistente-config .ascfg-estado', (e) => e.style.color), 'rgb(185, 28, 28)');
        assert.strictEqual(await p.page.$eval('#asistente-config .ascfg-guardar', (e) => e.disabled), false, 'el botón quedó bloqueado');
        assert.deepStrictEqual(await claves(), antes, 'un valor rechazado cambió la configuración');
        assert.deepStrictEqual(p.dialogos, [], 'el rechazo levantó una ventana de error');
      } finally { await p.cerrar(); }
    });

    await t('B4. «Volver a avisar» lo quita de la lista y de la base', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await seccion(p);
        await p.page.click(`#asistente-config button[data-firma="${FIRMA}"]`);
        await esperarEstado(p.page, /^Listo: ese aviso puede volver a salir\.$/);
        assert.strictEqual(await p.page.$('#asistente-config .ascfg-silencio'), null);
        assert.match(await p.page.$eval('#asistente-config', (c) => c.textContent), /Ninguno\. Cuando pulses «No avisar de esto»/);
        assert.strictEqual((await q('SELECT 1 FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A])).rowCount, 0);
      } finally { await p.cerrar(); }
    });

    await t('B5. «Mostrar los avisos» pide confirmación: «Cancelar» no cambia nada; «Aceptar» lo pasa a visible', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await seccion(p);
        await p.page.click('#ascfg-visible');
        const puts = () => p.pedidas.filter((x) => x.startsWith('PUT')).length;
        p.responder = 'dismiss';
        await p.page.click('#asistente-config .ascfg-guardar');
        await new Promise((r) => setTimeout(r, 600));
        assert.strictEqual(p.dialogos.length, 1, 'no pidió confirmación');
        assert.match(p.dialogos[0], /Desde mañana los avisos se van a mostrar en la campanita a 2 personas\. ¿Seguro\?/);
        assert.strictEqual(puts(), 0, 'cancelar igual guardó');
        assert.strictEqual((await claves())[AV.CLAVE_MODO], 'ensayo');
        p.responder = 'accept';
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperarEstado(p.page, /^Guardado\./);
        assert.strictEqual(p.dialogos.length, 2);
        assert.strictEqual((await claves())[AV.CLAVE_MODO], 'visible');
        assert.strictEqual(await p.page.$eval('#cfgst-asistente', (e) => e.textContent), '✓ Visible');
        assert.strictEqual(await p.page.$eval('#ascfg-visible', (e) => e.checked), true);
        // Guardar otra vez ya en visible no vuelve a preguntar.
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperarEstado(p.page, /^Guardado\./);
        assert.strictEqual(p.dialogos.length, 2, 'preguntó otra vez estando ya visible');
      } finally { await p.cerrar(); }
      await cfg(AV.CLAVE_MODO, undefined);
    });

    await t('B6. otro administrador no ve la tarjeta; el operador ni pregunta', async () => {
      await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));
      const p = await abrirPanel(SES.admin2);
      try {
        await portada(p);
        assert.strictEqual(await tarjetaVisible(p.page), false, 'otro administrador ve la tarjeta');
        assert.strictEqual(await p.page.$eval('#cfgst-asistente', (e) => e.textContent), '○ Revisar');
        assert.deepStrictEqual(p.dialogos, [], 'la consulta levantó una ventana');
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
      const s = await abrirPanel(SES.staff, { rol: 'staff' });
      try {
        await s.page.evaluate(() => window.XaborAsistenteConfig.revisarTarjeta());
        await new Promise((r) => setTimeout(r, 1500));
        assert.deepStrictEqual(s.pedidas, [], 'el operador preguntó por la configuración');
        assert.strictEqual(await tarjetaVisible(s.page), false);
      } finally { await s.cerrar(); }
    });

    await t('B7. en el celular la sección no se sale de la pantalla', async () => {
      await callar();
      const p = await abrirPanel(SES.admin, { ancho: 375, alto: 812 });
      try {
        await seccion(p);
        const m = await p.page.$eval('#asistente-config .ascfg', (e) => { const r = e.getBoundingClientRect(); return { izq: r.left, der: r.right }; });
        assert.ok(m.izq >= 0 && m.der <= 375, `la sección se sale: ${JSON.stringify(m)}`);
        const ancho = await p.page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(ancho <= 376, `la página se desborda: ${ancho}px`);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B8. con el asistente apagado la tarjeta no aparece, ni para quien recibía los avisos', async () => {
      await cfg(AV.BANDERA, undefined);
      const p = await abrirPanel(SES.admin);
      try {
        await portada(p);
        assert.strictEqual(await tarjetaVisible(p.page), false);
        assert.deepStrictEqual(p.dialogos, []);
      } finally { await p.cerrar(); await cfg(AV.BANDERA, 'true'); }
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
