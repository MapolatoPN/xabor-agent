// Íconos de Xabor instalado como app (iPad/iPhone, Android y Windows).
//
// Por qué existe: el isotipo es una X naranja TRANSPARENTE que llega al
// borde. Al agregar Xabor a la pantalla de inicio, iOS rellena lo transparente
// de negro y redondea las esquinas (la X salía en un cuadro negro con las
// puntas cortadas), y Android, sin ícono "maskable", la encogía dentro de un
// círculo blanco. Además los avisos push pedían /icon-192.png e /icon-72.png,
// que nunca existieron.
//
// Esta prueba no confía en el aspecto del archivo: lee los píxeles. No
// necesita base de datos ni servidor de Xabor.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import puppeteer from 'puppeteer';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARCA = join(RAIZ, 'public', 'brand');
const ACENTO = [0xFF, 0x6B, 0x35];

let pasadas = 0, fallidas = 0;
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; }
}

// Lee un PNG y mide lo que importa: si tiene alfa, el color de las esquinas,
// dónde está la "tinta" (lo que no es fondo blanco) y cuánto es naranja.
async function medir(archivo) {
  const meta = await sharp(archivo).metadata();
  const { data, info } = await sharp(archivo).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const px = (x, y) => [...data.subarray((y * w + x) * c, (y * w + x) * c + c)];
  let distMax = 0, minX = w, maxX = -1, naranja = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = px(x, y);
      if (Math.abs(r - ACENTO[0]) <= 12 && Math.abs(g - ACENTO[1]) <= 12 && Math.abs(b - ACENTO[2]) <= 12 && a === 255) naranja++;
      if ((255 - r) + (255 - g) + (255 - b) <= 60) continue; // fondo blanco
      if (c === 4 && a < 128) continue;                       // transparente
      const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
      if (d > distMax) distMax = d;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return {
    w, h, canales: c, alfa: meta.hasAlpha,
    esquinas: [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)],
    distMax: distMax / w, anchoTinta: (maxX - minX + 1) / w, naranja: naranja / (w * h),
  };
}

const blanco = (p) => p.length === 3 && p.every(v => v === 255);

// Ícono para pantalla de inicio: opaco, esquinas blancas, X naranja visible
// y alejada del borde que el sistema recorta.
async function exigirOpaco(archivo, lado, radioMax) {
  assert.ok(existsSync(archivo), `${archivo} no existe`);
  const m = await medir(archivo);
  assert.deepStrictEqual([m.w, m.h], [lado, lado], `mide ${m.w}x${m.h}, debía ${lado}x${lado}`);
  assert.equal(m.alfa, false, 'tiene canal alfa: iOS pinta de negro lo transparente');
  assert.ok(m.esquinas.every(blanco), `esquinas no blancas: ${JSON.stringify(m.esquinas)}`);
  assert.ok(m.naranja >= 0.05, `casi no hay naranja de marca (${(m.naranja * 100).toFixed(1)} %)`);
  assert.ok(m.anchoTinta >= 0.4, `la X quedó muy chica (${(m.anchoTinta * 100).toFixed(0)} % del ancho)`);
  assert.ok(m.distMax <= radioMax, `la X llega a ${(m.distMax * 100).toFixed(1)} % del lado desde el centro; máximo ${radioMax * 100} %`);
}

// ── 1-2. iPad / iPhone ─────────────────────────────────────────────────────
await t('APPLE', '1. el apple-touch-icon es opaco, 180x180, con esquinas blancas', async () => {
  const m = await medir(join(MARCA, 'xabor-icono-180.png'));
  assert.deepStrictEqual([m.w, m.h], [180, 180]);
  assert.equal(m.alfa, false, 'tiene canal alfa: iOS pinta de negro lo transparente');
  assert.ok(m.esquinas.every(blanco), `esquinas no blancas: ${JSON.stringify(m.esquinas)}`);
});

await t('APPLE', '2. la X naranja queda lejos de las esquinas redondeadas', async () => {
  // iOS redondea ~22 % del lado: el círculo de radio 42 % queda a salvo.
  await exigirOpaco(join(MARCA, 'xabor-icono-180.png'), 180, 0.42);
});

// ── 3. Android ─────────────────────────────────────────────────────────────
await t('ANDROID', '3. los maskable 192 y 512 son opacos y la X cabe en el círculo seguro del 40 %', async () => {
  for (const lado of [192, 512]) {
    try { await exigirOpaco(join(MARCA, `xabor-icono-maskable-${lado}.png`), lado, 0.40); }
    catch (e) { throw new Error(`maskable-${lado}: ${e.message}`); }
  }
});

// ── 4-5. Manifest ──────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(MARCA, 'site.webmanifest'), 'utf8'));
const proposito = (i) => (i.purpose || 'any').split(/\s+/);

