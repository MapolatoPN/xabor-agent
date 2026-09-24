// Regresión de seguridad: los logins solo pueden regresar a rutas del mismo
// origen. Se usa un navegador real porque WHATWG URL normaliza /\evil.example
// como https://evil.example/ y puede producir un pathname que empiece con //.
//
// Uso: node test/fase-login-redirect-seguro.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_LOGIN_REDIRECT || 0);

const paginas = new Map([
  ['/login', 'login-negocio.html'],
  ['/login-negocio.html', 'login-negocio.html'],
  ['/login.html', 'login.html'],
]);

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"error":"sin sesión"}');
  }
  const archivo = paginas.get(pathname);
  if (archivo) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(PANEL_DIR, archivo)));
  }
  res.writeHead(404);
  res.end('no');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PUERTO, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

let pasadas = 0;
let fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try {
    await fn();
    console.log(`  OK  ${nombre}`);
    pasadas++;
  } catch (error) {
    console.log(`FALLO ${nombre}: ${error.message}`);
    fallidas++;
    fallos.push(nombre);
  }
}

const casos = [
  { valor: 'javascript:globalThis.__xss = true', aceptado: false, nombre: 'rechaza javascript:' },
  { valor: 'https://evil.example', aceptado: false, nombre: 'rechaza URL absoluta externa' },
  { valor: `${base}/app#mesas`, aceptado: false, nombre: 'rechaza URL absoluta del mismo origen' },
  { valor: '//evil.example', aceptado: false, nombre: 'rechaza URL protocol-relative' },
  { valor: '/\\evil.example', aceptado: false, nombre: 'rechaza barra invertida normalizada como host' },
  { valor: '/\t/evil.example', aceptado: false, nombre: 'rechaza controles normalizados como host' },
  { valor: '/..//evil.example', aceptado: true, nombre: 'ancla al origen tras normalizar segmentos' },
  { valor: '/app#mesas', aceptado: true, nombre: 'acepta ruta interna' },
];

const navegador = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await navegador.newPage();
await page.setRequestInterception(true);
page.on('request', request => {
  if (request.url().startsWith(base)) request.continue();
  else request.abort();
});

try {
  for (const ruta of ['/login', '/login-negocio.html', '/login.html']) {
    for (const caso of casos) {
      await t(`${ruta}: ${caso.nombre}`, async () => {
        await page.goto(`${base}${ruta}?redirect=${encodeURIComponent(caso.valor)}`, {
          waitUntil: 'domcontentloaded',
        });
        const actual = await page.evaluate(() => ({
          redirect: redirectUrl,
          destinoFinal: new URL(redirectUrl, location.href).href,
        }));
        const destinoEsperado = new URL(caso.aceptado ? caso.valor : '/app', base).href;
        const rechazoIncorrecto = !caso.aceptado && actual.redirect !== '/app';
        if (rechazoIncorrecto || actual.destinoFinal !== destinoEsperado) {
          const esperado = { redirect: caso.aceptado ? 'ruta interna segura' : '/app', destinoFinal: destinoEsperado };
          throw new Error(`esperaba ${JSON.stringify(esperado)} y obtuvo ${JSON.stringify(actual)}`);
        }
      });
    }
  }
} finally {
  await navegador.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(`\n${pasadas} pasaron, ${fallidas} fallaron`);
if (fallidas) {
  console.log(`Casos fallidos: ${fallos.join(', ')}`);
  process.exit(1);
}
