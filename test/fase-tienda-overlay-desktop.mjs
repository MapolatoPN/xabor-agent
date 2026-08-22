// Overlay invisible del checkout en ESCRITORIO — regresión fijada.
//
// En @media(min-width:1024px) las hojas (#hoja-carrito / #hoja-checkout)
// cerradas quedan CENTRADAS con opacity:0. Un elemento con opacity:0 sigue
// recibiendo clicks: sin pointer-events:none, dos cajas invisibles de
// 560px x 86vh en z-index 51 tapaban el centro de la tienda en desktop y
// se comían los clicks del menú y del CTA. En móvil no ocurre porque el
// estado cerrado vive fuera del viewport (translateY(101%)).
//
// El assert es estructural sobre la hoja de estilos servida: dentro del
// bloque desktop, la hoja cerrada debe ser pointer-events:none y la
// abierta (.on) pointer-events:auto.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, '..', 'panel', 'tienda.html'), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// El bloque desktop de LAS HOJAS (hay varios @media 1024px en la página;
// se toma el que define .hoja y .hoja.on).
const bloques = [...HTML.matchAll(/@media\(min-width:1024px\)\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
const bloque = bloques.find((b) => b.includes('.hoja{') && b.includes('.hoja.on{'));
assert.ok(bloque, 'ningun bloque desktop define la hoja (.hoja/.hoja.on)');

t('1. la hoja cerrada en desktop no intercepta clicks (pointer-events:none junto a opacity:0)', () => {
  const reglaCerrada = bloque.split('.hoja.on')[0];
  assert.ok(/opacity:\s*0/.test(reglaCerrada), 'la hoja cerrada ya no es opacity:0 (revisar si este test sigue aplicando)');
  assert.ok(/pointer-events:\s*none/.test(reglaCerrada),
    'la hoja cerrada es un overlay invisible clickeable en desktop (falta pointer-events:none)');
});

t('2. la hoja abierta (.on) recupera los clicks (pointer-events:auto)', () => {
  const reglaAbierta = bloque.slice(bloque.indexOf('.hoja.on'));
  assert.ok(/pointer-events:\s*auto/.test(reglaAbierta),
    'la hoja abierta quedaria sin clicks (falta pointer-events:auto en .hoja.on)');
});

t('3. el velo conserva su propio contrato (none cerrado, auto abierto)', () => {
  assert.ok(/\.velo\{[^}]*pointer-events:none/.test(HTML), 'el velo cerrado debe ser pointer-events:none');
  assert.ok(/\.velo\.on\{[^}]*pointer-events:auto/.test(HTML), 'el velo abierto debe ser pointer-events:auto');
});

console.log(`\n═══ fase-tienda-overlay-desktop: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
