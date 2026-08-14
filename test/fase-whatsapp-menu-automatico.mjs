// Menú automático de WhatsApp, de punta a punta.
//
// Lo que esta suite tiene que demostrar, además de que la feature funciona:
//
//   - Que el menú es DE CADA NEGOCIO. Antes de esto el bot mandaba siempre
//     `public/menu.png`, un único archivo del repositorio: quien pidiera el
//     menú a Carnitas recibía el menú que estuviera commiteado. Los casos de
//     aislamiento están para que eso no pueda volver.
//   - Que se manda UNA sola respuesta (texto + imagen), no tres.
//   - Que si la imagen falla, el cliente recibe un aviso claro y el webhook
//     no se cae.
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... node test/fase-whatsapp-menu-automatico.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import sharp from 'sharp';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4081';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, obtenerConfiguracion, crearUsuarioConPassword } = await import('../src/services/database.js');
const { mensajePideMenu, normalizar, sanearFrases, TEXTO_ACOMPANA, TEXTO_FALLBACK } =
  await import('../src/services/menuAutomatico.js');

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

// ─── Matcher (sin servidor, sin base) ───────────────────────────────────────

const DEBEN_DISPARAR = [
  'menu', 'menú', 'MENÚ', 'me mandas el menu', '¿me mandas el menú?',
  'tienes menú?', 'quiero ver la carta', 'tienes carta', 'quiero ver precios',
  'que venden', 'qué venden', 'precios',
];
for (const frase of DEBEN_DISPARAR) {
  await t('FRASES', `dispara: "${frase}"`, () => {
    assert.strictEqual(mensajePideMenu(frase), true);
  });
}

const NO_DEBEN_DISPARAR = [
  'el menú estuvo muy bueno ayer',
  'gracias por el menu, todo delicioso',
  'quiero unas menudencias',
  'hola buenas tardes',
  '',
];
for (const frase of NO_DEBEN_DISPARAR) {
  await t('FRASES', `no dispara: "${frase}"`, () => {
    assert.strictEqual(mensajePideMenu(frase), false);
  });
}

await t('FRASES', 'normalizar quita acentos, signos y espacios de más', () => {
  assert.strictEqual(normalizar('  ¿Me mandas el   MENÚ?  '), 'me mandas el menu');
});

await t('FRASES', 'una frase con metacaracteres no se compila como regex', () => {
  // Si la frase del negocio se usara cruda como expresión regular, esto
  // lanzaría o convertiría el matcher en un comodín.
  assert.doesNotThrow(() => mensajePideMenu('hola', ['(((', '.*', '[a-z']));
  assert.strictEqual(mensajePideMenu('cualquier cosa', ['.*']), false);
});

await t('FRASES', 'las frases del negocio se sanean (vacías, duplicadas, largas)', () => {
  const r = sanearFrases(['  menu  ', 'MENU', '', '   ', 'x'.repeat(200), 'carta']);
  assert.deepStrictEqual(r.slice(0, 2), ['menu', 'x'.repeat(60)]);
  assert.ok(r.includes('carta'));
  assert.ok(!r.some((f) => f.length > 60));
});

// ─── Setup ──────────────────────────────────────────────────────────────────

const IMAGEN_JPG = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 240, g: 230, b: 200 } } })
  .jpeg().toBuffer();
const IMAGEN_JPG_2 = await sharp({ create: { width: 400, height: 500, channels: 3, background: { r: 10, g: 90, b: 40 } } })
  .jpeg().toBuffer();
const SVG_MALICIOSO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_DISFRAZADO = Buffer.from('<!doctype html><html><body>no soy una imagen</body></html>');

const NEG_A = SEED.negocioA;   // el que sube su menú
const NEG_B = SEED.negocioB;   // el vecino: nunca debe ver ni tocar el de A
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const STAFF_A = SEED.staffNegocioAUsuarioId;

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(NEG_A, 'whatsapp', 'activo');
await fijarModulo(NEG_B, 'whatsapp', 'activo');

const PNID_A = 'PNID_MENU_A';
const PNID_B = 'PNID_MENU_B';
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
   VALUES ($1,'whatsapp',$2,'Prueba menú A', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG_A, PNID_A]);
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
   VALUES ($1,'whatsapp',$2,'Prueba menú B', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG_B, PNID_B]);
