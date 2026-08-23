// P0 DE CANAL (2026-08-22): el bot de Nonna dejó de responder a CUALQUIER
// mensaje. Causa: `menu_productos.opciones` guarda dos cosas distintas —
// opciones COMERCIALES (formato legacy: array, u objeto de arrays) y
// METADATA TÉCNICA interna (`tipo_item='envio'`, la marca estructural del
// cargo de envío) — y `formatearMenu` hacía `valores.join(', ')` sobre
// TODOS los valores: `'envio'.join is not a function` reventaba la
// construcción del prompt antes de llamar al modelo.
//
// Dos defectos más, del mismo incidente:
//   · `clearTimeout(waitTimer)` vivía después del await, así que una
//     excepción lo saltaba: el cliente recibía "Dame un momento..." 8 s
//     después de un fallo instantáneo, y nunca nada más.
//   · el catch del canal solo logueaba: el cliente quedaba colgado.
//
// Cero red real: mock de Meta (lib-meta-mock) y mock propio de Anthropic
// con control de latencia/fallo.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createServer } from 'http';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const metaMock = await arrancarMetaMock();
process.env.META_GRAPH_BASE_URL = metaMock.baseUrl;

// ── Mock de Anthropic con latencia y fallo controlados ─────────────────────
let modoBrain = { tipo: 'ok', demoraMs: 0, texto: 'Respuesta normal del bot.' };
const anthropicMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', async () => {
    if (modoBrain.demoraMs) await new Promise((r) => setTimeout(r, modoBrain.demoraMs));
    if (modoBrain.tipo === 'error') {
      // 400 a propósito: el SDK de Anthropic REINTENTA los 5xx (y con
      // demora simulada esos reintentos se solapaban con el caso
      // siguiente). Un 4xx falla al primer intento, que es justo lo que
      // estas pruebas necesitan observar.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'simulado' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: modoBrain.texto }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
});
await new Promise((r) => anthropicMock.listen(0, r));
const ANTHROPIC_URL = `http://localhost:${anthropicMock.address().port}`;

