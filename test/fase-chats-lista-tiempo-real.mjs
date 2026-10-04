// Chats del panel: la lista y la conversación tienen que seguir al día sin
// recargar (reporte del dueño, 3-oct-2026, Mapolato Obispado).
//
// Lo que se vio en producción (lectura de solo lectura el 3-oct): Obispado
// tenía 26 conversaciones en revisión, la más vieja de hacía 3 días. GET
// /api/conversaciones las ponía PRIMERO, de la más vieja a la más nueva y con
// tope de 20, así que las 20 filas de arriba eran chats de hace 1 a 3 días y
// un cliente que escribía en ese momento quedaba en la fila 21, fuera de la
// pantalla. Además, la respuesta del Mesero (entregada por el outbox) se
// guardaba en el historial sin avisar al panel: la fila seguía mostrando el
// mensaje del cliente con el punto de «sin responder».
//
// Servidor REAL + Postgres desechable + Puppeteer con el panel real. Meta es
// un servidor local de 20 líneas (META_GRAPH_BASE_URL). Exige una base cuyo
// nombre empiece por test_ (nunca corre contra otra).
//
//   L1  un cliente que escribe AHORA queda en la primera fila de la lista,
//       aunque haya 22 conversaciones viejas en revisión.
//   L2  las conversaciones en revisión siguen en la lista con su aviso;
//       ninguna se pierde por el tope (antes, las más NUEVAS lo perdían).
//   P1  el filtro «Revisión» de Chats las reúne todas y dice cuántas son
//       (ya no van fijas arriba; así siguen a un toque).
//   P2  llegar un mensaje no regresa la lista al principio si el operador
//       la tenía desplazada (el esqueleto de carga solo sale la primera vez).
//   W1  el mensaje entrante del webhook llega al panel por WebSocket.
//   W2  la respuesta del Mesero entregada por el outbox llega al panel por
//       WebSocket (nuevo_mensaje) y la fila deja de estar «sin responder».
//   C1  la conversación abierta muestra la respuesta sin recargar.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const NEG = SEED.negocioA;

const nombreBase = (() => { try { return new URL(process.env.DATABASE_URL).pathname.slice(1); } catch { return ''; } })();
if (!/^test_/.test(nombreBase)) {
  console.error(`Se niega a correr: la base «${nombreBase}» no empieza por test_.`);
  process.exit(2);
}
// La sesión del panel se acuña con el mismo secreto que usa el servidor hijo.
process.env.SESSION_SECRET ||= 'secreto-chats-tiempo-real';
delete process.env.META_APP_SECRET; // el webhook de prueba no va firmado

const PUERTO = process.env.TEST_PORT_CHATS_TR || '47821';
const PUERTO_META = process.env.TEST_PORT_CHATS_TR_META || '47822';
const PNID = 'PNID_CHATS_TIEMPO_REAL';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { estadoNuevo } = await import('../src/mesero-agente/ejecutorDeHerramientas.js');
const { normalizarEstado } = await import('../src/mesero-agente/estadoCanonico.js');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms, paso = 250) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { const v = await cond(); if (v) return v; await esperar(paso); }
  return null;
}
const ocultar = (tel) => `***${String(tel).slice(-4)}`;

// ─── Datos: teléfonos propios de esta suite (521819907…) ───────────────────
const PREFIJO = '521819907';
const telRevision = (i) => `${PREFIJO}1${String(i).padStart(2, '0')}`; // 22 en revisión, viejas
const telReciente = (i) => `${PREFIJO}2${String(i).padStart(2, '0')}`; // 5 sin revisión, de la última hora
const TEL_MESERO = `${PREFIJO}301`;   // conversación que contesta el Mesero por el outbox
const TEL_NUEVO = `${PREFIJO}401`;    // cliente que escribe durante la prueba
const TEL_NUEVO2 = `${PREFIJO}402`;   // otro, con la lista desplazada
const TEXTO_RESPUESTA = `Tu pedido: 1 × Waffle. ¿Lo confirmo? (${randomUUID().slice(0, 6)})`;

