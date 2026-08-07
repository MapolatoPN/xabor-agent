// Hotfix bot-envio-enlace-pago: una clienta con pedido activo pidió pagar
// con enlace de pago y el bot no envió la URL. Esta suite PRIMERO
// reproduce el incidente de punta a punta (webhook real de WhatsApp →
// debounce → bot) y después valida el comportamiento corregido: intención
// reconocida, URL simulada de Clip enviada, pedido como pago pendiente
// hasta que el webhook de la pasarela confirme.
//
// Uso: mismas env vars que la batería. Requiere aplicar-migraciones.mjs y
// seed-datos-prueba.mjs ya corridos sobre el mismo DATABASE_URL.
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4189';

const { pool, guardarPedidoActivo, getBotPausado, setBotPausado } = await import('../src/services/database.js');
const { guardarCredencialesClip, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
const { actualizarConfiguracion } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = ms => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 300 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

// ═══════════ Mock de Clip (URL simulada, cero red real) ═══════════
// Sirve POST /v2/checkout con una URL determinista por referencia. El código
// de producción apunta aquí vía CLIP_API_BASE_URL (override solo-pruebas).
let clipLlamadas = [];
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => cuerpo += c);
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const linkId = req.url.split('/').pop();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ resource_status: 'COMPLETED', me_reference_id: (clipLlamadas.find(c => true) || {}).metadata?.external_reference || linkId }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      clipLlamadas.push(body);
      const id = 'clip-mock-' + clipLlamadas.length;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        payment_request_id: id,
        payment_request_url: `https://pago.mock.clip/${id}`,
        status: 'CHECKOUT',
      }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});
await new Promise(r => clipMock.listen(0, r));
const CLIP_MOCK_URL = `http://127.0.0.1:${clipMock.address().port}`;