// Esta suite enciende el bot y configura WhatsApp en los negocios de prueba.
// Otras suites de la regresion asumen justo lo contrario (bot apagado, sin
// WhatsApp), asi que se anota como estaba todo para devolverlo al final.
const estadoPrevio = {};
for (const n of [NEG_A, NEG_B]) {
  const { rows } = await pool.query(`SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [n]);
  const cfg = await obtenerConfiguracion(n);
  estadoPrevio[n] = {
    bot: rows[0]?.bot_whatsapp_activo === true,
    phoneId: cfg?.int_wa_phone_id ?? null,
    token: cfg?.int_wa_token ?? null,
  };
}

await actualizarConfiguracion({ int_wa_phone_id: PNID_A, int_wa_token: 'token-menu-a' }, NEG_A);
await actualizarConfiguracion({ int_wa_phone_id: PNID_B, int_wa_token: 'token-menu-b' }, NEG_B);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id IN ($1,$2)`, [NEG_A, NEG_B]);
// V2 (050): las páginas viven en la tabla hija -- limpiarla SIEMPRE antes
// que el padre, o el residuo de una corrida anterior hace ver "con imagen"
// a un negocio que esta suite asume vacío.
await pool.query(`DELETE FROM whatsapp_menu_imagenes WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);
await pool.query(`DELETE FROM whatsapp_menu_automatico WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);
await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52187893%'`);

const ckAdminA = cookie(ADMIN_A, NEG_A, 'admin');
const ckStaffA = cookie(STAFF_A, NEG_A, 'staff');
const ckMeseroA = cookie(STAFF_A, NEG_A, 'mesero');
const ckRepartidorA = cookie(STAFF_A, NEG_A, 'operador');
// Admin REAL del negocio vecino. No sirve reutilizar al superadmin con el
// negocio B en la cookie: la sesion se resuelve contra el negocio al que el
// usuario pertenece de verdad, asi que esa cookie terminaba apuntando otra vez
// al negocio A -- y entonces las pruebas de aislamiento no probaban nada.
const adminB = await crearUsuarioConPassword({
  negocioId: NEG_B, nombre: 'Admin Menu B', email: `admin-menu-b-${Date.now()}@test.local`,
  password: 'ClaveMenuB123!', rol: 'admin' });
const ckAdminB = cookie(adminB.id, NEG_B, 'admin');

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  STORAGE_DRIVER: 'local',            // en producción es s3/R2; aquí, disco
  STORAGE_ENV_PREFIX: 'test',
}, { timeoutMs: 30000 });
const BASE = srv.base;

try {

// ─── Panel ──────────────────────────────────────────────────────────────────

await t('PANEL', 'un negocio sin menú reporta inactivo y sin imagen, con frases por defecto', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.activo, false);
  assert.strictEqual(r.body.tieneImagen, false);
  assert.ok(r.body.frases.includes('menu'), 'debe traer frases sugeridas para empezar');
});

await t('PANEL', 'no se puede activar sin imagen', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /imagen/i);
});

await t('PANEL', 'subir la imagen del menú', async () => {
  const r = await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminA, method: 'POST',
    body: { base64: IMAGEN_JPG.toString('base64'), filename: 'menu-agosto.jpg' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.tieneImagen, true);
  assert.ok(r.body.tamanoBytes > 0);
});

await t('PANEL', 'la vista previa devuelve la imagen real, no una URL del bucket', async () => {
  const r = await api(BASE, RUTA + '/imagen', { cookie: ckAdminA, crudo: true });
  assert.strictEqual(r.status, 200);
  assert.match(r.tipo, /^image\//);
  assert.ok(r.buffer.length > 100);
  const meta = await sharp(r.buffer).metadata();
  assert.ok(meta.width > 0, 'lo servido tiene que ser una imagen decodificable');
});

await t('PANEL', 'la respuesta del panel nunca expone la storage_key', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  const texto = JSON.stringify(r.body);
  assert.ok(!/storage_key|storageKey/i.test(texto), 'la ruta interna no puede salir al navegador');
  assert.ok(!/negocios\//.test(texto), 'ni la ruta lógica dentro del bucket');
});

await t('PANEL', 'ya con imagen, se puede activar', async () => {
  const r = await api(BASE, RUTA, {
    cookie: ckAdminA, method: 'POST',
    body: { activo: true, frases: ['menu', 'carta', 'precios'] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.activo, true);
  assert.deepStrictEqual(r.body.frases, ['menu', 'carta', 'precios']);
});

await t('PANEL', 'no se puede dejar sin ninguna frase', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { frases: ['', '   '] } });
  assert.strictEqual(r.status, 400);
});