async function limpiar() {
  const like = `${PREFIJO}%`;
  await pool.query(`DELETE FROM agente_outbox WHERE negocio_id=$1 AND carga->>'telefono' LIKE $2`, [NEG, like]);
  await pool.query(`DELETE FROM conversacion_estado WHERE negocio_id=$1 AND session_id LIKE $2`, [NEG, `%${PREFIJO}%`]);
  await pool.query(`DELETE FROM mensajes WHERE negocio_id=$1 AND telefono LIKE $2`, [NEG, like]);
  await pool.query(`DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono LIKE $2`, [NEG, like]);
  await pool.query(`DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono LIKE $2`, [NEG, like]);
  await pool.query(`DELETE FROM conversaciones_control WHERE negocio_id=$1 AND telefono LIKE $2`, [NEG, like]);
}

async function mensaje(tel, direccion, texto, haceMin, origen) {
  await pool.query(
    `INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,"timestamp")
     VALUES($1,$2,$3,$4,$5,$6,(now() AT TIME ZONE 'UTC') - ($7 || ' minutes')::interval)`,
    [tel, direccion === 'entrante' ? `Cliente ${tel.slice(-3)}` : null, direccion, texto, NEG, origen, String(haceMin)]);
}

await limpiar();
// Solo este negocio en la bandeja: lo que dejen otras suites no cuenta aquí.
await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=false WHERE negocio_id=$1`, [NEG]);
await pool.query(`DELETE FROM mensajes WHERE negocio_id=$1`, [NEG]);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'whatsapp',$2,'Chats tiempo real',TRUE) ON CONFLICT (canal, identificador) DO UPDATE SET negocio_id=$1, activo=TRUE`, [NEG, PNID]);
for (const [clave, valor] of [['int_wa_phone_id', PNID], ['int_wa_token', 'token-local-de-prueba']]) {
  await pool.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
    ON CONFLICT (negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`, [NEG, clave, valor]);
}
// Bot apagado mientras entra el webhook (nadie contesta por su cuenta); se
// enciende después solo para que el despachador entregue la respuesta.
await pool.query(`UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1`, [NEG]);

// 22 conversaciones en revisión, de hace 3 días a hace 1 (Obispado tenía 26):
// más de 20, para que el tope viejo (las 20 MÁS VIEJAS) se note.
const N_REVISION = 22;
for (let i = 1; i <= N_REVISION; i++) {
  const haceMin = (72 - i * 2) * 60;
  await mensaje(telRevision(i), 'entrante', `Mensaje viejo ${i}`, haceMin + 5, 'cliente');
  await mensaje(telRevision(i), 'saliente', `Respuesta vieja ${i}`, haceMin, 'humano');
  await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision,motivo,actualizado_at)
    VALUES($1,$2,true,'AGENTE_PIDE_HUMANO',now() - ($3 || ' minutes')::interval)`, [NEG, telRevision(i), String(haceMin)]);
}
for (let i = 1; i <= 5; i++) {
  await mensaje(telReciente(i), 'entrante', `Hola ${i}`, 50 - i * 5 + 1, 'cliente');
  await mensaje(telReciente(i), 'saliente', `Con gusto ${i}`, 50 - i * 5, 'bot');
  await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2)`, [NEG, telReciente(i)]);
}
// La del Mesero: el cliente acaba de escribir y la respuesta está comprometida.
await mensaje(TEL_MESERO, 'entrante', 'Quiero un waffle', 1, 'cliente');
await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2)`, [NEG, TEL_MESERO]);