// ═══════════ Setup ═══════════
const PNID = 'PNID_ENLACE_A';
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioA, 'whatsapp', 'activo');
await fijarModulo(SEED.negocioA, 'pagos', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: PNID, int_wa_token: 'fake-token-enlace-a' }, SEED.negocioA);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Enlace A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, PNID]);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [SEED.negocioA]);
// El negocio SÍ ofrece enlace de pago y SÍ tiene Clip configurado como
// proveedor principal (mismo escenario del incidente).
for (const [tipo, habilitado, orden] of [['efectivo', true, 0], ['enlace_pago', true, 1]]) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,$3,$4)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`, [SEED.negocioA, tipo, habilitado, orden]);
}
await guardarCredencialesClip(SEED.negocioA, 'CLIP_KEY_ENLACE_TEST', 'CLIP_SECRET_ENLACE_TEST', SEED.superadminUsuarioId);
await marcarProveedorPrincipal(SEED.negocioA, 'clip', SEED.superadminUsuarioId);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
// Cola generosa de respuestas del "Claude" simulado: en el estado ROTO el
// mensaje cae a la IA y contesta texto libre (sin URL); en el estado
// corregido el atajo determinista responde ANTES y estas respuestas no se
// consumen para la intención de enlace.
for (let i = 0; i < 40; i++) anthropicMock.encolarRespuesta('Claro, con gusto te ayudamos con tu pago.');

const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-mock',
  CLIP_API_BASE_URL: CLIP_MOCK_URL,
}, { timeoutMs: 30000 });
const base = srv.base;

let folioSeq = 9200;
async function crearPedidoActivoConfirmado(telefono, { total = 250, formaPago = 'efectivo', folio = null } = {}) {
  const id = folio || `XAB-${folioSeq++}`;
  await guardarPedidoActivo({
    id, negocioId: SEED.negocioA, canal: 'whatsapp', estado: 'en_preparacion',
    modalidad: 'recoger en tienda', forma_pago: formaPago, total,
    cliente: { nombre: 'Clienta Prueba Enlace', telefono },
    items: [{ nombre: 'Combo', cantidad: 1, precio_unitario: total }],
    timestamp: new Date().toISOString(),
  }, SEED.negocioA);
  return id;
}

let wamidSeq = 0;
async function mensajeEntrante(telefono, texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID },
      messages: [{ type: 'text', from: telefono, id: `wamid.ENLACE-${Date.now()}-${wamidSeq++}`, text: { body: texto } }],
      contacts: [{ profile: { name: 'Clienta Prueba Enlace' } }],
    } }] }],
  };
  await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

function salientesA(telefono, desde = 0) {
  return metaMock.obtenerMensajesEnviados().slice(desde)
    .filter(m => m.text?.body && String(m.to) === telefono)
    .map(m => m.text.body);
}
// El debounce del bot es de 6s: se espera la PRIMERA respuesta saliente y
// se da un margen corto para descartar segundas respuestas duplicadas.
async function respuestaDelBot(telefono, desde) {
  const r = await esperarHasta(() => {
    const msgs = salientesA(telefono, desde);
    return msgs.length ? msgs : null;
  });
  return r || [];
}

// ═══════════ REPRODUCCIÓN DEL INCIDENTE ═══════════
await t('REPRO', 'clienta con pedido activo escribe "Quiero pagar con enlace de pago" -> el bot envía la URL y el pedido queda pago pendiente', async () => {
  const tel = '5218780010001';
  const folio = await crearPedidoActivoConfirmado(tel);
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'Quiero pagar con enlace de pago');
  const respuestas = await respuestaDelBot(tel, antes);
  if (!respuestas.length) {
    const salida = (srv.obtenerSalida?.() || '').split('\n').slice(-40).join('\n');
    console.log('--- SALIDA SERVIDOR ---\n' + salida);
  }
  assert.ok(respuestas.length, 'el bot debía responder algo');
  const conUrl = respuestas.filter(m => m.includes('https://pago.mock.clip/'));
  if (!conUrl.length) {
    const salida = (srv.obtenerSalida?.() || '').split('\n').filter(l => /Error|Clip|enlace/i.test(l)).slice(-12).join('\n');
    console.log('--- ERRORES SERVIDOR ---\n' + salida);
  }
  assert.ok(conUrl.length >= 1, `el bot debía enviar la URL del enlace de pago; respondió: ${JSON.stringify(respuestas)}`);
  assert.ok(conUrl[0].includes('$250'), 'el mensaje debe traer el total del pedido');
  // El pedido NO se marca pagado por pedir el enlace: queda pago pendiente
  // hasta que la pasarela confirme vía webhook.
  const { rows: [ped] } = await pool.query(`SELECT (datos->>'pago_confirmado') AS pc FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.notStrictEqual(ped.pc, 'true', 'pedir el enlace jamás marca pagado');
  const { rows: pagos } = await pool.query(`SELECT estado, url FROM pagos WHERE pedido_folio = $1 AND negocio_id = $2`, [folio, SEED.negocioA]);
  assert.strictEqual(pagos.length, 1, 'exactamente un registro de pago');
  assert.strictEqual(pagos[0].estado, 'pendiente');
  assert.ok(pagos[0].url.includes('pago.mock.clip'));
});

// ═══════════ Intenciones (Fase 5, detector puro) ═══════════
const { detectarSolicitudEnlacePago } = await import('../src/utils/intencionEnlacePago.js');
await t('INTENCION', 'las 11 frases del encargo se reconocen (con mayúsculas y acentos variables)', () => {
  const frases = [
    'Quiero pagar con enlace', 'Mándame el link', 'Pásame la liga para pagar',
    'Pago con enlace', 'Voy a pagar por link', 'Quiero pagar en línea',
    'Sí, con link', 'Con enlace, por favor', 'Me generas el enlace de pago',
    'Dónde pago', 'Mándame el enlace otra vez',
    'QUIERO PAGAR CON ENLACE DE PAGO', 'quiero pagar en linea', 'donde pago?',
  ];
  for (const f of frases) assert.ok(detectarSolicitudEnlacePago(f), `debía reconocer: "${f}"`);
});
await t('INTENCION', 'mensajes normales NO disparan el enlace (falso positivo = cobro no pedido)', () => {
  for (const f of ['quiero una pizza grande', 'voy a pagar en efectivo', 'hola buenas tardes',
                   'el enlace de tu página no abre', '¿tienen liga de futbol hoy?', '']) {
    assert.ok(!detectarSolicitudEnlacePago(f), `NO debía reconocer: "${f}"`);
  }
});

