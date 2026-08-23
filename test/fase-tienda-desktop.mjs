// Experiencia de la tienda en ESCRITORIO.
//
// La tienda nació móvil: en un monitor era una columna de 760px centrada,
// con un producto por renglón y espacio muerto a los lados. Este cambio la
// adapta al ancho disponible SOLO con CSS -- ni una línea de JavaScript, ni
// un nodo del DOM.
//
// Por eso esta suite tiene dos mitades:
//   a) que el layout de escritorio exista de verdad (rejilla, anchos,
//      carrito lateral, breakpoints);
//   b) que NADA de la compra haya cambiado: mismo estado de carrito, mismos
//      totales, mismos métodos de pago, mismo checkout, mismo seguimiento, y
//      móvil idéntico. Esta mitad es la que importa: un rediseño que se
//      lleve por delante el checkout no vale el ancho ganado.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, '..', 'panel', 'tienda.html'), 'utf8');
const CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
const JS = HTML.slice(HTML.indexOf('<script>'), HTML.lastIndexOf('</script>'));

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Bloques @media por ancho mínimo, en orden de aparición.
//
// Se recorren las llaves a mano en vez de usar una expresión regular
// perezosa: la hoja de estilos mezcla bloques de una sola línea con bloques
// de treinta, y una regex que corte en el primer salto de línea con llave
// devuelve fragmentos partidos -- y pruebas que fallan por el recorte, no
// por el CSS.
function bloquesDesde(min) {
  const marca = `@media(min-width:${min}px){`;
  const encontrados = [];
  let desde = 0;
  for (;;) {
    const i = CSS.indexOf(marca, desde);
    if (i === -1) break;
    let nivel = 0, j = i + marca.length - 1;
    for (; j < CSS.length; j++) {
      if (CSS[j] === '{') nivel++;
      else if (CSS[j] === '}' && --nivel === 0) break;
    }
    encontrados.push(CSS.slice(i + marca.length, j));
    desde = j + 1;
  }
  return encontrados;
}
const desktop = bloquesDesde(1024);
const anchos = bloquesDesde(1280);
const muyAnchos = bloquesDesde(1500);
const layout = desktop.find(b => b.includes('.cat-sec{'));

