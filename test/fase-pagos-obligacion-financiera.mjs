// ─── La obligación financiera: deuda, ambigüedad de creación, lock único ────
//
// Tres agujeros que quedaban después de 73a1f37:
//
//   1. `ok:true/ya_confirmado` se resuelve ANTES de comparar versión, así que
//      un segundo aviso del mismo webhook sobre un cobro de la v1 llegaba a
//      derivar la v2 -- justo lo que el primer aviso había impedido. La
//      autorización para derivar pasa a ser la DEUDA, no el ok.
//   2. "Sin ids persistidos" NO demuestra "el proveedor no creó checkout". Una
//      respuesta perdida deja el mismo rastro que una petición que nunca salió.
//   3. Crear y asentar usaban locks distintos, así que no se bloqueaban: se
//      podía estar creando un cobro nuevo mientras entraba el dinero del viejo.
//
// Ninguna prueba toca Clip ni Mercado Pago reales. Cero dinero real en juego.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createHmac } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const SECRETO_MP = 'secreto-obligacion';
const PUERTO = Number(process.env.TEST_PORT_OBLIG || 4311);
const PUERTO_CRASH = Number(process.env.TEST_PORT_OBLIG_CRASH || 4312);
const PUERTO_CLIP = Number(process.env.TEST_PORT_OBLIG_CLIP || 4313);
const PUERTO_MP = Number(process.env.TEST_PORT_OBLIG_MP || 4314);
const base = `http://localhost:${PUERTO}`;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mock de Clip, con modo "crea y se corta la conexión" ────────────────────
let checkoutsClip = 0;
const CHECKOUTS = new Map();
let clipCortaRespuesta = false;      // crea el checkout y mata el socket
let clipReconsultaCaida = false;     // la reconsulta se cae, la creación no
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-ob-${++checkoutsClip}`;
      // El checkout SE CREA de verdad. Lo que se pierde es la respuesta.
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING',
        monto: Number(body.amount),
      });
      if (clipCortaRespuesta) { req.destroy(); res.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        payment_request_id: id, payment_request_url: `https://pago.mock.clip/${id}`, status: 'CHECKOUT',
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      if (clipReconsultaCaida) { req.destroy(); res.destroy(); return; }
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      // Forma DOCUMENTADA de GET /v2/checkout/{payment_request_id}. No lleva
      // resource_status ni me_reference_id -- esos son campos del webhook.
      res.end(JSON.stringify({
        object_type: 'payment_link',
        payment_request_id: id,
        status: c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED' : 'CHECKOUT_PENDING',
        amount: c.monto ?? null,
        currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
        created_at: '2026-08-17T00:00:00.000Z',
        expired_at: c.expiraAt || null,
        last_status_message: 'Payment request is active',
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

// ── Mock de Mercado Pago, con el mismo modo y con búsqueda por referencia ───
let checkoutsMP = 0;
let mpCortaRespuesta = false;
const PREFERENCIAS = new Map();      // prefId -> { external_reference }
const PAGOS_MP = new Map();
let busquedasPreferencia = 0;
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences/search')) {
    busquedasPreferencia++;
    const ref = new URL(req.url, 'http://x').searchParams.get('external_reference');
    const elements = [...PREFERENCIAS.entries()]
      .filter(([, v]) => v.external_reference === ref)
      .map(([id]) => ({ id, init_point: `https://mp.test/checkout/${id}` }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ elements }));
    return;
  }
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-ob-${++checkoutsMP}`;
      PREFERENCIAS.set(id, { external_reference: p.external_reference });
      if (mpCortaRespuesta) { req.destroy(); res.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, init_point: `https://mp.test/checkout/${id}` }));
    });
    return;
  }
  const m = /^\/v1\/payments\/([^/?]+)/.exec(req.url);
  if (m && !req.url.startsWith('/v1/payments/search')) {
    const pago = PAGOS_MP.get(decodeURIComponent(m[1]));
    if (!pago) { res.writeHead(404); res.end('{"message":"not found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pago));
    return;
  }
  if (req.url.startsWith('/v1/payments/search')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
    return;
  }
  res.writeHead(404); res.end('{}');
});

await new Promise(r => clipMock.listen(PUERTO_CLIP, r));
await new Promise(r => mpMock.listen(PUERTO_MP, r));

