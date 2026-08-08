// Integridad del HTML que sirve el panel.
//
// Regresión real que motivó esta suite: se insertó
// `<script src="/modificadores.js"></script>` dentro de un literal de
// plantilla de JavaScript (el que arma el ticket imprimible, que contiene
// "</style></head><body>" como texto). El parser HTML del navegador corta el
// <script> inline en el PRIMER "</script>" que encuentra, aunque esté dentro
// de un string de JS: a partir de ahí miles de líneas de código se pintaron
// como texto en /app y el layout reventó con scroll horizontal.
//
// La comprobación imita al navegador: extrae cada script inline hasta su
// primer "</script>", lo compila para detectar SyntaxError, y revisa que el
// texto que queda fuera de scripts/estilos no parezca código.
import assert from 'assert';
import vm from 'vm';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4954';
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// Igual que el parser del navegador: el contenido de un <script> termina en
// el primer "</script>", sin importar el contexto de JavaScript.
function extraerScripts(htmlOriginal) {
  // Los comentarios se descartan primero: el navegador tampoco interpreta
  // una etiqueta escrita dentro de un comentario. Se sustituyen por
  // espacios para no mover posiciones.
  const html = htmlOriginal.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const scripts = [];
  const abre = /<script\b([^>]*)>/gi;
  let m;
  while ((m = abre.exec(html)) !== null) {
    const attrs = m[1] || '';
    const inicio = abre.lastIndex;
    const fin = html.indexOf('</script>', inicio);
    const tieneSrc = /\bsrc\s*=/i.test(attrs);
    scripts.push({ attrs, tieneSrc, contenido: fin === -1 ? html.slice(inicio) : html.slice(inicio, fin), cerrado: fin !== -1, fin });
    if (fin === -1) break;
    abre.lastIndex = fin + '</script>'.length;
  }
  return scripts;
}

function textoFueraDeScripts(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

const PAGINAS = ['/app', '/index.html', '/superadmin.html', '/mesas.html', '/repartidor.html', '/modificadores.js'];
const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const traer = async (ruta) => {
  const r = await fetch(base + ruta);
  return { status: r.status, texto: await r.text() };
};

for (const ruta of PAGINAS) {
  await t('SIRVE', `${ruta} responde 200 y no viene vacío`, async () => {
    const { status, texto } = await traer(ruta);
    assert.strictEqual(status, 200, `${ruta} devolvió ${status}`);
    assert.ok(texto.length > 500, `${ruta} llegó demasiado corto (${texto.length} bytes)`);
  });
}

for (const ruta of PAGINAS.filter(r => r.endsWith('.html') || r === '/app')) {
  await t('SCRIPTS', `${ruta}: todo <script> abre y cierra, y el inline compila sin SyntaxError`, async () => {
    const { texto } = await traer(ruta);
    const sinComentarios = texto.replace(/<!--[\s\S]*?-->/g, ' ');
    const aperturas = (sinComentarios.match(/<script\b/gi) || []).length;
    const cierres = (sinComentarios.match(/<\/script\s*>/gi) || []).length;
    assert.strictEqual(aperturas, cierres, `etiquetas <script> desbalanceadas: ${aperturas} aperturas / ${cierres} cierres`);

    for (const [i, s] of extraerScripts(texto).entries()) {
      assert.ok(s.cerrado, `script #${i + 1} sin cerrar`);
      if (s.tieneSrc || !s.contenido.trim()) continue;
      const esModulo = /type\s*=\s*["']module["']/i.test(s.attrs);
      try {
        new vm.Script(s.contenido, { filename: `${ruta}#script${i + 1}`, ...(esModulo ? { } : {}) });
      } catch (e) {
        // Un </script> dentro de un string de JS parte el script justo aquí:
        // el pedazo resultante casi nunca compila, y lo que sigue se pinta
        // como texto en la página.
        throw new Error(`script inline #${i + 1} no compila (${e.message.split('\n')[0]})`);
      }
    }
  });
  await t('RENDER', `${ruta}: no queda código JavaScript suelto como texto de la página`, async () => {
    const { texto } = await traer(ruta);
    const fuera = textoFueraDeScripts(texto);
    const sospechas = [
      [/\$\{[^}]{3,}\}/, 'interpolación ${...} de un template literal'],
      [/=>\s*\{/, 'función flecha'],
      [/\bfunction\s*\([^)]*\)\s*\{/, 'declaración de función'],
      [/document\.getElementById\(/, 'código que toca el DOM'],
      [/\.toLowerCase\(\)/, 'llamada a método de JS'],
    ];
    for (const [re, que] of sospechas) {
      const m = fuera.match(re);
      assert.ok(!m, `hay ${que} visible como texto: "${String(m && m[0]).slice(0, 80)}"`);
    }
  });
}

await t('CONTRATO', 'el panel carga el modal compartido desde el <head> real, antes de <body>', async () => {
  const { texto: crudo } = await traer('/app');
  const texto = crudo.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const iScript = texto.indexOf('<script src="/modificadores.js">');
  assert.ok(iScript > 0, 'el panel debe cargar /modificadores.js');
  const iBody = texto.toLowerCase().indexOf('<body');
  assert.ok(iScript < iBody, 'debe ir en el <head>, no dentro de un literal de plantilla más abajo');
  // El único </head> que existe antes de <body> es el real de la página.
  const iHead = texto.toLowerCase().indexOf('</head>');
  assert.ok(iScript < iHead, 'el script va antes de cerrar el head');
});
await t('CONTRATO', 'la funcionalidad de la microfase sigue en el HTML servido', async () => {
  const { texto } = await traer('/app');
  assert.match(texto, /id="tab-restaurante"[^>]*data-modulo="restaurante"/, 'pestaña Restaurante gateada por módulo');
  assert.ok(texto.includes("location.href='/mesas.html'"), 'abre la UI de mesas');
  assert.ok(texto.includes('elegirProductoPOS'), 'POS abre el modal de modificadores');
  assert.ok(texto.includes('firmaCarrito'), 'el carrito separa líneas por selección');
  const mesas = await traer('/mesas.html');
  assert.ok(mesas.texto.includes('modificadores.js'), 'mesas usa el mismo modal');
  assert.ok(mesas.texto.includes('agregarDesdeMenu'), 'mesas agrega desde el menú');
});
await t('CONTRATO', '/modificadores.js es JavaScript válido y expone la API que usan las dos pantallas', async () => {
  const { texto } = await traer('/modificadores.js');
  new vm.Script(texto, { filename: 'modificadores.js' });
  assert.ok(texto.includes('XaborModificadores'), 'expone el objeto global');
  assert.ok(texto.includes('tieneModificadores') && texto.includes('abrirModal'), 'expone las funciones usadas');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