// ─── Meta local: acepta todo envío y devuelve un wamid ──────────────────────
let nWamid = 0;
const enviosMeta = [];
const meta = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; });
  req.on('end', () => {
    enviosMeta.push({ url: req.url, cuerpo });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.LOCAL${++nWamid}${Date.now()}` }] }));
  });
});
await new Promise((r) => meta.listen(Number(PUERTO_META), '127.0.0.1', r));

const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: `http://127.0.0.1:${PUERTO_META}`,
  INTEGRATIONS_ENCRYPTION_KEY: process.env.INTEGRATIONS_ENCRYPTION_KEY || randomBytes(32).toString('base64'),
  NODE_OPTIONS: `--import=${pathToFileURL(join(__dirname, 'red-solo-local.mjs')).href}`,
}, { timeoutMs: 40000 });

const navegador = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const framesWS = [];
const erroresPagina = [];
// Retraso artificial de GET /api/conversaciones (ms). En localhost la lista
// responde antes de que el navegador pinte; con la red de una tablet no, y es
// ahí donde se ve el salto al principio (P2).
let latenciaLista = 0;
try {
  const page = await navegador.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  page.on('pageerror', (e) => erroresPagina.push(e.message));
  page.on('dialog', (d) => { console.log(`  [dialogo ${d.type()}] ${d.message().slice(0, 120)}`); d.dismiss().catch(() => {}); });
  // Lo que el panel pida fuera de este servidor (fuentes, iconos) no se
  // espera: sin red externa la carga se quedaría colgada.
  await page.setRequestInterception(true);
  page.on('request', (rq) => {
    const u = new URL(rq.url());
    if (latenciaLista && u.pathname === '/api/conversaciones') {
      setTimeout(() => rq.continue().catch(() => {}), latenciaLista);
      return;
    }
    if (['localhost', '127.0.0.1'].includes(u.hostname) || u.protocol === 'data:') rq.continue();
    else rq.abort();
  });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    try { framesWS.push(JSON.parse(response.payloadData)); } catch { /* no JSON */ }
  });
  const token = crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' });
  await page.setCookie({ name: 'xabor_sesion', value: token, url: srv.base });
  await page.goto(`${srv.base}/app`, { waitUntil: 'domcontentloaded' });
  await hasta(() => page.evaluate(() => document.getElementById('dot')?.className === 'conectado'), 10000);
  await page.evaluate(() => mostrarTab('chats'));
  await page.waitForSelector('#contactos-lista .chat-row', { timeout: 10000 });

  const leerLista = () => page.evaluate(() => {
    const scroller = document.getElementById('lista-chats');
    const caja = scroller.getBoundingClientRect();
    return [...document.querySelectorAll('#contactos-lista .chat-row')].map((r, i) => {
      const b = r.getBoundingClientRect();
      return {
        i, tel: r.id.replace('contacto-', ''),
        preview: r.querySelector('.chat-row-preview')?.textContent || '',
        hora: r.querySelector('.chat-row-hora')?.textContent || '',
        sinResponder: !!r.querySelector('.chat-row-punto'),
        aLaVista: b.top < caja.bottom && b.bottom > caja.top,
      };
    });
  });
  const mostrar = (lista, n = 8) => lista.slice(0, n).map((f) =>
    `      ${String(f.i).padStart(2)} ${ocultar(f.tel)} ${f.aLaVista ? 'visible ' : 'oculta  '} ${f.hora.padEnd(8)} ${f.sinResponder ? '●' : ' '} ${f.preview.slice(0, 48)}`).join('\n');

  const inicial = await leerLista();
  console.log(`  Lista al entrar (${inicial.length} filas, ${inicial.filter((f) => f.aLaVista).length} a la vista):\n${mostrar(inicial)}`);

  // ── Entra un mensaje por el webhook real ───────────────────────────────
  const enviarWebhook = async (tel, texto) => {
    const r = await fetch(`${srv.base}/webhook/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { display_phone_number: '5218100000000', phone_number_id: PNID },
        contacts: [{ profile: { name: `Cliente ${tel.slice(-3)}` }, wa_id: tel }],
        messages: [{ from: tel, id: `wamid.IN${randomUUID().replace(/-/g, '')}`, timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text', text: { body: texto } }] } }] }] }),
    });
    if (r.status !== 200) throw new Error(`el webhook respondió ${r.status}`);
  };
  await enviarWebhook(TEL_NUEVO, 'Hola, ¿todavía tienen chilaquiles?');

  await t('W1 el mensaje entrante del webhook llega al panel por WebSocket', async () => {
    const f = await hasta(() => framesWS.find((m) => m.tipo === 'nuevo_mensaje' && m.mensaje?.telefono === TEL_NUEVO), 5000);
    if (!f) throw new Error('ningún frame nuevo_mensaje del cliente nuevo');
  });

  const conNuevo = await hasta(async () => {
    const l = await leerLista();
    return l.some((f) => f.tel === TEL_NUEVO) ? l : null;
  }, 8000);
  console.log(`  Lista tras el mensaje del cliente nuevo:\n${mostrar(conNuevo || await leerLista())}`);
  await t('L1 un cliente que escribe ahora queda en la primera fila de la lista', async () => {
    const fila = (conNuevo || []).find((f) => f.tel === TEL_NUEVO);
    if (!fila) throw new Error('el cliente nuevo no aparece en la lista');
    if (fila.i !== 0) throw new Error(`queda en la fila ${fila.i + 1} (${fila.aLaVista ? 'visible' : 'FUERA de la pantalla'}); arriba hay ${fila.i} conversaciones más viejas`);
  });

  await t('L2 las 22 conversaciones en revisión siguen en la lista con su aviso (ninguna se pierde por el tope)', async () => {
    const l = await leerLista();
    const enRevision = l.filter((f) => /revisi[oó]n/i.test(f.preview));
    if (enRevision.length !== N_REVISION) throw new Error(`la lista muestra ${enRevision.length} con aviso de revisión, no ${N_REVISION}`);
  });

  await t('P1 el filtro «Revisión» reúne las conversaciones en revisión y dice cuántas son', async () => {
    const filtro = await page.$('#chats-filtros .chats-filtro[data-filtro="revision"]');
    if (!filtro) throw new Error('no hay filtro «Revisión» en Chats');
    const rotulo = await page.evaluate((b) => b.textContent.replace(/\s+/g, ' ').trim(), filtro);
    await filtro.click();
    const soloRevision = await leerLista();
    await page.evaluate(() => setFiltroChats('todos'));
    if (soloRevision.length !== N_REVISION || soloRevision.some((f) => !/revisi[oó]n/i.test(f.preview))) {
      throw new Error(`el filtro muestra ${soloRevision.length} filas y no todas en revisión`);
    }
    if (!rotulo.includes(`(${N_REVISION})`)) throw new Error(`el botón dice «${rotulo}», sin el número`);
  });

  await t('P2 un mensaje nuevo no regresa la lista al principio si estaba desplazada', async () => {
    const antes = await page.evaluate(() => {
      const s = document.getElementById('lista-chats');
      s.scrollTop = s.scrollHeight;
      return s.scrollTop;
    });
    if (antes < 200) throw new Error(`la lista no se puede desplazar (scrollTop=${antes})`);
    latenciaLista = 400;
    try {
      await enviarWebhook(TEL_NUEVO2, 'Buenas tardes');
      await hasta(async () => (await leerLista()).some((f) => f.tel === TEL_NUEVO2), 8000);
      await esperar(800);
    } finally { latenciaLista = 0; }
    const despues = await page.evaluate(() => document.getElementById('lista-chats').scrollTop);
    if (despues < antes - 50) throw new Error(`la lista saltó de scrollTop=${antes} a ${despues}`);
  });

  // ── El Mesero contesta por el outbox (camino del despachador) ──────────
  const sessionId = `agente:${TEL_MESERO}`;
  const estado = normalizarEstado(estadoNuevo({ negocioId: NEG, conversacionId: sessionId }));
  const dialogoId = randomUUID();
  estado.dialogo = { id: dialogoId, ciclo: sessionId, mensaje: 'Quiero un waffle', texto: TEXTO_RESPUESTA, tipo: 'resumen', huella: 'h1', enviado: false };
  await pool.query(`INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision) VALUES ($1,$2,$3::jsonb,1)
    ON CONFLICT (negocio_id, session_id) DO UPDATE SET estado = EXCLUDED.estado`, [NEG, sessionId, JSON.stringify(estado)]);
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1`, [NEG]);
  const clave = createHash('sha256').update(`${sessionId}|${randomUUID()}`).digest('hex');
  await pool.query(
    `INSERT INTO agente_outbox (negocio_id, evento_clave, tipo, carga, conversacion_id, turno_clave, disponible_at)
     VALUES ($1,$2,'respuesta_cliente',$3::jsonb,$4,$5, now())`,
    [NEG, clave, JSON.stringify({ telefono: TEL_MESERO, texto: TEXTO_RESPUESTA, dialogo_id: dialogoId, session_id: sessionId }),
      sessionId, `wa:${randomUUID()}`]);

  const guardada = await hasta(async () => (await pool.query(
    `SELECT id FROM mensajes WHERE negocio_id=$1 AND telefono=$2 AND direccion='saliente' AND texto=$3`,
    [NEG, TEL_MESERO, TEXTO_RESPUESTA])).rows[0], 45000, 500);
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1`, [NEG]);
  if (!guardada) {
    const { rows: [o] } = await pool.query(`SELECT estado, ultimo_error FROM agente_outbox WHERE evento_clave=$1`, [clave]);
    throw new Error(`el despachador no entregó la respuesta en 45 s (outbox=${JSON.stringify(o)})`);
  }
  console.log(`  El despachador entregó la respuesta del Mesero (mensajes.id=${guardada.id}, envíos a Meta=${enviosMeta.length}).`);

  await t('W2 la respuesta del Mesero llega al panel por WebSocket y la fila deja de estar sin responder', async () => {
    const f = await hasta(() => framesWS.find((m) => m.tipo === 'nuevo_mensaje' && m.mensaje?.telefono === TEL_MESERO
      && m.mensaje?.direccion === 'saliente'), 5000);
    const fila = await hasta(async () => (await leerLista()).find((x) => x.tel === TEL_MESERO && x.preview.includes('Waffle')), 3000);
    const actual = (await leerLista()).find((x) => x.tel === TEL_MESERO);
    if (!f) throw new Error(`ningún frame nuevo_mensaje con la respuesta (la fila dice «${actual?.preview}»${actual?.sinResponder ? ', con punto de sin responder' : ''})`);
    if (!fila) throw new Error(`llegó el frame pero la fila sigue en «${actual?.preview}»`);
    if (fila.sinResponder) throw new Error('la fila sigue marcada sin responder');
  });

  await t('C1 la conversación abierta muestra la respuesta sin recargar', async () => {
    await page.evaluate((tel) => abrirConversacion(tel, ''), TEL_MESERO);
    const ok = await hasta(() => page.evaluate((txt) =>
      [...document.querySelectorAll('#chat-mensajes [data-mensaje-id]')].some((e) => e.textContent.includes(txt)), TEXTO_RESPUESTA), 6000);
    if (!ok) throw new Error('la burbuja de la respuesta no aparece en la conversación abierta');
  });

  if (erroresPagina.length) console.log(`  Errores de la página: ${erroresPagina.slice(0, 3).join(' | ')}`);
} finally {
  await navegador.close().catch(() => {});
  srv.detener();
  meta.close();
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1`, [NEG]).catch(() => {});
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

const total = pasadas + fallos.length;
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallos.length} fallidas de ${total}`);
for (const f of fallos) console.log(`  - ${f}`);
process.exit(fallos.length ? 1 : 0);
