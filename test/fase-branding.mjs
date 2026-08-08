// Identidad visual de Xabor, servida de verdad.
//
// Esto existe porque el branding se desincronizó sin que nadie se enterara:
// la landing declaraba su favicon y las diez pantallas del panel no
// declaraban ninguno, así que el navegador pedía /favicon.ico — que
// respondía 404 — y seguía mostrando el icono viejo que tenía guardado.
//
// La prueba no revisa el repo: pide las páginas al servidor y comprueba lo
// que un navegador recibiría, incluidos los assets referenciados (que un
// <link> apunte a algo que da 404 es exactamente el fallo anterior).
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4961';
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// Todas las superficies con HTML propio. Si mañana nace otra pantalla y no
// trae la marca, esta lista es el lugar donde se nota.
const PAGINAS = [
  '/', '/aviso-privacidad.html',
  '/app', '/index.html', '/login-negocio.html', '/login.html',
  '/superadmin.html', '/finanzas', '/repartidor.html',
  '/restaurante', '/mesas.html', '/mesero/negocio-de-prueba',
  '/crear-password', '/restablecer-contrasena',
];

// Marca aprobada (la misma de la landing): isotipo cuadrado #C96220 con la X.
const ACENTO = '#C96220';
const ICONO = '/public/brand/xabor-icono.svg';

