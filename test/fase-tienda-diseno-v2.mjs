// Diseño v2 de la tienda en línea, encendido por negocio.
//
// Lo que esta suite protege, en orden de importancia:
//   a) que un negocio SIN configuración siga viendo la tienda clásica
//      idéntica: todo el CSS nuevo va bajo .tema-v2 y todo el JS nuevo detrás
//      de esV2();
//   b) que la compra no cambie: mismos ids, mismos manejadores, mismos
//      inputs de modificadores en los dos diseños;
//   c) que lo que viaja por la API pública esté filtrado (tema, tipografía y
//      número de WhatsApp por lista blanca).
// No necesita base de datos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { normalizarDiseno, DISENO_CLASICO } from '../src/services/tiendaDiseno.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, '..', 'panel', 'tienda.html'), 'utf8').replace(/\r\n/g, '\n');
const CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
const JS = HTML.slice(HTML.indexOf('<script>'), HTML.lastIndexOf('</script>'));
const RUTAS = readFileSync(join(__dirname, '..', 'src', 'services', 'tiendaRutasCore.js'), 'utf8');

let pasadas = 0, fallidas = 0;
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}

// ── a) normalización del diseño ─────────────────────────────────────────────
t('1. sin configuración o con basura: diseño clásico', () => {
  for (const v of [undefined, null, '', 'no-json', '[]', '{}', 42, '{"tema":"rosa"}', { tema: 'clasico' }]) {
    assert.deepStrictEqual(normalizarDiseno(v), { ...DISENO_CLASICO }, `valor ${JSON.stringify(v)}`);
  }
});

t('2. v2 válido desde texto JSON (como vive en configuracion.valor)', () => {
  const d = normalizarDiseno('{"tema":"v2","tipografia":"redonda","whatsappEventos":"+52 878 795 4683"}');
  assert.deepStrictEqual(d, { tema: 'v2', tipografia: 'redonda', eventos: { whatsapp: '528787954683' } });
});

t('3. listas blancas: tipografía desconocida -> sistema; WhatsApp inválido -> sin eventos', () => {
  const d = normalizarDiseno({ tema: 'v2', tipografia: '<script>', whatsappEventos: '123' });
  assert.strictEqual(d.tipografia, 'sistema');
  assert.strictEqual(d.eventos, null);
  const largo = normalizarDiseno({ tema: 'v2', whatsappEventos: '1'.repeat(16) });
  assert.strictEqual(largo.eventos, null);
});

t('4. la API pública expone el diseño ya normalizado', () => {
  assert.match(RUTAS, /import \{ disenoTienda \} from '\.\/tiendaDiseno\.js'/);
  assert.match(RUTAS, /const diseno = await disenoTienda\(tienda\.negocioId\)/);
  assert.match(RUTAS, /\n\s+diseno,\n\s+\}\);/);
});

