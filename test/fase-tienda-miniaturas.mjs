// Formulario «tienda» (tienda_v1), Fase 1: miniaturas del menú
// (src/services/miniaturasMenu.js). Pura: sin base de datos ni red; las fotos
// se generan con sharp en memoria y la lectura del almacenamiento se inyecta.
//
// Garantías que prueba:
//   receta   JPEG siempre (también desde WebP y PNG), medida exacta por
//            variante, giro EXIF, transparencia a blanco
//   topes    se recodifica hasta 60 KB de base64; nunca pasa de 100 KB (si no
//            cabe, no hay miniatura)
//   caché    LRU por entradas y por bytes, con llave storage_key|variante; una
//            foto nueva es otra llave y nunca devuelve la vieja
//   cola     obtener() es síncrono: si falta, devuelve null y encola; una
//            lectura por foto; sin duplicados; un fallo no detiene la cola ni
//            se reintenta en caliente; tope de cola; llaves peligrosas fuera
//   aislado  el módulo no toca la base de datos
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { crearMiniaturas, generarMiniatura, llaveDeAlmacenamientoValida, VARIANTES, NOMBRES_VARIANTES, VARIANTES_PRECALENTADAS, TOPE_OBJETIVO, TOPE_DURO,
  CAPACIDAD_CACHE, REINTENTO_FALLIDA_MS, miniaturasMenu, miniaturaOEncolar, miniaturaEnCache, encolarMiniaturas } from '../src/services/miniaturasMenu.js';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.message}`); }
};
const sinRechazos = [];
process.on('unhandledRejection', (e) => sinRechazos.push(e));

const solida = (w, h, color, formato = 'jpeg') => sharp({ create: { width: w, height: h, channels: 3, background: color } })[formato]().toBuffer();
function ruidoCrudo(w, h, semilla = 7) {
  const crudo = Buffer.alloc(w * h * 3);
  for (let i = 0; i < crudo.length; i++) { semilla = (semilla * 1103515245 + 12345) >>> 0; crudo[i] = semilla >>> 24; }
  return sharp(crudo, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
async function pixel(base64, x, y) {
  const { data, info } = await sharp(Buffer.from(base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + 3)];
}
const meta = (base64) => sharp(Buffer.from(base64, 'base64')).metadata();
const esJpeg = (base64) => Buffer.from(base64, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
const cerca = (px, rgb, tol = 40) => px.every((c, i) => Math.abs(c - rgb[i]) <= tol);
/** Almacenamiento en memoria que anota cada lectura. */
function almacen(fotos = {}) {
  const lecturas = [], mapa = new Map(Object.entries(fotos));
  return { lecturas, mapa, leer: async (k) => { lecturas.push(k); if (!mapa.has(k)) throw new Error(`no existe ${k}`); return mapa.get(k); } };
}
const silencio = () => {};

const ROJO = await solida(800, 600, '#e01010'), AZUL = await solida(800, 600, '#1030e0');
const WEBP = await solida(640, 480, '#10a020', 'webp');
const PNG_TRANSPARENTE = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
const RUIDO_FICHA = await ruidoCrudo(480, 320);

// ── Receta ───────────────────────────────────────────────────────────────
await t('constantes de la propuesta: variantes 96/128/480×320 (+80 de la escalera, bajo demanda), topes 60 KB y 100 KB, caché de 1500', () => {
  assert.deepEqual(VARIANTES, { lista96: { ancho: 96, alto: 96, calidad: 65 }, cat128: { ancho: 128, alto: 128, calidad: 70 },
    lista80: { ancho: 80, alto: 80, calidad: 55 }, ficha480: { ancho: 480, alto: 320, calidad: 70 } });
  assert.deepEqual(NOMBRES_VARIANTES, ['lista96', 'cat128', 'lista80', 'ficha480']);
  assert.deepEqual(VARIANTES_PRECALENTADAS, ['lista96', 'cat128', 'ficha480'], 'lista80 no se precalienta');
  assert(Object.isFrozen(VARIANTES_PRECALENTADAS));
  assert.deepEqual([TOPE_OBJETIVO, TOPE_DURO, CAPACIDAD_CACHE], [60_000, 100_000, 1500]);
  assert(Object.isFrozen(VARIANTES) && Object.isFrozen(VARIANTES.lista96));
});
await t('receta: cada variante sale JPEG con su medida exacta y dentro de 60 KB', async () => {
  for (const v of NOMBRES_VARIANTES) {
    const r = await generarMiniatura(ROJO, v);
    assert(esJpeg(r.base64), v);
    const m = await meta(r.base64);
    assert.deepEqual([m.format, m.width, m.height], ['jpeg', VARIANTES[v].ancho, VARIANTES[v].alto], v);
    assert(r.bytes === r.base64.length && r.bytes <= TOPE_OBJETIVO, `${v}: ${r.bytes}`);
    assert.equal(r.calidad, VARIANTES[v].calidad, `${v}: sin recodificar si ya cabe`);
    assert(cerca(await pixel(r.base64, 5, 5), [224, 16, 16]), v);
  }
});
await t('receta: una foto WebP o PNG de entrada sale JPEG; la transparencia sale blanca, no negra', async () => {
  for (const v of NOMBRES_VARIANTES) {
    const deWebp = await generarMiniatura(WEBP, v), dePng = await generarMiniatura(PNG_TRANSPARENTE, v);
    assert(esJpeg(deWebp.base64) && esJpeg(dePng.base64), v);
    assert.equal((await meta(dePng.base64)).format, 'jpeg');
    assert(cerca(await pixel(deWebp.base64, 3, 3), [16, 160, 32]), `${v} WebP`);
    const px = await pixel(dePng.base64, 3, 3);
    assert(px.every((c) => c >= 245), `${v}: transparente → ${px}`);
  }
});
await t('receta: aplica el giro EXIF antes de recortar (orientación 6)', async () => {
  // Guardada 200×300: mitad de arriba roja, de abajo azul. Con orientación 6 se
  // ve 300×200: izquierda azul, derecha roja (cabe en 480×320 sin recorte).
  const arriba = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const girada = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#0000ff' } })
    .composite([{ input: arriba, left: 0, top: 0 }]).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const r = await generarMiniatura(girada, 'ficha480');
  assert(cerca(await pixel(r.base64, 20, 160), [0, 0, 255]), 'izquierda azul');
  assert(cerca(await pixel(r.base64, 460, 160), [255, 0, 0]), 'derecha roja');
});
await t('topes: lo que pasa de 60 KB se recodifica a menor calidad hasta caber', async () => {
  const sinTope = await generarMiniatura(RUIDO_FICHA, 'ficha480', { topeObjetivo: Infinity });
  assert(sinTope.bytes > TOPE_OBJETIVO, `la foto de prueba debe pasar del tope en q70 (${sinTope.bytes})`);
  const r = await generarMiniatura(RUIDO_FICHA, 'ficha480');
  assert(r.bytes <= TOPE_OBJETIVO, `${r.bytes}`); assert(r.calidad < 70 && r.calidad >= 20, `calidad ${r.calidad}`);
  assert(esJpeg(r.base64));
});
await t('topes: si ni en la calidad mínima cabe en el tope duro, no hay miniatura (null), nunca una de más', async () => {
  assert.equal(await generarMiniatura(RUIDO_FICHA, 'ficha480', { topeObjetivo: 1000, topeDuro: 2000 }), null);
  const a = almacen({ 'n/ruido.png': RUIDO_FICHA }), m = crearMiniaturas({ leer: a.leer, topeObjetivo: 1000, topeDuro: 2000, avisar: silencio });
  assert.equal(m.encolar('n/ruido.png', ['ficha480']), 1);
  await m.esperar();
  assert.equal(m.enCache('n/ruido.png', 'ficha480'), null);
  assert.deepEqual([m.estado().generadas, m.estado().fallidas, m.estado().entradas], [0, 1, 0]);
});
await t('variante desconocida o imagen vacía: error de programación, no una miniatura', async () => {
  await assert.rejects(generarMiniatura(ROJO, 'gigante'), TypeError);
  await assert.rejects(generarMiniatura(Buffer.alloc(0), 'lista96'), /vacía/);
  const m = crearMiniaturas({ leer: async () => ROJO });
  assert.throws(() => m.obtener('n/a.jpg', 'gigante'), TypeError);
  assert.throws(() => m.encolar('n/a.jpg', ['lista96', 'gigante']), TypeError);
});

// ── Cola ─────────────────────────────────────────────────────────────────
await t('falta la miniatura: obtener devuelve null al instante (no una promesa), la encola y no lee nada todavía', async () => {
  const a = almacen({ 'n/rojo.jpg': ROJO }), m = crearMiniaturas({ leer: a.leer });
  const r = m.obtener('n/rojo.jpg', 'lista96');
  assert.equal(r, null); assert.equal(a.lecturas.length, 0, 'nada se genera dentro de la llamada');
  assert.deepEqual([m.estado().pendientes, m.estado().entradas], [1, 0]);
  await m.esperar();
  const b64 = m.obtener('n/rojo.jpg', 'lista96');
  assert.equal(typeof b64, 'string'); assert(esJpeg(b64));
  assert.equal(m.enCache('n/rojo.jpg', 'lista96'), b64);
  assert.deepEqual([a.lecturas.length, m.estado().pendientes], [1, 0]);
});
await t('cola: una sola lectura por foto para todas sus variantes y sin duplicados', async () => {
  const a = almacen({ 'n/rojo.jpg': ROJO }), m = crearMiniaturas({ leer: a.leer });
  assert.equal(m.encolar('n/rojo.jpg'), 3);
  assert.equal(m.encolar('n/rojo.jpg'), 0, 'ya en la cola');
  for (const v of VARIANTES_PRECALENTADAS) assert.equal(m.obtener('n/rojo.jpg', v), null);
  assert.equal(m.estado().pendientes, 3);
  await m.esperar();
  assert.equal(a.lecturas.length, 1);
  assert.equal(m.encolar('n/rojo.jpg'), 0, 'ya en la caché');
  for (const v of VARIANTES_PRECALENTADAS) assert.equal((await meta(m.enCache('n/rojo.jpg', v))).width, VARIANTES[v].ancho);
  assert.equal(m.enCache('n/rojo.jpg', 'lista80'), null, 'lista80 no se precalienta');
});
await t('cola: lista80 (peldaño 1 de la escalera) solo bajo demanda: obtener la encola y la siguiente vez está', async () => {
  const a = almacen({ 'n/rojo.jpg': ROJO }), m = crearMiniaturas({ leer: a.leer });
  assert.equal(m.obtener('n/rojo.jpg', 'lista80'), null);
  assert.equal(m.estado().pendientes, 1);
  await m.esperar();
  const b64 = m.obtener('n/rojo.jpg', 'lista80');
  assert.deepEqual([(await meta(b64)).width, (await meta(b64)).height, a.lecturas.length], [80, 80, 1]);
  assert.equal(m.encolar('n/rojo.jpg', ['lista80']), 0, 'ya en la caché');
});
await t('cola: una foto que falla (no existe o está corrupta) no detiene a las demás ni deja rechazos sueltos', async () => {
  const avisos = [], a = almacen({ 'n/rota.jpg': Buffer.from('no es una imagen'), 'n/buena.jpg': AZUL });
  const m = crearMiniaturas({ leer: a.leer, avisar: (x) => avisos.push(x) });
  m.encolar('n/falta.jpg', ['lista96']); m.encolar('n/rota.jpg', ['lista96']); m.encolar('n/buena.jpg', ['lista96']);
  await m.esperar();
  assert.equal(m.enCache('n/falta.jpg', 'lista96'), null); assert.equal(m.enCache('n/rota.jpg', 'lista96'), null);
  assert(cerca(await pixel(m.enCache('n/buena.jpg', 'lista96'), 5, 5), [16, 48, 224]));
  assert.deepEqual([m.estado().fallidas, m.estado().generadas], [2, 1]);
  assert.equal(avisos.length, 2); assert.match(avisos[0], /n\/falta\.jpg.*lectura/);
  await new Promise((r) => setImmediate(r));
  assert.equal(sinRechazos.length, 0, String(sinRechazos[0]));
});
await t('cola: una foto que falló no se reintenta en caliente; sí pasado el tiempo de reintento', async () => {
  let reloj = 1_000_000;
  const a = almacen({}), m = crearMiniaturas({ leer: a.leer, ahora: () => reloj, avisar: silencio });
  assert.equal(REINTENTO_FALLIDA_MS, 600_000);
  m.obtener('n/falta.jpg', 'ficha480'); await m.esperar();
  assert.equal(a.lecturas.length, 1);
  for (let i = 0; i < 5; i++) assert.equal(m.obtener('n/falta.jpg', 'ficha480'), null);
  reloj += REINTENTO_FALLIDA_MS - 1; m.obtener('n/falta.jpg', 'ficha480'); await m.esperar();
  assert.equal(a.lecturas.length, 1, 'cada formulario no vuelve a pedir la foto rota');
  reloj += 2; a.mapa.set('n/falta.jpg', ROJO);
  assert.equal(m.obtener('n/falta.jpg', 'ficha480'), null); await m.esperar();
  assert.equal(a.lecturas.length, 2); assert.equal(typeof m.enCache('n/falta.jpg', 'ficha480'), 'string');
});
await t('cola: tiene tope; lo que no cabe se descarta y se cuenta', async () => {
  const a = almacen({ 'n/rojo.jpg': ROJO }), m = crearMiniaturas({ leer: a.leer, maxCola: 2 });
  assert.equal(m.encolar('n/rojo.jpg'), 2);
  assert.equal(m.estado().descartadas, 1);
  await m.esperar();
  assert.equal(m.estado().entradas, 2);
});
await t('llaves peligrosas o mal formadas: ni se leen ni se encolan', async () => {
  const a = almacen({}), m = crearMiniaturas({ leer: a.leer, avisar: silencio });
  const malas = ['../secreto.jpg', 'n/../../x.jpg', '/etc/passwd', 'n//x.jpg', 'n/./x.jpg', 'n\\x.jpg', 'n/x .jpg', '', null, undefined, 42,
    `n/${'x'.repeat(520)}.jpg`, 'C:/x.jpg', 'n/x.jpg/'];
  for (const k of malas) {
    assert.equal(llaveDeAlmacenamientoValida(k), false, String(k));
    assert.equal(m.obtener(k, 'lista96'), null); assert.equal(m.encolar(k), 0);
  }
  await m.esperar();
  assert.deepEqual([a.lecturas.length, m.estado().pendientes], [0, 0]);
  for (const k of ['development/negocios/4b1c0d8e-0000-4000-8000-000000000000/productos/2f9e0c1a-1111-4222-8333-444455556666.webp',
    '0f7e/2f9e0c1a-1111-4222-8333-444455556666.pdf']) assert(llaveDeAlmacenamientoValida(k), k);
});

// ── Caché ────────────────────────────────────────────────────────────────
await t('caché: la llave es storage_key|variante (dos variantes de la misma foto son dos entradas)', async () => {
  const a = almacen({ 'n/rojo.jpg': ROJO }), m = crearMiniaturas({ leer: a.leer });
  m.encolar('n/rojo.jpg', ['lista96', 'ficha480']); await m.esperar();
  const [l, f] = [m.enCache('n/rojo.jpg', 'lista96'), m.enCache('n/rojo.jpg', 'ficha480')];
  assert.notEqual(l, f);
  assert.deepEqual([(await meta(l)).width, (await meta(f)).width], [96, 480]);
  assert.equal(m.enCache('n/rojo.jpg', 'cat128'), null);
  assert.equal(m.estado().entradas, 2);
});
await t('caché: una foto nueva es otra llave; la vieja nunca se devuelve por la nueva', async () => {
  const a = almacen({ 'n/v1.jpg': ROJO, 'n/v2.jpg': AZUL }), m = crearMiniaturas({ leer: a.leer });
  m.obtener('n/v1.jpg', 'lista96'); await m.esperar();
  assert(cerca(await pixel(m.enCache('n/v1.jpg', 'lista96'), 5, 5), [224, 16, 16]));
  assert.equal(m.obtener('n/v2.jpg', 'lista96'), null, 'la foto nueva no hereda la miniatura vieja');
  await m.esperar();
  assert(cerca(await pixel(m.obtener('n/v2.jpg', 'lista96'), 5, 5), [16, 48, 224]));
});
await t('caché LRU por entradas: se va la de uso más viejo, y leerla la renueva', async () => {
  const fotos = Object.fromEntries(['a', 'b', 'c', 'd'].map((k) => [`n/${k}.jpg`, ROJO]));
  const a = almacen(fotos), m = crearMiniaturas({ leer: a.leer, capacidad: 3 });
  for (const k of ['a', 'b', 'c']) { m.encolar(`n/${k}.jpg`, ['lista96']); await m.esperar(); }
  assert.notEqual(m.enCache('n/a.jpg', 'lista96'), null, 'a se usa: pasa a la más reciente');
  m.encolar('n/d.jpg', ['lista96']); await m.esperar();
  assert.equal(m.estado().entradas, 3);
  assert.equal(m.enCache('n/b.jpg', 'lista96'), null, 'b era la de uso más viejo');
  for (const k of ['a', 'c', 'd']) assert.notEqual(m.enCache(`n/${k}.jpg`, 'lista96'), null, k);
});
await t('caché LRU por bytes: no pasa de su tope de bytes', async () => {
  const a = almacen({ 'n/a.jpg': ROJO, 'n/b.jpg': AZUL }), m0 = crearMiniaturas({ leer: a.leer });
  m0.encolar('n/a.jpg', ['ficha480']); await m0.esperar();
  const una = m0.enCache('n/a.jpg', 'ficha480').length;
  const m = crearMiniaturas({ leer: a.leer, maxBytes: Math.floor(una * 1.5) });
  m.encolar('n/a.jpg', ['ficha480']); await m.esperar();
  m.encolar('n/b.jpg', ['ficha480']); await m.esperar();
  assert(m.estado().bytes <= Math.floor(una * 1.5), `${m.estado().bytes}`);
  assert.deepEqual([m.enCache('n/a.jpg', 'ficha480'), typeof m.enCache('n/b.jpg', 'ficha480')], [null, 'string']);
});
await t('vaciar: la caché queda vacía y las fallidas se olvidan', async () => {
  const a = almacen({ 'n/a.jpg': ROJO }), m = crearMiniaturas({ leer: a.leer, avisar: silencio });
  m.encolar('n/a.jpg', ['lista96']); m.encolar('n/b.jpg', ['lista96']); await m.esperar();
  assert.deepEqual([m.estado().entradas, m.estado().fallidasRecientes], [1, 1]);
  m.vaciar();
  assert.deepEqual([m.estado().entradas, m.estado().bytes, m.estado().fallidasRecientes], [0, 0, 0]);
  m.encolar('n/b.jpg', ['lista96']); await m.esperar();
  assert.equal(m.estado().lecturas, 3, 'olvidada, se vuelve a intentar');
});

// ── La instancia del servidor y el aislamiento ───────────────────────────
await t('la instancia del servidor: mismas reglas y nada se genera dentro de la llamada', async () => {
  assert.equal(miniaturaEnCache('n/inexistente.jpg', 'lista96'), null);
  assert.equal(encolarMiniaturas('../fuera.jpg'), 0);
  assert.equal(miniaturaOEncolar('../fuera.jpg', 'ficha480'), null);
  assert.equal(typeof miniaturasMenu.esperar, 'function');
  assert.deepEqual(miniaturasMenu.estado().lecturas, 0);
});
await t('aislado: el módulo no importa la base de datos (genera fuera de toda transacción)', () => {
  const fuente = readFileSync(new URL('../src/services/miniaturasMenu.js', import.meta.url), 'utf8');
  const imports = [...fuente.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./almacenamiento.js', 'sharp']);
  assert.doesNotMatch(fuente, /database\.js|\bpool\b|BEGIN|FOR UPDATE/);
});

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (miniaturas tienda)`);
process.exit(fallidas ? 1 : 0);
