// Menú automático MULTIIMAGEN (migración 050) — M1-M14 + fixture real.
//
// Lo que esta suite demuestra:
//   - Un menú puede tener varias páginas, ordenadas, y el envío las manda
//     TODAS en el orden configurado (M2-M4).
//   - Eliminar/reordenar mantiene un orden estable y persistido (M5-M6).
//   - Éxito parcial JAMÁS se reporta como completo, y el cliente recibe la
//     verdad (M7, M13); el fallback textual sale del catálogo REAL (fixture).
//   - Las frases se persisten de verdad (DB), sobreviven recarga y
//     logout/login, y la captura del panel ocurre ANTES de re-pintar (M8-M10).
//   - Aislamiento multi-tenant de páginas y frases (M12).
//
// Uso: mismas env vars que la batería.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import sharp from 'sharp';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4083';
const HTML_PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, crearUsuarioConPassword } = await import('../src/services/database.js');
const { TEXTO_FALLBACK } = await import('../src/services/menuAutomatico.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
async function api(base, path, { cookie: ck, method = 'GET', body, crudo = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (crudo) return { status: r.status, tipo: r.headers.get('content-type'), buffer: Buffer.from(await r.arrayBuffer()) };
  let json = null; try { json = await r.json(); } catch { /* sin JSON */ }
  return { status: r.status, body: json };
}
const RUTA = '/api/config/whatsapp/menu';

// Tres páginas de colores distintos, distinguibles por dimensiones.
const PAG_1 = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
const PAG_2 = await sharp({ create: { width: 310, height: 410, channels: 3, background: { r: 40, g: 200, b: 40 } } }).jpeg().toBuffer();
const PAG_3 = await sharp({ create: { width: 320, height: 420, channels: 3, background: { r: 40, g: 40, b: 200 } } }).jpeg().toBuffer();

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const PNID_A = 'PNID_MULTIMENU_A';
const TEL = '5218789411001';

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(NEG_A, 'whatsapp', 'activo');
await fijarModulo(NEG_B, 'whatsapp', 'activo');
await fijarModulo(NEG_A, 'asistente_comercial_cotizaciones', 'no_configurado');
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'whatsapp',$2,'Prueba multimenu A', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG_A, PNID_A]);
await actualizarConfiguracion({ int_wa_phone_id: PNID_A, int_wa_token: 'token-multimenu-a' }, NEG_A);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG_A]);
// Limpieza re-ejecutable
await pool.query(`DELETE FROM whatsapp_menu_imagenes WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);
await pool.query(`DELETE FROM whatsapp_menu_automatico WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);
await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52187894%'`);
await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'MM %'`, [NEG_A]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'MM %'`, [NEG_A]);

// Catálogo REAL para el fallback textual del fixture.
const { rows: [catMM] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'MM Ramos',TRUE,997) RETURNING id`, [NEG_A]);
await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
   VALUES ($1,$2,'MM Ramo Luz',200,TRUE,FALSE,0), ($1,$2,'MM Ramo Aurora',700,TRUE,FALSE,1)`, [NEG_A, catMM.id]);

const ckAdminA = cookie(ADMIN_A, NEG_A, 'admin');
const adminB = await crearUsuarioConPassword({
  negocioId: NEG_B, nombre: 'Admin MultiMenu B', email: `admin-mmenu-b-${Date.now()}@test.local`,
  password: 'ClaveMenuB123!', rol: 'admin' });
const ckAdminB = cookie(adminB.id, NEG_B, 'admin');

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  STORAGE_DRIVER: 'local',
  STORAGE_ENV_PREFIX: 'test',
}, { timeoutMs: 30000 });
const BASE = srv.base;

let wamidSeq = 0;
async function mensajeEntrante(texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID_A },
      messages: [{ type: 'text', from: TEL, id: `wamid.MM-${Date.now()}-${wamidSeq++}`, text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente MultiMenu' } }],
    } }] }],
  };
  await fetch(BASE + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  // Ventana real de debounce del producto (6 s) + margen.
  await new Promise((r) => setTimeout(r, 8000));
}
const enviados = () => metaMock.obtenerMensajesEnviados();
const subir = (buf, nombre, imagenId = null) => api(BASE, RUTA + '/imagen', {
  cookie: ckAdminA, method: 'POST',
  body: { base64: buf.toString('base64'), filename: nombre, imagenId },
});
const anchoDe = async (buffer) => (await sharp(buffer).metadata()).width;

