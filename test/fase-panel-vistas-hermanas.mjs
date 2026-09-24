// Las vistas del panel (id="vista-*") son HERMANAS: ninguna vive dentro de
// otra. mostrarTab esconde todas menos una, así que una vista anidada en otra
// queda en blanco aunque su propio display diga "block".
//
// Incidente del 2026-09-24: a la sección de Facturación de Configuración le
// faltó el </div> que cierra vista-config, y Repartidores, Envíos, Clientes,
// Rewards, Cotizaciones y Usuarios quedaron dentro de Configuración: en
// producción se abrían en blanco. Un conteo de etiquetas en el texto no lo
// ve con claridad; aquí se arma el DOM real con Chrome (sin ejecutar el
// JavaScript del panel) y se revisa el árbol.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await navegador.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const arbol = await page.evaluate(() => {
    const vistaContenedora = (el) => { for (let n = el.parentElement; n; n = n.parentElement) if (/^vista-/.test(n.id)) return n.id; return null; };
    const vistas = [...document.querySelectorAll('[id^="vista-"]')];
    return {
      total: vistas.length,
      anidadas: vistas.map(v => [v.id, vistaContenedora(v)]).filter(([, padre]) => padre).map(([id, padre]) => `${id} dentro de ${padre}`),
      fueraDeSuContenedor: vistas.filter(v => !v.closest('main, #vistas-extra')).map(v => v.id),
      // Lo que tiene que verse desde cualquier pantalla: si queda dentro de
      // <main> o #vistas-extra, se esconde con ellos (el mismo incidente dejó
      // el cobro y la barra del celular dentro de #vistas-extra, oculto en el
      // tablero de Pedidos).
      atrapados: ['bottom-nav', 'mas-sheet', 'btn-confirmar-cobro']
        .filter(id => { const el = document.getElementById(id); return !el || !!el.closest('main, #vistas-extra'); }),
    };
  });

  await t('se leyeron las vistas del panel', () => {
    assert.ok(arbol.total >= 15, `pocas vistas: ${arbol.total}`);
  });
  await t('ninguna vista vive dentro de otra vista', () => {
    assert.deepStrictEqual(arbol.anidadas, [], `vistas anidadas: ${arbol.anidadas.join('; ')}`);
  });
  await t('todas las vistas cuelgan de <main> o de #vistas-extra', () => {
    assert.deepStrictEqual(arbol.fueraDeSuContenedor, [], `fuera de lugar: ${arbol.fueraDeSuContenedor.join(', ')}`);
  });
  await t('el cobro y la barra del celular no quedaron dentro de un contenedor que se oculta', () => {
    assert.deepStrictEqual(arbol.atrapados, [], `atrapados (o ausentes): ${arbol.atrapados.join(', ')}`);
  });
} finally {
  await navegador.close();
}
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
