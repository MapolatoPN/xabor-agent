// EL MENÚ EN IMAGEN NO PUEDE MOSTRAR LO QUE EL NEGOCIO RETIRÓ DE WHATSAPP.
//
// Una imagen del menú es opaca. Desde la migración 100 solo sale si su
// administrador la revisó contra la carta de WhatsApp VIGENTE; si la carta o
// las imágenes cambiaron desde esa revisión —o no se puede comprobar—, el
// cliente recibe el menú EN TEXTO generado desde la carta. Por el canal real
// (servidor hijo; Meta y Anthropic simulados; nada sale de la máquina), con un
// negocio propio que tiene una categoría EXTRAS y una «Pieza de Hotcake»:
//
//   R0-R1   nunca revisado: el panel lo explica y «menú» saca el menú en texto
//           (sin EXTRAS), cero imágenes, sin llamar al modelo.
//   R2-R4   la revisión: roles, aislamiento, compare-and-set (409) y registro.
//   R5-R7   revisado sale la imagen; retirar «Pieza de Hotcake» en el panel la
//           invalida (texto sin la Pieza); republicarla la vuelve a validar.
//   R8      cada cambio de carta por SQL la invalida: publicación, categoría,
//           precio, nombre, disponible, producto nuevo, resiembra, borrado en
//           cascada. `agotado` no (es el faltante del día).
//   R9      cada cambio de IMÁGENES la invalida (agregar, reemplazar, SQL);
//           reordenar no.
//   R10     sin poder comprobar (función ilegible): texto, fallo cerrado.
//   R11     herramienta enviar_menu del Mesero: sale el texto y el modelo NO
//           recibe «no se pudo enviar el menú».
//   R12     la imagen V1 que reaparece al borrar la última página no sale.
//   R13     marcador <ENVIAR_MENU> del bot legacy: texto sin «Aquí está nuestro
//           menú» mientras no esté revisado; imagen cuando sí.
//   R14-R15 panel (HTML) y unidades puras.
//   R16     sin nada disponible que listar sale el aviso genérico, y para el
//           Mesero eso NO es un menú entregado.
//   R17     una carta larga no se corta en silencio: dice que hay más.
//
// Uso: DATABASE_URL=<local> node test/fase-menu-revision-carta.mjs
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { publicarCartaWhatsapp, retirarDeWhatsapp } from './lib-carta-whatsapp.mjs';
import { pool, actualizarConfiguracion, crearUsuarioConPassword } from '../src/services/database.js';
import { crearTokenSesion } from '../src/services/session.js';
import { TEXTO_ACOMPANA, TEXTO_MENU_EN_TEXTO, TEXTO_FALLBACK, enviarMenuAutomatico, menuTextualDesdeCatalogo } from '../src/services/menuAutomatico.js';
import { estadoRevisionParaEnvio, cambiosDeCarta } from '../src/services/revisionMenuWhatsapp.js';
import { resultadoDelEnvioDeMenu } from '../src/mesero-agente/canalDelAgente.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`  OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const sufijo = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
const LEGACY = `5287866${sufijo}`;
const AGENTE = `5287877${sufijo}`;
const identificador = `revision-menu-${randomUUID()}`;
const secreto = 'firma-local-revision-menu';
const RUTA = '/api/config/whatsapp/menu';
const RUTA_REVISION = '/api/admin/whatsapp/menu/revision';

const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
// Si fase-menu-revision-carta se cortó durante su R10, la función quedó renombrada.
await pool.query('ALTER FUNCTION estado_revision_menu_whatsapp_oculta(uuid, text[]) RENAME TO estado_revision_menu_whatsapp').catch(() => {});
// Se prueban EXACTAMENTE las funciones del repositorio: la 100 es idempotente
// (CREATE OR REPLACE), así que se aplica aquí aunque la base ya la tenga.
await pool.query(readFileSync(join(RAIZ, 'migrations', '100_revision_menu_whatsapp.sql'), 'utf8'));
const NEG = (await q1('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
  ['Revisión Menú Carta', `revision-menu-${randomUUID()}`])).id;
const NEG_B = (await q1('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
  ['Revisión Menú Vecino', `revision-menu-b-${randomUUID()}`])).id;

let meta;
let ia;
let srv;
let wamidSeq = 0;
const ids = {};
const archivosExtra = [];

const IMG_1 = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg().toBuffer();
const IMG_2 = await sharp({ create: { width: 310, height: 410, channels: 3, background: { r: 60, g: 200, b: 60 } } }).jpeg().toBuffer();
const IMG_3 = await sharp({ create: { width: 320, height: 420, channels: 3, background: { r: 60, g: 60, b: 200 } } }).jpeg().toBuffer();