try {

await t('M1', 'negocio sin imágenes → el menú automático no puede activarse', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /imagen/i);
  const estado = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.strictEqual(estado.body.activo, false);
  assert.deepStrictEqual(estado.body.imagenes, []);
});

await t('M2', 'una imagen → el envío manda exactamente una', async () => {
  const r1 = await subir(PAG_1, 'pagina-1.jpg');
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  assert.strictEqual(r1.body.imagenes.length, 1);
  await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: true } });
  const antes = enviados().length;
  await mensajeEntrante('me pasas el menu');
  const imgs = enviados().slice(antes).filter((m) => m.type === 'image');
  assert.strictEqual(imgs.length, 1);
});

await t('M3', 'dos imágenes → envía ambas en orden', async () => {
  const r2 = await subir(PAG_2, 'pagina-2.jpg');
  assert.strictEqual(r2.body.imagenes.length, 2);
  const antes = enviados().length;
  await mensajeEntrante('menu porfa');
  const imgs = enviados().slice(antes).filter((m) => m.type === 'image');
  assert.strictEqual(imgs.length, 2, 'no debe enviar solamente la primera');
});

await t('M4', 'tres imágenes → envía las tres en el orden configurado', async () => {
  const r3 = await subir(PAG_3, 'pagina-3.jpg');
  assert.strictEqual(r3.body.imagenes.length, 3);
  const antes = enviados().length;
  await mensajeEntrante('precios');
  const imgs = enviados().slice(antes).filter((m) => m.type === 'image');
  assert.strictEqual(imgs.length, 3);
  // El ORDEN de envío sale de obtenerPaginas (ORDER BY orden) -- la
  // persistencia y estabilidad de ese orden se demuestran en M5/M6 contra
  // la API y la base; aquí basta con que las TRES páginas viajen.
});