const { pool } = await import('../src/services/database.js');
const { construirSystemPrompt, CLAVES_OPCIONES_TECNICAS } = await import('../src/agent/prompts.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const NEG = SEED.negocioA;
const suf = Date.now().toString().slice(-6);
// Puerto ÚNICO por corrida: con un puerto fijo, un servidor huérfano de una
// corrida anterior contesta /health y la suite le habla a ÉL (con mocks ya
// cerrados) -- se ve como "el bot no respondió nada" y es mentira.
const PUERTO = String(process.env.TEST_PORT_MMT || (4700 + (Number(suf) % 250)));
const PNID = `PNIDMMT${suf}`;
const WABA = `WABAMMT${suf}`;
const TEL = `52899760${suf.slice(-4)}`;

const P_ENVIO = `MMT Cargo Envio ${suf}`;         // {"tipo_item":"envio"}  ← el que rompía
const P_ARRAY = `MMT Refresco ${suf}`;            // ["Coca","Sprite"]      (legacy array)
const P_OBJ = `MMT Focaccia ${suf}`;              // {tamaños:["ch","gr"]}  (legacy objeto-de-arrays)
const P_RARO = `MMT Rara ${suf}`;                 // {salsa:{a:1}}          (formato inesperado)
const P_MIXTO = `MMT Mixta ${suf}`;               // técnica + comercial juntas

async function limpiar() {
  await pool.query(`DELETE FROM mensajes WHERE negocio_id = $1 AND telefono = $2`, [NEG, TEL]);
  await pool.query(`DELETE FROM clientes WHERE negocio_id = $1 AND telefono = $2`, [NEG, TEL]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'MMT %'`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'MMT %'`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
}

let srv = null;
let botActivoOriginal = null;
try {
  await limpiar();
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'MMT Cat (test)',TRUE,992) RETURNING id`, [NEG]);
  for (const [nombre, precio, opciones] of [
    [P_ENVIO, 60, { tipo_item: 'envio' }],
    [P_ARRAY, 30, ['Coca', 'Sprite']],
    [P_OBJ, 120, { tamaños: ['chico', 'grande'] }],
    [P_RARO, 90, { salsa: { picante: true } }],
    [P_MIXTO, 80, { tipo_item: 'envio', extras: ['queso', 'tocino'] }],
  ]) {
    await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden, opciones)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1,$5)`, [NEG, cat.id, nombre, precio, JSON.stringify(opciones)]);
  }

  // ═══ A-E: el prompt tolera TODO shape y nunca filtra metadata técnica ════
  let prompt = null;
  await t('A. producto con opciones={"tipo_item":"envio"}: construirSystemPrompt NO lanza', async () => {
    prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'prompt vacio');
  });

  await t('B. la metadata tecnica NO aparece en el menu visible del prompt', async () => {
    assert.ok(!/tipo_item/i.test(prompt), 'el prompt filtro la clave tecnica');
    assert.ok(!/Tipo_item:\s*envio/i.test(prompt), 'el prompt mostro tipo_item al cliente');
    assert.ok(CLAVES_OPCIONES_TECNICAS.has('tipo_item'), 'tipo_item no esta en la lista tecnica');
    // El producto SÍ sigue en el menú (es un cargo real del catálogo), solo
    // que sin su metadata interna.
    assert.ok(prompt.includes(P_ENVIO), 'el producto desaparecio del menu');
  });

  await t('C. opciones legacy en array: comportamiento intacto', async () => {
    assert.ok(/Opciones:\s*Coca,\s*Sprite/.test(prompt), 'se perdio el formato legacy de array');
  });

  await t('D. opciones legacy objeto-de-arrays: comportamiento intacto', async () => {
    assert.ok(/Tamaños:\s*chico,\s*grande/.test(prompt), 'se perdio el formato legacy objeto-de-arrays');
  });

  await t('E. valor comercial con formato inesperado: fail-safe (se omite, no crashea, sin volcar contenido)', async () => {
    assert.ok(prompt.includes(P_RARO), 'el producto de formato raro desaparecio del menu');
    assert.ok(!/picante/i.test(prompt), 'volco el contenido inesperado al prompt');
    // Mixto: la clave comercial se conserva, la técnica no.
    assert.ok(/Extras:\s*queso,\s*tocino/.test(prompt), 'se perdio la clave comercial del producto mixto');
  });

  // ═══ F-I: timer provisional y respuesta de error (canal real) ════════════
  await pool.query(
    `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, nombre, estado, activo, waba_id)
     VALUES ($1,'whatsapp','meta',$2,'MMT prueba','activo',TRUE,$3)`, [NEG, PNID, WABA]);
  const { guardarCredencialesCifradas, actualizarEstadoIntegracion } = await import('../src/services/integracionesService.js');
  await guardarCredencialesCifradas(NEG, 'whatsapp', 'meta',
    { phoneNumberId: PNID, wabaId: WABA, accessToken: 'TOKEN-MMT-TEST' }, SEED.superadminUsuarioId);
  await actualizarEstadoIntegracion(NEG, 'whatsapp', 'meta', 'activo', SEED.superadminUsuarioId);
  // El interruptor REAL del bot es la columna negocios.bot_whatsapp_activo
  // (migración 019), no una clave de `configuracion`: sin esto el canal
  // guarda el mensaje y no responde nada. Se toma snapshot para devolver el
  // valor original y no contaminar a otras suites.
  const { rows: [botPrevio] } = await pool.query(
    `SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [NEG]);
  botActivoOriginal = botPrevio?.bot_whatsapp_activo ?? null;
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG]);

  srv = await arrancarServidor({
    PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl,
    ANTHROPIC_BASE_URL: ANTHROPIC_URL, ANTHROPIC_API_KEY: 'sk-ant-test-mmt',
  }, { timeoutMs: 60000 });

  let n = 0;
  const enviarWebhook = (texto) => fetch(`${srv.base}/webhook/whatsapp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
        contacts: [{ profile: { name: 'Cliente MMT' }, wa_id: TEL }],
        messages: [{ from: TEL, id: `wamid.mmt.${suf}.${++n}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }],
      } }] }],
    }),
  });
  const salientes = () => metaMock.obtenerMensajesEnviados()
    .filter((m) => m.to === TEL).map((m) => m.text?.body || '');
  const contar = (re) => salientes().filter((x) => re.test(x)).length;
  async function esperarHasta(fn, { timeoutMs = 20000, intervaloMs = 250 } = {}) {
    const lim = Date.now() + timeoutMs;
    for (;;) { if (await fn()) return true; if (Date.now() > lim) return false; await esperar(intervaloMs); }
  }
  // Drenaje entre casos: ningún envío en vuelo del caso anterior puede
  // contarse en el siguiente (cada caso mide deltas sobre su propio
  // baseline, y ese baseline solo es válido con la línea quieta).
  async function drenar() {
    let previo = -1;
    for (let i = 0; i < 20; i++) {
      const actual = salientes().length;
      if (actual === previo) return;
      previo = actual;
      await esperar(600);
    }
  }

  await t('F. el brain falla ANTES de 8s: timer cancelado, CERO "Dame un momento", y disculpa honesta', async () => {
    await drenar();
    modoBrain = { tipo: 'error', demoraMs: 0 };
    const antesProv = contar(/Dame un momento/i);
    await enviarWebhook('hola');
    const ok = await esperarHasta(async () => contar(/tuve un problema al procesar/i) > 0, { timeoutMs: 15000 });
    assert.ok(ok, `no llego la disculpa: ${JSON.stringify(salientes())} | servidor: ${srv.obtenerSalida().slice(-1200)}`);
    await esperar(2500); // margen para que un timer no cancelado dispare
    assert.strictEqual(contar(/Dame un momento/i), antesProv,
      'el timer provisional sobrevivio a la excepcion');
  });

  await t('G. el brain falla DESPUES del provisional: provisional una vez, disculpa una vez, sin bucle', async () => {
    await drenar();
    modoBrain = { tipo: 'error', demoraMs: 8600 };
    const provAntes = contar(/Dame un momento/i);
    const discAntes = contar(/tuve un problema al procesar/i);
    await enviarWebhook('hola de nuevo');
    const ok = await esperarHasta(async () => contar(/tuve un problema al procesar/i) === discAntes + 1, { timeoutMs: 40000 });
    assert.ok(ok, `disculpas=${contar(/tuve un problema al procesar/i) - discAntes}: ${JSON.stringify(salientes())}`);
    assert.strictEqual(contar(/Dame un momento/i), provAntes + 1, 'el provisional se envio mas de una vez');
    await esperar(2000);
    assert.strictEqual(contar(/tuve un problema al procesar/i), discAntes + 1, 'hubo respuesta de error duplicada (bucle)');
  });

  await t('H. procesamiento normal >8s: provisional UNA vez y despues la respuesta final', async () => {
    await drenar();
    modoBrain = { tipo: 'ok', demoraMs: 8600, texto: 'Claro que si, con gusto te ayudo.' };
    const provAntes = contar(/Dame un momento/i);
    const discAntes = contar(/tuve un problema al procesar/i);
    await enviarWebhook('me tardas?');
    const ok = await esperarHasta(async () => contar(/Claro que si, con gusto/i) > 0, { timeoutMs: 40000 });
    assert.ok(ok, `no llego la respuesta final: ${JSON.stringify(salientes())}`);
    assert.strictEqual(contar(/Dame un momento/i), provAntes + 1, 'provisional ausente o duplicado');
    assert.strictEqual(contar(/tuve un problema al procesar/i), discAntes,
      'una respuesta normal genero disculpa de error');
  });

  await t('I. procesamiento normal <8s: sin provisional y con respuesta final', async () => {
    await drenar();
    modoBrain = { tipo: 'ok', demoraMs: 0, texto: 'Respuesta rapidita.' };
    const provAntes = contar(/Dame un momento/i);
    await enviarWebhook('rapido');
    const ok = await esperarHasta(async () => contar(/Respuesta rapidita/i) > 0, { timeoutMs: 15000 });
    assert.ok(ok, `no llego la respuesta: ${JSON.stringify(salientes())}`);
    await esperar(1500);
    assert.strictEqual(contar(/Dame un momento/i), provAntes, 'mando provisional en una respuesta rapida');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  // Cierre REAL del proceso hijo: sin esperar su 'exit' puede sobrevivir y
  // secuestrar el puerto de la siguiente corrida.
  try {
    if (srv) {
      srv.detener();
      await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
    }
  } catch { /* abajo */ }
  anthropicMock.close();
  metaMock.detener();
  if (botActivoOriginal !== null) {
    await pool.query(`UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1`, [NEG, botActivoOriginal]).catch(() => {});
  }
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-menu-metadata-tecnica: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