// ═══════════ Variantes de intención de punta a punta ═══════════
await t('VARIANTES', '"mándame el enlace otra vez" reutiliza el MISMO enlace (idempotente, jamás doble cobro)', async () => {
  const tel = '5218780010002';
  const folio = await crearPedidoActivoConfirmado(tel, { total: 180 });
  let antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'me generas el enlace de pago');
  const r1 = await respuestaDelBot(tel, antes);
  const url1 = r1.join(' ').match(/https:\/\/pago\.mock\.clip\/[\w-]+/)?.[0];
  assert.ok(url1, 'primer enlace enviado');
  antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'Mándame el enlace otra vez');
  const r2 = await respuestaDelBot(tel, antes);
  const url2 = r2.join(' ').match(/https:\/\/pago\.mock\.clip\/[\w-]+/)?.[0];
  assert.strictEqual(url2, url1, 'el reenvío devuelve el MISMO enlace vigente');
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pagos WHERE pedido_folio = $1`, [folio]);
  assert.strictEqual(rows[0].n, 1, 'un solo registro de pago pese al reenvío');
});

await t('VARIANTES', '"dónde pago" también dispara el envío del enlace', async () => {
  const tel = '5218780010003';
  await crearPedidoActivoConfirmado(tel, { total: 99.5 });
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, '¿Dónde pago?');
  const r = await respuestaDelBot(tel, antes);
  assert.ok(r.some(m => m.includes('https://pago.mock.clip/')), `esperaba URL; respondió ${JSON.stringify(r)}`);
});

// ═══════════ Casos de negocio ═══════════
await t('CASOS', 'pedido YA pagado: no se genera enlace nuevo, se informa que ya está pagado', async () => {
  const tel = '5218780010004';
  const folio = await crearPedidoActivoConfirmado(tel);
  await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{pago_confirmado}', 'true') WHERE folio = $1`, [folio]);
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'quiero pagar con enlace');
  const r = await respuestaDelBot(tel, antes);
  assert.ok(r.some(m => m.includes('ya está pagado')), `esperaba aviso de pagado; respondió ${JSON.stringify(r)}`);
  assert.ok(!r.some(m => m.includes('pago.mock.clip')), 'jamás un enlace para un pedido pagado');
});

await t('CASOS', 'dos pedidos activos sin pagar: el bot pide el folio en vez de adivinar', async () => {
  const tel = '5218780010005';
  const f1 = await crearPedidoActivoConfirmado(tel);
  const f2 = await crearPedidoActivoConfirmado(tel);
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'pásame la liga para pagar');
  const r = await respuestaDelBot(tel, antes);
  assert.ok(r.some(m => m.includes('más de un pedido') && m.includes(f1) && m.includes(f2)),
    `esperaba solicitud de folio; respondió ${JSON.stringify(r)}`);
  assert.ok(!r.some(m => m.includes('pago.mock.clip')), 'sin enlace hasta saber el folio');
});

await t('CASOS', 'takeover activo (bot pausado): el atajo NO responde — la conversación es del humano', async () => {
  const tel = '5218780010006';
  await crearPedidoActivoConfirmado(tel);
  await setBotPausado(tel, true, SEED.negocioA);
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'quiero pagar con enlace de pago');
  await esperar(8000);
  assert.strictEqual(salientesA(tel, antes).length, 0, 'con takeover el bot no responde nada');
  await setBotPausado(tel, false, SEED.negocioA);
});

await t('CASOS', 'sin pedido activo: la intención cae a la IA (flujo normal de pedido), sin error', async () => {
  const tel = '5218780010007';
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'quiero pagar con enlace');
  const r = await respuestaDelBot(tel, antes);
  assert.ok(r.length >= 1, 'la IA responde el flujo normal');
  assert.ok(!r.some(m => m.includes('pago.mock.clip')), 'sin pedido no hay nada que cobrar');
});