// ─── a) El layout de escritorio existe ──────────────────────────────────────
t('1. el catálogo usa rejilla de 2 columnas desde 1024px', () => {
  assert.ok(layout, 'ningún bloque de escritorio define .cat-sec');
  assert.match(layout, /\.cat-sec\{[^}]*display:grid/);
  assert.match(layout, /\.cat-sec\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // El título de categoría debe cruzar la fila completa, si no queda de
  // "primera tarjeta" y la rejilla se descuadra.
  assert.match(layout, /\.cat-tit\{[^}]*grid-column:1\/-1/);
});

t('2. en monitores muy anchos son 3 columnas, nunca más', () => {
  const b = muyAnchos.find(x => x.includes('.cat-sec{'));
  assert.ok(b, 'falta el bloque de monitores anchos');
  assert.match(b, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.ok(!/repeat\(4,/.test(CSS), 'cuatro columnas dejan las descripciones cortadas siempre');
});

t('3. el contenedor deja de ser una columna de teléfono', () => {
  // Regla base (móvil primero) intacta y ampliación progresiva en desktop.
  assert.match(CSS, /\.app\{max-width:560px/, 'se perdió el ancho base móvil');
  assert.match(layout, /\.app\{max-width:1180px/);
  const b = anchos.find(x => x.includes('.app{'));
  assert.match(b, /\.app\{max-width:1280px;padding-right:312px\}/);
});

t('4. el carrito lateral solo aparece cuando hay ancho para él', () => {
  // Reservar la franja del carrito antes de 1280 dejaría un hueco vacío al
  // lado del catálogo cada vez que el carrito está vacío.
  assert.ok(!/padding-right:312px/.test(layout),
    'el bloque de 1024px reserva espacio de carrito: deja hueco muerto');
  const b = anchos.find(x => x.includes('.barra{'));
  assert.ok(b, 'falta la presentación lateral del carrito');
  assert.match(b, /\.barra\{[^}]*top:96px/, 'el carrito lateral debe quedar a la vista al hacer scroll');
  assert.match(b, /\.barra\{[^}]*width:280px/);
});

t('5. el carrito lateral es el MISMO botón, no un carrito nuevo', () => {
  // Un solo #btn-carrito en todo el documento, con un solo onclick.
  const botones = [...HTML.matchAll(/id="btn-carrito"/g)];
  assert.strictEqual(botones.length, 1, 'apareció un segundo botón de carrito');
  assert.strictEqual([...HTML.matchAll(/id="carrito-total"/g)].length, 1, 'apareció un segundo total de carrito');
  assert.strictEqual([...HTML.matchAll(/id="carrito-n"/g)].length, 1, 'apareció un segundo contador de carrito');
  assert.match(HTML, /id="btn-carrito" onclick="abrirCarrito\(\)"/);
  // Y el CSS de escritorio solo lo re-presenta: nunca lo duplica ni lo crea.
  assert.ok(!/content:\s*['"]/.test(layout), 'el escritorio está generando contenido propio del carrito');
});

t('6. el checkout de escritorio es más legible, no otro checkout', () => {
  assert.match(layout, /#hoja-checkout,#hoja-carrito\{max-width:640px\}/);
  assert.strictEqual([...HTML.matchAll(/id="hoja-checkout"/g)].length, 1);
  assert.strictEqual([...HTML.matchAll(/id="hoja-carrito"/g)].length, 1);
});

// ─── b) La compra no cambió ────────────────────────────────────────────────
t('7. móvil intacto: las reglas base siguen siendo las de siempre', () => {
  assert.match(CSS, /\.prod\{display:flex;gap:12px;padding:12px/, 'cambió la tarjeta base (móvil)');
  assert.match(CSS, /\.barra\{position:fixed;left:0;right:0;bottom:0/, 'cambió la barra base (móvil)');
  assert.match(CSS, /\.hoja\{position:fixed;left:0;right:0;bottom:0/, 'cambió la hoja base (móvil)');
  assert.match(CSS, /\.cats\{position:sticky;top:0/, 'cambió la navegación base de categorías');
  // Y ningún ajuste de escritorio se coló fuera de un @media.
  const fueraDeMedia = CSS.split(/@media/)[0];
  assert.ok(!/grid-template-columns:repeat\(2/.test(fueraDeMedia),
    'la rejilla de escritorio se aplicó también en móvil');
});

t('8. no hay overlays invisibles que se coman los clicks', () => {
  // Contrato ya fijado por fase-tienda-overlay-desktop; aquí se vuelve a
  // exigir porque este cambio toca justo el escritorio.
  const hoja = desktop.find(b => b.includes('.hoja{') && b.includes('.hoja.on{'));
  assert.ok(hoja, 'desapareció el bloque desktop de las hojas');
  assert.ok(/pointer-events:\s*none/.test(hoja.split('.hoja.on')[0]), 'la hoja cerrada volvió a ser clickeable');
  assert.ok(/pointer-events:\s*auto/.test(hoja.slice(hoja.indexOf('.hoja.on'))), 'la hoja abierta perdió los clicks');
  // El nuevo layout no introduce ningún elemento a pantalla completa.
  for (const bloque of [...desktop, ...anchos, ...muyAnchos]) {
    assert.ok(!/position:fixed;inset:0/.test(bloque), 'una regla de escritorio crea una capa a pantalla completa');
  }
});

t('9. nada quedó fuera de alcance del teclado ni del puntero', () => {
  // Se examinan los bloques de escritorio NUEVOS. El bloque de las hojas
  // queda fuera a propósito: su pointer-events:none es la corrección del
  // overlay invisible y lo verifica la prueba 8.
  const nuevos = [...desktop, ...anchos, ...muyAnchos].filter(b => !b.includes('.hoja{'));
  assert.ok(nuevos.length >= 3, 'no se encontraron los bloques de escritorio nuevos');
  for (const bloque of nuevos) {
    assert.ok(!/pointer-events:\s*none/.test(bloque),
      'una regla de escritorio apaga los clicks de algo');
    assert.ok(!/user-select:\s*none/.test(bloque));
    assert.ok(!/visibility:\s*hidden/.test(bloque));
  }
  // La barra base apaga los clicks del degradado pero los devuelve a sus
  // hijos: ese contrato debe seguir intacto.
  assert.match(CSS, /\.barra\{[^}]*pointer-events:none\}/);
  assert.match(CSS, /\.barra>\*\{pointer-events:auto\}/);
});

t('10. el estado del carrito y los totales son un solo cálculo', () => {
  // Un único acumulador de carrito y un único subtotal en toda la página:
  // si escritorio hubiera duplicado la lógica, habría dos.
  assert.strictEqual([...JS.matchAll(/function\s+abrirCarrito\s*\(/g)].length, 1);
  assert.strictEqual([...JS.matchAll(/const dinero = /g)].length, 1,
    'hay más de un formateador de dinero: los totales podrían divergir');
  assert.strictEqual([...JS.matchAll(/function\s+totalLocal\s*\(/g)].length, 1,
    'hay más de un cálculo de total');
  // Dos filas de "Subtotal" (resumen del carrito y totales del checkout) son
  // las de siempre; una tercera significaría una vista propia de escritorio.
  assert.strictEqual([...JS.matchAll(/<span>Subtotal<\/span>/g)].length, 2,
    'cambió la cantidad de filas de subtotal: escritorio pudo haber duplicado una vista');
  // Y ninguna rama del código decide por ancho de pantalla.
  assert.ok(!/matchMedia|innerWidth|clientWidth\s*>/.test(JS),
    'el JavaScript empezó a ramificar por tamaño de pantalla: móvil y escritorio dejarían de compartir cálculo');
});

t('11. métodos de pago: los mismos, y los decide el backend', () => {
  assert.match(JS, /METODOS = r\.metodos \|\| \[\]/, 'los métodos de pago dejaron de venir del backend');
  assert.ok(!/METODOS\s*=\s*\[\s*['"]/.test(JS), 'aparecieron métodos de pago escritos en el cliente');
  assert.strictEqual([...JS.matchAll(/function\s+elegirPago\s*\(/g)].length, 1);
});

t('12. compra de invitado, checkout y seguimiento intactos', () => {
  assert.match(JS, /metodoPago: CK\.metodoPago/, 'cambió el cuerpo del checkout');
  assert.match(JS, /\/seguimiento\/\$\{encodeURIComponent\(r\.trackingToken\)\}/, 'se perdió el enlace de seguimiento');
  assert.match(JS, /\/api\/tienda\/seguimiento\/'/, 'se perdió la consulta de estado de pago');
  // El cliente no exige cuenta en ningún punto del flujo.
  assert.ok(!/localStorage\.getItem\(['"]token/.test(JS), 'apareció un requisito de sesión en la tienda');
});

t('13. los breakpoints van en escalera y no se pisan', () => {
  const orden = [...CSS.matchAll(/@media\(min-width:(\d+)px\)/g)].map(m => Number(m[1]));
  const desktopIdx = orden.indexOf(1024);
  assert.ok(desktopIdx >= 0, 'falta el breakpoint de escritorio');
  // Los ajustes progresivos (1280, 1500) deben venir DESPUÉS del de 1024,
  // si no el más específico pierde por orden de cascada.
  assert.ok(orden.lastIndexOf(1024) < orden.indexOf(1280), '1280 debe ir después de 1024');
  assert.ok(orden.indexOf(1280) < orden.indexOf(1500), '1500 debe ir después de 1280');
});

t('14. la foto del producto conserva proporción fija en la rejilla', () => {
  // Sin alto fijo, dos tarjetas de la misma fila con y sin foto miden
  // distinto y la rejilla queda dispareja.
  assert.match(layout, /\.prod-img\{width:104px;height:104px\}/);
  assert.match(CSS, /\.prod-img\{width:82px;height:82px;[^}]*object-fit:cover/, 'cambió la foto en móvil');
  assert.match(HTML, /class="prod-img" src="\$\{esc\(p\.imagen\)\}" alt="" loading="lazy"/,
    'la foto del catálogo perdió el lazy loading');
});

console.log(`\n═══ fase-tienda-desktop: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