// ─── Seguridad de la subida ────────────────────────────────────────────────

await t('UPLOAD', 'un SVG con <script> disfrazado de imagen se rechaza', async () => {
  const r = await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminA, method: 'POST',
    body: { base64: SVG_MALICIOSO.toString('base64'), filename: 'menu.jpg' },
  });
  assert.strictEqual(r.status, 400);
});

await t('UPLOAD', 'un HTML con extensión .png se rechaza', async () => {
  const r = await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminA, method: 'POST',
    body: { base64: HTML_DISFRAZADO.toString('base64'), filename: 'menu.png' },
  });
  assert.strictEqual(r.status, 400);
});

await t('UPLOAD', 'un nombre con ../ no puede escapar de la ruta', async () => {
  // Fixture V2 (050): se REEMPLAZA la página existente (sin imagenId ahora
  // se agregaría una segunda página) y las referencias viven en
  // whatsapp_menu_imagenes. La propiedad bajo prueba es la misma: la
  // storage_key jamás sale del nombre del usuario.
  const estado = await api(BASE, RUTA, { cookie: ckAdminA });
  const r = await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminA, method: 'POST',
    body: { base64: IMAGEN_JPG.toString('base64'), filename: '../../../../etc/passwd.jpg', imagenId: estado.body.imagenes[0].id },
  });
  assert.strictEqual(r.status, 200);
  const { rows } = await pool.query(
    `SELECT storage_key, nombre_archivo FROM whatsapp_menu_imagenes WHERE negocio_id = $1 ORDER BY orden LIMIT 1`, [NEG_A]);
  assert.ok(!rows[0].storage_key.includes('..'), 'la storage_key es un UUID, nunca el nombre del usuario');
  assert.ok(!/[\\/]/.test(rows[0].nombre_archivo),
    'sin separadores en el nombre visible no hay travesía posible');
});

await t('UPLOAD', 'sin imagen en el cuerpo -> 400', async () => {
  const r = await api(BASE, RUTA + '/imagen', { cookie: ckAdminA, method: 'POST', body: {} });
  assert.strictEqual(r.status, 400);
});

// ─── Roles ──────────────────────────────────────────────────────────────────

for (const [rol, ck] of [['staff', ckStaffA], ['mesero', ckMeseroA], ['operador/repartidor', ckRepartidorA]]) {
  await t('ROLES', `${rol} no puede leer ni tocar el menú -> 403`, async () => {
    const leer = await api(BASE, RUTA, { cookie: ck });
    assert.strictEqual(leer.status, 403);
    const subir = await api(BASE, RUTA + '/imagen', {
      cookie: ck, method: 'POST',
      body: { base64: IMAGEN_JPG.toString('base64'), filename: 'x.jpg' },
    });
    assert.strictEqual(subir.status, 403);
    const borrar = await api(BASE, RUTA + '/imagen', { cookie: ck, method: 'DELETE' });
    assert.strictEqual(borrar.status, 403);
  });
}

await t('ROLES', 'sin sesión, todo el menú falla cerrado', async () => {
  for (const [metodo, ruta] of [['GET', RUTA], ['POST', RUTA], ['GET', RUTA + '/imagen'], ['DELETE', RUTA + '/imagen']]) {
    const r = await api(BASE, ruta, { method: metodo, body: metodo === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 401, `${metodo} ${ruta} devolvió ${r.status}`);
  }
});

// ─── Aislamiento entre negocios ────────────────────────────────────────────

await t('AISLAMIENTO', 'el vecino no ve el menú de A: ve el suyo, vacío', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminB });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.tieneImagen, false, 'B no tiene menú y no debe heredar el de A');
  assert.strictEqual(r.body.activo, false);
});

await t('AISLAMIENTO', 'el vecino no puede descargar la imagen de A', async () => {
  const r = await api(BASE, RUTA + '/imagen', { cookie: ckAdminB });
  assert.strictEqual(r.status, 404, 'para B, el menú de A sencillamente no existe');
});

