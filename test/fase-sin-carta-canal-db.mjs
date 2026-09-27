// SIN CARTA PUBLICADA NINGÚN BOT DE WHATSAPP CONTESTA — por el canal real.
//
// Un negocio con el bot encendido, el catálogo operativo lleno («Hotcake de
// cumpleaños», «Pieza de Hotcake», la categoría EXTRAS) y CERO productos
// publicados para WhatsApp. Por el webhook real (servidor hijo, Meta y
// Anthropic simulados, nada sale de la máquina):
//
//   C1  teléfono del canario (agente): no se llama al modelo, el cliente no
//       recibe nada, la conversación queda en revisión con SIN_CARTA_WHATSAPP
//       y el equipo recibe UN aviso;
//   C2  teléfono fuera del canario (bot legacy): lo mismo;
//   C3  un mensaje nuevo de esa conversación no lo toma ningún bot —ni el
//       agente ni el legacy— mientras siga en revisión;
//   C3b pedir el menú tampoco saca la imagen del menú;
//   C3c lo que no habla de productos sigue (consulta de puntos);
//   C4  control: con UN producto publicado, un cliente nuevo sí es atendido.
//
// Uso: DATABASE_URL=<local> node test/fase-sin-carta-canal-db.mjs
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { pool, actualizarConfiguracion } from '../src/services/database.js';

