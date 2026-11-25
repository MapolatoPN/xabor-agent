// ─── Fase 2: el panel (Menú › Tipo y Rappi › Opciones sin clasificar) ──────
//
// Sin Postgres ni servidor. Lo que se protege:
//   · la etiqueta del script nuevo lleva la huella de su contenido (?v=), así
//     la caché del navegador no sirve una versión vieja tras desplegar;
//   · el editor del producto tiene el selector «Tipo» con las cinco claves de
//     la base, lo precarga con el tipo guardado y lo manda al guardar;
//   · «Opciones sin clasificar»: oculta sin la bandera; los nombres que manda
//     Rappi se pintan como TEXTO (los escribe otra empresa); Guardar manda el
//     producto y la opción elegidos; Quitar llama a la ruta del emparejamiento.
//
// Uso: node test/fase-lineas-estructuradas-panel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TIPOS_PRODUCTO } from '../src/services/lineasEstructuradas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
const js = readFileSync(join(__dirname, '..', 'panel', 'rappi-sin-clasificar.js'), 'utf8');

let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  try { await fn(); console.log('  OK  ' + nombre); pasadas++; }
  catch (e) { console.log('FALLO ' + nombre + ': ' + String(e.message).split('\n')[0]); fallidas++; }
}

await t('la etiqueta del script lleva la huella de su contenido', () => {
  const huella = createHash('sha256').update(js).digest('hex').slice(0, 8);
  const m = panel.match(/<script src="\/rappi-sin-clasificar\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'falta la etiqueta del script');
  assert.equal(m[1], huella, `actualiza la etiqueta a ?v=${huella}`);
});

await t('el selector «Tipo» tiene las mismas claves que la base, en el mismo orden', () => {
  const m = panel.match(/const TIPOS_PRODUCTO_PANEL = \{([^}]+)\};/);
  assert.ok(m, 'falta TIPOS_PRODUCTO_PANEL');
  const claves = [...m[1].matchAll(/(\w+):\s*'/g)].map((x) => x[1]);
  assert.deepEqual(claves, [...TIPOS_PRODUCTO]);
  assert.match(panel, /<select id="mp-tipo"[^>]*>\$\{Object\.entries\(TIPOS_PRODUCTO_PANEL\)/);
  assert.match(panel, /k === datos\.tipo \? 'selected' : ''/, 'precarga el tipo guardado');
});

await t('editar un producto precarga su tipo y guardar lo manda (PATCH y POST)', () => {
  // Cada línea que LLAMA al editor (no la que lo define) debe pasar el tipo.
  const llamadas = panel.split('\n').filter((l) => l.includes('abrirModalEditarProducto(') && !l.includes('function abrirModalEditarProducto('));
  assert.ok(llamadas.length >= 2, 'no se encontraron las llamadas al editor');
  for (const a of llamadas) assert.match(a, /p\.tipo\s*\|\|\s*'platillo'/, `una llamada no pasa el tipo: ${a.trim().slice(0, 80)}`);
  const guardar = panel.slice(panel.indexOf('async function guardarProducto('), panel.indexOf('// REWARDS — Módulo de lealtad'));
  assert.match(guardar, /getElementById\('mp-tipo'\)/);
  const cuerpos = [...guardar.matchAll(/JSON\.stringify\(\{([^}]+)\}\)/g)].map((x) => x[1]);
  assert.equal(cuerpos.length, 2);
  for (const c of cuerpos) assert.match(c, /\btipo\b/);
});

await t('el script pinta solo con textContent (ningún innerHTML)', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js));
});

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const pag = await navegador.newPage();
  const MALO = '<img src=x onerror="window.__xss=1">';
  await pag.setContent('<!doctype html><html><body><div id="rappi-sin-clasificar" style="display:none"></div></body></html>');
  await pag.evaluate(() => {
    window.__llamadas = [];
    window.__respuesta = { activo: false };
    window.confirm = () => true;
    window.apiFetch = async (url, opts = {}) => {
      window.__llamadas.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      const cuerpo = (opts.method || 'GET') === 'GET' ? window.__respuesta : { ok: true, rehechos: 3 };
      return new Response(JSON.stringify(cuerpo), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  });
  await pag.addScriptTag({ content: js });
  const visible = () => pag.$eval('#rappi-sin-clasificar', (n) => n.style.display !== 'none');

  await t('sin la bandera, la sección no se muestra', async () => {
    await pag.evaluate(() => window.XaborRappiSinClasificar.cargar());
    assert.equal(await visible(), false);
  });

  await t('con datos: se muestran como texto, sin ejecutar nada', async () => {
    await pag.evaluate((malo) => {
      window.__respuesta = {
        activo: true,
        productos: [{ producto_rappi: `Combo ${malo}`, veces: 2 }],
        opciones: [{ producto_rappi: 'Chilaquiles', producto_id: 10, producto: 'Chilaquiles', opcion_rappi: `Salsa ${malo}`, veces: 5,
          elegibles: [{ opcion_id: 1003, texto: 'Salsa: Mole' }, { opcion_id: 1001, texto: 'Salsa: Verde' }] }],
        emparejamientos: [{ id: 77, producto_rappi: 'enchis', opcion_rappi: '', producto: 'Enchiladas', grupo: null, opcion: null }],
        menu: [{ id: 10, nombre: 'Chilaquiles' }, { id: 14, nombre: `Enchiladas ${malo}` }],
      };
    }, MALO);
    await pag.evaluate(() => window.XaborRappiSinClasificar.cargar());
    assert.equal(await visible(), true);
    const r = await pag.evaluate(() => ({
      img: document.querySelectorAll('#rappi-sin-clasificar img').length,
      xss: window.__xss,
      texto: document.getElementById('rappi-sin-clasificar').textContent,
    }));
    assert.equal(r.img, 0);
    assert.equal(r.xss, undefined);
    assert.ok(r.texto.includes('<img src=x'), 'el nombre se ve literal');
  });

  await t('Guardar una opción manda producto, opción de Rappi y opción del menú', async () => {
    await pag.evaluate(() => { window.__llamadas = []; });
    await pag.evaluate(() => {
      const filas = [...document.querySelectorAll('#rappi-sin-clasificar select')];
      const sel = filas.find((s) => [...s.options].some((o) => o.value === '1003'));
      sel.value = '1003';
      sel.parentElement.querySelector('button').click();
    });
    await new Promise((r) => setTimeout(r, 100));
    const put = await pag.evaluate(() => window.__llamadas.find((l) => l.method === 'PUT'));
    assert.equal(put.url, '/api/admin/lineas/rappi/emparejamientos');
    assert.deepEqual(put.body, { producto_rappi: 'Chilaquiles', opcion_rappi: 'Salsa <img src=x onerror="window.__xss=1">', producto_id: 10, opcion_id: 1003 });
    const aviso = await pag.evaluate(() => document.getElementById('rappi-sin-clasificar').textContent);
    assert.match(aviso, /Pedidos actualizados: 3/);
  });

  await t('Guardar sin elegir no llama al servidor', async () => {
    await pag.evaluate(() => window.XaborRappiSinClasificar.cargar());
    await pag.evaluate(() => { window.__llamadas = []; });
    await pag.evaluate(() => {
      const sel = [...document.querySelectorAll('#rappi-sin-clasificar select')].find((s) => [...s.options].some((o) => o.value === '14'));
      sel.value = '';
      sel.parentElement.querySelector('button').click();
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await pag.evaluate(() => window.__llamadas.length), 0);
  });

  await t('Quitar llama a la ruta del emparejamiento con su id', async () => {
    await pag.evaluate(() => { window.__llamadas = []; });
    await pag.evaluate(() => {
      const b = [...document.querySelectorAll('#rappi-sin-clasificar button')].find((x) => x.textContent === 'Quitar');
      b.click();
    });
    await new Promise((r) => setTimeout(r, 100));
    const del = await pag.evaluate(() => window.__llamadas.find((l) => l.method === 'DELETE'));
    assert.equal(del?.url, '/api/admin/lineas/rappi/emparejamientos/77');
  });
} finally {
  await navegador.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
