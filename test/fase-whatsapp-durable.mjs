// El webhook real de WhatsApp, contra el servidor real.
//
// La pregunta no es "responde 200". Es: si el proceso muere entre el acuse y
// el guardado, cuantos mensajes de clientes desaparecen. Antes de este cambio
// el handler contestaba 200 en su PRIMERA linea, asi que la respuesta era
// "todos los que estuvieran en vuelo, y sin dejar rastro".
//
// Fuente oficial consultada el 10 de agosto de 2026:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
//   "Meta retries delivery with decreasing frequency until the request
//    succeeds, for up to 7 days" / "These retries can result in duplicate
//    webhook notifications."
// Por eso 503 ante un fallo de persistencia es correcto: Meta reintenta.
import assert from 'assert';
import { randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4988';
const { pool } = await import('../src/services/database.js');
const wa = await import('../src/services/whatsappDurable.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function hasta(cond, { limiteMs = 15000, pasoMs = 100, que = 'la condicion' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(pasoMs); }
  throw new Error(`se agoto la espera de ${que}`);
}

// ─── Montaje ────────────────────────────────────────────────────────────────
const PNID = `pn-${Date.now()}`;
const { rows: [neg] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('WA Handler','wa-handler')
   ON CONFLICT (slug) DO UPDATE SET nombre='WA Handler' RETURNING id`);
const NEG = neg.id;
await pool.query(
  `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
   ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);

// El negocio queda mapeado al phone_number_id, y con el bot APAGADO: lo que
// se prueba aqui es la durabilidad del webhook, no las respuestas de la IA.
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, activo)
   VALUES ($1,'whatsapp',$2,true)
   ON CONFLICT (canal, identificador) DO UPDATE SET negocio_id = $1, activo = true`,
  [NEG, PNID]);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = false WHERE id = $1`, [NEG]).catch(() => {});

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const URL = `http://localhost:${PUERTO}/webhook/whatsapp`;

const webhookMensaje = (wamid, texto = 'hola', pnid = PNID) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5218780000000', phone_number_id: pnid },
    contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: '5218781234567' }],
    messages: [{ from: '5218781234567', id: wamid, timestamp: '1780000000',
                 type: 'text', text: { body: texto } }],
  } }] }],
});
const webhookEstado = (wamid, status) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5218780000000', phone_number_id: PNID },
    statuses: [{ id: wamid, status, timestamp: '1780000001',
                 recipient_id: '5218781234567' }],
  } }] }],
});

const enviar = (cuerpo) => fetch(URL, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
});

// ─── Contrato del acuse ─────────────────────────────────────────────────────

await t('ACUSE', '1. un webhook valido se persiste y DESPUES se contesta 200', async () => {
  const wamid = `wamid.${randomUUID()}`;
  const r = await enviar(webhookMensaje(wamid));
  assert.strictEqual(r.status, 200);

  // Cuando el 200 llega, la fila ya tiene que estar. Si estuviera "en camino"
  // el acuse seria una promesa que no podemos cumplir.
  const { rows } = await pool.query(
    `SELECT negocio_id, estado FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
  assert.strictEqual(rows.length, 1, 'el evento tiene que estar guardado ANTES del 200');
  assert.strictEqual(rows[0].negocio_id, NEG, 'y con su negocio resuelto');
});

await t('ACUSE', '2. un cuerpo que no es de WhatsApp se acusa sin guardar basura', async () => {
  const antes = (await pool.query(`SELECT count(*)::int n FROM whatsapp_inbox`)).rows[0].n;
  const r = await enviar({ object: 'page', entry: [] });
  assert.strictEqual(r.status, 200);
  const despues = (await pool.query(`SELECT count(*)::int n FROM whatsapp_inbox`)).rows[0].n;
  assert.strictEqual(despues, antes);
});

await t('ACUSE', '3. un webhook sin eventos utiles se acusa 200', async () => {
  const r = await enviar({ object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID } } }] }] });
  assert.strictEqual(r.status, 200);
});

// ─── Deduplicacion ──────────────────────────────────────────────────────────

await t('DEDUPE', '4. la MISMA entrega repetida 100 veces es UN evento logico', async () => {
  const wamid = `wamid.${randomUUID()}`;
  const cuerpo = webhookMensaje(wamid, 'quiero un pedido');

  const respuestas = [];
  for (let i = 0; i < 100; i++) respuestas.push((await enviar(cuerpo)).status);

  assert.ok(respuestas.every(s => s === 200), 'las 100 entregas se acusan');

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
  assert.strictEqual(rows[0].n, 1, `100 entregas produjeron ${rows[0].n} eventos`);
});

await t('DEDUPE', '5. y esas 100 entregas producen UN mensaje, no 100', async () => {
  const wamid = `wamid.${randomUUID()}`;
  const cuerpo = webhookMensaje(wamid, 'mensaje unico');
  for (let i = 0; i < 100; i++) await enviar(cuerpo);

  await hasta(async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM mensajes WHERE message_id_externo = $1`, [wamid]);
    return rows[0].n >= 1;
  }, { que: 'que el mensaje se guarde' });

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM mensajes WHERE message_id_externo = $1`, [wamid]);
  assert.strictEqual(rows[0].n, 1, `se guardaron ${rows[0].n} mensajes para un solo wamid`);
});

await t('DEDUPE', '6. los tres estados del mismo mensaje son tres eventos, no uno', async () => {
  const wamid = `wamid.${randomUUID()}`;
  for (const st of ['sent', 'delivered', 'read']) {
    const r = await enviar(webhookEstado(wamid, st));
    assert.strictEqual(r.status, 200);
  }
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id LIKE $1`, [`st:${wamid}:%`]);
  assert.strictEqual(rows[0].n, 3, 'deduplicar por wamid a secas tiraria dos de cada tres');
});