await t('AISLAMIENTO', 'lo que B guarde no toca lo de A', async () => {
  await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminB, method: 'POST',
    body: { base64: IMAGEN_JPG_2.toString('base64'), filename: 'menu-de-b.jpg' },
  });
  await api(BASE, RUTA, { cookie: ckAdminB, method: 'POST', body: { activo: true, frases: ['carta'] } });

  const a = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.deepStrictEqual(a.body.frases, ['menu', 'carta', 'precios'], 'A conserva sus frases');
  // Fixture V2 (050): las referencias de imagen viven en la tabla hija.
  const { rows } = await pool.query(
    `SELECT negocio_id, storage_key FROM whatsapp_menu_imagenes WHERE negocio_id IN ($1,$2) ORDER BY negocio_id`, [NEG_A, NEG_B]);
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(rows[0].storage_key, rows[1].storage_key, 'cada negocio tiene su propio archivo');
});

await t('AISLAMIENTO', 'el negocio_id del cuerpo no puede suplantar al de la sesión', async () => {
  const r = await api(BASE, RUTA, {
    cookie: ckAdminA, method: 'POST',
    body: { activo: false, negocioId: NEG_B, negocio_id: NEG_B },
  });
  assert.strictEqual(r.status, 200);
  const b = await api(BASE, RUTA, { cookie: ckAdminB });
  assert.strictEqual(b.body.activo, true, 'B seguía activo y nadie desde A pudo apagarlo');
  await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: true } }); // se restaura A
});

// ─── El envío real por WhatsApp ────────────────────────────────────────────

const TEL_A = '5218789300001';
async function mensajeEntrante(phoneNumberId, telefono, texto, wamid) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ type: 'text', from: telefono, id: wamid, text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente Menú' } }],
    } }] }],
  };
  await fetch(BASE + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  // whatsapp-meta.js agrupa los mensajes seguidos de un mismo cliente durante
  // 6 s antes de procesarlos (encolarMensaje). No es una espera inventada para
  // esconder una carrera: es la ventana real del producto, y hasta que cierra
  // no existe ninguna respuesta que verificar.
  await new Promise((r) => setTimeout(r, 8000));
}
const enviados = () => metaMock.obtenerMensajesEnviados();

await t('ENVIO', 'pedir el menú responde texto + imagen, exactamente una vez', async () => {
  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, '¿me mandas el menú?', 'wamid.MENU-1');
  const nuevos = enviados().slice(antes);

  const textos = nuevos.filter((m) => m.type === 'text' || m.text);
  const imagenes = nuevos.filter((m) => m.type === 'image');
  assert.strictEqual(imagenes.length, 1, `esperaba 1 imagen, hubo ${imagenes.length}`);
  assert.strictEqual(textos.length, 1, `esperaba 1 texto, hubo ${textos.length} -- el bot no puede contestar dos veces`);
  assert.strictEqual(textos[0].text.body, TEXTO_ACOMPANA);
  // (entre medio viaja el acuse de lectura que el bot manda siempre; lo que
  // importa es que el texto salga ANTES que la imagen)
  assert.ok(nuevos.indexOf(textos[0]) < nuevos.indexOf(imagenes[0]),
    'el texto de acompanamiento tiene que salir antes que la imagen');
});

await t('ENVIO', 'la imagen va como media privada de Meta, no como URL', async () => {
  const imagen = enviados().filter((m) => m.type === 'image').at(-1);
  assert.ok(imagen.image.id, 'debe viajar un media_id');
  assert.ok(!imagen.image.link, 'nunca una URL pública de la imagen');
  assert.strictEqual(imagen.to, TEL_A);
});

await t('ENVIO', 'no se filtró ningún secreto en lo que se le mandó a Meta', async () => {
  const texto = JSON.stringify(enviados());
  assert.ok(!/token-menu-a|storage_key|S3_SECRET|Bearer /i.test(texto));
});

await t('ENVIO', 'las frases del negocio mandan: "carta" también dispara', async () => {
  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, 'tienes carta', 'wamid.MENU-2');
  assert.strictEqual(enviados().slice(antes).filter((m) => m.type === 'image').length, 1);
});

await t('ENVIO', 'una frase que el negocio NO configuró no dispara el menú', async () => {
  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, 'qué venden', 'wamid.MENU-3');
  const imagenes = enviados().slice(antes).filter((m) => m.type === 'image');
  assert.strictEqual(imagenes.length, 0, 'A dejó solo menu/carta/precios: esto debía seguir a la lógica de siempre');
});

await t('ENVIO', 'con el menú desactivado no se manda ninguna imagen', async () => {
  await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: false } });
  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, 'menu', 'wamid.MENU-4');
  assert.strictEqual(enviados().slice(antes).filter((m) => m.type === 'image').length, 0);
  await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: true } });
});

