// ASISTENTE DEL RESTAURANTE, Fase 3: la parte nueva de la tarjeta y de la
// campanita, en un navegador real (puppeteer) contra el servidor de prueba.
//
// Negocio, usuarios, números y avisos INVENTADOS. Cubre: las huellas ?v= de
// los tres archivos que cambiaron; la sección «Redacción con IA y resumen por
// WhatsApp» nace apagada; guardar se queda al recargar; el error del servidor
// se ve y no guarda nada; «Enviar prueba» no sale con un número sin guardar y
// dice por qué no salió; los últimos envíos se pintan como texto; en la
// campanita, el aviso redactado con IA muestra su explicación y los dos avisos
// nuevos su texto; y en el celular no se sale de la pantalla.
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
const { fechaOperativaDe } = await import('../src/services/cortesCaja.js');
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
const huella = (f) => createHash('sha256').update(readFileSync(raiz(`panel/${f}`))).digest('hex').slice(0, 8);

await t('A1. las huellas ?v= de los tres archivos que cambiaron; ninguno arma HTML con texto', () => {
  for (const f of ['avisos-panel.js', 'asistente-avisos.js', 'asistente-config.js']) {
    assert.ok(HTML.includes(`<script src="/${f}?v=${huella(f)}"></script>`), `la huella correcta de ${f} es ${huella(f)}`);
    const js = readFileSync(raiz(`panel/${f}`), 'utf8');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js), `${f} arma HTML con texto`);
  }
});

// ═══ B. En un navegador real ══════════════════════════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => P.horaLocal(new Date(Date.now() + m * 60000), z) < 5));
const HOY = fechaOperativaDe(new Date(), TZ);

const TAG = 'AP' + (Date.now() % 1e8).toString(36).toUpperCase();
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f3p-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_resumenes WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1');
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
const A = (await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [`${TAG} Sucursal`, `${TAG.toLowerCase()}-asis-f3p-a`])).id;
for (const m of ['pos', 'caja', 'whatsapp', 'menu']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [A, m]);
const ADMIN = (await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
  [A, `${TAG} Dueño`, `${TAG.toLowerCase()}-dueno@test.local`])).id;
await q(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',true)`, [ADMIN, A]);
async function cfg(clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [A, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [A, clave, valor]);
}
const guardado = async () => { const r = await uno('SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [A, C.CLAVE_RESUMEN]); return r ? JSON.parse(r.valor) : null; };
await cfg('timezone', TZ);
await cfg(AV.BANDERA, 'true');
await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));
await cfg(AV.CLAVE_MODO, 'visible');
await cfg('avisos_panel_v1', 'true');
const XSS = '<img src=x onerror="window.__xss=1">';

const { crearTokenSesion } = await import('../src/services/session.js');
const { arrancarServidor } = await import('./lib-servidor.mjs');
const SES = encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN, negocioId: A, rol: 'admin' }));