// ── Fixture ─────────────────────────────────────────────────────────────────
async function conectarClip() {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
}
async function conectarMP() {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'mercado_pago',
    { accessToken: 'token-ob', publicKey: 'pk-test', webhookSecret: SECRETO_MP },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'mercado_pago', SEED.superadminUsuarioId);
  const { asegurarRoutingTokenIntegracion } = await import('../src/services/database.js');
  return asegurarRoutingTokenIntegracion(NEG, 'mercado_pago');
}

async function pedido(folio, monto) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,'pendiente_pago',$3)
     ON CONFLICT (folio) DO UPDATE SET estado='pendiente_pago', datos=$3`,
    [folio, NEG, JSON.stringify({
      id: folio, negocioId: NEG, canal: 'tienda_online', total: monto, estado: 'pendiente_pago',
      modalidad: 'recoger en tienda', forma_pago: 'enlace de pago', pago_confirmado: false,
      cliente: { nombre: 'Cliente obligación', telefono: '8997600001' },
      items: [{ nombre: 'Producto', cantidad: 1, precio_unitario: monto }],
      timestamp: new Date().toISOString(),
    })]);
}
const crearEnlace = async (folio) => {
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  return crearEnlacePago({ negocioId: NEG, pedidoId: folio, actor: SEED.superadminUsuarioId });
};
async function filas(folio) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [NEG, folio]);
  return rows;
}
const filaId = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [id])).rows[0];
async function pedidoDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
  return r || null;
}
async function comandasDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2`, [NEG, folio]);
  return r.n;
}
async function esperar(condicion, queEsperaba, ms = 10000) {
  const limite = Date.now() + ms;
  for (;;) {
    if (await condicion()) return;
    if (Date.now() > limite) throw new Error(`tiempo agotado esperando: ${queEsperaba}`);
    await new Promise(r => setTimeout(r, 120));
  }
}
// Webhook con la forma DOCUMENTADA del Checkout Webhook de Clip: incluye
// payment_request_id, que es justo el id que Xabor no conoce cuando la
// creación quedó ambigua. Clip NO firma este webhook, así que nada de lo que
// venga aquí se cree sin reconsultar.
async function webhookClip(referencia, { puerto = PUERTO, paymentRequestId = null } = {}) {
  const cuerpo = {
    id: 'ntf-' + Math.random().toString(16).slice(2),
    resource: 'CHECKOUT', resource_status: 'COMPLETED',
    me_reference_id: referencia,
    api_version: '2', attempts: 1,
  };
  if (paymentRequestId) cuerpo.payment_request_id = paymentRequestId;
  const r = await fetch(`http://localhost:${puerto}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return r.status;
}
function firmarMP(dataId, requestId, ts, secreto) {
  const id = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  return createHmac('sha256', secreto).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
}
async function webhookMP(token, paymentId, { puerto = PUERTO } = {}) {
  const ts = '1700000000', requestId = 'req-ob';
  const r = await fetch(
    `http://localhost:${puerto}/webhook/pagos/mercado_pago/${token}?data.id=${paymentId}&type=payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': `ts=${ts},v1=${firmarMP(paymentId, requestId, ts, SECRETO_MP)}`,
        'x-request-id': requestId,
      },
      body: JSON.stringify({ type: 'payment', data: { id: paymentId } }),
    });
  return r.status;
}
async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC OBLIG' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora obligación', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora obligación' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}
async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'OB-%'`, [NEG]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'OB-%'`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='PC OBLIG')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='PC OBLIG' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