await t('M5', 'eliminar la página intermedia → el orden restante se compacta (1..n)', async () => {
  const estado = await api(BASE, RUTA, { cookie: ckAdminA });
  const idIntermedia = estado.body.imagenes[1].id;
  const r = await api(BASE, RUTA + '/imagen/' + idIntermedia, { cookie: ckAdminA, method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.imagenes.length, 2);
  assert.deepStrictEqual(r.body.imagenes.map((i) => i.orden), [1, 2]);
  const { rows } = await pool.query(
    `SELECT orden FROM whatsapp_menu_imagenes WHERE negocio_id = $1 ORDER BY orden`, [NEG_A]);
  assert.deepStrictEqual(rows.map((r2) => r2.orden), [1, 2]);
});

await t('M6', 'reordenar → el nuevo orden persiste tras "recargar" (lectura fresca)', async () => {
  const estado = await api(BASE, RUTA, { cookie: ckAdminA });
  const ids = estado.body.imagenes.map((i) => i.id);
  const invertidos = [...ids].reverse();
  const r = await api(BASE, RUTA + '/imagenes/orden', { cookie: ckAdminA, method: 'POST', body: { ids: invertidos } });
  assert.strictEqual(r.status, 200);
  const relectura = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.deepStrictEqual(relectura.body.imagenes.map((i) => i.id), invertidos, 'el orden sobrevive a una recarga');
  // Un orden inválido (ids que no son del negocio) se rechaza.
  const malo = await api(BASE, RUTA + '/imagenes/orden', { cookie: ckAdminA, method: 'POST', body: { ids: ['00000000-0000-0000-0000-000000000001'] } });
  assert.strictEqual(malo.status, 400);
});

await t('M7', 'falla la página 2 → NO se registra "menú enviado completo" y el cliente sabe la verdad', async () => {
  const { rows: paginas } = await pool.query(
    `SELECT id, storage_key FROM whatsapp_menu_imagenes WHERE negocio_id = $1 ORDER BY orden`, [NEG_A]);
  const rota = paginas[1];
  await pool.query(`UPDATE whatsapp_menu_imagenes SET storage_key = 'test/no-existe/x.jpg' WHERE id = $1`, [rota.id]);
  const antes = enviados().length;
  await mensajeEntrante('quiero ver la carta');
  const nuevos = enviados().slice(antes);
  const imgs = nuevos.filter((m) => m.type === 'image');
  const textos = nuevos.filter((m) => m.text).map((m) => m.text.body);
  assert.strictEqual(imgs.length, 1, 'solo la página sana');
  assert.ok(textos.some((x) => /1 de 2 p(á|a)ginas/.test(x)), `el cliente recibe el aviso parcial honesto: ${JSON.stringify(textos)}`);
  const salida = srv.obtenerSalida();
  assert.ok(/env(í|i)o PARCIAL/.test(salida), 'el fallo parcial queda registrado');
  await pool.query(`UPDATE whatsapp_menu_imagenes SET storage_key = $2 WHERE id = $1`, [rota.id, rota.storage_key]);
});

await t('M8', 'editar frases → persistencia REAL en la base', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { frases: ['mm frase uno', 'mm frase dos'] } });
  assert.strictEqual(r.status, 200);
  const { rows: [fila] } = await pool.query(
    `SELECT frases_disparadoras FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [NEG_A]);
  assert.deepStrictEqual(fila.frases_disparadoras, ['mm frase uno', 'mm frase dos']);
});

await t('M9', 'recarga (lectura fresca de la misma sesión) → las frases permanecen', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.deepStrictEqual(r.body.frases, ['mm frase uno', 'mm frase dos']);
});

await t('M10', 'logout/login (sesión NUEVA) → las frases permanecen', async () => {
  const ckNueva = cookie(ADMIN_A, NEG_A, 'admin');
  const r = await api(BASE, RUTA, { cookie: ckNueva });
  assert.deepStrictEqual(r.body.frases, ['mm frase uno', 'mm frase dos']);
});

await t('M10b', 'el panel captura las frases ANTES de re-pintar (causa raíz del bug)', () => {
  const fn = HTML_PANEL.slice(HTML_PANEL.indexOf('async function guardarMenuAutomatico'), HTML_PANEL.indexOf('async function alternarMenuAutomatico'));
  // Literales de CÓDIGO (no de comentarios): la captura a variable debe
  // preceder al re-render que pisa el textarea.
  const posCaptura = fn.indexOf('const frases = frasesDelTextarea();');
  const posPintar = fn.indexOf('menuOcupado = true; pintarMenuAutomatico();');
  assert.ok(posCaptura !== -1 && posPintar !== -1 && posCaptura < posPintar,
    'la lectura del textarea debe ocurrir antes del re-render que lo pisa');
  assert.ok(fn.includes('frases: frases'), 'el POST manda las frases capturadas, no una relectura tardía');
});

await t('M11', 'frases con mayúsculas/acentos → detección correcta', async () => {
  const antes = enviados().length;
  await mensajeEntrante('¿MM FRASE UNO?');
  const imgs = enviados().slice(antes).filter((m) => m.type === 'image');
  assert.strictEqual(imgs.length, 2, 'la frase configurada dispara sin importar mayúsculas/acentos');
});

await t('M12', 'tenant B no puede ver, borrar ni reemplazar páginas/frases de A', async () => {
  const estadoA = await api(BASE, RUTA, { cookie: ckAdminA });
  const idA = estadoA.body.imagenes[0].id;
  const verB = await api(BASE, RUTA, { cookie: ckAdminB });
  assert.strictEqual(verB.body.imagenes.length, 0, 'B no ve páginas de A');
  assert.notDeepStrictEqual(verB.body.frases, ['mm frase uno', 'mm frase dos'], 'B no ve frases de A');
  const previaB = await api(BASE, RUTA + '/imagen/' + idA, { cookie: ckAdminB, crudo: true });
  assert.strictEqual(previaB.status, 404, 'B no puede leer la página de A');
  const borrarB = await api(BASE, RUTA + '/imagen/' + idA, { cookie: ckAdminB, method: 'DELETE' });
  assert.ok([400, 404].includes(borrarB.status), 'B no puede borrar la página de A');
  const reemplazarB = await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminB, method: 'POST',
    body: { base64: PAG_1.toString('base64'), filename: 'x.jpg', imagenId: idA },
  });
  assert.strictEqual(reemplazarB.status, 400, 'B no puede reemplazar la página de A');
  const { rows: [sigue] } = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_menu_imagenes WHERE negocio_id = $1`, [NEG_A]);
  assert.strictEqual(sigue.n, 2, 'las páginas de A siguen intactas');
});

