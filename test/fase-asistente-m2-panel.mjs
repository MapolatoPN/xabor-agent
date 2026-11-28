// ASISTENTE DEL RESTAURANTE, Mejora 2: la tarjeta en un navegador real
// (puppeteer) contra el servidor de prueba.
//
// Una sucursal y sus avisos INVENTADOS, creados aquí y borrados al final.
// Cubre:
//   A. la huella ?v= de asistente-pantalla.js y que las cifras chicas no se
//      arman con HTML;
//   B. con la bandera: el orden en tres grupos y su nota; hasta 3 cifras
//      chicas por tarjeta; la tarjeta sin recomendación no tiene flecha ni
//      texto de «qué hacer» (y sí su botón y su detalle); sin errores;
//   C. apagada: control primero, la nota de siempre y sin cifras chicas en
//      las tarjetas que no las traen;
//   D. en el celular las cifras chicas caben y la página no se desliza de lado.
//
// La sucursal vive en una zona donde AHORA no son de las 5 a las 13: el
// servidor de prueba no le corre la revisión de la mañana (de 6 a 12).
import assert from 'assert';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const R = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const AC = await import('../src/asistenteRestaurante/acciones.js');
const M2 = await import('../src/asistenteRestaurante/recomendaciones.js');

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
const huella = createHash('sha256').update(readFileSync(raiz('panel/asistente-pantalla.js'))).digest('hex').slice(0, 8);

await t('A1. la huella ?v= de asistente-pantalla.js; las cifras chicas van como texto, no como HTML', () => {
  assert.ok(HTML.includes(`<script src="/asistente-pantalla.js?v=${huella}"></script>`), `la huella correcta es ${huella}`);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(JS), 'asistente-pantalla.js arma HTML con texto');
  assert.match(JS, /el\('ul', 'asp-datos'\)/);
  assert.match(JS, /t\.datos\.slice\(0, 3\)/);
});

// ═══ B–D. En un navegador real ═════════════════════════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h < 5 || (h >= 14 && h <= 21); }));
if (!TZ) { console.error('ninguna zona fuera de las 5 a las 13'); process.exit(2); }
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const SEMANA = { desde: R.sumarDias(AYER, -6), hasta: AYER };