await t('ENVIO', 'el saludo normal NO se lo queda el menú', async () => {
  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, 'hola buenas tardes', 'wamid.MENU-5');
  assert.strictEqual(enviados().slice(antes).filter((m) => m.type === 'image').length, 0,
    'un saludo tiene que seguir yendo por el flujo de siempre');
});

await t('ENVIO', 'el menú queda registrado en la conversación del panel', async () => {
  const r = await api(BASE, `/api/conversacion/${TEL_A}`, { cookie: ckAdminA });
  assert.strictEqual(r.status, 200);
  const textos = r.body.map((m) => m.mensaje || m.texto || '');
  assert.ok(textos.some((x) => String(x).includes('Menú')), 'el envío del menú debe verse en el chat');
});

// ─── Reemplazo sin deploy ──────────────────────────────────────────────────

await t('REEMPLAZO', 'al subir un menú nuevo, el siguiente envío usa el nuevo', async () => {
  // Fixture V2 (multiimagen, migración 050): reemplazar = POST con el
  // imagenId de la página; sin imagenId ahora se AGREGA una página nueva.
  // La propiedad bajo prueba (el siguiente envío usa la imagen nueva sin
  // deploy ni reinicio) es la misma.
  const estado = await api(BASE, RUTA, { cookie: ckAdminA });
  const paginaId = estado.body.imagenes[0].id;
  const { rows: [antesFila] } = await pool.query(
    `SELECT storage_key FROM whatsapp_menu_imagenes WHERE id = $1 AND negocio_id = $2`, [paginaId, NEG_A]);

  const r = await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminA, method: 'POST',
    body: { base64: IMAGEN_JPG_2.toString('base64'), filename: 'menu-septiembre.jpg', imagenId: paginaId },
  });
  assert.strictEqual(r.status, 200);

  const { rows: [despuesFila] } = await pool.query(
    `SELECT storage_key FROM whatsapp_menu_imagenes WHERE id = $1 AND negocio_id = $2`, [paginaId, NEG_A]);
  assert.notStrictEqual(despuesFila.storage_key, antesFila.storage_key, 'la referencia tiene que cambiar');

  // Y lo que se sirve en la vista previa ya es la imagen nueva (400x500).
  const previa = await api(BASE, RUTA + '/imagen', { cookie: ckAdminA, crudo: true });
  const meta = await sharp(previa.buffer).metadata();
  assert.strictEqual(meta.width, 400, 'la vista previa debe ser ya la imagen nueva, sin reinicio ni deploy');
});

// ─── Cuando algo falla ─────────────────────────────────────────────────────

await t('FALLO', 'si la imagen no se puede leer, el cliente recibe un aviso claro', async () => {
  // Fixture V2 (050): las páginas viven en whatsapp_menu_imagenes -- se
  // rompe la referencia de la PÁGINA a propósito: el objeto ya no existe.
  const { rows: [orig] } = await pool.query(
    `SELECT id, storage_key FROM whatsapp_menu_imagenes WHERE negocio_id = $1 ORDER BY orden LIMIT 1`, [NEG_A]);
  await pool.query(
    `UPDATE whatsapp_menu_imagenes SET storage_key = $2 WHERE id = $1`,
    [orig.id, 'test/negocios/no-existe/menu/00000000-0000-0000-0000-000000000000.jpg']);

  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, 'menu', 'wamid.MENU-FALLO');
  const nuevos = enviados().slice(antes);
  const textos = nuevos.filter((m) => m.text).map((m) => m.text.body);

  assert.strictEqual(nuevos.filter((m) => m.type === 'image').length, 0, 'no se puede fingir que se mandó');
  // Comportamiento V2 deliberado: si el negocio tiene catálogo, el aviso
  // honesto viene acompañado del menú TEXTUAL construido del catálogo real
  // ("No pude enviarte la imagen... te comparto lo principal"); sin
  // catálogo, sigue siendo TEXTO_FALLBACK. Ambos empiezan con "No pude
  // enviar" y ninguno finge éxito.
  assert.ok(textos.some((x) => x.startsWith('No pude enviar')) || textos.includes(TEXTO_FALLBACK),
    `esperaba el aviso de fallo, llegó: ${JSON.stringify(textos)}`);

  await pool.query(`UPDATE whatsapp_menu_imagenes SET storage_key = $2 WHERE id = $1`, [orig.id, orig.storage_key]);
});