// ── b) aislamiento del diseño clásico ───────────────────────────────────────
t('5. todo el CSS v2 está bajo .tema-v2 / .tipo-redonda o usa clases propias', () => {
  const inicio = CSS.indexOf('/* ══ DISEÑO V2');
  assert.ok(inicio > 0, 'no se encontró el bloque v2');
  const fin = CSS.indexOf('/* ══ FIN DISEÑO V2');
  assert.ok(fin > inicio, 'no se encontró el cierre del bloque v2');
  const bloque = CSS.slice(inicio, fin).replace(/\/\*[\s\S]*?\*\//g, '');
  // Selectores de cada regla (lo que va antes de "{"), sin @media.
  const selectores = [...bloque.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map(m => m[1].trim()).filter(s => s && !s.startsWith('@'));
  assert.ok(selectores.length > 40, 'muy pocas reglas: ¿cambió el formato?');
  const propio = /^(html\.tema-v2|html\.tipo-redonda|\.tema-v2 |#v2-|\.v2-|\.ev-|#hoja-eventos)/;
  const sueltos = selectores.flatMap(s => s.split(',').map(x => x.trim())).filter(x => x && !propio.test(x));
  assert.deepStrictEqual(sueltos, [], 'selectores que tocarían la tienda clásica');
});

t('6. el JS v2 solo corre detrás de esV2()', () => {
  assert.match(JS, /function aplicarDiseno\(\) \{\n\s+if \(!esV2\(\)\) return;/);
  assert.match(JS, /if \(esV2\(\)\) \{\n[^\n]*nombreBonito[^\n]*\n\s+pintarInicioV2\(\);/);
  assert.match(JS, /\$\('prod-cuerpo'\)\.innerHTML = esV2\(\) \? fichaV2\(p, partes\.slice\(inicioOpciones\)\) : partes\.join\(''\);/);
});

// ── c) la compra no cambia ──────────────────────────────────────────────────
t('7. los ids del flujo de compra existen una sola vez', () => {
  for (const id of ['btn-carrito', 'btn-agregar', 'prod-cuerpo', 'prod-total', 'cant-val', 'carrito-cuerpo',
    'btn-ir-checkout', 'ck-cuerpo', 'ck-pie', 'hoja-prod', 'hoja-carrito', 'hoja-checkout', 'hoja-cuenta', 'cats', 'catalogo']) {
    const n = (HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(n, 1, `#${id} aparece ${n} veces`);
  }
});

t('8. la ficha v2 reutiliza los mismos bloques de modificadores y notas', () => {
  // fichaV2 recibe las partes de opciones que arma abrirProducto: mismos
  // inputs con data-grupo/data-max y el mismo onchange.
  assert.match(JS, /function fichaV2\(p, opciones\)/);
  assert.match(JS, /<div class="v2-ficha-opciones">\$\{opciones\.join\(''\)\}<\/div>/);
  assert.match(JS, /onchange="alCambiarModificador\(this\)"/);
  assert.match(JS, /id="prod-notas"/);
});

t('9. la hoja de eventos se cierra con el mismo cerrarTodo (es una .hoja)', () => {
  assert.match(HTML, /<template id="tpl-eventos">\n<div class="hoja" id="hoja-eventos">/);
  assert.match(JS, /document\.body\.appendChild\(\$\('tpl-eventos'\)\.content\.cloneNode\(true\)\)/);
  assert.match(JS, /document\.querySelectorAll\('\.hoja'\)\.forEach\(h => h\.classList\.remove\('on'\)\)/);
});

t('10. eventos: solo arma un enlace de WhatsApp, codificado, sin tocar el checkout', () => {
  const f = JS.slice(JS.indexOf('function enviarCotizacionEvento'), JS.indexOf('// Ficha de producto v2'));
  assert.match(f, /encodeURIComponent\(texto\)/);
  assert.match(f, /'https:\/\/wa\.me\/' \+ wa/);
  assert.doesNotMatch(f, /innerHTML|api\(|checkout/i);
  assert.match(JS, /if \(TIENDA\.diseno\.eventos\) \{/);
});

t('11. todo lo que viene del catálogo se escapa en los bloques v2', () => {
  const v2 = JS.slice(JS.indexOf('function fotoDeCategoria'), JS.indexOf('function bloqueEventosV2'))
    + JS.slice(JS.indexOf('function fichaV2'), JS.indexOf('function alCambiarModificador'));
  assert.doesNotMatch(v2, /\$\{\s*(?:p\.(?:nombre|descripcion|imagen|badge)|foto|c\.nombre)\s*\}/,
    'dato del catálogo insertado sin esc()');
  for (const campo of ['p.nombre', 'p.descripcion', 'p.imagen', 'foto', 'p.badge']) {
    assert.ok(v2.includes(`esc(${campo}`), `falta esc(${campo}...)`);
  }
});

console.log(`\n═══ fase-tienda-diseno-v2: ${pasadas} OK · ${fallidas} fallos ═══`);
process.exit(fallidas ? 1 : 0);