// ═══════════ Confirmación por la pasarela (pendiente hasta el webhook) ═══════════
await t('WEBHOOK', 'el pedido sigue pago pendiente hasta que el webhook de Clip confirma', async () => {
  const tel = '5218780010008';
  const folio = await crearPedidoActivoConfirmado(tel, { total: 300 });
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(tel, 'quiero pagar en línea');
  const r = await respuestaDelBot(tel, antes);
  assert.ok(r.some(m => m.includes('pago.mock.clip')), 'enlace enviado');
  const { rows: [pago] } = await pool.query(`SELECT id, estado, referencia_interna FROM pagos WHERE pedido_folio = $1`, [folio]);
  assert.strictEqual(pago.estado, 'pendiente', 'pendiente hasta que la pasarela confirme');
  // Webhook de Clip (mismo contrato que la suite de pagos): confirma el pago.
  const rWh = await fetch(base + '/webhook/clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource_status: 'COMPLETED', resource: 'CHECKOUT', me_reference_id: pago.referencia_interna }),
  });
  assert.ok([200, 201].includes(rWh.status), `webhook debía aceptar (dio ${rWh.status})`);
  const confirmado = await esperarHasta(async () => {
    const { rows: [p2] } = await pool.query(`SELECT estado FROM pagos WHERE id = $1`, [pago.id]);
    return p2.estado === 'pagado' ? p2 : null;
  }, { timeoutMs: 6000 });
  assert.ok(confirmado, 'el webhook marca el pago como pagado');
});

// ═══════════ Búsqueda por folio y simulación del incidente XAB-0114 ═══════════
// Fixture SANITIZADO que replica el incidente real: teléfono de entrega
// DICTADO en el chat (10 dígitos, sin prefijo 521) distinto en formato al
// remitente del webhook; pedido archivado como 'entregado' sin pagar; y una
// fila de pago previa en estado 'fallido' (la del CHECK roto) que debe
// reutilizarse -- jamás una segunda fila.
const { calcularVersionPedidoHash } = await import('../src/services/database.js');

