// El scroll de la tienda no se mueve solo.
//
// BUG REAL, medido en producción (xabor.mx/t/nonna-maye, SHA 182b318):
// bajando con la rueda, la página saltaba HACIA ARRIBA. La instrumentación
// capturó la secuencia exacta:
//
//   t=46963  scrollIntoView  y=1269  el=".cat-chip on"  {inline:center, block:nearest}
//   t=47038  RETROCESO       1258 -> 1210
//   t=47506  efecto          delta = -59
//
// Causa, en dos eslabones:
//
//   1. `#contenido{overflow:hidden}` (puesto para redondear esquinas) hace
//      que `position:sticky` de la barra de categorías resuelva contra esa
//      caja en vez del viewport. Medido: con overflow:hidden la barra queda
//      en top=-724; con overflow:visible, en top=0.
//   2. El callback del IntersectionObserver llamaba
//      `chip.scrollIntoView({inline:'center', block:'nearest'})` para centrar
//      el chip activo. scrollIntoView desplaza TODOS los ancestros
//      desplazables, incluido el documento. Mientras la barra estuvo pegada
//      arriba el chip siempre era visible y `block:'nearest'` no hacía nada;
//      en cuanto la barra se fue de pantalla, el navegador tiró del documento
//      hacia arriba para mostrarlo.
//
// Esta suite corre un navegador DE VERDAD (puppeteer, ya en el proyecto) y
// hace scroll real. Un test estático no habría visto nada: el HTML estaba
// perfecto, lo que fallaba era el comportamiento.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const HTML = readFileSync(join(__dirname, '..', 'panel', 'tienda.html'), 'utf8').replace(/\r\n/g, '\n');

const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const PUERTO = process.env.TEST_PORT_SCROLL || '4231';
const SLUG = 'scroll-test';
const suf = Date.now().toString().slice(-6);

async function del(sql, params) { try { await pool.query(sql, params); } catch { /* ignorado */ } }
async function limpiar() {
  await del(`DELETE FROM tienda_productos WHERE negocio_id = $1 AND producto_id IN
               (SELECT id FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'SC %')`, [NEG]);
  await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'SC %'`, [NEG]);
  await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'SC %'`, [NEG]);
  await del(`DELETE FROM tienda_config WHERE negocio_id = $1 AND slug_publico = $2`, [NEG, SLUG]);
}

// Catálogo largo y con varias categorías: hace falta altura real para que el
// observer cruce fronteras mientras se hace scroll.
async function sembrar() {
  for (let c = 0; c < 5; c++) {
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`,
      [NEG, `SC Categoria ${c} ${suf}`, 800 + c]);
    for (let p = 0; p < 6; p++) {
      const { rows: [prod] } = await pool.query(
        `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, descripcion, precio, disponible, agotado, orden)
         VALUES ($1,$2,$3,$4,$5,TRUE,FALSE,$6) RETURNING id`,
        [NEG, cat.id, `SC Producto ${c}-${p} ${suf}`,
         'Descripcion suficientemente larga para que la tarjeta tenga altura real y el catalogo se pueda recorrer.',
         100 + c * 10 + p, p]);
      await pool.query(
        `INSERT INTO tienda_productos (negocio_id, producto_id, publicado, orden) VALUES ($1,$2,TRUE,$3)`,
        [NEG, prod.id, p]);
    }
  }
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, descripcion, modalidades, publicada_at)
     VALUES ($1,'publicada',$2,'Tienda scroll','Prueba de scroll','["recoger"]'::jsonb, NOW())
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, publicada_at=NOW()`,
    [NEG, SLUG]);
}