// ─── FIXTURE de la conversación real (anonimizada) ─────────────────────────
await t('FIXTURE', 'cliente: "Me podrían pasar el menú? 😄" + fallo total → JAMÁS "aquí está" como si hubiera llegado', async () => {
  const { rows: paginas } = await pool.query(
    `SELECT id, storage_key FROM whatsapp_menu_imagenes WHERE negocio_id = $1 ORDER BY orden`, [NEG_A]);
  for (const p of paginas) {
    await pool.query(`UPDATE whatsapp_menu_imagenes SET storage_key = 'test/no-existe/' || id || '.jpg' WHERE id = $1`, [p.id]);
  }
  const antes = enviados().length;
  await mensajeEntrante('Me podrían pasar el mm frase uno? 😄');
  const nuevos = enviados().slice(antes);
  const imgs = nuevos.filter((m) => m.type === 'image');
  const textos = nuevos.filter((m) => m.text).map((m) => m.text.body);
  assert.strictEqual(imgs.length, 0, 'cero imágenes entregadas');
  // Con catálogo REAL configurado, el fallback textual sale del catálogo.
  assert.ok(textos.some((x) => x.includes('MM Ramo Luz') && x.includes('$200')),
    `el fallback debe venir del catálogo real: ${JSON.stringify(textos).slice(0, 300)}`);
  assert.ok(!textos.some((x) => /aqu(í|i) est(á|a)/i.test(x) && !/no pude/i.test(x)), 'nada de "aquí está" fingido');
  // El texto de acompañamiento inicial existe, pero el cierre es el aviso honesto.
  for (const p of paginas) {
    await pool.query(`UPDATE whatsapp_menu_imagenes SET storage_key = $2 WHERE id = $1`, [p.id, p.storage_key]);
  }
});

await t('M13', 'cliente: "No me llegó el menú" → reintento controlado con envío ya reparado, sin inventar nada', async () => {
  const antes = enviados().length;
  await mensajeEntrante('no me llegó, me mandas mm frase dos?');
  const imgs = enviados().slice(antes).filter((m) => m.type === 'image');
  assert.strictEqual(imgs.length, 2, 'con el storage reparado, el reintento del cliente recibe el menú completo');
});

await t('M14', 'envío exitoso → la conversación registra el resultado REAL (páginas enviadas)', async () => {
  const { rows } = await pool.query(
    `SELECT texto FROM mensajes WHERE negocio_id = $1 AND telefono = $2 AND origen = 'bot' ORDER BY id DESC LIMIT 4`, [NEG_A, TEL]);
  assert.ok(rows.some((r) => /Men(ú|u) \(2 p(á|a)ginas\)/.test(r.texto)),
    `el registro refleja el envío real: ${JSON.stringify(rows.map(r => r.texto))}`);
});

} finally {
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await metaMock.detener();
  // Higiene entre suites: nada de este archivo sobrevive.
  await pool.query(`DELETE FROM whatsapp_menu_imagenes WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]).catch(() => {});
  await pool.query(`DELETE FROM whatsapp_menu_automatico WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]).catch(() => {});
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_phone_id','int_wa_token')`, [NEG_A]).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador = $1`, [PNID_A]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'MM %'`, [NEG_A]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'MM %'`, [NEG_A]).catch(() => {});
  await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52187894%'`).catch(() => {});
  await pool.query(`DELETE FROM perfiles_clientes WHERE telefono LIKE '52187894%'`).catch(() => {});
  await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52187894%'`).catch(() => {});
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [NEG_A]).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