const TAG = 'AO' + (Date.now() % 1e8).toString(36).toUpperCase();
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-m2p-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM asistente_restaurante_acciones WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_opiniones WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_hallazgos WHERE negocio_id = $1');
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
  await limpiar();
  const A = (await uno('INSERT INTO negocios (nombre, slug, bot_whatsapp_activo) VALUES ($1, $2, true) RETURNING id', [`${TAG} Sucursal`, `${TAG.toLowerCase()}-asis-m2p-a`])).id;
  for (const m of ['pos', 'caja']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [A, m]);
  await actualizarConfiguracion({ timezone: TZ }, A);
  const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
    [A, `${TAG} Dueño`, `${TAG.toLowerCase()}-dueno@test.local`]);
  await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, A, 'admin']);
  const ADMIN = u.id;
  async function cfg(clave, valor) {
    await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [A, clave]);
    if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [A, clave, valor]);
  }
  await cfg(AV.BANDERA, 'true');
  await cfg(AV.CLAVE_MODO, 'visible');
  await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));
  await cfg(AC.BANDERA_ACCIONES, 'true');
  await cfg(M2.BANDERA_REGLAS_V2, 'true');

  // La revisión de hoy: dos que piden decisión, una buena noticia sin
  // recomendación y una informativa (la más cara, pero va al final).
  const corrida = (await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos, terminada_en)
                              VALUES ($1, $2, 'visible', 'lista', 12, 4, now()) RETURNING id`, [A, HOY])).id;
  const num = { detalle: { numeros: [{ etiqueta: 'Últimas 4 semanas', valor: 9000, formato: 'dinero' }, { etiqueta: '4 anteriores', valor: 4800, formato: 'dinero' }] } };
  const H = {};
  for (const [clave, tipo, impacto, extra] of [
    ['cambiaron', 'clientes_cambiaron', 50000, { sugerencia: 'Mira qué piden ahora estos 2 clientes.' }],
    ['sube', 'categoria_sube', 9000, { sugerencia: '', pantalla: { encabezado: 'Desayunos vende más', datos: ['Total del negocio +12.5 %', 'Sábados: 45 % del aumento'] },
      detalle: { ...num.detalle, nota: 'El cambio está repartido entre muchos platillos: ninguno suma la mitad, así que no hay una recomendación concreta.' } }],
    ['baja', 'producto_baja', 4200, { sugerencia: 'Revisa que «Chilaquiles» esté disponible y se ofrezca de 9 a 11, donde más bajó ($4,200 menos en 4 semanas).',
      pantalla: { encabezado: 'Chilaquiles vende menos', datos: ['Total del negocio igual', 'Sábados: 60 % de la baja', '9 a 11: 70 % de la baja'] } }],
    ['sinPago', 'ventas_sin_forma_pago', 600, { sugerencia: 'Captura la forma de pago de esas 3 ventas ($600) para que el corte cuadre.', accion: SEMANA }],
  ]) {
    H[clave] = (await uno(
      `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, 'elegido', true) RETURNING id::text AS id`,
      [A, corrida, tipo, `${tipo}:m2p`, impacto, `Prueba ${tipo}.`, JSON.stringify({ ...num, ...extra })])).id;
  }

  const { crearTokenSesion } = await import('../src/services/session.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const SES = encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN, negocioId: A, rol: 'admin' }));

  let puppeteer = null;
  try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
  if (!puppeteer) {
    await t('B. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_M2_PANEL || '4762' }, { timeoutMs: 40000, omitir: ['XABOR_ASISTENTE_RESUMEN_WA'] });
    const BASE = srv.base;
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    async function abrirPanel({ ancho = 1280, alto = 800 } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: SES, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const p = { page, errores: [], cerrar: () => ctxN.close() };
      page.on('pageerror', (e) => p.errores.push(e.message));
      page.on('dialog', (d) => d.dismiss().catch(() => {}));
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof ROL !== 'undefined' && ROL === 'admin' && Array.isArray(MODULOS), { timeout: 25000 });
      return p;
    }
    async function asistente(p) {
      await p.page.evaluate(() => mostrarTab('ventas'));
      await p.page.waitForFunction(() => document.getElementById('pest-asistente').style.display !== 'none', { timeout: 15000 });
      const datos = p.page.waitForResponse((r) => r.url().endsWith(RUTA) && r.request().method() === 'GET', { timeout: 15000 }).catch(() => null);
      await p.page.$eval('#pest-asistente', (e) => e.click());
      await p.page.waitForFunction(() => document.getElementById('vista-asistente')?.style.display === 'block', { timeout: 10000 });
      await Promise.race([datos, new Promise((x) => setTimeout(x, 2000))]);
      await p.page.waitForSelector('#reportes-asistente article.asp-tarjeta', { timeout: 15000 });
    }
    const leer = (p) => p.page.evaluate(() => ({
      nota: document.querySelector('#reportes-asistente .asp-titulo .asp-nota')?.textContent.trim() || null,
      tarjetas: [...document.querySelectorAll('#reportes-asistente article.asp-tarjeta')].map((a) => ({
        id: a.dataset.aviso,
        datos: [...a.querySelectorAll('ul.asp-datos li')].map((li) => li.textContent),
        hacer: a.querySelector('.asp-hacer')?.textContent || '',
        flecha: a.querySelectorAll('.asp-accion > svg').length,
        boton: a.querySelector('.asp-ir')?.textContent.trim() || null,
        ver: !!a.querySelector('.asp-ver'),
      })),
    }));

    await t('B1. con la bandera: primero lo que pide decisión (por pesos), luego la buena noticia y al final lo informativo', async () => {
      const p = await abrirPanel();
      try {
        await asistente(p);
        const r = await leer(p);
        assert.deepStrictEqual(r.tarjetas.map((x) => x.id), [H.baja, H.sinPago, H.sube, H.cambiaron]);
        assert.match(r.nota, /4 de 12 cosas revisadas · primero lo que pide una decisión$/);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B2. hasta 3 cifras chicas por tarjeta; sin recomendación, ni flecha ni «qué hacer», pero sí su detalle', async () => {
      const p = await abrirPanel();
      try {
        await asistente(p);
        const por = Object.fromEntries((await leer(p)).tarjetas.map((x) => [x.id, x]));
        assert.deepStrictEqual(por[H.baja].datos, ['Total del negocio igual', 'Sábados: 60 % de la baja', '9 a 11: 70 % de la baja']);
        assert.deepStrictEqual(por[H.sube].datos, ['Total del negocio +12.5 %', 'Sábados: 45 % del aumento']);
        assert.deepStrictEqual(por[H.sinPago].datos, []);
        assert.strictEqual(por[H.baja].flecha, 1);
        assert.match(por[H.baja].hacer, /«Chilaquiles».*de 9 a 11/);
        assert.deepStrictEqual([por[H.sube].flecha, por[H.sube].hacer], [0, ''], 'la tarjeta sin recomendación trae flecha o texto');
        assert.ok(por[H.sube].ver, 'la tarjeta sin recomendación perdió «Ver números»');
        assert.strictEqual(por[H.sinPago].boton, 'Ver en Historial', 'se perdió el botón de la Mejora 1');
        // Al abrir el detalle sale la nota de por qué no hay recomendación.
        await p.page.$eval(`#reportes-asistente article.asp-tarjeta[data-aviso="${H.sube}"] .asp-ver`, (b) => b.click());
        await p.page.waitForFunction((id) => /repartido entre muchos platillos/.test(document.querySelector(`#reportes-asistente article.asp-tarjeta[data-aviso="${id}"]`)?.textContent || ''),
          { timeout: 5000 }, H.sube);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('C1. apagada la bandera: control primero, la nota de siempre', async () => {
      await cfg(M2.BANDERA_REGLAS_V2, undefined);
      const p = await abrirPanel();
      try {
        await asistente(p);
        const r = await leer(p);
        assert.deepStrictEqual(r.tarjetas.map((x) => x.id), [H.sinPago, H.cambiaron, H.sube, H.baja]);
        assert.match(r.nota, /las de control van primero$/);
        assert.deepStrictEqual(r.tarjetas.find((x) => x.id === H.sinPago).datos, []);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); await cfg(M2.BANDERA_REGLAS_V2, 'true'); }
    });

    await t('D1. en el celular las cifras chicas caben en la tarjeta y la página no se desliza de lado', async () => {
      const m = await abrirPanel({ ancho: 375, alto: 812 });
      try {
        await asistente(m);
        const r = await m.page.evaluate(() => {
          const fuera = [];
          for (const li of document.querySelectorAll('#reportes-asistente ul.asp-datos li')) {
            const caja = li.closest('article').getBoundingClientRect(), b = li.getBoundingClientRect();
            if (b.left < caja.left - 1 || b.right > caja.right + 1) fuera.push(li.textContent);
          }
          return { cifras: document.querySelectorAll('#reportes-asistente ul.asp-datos li').length, fuera,
            ancho: document.documentElement.scrollWidth, ventana: window.innerWidth };
        });
        assert.strictEqual(r.cifras, 5);
        assert.deepStrictEqual(r.fuera, [], 'una cifra chica se sale de su tarjeta');
        assert.ok(r.ancho <= r.ventana, `la página se desliza de lado (${r.ancho} > ${r.ventana})`);
        // Una foto para revisarla a ojo, solo si se pide (fuera del repositorio).
        if (process.env.CAPTURA_M2) {
          await m.page.$eval(`#reportes-asistente article.asp-tarjeta[data-aviso="${H.baja}"]`, (e) => e.scrollIntoView());
          await m.page.screenshot({ path: process.env.CAPTURA_M2 }).catch(() => {});
        }
        assert.deepStrictEqual(m.errores, []);
      } finally { await m.cerrar(); }
    });
  }
} finally {
  try { await navegador?.close(); } catch { /* ya cerrado */ }
  try { srv?.detener(); } catch { /* ya terminó */ }
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) console.log(fallos.map((f) => ` - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