const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
async function api(path, { ck, method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ck) headers.Cookie = ck;
  const r = await fetch(srv.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch { /* sin JSON */ }
  return { status: r.status, body: json, texto };
}

async function mensaje(telefono, texto) {
  const wamid = `rc-${sufijo}-${wamidSeq++}`;
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: identificador },
      messages: [{ id: wamid, from: telefono, type: 'text', text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente Revisión' } }],
    } }] }],
  });
  const antes = meta.obtenerMensajesEnviados().length;
  const r = await fetch(`${srv.base}/webhook/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`,
    },
    body: cuerpo,
  });
  assert.equal(r.status, 200);
  const limite = Date.now() + 20000;
  for (;;) {
    const e = await q1('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2', [NEG, wamid]);
    if (e && !['pendiente', 'procesando'].includes(e.estado)) break;
    if (Date.now() > limite) throw new Error(`${wamid} no terminó; servidor=${srv.obtenerSalida().slice(-1500)}`);
    await new Promise((ok) => setTimeout(ok, 100));
  }
  await new Promise((ok) => setTimeout(ok, 700));
  const nuevos = meta.obtenerMensajesEnviados().slice(antes).filter((m) => m.to === telefono);
  return {
    imagenes: nuevos.filter((m) => m.type === 'image'),
    textos: nuevos.filter((m) => m.text?.body).map((m) => m.text.body),
  };
}

const revision = async (ck) => (await api(RUTA, { ck })).body?.revision;
async function revisar(ck) {
  const rv = await revision(ck);
  const r = await api(RUTA_REVISION, { ck, method: 'POST', body: { huellaCarta: rv.huellaCarta, huellaImagenes: rv.huellaImagenes } });
  assert.equal(r.status, 200, `la revisión no se registró: ${r.texto}`);
  assert.equal(r.body.revision.estado, 'vigente');
}
async function paginas() {
  return (await pool.query('SELECT id, storage_key FROM whatsapp_menu_imagenes WHERE negocio_id=$1 ORDER BY orden', [NEG])).rows;
}
const estadoEnvio = async () => estadoRevisionParaEnvio(NEG, (await paginas()).map((p) => p.storage_key));
const esMenuEnTexto = (x) => x.startsWith(TEXTO_MENU_EN_TEXTO);

// Pide el menú por la frase (camino determinista del canal) y exige texto, sin imagen.
async function exigirMenuEnTexto(etiqueta, { sin = [], con = [] } = {}) {
  const r = await mensaje(LEGACY, 'me pasas el menu');
  assert.equal(r.imagenes.length, 0, `${etiqueta}: salió una imagen sin revisión vigente`);
  const menus = r.textos.filter(esMenuEnTexto);
  assert.equal(menus.length, 1, `${etiqueta}: esperaba UN menú en texto, llegó ${JSON.stringify(r.textos)}`);
  assert.equal(r.textos.length, 1, `${etiqueta}: el cliente recibió más de una respuesta: ${JSON.stringify(r.textos)}`);
  for (const n of sin) assert.ok(!menus[0].includes(n), `${etiqueta}: el menú en texto nombra «${n}»`);
  for (const n of con) assert.ok(menus[0].includes(n), `${etiqueta}: el menú en texto no trae «${n}»`);
  return menus[0];
}
async function exigirMenuEnImagen(etiqueta, paginasEsperadas = 1) {
  const r = await mensaje(LEGACY, 'me pasas el menu');
  assert.equal(r.imagenes.length, paginasEsperadas, `${etiqueta}: esperaba ${paginasEsperadas} imagen(es), llegaron ${r.imagenes.length}; textos=${JSON.stringify(r.textos)}`);
  assert.deepEqual(r.textos, [TEXTO_ACOMPANA], `${etiqueta}: textos inesperados ${JSON.stringify(r.textos)}`);
  assert.ok(r.imagenes.every((m) => m.image?.id && !m.image?.link), 'la imagen viaja como media privada');
}

// Un modelo que solo existe para detectar que alguien lo llamó.
const trampa = { llamadas: 0 };
const trampaDelModelo = () => { trampa.llamadas += 1; return 'Tenemos Pieza de Hotcake y Extra Queso.'; };