await t('FOLIO', 'incidente XAB-0114 simulado: entregado sin pagar + tel dictado sin prefijo + fila fallida -> el folio recupera el pedido y REUTILIZA el pago', async () => {
  const remitente = '5218780010009';           // como llega del webhook
  const telDictado = '8780010009';             // como lo dictó en el chat (10 dígitos)
  const folio = 'XAB-9300';
  await guardarPedidoActivo({
    id: folio, negocioId: SEED.negocioA, canal: 'whatsapp', estado: 'en_preparacion',
    modalidad: 'entrega a domicilio', forma_pago: 'enlace de pago', total: 310,
    cliente: { nombre: 'Alina Prueba', telefono: telDictado, calle: 'Boulevard Sanitizado 208', colonia: 'Guillén' },
    items: [{ nombre: 'Combo Focaccia + Media Ensalada', cantidad: 1, precio_unitario: 310 }],
    timestamp: new Date().toISOString(),
  }, SEED.negocioA);
  // Archivado prematuro (como el real, 3 segundos después del "Folio 114").
  await pool.query(`UPDATE pedidos_activos SET estado = 'entregado' WHERE folio = $1`, [folio]);
  // Fila de pago FALLIDA previa con la referencia determinista real.
  const { rows: [pRow] } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [folio]);
  const hash = calcularVersionPedidoHash(pRow.datos);
  const refInterna = `${SEED.negocioA}:${folio}:${hash}`;
  const { rows: [fallida] } = await pool.query(
    `INSERT INTO pagos (negocio_id, pedido_folio, cliente_telefono, proveedor, integracion_id, referencia_interna, tipo, moneda, monto, version_pedido_hash, estado)
     SELECT $1, $2, $3, 'clip', ic.id, $4, 'enlace_pago', 'MXN', 310, $5, 'fallido'
     FROM integraciones_canal ic WHERE ic.negocio_id = $1 AND ic.canal = 'pagos' AND ic.proveedor = 'clip' LIMIT 1
     RETURNING id`,
    [SEED.negocioA, folio, telDictado, refInterna, hash]
  );
  assert.ok(fallida?.id, 'fixture: fila fallida sembrada');

  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(remitente, 'Mándame el enlace de pago del pedido XAB-9300');
  const r = await respuestaDelBot(remitente, antes);
  const conUrl = r.filter(m => m.includes('https://pago.mock.clip/'));
  if (!conUrl.length) {
    const lineas = (srv.obtenerSalida?.() || '').split(String.fromCharCode(10));
    console.log('--- ERRORES SERVIDOR (XAB-9300) ---');
    console.log(lineas.filter(l => /Error|Clip|folio/i.test(l)).slice(-8).join(String.fromCharCode(10)));
  }
  assert.ok(conUrl.length >= 1, `esperaba URL; respondió ${JSON.stringify(r)}`);
  assert.ok(conUrl[0].includes(folio) && conUrl[0].includes('$310'), 'folio y total reales en el mensaje');
  // REUTILIZÓ la fila fallida: mismo id, ahora pendiente, una sola fila.
  const { rows: pagosRows } = await pool.query(`SELECT id, estado, url FROM pagos WHERE pedido_folio = $1`, [folio]);
  assert.strictEqual(pagosRows.length, 1, 'jamás una segunda fila de pago');
  assert.strictEqual(pagosRows[0].id, fallida.id, 'se reutilizó exactamente el registro fallido');
  assert.strictEqual(pagosRows[0].estado, 'pendiente', 'reactivado y pendiente hasta el webhook');
  assert.ok(pagosRows[0].url.includes('pago.mock.clip'));
  // Sigue sin marcarse pagado.
  const { rows: [ped2] } = await pool.query(`SELECT (datos->>'pago_confirmado') AS pc FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.notStrictEqual(ped2.pc, 'true');
});

await t('FOLIO', 'variantes "Folio 9300" y "XAB 9300" encuentran el mismo pedido (reutilizan el MISMO enlace)', async () => {
  const remitente = '5218780010009';
  for (const texto of ['Folio 9300', 'mandame el link del XAB 9300']) {
    const antes = metaMock.obtenerMensajesEnviados().length;
    await mensajeEntrante(remitente, texto);
    const r = await respuestaDelBot(remitente, antes);
    assert.ok(r.some(m => m.includes('https://pago.mock.clip/')), `"${texto}" debía devolver el enlace; respondió ${JSON.stringify(r)}`);
  }
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pagos WHERE pedido_folio = 'XAB-9300'`);
  assert.strictEqual(rows[0].n, 1, 'las variantes reutilizan, jamás duplican');
});

await t('FOLIO', 'atajo por teléfono: el remitente 521 recupera su pedido aunque el pedido guarde el tel dictado de 10 dígitos', async () => {
  const remitente = '5218780010010';
  const telDictado = '8780010010';
  const folio = 'XAB-9301';
  await guardarPedidoActivo({
    id: folio, negocioId: SEED.negocioA, canal: 'whatsapp', estado: 'nuevo',
    modalidad: 'entrega a domicilio', forma_pago: 'enlace de pago', total: 120,
    cliente: { nombre: 'Cliente Formato', telefono: telDictado },
    items: [{ nombre: 'Item', cantidad: 1, precio_unitario: 120 }],
    timestamp: new Date().toISOString(),
  }, SEED.negocioA);
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(remitente, 'quiero pagar con enlace');
  const r = await respuestaDelBot(remitente, antes);
  assert.ok(r.some(m => m.includes('https://pago.mock.clip/') && m.includes(folio)), `esperaba el enlace de ${folio}; respondió ${JSON.stringify(r)}`);
});