let puppeteer = null;
try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
let srv = null, navegador = null;
try {
  if (!puppeteer) {
    await t('B. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_F3_PANEL || '4794' }, { timeoutMs: 40000 });
    const BASE = srv.base;
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    async function abrirPanel({ ancho = 1280, alto = 800 } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: SES, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const p = { page, pedidas: [], errores: [], dialogos: [], cerrar: () => ctxN.close() };
      page.on('request', (r) => { if (r.url().includes('/api/admin/asistente-restaurante/configuracion')) p.pedidas.push(`${r.method()} ${r.url()}`); });
      page.on('pageerror', (e) => p.errores.push(e.message));
      page.on('dialog', (d) => { p.dialogos.push(d.message()); d.dismiss().catch(() => {}); });
      await page.evaluateOnNewDocument(() => { window.__xss = 0; });
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof ROL !== 'undefined' && ROL === 'admin' && Array.isArray(MODULOS) && MODULOS.includes('pos'), { timeout: 25000 });
      return p;
    }
    async function seccion(p) {
      const respuesta = p.page.waitForResponse((r) => r.url().includes('/api/admin/asistente-restaurante/configuracion') && r.request().method() === 'GET', { timeout: 15000 });
      await p.page.evaluate(() => mostrarTab('config'));
      await respuesta;
      await p.page.waitForFunction(() => getComputedStyle(document.getElementById('cfg-card-asistente')).display !== 'none', { timeout: 10000 });
      await p.page.click('#cfg-card-asistente');
      await p.page.waitForSelector('#asistente-config #ascfg-resumen', { timeout: 10000 });
    }
    const leer = (page) => page.$eval('#ascfg-resumen', (b) => ({
      titulo: b.querySelector('h3').textContent,
      ia: b.querySelector('#ascfg-ia').checked, tope: b.querySelector('#ascfg-tope').value, numero: b.querySelector('#ascfg-numero').value,
      diario: b.querySelector('#ascfg-diario').checked, hora: b.querySelector('#ascfg-hora').value, semanal: b.querySelector('#ascfg-semanal').checked,
      texto: b.textContent,
    }));
    const poner = (page, sel, valor) => page.$eval(sel, (e, v) => { e.value = v; }, valor);
    const marcar = (page, sel, si) => page.$eval(sel, (e, v) => { e.checked = v; }, si);
    const esperar = (page, sel, patron) => page.waitForFunction((s, src) => new RegExp(src).test(document.querySelector(s)?.textContent || ''), { timeout: 10000 }, sel, patron.source);

    await t('B1. la sección nace apagada, con la plantilla y el gasto del mes', async () => {
      const p = await abrirPanel();
      try {
        await seccion(p);
        const d = await leer(p.page);
        assert.strictEqual(d.titulo, 'Redacción con IA y resumen por WhatsApp');
        assert.deepStrictEqual({ ia: d.ia, tope: d.tope, numero: d.numero, diario: d.diario, hora: d.hora, semanal: d.semanal },
          { ia: false, tope: '10', numero: '', diario: false, hora: '21:30', semanal: false });
        assert.match(d.texto, /«xabor_resumen_asistente_v1»/);
        assert.match(d.texto, /Gastado este mes: US\$0\.00\./);
        assert.match(d.texto, /Vacío = no se manda nada/);
        assert.deepStrictEqual(p.errores, []);
        assert.deepStrictEqual(p.dialogos, []);
      } finally { await p.cerrar(); }
    });

    await t('B2. guardar: se guarda lo que se ve (el número a 10 dígitos) y sigue igual al recargar', async () => {
      const p = await abrirPanel();
      try {
        await seccion(p);
        await marcar(p.page, '#ascfg-ia', true);
        await poner(p.page, '#ascfg-tope', '7');
        await poner(p.page, '#ascfg-numero', '+52 878 000 0001');
        await marcar(p.page, '#ascfg-diario', true);
        await poner(p.page, '#ascfg-hora', '22:00');
        await marcar(p.page, '#ascfg-semanal', true);
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperar(p.page, '#asistente-config .ascfg-estado', /^Guardado\./);
        assert.deepStrictEqual(await guardado(), { ia: true, topeUsd: 7, diario: true, hora: '22:00', semanal: true, numero: '8780000001' });
      } finally { await p.cerrar(); }
      const r = await abrirPanel();
      try {
        await seccion(r);
        const d = await leer(r.page);
        assert.deepStrictEqual({ ia: d.ia, tope: d.tope, numero: d.numero, diario: d.diario, hora: d.hora, semanal: d.semanal },
          { ia: true, tope: '7', numero: '8780000001', diario: true, hora: '22:00', semanal: true });
      } finally { await r.cerrar(); }
    });

    await t('B3. sin número y con el diario encendido: el error del servidor se ve y no se guarda nada', async () => {
      const antes = await guardado();
      const p = await abrirPanel();
      try {
        await seccion(p);
        await poner(p.page, '#ascfg-numero', '');
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperar(p.page, '#asistente-config .ascfg-estado', /Escribe el número que recibe el resumen/);
        assert.strictEqual(await p.page.$eval('#asistente-config .ascfg-estado', (e) => e.style.color), 'rgb(185, 28, 28)');
        assert.deepStrictEqual(await guardado(), antes, 'un resumen rechazado se guardó');
        await poner(p.page, '#ascfg-tope', '80');
        await poner(p.page, '#ascfg-numero', '8780000001');
        await p.page.click('#asistente-config .ascfg-guardar');
        await esperar(p.page, '#asistente-config .ascfg-estado', /entre 1 y 50/);
        assert.deepStrictEqual(await guardado(), antes);
      } finally { await p.cerrar(); }
    });

    await t('B4. «Enviar prueba»: con un número sin guardar no sale; con el guardado dice por qué no salió', async () => {
      const p = await abrirPanel();
      try {
        await seccion(p);
        await poner(p.page, '#ascfg-numero', '8780000009');
        await p.page.click('#asistente-config .ascfg-prueba');
        await esperar(p.page, '#asistente-config .ascfg-prueba-estado', /^Cambiaste el número: pulsa «Guardar»/);
        assert.strictEqual(p.pedidas.filter((x) => x.includes('/enviar-prueba')).length, 0, 'mandó la prueba a un número sin guardar');
        await poner(p.page, '#ascfg-numero', '8780000001');
        await p.page.click('#asistente-config .ascfg-prueba');
        await esperar(p.page, '#asistente-config .ascfg-prueba-estado', /^La sucursal no tiene WhatsApp conectado\.$/);
        assert.strictEqual(await p.page.$eval('#asistente-config .ascfg-prueba-estado', (e) => e.style.color), 'rgb(185, 28, 28)');
        assert.strictEqual(await p.page.$eval('#asistente-config .ascfg-prueba', (e) => e.disabled), false, 'el botón quedó bloqueado');
        assert.deepStrictEqual(p.pedidas.filter((x) => x.includes('/enviar-prueba')).map((x) => x.split(' ')[0]), ['POST']);
        assert.deepStrictEqual(p.dialogos, []);
      } finally { await p.cerrar(); }
    });

    await t('B5. los últimos envíos se pintan como texto, con los 4 dígitos y si llevó IA', async () => {
      await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado, con_ia, destino, enviado_en, creado_en)
               VALUES ($1, 'diario', $2, 'enviado', true, '0001', now() - interval '2 hours', now() - interval '2 hours')`, [A, HOY]);
      await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado, destino, error)
               VALUES ($1, 'prueba', $2, 'fallo', '0001', $3)`, [A, HOY, `Meta dijo ${XSS}`]);
      const p = await abrirPanel();
      try {
        await seccion(p);
        const filas = await p.page.$$eval('#ascfg-resumen [data-envio]', (els) => els.map((e) => [e.dataset.envio, e.textContent]));
        assert.strictEqual(filas.length, 2);
        assert.strictEqual(filas[0][0], 'fallo');
        assert.match(filas[0][1], / · Prueba · No salió · al …0001: Meta dijo <img src=x onerror="window\.__xss=1">$/);
        assert.match(filas[1][1], / · Diario · Enviado · al …0001 · con IA$/);
        assert.strictEqual(await p.page.$('#ascfg-resumen img'), null, 'el texto de la base se volvió una etiqueta');
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
      } finally { await p.cerrar(); }
    });

    await t('B6. la campanita: el aviso redactado con IA muestra su explicación; los dos avisos nuevos, su texto', async () => {
      const c = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos, ia)
                           VALUES ($1, $2, 'visible', 'lista', 1, 1, 'ok') RETURNING id`, [A, HOY]);
      await q(`INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
               VALUES ($1, $2, 'ventas_sin_forma_pago', 'ventas_sin_forma_pago', 600, '3 ventas de ayer no tienen forma de pago ($600).', $3::jsonb, true, 'elegido', true)`,
      [A, c.id, JSON.stringify({
        detalle: { numeros: [{ etiqueta: 'Ventas', valor: 3, formato: 'entero' }] },
        sugerencia: 'Captura la forma de pago de esas ventas.',
        ia: { titulo: `Hubo ventas sin forma de pago ${XSS}`, explicacion: 'Algunos cobros de ayer quedaron sin registrar cómo se pagaron.', sugerencia: 'Pide al cajero que la registre.', orden: 0 },
      })]);
      await q(`INSERT INTO avisos_panel (negocio_id, tipo, datos) VALUES ($1, 'asistente_resumen_fallo', $2::jsonb), ($1, 'asistente_tope_ia', $3::jsonb)`,
        [A, JSON.stringify({ motivo: 'La plantilla xabor_resumen_asistente_v1 no existe o no está aprobada en Meta', razon: 'Resumen diario del 26 nov' }), JSON.stringify({ motivo: 'US$7' })]);
      const p = await abrirPanel();
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        await p.page.click('#btn-avisos');
        await p.page.waitForSelector('#menu-avisos:not([hidden]) .as-item', { timeout: 10000 });
        const it = await p.page.$eval('#menu-avisos .as-item', (e) => ({
          titulo: e.querySelector('.as-titulo').textContent, meta: e.querySelector('.as-meta').textContent,
          explica: e.querySelector('.as-explica')?.textContent, que: e.querySelector('.as-que')?.textContent,
        }));
        assert.ok(it.titulo.endsWith(`Hubo ventas sin forma de pago ${XSS}`), it.titulo);
        assert.match(it.meta, /redactado con IA$/);
        assert.strictEqual(it.explica, 'Algunos cobros de ayer quedaron sin registrar cómo se pagaron.');
        assert.strictEqual(it.que, 'Qué hacer: Pide al cajero que la registre.');
        assert.match(await p.page.$eval('#menu-avisos .as-pie', (e) => e.textContent), /la IA solo escribió el texto y Xabor revisó cada número/);
        const av = await p.page.$$eval('#menu-avisos .av-item', (els) => els.map((e) => e.textContent));
        assert.ok(av.some((x) => x.includes('🧾 El resumen por WhatsApp no salió') && x.includes('Resumen diario del 26 nov. La plantilla xabor_resumen_asistente_v1')), JSON.stringify(av));
        assert.ok(av.some((x) => x.includes('💸 La IA del asistente llegó a su tope de gasto del mes (US$7)')), JSON.stringify(av));
        assert.strictEqual(await p.page.$('#menu-avisos img'), null);
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B7. en el celular la sección nueva no se sale de la pantalla', async () => {
      const p = await abrirPanel({ ancho: 375, alto: 812 });
      try {
        await seccion(p);
        const m = await p.page.$eval('#ascfg-resumen', (e) => {
          const r = e.getBoundingClientRect();
          const dentro = [...e.querySelectorAll('input, button')].every((x) => { const b = x.getBoundingClientRect(); return b.left >= 0 && b.right <= 375; });
          return { izq: r.left, der: r.right, dentro };
        });
        assert.ok(m.izq >= 0 && m.der <= 375 && m.dentro, `la sección se sale: ${JSON.stringify(m)}`);
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
