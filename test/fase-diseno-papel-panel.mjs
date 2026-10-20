// ─── Configuración → «Diseño de ticket y comanda» ───────────────────────────
//
// La pantalla con la que el dueño de un restaurante (sin saber de código)
// elige cómo se ve el papel. Fija:
//   A. el panel carga la pantalla con la huella correcta y la abre desde su
//      tarjeta; cada opción de la pantalla existe en el formato y el servidor
//      la acepta tal cual;
//   B. la API: solo administradores; lo guardado se valida; la vista previa
//      sale del mismo armado que el papel y cabe en el ancho elegido;
//   C. en un navegador real: cambiar una opción cambia la vista previa, se
//      guarda solo («Guardado ✓»), sobrevive a recargar y «Volver al diseño de
//      fábrica» lo deshace; sin errores de JavaScript y sin desbordar en tablet.
import assert from 'assert';
import vm from 'vm';
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizarFormato, FORMATO_POR_DEFECTO } from '../src/printing/formato/opciones.js';
import { puntosDeRenglon } from '../src/printing/formato/maquetador.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const panel = readFileSync(join(__dirname, '../panel/index.html'), 'utf8');
const modulo = readFileSync(join(__dirname, '../panel/disenoPapel.js'), 'utf8');

// ═══════════ A. Piezas del panel ═══════════
await t('PANEL', '1. index.html carga disenoPapel.js con su huella y abre la sección desde su tarjeta', async () => {
  const huella = createHash('sha256').update(readFileSync(join(__dirname, '../panel/disenoPapel.js'))).digest('hex').slice(0, 8);
  const m = /<script src="\/disenoPapel\.js\?v=([0-9a-f]{8})"><\/script>/.exec(panel);
  assert.ok(m, 'falta la etiqueta de disenoPapel.js con ?v=');
  assert.strictEqual(m[1], huella, `el ?v= dice "${m[1]}" y el archivo tiene huella "${huella}": pon "${huella}" en index.html`);
  assert.ok(/class="cfg-card admin-only" id="cfg-card-diseno" onclick="cfgIr\('diseno'\)"/.test(panel), 'falta la tarjeta (solo admin)');
  assert.ok(panel.includes('<div class="cfg-sec" id="cfg-sec-diseno">') && panel.includes('<div id="diseno-papel"></div>'));
  assert.ok(panel.includes("if (sec === 'diseno' && window.XaborDisenoPapel) window.XaborDisenoPapel.abrir(document.getElementById('diseno-papel'));"));
});

// Las opciones que ofrece la pantalla, leídas del propio módulo.
function opcionesDelModulo() {
  const ctx = { window: {}, document: {} };
  vm.createContext(ctx);
  const fuente = modulo.replace("window.XaborDisenoPapel = { abrir };", "window.XaborDisenoPapel = { abrir, OPCIONES };");
  vm.runInContext(fuente, ctx);
  return ctx.window.XaborDisenoPapel.OPCIONES;
}

await t('PANEL', '2. cada opción de la pantalla existe en el formato y el servidor acepta cada valor tal cual', async () => {
  const OP = opcionesDelModulo();
  for (const [seccion, lista] of Object.entries(OP)) {
    for (const o of lista.filter(x => x.clave)) {
      assert.ok(o.clave in FORMATO_POR_DEFECTO[seccion], `${seccion}.${o.clave} no existe en el formato`);
      const valores = o.tipo === 'opciones' ? o.valores.map(v => v[0]) : o.tipo === 'si' ? [true, false] : ['Gracias · @mapolato', ''];
      for (const v of valores) {
        const n = normalizarFormato({ [seccion]: { [o.clave]: v } });
        assert.deepStrictEqual(n[seccion][o.clave], v, `${seccion}.${o.clave}=${JSON.stringify(v)} no sobrevive al servidor`);
      }
    }
  }
  const pantalla = new Set(Object.entries(OP).flatMap(([s, l]) => l.filter(x => x.clave).map(x => `${s}.${x.clave}`)));
  for (const [s, campos] of Object.entries(FORMATO_POR_DEFECTO)) {
    for (const c of Object.keys(campos)) assert.ok(pantalla.has(`${s}.${c}`), `la opción ${s}.${c} no se puede cambiar desde el panel`);
  }
});