const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`  OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const sufijo = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
const CANARIO = `5287800${sufijo}`;
const LEGACY = `5287811${sufijo}`;
const NUEVO = `5287822${sufijo}`;
const ADMIN = `5287833${sufijo}`;
const identificador = `sin-carta-${randomUUID()}`;
const secreto = 'firma-local-sin-carta';

const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const NEG = (await q1('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
  ['Sin Carta Canal', `sin-carta-canal-${randomUUID()}`])).id;

let meta;
let ia;
let srv;
let HOTCAKE;
const trampa = { llamadas: 0 };

const publicar = (telefono, id, texto) => {
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: identificador },
      messages: [{ id, from: telefono, type: 'text', text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente sin carta' } }],
    } }] }],
  });
  return fetch(`${srv.base}/webhook/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`,
    },
    body: cuerpo,
  });
};
const esperar = async (fn, ms = 18000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await fn()) return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`timeout; servidor=${srv?.obtenerSalida?.().slice(-1500) || ''}`);
};
const conversacion = (telefono) => q1(
  'SELECT requiere_revision, motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [NEG, telefono]);
const enviadosA = (telefono) => meta.obtenerMensajesEnviados().filter((m) => m.to === telefono);
const trampaDelModelo = () => { trampa.llamadas += 1; return 'Tenemos Hotcake de cumpleaños, Pieza de Hotcake y Extra Queso.'; };

try {
  const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'Desayunos',0,TRUE) RETURNING id`, [NEG])).id;
  const ext = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'EXTRAS',1,TRUE) RETURNING id`, [NEG])).id;
  HOTCAKE = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Hotcake de cumpleaños',150,TRUE) RETURNING id`, [NEG, cat])).id;
  await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Pieza de Hotcake',30,TRUE)`, [NEG, cat]);
  await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Extra Queso',15,TRUE)`, [NEG, ext]);
  await pool.query(`DELETE FROM whatsapp_productos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,TRUE)`,
    [NEG, identificador]);
  await actualizarConfiguracion({
    int_wa_phone_id: identificador,
    int_wa_token: 'token-mock-sin-carta',
    mesero_agente_v1: 'true',
    mesero_agente_telefonos: CANARIO,
    wa_admin_numero: ADMIN,
  }, NEG);
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=TRUE WHERE id=$1', [NEG]);

  meta = await arrancarMetaMock();
  ia = await arrancarAnthropicMock();
  // Si CUALQUIER motor llamara al modelo, consumiría una de estas trampas.
  for (let i = 0; i < 6; i += 1) ia.encolarRespuesta(trampaDelModelo);
  srv = await arrancarServidor({
    PORT: process.env.TEST_PORT_SIN_CARTA || '4998',
    META_GRAPH_BASE_URL: meta.baseUrl,
    ANTHROPIC_BASE_URL: ia.baseUrl,
    ANTHROPIC_API_KEY: 'test-only',
    META_APP_SECRET: secreto,
    MESERO_AGENTE_MODE: 'true',
  });

  await t('C1. canario (agente) sin carta: nadie le contesta, pasa a una persona y el equipo se entera UNA vez', async () => {
    const r = await publicar(CANARIO, `sc-c1-${sufijo}`, 'Hola, ¿qué promociones tienen hoy?');
    assert.equal(r.status, 200);
    await esperar(async () => (await conversacion(CANARIO))?.requiere_revision === true);
    const c = await conversacion(CANARIO);
    assert.equal(c.motivo, 'SIN_CARTA_WHATSAPP');
    await new Promise((ok) => setTimeout(ok, 800));
    assert.equal(enviadosA(CANARIO).length, 0, `el cliente recibió: ${JSON.stringify(enviadosA(CANARIO))}`);
    assert.equal(trampa.llamadas, 0, 'se llamó al modelo sin carta publicada');
    const avisos = enviadosA(ADMIN);
    assert.equal(avisos.length, 1, `avisos al equipo: ${avisos.length}`);
    assert.match(avisos[0].text.body, /no tiene carta publicada para WhatsApp/);
    const { rows } = await pool.query('SELECT 1 FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',
      [NEG, `agente:${CANARIO}`]);
    assert.equal(rows.length, 0, 'el agente comprometió un turno sin carta');
  });

  await t('C2. fuera del canario (legacy) sin carta: lo mismo, sin modelo y sin texto', async () => {
    await publicar(LEGACY, `sc-c2-${sufijo}`, 'quiero un hotcake de cumpleaños y una pieza de hotcake');
    await esperar(async () => (await conversacion(LEGACY))?.requiere_revision === true);
    assert.equal((await conversacion(LEGACY)).motivo, 'SIN_CARTA_WHATSAPP');
    await new Promise((ok) => setTimeout(ok, 800));
    assert.equal(enviadosA(LEGACY).length, 0, `el cliente recibió: ${JSON.stringify(enviadosA(LEGACY))}`);
    assert.equal(trampa.llamadas, 0, 'el legacy llamó al modelo sin carta publicada');
    assert.equal(enviadosA(ADMIN).length, 2, 'cada conversación avisa una vez');
  });

  await t('C3. mientras siga en revisión, un mensaje nuevo no lo toma ningún bot', async () => {
    const antes = enviadosA(ADMIN).length;
    for (const [tel, id] of [[CANARIO, `sc-c3a-${sufijo}`], [LEGACY, `sc-c3b-${sufijo}`]]) {
      await publicar(tel, id, 'hola?? me contestan');
    }
    await new Promise((ok) => setTimeout(ok, 2500));
    for (const tel of [CANARIO, LEGACY]) {
      assert.equal(enviadosA(tel).length, 0, `${tel} recibió algo estando en revisión`);
      const { rows } = await pool.query(
        `SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2 ORDER BY id`, [NEG, tel]);
      assert.equal(rows.at(-1)?.estado, 'pendiente', `la entrada nueva de ${tel} se procesó: ${JSON.stringify(rows)}`);
    }
    assert.equal(trampa.llamadas, 0);
    assert.equal(enviadosA(ADMIN).length, antes, 'se repitió el aviso al equipo');
  });

  await t('C3b. sin carta, pedir el MENÚ tampoco sale (el menú en imagen muestra productos)', async () => {
    const MENU = `5287844${sufijo}`;
    // El menú en imagen ACTIVO: sin la guarda, «el menú» dispararía su envío
    // (aunque la imagen no se pueda leer, sale al menos un texto al cliente).
    await pool.query(`INSERT INTO whatsapp_menu_automatico (negocio_id, activo, storage_key, mime_type, nombre_archivo, tamano_bytes)
      VALUES ($1, TRUE, 'prueba-sin-carta/menu.jpg', 'image/jpeg', 'menu.jpg', 1234)
      ON CONFLICT (negocio_id) DO UPDATE SET activo = TRUE`, [NEG]);
    await publicar(MENU, `sc-menu-${sufijo}`, 'me pasas el menú por favor');
    await esperar(async () => (await conversacion(MENU))?.requiere_revision === true);
    assert.equal((await conversacion(MENU)).motivo, 'SIN_CARTA_WHATSAPP');
    await new Promise((ok) => setTimeout(ok, 800));
    assert.equal(enviadosA(MENU).length, 0, `salió algo del menú: ${JSON.stringify(enviadosA(MENU))}`);
    assert.equal(trampa.llamadas, 0);
  });

  await t('C3c. sin carta, lo que NO habla de productos sigue: consulta de puntos Rewards', async () => {
    const PUNTOS = `5287855${sufijo}`;
    await publicar(PUNTOS, `sc-puntos-${sufijo}`, '¿cuántos puntos tengo?');
    await esperar(async () => enviadosA(PUNTOS).length >= 1);
    assert.match(String(enviadosA(PUNTOS)[0].text?.body || ''), /Rewards/);
    const c = await conversacion(PUNTOS);
    assert.equal(c?.requiere_revision, false, `una consulta de puntos pasó a revisión: ${JSON.stringify(c)}`);
    assert.equal(trampa.llamadas, 0);
  });

  await t('C4. control: con UN producto publicado, un cliente nuevo sí es atendido', async () => {
    await pool.query(`INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado, origen) VALUES ($1,$2,TRUE,'panel')
      ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = TRUE`, [NEG, HOTCAKE]);
    ia.drenar();
    ia.encolarRespuesta('¡Hola! Con gusto. ¿Qué te gustaría pedir?');
    await publicar(NUEVO, `sc-c4-${sufijo}`, 'Hola');
    await esperar(async () => enviadosA(NUEVO).length >= 1);
    const c = await conversacion(NUEVO);
    assert.equal(c?.requiere_revision, false, `con carta publicada pasó a revisión: ${JSON.stringify(c)}`);
    for (const m of enviadosA(NUEVO)) {
      for (const oculto of ['Pieza de Hotcake', 'Extra Queso']) {
        assert.ok(!String(m.text?.body || '').includes(oculto), `se nombró "${oculto}": ${m.text?.body}`);
      }
    }
  });
} finally {
  if (srv) {
    const salida = new Promise((ok) => srv.proc.once('exit', ok));
    srv.detener();
    await salida;
  }
  ia?.drenar(); ia?.detener(); meta?.detener();
  for (const sql of [
    'DELETE FROM whatsapp_entradas WHERE negocio_id=$1', 'DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1',
    'DELETE FROM conversaciones_control WHERE negocio_id=$1', 'DELETE FROM conversacion_estado WHERE negocio_id=$1',
    'DELETE FROM agente_outbox WHERE negocio_id=$1', 'DELETE FROM agente_turnos WHERE negocio_id=$1',
    'DELETE FROM agente_operaciones WHERE negocio_id=$1', 'DELETE FROM mensajes WHERE negocio_id=$1',
    'DELETE FROM whatsapp_productos WHERE negocio_id=$1', 'DELETE FROM integraciones_canal WHERE negocio_id=$1',
    'DELETE FROM whatsapp_menu_imagenes WHERE negocio_id=$1', 'DELETE FROM whatsapp_menu_automatico WHERE negocio_id=$1',
    'DELETE FROM configuracion WHERE negocio_id=$1', 'DELETE FROM menu_productos WHERE negocio_id=$1',
    'DELETE FROM menu_categorias WHERE negocio_id=$1', 'DELETE FROM clientes WHERE negocio_id=$1',
    'DELETE FROM negocios WHERE id=$1',
  ]) await pool.query(sql, [NEG]).catch(() => {});
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallos.length} fallidas de ${pasadas + fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