try {
  // ── Negocio de prueba ──────────────────────────────────────────────────
  const des = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'RC Desayunos',0,TRUE) RETURNING id`, [NEG])).id;
  const pos = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'RC Postres',1,TRUE) RETURNING id`, [NEG])).id;
  const ext = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'EXTRAS',2,TRUE) RETURNING id`, [NEG])).id;
  const prod = async (cat, nombre, precio) => (await q1(
    `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
    [NEG, cat, nombre, precio])).id;
  ids.hotcake = await prod(des, 'RC Hotcake', 50);
  ids.pieza = await prod(des, 'RC Pieza de Hotcake', 20);
  ids.waffle = await prod(pos, 'RC Waffle', 60);
  ids.queso = await prod(ext, 'RC Extra Queso', 10);
  ids.categoriaPostres = pos;
  await publicarCartaWhatsapp(pool, NEG, [ids.hotcake, ids.pieza, ids.waffle]);
  for (const n of [NEG, NEG_B]) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n]);
  }
  await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,TRUE)`, [NEG, identificador]);
  const DIA = { abierto: true, apertura: '00:00', cierre: '24:00' };
  await actualizarConfiguracion({
    int_wa_phone_id: identificador,
    int_wa_token: 'token-mock-revision-menu',
    mesero_agente_v1: 'true',
    mesero_agente_telefonos: AGENTE,
    reglas_atencion: JSON.stringify({
      restaurante: 'Revisión Menú Carta', cierres_especiales: [], promociones: [], politicas: [],
      horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].map((d) => [d, DIA])),
      pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
    }),
  }, NEG);
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=TRUE WHERE id=$1', [NEG]);
  const admin = await crearUsuarioConPassword({ negocioId: NEG, nombre: 'Admin Revisión', email: `admin-rev-${sufijo}@test.local`, password: 'ClaveRev123!', rol: 'admin' });
  const staff = await crearUsuarioConPassword({ negocioId: NEG, nombre: 'Staff Revisión', email: `staff-rev-${sufijo}@test.local`, password: 'ClaveRev123!', rol: 'staff' });
  const adminB = await crearUsuarioConPassword({ negocioId: NEG_B, nombre: 'Admin Vecino', email: `admin-rev-b-${sufijo}@test.local`, password: 'ClaveRev123!', rol: 'admin' });
  const ckAdmin = cookie(admin.id, NEG, 'admin');
  const ckStaff = cookie(staff.id, NEG, 'staff');
  const ckAdminB = cookie(adminB.id, NEG_B, 'admin');

  meta = await arrancarMetaMock();
  ia = await arrancarAnthropicMock();
  srv = await arrancarServidor({
    PORT: process.env.TEST_PORT_REVISION_MENU || '4996',
    META_GRAPH_BASE_URL: meta.baseUrl,
    ANTHROPIC_BASE_URL: ia.baseUrl,
    ANTHROPIC_API_KEY: 'test-only',
    META_APP_SECRET: secreto,
    MESERO_AGENTE_MODE: 'true',
    STORAGE_DRIVER: 'local',
    STORAGE_ENV_PREFIX: 'test',
  }, { timeoutMs: 60000 });
  for (let i = 0; i < 4; i += 1) ia.encolarRespuesta(trampaDelModelo);

  const subida = await api(`${RUTA}/imagen`, { ck: ckAdmin, method: 'POST', body: { base64: IMG_1.toString('base64'), filename: 'menu-p1.jpg' } });
  assert.equal(subida.status, 200, subida.texto);
  const act = await api(RUTA, { ck: ckAdmin, method: 'POST', body: { activo: true } });
  assert.equal(act.status, 200, act.texto);

  // ── Nunca revisado ─────────────────────────────────────────────────────
  await t('R0. el panel explica que falta la revisión y muestra la carta, sin storage keys', async () => {
    const r = await api(RUTA, { ck: ckAdmin });
    assert.equal(r.status, 200);
    assert.equal(r.body.activo, true);
    assert.equal(r.body.revision.estado, 'nunca_revisada');
    assert.deepEqual(r.body.revision.carta.map((p) => p.nombre).sort(), ['RC Hotcake', 'RC Pieza de Hotcake', 'RC Waffle']);
    assert.ok(!/storage_key|storageKey|negocios\//.test(r.texto), 'una storage key salió al navegador');
    assert.match(String(r.body.revision.huellaCarta), /^c1:[0-9a-f]{32}$/);
    assert.match(String(r.body.revision.huellaImagenes), /^i1:[0-9a-f]{32}$/);
  });

  await t('R1. nunca revisado: «menú» saca el menú EN TEXTO desde la carta, sin EXTRAS, sin imagen ni modelo', async () => {
    const texto = await exigirMenuEnTexto('R1', { sin: ['RC Extra Queso'], con: ['RC Hotcake', 'RC Pieza de Hotcake', 'RC Waffle', '$50'] });
    assert.ok(!/aqu[ií] est[aá]/i.test(texto));
    assert.equal(trampa.llamadas, 0, 'el menú llamó al modelo');
    assert.match(srv.obtenerSalida(), /menu_en_texto: .*estado=nunca_revisada/);
  });

  // ── La revisión ────────────────────────────────────────────────────────
  await t('R2. revisar exige administrador del negocio: sin sesión 401, staff 403, el vecino no toca a A', async () => {
    const rv = await revision(ckAdmin);
    const cuerpo = { huellaCarta: rv.huellaCarta, huellaImagenes: rv.huellaImagenes };
    const sin = await api(RUTA_REVISION, { method: 'POST', body: cuerpo });
    assert.equal(sin.status, 401, `sin sesión: ${sin.status}`);
    const st = await api(RUTA_REVISION, { ck: ckStaff, method: 'POST', body: cuerpo });
    assert.equal(st.status, 403, `staff: ${st.status}`);
    const vecino = await api(RUTA_REVISION, { ck: ckAdminB, method: 'POST', body: { ...cuerpo, negocioId: NEG } });
    assert.equal(vecino.status, 400, `vecino: ${vecino.status} ${vecino.texto}`);
    assert.equal((await revision(ckAdmin)).estado, 'nunca_revisada', 'algo de lo anterior registró la revisión de A');
  });

  await t('R3. si la carta cambió mientras el admin miraba (huella vieja), 409 y no se registra', async () => {
    const rv = await revision(ckAdmin);
    const r = await api(RUTA_REVISION, { ck: ckAdmin, method: 'POST', body: { huellaCarta: 'c1:00000000000000000000000000000000', huellaImagenes: rv.huellaImagenes } });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'CAMBIO_DURANTE_REVISION');
    const r2 = await api(RUTA_REVISION, { ck: ckAdmin, method: 'POST', body: { huellaCarta: rv.huellaCarta, huellaImagenes: 'i1:00000000000000000000000000000000' } });
    assert.equal(r2.status, 409);
    assert.equal((await revision(ckAdmin)).estado, 'nunca_revisada');
  });

  await t('R4. el administrador revisa: queda vigente, con fecha y nombre', async () => {
    await revisar(ckAdmin);
    const rv = await revision(ckAdmin);
    assert.equal(rv.revisadoPor, 'Admin Revisión');
    assert.ok(rv.revisadoEn);
  });

  await t('R5. revisado: «menú» saca la imagen (texto de acompañamiento + 1 página)', async () => {
    await exigirMenuEnImagen('R5');
  });

  await t('R6. retirar «Pieza de Hotcake» en el panel invalida la imagen: menú en texto SIN la Pieza', async () => {
    const r = await api('/api/admin/whatsapp/productos/publicar', { ck: ckAdmin, method: 'POST', body: { productoIds: [ids.pieza], publicado: false } });
    assert.equal(r.status, 200, r.texto);
    const rv = await revision(ckAdmin);
    assert.equal(rv.estado, 'carta_cambio');
    assert.deepEqual(rv.cambios.retirados, ['RC Pieza de Hotcake']);
    await exigirMenuEnTexto('R6', { sin: ['RC Pieza de Hotcake', 'RC Extra Queso'], con: ['RC Hotcake', 'RC Waffle'] });
  });

  await t('R7. republicarla devuelve la carta revisada: la imagen vuelve a salir sin otra revisión', async () => {
    const r = await api('/api/admin/whatsapp/productos/publicar', { ck: ckAdmin, method: 'POST', body: { productoIds: [ids.pieza], publicado: true } });
    assert.equal(r.status, 200, r.texto);
    assert.equal((await revision(ckAdmin)).estado, 'vigente');
    await exigirMenuEnImagen('R7');
  });

  // ── Cambios de carta por fuera del panel ───────────────────────────────
  const cambiosDeCartaSQL = [
    ['publicado=FALSE por SQL', `UPDATE whatsapp_productos SET publicado=FALSE WHERE negocio_id=$1 AND producto_id=${ids.waffle}`,
      `UPDATE whatsapp_productos SET publicado=TRUE WHERE negocio_id=$1 AND producto_id=${ids.waffle}`],
    ['categoría desactivada', `UPDATE menu_categorias SET activa=FALSE WHERE negocio_id=$1 AND id=${ids.categoriaPostres}`,
      `UPDATE menu_categorias SET activa=TRUE WHERE negocio_id=$1 AND id=${ids.categoriaPostres}`],
    ['precio', `UPDATE menu_productos SET precio=65 WHERE negocio_id=$1 AND id=${ids.waffle}`,
      `UPDATE menu_productos SET precio=60 WHERE negocio_id=$1 AND id=${ids.waffle}`],
    ['nombre', `UPDATE menu_productos SET nombre='RC Waffle Grande' WHERE negocio_id=$1 AND id=${ids.waffle}`,
      `UPDATE menu_productos SET nombre='RC Waffle' WHERE negocio_id=$1 AND id=${ids.waffle}`],
    ['disponible=FALSE', `UPDATE menu_productos SET disponible=FALSE WHERE negocio_id=$1 AND id=${ids.waffle}`,
      `UPDATE menu_productos SET disponible=TRUE WHERE negocio_id=$1 AND id=${ids.waffle}`],
    ['un producto nuevo publicado (EXTRAS)', `INSERT INTO whatsapp_productos (negocio_id,producto_id,publicado,origen) VALUES ($1,${ids.queso},TRUE,'panel')`,
      `DELETE FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id=${ids.queso}`],
  ];
  for (const [nombre, cambio, deshacer] of cambiosDeCartaSQL) {
    await t(`R8. ${nombre}: invalida la imagen y deshacerlo la revalida`, async () => {
      await pool.query(cambio, [NEG]);
      try {
        assert.equal(await estadoEnvio(), 'carta_cambio');
        assert.equal((await revision(ckAdmin)).estado, 'carta_cambio');
      } finally { await pool.query(deshacer, [NEG]); }
      assert.equal(await estadoEnvio(), 'vigente');
    });
  }

  await t('R8. agotado NO invalida la imagen (es el faltante del día, no un retiro)', async () => {
    await pool.query('UPDATE menu_productos SET agotado=TRUE WHERE negocio_id=$1 AND id=$2', [NEG, ids.waffle]);
    try { assert.equal(await estadoEnvio(), 'vigente'); }
    finally { await pool.query('UPDATE menu_productos SET agotado=FALSE WHERE negocio_id=$1 AND id=$2', [NEG, ids.waffle]); }
  });

  await t('R8. una resiembra con otra selección (como la 098 tras su _down) invalida la imagen', async () => {
    const { rows: antes } = await pool.query('SELECT producto_id, publicado, origen FROM whatsapp_productos WHERE negocio_id=$1', [NEG]);
    await pool.query('DELETE FROM whatsapp_productos WHERE negocio_id=$1', [NEG]);
    await pool.query(`INSERT INTO whatsapp_productos (negocio_id,producto_id,publicado,origen) VALUES ($1,$2,TRUE,'siembra_tienda')`, [NEG, ids.hotcake]);
    try { assert.equal(await estadoEnvio(), 'carta_cambio'); }
    finally {
      await pool.query('DELETE FROM whatsapp_productos WHERE negocio_id=$1', [NEG]);
      for (const f of antes) {
        await pool.query('INSERT INTO whatsapp_productos (negocio_id,producto_id,publicado,origen) VALUES ($1,$2,$3,$4)',
          [NEG, f.producto_id, f.publicado, f.origen]);
      }
    }
    assert.equal(await estadoEnvio(), 'vigente');
  });

  await t('R8. borrar un producto publicado (la publicación cae en cascada) invalida la imagen', async () => {
    ids.temporal = await prod(des, 'RC Temporal', 40);
    await publicarCartaWhatsapp(pool, NEG, [ids.temporal]);
    await revisar(ckAdmin);
    await pool.query('DELETE FROM menu_productos WHERE negocio_id=$1 AND id=$2', [NEG, ids.temporal]);
    assert.equal(await estadoEnvio(), 'carta_cambio');
    assert.deepEqual((await revision(ckAdmin)).cambios.retirados, ['RC Temporal']);
    await revisar(ckAdmin);
  });

  // ── Cambios de imágenes ────────────────────────────────────────────────
  await t('R9. agregar una página la invalida (menú en texto) y revisarla la vuelve a dejar salir', async () => {
    const r = await api(`${RUTA}/imagen`, { ck: ckAdmin, method: 'POST', body: { base64: IMG_2.toString('base64'), filename: 'menu-p2.jpg' } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.body.revision.estado, 'imagenes_cambiaron');
    await exigirMenuEnTexto('R9', { sin: ['RC Extra Queso'] });
    await revisar(ckAdmin);
    await exigirMenuEnImagen('R9 revisado', 2);
  });

  await t('R9. reordenar NO la invalida; reemplazar una página o cambiar su referencia por SQL, sí', async () => {
    const actuales = (await api(RUTA, { ck: ckAdmin })).body.imagenes.map((i) => i.id);
    const ord = await api(`${RUTA}/imagenes/orden`, { ck: ckAdmin, method: 'POST', body: { ids: [...actuales].reverse() } });
    assert.equal(ord.status, 200, ord.texto);
    assert.equal(await estadoEnvio(), 'vigente');
    const [p1] = await paginas();
    await pool.query(`UPDATE whatsapp_menu_imagenes SET storage_key = storage_key || '.otra' WHERE id=$1`, [p1.id]);
    try { assert.equal(await estadoEnvio(), 'imagenes_cambiaron'); }
    finally { await pool.query('UPDATE whatsapp_menu_imagenes SET storage_key=$2 WHERE id=$1', [p1.id, p1.storage_key]); }
    assert.equal(await estadoEnvio(), 'vigente');
    const rep = await api(`${RUTA}/imagen`, { ck: ckAdmin, method: 'POST', body: { base64: IMG_3.toString('base64'), filename: 'menu-p1b.jpg', imagenId: p1.id } });
    assert.equal(rep.status, 200, rep.texto);
    assert.equal(rep.body.revision.estado, 'imagenes_cambiaron');
    await revisar(ckAdmin);
  });

  // ── Sin poder comprobar ────────────────────────────────────────────────
  await t('R10. si la revisión no se puede comprobar, sale el menú en texto (fallo cerrado)', async () => {
    await pool.query('ALTER FUNCTION estado_revision_menu_whatsapp(uuid, text[]) RENAME TO estado_revision_menu_whatsapp_oculta');
    try {
      assert.equal(await estadoEnvio(), 'error_lectura');
      await exigirMenuEnTexto('R10', { sin: ['RC Extra Queso'], con: ['RC Hotcake'] });
      assert.match(srv.obtenerSalida(), /menu_en_texto: .*estado=error_lectura/);
    } finally {
      await pool.query('ALTER FUNCTION estado_revision_menu_whatsapp_oculta(uuid, text[]) RENAME TO estado_revision_menu_whatsapp');
    }
    assert.equal(await estadoEnvio(), 'vigente');
  });

  // ── Mesero: herramienta enviar_menu ────────────────────────────────────
  await t('R11. Mesero (enviar_menu) sin revisión vigente: sale el menú en texto, sin imagen, y el modelo no oye «no se pudo»', async () => {
    await retirarDeWhatsapp(pool, NEG, [ids.pieza]);
    const pedidos = [];
    const responder = (payload) => {
      pedidos.push(JSON.stringify(payload.messages || []));
      return pedidos.at(-1).includes('tool_result')
        ? '¿Qué se te antoja?'
        : { content: [{ type: 'tool_use', id: `toolu_menu_${pedidos.length}`, name: 'enviar_menu', input: {} }], stop_reason: 'tool_use' };
    };
    ia.drenar();
    for (let i = 0; i < 6; i += 1) ia.encolarRespuesta(responder);
    try {
      const r = await mensaje(AGENTE, 'enséñame lo que hay para desayunar');
      assert.equal(r.imagenes.length, 0, 'salió una imagen sin revisión vigente');
      const menus = r.textos.filter(esMenuEnTexto);
      assert.equal(menus.length, 1, `esperaba el menú en texto una vez: ${JSON.stringify(r.textos)}`);
      assert.ok(!menus[0].includes('RC Pieza de Hotcake') && !menus[0].includes('RC Extra Queso'));
      assert.ok(pedidos.some((p) => p.includes('tool_result')), `el modelo nunca recibió el resultado: ${srv.obtenerSalida().slice(-1200)}`);
      // El resultado viaja al modelo ya redactado (agenteDelMesero,
      // resultadoParaModelo): «La acción se completó.» o «La acción no se
      // aplicó.»; el motivo técnico no llega tal cual.
      const conResultado = pedidos.filter((p) => p.includes('tool_result')).join('\n');
      assert.ok(conResultado.includes('La acción se completó'), `al modelo no se le dijo que el menú salió: ${conResultado.slice(-600)}`);
      assert.ok(!conResultado.includes('La acción no se aplicó'), 'al modelo se le dijo que el menú no se pudo enviar');
      assert.ok(!r.textos.some((x) => /no (pude|se pudo)/i.test(x)), `el cliente leyó un «no pude»: ${JSON.stringify(r.textos)}`);
    } finally {
      ia.drenar();
      await publicarCartaWhatsapp(pool, NEG, [ids.pieza]);
    }
    assert.equal(await estadoEnvio(), 'vigente');
  });

  // ── La imagen V1 que reaparece ─────────────────────────────────────────
  await t('R12. la imagen V1 que reaparece al borrar la última página no sale sin revisión', async () => {
    // Una imagen del V1 (048) que sigue en la columna, con su objeto vivo.
    const claveV1 = `test/negocios/${NEG}/menu/v1-heredada.jpg`;
    const [p] = await paginas();
    const destino = join(RAIZ, 'storage', 'documentos', claveV1);
    copyFileSync(join(RAIZ, 'storage', 'documentos', p.storage_key), destino);
    archivosExtra.push(destino);
    await pool.query(`UPDATE whatsapp_menu_automatico SET storage_key=$2, mime_type='image/jpeg', nombre_archivo='v1.jpg' WHERE negocio_id=$1`, [NEG, claveV1]);
    for (const pag of (await api(RUTA, { ck: ckAdmin })).body.imagenes) {
      const d = await api(`${RUTA}/imagen/${pag.id}`, { ck: ckAdmin, method: 'DELETE' });
      assert.equal(d.status, 200, d.texto);
    }
    const estado = (await api(RUTA, { ck: ckAdmin })).body;
    assert.deepEqual(estado.imagenes.map((i) => i.id), ['v1'], 'la V1 reapareció como página virtual');
    assert.equal(estado.revision.estado, 'imagenes_cambiaron');
    await exigirMenuEnTexto('R12', { sin: ['RC Extra Queso'] });
  });

  // ── Legacy: marcador <ENVIAR_MENU> ────────────────────────────────────
  await t('R13. legacy con <ENVIAR_MENU>: sin revisión sale el texto y NO «Aquí está nuestro menú»; revisado sale la imagen', async () => {
    const marcador = () => '¡Claro! Aquí está nuestro menú: <ENVIAR_MENU>';
    ia.drenar();
    for (let i = 0; i < 6; i += 1) ia.encolarRespuesta(marcador);
    try {
      const r = await mensaje(LEGACY, 'enséñame lo que hay para desayunar');
      assert.equal(r.imagenes.length, 0, 'salió la imagen V1 sin revisar');
      assert.equal(r.textos.filter(esMenuEnTexto).length, 1, `esperaba el menú en texto: ${JSON.stringify(r.textos)}`);
      assert.ok(!r.textos.some((x) => /aqu[ií] est[aá] nuestro men[uú]/i.test(x)), `salió el texto del modelo: ${JSON.stringify(r.textos)}`);
      await revisar(ckAdmin);
      ia.drenar();
      for (let i = 0; i < 6; i += 1) ia.encolarRespuesta(marcador);
      const r2 = await mensaje(LEGACY, 'enséñame lo que hay para comer');
      assert.equal(r2.imagenes.length, 1, `revisada, la V1 sí sale: ${JSON.stringify(r2.textos)}`);
      assert.deepEqual(r2.textos, [TEXTO_ACOMPANA]);
    } finally { ia.drenar(); }
  });

  // ── Panel y unidades ───────────────────────────────────────────────────
  await t('R14. el panel pinta el estado de la revisión y confirma con las huellas que vio', () => {
    const html = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
    for (const f of ['revisionMenuHTML', 'revisarMenuAutomatico']) {
      assert.equal((html.match(new RegExp(`function ${f}\\s*\\(`, 'g')) || []).length, 1, `${f} tiene que existir UNA vez`);
    }
    const fn = html.slice(html.indexOf('async function revisarMenuAutomatico'));
    assert.ok(fn.includes("'/api/admin/whatsapp/menu/revision'") && fn.includes('huellaCarta') && fn.includes('huellaImagenes'));
    const pintar = html.slice(html.indexOf('function pintarMenuAutomatico'), html.indexOf('async function cargarMenuAutomatico'));
    assert.ok(pintar.includes('revisionMenuHTML(m, btn)'), 'pintarMenuAutomatico no muestra la revisión');
    const catalogo = readFileSync(join(RAIZ, 'panel', 'catalogo-whatsapp.html'), 'utf8');
    assert.ok(catalogo.includes('id="aviso-menu-imagen"'), 'la página de la carta no avisa del menú en imagen');
    // Cada panel abierto imprime comandas: nada de esto puede abrir /app en
    // otra pestaña ni sacar al panel de /app.
    assert.ok(!/href="\/app/.test(catalogo), 'la página de la carta enlaza a /app: abriría un segundo panel que imprime');
    const bloque = html.slice(html.indexOf('function revisionMenuHTML'), html.indexOf('function pintarMenuAutomatico'));
    for (const a of bloque.match(/<a [^>]*>/g) || []) {
      assert.ok(/target="_blank"/.test(a) && /rel="noopener"/.test(a), `un enlace del aviso saca al panel de /app: ${a}`);
    }
    const revisarFn = html.slice(html.indexOf('async function revisarMenuAutomatico'), html.indexOf('// Multiimagen: destino'));
    assert.ok(/if \(!r\.ok\)[\s\S]*?await cargarMenuAutomatico\(\)/.test(revisarFn), 'tras un rechazo no recarga las páginas');
    assert.ok(/addEventListener\('visibilitychange'/.test(revisarFn), 'al volver a la pestaña no relee el estado de la revisión');
  });

  await t('R15. unidades: mapeo del Mesero, fallo cerrado y diferencias de carta', async () => {
    assert.deepEqual(resultadoDelEnvioDeMenu({ ok: false, motivo: 'imagen_sin_revisar', menuEnTexto: true, textoFallback: 'x' }), { ok: true, paginas: 0, comoTexto: true });
    assert.equal(resultadoDelEnvioDeMenu({ ok: false, motivo: 'imagen_sin_revisar', menuEnTexto: false, textoFallback: TEXTO_FALLBACK }).ok, false);
    assert.deepEqual(resultadoDelEnvioDeMenu({ ok: true, enviadas: 2 }), { ok: true, paginas: 2 });
    assert.equal(resultadoDelEnvioDeMenu({ ok: false, motivo: 'error_envio' }).ok, false);
    const dbRota = { query: async () => { throw new Error('conexión perdida'); } };
    assert.equal(await estadoRevisionParaEnvio(NEG, ['a'], { db: dbRota }), 'error_lectura');
    assert.equal(await estadoRevisionParaEnvio('no-es-uuid', ['a']), 'error_lectura');
    const c = cambiosDeCarta([{ id: 1, nombre: 'A', precio: 1, disponible: true }], [{ id: 1, nombre: 'A', precio: 2, disponible: false }]);
    assert.equal(c.cambiados.length, 1);
    assert.match(c.cambiados[0], /precio.*ya no está disponible/);
  });
  await t('R16. sin nada disponible que listar sale el aviso genérico, y el Mesero NO lo toma por menú entregado', async () => {
    // Todo lo publicado queda no disponible: la carta cambia (sin revisión
    // vigente) y el menú en texto no tiene qué listar.
    const publicados = [ids.hotcake, ids.pieza, ids.waffle];
    await pool.query('UPDATE menu_productos SET disponible=FALSE WHERE negocio_id=$1 AND id = ANY($2::int[])', [NEG, publicados]);
    try {
      const textos = []; let imagenes = 0;
      const r = await enviarMenuAutomatico({ negocioId: NEG, telefono: 'prueba-r16', credenciales: null,
        enviarTexto: async (_t, x) => { textos.push(x); }, enviarImagenBuffer: async () => { imagenes += 1; } });
      assert.equal(imagenes, 0);
      assert.deepEqual(textos, [TEXTO_FALLBACK]);
      assert.equal(r.motivo, 'imagen_sin_revisar');
      assert.equal(r.menuEnTexto, false);
      assert.equal(resultadoDelEnvioDeMenu(r).ok, false, 'el Mesero diría «¿qué se te antoja?» tras «No pude enviar el menú»');
    } finally {
      await pool.query('UPDATE menu_productos SET disponible=TRUE WHERE negocio_id=$1 AND id = ANY($2::int[])', [NEG, publicados]);
    }
  });

  await t('R17. una carta larga no se corta en silencio: cabe en un WhatsApp y dice que hay más', async () => {
    const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'RC Larga',9,TRUE) RETURNING id`, [NEG])).id;
    const nuevos = [];
    for (let i = 0; i < 140; i += 1) nuevos.push(await prod(cat, `RC Platillo de prueba número ${String(i).padStart(3, '0')}`, 100 + i));
    await publicarCartaWhatsapp(pool, NEG, nuevos);
    try {
      const texto = await menuTextualDesdeCatalogo(NEG);
      assert.ok(texto.length + TEXTO_MENU_EN_TEXTO.length + 1 <= 4096, `no cabe en un mensaje: ${texto.length}`);
      assert.ok(texto.endsWith('… y hay más. Pregúntame por lo que se te antoje.'), 'se cortó sin decirlo');
    } finally {
      await pool.query('DELETE FROM menu_productos WHERE negocio_id=$1 AND categoria_id=$2', [NEG, cat]);
      await pool.query('DELETE FROM menu_categorias WHERE negocio_id=$1 AND id=$2', [NEG, cat]);
    }
  });
} finally {
  if (srv) {
    const salida = new Promise((ok) => srv.proc.once('exit', ok));
    srv.detener();
    await Promise.race([salida, new Promise((ok) => setTimeout(ok, 3000))]);
  }
  ia?.drenar(); ia?.detener(); meta?.detener();
  await pool.query('ALTER FUNCTION estado_revision_menu_whatsapp_oculta(uuid, text[]) RENAME TO estado_revision_menu_whatsapp').catch(() => {});
  for (const p of (await pool.query('SELECT storage_key FROM whatsapp_menu_imagenes WHERE negocio_id=$1', [NEG]).catch(() => ({ rows: [] }))).rows) {
    archivosExtra.push(join(RAIZ, 'storage', 'documentos', p.storage_key));
  }
  for (const f of archivosExtra) rmSync(f, { force: true });
  for (const n of [NEG, NEG_B]) {
    for (const sql of [
      'DELETE FROM whatsapp_entradas WHERE negocio_id=$1', 'DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1',
      'DELETE FROM conversaciones_control WHERE negocio_id=$1', 'DELETE FROM conversacion_estado WHERE negocio_id=$1',
      'DELETE FROM agente_outbox WHERE negocio_id=$1', 'DELETE FROM agente_turnos WHERE negocio_id=$1',
      'DELETE FROM agente_operaciones WHERE negocio_id=$1', 'DELETE FROM mensajes WHERE negocio_id=$1',
      'DELETE FROM whatsapp_productos WHERE negocio_id=$1', 'DELETE FROM integraciones_canal WHERE negocio_id=$1',
      'DELETE FROM whatsapp_menu_imagenes WHERE negocio_id=$1', 'DELETE FROM whatsapp_menu_automatico WHERE negocio_id=$1',
      'DELETE FROM configuracion WHERE negocio_id=$1', 'DELETE FROM menu_productos WHERE negocio_id=$1',
      'DELETE FROM menu_categorias WHERE negocio_id=$1', 'DELETE FROM clientes WHERE negocio_id=$1',
      'DELETE FROM negocio_modulos WHERE negocio_id=$1', 'DELETE FROM usuarios WHERE negocio_id=$1',
      'DELETE FROM negocios WHERE id=$1',
    ]) await pool.query(sql, [n]).catch(() => {});
  }
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallos.length} fallidas de ${pasadas + fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