await t('DEDUPE', '7. repetir un estado NO crea otro evento', async () => {
  const wamid = `wamid.${randomUUID()}`;
  for (let i = 0; i < 10; i++) await enviar(webhookEstado(wamid, 'delivered'));
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id LIKE $1`, [`st:${wamid}:%`]);
  assert.strictEqual(rows[0].n, 1);
});

// ─── Negocio sin mapear ─────────────────────────────────────────────────────

await t('HUERFANO', '8. un phone_number_id sin mapear ya NO tira el mensaje', async () => {
  const wamid = `wamid.${randomUUID()}`;
  const r = await enviar(webhookMensaje(wamid, 'hola', 'pn-sin-mapear-xyz'));
  assert.strictEqual(r.status, 200);

  const { rows } = await pool.query(
    `SELECT estado, negocio_id FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
  assert.strictEqual(rows.length, 1, 'antes se descartaba con un console.error y se perdia');
  assert.strictEqual(rows[0].estado, 'huerfano');
  assert.strictEqual(rows[0].negocio_id, null);
});

await t('HUERFANO', '9. y se recupera cuando se configura el negocio', async () => {
  const adoptados = await wa.adoptarHuerfanos('pn-sin-mapear-xyz', NEG);
  assert.ok(adoptados >= 1, 'lo guardado sin dueno se puede reasignar');
});

// ─── Volumen ────────────────────────────────────────────────────────────────

await t('VOLUMEN', '10. 1000 entregas con duplicados: 400 eventos logicos exactos', async () => {
  const LOGICOS = 400;
  const wamids = Array.from({ length: LOGICOS }, (_, i) => `wamid.VOL${Date.now()}.${i}`);

  // Se mezclan originales y reentregas, como haria Meta al reintentar.
  const entregas = [];
  for (const w of wamids) {
    entregas.push(w);
    if (Math.random() < 0.5) entregas.push(w);           // reentrega
    if (Math.random() < 0.2) { entregas.push(w); entregas.push(w); }
  }
  const codigos = new Set();
  for (const w of entregas) codigos.add((await enviar(webhookMensaje(w, 'volumen'))).status);

  assert.deepStrictEqual([...codigos], [200], 'todas las entregas se acusan');

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id = ANY($1::text[])`,
    [wamids.map(w => `msg:${w}`)]);
  assert.strictEqual(rows[0].n, LOGICOS,
    `${entregas.length} entregas produjeron ${rows[0].n} eventos logicos, se esperaban ${LOGICOS}`);
  console.log(`      ${entregas.length} entregas -> ${rows[0].n} eventos logicos`);
});

// ─── Ventanas de crash ──────────────────────────────────────────────────────

await t('CRASH', '11. si la persistencia falla, NO se contesta 200', async () => {
  // Se rompe la tabla del buzon a proposito: es la forma honesta de simular
  // "la base no responde" sin tumbar el resto del servidor.
  await pool.query(`ALTER TABLE whatsapp_inbox RENAME TO whatsapp_inbox_oculto`);
  try {
    const r = await enviar(webhookMensaje(`wamid.${randomUUID()}`, 'con la base rota'));
    assert.notStrictEqual(r.status, 200,
      'contestar 200 sin haber guardado es exactamente el fallo que se esta arreglando');
    assert.strictEqual(r.status, 503, 'un 5xx hace que Meta reintente (hasta 7 dias, doc oficial)');
  } finally {
    await pool.query(`ALTER TABLE whatsapp_inbox_oculto RENAME TO whatsapp_inbox`);
  }
});

await t('CRASH', '12. y cuando la base vuelve, el reintento de Meta si se guarda', async () => {
  const wamid = `wamid.${randomUUID()}`;
  const r = await enviar(webhookMensaje(wamid, 'reintento tras la caida'));
  assert.strictEqual(r.status, 200);
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
  assert.strictEqual(rows[0].n, 1, 'por eso el 503 no pierde nada: el evento llega en el reintento');
});

// ─── Dos workers ────────────────────────────────────────────────────────────

await t('WORKERS', '13. dos workers vacian el buzon sin pisarse', async () => {
  const procesados = new Set();
  const dobles = [];
  for (let v = 0; v < 60; v++) {
    const [a, b] = await Promise.all([
      wa.reclamarEntrantes('wk-A', { limite: 30, leaseMs: 5000 }),
      wa.reclamarEntrantes('wk-B', { limite: 30, leaseMs: 5000 }),
    ]);
    const lote = [...a, ...b];
    if (!lote.length) break;
    for (const ev of lote) {
      if (procesados.has(ev.id)) dobles.push(ev.evento_id);
      procesados.add(ev.id);
      await wa.marcarEntranteProcesado(ev.id);
    }
  }
  assert.deepStrictEqual(dobles, [], 'ningun evento puede ser tomado por los dos');
  assert.ok(procesados.size > 0);
  console.log(`      ${procesados.size} eventos repartidos entre dos workers, 0 solapamientos`);
});

// ─── Higiene ────────────────────────────────────────────────────────────────

await t('LOGS', '14. el webhook no registra el contenido del cliente al fallar', async () => {
  const salida = srv.obtenerSalida();
  assert.ok(!salida.includes('con la base rota'),
    'el texto del cliente no puede acabar en los logs de error');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await srv.detener?.();
await pool.end();
process.exit(fallidas ? 1 : 0);