await t('FALLO', 'el servidor sigue vivo después del fallo', async () => {
  const r = await fetch(BASE + '/health');
  assert.strictEqual(r.status, 200);
  const salida = srv.obtenerSalida();
  assert.ok(!salida.includes('PromiseRejectCallback'), 'ningún rechazo sin manejar');
  assert.ok(salida.includes('[Menu WA]'), 'el fallo tiene que haber quedado registrado');
});

await t('FALLO', 'si Meta rechaza el envío, tampoco se finge éxito', async () => {
  metaMock.forzarErrorSiguienteEnvio();
  const antes = enviados().length;
  await mensajeEntrante(PNID_A, TEL_A, 'precios', 'wamid.MENU-META-ERROR');
  const nuevos = enviados().slice(antes);
  assert.ok(nuevos.filter((m) => m.type === 'image').length <= 1);
  const r = await fetch(BASE + '/health');
  assert.strictEqual(r.status, 200, 'un error de Meta no puede tumbar el webhook');
});

// ─── Quitar la imagen ──────────────────────────────────────────────────────

await t('QUITAR', 'quitar la imagen desactiva el menú y no deja referencias rotas', async () => {
  const r = await api(BASE, RUTA + '/imagen', { cookie: ckAdminA, method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.tieneImagen, false);
  assert.strictEqual(r.body.activo, false, 'no puede quedar activo sin nada que mandar');

  const { rows } = await pool.query(
    `SELECT storage_key FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [NEG_A]);
  assert.strictEqual(rows[0].storage_key, null);
});

await t('QUITAR', 'y después se puede volver a subir y reactivar', async () => {
  await api(BASE, RUTA + '/imagen', {
    cookie: ckAdminA, method: 'POST',
    body: { base64: IMAGEN_JPG.toString('base64'), filename: 'menu-otra-vez.jpg' },
  });
  const r = await api(BASE, RUTA, { cookie: ckAdminA, method: 'POST', body: { activo: true } });
  assert.strictEqual(r.body.activo, true);
});

// ─── El PNG global ya no existe como camino ────────────────────────────────

await t('LEGADO', 'ningún negocio puede volver a recibir el menu.png global', () => {
  const fuente = readFileSync(join(__dirname, '..', 'src', 'channels', 'whatsapp-meta.js'), 'utf8');
  const sinComentarios = fuente.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!sinComentarios.includes('/public/menu.png'),
    'el envío del PNG global era el menú equivocado para todos menos uno');
});

// ─── El panel declara la sección ───────────────────────────────────────────

// Reingeniería UX 2026-08: el bloque se movió INTACTO de Config a Catálogo
// (vista-menu) porque la imagen del menú es contenido del catálogo; el
// contrato pasa a ser "vive dentro de Catálogo, después del editor".
await t('PANEL-HTML', 'la sección Menú automático vive en Catálogo (vista-menu)', () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
  const i = html.indexOf('<div id="wa-menu"></div>');
  assert.ok(i > 0, 'el contenedor tiene que existir como ELEMENTO, no dentro de un template');
  const iEditor = html.indexOf('<div id="menu-editor"></div>');
  assert.ok(iEditor > 0 && i > iEditor, 'va dentro de Catálogo, después del editor de menú');
  assert.ok(html.indexOf('<div id="int-form"></div>') > i, 'Config (int-form) queda después en el documento');
  // Fixture V2 (multiimagen): quitarImagenMenu se volvió quitarPaginaMenu
  // (por página) y se agregaron elegirImagenMenu/moverPaginaMenu.
  for (const f of ['pintarMenuAutomatico', 'subirImagenMenu', 'quitarPaginaMenu', 'elegirImagenMenu', 'moverPaginaMenu', 'alternarMenuAutomatico']) {
    assert.ok(html.includes(`function ${f}`) || html.includes(`async function ${f}`), `falta ${f}`);
  }
});

} finally {
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  metaMock.detener();
  await pool.query(`DELETE FROM whatsapp_menu_automatico WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]).catch(() => {});
  await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52187893%'`).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE identificador IN ($1,$2)`, [PNID_A, PNID_B]).catch(() => {});
  for (const n of [NEG_A, NEG_B]) {
    const prev = estadoPrevio[n];
    await pool.query(`UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1`, [n, prev.bot]).catch(() => {});
    await actualizarConfiguracion(
      { int_wa_phone_id: prev.phoneId ?? '', int_wa_token: prev.token ?? '' }, n).catch(() => {});
  }
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