// ═══════════ B y C. Con servidor y Postgres ═══════════
const SEED_PATH = join(__dirname, '.datos-prueba.json');
const url = process.env.DATABASE_URL || '';
if (!url || /railway|rlwy/.test(url) || !existsSync(SEED_PATH)) {
  console.log('\n(Partes B y C omitidas: hace falta DATABASE_URL local y test/.datos-prueba.json)');
} else {
  const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { pool } = await import('../src/services/database.js');
  const NEG = SEED.negocioA;
  const PUERTO = process.env.TEST_PORT_DISENO || '4981';
  const base = `http://localhost:${PUERTO}`;
  const sesion = (usuarioId, rol) => encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: NEG, rol }));
  const ADMIN = sesion(SEED.adminNegocioAUsuarioId, 'admin');
  const STAFF = sesion(SEED.staffNegocioAUsuarioId, 'staff');
  const api = async (ruta, { metodo = 'GET', cuerpo, cookie = ADMIN } = {}) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Cookie: `xabor_sesion=${cookie}` },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const previo = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [NEG]);
  const guardado = async () => {
    const { rows } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [NEG]);
    return rows.length ? JSON.parse(rows[0].valor) : null;
  };
  let srv = null;
  try {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [NEG]);
    srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

    await t('API', '3. solo el administrador lee y cambia el diseño', async () => {
      assert.strictEqual((await api('/api/impresion/formato', { cookie: STAFF })).status, 403);
      assert.strictEqual((await api('/api/impresion/formato', { metodo: 'PUT', cookie: STAFF, cuerpo: { formato: {} } })).status, 403);
      assert.strictEqual((await api('/api/impresion/formato/vista-previa', { metodo: 'POST', cookie: STAFF, cuerpo: {} })).status, 403);
      const r = await api('/api/impresion/formato');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.formato, normalizarFormato(null), 'sin nada guardado debe salir el de fábrica');
      assert.deepStrictEqual(r.body.anchos, [32, 42, 48]);
    });

    await t('API', '4. lo guardado se valida y se devuelve como quedó', async () => {
      const r = await api('/api/impresion/formato', { metodo: 'PUT', cuerpo: { formato: { comanda: { producto: 'enorme', notaInvertida: true }, ticket: { pie: 'Hola' } } } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.formato.comanda.producto, 'auto', 'un valor desconocido debe caer al de fábrica');
      assert.strictEqual(r.body.formato.comanda.notaInvertida, true);
      assert.deepStrictEqual(await guardado(), r.body.formato, 'lo guardado en la base no es lo que se devolvió');
      assert.strictEqual((await api('/api/impresion/formato', { metodo: 'PUT', cuerpo: { formato: 'x' } })).status, 400);
      assert.strictEqual((await api('/api/impresion/formato', { metodo: 'PUT', cuerpo: {} })).status, 400);
    });

    await t('API', '5. la vista previa usa el diseño que se manda y cabe en cada papel', async () => {
      for (const ancho of [32, 42, 48]) for (const documento of ['comanda', 'cuenta']) {
        const r = await api('/api/impresion/formato/vista-previa', { metodo: 'POST', cuerpo: { documento, ancho, formato: normalizarFormato(null) } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ancho, ancho);
        for (const x of r.body.renglones.filter(y => typeof y.texto === 'string')) assert.ok(puntosDeRenglon(x) <= ancho * 12, `${documento}/${ancho}: «${x.texto}»`);
      }
      const inv = await api('/api/impresion/formato/vista-previa', { metodo: 'POST', cuerpo: { documento: 'comanda', ancho: 42, formato: { comanda: { notaInvertida: true } } } });
      assert.ok(inv.body.renglones.some(x => x.invertido), 'la vista previa no usó el diseño enviado');
      const raro = await api('/api/impresion/formato/vista-previa', { metodo: 'POST', cuerpo: { documento: 'otro', ancho: 999 } });
      assert.strictEqual(raro.body.ancho, 42);
      assert.strictEqual(raro.body.documento, 'comanda');
    });

    await t('NAVEGADOR', '6. el dueño cambia una opción: la vista previa cambia, se guarda sola, sobrevive a recargar y se puede deshacer', async () => {
      await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [NEG]);
      const puppeteer = (await import('puppeteer')).default;
      const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const errores = [];
      try {
        const pag = await nav.newPage();
        pag.on('pageerror', e => errores.push(e.message));
        pag.on('dialog', d => d.accept().catch(() => {}));
        await pag.setViewport({ width: 1280, height: 900 });
        await pag.setCookie({ name: 'xabor_sesion', value: ADMIN, domain: 'localhost', path: '/' });
        await pag.goto(`${base}/app#config`, { waitUntil: 'networkidle0', timeout: 60000 });
        const abrir = async () => {
          await pag.evaluate(() => { if (typeof mostrarTab === 'function') mostrarTab('config'); });
          await pag.waitForSelector('#cfg-card-diseno', { visible: true, timeout: 15000 });
          await pag.click('#cfg-card-diseno');
          await pag.waitForSelector('#dp-hoja-cont .dp-hoja', { timeout: 15000 });
        };
        await abrir();
        const platillo = () => pag.$$eval('#dp-hoja-cont .dp-r', rs => {
          const r = rs.find(x => /^1 CHILAQUILES SENCILLOS$/.test(x.textContent.trim()));
          return r ? r.className : null;
        });
        assert.ok((await platillo())?.includes('alto'), `de fábrica el platillo va grande: ${await platillo()}`);
        // «Tamaño del platillo» → Normal
        await pag.evaluate(() => {
          const op = [...document.querySelectorAll('#dp-controles .dp-op')].find(d => d.textContent.includes('Tamaño del platillo'));
          [...op.querySelectorAll('button')].find(b => b.textContent.trim() === 'Normal').click();
        });
        await pag.waitForFunction(() => {
          const r = [...document.querySelectorAll('#dp-hoja-cont .dp-r')].find(x => /^1 CHILAQUILES SENCILLOS$/.test(x.textContent.trim()));
          return r && !r.className.includes('alto');
        }, { timeout: 10000 });
        await pag.waitForFunction(() => document.getElementById('dp-estado')?.textContent.includes('Guardado ✓'), { timeout: 10000 });
        assert.strictEqual((await guardado())?.comanda?.producto, 'normal', 'el cambio no llegó a la base');
        // Ticket: quitar el total grande
        await pag.click('[data-dp-doc="cuenta"]');
        await pag.waitForFunction(() => [...document.querySelectorAll('#dp-hoja-cont .dp-r')].some(x => x.textContent.includes('TOTAL')), { timeout: 10000 });
        await pag.evaluate(() => {
          const op = [...document.querySelectorAll('#dp-controles .dp-op')].find(d => d.textContent.includes('Total en letra grande'));
          op.querySelector('input[type=checkbox]').click();
        });
        await pag.waitForFunction(() => {
          const r = [...document.querySelectorAll('#dp-hoja-cont .dp-r')].find(x => x.textContent.includes('TOTAL'));
          return r && !r.className.includes('ancho');
        }, { timeout: 10000 });
        await pag.waitForFunction(() => document.getElementById('dp-estado')?.textContent.includes('Guardado ✓'), { timeout: 10000 });
        assert.strictEqual((await guardado())?.ticket?.totalGrande, false);
        // Recargar: lo elegido sigue ahí
        await pag.reload({ waitUntil: 'networkidle0' });
        await abrir();
        const activo = await pag.evaluate(() => {
          const op = [...document.querySelectorAll('#dp-controles .dp-op')].find(d => d.textContent.includes('Tamaño del platillo'));
          return op.querySelector('button.activo')?.textContent.trim();
        });
        assert.strictEqual(activo, 'Normal', 'tras recargar no se ve lo guardado');
        // Tablet: sin desbordar a lo ancho
        await pag.setViewport({ width: 768, height: 1024 });
        await new Promise(r => setTimeout(r, 300));
        const desborde = await pag.evaluate(() => {
          const s = document.getElementById('cfg-sec-diseno');
          return s.scrollWidth - s.clientWidth;
        });
        assert.ok(desborde <= 2, `la sección se desborda ${desborde}px en tablet`);
        // Volver al diseño de fábrica
        await pag.click('#dp-reset');
        await pag.waitForFunction(() => document.getElementById('dp-estado')?.textContent.includes('Guardado ✓'), { timeout: 10000 });
        assert.deepStrictEqual(await guardado(), normalizarFormato(null), 'no volvió al diseño de fábrica');
        // Al salir, Configuración vuelve a su ancho de siempre.
        const anchos = await pag.evaluate(() => {
          const vc = document.getElementById('vista-config');
          const dentro = vc.style.maxWidth;
          cfgVolver();
          return [dentro, vc.style.maxWidth];
        });
        assert.deepStrictEqual(anchos, ['1100px', '560px']);
        assert.deepStrictEqual(errores, [], 'errores de JavaScript en el panel');
      } finally { await nav.close(); }
    });
  } finally {
    srv?.detener();
    if (previo.rows.length) await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'impresion_formato',$2)
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, previo.rows[0].valor]);
    else await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [NEG]);
    await pool.end();
  }
}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