await t('MANIFEST', '4. declara maskable 192 y 512, y conserva los "any" transparentes para Windows', async () => {
  for (const lado of [192, 512]) {
    const mask = manifest.icons.find(i => proposito(i).includes('maskable') && i.sizes === `${lado}x${lado}`);
    assert.ok(mask, `falta el ícono maskable ${lado}x${lado}`);
    assert.equal(mask.src, `/public/brand/xabor-icono-maskable-${lado}.png`);
    const any = manifest.icons.find(i => proposito(i).includes('any') && i.sizes === `${lado}x${lado}` && i.type === 'image/png');
    assert.ok(any, `falta el ícono "any" ${lado}x${lado}`);
    const m = await medir(join(RAIZ, any.src.replace(/^\//, '')));
    assert.equal(m.alfa, true, `${any.src} dejó de ser transparente: en Windows se vería un cuadro blanco`);
  }
});

await t('MANIFEST', '5. cada ícono declarado existe y mide lo que dice `sizes`', async () => {
  for (const icono of manifest.icons) {
    const ruta = join(RAIZ, icono.src.replace(/^\//, ''));
    assert.ok(icono.src.startsWith('/public/') && existsSync(ruta), `${icono.src} no existe en el repo`);
    if (icono.sizes === 'any') continue;
    const meta = await sharp(ruta).metadata();
    assert.equal(`${meta.width}x${meta.height}`, icono.sizes, `${icono.src} mide ${meta.width}x${meta.height} y declara ${icono.sizes}`);
  }
});

// ── 6. Avisos push ─────────────────────────────────────────────────────────
await t('AVISOS', '6. el ícono y el badge de los avisos push apuntan a archivos que existen', async () => {
  const sw = readFileSync(join(RAIZ, 'panel', 'sw.js'), 'utf8');
  for (const campo of ['icon', 'badge']) {
    const m = sw.match(new RegExp(`\\b${campo}:\\s*'([^']+)'`));
    assert.ok(m, `sw.js no declara ${campo}`);
    assert.ok(m[1].startsWith('/public/') && existsSync(join(RAIZ, m[1].replace(/^\//, ''))), `${campo} apunta a ${m[1]}, que no existe (404 en el aviso)`);
  }
});

// ── 7. Nada a mano ─────────────────────────────────────────────────────────
await t('GENERADOR', '7. el script de marca reproduce los íconos de app versionados', async () => {
  // Copia del script y de los SVG dentro del repo (para que encuentre sharp
  // subiendo a node_modules), se corre y se comparan píxeles, no bytes: otra
  // versión de libvips puede comprimir distinto y pintar igual.
  const tmp = join(RAIZ, `.tmp-iconos-${process.pid}`);
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    mkdirSync(join(tmp, 'public', 'brand'), { recursive: true });
    copyFileSync(join(RAIZ, 'scripts', 'generar-assets-marca.mjs'), join(tmp, 'scripts', 'generar-assets-marca.mjs'));
    for (const svg of ['xabor-icono.svg', 'xabor-social.svg']) copyFileSync(join(MARCA, svg), join(tmp, 'public', 'brand', svg));
    const r = spawnSync(process.execPath, [join(tmp, 'scripts', 'generar-assets-marca.mjs')], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `el generador falló: ${r.stderr || r.stdout}`);
    for (const nombre of ['xabor-icono-180.png', 'xabor-icono-maskable-192.png', 'xabor-icono-maskable-512.png']) {
      const [a, b] = await Promise.all([join(MARCA, nombre), join(tmp, 'public', 'brand', nombre)]
        .map(f => sharp(f).raw().toBuffer({ resolveWithObject: true })));
      assert.deepStrictEqual([b.info.width, b.info.height, b.info.channels], [a.info.width, a.info.height, a.info.channels], `${nombre}: el generador produce otra forma`);
      let distintos = 0;
      for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i] - b.data[i]) > 8) distintos++;
      assert.ok(distintos / a.data.length < 0.005, `${nombre} no es lo que genera el script (${distintos} valores distintos): ¿se editó a mano o falta correr el generador?`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 8. Chrome real ─────────────────────────────────────────────────────────
await t('CHROME', '8. Chrome lee el manifiesto sin errores y ofrece instalar', async () => {
  const TIPOS = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
  const srv = createServer((req, res) => {
    const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (ruta === '/' || ruta === '/app') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Xabor</title>'
        + '<link rel="manifest" href="/public/brand/site.webmanifest?v=3"></head><body>Xabor</body></html>');
    }
    const archivo = join(RAIZ, ruta.replace(/^\//, ''));
    if (!ruta.startsWith('/public/brand/') || !existsSync(archivo)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TIPOS[extname(archivo)] || 'application/octet-stream' });
    res.end(readFileSync(archivo));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await navegador.newPage();
    await page.goto(`http://localhost:${srv.address().port}/app`, { waitUntil: 'load' });
    const cdp = await page.createCDPSession();
    const man = await cdp.send('Page.getAppManifest');
    assert.ok(man.url.includes('site.webmanifest'), 'Chrome no encontró el manifiesto');
    assert.deepStrictEqual(man.errors, [], `errores al leer el manifiesto: ${JSON.stringify(man.errors)}`);
    // Chrome baja los íconos para decidir: un ícono roto o un modo de
    // pantalla no soportado aparecen aquí.
    let errores = [];
    for (let i = 0; i < 10; i++) {
      ({ installabilityErrors: errores } = await cdp.send('Page.getInstallabilityErrors'));
      if (!errores.length) break;
      await new Promise(r => setTimeout(r, 300));
    }
    assert.deepStrictEqual(errores.map(e => e.errorId), [], 'Chrome no ofrecería instalar Xabor');
  } finally {
    await navegador.close();
    srv.close();
  }
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
