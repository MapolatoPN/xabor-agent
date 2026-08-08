// Candado de alcance: la identidad de Xabor no cambia por accidente.
//
// Motivo: una rama cuyo objetivo era rediseñar la LANDING terminó tocando
// también el favicon, el logotipo y el theme-color de /app, Superadmin,
// Restaurante, la estación de meseros y las pantallas de contraseña. En ese
// caso fue una decisión consciente y autorizada (el isotipo anterior no era
// el logotipo real del negocio), pero pasó desapercibido hasta la revisión.
//
// Este archivo fija la identidad canónica en un solo lugar. Si alguien la
// cambia, esta prueba falla hasta que edite IDENTIDAD aquí abajo: cambiar la
// marca sigue siendo posible, pero deja de ser un efecto colateral invisible
// y aparece explícito en el diff.
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4963';
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ─── IDENTIDAD CANÓNICA ─────────────────────────────────────────────────────
// Cambiar cualquiera de estos valores ES cambiar la marca de Xabor. Hacerlo
// a propósito está bien; hacerlo sin darse cuenta es lo que esto impide.
const IDENTIDAD = {
  isotipo: '/public/brand/xabor-icono.svg',
  iconoPng: '/public/brand/xabor-icono-32.png',
  appleTouch: '/public/brand/xabor-icono-180.png',
  manifest: '/public/brand/site.webmanifest',
  themeColor: '#FF6B35',
  version: 'v=3',
  wordmark: 'XABOR',
};

// Superficies del PRODUCTO. La landing va aparte a propósito: puede
// rediseñarse sin permiso de nadie, pero no puede arrastrar a estas.
const SUPERFICIES_PRODUCTO = [
  '/app', '/index.html', '/login-negocio.html', '/login.html',
  '/superadmin.html', '/finanzas', '/repartidor.html',
  '/restaurante', '/mesas.html', '/mesero/negocio-de-prueba',
  '/crear-password', '/restablecer-contrasena',
];
const SUPERFICIES_LANDING = ['/', '/aviso-privacidad.html'];

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const traer = async (ruta) => { const r = await fetch(base + ruta); return { status: r.status, texto: await r.text() }; };

// Extrae la declaración de marca tal como la leería un navegador.
function leerMarca(html) {
  const uno = (re) => { const m = html.match(re); return m ? m[1] : null; };
  return {
    isotipo: uno(/<link rel="icon" type="image\/svg\+xml" href="([^"?]+)/),
    iconoPng: uno(/<link rel="icon" type="image\/png"[^>]*href="([^"?]+)/),
    appleTouch: uno(/<link rel="apple-touch-icon"[^>]*href="([^"?]+)/),
    manifest: uno(/<link rel="manifest" href="([^"?]+)/),
    themeColor: uno(/<meta name="theme-color" content="([^"]+)"/),
    version: uno(/xabor-icono\.svg\?(v=\d+)/),
  };
}

await t('SCOPE', '1. cada superficie del producto declara EXACTAMENTE la identidad canónica', async () => {
  const desviadas = [];
  for (const ruta of SUPERFICIES_PRODUCTO) {
    const { status, texto } = await traer(ruta);
    assert.strictEqual(status, 200, `${ruta} respondió ${status}`);
    const marca = leerMarca(texto);
    for (const clave of Object.keys(marca)) {
      if (marca[clave] !== IDENTIDAD[clave]) {
        desviadas.push(`${ruta} · ${clave}: "${marca[clave]}" en vez de "${IDENTIDAD[clave]}"`);
      }
    }
  }
  assert.deepStrictEqual(desviadas, [],
    'una superficie del producto quedó con otra identidad — si el cambio es intencional, actualiza IDENTIDAD en esta prueba');
});

await t('SCOPE', '2. la landing comparte la misma identidad: no hay dos marcas conviviendo', async () => {
  const desviadas = [];
  for (const ruta of SUPERFICIES_LANDING) {
    const { texto } = await traer(ruta);
    const marca = leerMarca(texto);
    for (const clave of Object.keys(marca)) {
      if (marca[clave] !== IDENTIDAD[clave]) desviadas.push(`${ruta} · ${clave}: "${marca[clave]}"`);
    }
  }
  assert.deepStrictEqual(desviadas, [], 'la landing se separó de la identidad del producto');
});

await t('SCOPE', '3. el archivo de marca que se sirve es el declarado y trae el color canónico', async () => {
  const { status, texto } = await traer(IDENTIDAD.isotipo);
  assert.strictEqual(status, 200);
  assert.ok(texto.includes(IDENTIDAD.themeColor),
    `el isotipo debe dibujarse en ${IDENTIDAD.themeColor}`);
});

await t('SCOPE', '4. el wordmark es el del logotipo en todas las cabeceras que lo muestran', async () => {
  const malas = [];
  for (const ruta of [...SUPERFICIES_PRODUCTO, ...SUPERFICIES_LANDING]) {
    const { texto } = await traer(ruta);
    // El isotipo no siempre va con el wordmark: en /repartidor.html acompaña
    // al título de la pantalla. Lo que se vigila es que CUANDO aparece el
    // nombre de la marca, esté escrito como en el logotipo -- que es donde
    // se cuela la deriva ("Xabor" contra "XABOR").
    const bloques = [...texto.matchAll(/<img src="\/public\/brand\/xabor-icono\.svg[^>]*>\s*([Xx][Aa][Bb][Oo][Rr])/g)];
    for (const b of bloques) {
      if (b[1] !== IDENTIDAD.wordmark) malas.push(`${ruta}: "${b[1]}"`);
    }
  }
  assert.deepStrictEqual(malas, [], `el wordmark debe ser "${IDENTIDAD.wordmark}"`);
});

await t('SCOPE', '5. el rediseño de la landing no se filtró a ninguna pantalla del producto', async () => {
  // La landing tiene su propia hoja y sus propias clases. Si aparecieran en
  // el producto, el "rediseño de la landing" habría cruzado la frontera.
  const filtradas = [];
  for (const ruta of SUPERFICIES_PRODUCTO) {
    const { texto } = await traer(ruta);
    for (const marca of ['/public/landing/styles.css', 'class="hero', 'cabecera-seccion', 'rejilla-modulos']) {
      if (texto.includes(marca)) filtradas.push(`${ruta}: ${marca}`);
    }
  }
  assert.deepStrictEqual(filtradas, [], 'estilos o estructura de la landing dentro del producto');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