await t('FOLIO', 'telefono_conversacion: si el tel de entrega es de OTRA persona, el remitente sigue encontrando SU pedido', async () => {
  const remitente = '5218780010011';
  const folio = 'XAB-9302';
  await guardarPedidoActivo({
    id: folio, negocioId: SEED.negocioA, canal: 'whatsapp', estado: 'nuevo',
    modalidad: 'entrega a domicilio', forma_pago: 'enlace de pago', total: 150,
    cliente: { nombre: 'Destinataria Distinta', telefono: '8999999999' },
    telefono_conversacion: remitente,
    items: [{ nombre: 'Item', cantidad: 1, precio_unitario: 150 }],
    timestamp: new Date().toISOString(),
  }, SEED.negocioA);
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(remitente, 'pásame la liga para pagar');
  const r = await respuestaDelBot(remitente, antes);
  assert.ok(r.some(m => m.includes('https://pago.mock.clip/') && m.includes(folio)), `esperaba ${folio}; respondió ${JSON.stringify(r)}`);
  // Y un tercero con OTRO número jamás lo ve.
  const intruso = '5215550001111';
  const antes2 = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(intruso, 'quiero pagar con enlace');
  const r2 = await respuestaDelBot(intruso, antes2);
  assert.ok(!r2.some(m => m.includes(folio)), 'el pedido de otro cliente es invisible');
});

await t('FOLIO', 'folio ya pagado responde "ya está pagado"; cancelado responde no encontrado; otro negocio no lo ve', async () => {
  const remitente = '5218780010012';
  // Pagado.
  const fPag = 'XAB-9303';
  await guardarPedidoActivo({ id: fPag, negocioId: SEED.negocioA, canal: 'whatsapp', estado: 'entregado', modalidad: 'recoger en tienda', total: 80, pago_confirmado: true, cliente: { nombre: 'X', telefono: remitente }, items: [], timestamp: new Date().toISOString() }, SEED.negocioA);
  let antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(remitente, 'Folio 9303');
  let r = await respuestaDelBot(remitente, antes);
  assert.ok(r.some(m => m.includes('ya está pagado')), `esperaba ya pagado; respondió ${JSON.stringify(r)}`);
  assert.ok(!r.some(m => m.includes('pago.mock.clip')), 'sin enlace para pagado');
  // Cancelado.
  const fCan = 'XAB-9304';
  await guardarPedidoActivo({ id: fCan, negocioId: SEED.negocioA, canal: 'whatsapp', estado: 'nuevo', modalidad: 'recoger en tienda', total: 90, cliente: { nombre: 'X', telefono: remitente }, items: [], timestamp: new Date().toISOString() }, SEED.negocioA);
  await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [fCan]);
  antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(remitente, 'Folio 9304');
  r = await respuestaDelBot(remitente, antes);
  assert.ok(r.some(m => m.includes('No encontramos')), 'cancelado = no elegible para pago');
  // Otro negocio: pedido de B invisible desde el chat de A.
  const fB = 'XAB-9305';
  await guardarPedidoActivo({ id: fB, negocioId: SEED.negocioB, canal: 'whatsapp', estado: 'nuevo', modalidad: 'recoger en tienda', total: 70, cliente: { nombre: 'X', telefono: remitente }, items: [], timestamp: new Date().toISOString() }, SEED.negocioB);
  antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(remitente, 'Folio 9305');
  r = await respuestaDelBot(remitente, antes);
  assert.ok(r.some(m => m.includes('No encontramos')), 'el folio de otro negocio es inexistente aquí');
});

await t('IDENTIDAD', 'el nombre de ENTREGA jamás pisa el nombre ya conocido del interlocutor', async () => {
  const { upsertCliente, upsertClienteNombreEntrega, obtenerCliente } = await import('../src/services/database.js');
  const tel = '5218780010013';
  await upsertCliente(tel, 'Mario Interlocutor', SEED.negocioA);
  await upsertClienteNombreEntrega(tel, 'Alina Destinataria', SEED.negocioA);
  const c = await obtenerCliente(tel, SEED.negocioA);
  assert.strictEqual(c.nombre, 'Mario Interlocutor', 'el interlocutor conserva su nombre');
  // Perfil vacío: el nombre de entrega SÍ llena el hueco.
  const tel2 = '5218780010014';
  await upsertClienteNombreEntrega(tel2, 'Alina Nueva', SEED.negocioA);
  const c2 = await obtenerCliente(tel2, SEED.negocioA);
  assert.strictEqual(c2.nombre, 'Alina Nueva');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
clipMock.close();
await srv.detener();
anthropicMock.detener?.();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