// Lo que ya no debe aparecer en ninguna superficie.
const LEGADO = [
  { patron: /🌮/, que: 'el taco que se usaba como logo' },
  { patron: /\/public\/landing\/favicon\.svg/, que: 'la copia del favicon dentro de la landing' },
  { patron: />\s*XABOR\s*</, que: 'el wordmark en mayúsculas (la marca es "Xabor")' },
];

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const traer = async (ruta) => { const r = await fetch(base + ruta); return { status: r.status, tipo: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', texto: await r.text() }; };
const cabeza = async (ruta) => { const r = await fetch(base + ruta); return { status: r.status, tipo: r.headers.get('content-type') || '', bytes: (await r.arrayBuffer()).byteLength }; };

// ── 1-3. Los assets canónicos existen y se sirven ──────────────────────────
await t('ASSETS', '1. el isotipo canónico se sirve como SVG y es la marca aprobada', async () => {
  const r = await traer(ICONO);
  assert.strictEqual(r.status, 200);
  assert.match(r.tipo, /svg/);
  assert.ok(r.texto.includes(ACENTO), `el isotipo debe usar el acento de marca ${ACENTO}`);
  assert.ok(/rx="8"/.test(r.texto), 'cuadrado redondeado');
  assert.ok(/>X</.test(r.texto), 'con la X');
});

await t('ASSETS', '2. cada derivado del isotipo existe y no está vacío', async () => {
  for (const [ruta, tipo] of [
    ['/public/brand/xabor-icono-32.png', /png/],
    ['/public/brand/xabor-icono-180.png', /png/],
    ['/public/brand/xabor-icono-192.png', /png/],
    ['/public/brand/xabor-icono-512.png', /png/],
    ['/public/brand/xabor-social.png', /png/],
    ['/public/brand/xabor-logo.svg', /svg/],
    ['/public/brand/favicon.ico', /(icon|image)/],
  ]) {
    const r = await cabeza(ruta);
    assert.strictEqual(r.status, 200, `${ruta} debería servirse y respondió ${r.status}`);
    assert.match(r.tipo, tipo, `${ruta} con tipo inesperado: ${r.tipo}`);
    assert.ok(r.bytes > 200, `${ruta} llegó vacío (${r.bytes} bytes)`);
  }
});

await t('ASSETS', '3. las direcciones que el navegador pide solas ya no dan 404', async () => {
  // Este es el fallo original: sin /favicon.ico la pestaña se queda con el
  // icono que tuviera en caché.
  for (const ruta of ['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/site.webmanifest']) {
    const r = await cabeza(ruta);
    assert.strictEqual(r.status, 200, `${ruta} respondió ${r.status}`);
    assert.ok(r.bytes > 100, `${ruta} llegó vacío`);
  }
});

await t('ASSETS', '4. el manifest es JSON válido y apunta a iconos que existen', async () => {
  const r = await traer('/site.webmanifest');
  const m = JSON.parse(r.texto);
  assert.strictEqual(m.name, 'Xabor');
  assert.strictEqual(m.theme_color, ACENTO);
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
  for (const icono of m.icons) {
    const a = await cabeza(icono.src);
    assert.strictEqual(a.status, 200, `el manifest declara ${icono.src} y responde ${a.status}`);
  }
});

// ── 5-7. Todas las pantallas declaran la marca ─────────────────────────────
await t('PANTALLAS', '5. todas las superficies declaran favicon, apple-touch-icon y manifest', async () => {
  const sinMarca = [];
  for (const ruta of PAGINAS) {
    const { status, texto } = await traer(ruta);
    assert.strictEqual(status, 200, `${ruta} respondió ${status}`);
    const falta = [];
    if (!/<link rel="icon"[^>]*xabor-icono\.svg/.test(texto)) falta.push('favicon svg');
    if (!/<link rel="apple-touch-icon"/.test(texto)) falta.push('apple-touch-icon');
    if (!/<link rel="manifest"/.test(texto)) falta.push('manifest');
    if (!/<meta name="theme-color" content="#C96220">/.test(texto)) falta.push('theme-color');
    if (falta.length) sinMarca.push(`${ruta} (${falta.join(', ')})`);
  }
  assert.deepStrictEqual(sinMarca, [], 'pantallas sin la marca declarada');
});

await t('PANTALLAS', '6. el favicon va versionado para que el navegador suelte el viejo', async () => {
  for (const ruta of PAGINAS) {
    const { texto } = await traer(ruta);
    assert.match(texto, /xabor-icono\.svg\?v=\d+/, `${ruta} debe pedir el icono con versión`);
  }
});

await t('PANTALLAS', '7. ninguna pantalla conserva marcas de la identidad anterior', async () => {
  const restos = [];
  for (const ruta of PAGINAS) {
    const { texto } = await traer(ruta);
    for (const { patron, que } of LEGADO) {
      if (patron.test(texto)) restos.push(`${ruta}: ${que}`);
    }
  }
  assert.deepStrictEqual(restos, [], 'quedan restos de la identidad anterior');
});

// ── 8-9. Nada roto ─────────────────────────────────────────────────────────
await t('INTEGRIDAD', '8. ningún asset referenciado por las pantallas responde 404', async () => {
  const rotos = [];
  const vistos = new Set();
  for (const ruta of PAGINAS) {
    const { texto } = await traer(ruta);
    const refs = [...texto.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map(m => m[1]);
    for (const ref of refs) {
      if (vistos.has(ref)) continue;
      vistos.add(ref);
      // Solo archivos: las rutas de navegación se prueban aparte.
      if (!/\.(svg|png|ico|css|js|webmanifest|jpg|jpeg|webp)(\?|$)/.test(ref)) continue;
      const r = await cabeza(ref);
      if (r.status !== 200) rotos.push(`${ref} -> ${r.status} (en ${ruta})`);
    }
  }
  assert.deepStrictEqual(rotos, [], 'assets referenciados que no existen');
});

await t('INTEGRIDAD', '9. la vista previa social está declarada y la imagen existe', async () => {
  const { texto } = await traer('/');
  assert.match(texto, /<meta property="og:image" content="https:\/\/xabor\.mx\/public\/brand\/xabor-social\.png">/);
  assert.match(texto, /<meta name="twitter:card" content="summary_large_image">/);
  const img = await cabeza('/public/brand/xabor-social.png');
  assert.strictEqual(img.status, 200);
  assert.ok(img.bytes > 5000, 'la imagen social llegó demasiado pequeña');
});

// ── 10. La marca no se copió por pantalla ──────────────────────────────────
await t('FUENTE UNICA', '10. todas las pantallas apuntan al mismo archivo de marca', async () => {
  const origenes = new Set();
  for (const ruta of PAGINAS) {
    const { texto } = await traer(ruta);
    for (const m of texto.matchAll(/(?:href|src)="(\/[^"]*(?:favicon|logo|icono|brand)[^"]*)"/g)) {
      origenes.add(m[1].split('?')[0]);
    }
  }
  const fuera = [...origenes].filter(o => !o.startsWith('/public/brand/'));
  // /logo.png es el logotipo del NEGOCIO en su ticket impreso, no la marca
  // de Xabor: no se toca (ver docs/branding.md).
  assert.deepStrictEqual(fuera.filter(o => o !== '/logo.png'), [],
    'hay marcas servidas desde fuera de /public/brand');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