// Instrumentación que se inyecta ANTES de que cargue la página: registra
// cualquier movimiento del scroll hacia atrás y quién lo provocó.
const INSTRUMENTACION = `
  window.__mov = { retrocesos: [], scrollIntoView: [], focos: [], scrollTo: [] };
  (() => {
    const siv = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (o) {
      window.__mov.scrollIntoView.push({ el: this.className || this.tagName, opt: JSON.stringify(o || null), y: Math.round(scrollY) });
      return siv.call(this, o);
    };
    const st = window.scrollTo.bind(window);
    window.scrollTo = function (...a) { window.__mov.scrollTo.push({ args: JSON.stringify(a), y: Math.round(scrollY) }); return st(...a); };
    let ultimo = 0;
    addEventListener('scroll', () => {
      const y = scrollY;
      if (y < ultimo - 10 && !window.__permitirRetroceso) {
        window.__mov.retrocesos.push({ desde: Math.round(ultimo), hasta: Math.round(y) });
      }
      ultimo = y;
    }, { passive: true });
    addEventListener('focusin', e => window.__mov.focos.push(e.target.className || e.target.tagName), true);
  })();
`;

let servidor, navegador;
try {
  await limpiar();
  await sembrar();
  servidor = await arrancarServidor(
    { PORT: PUERTO, XABOR_TIENDA_LIMITE_LECTURA: '500', XABOR_TIENDA_LIMITE_COTIZAR: '500', XABOR_TIENDA_LIMITE_CHECKOUT: '500' },
    { timeoutMs: 90000 });
  navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  const abrir = async (ancho, alto) => {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: ancho, height: alto });
    await pagina.evaluateOnNewDocument(INSTRUMENTACION);
    await pagina.goto(`http://localhost:${PUERTO}/t/${SLUG}`, { waitUntil: 'networkidle0' });
    await pagina.waitForSelector('.cat-sec');
    return pagina;
  };

  // Rueda de ratón REAL, en pasos, cruzando fronteras de categoría.
  const rodar = async (pagina, pasos = 14, delta = 220) => {
    for (let i = 0; i < pasos; i++) {
      await pagina.mouse.move(300, 400);
      await pagina.mouse.wheel({ deltaY: delta });
      await new Promise(r => setTimeout(r, 90));
    }
    await new Promise(r => setTimeout(r, 700));   // deja terminar cualquier smooth scroll
  };

  const ANCHOS = [[1536, 864], [1440, 900], [1024, 768]];

  for (const [ancho, alto] of ANCHOS) {
    await t(`1. ${ancho}x${alto}: bajar con la rueda nunca devuelve la página hacia arriba`, async () => {
      const pagina = await abrir(ancho, alto);
      await rodar(pagina);
      const r = await pagina.evaluate(() => ({
        mov: window.__mov, y: Math.round(scrollY),
        chip: document.querySelector('.cat-chip.on')?.textContent.trim(),
      }));
      assert.deepStrictEqual(r.mov.retrocesos, [],
        `la página retrocedió sola: ${JSON.stringify(r.mov.retrocesos)}`);
      assert.deepStrictEqual(r.mov.scrollIntoView, [],
        `algo llamó scrollIntoView durante el scroll: ${JSON.stringify(r.mov.scrollIntoView)}`);
      assert.deepStrictEqual(r.mov.scrollTo, [], 'algo llamó window.scrollTo durante el scroll');
      assert.ok(r.y > 400, `apenas se avanzó (y=${r.y}): el scroll quedó trabado`);
      await pagina.close();
    });
  }

  await t('2. la barra de categorías queda pegada arriba en escritorio', async () => {
    const pagina = await abrir(1536, 864);
    await rodar(pagina, 8);
    const r = await pagina.evaluate(() => {
      const cats = document.querySelector('.cats');
      const ancestros = [];
      let e = cats.parentElement;
      while (e && e !== document.documentElement) {
        const o = getComputedStyle(e).overflow;
        if (o !== 'visible') ancestros.push(`${e.id || e.className}:${o}`);
        e = e.parentElement;
      }
      return { top: Math.round(cats.getBoundingClientRect().top), position: getComputedStyle(cats).position, ancestros };
    });
    // Es el invariante que evita que vuelva el bug: si algún ancestro recorta
    // el overflow, sticky deja de funcionar y el chip se va de pantalla.
    assert.deepStrictEqual(r.ancestros, [],
      `un ancestro de .cats recorta el overflow y rompe el sticky: ${r.ancestros.join(', ')}`);
    assert.strictEqual(r.position, 'sticky');
    assert.strictEqual(r.top, 0, `la barra de categorías no quedó pegada (top=${r.top})`);
    await pagina.close();
  });

  await t('3. la categoría activa se actualiza sin mover el scroll', async () => {
    const pagina = await abrir(1536, 864);
    const chipInicial = await pagina.evaluate(() => document.querySelector('.cat-chip.on')?.textContent.trim());
    await rodar(pagina, 12);
    const r = await pagina.evaluate(() => ({
      chip: document.querySelector('.cat-chip.on')?.textContent.trim(),
      retrocesos: window.__mov.retrocesos, siv: window.__mov.scrollIntoView,
    }));
    assert.notStrictEqual(r.chip, chipInicial, 'la categoría activa no cambió: el observer no está haciendo su trabajo');
    assert.deepStrictEqual(r.retrocesos, [], 'resaltar la categoría movió el scroll');
    assert.deepStrictEqual(r.siv, [], 'resaltar la categoría llamó scrollIntoView');
    await pagina.close();
  });

  await t('4. agregar al carrito no devuelve la página hacia arriba', async () => {
    const pagina = await abrir(1536, 864);
    await rodar(pagina, 10);
    const antes = await pagina.evaluate(() => Math.round(scrollY));
    await pagina.evaluate(() => {
      const p = CATALOGO[2].productos[0];
      CARRITO.push({ productoId: p.id, nombre: p.nombre, cantidad: 1, precio: p.precio, modificadores: [], notas: '' });
      refrescarBarra();
    });
    await new Promise(r => setTimeout(r, 500));
    const r = await pagina.evaluate(() => ({ y: Math.round(scrollY), retrocesos: window.__mov.retrocesos,
      total: document.getElementById('carrito-total').textContent }));
    assert.deepStrictEqual(r.retrocesos, [], 'actualizar el carrito movió el scroll');
    assert.strictEqual(r.y, antes, `el scroll se movió al actualizar el carrito: ${antes} -> ${r.y}`);
    assert.ok(/\d/.test(r.total), 'el total del carrito no se actualizó');
    await pagina.close();
  });

  await t('5. abrir y cerrar el carrito conserva la posición', async () => {
    const pagina = await abrir(1536, 864);
    await rodar(pagina, 10);
    const antes = await pagina.evaluate(() => Math.round(scrollY));
    await pagina.evaluate(() => { abrirCarrito(); });
    await new Promise(r => setTimeout(r, 400));
    await pagina.evaluate(() => { cerrarTodo(); });
    await new Promise(r => setTimeout(r, 400));
    const r = await pagina.evaluate(() => ({ y: Math.round(scrollY), hojas: document.querySelectorAll('.hoja.on').length }));
    assert.strictEqual(r.hojas, 0);
    assert.ok(Math.abs(r.y - antes) <= 2, `abrir/cerrar el carrito movió el scroll: ${antes} -> ${r.y}`);
    await pagina.close();
  });

  await t('6. ningún foco automático se lleva al usuario durante el scroll', async () => {
    const pagina = await abrir(1440, 900);
    await rodar(pagina, 12);
    const focos = await pagina.evaluate(() => window.__mov.focos);
    assert.deepStrictEqual(focos, [], `hubo foco programático durante el scroll: ${JSON.stringify(focos)}`);
    await pagina.close();
  });

  await t('7. pulsar una categoría SÍ navega (es la única forma de mover el scroll)', async () => {
    const pagina = await abrir(1536, 864);
    await pagina.evaluate(() => { window.__permitirRetroceso = true; });   // aquí el movimiento es querido
    const antes = await pagina.evaluate(() => Math.round(scrollY));
    await pagina.evaluate(() => { document.querySelectorAll('.cat-chip')[3].click(); });
    await new Promise(r => setTimeout(r, 900));
    const despues = await pagina.evaluate(() => Math.round(scrollY));
    assert.ok(despues > antes + 200, `el click en la categoría no llevó a la sección (${antes} -> ${despues})`);
    // Y la sección aterriza DEBAJO de la barra pegada, no tapada por ella.
    const tapada = await pagina.evaluate(() => {
      const cats = document.querySelector('.cats').getBoundingClientRect();
      const sec = document.querySelectorAll('.cat-sec')[3].getBoundingClientRect();
      return sec.top < cats.bottom - 2;
    });
    assert.ok(!tapada, 'la barra de categorías tapa el título de la sección a la que se navegó');
    await pagina.close();
  });

  await t('8. móvil intacto: el catálogo sigue en una columna y la barra abajo', async () => {
    const pagina = await abrir(390, 844);
    await rodar(pagina, 8, 160);
    const r = await pagina.evaluate(() => {
      const s = document.querySelector('.cat-sec');
      return { display: getComputedStyle(s).display, barraBottom: getComputedStyle(document.getElementById('barra')).bottom,
        barraPos: getComputedStyle(document.getElementById('barra')).position,
        retrocesos: window.__mov.retrocesos, siv: window.__mov.scrollIntoView,
        scrollHorizontal: document.documentElement.scrollWidth > innerWidth };
    });
    assert.strictEqual(r.display, 'block', 'la rejilla de escritorio se aplicó en móvil');
    assert.strictEqual(r.barraPos, 'fixed');
    assert.strictEqual(r.barraBottom, '0px', 'la barra del carrito dejó de ir abajo en móvil');
    assert.strictEqual(r.scrollHorizontal, false);
    assert.deepStrictEqual(r.retrocesos, [], 'móvil también retrocede');
    await pagina.close();
  });

  await t('9. recargar a media página no produce un salto inesperado', async () => {
    const pagina = await abrir(1536, 864);
    await rodar(pagina, 10);
    const antes = await pagina.evaluate(() => Math.round(scrollY));
    await pagina.evaluate(() => { window.__permitirRetroceso = true; });
    await pagina.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 800));
    const r = await pagina.evaluate(() => ({ y: Math.round(scrollY), siv: window.__mov.scrollIntoView, restauracion: history.scrollRestoration }));
    // El navegador puede restaurar o no la posición; lo que NO puede pasar es
    // que la página se mueva sola DESPUÉS de asentarse.
    const asentado = r.y;
    await new Promise(r2 => setTimeout(r2, 900));
    const final = await pagina.evaluate(() => Math.round(scrollY));
    assert.strictEqual(final, asentado, `la página siguió moviéndose tras la recarga: ${asentado} -> ${final}`);
    assert.deepStrictEqual(r.siv, [], 'la recarga disparó un scrollIntoView');
    assert.ok(antes > 0);
    await pagina.close();
  });

  // ─── Contratos estáticos que evitan la reincidencia ───────────────────────
  await t('10. el código ya no centra el chip con scrollIntoView', async () => {
    const observador = HTML.slice(HTML.indexOf('function observarCategorias'), HTML.indexOf('// ─── Producto y modificadores'));
    assert.ok(!/scrollIntoView/.test(observador),
      'volvió el scrollIntoView dentro del callback del observer: es exactamente el bug');
    assert.ok(/scrollTo\(\{ left:/.test(HTML), 'el chip activo debe centrarse solo en horizontal');
    // irACategoria SÍ puede usarlo: ahí el movimiento lo pidió el usuario.
    const ir = HTML.slice(HTML.indexOf('function irACategoria'), HTML.indexOf('function centrarChipActivo'));
    assert.ok(/scrollIntoView/.test(ir), 'irACategoria debe seguir navegando a la sección');
  });

  await t('11. ningún ancestro del sticky recorta el overflow (en el CSS)', async () => {
    const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
    const contenido = css.match(/#contenido\{[^}]*\}/g) || [];
    for (const regla of contenido) {
      assert.ok(!/overflow:\s*hidden/.test(regla),
        `#contenido vuelve a recortar el overflow y eso rompe el sticky: ${regla}`);
    }
    assert.match(css, /\.portada\{[^}]*border-radius:17px 17px 0 0;overflow:hidden\}/,
      'las esquinas deben redondearse en la portada, que no es ancestro de nada pegajoso');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (navegador) await navegador.close().catch(() => {});
  if (servidor) servidor.detener();
  await limpiar();
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