let srv = null, srvCrash = null, TOKEN_MP = null;
const envServidor = {
  CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
  XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
  XABOR_URL_PUBLICA: base,
};
try {
  await limpiar();
  await montarImpresion();
  srv = await arrancarServidor({ PORT: String(PUERTO), ...envServidor }, { timeoutMs: 90000 });

  // ═══ P0-1 — LA DEUDA ES LA ÚNICA AUTORIZACIÓN ═══
  await t('1a. pago de la v1 con el pedido en v2: dinero asentado, cero deuda, cero comanda', async () => {
    const folio = 'OB-0001';
    await pedido(folio, 500);
    await conectarClip();
    const v1 = await crearEnlace(folio);
    const filaV1 = (await filas(folio))[0];
    await pedido(folio, 700);
    await crearEnlace(folio);

    CHECKOUTS.get(v1.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(filaV1.referencia_interna), 200);
    await esperar(async () => (await filaId(filaV1.id)).estado === 'pagado', 'el asiento del cobro v1');

    const f = await filaId(filaV1.id);
    assert.strictEqual(f.metadata_sanitizada.anomalia, 'version_desfasada');
    assert.strictEqual(f.derivacion_pendiente, false, 'se escribió deuda para un cobro desfasado');
    assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  await t('1b. EL MISMO webhook otra vez: `ya_confirmado` no puede derivar sin deuda', async () => {
    // Aquí estaba el agujero: la segunda vez la transición corta en
    // 'ya_confirmado' -- antes de comparar versión -- y devolvía ok:true.
    const folio = 'OB-0001';
    const filaV1 = (await filas(folio))[0];
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(await webhookClip(filaV1.referencia_interna), 200);
    }
    await new Promise(r => setTimeout(r, 1200));

    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'pendiente_pago', '¡el aviso repetido liberó la v2 con el cobro de la v1!');
    assert.notStrictEqual(p.datos.pago_confirmado, true, 'marcó pagado el pedido de $700 con $500');
    assert.strictEqual(await comandasDe(folio), 0, 'salió comanda por un aviso repetido');
    assert.strictEqual((await filaId(filaV1.id)).derivacion_pendiente, false,
      'se fabricó una deuda para poder derivar');
  });

  await t('1c. derivar sin deuda es un no-op idempotente, no un error', async () => {
    const { derivarPedidoPorPagoAsentado } = await import('../src/services/webhookPagos.js');
    const filaV1 = (await filas('OB-0001'))[0];
    const r = await derivarPedidoPorPagoAsentado({
      pagoId: filaV1.id, negocioId: NEG, folio: 'OB-0001' });
    assert.strictEqual(r.derivado, false);
    assert.strictEqual(r.razon, 'sin_deuda');
    assert.strictEqual(await comandasDe('OB-0001'), 0);
  });

  await t('1d. crash con deuda válida y el pedido cambia ANTES de recuperar', async () => {
    const folio = 'OB-0002';
    await pedido(folio, 640);
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const mp = (await filas(folio)).find(f => f.proveedor === 'mercado_pago');
    PAGOS_MP.set('pay-ob-2', {
      id: 'pay-ob-2', status: 'approved', external_reference: mp.referencia_interna,
      transaction_amount: 640, currency_id: 'MXN',
    });

    srvCrash = await arrancarServidor({
      PORT: String(PUERTO_CRASH), ...envServidor,
      XABOR_URL_PUBLICA: `http://localhost:${PUERTO_CRASH}`,
      XABOR_PAGOS_FALLA_EN: 'despues_de_asentar',
    }, { timeoutMs: 90000 });
    const estado = await webhookMP(TOKEN_MP, 'pay-ob-2', { puerto: PUERTO_CRASH });
    assert.ok(estado >= 500, `esperaba que la muerte se propagara; llegó ${estado}`);
    await esperar(async () => (await filaId(mp.id)).derivacion_pendiente === true, 'la deuda válida');
    await srvCrash.detener(); srvCrash = null;

    // El pedido cambia mientras el sistema estaba caído.
    await pedido(folio, 990);

    const { reconciliarDerivacionesPendientes } = await import('../src/services/webhookPagos.js');
    await reconciliarDerivacionesPendientes();

    const f = await filaId(mp.id);
    assert.strictEqual(f.estado, 'pagado', 'se repudió un cobro real');
    assert.strictEqual(f.metadata_sanitizada.anomalia, 'version_desfasada_post_asiento',
      `anomalía esperada; quedó '${f.metadata_sanitizada.anomalia}'`);
    assert.strictEqual(f.derivacion_pendiente, false,
      'la deuda quedó abierta: el job la reintentaría cada minuto para siempre');
    assert.ok(f.derivacion_saldada_at, 'la deuda se cerró sin registrar cuándo');
    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'pendiente_pago', 'liberó la v2 con el cobro de la v1');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  await t('1e. y esa deuda cerrada no vuelve en la siguiente vuelta del job', async () => {
    const { reconciliarDerivacionesPendientes } = await import('../src/services/webhookPagos.js');
    for (let i = 0; i < 3; i++) await reconciliarDerivacionesPendientes();
    assert.strictEqual(await comandasDe('OB-0002'), 0);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id=$1 AND pedido_folio='OB-0002' AND derivacion_pendiente`,
      [NEG]);
    assert.strictEqual(rows[0].n, 0, 'la deuda volvió a abrirse');
  });

  // ═══ P0-2 — CREACIÓN CON RESULTADO AMBIGUO ═══
  await t('2a. CLIP crea el checkout y se pierde la respuesta: la fila queda ambigua, no fallida', async () => {
    const folio = 'OB-0010';
    await pedido(folio, 410);
    await conectarClip();
    const antes = checkoutsClip;
    clipCortaRespuesta = true;
    await assert.rejects(() => crearEnlace(folio), 'el corte de conexión debía propagarse');
    clipCortaRespuesta = false;

    assert.strictEqual(checkoutsClip - antes, 1, 'fixture: el proveedor SÍ creó el checkout');
    const f = (await filas(folio))[0];
    assert.strictEqual(f.estado, 'requiere_revision',
      `quedó '${f.estado}': 'fallido' invitaría a reintentar y crear un segundo cobro real`);
    assert.strictEqual(f.metadata_sanitizada.anomalia, 'creacion_ambigua');
    assert.ok(f.idempotency_key, 'no quedó identidad durable de creación antes del POST');
    assert.ok(f.metadata_sanitizada.creacion_intentada_at,
      'no quedó constancia de que el POST llegó a salir');
  });

  await t('2b. CLIP no sabe deduplicar ni buscar: 5 reintentos, CERO checkouts nuevos', async () => {
    const folio = 'OB-0010';
    const antes = checkoutsClip;
    const { CreacionAmbiguaError } = await import('../src/services/pagosService.js');
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => crearEnlace(folio), e => e.code === 'CREACION_AMBIGUA',
        'un reintento mandó otro POST a ciegas');
    }
    assert.strictEqual(checkoutsClip - antes, 0,
      `los reintentos crearon ${checkoutsClip - antes} checkouts de más`);
    assert.strictEqual((await filas(folio)).length, 1, 'se escondieron dos cobros detrás de más filas');
    assert.ok(CreacionAmbiguaError, 'el error tipado debe existir para que el llamador lo distinga');
  });

  await t('2c. el cliente paga el checkout perdido: se recupera por el WEBHOOK, no a mano', async () => {
    // Este caso antes llamaba a asentarPagoRealVerificado directamente, así que
    // no probaba nada del camino real. Ahora recorre producción entera:
    // POST /webhook/clip → resolver fila por referencia → tomar el
    // payment_request_id del webhook como CANDIDATO → reconsultar Clip con las
    // credenciales del negocio → verificar external_reference y monto →
    // adoptar identidad → settlement común → derivación.
    const folio = 'OB-0010';
    const f = (await filas(folio))[0];
    assert.strictEqual(f.referencia_externa, null, 'fixture: la creación debía haber quedado sin id');

    const linkId = [...CHECKOUTS.entries()].find(([, c]) => c.referencia === f.referencia_interna)?.[0];
    assert.ok(linkId, 'el checkout creado no lleva la referencia de la fila');
    CHECKOUTS.get(linkId).estado = 'COMPLETED';

    assert.strictEqual(await webhookClip(f.referencia_interna, { paymentRequestId: linkId }), 200);
    await esperar(async () => (await filaId(f.id)).estado === 'pagado', 'el asiento por el webhook');

    const tras = await filaId(f.id);
    assert.strictEqual(tras.referencia_externa, linkId,
      'no se adoptó durablemente el checkout que el webhook nombró');
    assert.strictEqual(tras.metadata_sanitizada.anomalia, undefined,
      'la ambigüedad quedó marcada aunque ya se resolvió');
    assert.strictEqual(tras.metadata_sanitizada.creacion_ambigua_resuelta,
      'adoptado_por_aviso_de_webhook');
  });

  await t('2c-bis. y con identidad ya persistida, esa fila JAMÁS vuelve a hacer POST', async () => {
    const folio = 'OB-0010';
    // La invariante es CERO POST. Puede llegar por dos caminos igualmente
    // válidos: devolver el pago real que ya existe, o rechazar el pedido porque
    // ya está pagado -- que es la guarda que dispara primero una vez derivado.
    // Lo que jamás puede pasar es un segundo checkout externo.
    const antes = checkoutsClip;
    let estado = null, rechazo = null;
    try { estado = (await crearEnlace(folio)).estado; }
    catch (e) { rechazo = `${e.code}:${e.message}`; }
    assert.strictEqual(checkoutsClip - antes, 0, 'volvió a crear un checkout con identidad ya persistida');
    assert.ok(estado === 'pagado' || /ya est.* pagado/.test(rechazo || ''),
      `ni devolvió el pago real ni lo rechazó por pagado: estado=${estado} rechazo=${rechazo}`);
    assert.strictEqual((await filas(folio)).length, 1, 'creó una fila de más');
  });

  await t('2c-ter. un webhook que nombra OTRO checkout no puede asentar sobre esta fila', async () => {
    // El webhook de Clip no viene firmado: su payment_request_id es un
    // candidato, no una verdad. Si al reconsultarlo lleva otra referencia, o si
    // nombra un checkout distinto al de la fila, se para.
    const folio = 'OB-0012';
    await pedido(folio, 333);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const propio = enlace.referenciaExterna;
    const f = (await filas(folio))[0];

    // Un checkout de OTRO pedido, con su propia referencia, marcado pagado.
    const folioAjeno = 'OB-0013';
    await pedido(folioAjeno, 999);
    const ajeno = await crearEnlace(folioAjeno);
    CHECKOUTS.get(ajeno.referenciaExterna).estado = 'COMPLETED';

    assert.strictEqual(await webhookClip(f.referencia_interna,
      { paymentRequestId: ajeno.referenciaExterna }), 200);
    await new Promise(r => setTimeout(r, 1200));

    const tras = await filaId(f.id);
    assert.notStrictEqual(tras.estado, 'pagado',
      '¡asentó dinero de un checkout ajeno sobre esta fila!');
    assert.strictEqual(tras.referencia_externa, propio, 'sobrescribió la identidad de la fila');
    assert.strictEqual(tras.metadata_sanitizada.anomalia, 'checkout_ajeno');
  });

  await t('2c-pentis. fila AMBIGUA + webhook que nombra un checkout ajeno: solo la referencia salva', async () => {
    // Aquí la fila NO tiene identidad externa, así que la guarda de
    // "el webhook nombra otro checkout" no aplica: lo único que impide asentar
    // dinero ajeno es comprobar que el checkout reconsultado lleva NUESTRA
    // referencia. Es el caso que de verdad ejercita esa verificación.
    const folio = 'OB-0015';
    await pedido(folio, 275);
    await conectarClip();
    clipCortaRespuesta = true;
    await assert.rejects(() => crearEnlace(folio));
    clipCortaRespuesta = false;
    const f = (await filas(folio))[0];
    assert.strictEqual(f.referencia_externa, null, 'fixture: la fila debía quedar sin identidad');

    // Un checkout de otro pedido, pagado y con SU propia referencia.
    const folioAjeno = 'OB-0016';
    await pedido(folioAjeno, 640);
    const ajeno = await crearEnlace(folioAjeno);
    CHECKOUTS.get(ajeno.referenciaExterna).estado = 'COMPLETED';

    assert.strictEqual(await webhookClip(f.referencia_interna,
      { paymentRequestId: ajeno.referenciaExterna }), 200);
    await new Promise(r => setTimeout(r, 1200));

    const tras = await filaId(f.id);
    assert.notStrictEqual(tras.estado, 'pagado',
      '¡adoptó y asentó el checkout de OTRO pedido sobre una fila ambigua!');
    assert.strictEqual(tras.referencia_externa, null, 'adoptó una identidad que no es suya');
    assert.strictEqual(tras.metadata_sanitizada.anomalia, 'referencia_no_coincide');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  await t('2c-quater. el MONTO lo dice la API de Clip, no el webhook', async () => {
    const folio = 'OB-0014';
    await pedido(folio, 480);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const f = (await filas(folio))[0];
    const c = CHECKOUTS.get(enlace.referenciaExterna);
    c.estado = 'COMPLETED';
    c.monto = 10;                     // Clip reporta OTRO monto

    assert.strictEqual(await webhookClip(f.referencia_interna,
      { paymentRequestId: enlace.referenciaExterna }), 200);
    await new Promise(r => setTimeout(r, 1200));

    const tras = await filaId(f.id);
    assert.notStrictEqual(tras.estado, 'pagado', 'asentó un cobro por un monto que no cuadra');
    assert.strictEqual(tras.metadata_sanitizada.anomalia, 'monto_distinto');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  await t('2d. MERCADO PAGO tampoco tiene idempotencia, pero sí búsqueda: recupera, no duplica', async () => {
    const folio = 'OB-0011';
    await pedido(folio, 505);
    TOKEN_MP = await conectarMP();
    const antes = checkoutsMP;
    mpCortaRespuesta = true;
    await assert.rejects(() => crearEnlace(folio), 'el corte debía propagarse');
    mpCortaRespuesta = false;
    assert.strictEqual(checkoutsMP - antes, 1, 'fixture: MP SÍ creó la preferencia');

    const busquedasAntes = busquedasPreferencia;
    let ultimo = null;
    for (let i = 0; i < 5; i++) ultimo = await crearEnlace(folio);

    assert.strictEqual(checkoutsMP - antes, 1,
      `los reintentos crearon ${checkoutsMP - antes} preferencias; el checkout lógico debe ser 1`);
    assert.ok(busquedasPreferencia > busquedasAntes, 'no se preguntó al proveedor si la preferencia existía');
    assert.strictEqual(ultimo.recuperadoTrasAmbiguedad || ultimo.reutilizado, true,
      'no adoptó el checkout que ya existía');
    const f = (await filas(folio))[0];
    assert.strictEqual(f.estado, 'pendiente', `la fila quedó '${f.estado}' tras recuperarse`);
    assert.ok(f.preference_id, 'no se adoptó el id de la preferencia encontrada');
    assert.strictEqual((await filas(folio)).length, 1, 'se crearon filas de más');
  });

  await t('2e. las capacidades declaradas coinciden con lo que la documentación dice', async () => {
    // Si algún día un proveedor gana idempotencia real, esto cambia con la
    // implementación -- no antes. Declararla sin tenerla haría creer que la
    // creación está protegida.
    const clip = await import('../src/services/providers/clipProvider.js');
    const mp = await import('../src/services/providers/mercadoPagoProvider.js');
    assert.strictEqual(clip.getCapabilities().idempotenciaCreacion, false);
    assert.strictEqual(clip.getCapabilities().recuperaCreacionPorReferencia, false);
    assert.strictEqual(mp.getCapabilities().idempotenciaCreacion, false);
    assert.strictEqual(mp.getCapabilities().recuperaCreacionPorReferencia, true);
    assert.strictEqual(typeof mp.buscarCheckoutPorReferencia, 'function');
  });

  // ═══ P0-A — EL CANDIDATO SOBREVIVE A LA RECONSULTA CAÍDA ═══
  await t('2j. reconsulta caída tras el webhook: el candidato queda guardado, no se pierde', async () => {
    // La ventana: el endpoint respondió 200, la creación había quedado ambigua,
    // y la reconsulta se cae. Sin persistir el payment_request_id, ese id era
    // lo único que ataba el dinero de Clip con esta fila.
    const folio = 'OB-0030';
    await pedido(folio, 512);
    await conectarClip();
    clipCortaRespuesta = true;
    await assert.rejects(() => crearEnlace(folio));
    clipCortaRespuesta = false;
    const f = (await filas(folio))[0];
    assert.strictEqual(f.referencia_externa, null, 'fixture: la creación debía quedar ambigua');

    const linkId = [...CHECKOUTS.entries()].find(([, c]) => c.referencia === f.referencia_interna)?.[0];
    CHECKOUTS.get(linkId).estado = 'COMPLETED';

    clipReconsultaCaida = true;
    assert.strictEqual(await webhookClip(f.referencia_interna, { paymentRequestId: linkId }), 200);
    await esperar(async () =>
      (await filaId(f.id)).metadata_sanitizada?.clip_checkout_candidato === linkId,
      'que el candidato quede persistido pese a la reconsulta caída');
    clipReconsultaCaida = false;

    const tras = await filaId(f.id);
    assert.strictEqual(tras.metadata_sanitizada.clip_checkout_candidato_verificado, false,
      'un candidato sin reconsultar no puede darse por verificado');
    assert.strictEqual(tras.referencia_externa, null,
      '¡ascendió un candidato no verificado a identidad del checkout!');
    assert.notStrictEqual(tras.estado, 'pagado', 'asentó sin haber reconsultado');
  });

  await t('2k. la reconciliación de candidatos cobra SIN reenviar el webhook', async () => {
    const folio = 'OB-0030';
    const f = (await filas(folio))[0];
    const { reconciliarCandidatosClip } = await import('../src/services/webhookPagos.js');
    const resueltos = await reconciliarCandidatosClip();
    assert.ok(resueltos >= 1, 'la reconciliación no recuperó el candidato');

    const tras = await filaId(f.id);
    assert.strictEqual(tras.estado, 'pagado', 'el dinero real siguió sin asentarse');
    assert.strictEqual(tras.metadata_sanitizada.clip_checkout_candidato_verificado, true);
    assert.ok(tras.referencia_externa, 'no adoptó la identidad tras verificar');
    assert.strictEqual((await pedidoDe(folio)).datos.pago_confirmado, true);
    assert.strictEqual(await comandasDe(folio), 1, 'no salió exactamente una comanda');
  });

  await t('2l. correrla otra vez no duplica nada', async () => {
    const { reconciliarCandidatosClip } = await import('../src/services/webhookPagos.js');
    for (let i = 0; i < 3; i++) await reconciliarCandidatosClip();
    assert.strictEqual(await comandasDe('OB-0030'), 1);
  });

  await t('2m. un candidato AJENO se guarda sin verificar y jamás asciende ni asienta', async () => {
    const folio = 'OB-0031';
    await pedido(folio, 244);
    await conectarClip();
    clipCortaRespuesta = true;
    await assert.rejects(() => crearEnlace(folio));
    clipCortaRespuesta = false;
    const f = (await filas(folio))[0];

    // Checkout de otro pedido, pagado y con SU propia referencia.
    const folioAjeno = 'OB-0032';
    await pedido(folioAjeno, 888);
    const ajeno = await crearEnlace(folioAjeno);
    CHECKOUTS.get(ajeno.referenciaExterna).estado = 'COMPLETED';

    assert.strictEqual(await webhookClip(f.referencia_interna,
      { paymentRequestId: ajeno.referenciaExterna }), 200);
    await new Promise(r => setTimeout(r, 1200));

    const tras = await filaId(f.id);
    assert.strictEqual(tras.metadata_sanitizada.clip_checkout_candidato, ajeno.referenciaExterna,
      'el candidato debía guardarse aunque resulte falso: es evidencia');
    assert.strictEqual(tras.referencia_externa, null, '¡adoptó un checkout ajeno!');
    assert.notStrictEqual(tras.estado, 'pagado');
    assert.strictEqual(tras.metadata_sanitizada.anomalia, 'referencia_no_coincide');

    // Y la reconciliación tampoco lo asciende por insistir.
    const { reconciliarCandidatosClip } = await import('../src/services/webhookPagos.js');
    for (let i = 0; i < 3; i++) await reconciliarCandidatosClip();
    const final = await filaId(f.id);
    assert.strictEqual(final.referencia_externa, null, 'la reconciliación adoptó el checkout ajeno');
    assert.notStrictEqual(final.estado, 'pagado');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  // ═══ P0-3 — UN SOLO LOCK PARA LA OBLIGACIÓN ═══
  await t('3a. con dinero asentado y deuda pendiente, NO se crea otro checkout', async () => {
    const folio = 'OB-0020';
    await pedido(folio, 700);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = (await filas(folio))[0];
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    // Se asienta el dinero pero NO se deriva: queda la deuda abierta, y el
    // pedido todavía dice pago_confirmado=false.
    const { asentarPagoRealVerificado } = await import('../src/services/database.js');
    const r = await asentarPagoRealVerificado({
      pagoId: clip.id, negocioId: NEG, referenciaExterna: enlace.referenciaExterna });
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await filaId(clip.id)).derivacion_pendiente, true, 'fixture: debía quedar deuda');
    assert.notStrictEqual((await pedidoDe(folio)).datos.pago_confirmado, true,
      'fixture: el pedido aún no debe estar marcado');

    // El negocio cambia de proveedor y alguien pide otro enlace.
    TOKEN_MP = await conectarMP();
    const antesClip = checkoutsClip, antesMP = checkoutsMP;
    const otro = await crearEnlace(folio);

    assert.strictEqual((checkoutsClip - antesClip) + (checkoutsMP - antesMP), 0,
      '¡creó otro checkout con el dinero ya dentro!');
    assert.strictEqual(otro.pagoId, clip.id, 'no devolvió el pago real que ya existe');
    assert.strictEqual(otro.estado, 'pagado');
    assert.strictEqual((await filas(folio)).length, 1, 'creó filas de más');
  });

  await t('3b. y la recuperación de esa deuda produce UNA sola comanda', async () => {
    const folio = 'OB-0020';
    const { reconciliarDerivacionesPendientes } = await import('../src/services/webhookPagos.js');
    await reconciliarDerivacionesPendientes();
    const p = await pedidoDe(folio);
    assert.strictEqual(p.datos.pago_confirmado, true, 'la recuperación no liberó el pedido');
    assert.strictEqual(await comandasDe(folio), 1, 'no salió exactamente una comanda');
    await reconciliarDerivacionesPendientes();
    assert.strictEqual(await comandasDe(folio), 1, 'una segunda vuelta duplicó la comanda');
  });

  await t('3c. creación y webhook simultáneos se serializan sobre la MISMA obligación', async () => {
    const folio = 'OB-0021';
    await pedido(folio, 560);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = (await filas(folio))[0];
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    const antesClip = checkoutsClip;

    // Barrera determinista: la creación entra al claim y se duerme dentro; el
    // webhook llega mientras tanto y tiene que esperar SU turno sobre la misma
    // obligación. Con locks distintos ambos corrían a la vez.
    process.env.XABOR_PAGOS_RETARDO_INTENTO_MS = '1500';
    const creando = crearEnlace(folio).catch(e => ({ error: e.code || e.message }));
    await new Promise(r => setTimeout(r, 250));
    const codigo = await webhookClip(clip.referencia_interna);
    const resultadoCreacion = await creando;
    delete process.env.XABOR_PAGOS_RETARDO_INTENTO_MS;
    assert.strictEqual(codigo, 200);

    await esperar(async () => (await filaId(clip.id)).estado === 'pagado', 'el asiento del cobro');
    await esperar(async () => await comandasDe(folio) >= 1, 'la comanda del cobro');
    await new Promise(r => setTimeout(r, 800));

    assert.strictEqual(await comandasDe(folio), 1, 'la carrera produjo comandas de más');
    const todas = await filas(folio);
    const pagados = todas.filter(f => f.estado === 'pagado');
    assert.strictEqual(pagados.length, 1, `quedaron ${pagados.length} cobros reales`);
    // Da igual quién llegó primero: si la creación ganó el turno, devolvió su
    // enlace y el webhook lo cobró; si ganó el webhook, la creación vio el
    // dinero y no creó nada. Lo que NO puede pasar es un checkout de más.
    assert.ok(checkoutsClip - antesClip <= 1,
      `la carrera creó ${checkoutsClip - antesClip} checkouts externos`);
    assert.ok(!resultadoCreacion?.error || resultadoCreacion.error === 'PEDIDO_INVALIDO',
      `la creación falló de forma inesperada: ${resultadoCreacion?.error}`);
  });

  await t('3d. el settlement ESPERA al claim de creación: es el mismo lock, no dos', async () => {
    // 3c no basta para probar esto: ahí el resultado correcto también sale con
    // locks separados, porque la comprobación de "ya entró dinero" lo tapa. Lo
    // que se mide aquí es la exclusión misma -- si asentar no espera a quien
    // sostiene la obligación, es que son dos candados distintos.
    const folio = 'OB-0022';
    await pedido(folio, 480);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = (await filas(folio))[0];
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    await pedido(folio, 495);           // fuerza que la creación cree otro intento

    const { asentarPagoRealVerificado } = await import('../src/services/database.js');
    process.env.XABOR_PAGOS_RETARDO_INTENTO_MS = '1500';
    const creando = crearEnlace(folio).catch(() => null);
    await new Promise(r => setTimeout(r, 300));     // la creación ya tiene el claim

    const t0 = Date.now();
    await asentarPagoRealVerificado({
      pagoId: clip.id, negocioId: NEG, referenciaExterna: enlace.referenciaExterna });
    const espera = Date.now() - t0;
    await creando;
    delete process.env.XABOR_PAGOS_RETARDO_INTENTO_MS;

    assert.ok(espera >= 700,
      `asentar tardó ${espera}ms: no esperó al claim de creación, así que son locks distintos`);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  delete process.env.XABOR_PAGOS_RETARDO_INTENTO_MS;
  clipCortaRespuesta = false; mpCortaRespuesta = false; clipReconsultaCaida = false;
  if (srv) await srv.detener();
  if (srvCrash) await srvCrash.detener();
  clipMock.close(); mpMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-pagos-obligacion-financiera: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
