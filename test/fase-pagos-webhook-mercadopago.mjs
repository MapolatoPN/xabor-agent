// ─── Webhook real de Mercado Pago ──────────────────────────────────────────
//
// Dos cosas se fijan aquí, y son distintas:
//
//   1. `preference_id` NO es `payment_id`. El mock los expone por separado y la
//      suite comprueba que JAMÁS se consulta /v1/payments/<preferenceId>.
//   2. El cuerpo del webhook no decide nada: ni negocio, ni folio, ni monto, ni
//      si está pagado. Sólo aporta un id que hay que ir a verificar.
//
// Ninguna prueba toca Mercado Pago real ni mueve dinero: el adaptador apunta a
// un mock local vía XABOR_MP_API_BASE.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createHmac, randomBytes } from 'crypto';
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

const A = SEED.negocioA;
const B = SEED.negocioB;
const SECRETO_A = 'secreto-webhook-negocio-a';
const SECRETO_B = 'secreto-webhook-negocio-b';
const PUERTO = String(process.env.TEST_PORT_MPWH || 4281);
const PUERTO_MOCK = Number(process.env.TEST_PORT_MPMOCK || 4282);
// El adaptador corre en DOS procesos: el servidor hijo y este mismo (que crea
// los pagos por la vía real). Los dos tienen que apuntar al mock; si no, este
// terminaría llamando a la API real de Mercado Pago -- que es exactamente lo
// que la suite no puede hacer.
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MOCK}`;
process.env.XABOR_URL_PUBLICA = `http://localhost:${process.env.TEST_PORT_MPWH || 4281}`;
const base = `http://localhost:${PUERTO}`;

// ── Mock de Mercado Pago ────────────────────────────────────────────────────
// Representa por separado preferencia y pago. Registra CADA ruta consultada:
// es lo que permite demostrar que nunca se pide /v1/payments/<preferenceId>.
const PAGOS_MOCK = new Map();      // paymentId -> { status, external_reference, transaction_amount, currency_id }
const RUTAS_CONSULTADAS = [];
let contadorPref = 0;

const mock = createServer((req, res) => {
  RUTAS_CONSULTADAS.push(req.url);
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-${++contadorPref}`;
      PREFERENCIAS.set(id, { external_reference: p.external_reference, notification_url: p.notification_url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, init_point: `https://mp.test/checkout/${id}` }));
    });
    return;
  }
  const m = req.url.startsWith('/v1/payments/search') ? null : /^\/v1\/payments\/([^/?]+)/.exec(req.url);
  if (m) {
    const pago = PAGOS_MOCK.get(decodeURIComponent(m[1]));
    if (!pago) { res.writeHead(404); res.end('{"message":"not found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pago));
    return;
  }
  // Busqueda por external_reference: la via soportada por MP para llegar al
  // payment sin conocer su id. Es lo que usa la reconciliacion.
  if (req.url.startsWith('/v1/payments/search')) {
    const ref = decodeURIComponent((/external_reference=([^&]+)/.exec(req.url) || [])[1] || '');
    const results = [...PAGOS_MOCK.entries()]
      .filter(([, p]) => p.external_reference === ref)
      .map(([id, p]) => ({ id, ...p }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
    return;
  }
  if (req.url.startsWith('/v1/payment_methods')) { res.writeHead(200); res.end('[]'); return; }
  res.writeHead(404); res.end('{}');
});
const PREFERENCIAS = new Map();
await new Promise(r => mock.listen(PUERTO_MOCK, r));

// ── Firma según la especificación de Mercado Pago ───────────────────────────
// manifiesto: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
// y el data.id alfanumérico va en MINÚSCULAS.
function firmar(dataId, requestId, ts, secreto) {
  const id = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  return createHmac('sha256', secreto).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
}

async function enviarWebhook({ token, paymentId, secreto = SECRETO_A, firmaFalsa = false, proveedor = 'mercado_pago', requestId = 'req-1' }) {
  const ts = '1700000000';
  const v1 = firmaFalsa ? 'deadbeef'.repeat(8) : firmar(paymentId, requestId, ts, secreto);
  const r = await fetch(
    `${base}/webhook/pagos/${proveedor}/${token}?data.id=${encodeURIComponent(paymentId)}&type=payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': requestId,
      },
      // El cuerpo miente a propósito en todo lo que puede: si algo de esto
      // influyera, la prueba lo delataría.
      body: JSON.stringify({
        type: 'payment', data: { id: paymentId },
        negocioId: B, folio: 'XAB-0001', status: 'approved', transaction_amount: 999999,
      }),
    });
  return r.status;
}

// ── Fixture ─────────────────────────────────────────────────────────────────
async function conectarMP(negocioId, secreto) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'mercado_pago',
    { accessToken: `token-${negocioId.slice(0, 8)}`, publicKey: 'pk-test', webhookSecret: secreto },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'mercado_pago', SEED.superadminUsuarioId);
  const { asegurarRoutingTokenIntegracion } = await import('../src/services/database.js');
  return asegurarRoutingTokenIntegracion(negocioId, 'mercado_pago');
}

// Un pago Xabor listo para recibir su webhook, creado por la vía real
// (pagosService) para que la referencia interna y el preference_id sean los
// que produce el sistema, no unos inventados por la prueba.
async function crearPagoReal(negocioId, folio, monto) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,'pendiente_pago',$3)
     ON CONFLICT (folio) DO UPDATE SET estado='pendiente_pago', datos=$3`,
    [folio, negocioId, JSON.stringify({
      id: folio, negocioId, canal: 'tienda_online', total: monto, estado: 'pendiente_pago',
      cliente: { nombre: 'Cliente MP', telefono: '8997200001' }, items: [], pago_confirmado: false,
    })]);
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  return crearEnlacePago({ negocioId, pedidoId: folio, actor: SEED.superadminUsuarioId });
}

async function pagoDe(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at DESC LIMIT 1`,
    [negocioId, folio]);
  return r || null;
}
async function estadoPedido(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT estado FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, negocioId]);
  return r?.estado || null;
}

async function limpiar() {
  for (const n of [A, B]) {
    await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'MPWH-%'`, [n]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [n]);
  }
}

let srv = null, TOKEN_A = null, TOKEN_B = null;
try {
  await limpiar();
  TOKEN_A = await conectarMP(A, SECRETO_A);
  TOKEN_B = await conectarMP(B, SECRETO_B);
  assert.ok(/^[a-f0-9]{48}$/.test(TOKEN_A), 'el token de ruteo no es opaco de 192 bits');
  assert.notStrictEqual(TOKEN_A, TOKEN_B, 'dos negocios comparten token de ruteo');

  srv = await arrancarServidor({
    PORT: PUERTO,
    XABOR_MP_API_BASE: `http://localhost:${PUERTO_MOCK}`,
    XABOR_URL_PUBLICA: base,
  }, { timeoutMs: 90000 });

  await t('1. preference_id y payment_id son distintos, y NUNCA se consulta el preference', async () => {
    const folio = 'MPWH-0001';
    const enlace = await crearPagoReal(A, folio, 300);
    const pago = await pagoDe(A, folio);
    assert.ok(pago.preference_id, 'no se guardó preference_id');
    assert.match(pago.preference_id, /^pref-/, `preference_id inesperado: ${pago.preference_id}`);
    assert.strictEqual(pago.payment_id, null, 'payment_id no debe existir antes del webhook');
    assert.ok(enlace.url.includes(pago.preference_id));

    // El pago real en el proveedor tiene OTRO id.
    const paymentId = 'pay-987';
    PAGOS_MOCK.set(paymentId, {
      status: 'approved', external_reference: pago.referencia_interna,
      transaction_amount: 300, currency_id: 'MXN',
    });
    RUTAS_CONSULTADAS.length = 0;
    const st = await enviarWebhook({ token: TOKEN_A, paymentId });
    assert.strictEqual(st, 200, `el webhook respondió ${st}`);

    const consultadas = RUTAS_CONSULTADAS.filter(u => u.startsWith('/v1/payments/'));
    assert.ok(consultadas.some(u => u.includes('pay-987')), 'nunca consultó el payment real');
    assert.ok(!consultadas.some(u => u.includes('pref-')),
      `consultó /v1/payments con un preference_id: ${consultadas.join(', ')}`);

    const despues = await pagoDe(A, folio);
    assert.strictEqual(despues.estado, 'pagado', `el pago quedó '${despues.estado}'`);
    assert.strictEqual(despues.payment_id, paymentId, 'no se ligó el payment_id');
    assert.strictEqual(await estadoPedido(A, folio), 'nuevo', 'el pedido no se liberó');
  });

  await t('2. firma falsa → 401 y cero cambios', async () => {
    const folio = 'MPWH-0002';
    await crearPagoReal(A, folio, 150);
    const pago = await pagoDe(A, folio);
    const paymentId = 'pay-falsa';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 150, currency_id: 'MXN' });
    const st = await enviarWebhook({ token: TOKEN_A, paymentId, firmaFalsa: true });
    assert.strictEqual(st, 401, `respondió ${st} a una firma falsa`);
    assert.notStrictEqual((await pagoDe(A, folio)).estado, 'pagado', 'confirmó con firma falsa');
    assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago');
  });

  await t('3. token de ruteo inválido o de otro proveedor → 404', async () => {
    assert.strictEqual(await enviarWebhook({ token: 'a'.repeat(48), paymentId: 'pay-987' }), 404);
    assert.strictEqual(await enviarWebhook({ token: 'no-es-un-token', paymentId: 'pay-987' }), 404);
    assert.strictEqual(
      await enviarWebhook({ token: TOKEN_A, paymentId: 'pay-987', proveedor: 'un_proveedor_inventado' }), 404);
  });

  await t('4. payment inexistente en el proveedor → sin cambios', async () => {
    const folio = 'MPWH-0004';
    await crearPagoReal(A, folio, 120);
    const st = await enviarWebhook({ token: TOKEN_A, paymentId: 'pay-que-no-existe' });
    // Desde el webhook, un payment que el proveedor no devuelve es
    // indistinguible de un fallo transitorio: se responde 5xx para que MP
    // reintente. Lo que NO puede pasar es que confirme algo.
    assert.ok(st >= 500, `respondio ${st}`);
    assert.notStrictEqual((await pagoDe(A, folio)).estado, 'pagado');
  });

  await t('5. AISLAMIENTO: token de B con un payment de A → no toca nada de A', async () => {
    const folio = 'MPWH-0005';
    await crearPagoReal(A, folio, 200);
    const pagoA = await pagoDe(A, folio);
    const paymentId = 'pay-cruzado';
    PAGOS_MOCK.set(paymentId, {
      status: 'approved', external_reference: pagoA.referencia_interna,   // referencia de A
      transaction_amount: 200, currency_id: 'MXN',
    });
    // Llega por el token de B y firmado con el secreto de B: todo "correcto"
    // salvo que la referencia es ajena.
    const st = await enviarWebhook({ token: TOKEN_B, paymentId, secreto: SECRETO_B });
    assert.strictEqual(st, 200);
    assert.notStrictEqual((await pagoDe(A, folio)).estado, 'pagado',
      '¡UN WEBHOOK DE B CONFIRMÓ UN PAGO DE A!');
    assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago');
  });

  await t('6. monto distinto → requiere_revision, nunca pagado', async () => {
    const folio = 'MPWH-0006';
    await crearPagoReal(A, folio, 500);
    const pago = await pagoDe(A, folio);
    const paymentId = 'pay-monto';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 5, currency_id: 'MXN' });
    await enviarWebhook({ token: TOKEN_A, paymentId });
    assert.strictEqual((await pagoDe(A, folio)).estado, 'requiere_revision',
      'aceptó un pago por un monto distinto al del pedido');
    assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago', 'liberó cocina con el monto equivocado');
  });

  await t('7. estados no aprobados no liberan cocina', async () => {
    for (const [mp, esperado] of [['rejected', 'fallido'], ['pending', 'pendiente'], ['un_estado_nuevo_de_mp', 'requiere_revision']]) {
      const folio = `MPWH-07-${mp.slice(0, 6)}`;
      await crearPagoReal(A, folio, 90);
      const pago = await pagoDe(A, folio);
      const paymentId = `pay-${mp}`;
      PAGOS_MOCK.set(paymentId, { status: mp, external_reference: pago.referencia_interna, transaction_amount: 90, currency_id: 'MXN' });
      await enviarWebhook({ token: TOKEN_A, paymentId });
      assert.strictEqual((await pagoDe(A, folio)).estado, esperado, `${mp} se tradujo mal`);
      assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago', `${mp} liberó cocina`);
    }
  });

  await t('8. 50 webhooks repetidos → UNA confirmación', async () => {
    const folio = 'MPWH-0008';
    await crearPagoReal(A, folio, 250);
    const pago = await pagoDe(A, folio);
    const paymentId = 'pay-repetido';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 250, currency_id: 'MXN' });
    for (let i = 0; i < 50; i++) await enviarWebhook({ token: TOKEN_A, paymentId, requestId: `req-${i}` });
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND estado='pagado'`, [A, folio]);
    assert.strictEqual(c.n, 1, `quedaron ${c.n} pagos confirmados`);
    assert.strictEqual(await estadoPedido(A, folio), 'nuevo');
  });

  await t('9. 20 webhooks CONCURRENTES → UNA confirmación', async () => {
    const folio = 'MPWH-0009';
    await crearPagoReal(A, folio, 310);
    const pago = await pagoDe(A, folio);
    const paymentId = 'pay-concurrente';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 310, currency_id: 'MXN' });
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      enviarWebhook({ token: TOKEN_A, paymentId, requestId: `conc-${i}` })));
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND estado='pagado'`, [A, folio]);
    assert.strictEqual(c.n, 1, `quedaron ${c.n} pagos confirmados`);
    assert.strictEqual(await estadoPedido(A, folio), 'nuevo');
  });

  await t('10. el cuerpo del webhook no decide nada', async () => {
    // Los cuerpos de todos los envíos anteriores decían negocio B, folio
    // XAB-0001, monto 999999 y approved. Si algo de eso hubiera influido, el
    // pedido XAB-0001 existiría alterado o B tendría pagos.
    const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id=$1`, [B]);
    assert.strictEqual(c.n, 0, 'el negocio B terminó con pagos que nunca creó');
    const { rows: [p] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE monto = 999999`);
    assert.strictEqual(p.n, 0, 'un monto del cuerpo llegó a la base');
  });

  // ═══ P0-1: dinero fail-closed ═══
  await t('11. moneda distinta (USD vs MXN) → NO confirma', async () => {
    const folio = 'MPWH-0011';
    await crearPagoReal(A, folio, 400);
    const pago = await pagoDe(A, folio);
    const paymentId = 'pay-usd';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 400, currency_id: 'USD' });
    await enviarWebhook({ token: TOKEN_A, paymentId });
    assert.strictEqual((await pagoDe(A, folio)).estado, 'requiere_revision',
      'confirmo un cobro en otra moneda');
    assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago');
  });

  await t('12. moneda ausente → NO confirma', async () => {
    const folio = 'MPWH-0012';
    await crearPagoReal(A, folio, 410);
    const pago = await pagoDe(A, folio);
    const paymentId = 'pay-sin-moneda';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 410 });
    await enviarWebhook({ token: TOKEN_A, paymentId });
    assert.strictEqual((await pagoDe(A, folio)).estado, 'requiere_revision',
      'confirmo sin saber en que moneda se cobro');
    assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago');
  });

  await t('13. monto ausente, NaN o 0 → NO confirma', async () => {
    for (const [etiqueta, monto] of [['ausente', undefined], ['nan', 'no-es-un-numero'], ['cero', 0]]) {
      const folio = `MPWH-13-${etiqueta}`;
      await crearPagoReal(A, folio, 420);
      const pago = await pagoDe(A, folio);
      const paymentId = `pay-monto-${etiqueta}`;
      const cuerpo = { status: 'approved', external_reference: pago.referencia_interna, currency_id: 'MXN' };
      if (monto !== undefined) cuerpo.transaction_amount = monto;
      PAGOS_MOCK.set(paymentId, cuerpo);
      await enviarWebhook({ token: TOKEN_A, paymentId });
      assert.strictEqual((await pagoDe(A, folio)).estado, 'requiere_revision',
        `monto ${etiqueta}: confirmo igual`);
      assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago', `monto ${etiqueta}: libero cocina`);
    }
  });

  // ═══ P0-2: payment_id ya ligado a otro pago ═══
  await t('14. un payment_id que ya pertenece a otro cobro NO confirma el segundo', async () => {
    const folioA = 'MPWH-14-A';
    const folioB = 'MPWH-14-B';
    await crearPagoReal(A, folioA, 700);
    const pagoA = await pagoDe(A, folioA);
    const paymentId = 'pay-compartido';
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pagoA.referencia_interna, transaction_amount: 700, currency_id: 'MXN' });
    await enviarWebhook({ token: TOKEN_A, paymentId });
    assert.strictEqual((await pagoDe(A, folioA)).estado, 'pagado', 'el primero deberia confirmarse');

    // Segundo cobro del MISMO negocio cuyo proveedor devuelve el MISMO payment.
    await crearPagoReal(A, folioB, 700);
    const pagoB = await pagoDe(A, folioB);
    PAGOS_MOCK.set(paymentId, { status: 'approved', external_reference: pagoB.referencia_interna, transaction_amount: 700, currency_id: 'MXN' });
    await enviarWebhook({ token: TOKEN_A, paymentId, requestId: 'req-dup' });

    assert.notStrictEqual((await pagoDe(A, folioB)).estado, 'pagado',
      'un payment_id ya usado confirmo un SEGUNDO cobro: se cobraria dos veces lo mismo');
    assert.strictEqual((await pagoDe(A, folioB)).estado, 'requiere_revision');
    assert.strictEqual(await estadoPedido(A, folioB), 'pendiente_pago', 'libero cocina con un payment ajeno');
    // Y el primero quedo intacto.
    assert.strictEqual((await pagoDe(A, folioA)).estado, 'pagado');
    assert.strictEqual((await pagoDe(A, folioA)).payment_id, paymentId);
  });

  // ═══ P0-3: reconciliación cuando el webhook nunca llega ═══
  await t('15. el webhook NUNCA llega pero el pago existe en MP → la reconciliación lo confirma', async () => {
    const folio = 'MPWH-0015';
    await crearPagoReal(A, folio, 550);
    const pago = await pagoDe(A, folio);
    // El cobro existe en el proveedor; nadie avisó a Xabor.
    PAGOS_MOCK.set('pay-perdido', {
      status: 'approved', external_reference: pago.referencia_interna,
      transaction_amount: 550, currency_id: 'MXN',
    });
    assert.strictEqual((await pagoDe(A, folio)).estado, 'pendiente');

    const { reconciliarPagosMercadoPago } = await import('../src/services/webhookPagos.js');
    const n = await reconciliarPagosMercadoPago();
    assert.ok(n >= 1, 'la reconciliación no recuperó ningún pago');
    assert.strictEqual((await pagoDe(A, folio)).estado, 'pagado', 'el pago sigue sin confirmarse');
    assert.strictEqual((await pagoDe(A, folio)).payment_id, 'pay-perdido');
    assert.strictEqual(await estadoPedido(A, folio), 'nuevo', 'el pedido no se liberó');
  });

  await t('16. la reconciliación NUNCA consulta /v1/payments/<preferenceId>', async () => {
    const folio = 'MPWH-0016';
    await crearPagoReal(A, folio, 560);
    const pago = await pagoDe(A, folio);
    PAGOS_MOCK.set('pay-recon-2', { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 560, currency_id: 'MXN' });
    RUTAS_CONSULTADAS.length = 0;
    const { reconciliarPagosMercadoPago } = await import('../src/services/webhookPagos.js');
    await reconciliarPagosMercadoPago();
    const directas = RUTAS_CONSULTADAS.filter(u => u.startsWith('/v1/payments/') && !u.startsWith('/v1/payments/search'));
    assert.ok(!directas.some(u => u.includes('pref-')),
      `la reconciliación consultó una preferencia como si fuera un pago: ${directas.join(', ')}`);
    assert.ok(RUTAS_CONSULTADAS.some(u => u.startsWith('/v1/payments/search')),
      'no usó la búsqueda por external_reference');
  });

  await t('17. dos reconciliaciones concurrentes → una sola confirmación', async () => {
    const folio = 'MPWH-0017';
    await crearPagoReal(A, folio, 570);
    const pago = await pagoDe(A, folio);
    PAGOS_MOCK.set('pay-recon-conc', { status: 'approved', external_reference: pago.referencia_interna, transaction_amount: 570, currency_id: 'MXN' });
    const { reconciliarPagosMercadoPago } = await import('../src/services/webhookPagos.js');
    await Promise.all([reconciliarPagosMercadoPago(), reconciliarPagosMercadoPago()]);
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND estado='pagado'`, [A, folio]);
    assert.strictEqual(c.n, 1, `quedaron ${c.n} confirmaciones`);
    assert.strictEqual(await estadoPedido(A, folio), 'nuevo');
  });

  await t('18. un pago todavía pendiente en MP no cocina', async () => {
    const folio = 'MPWH-0018';
    await crearPagoReal(A, folio, 580);
    const pago = await pagoDe(A, folio);
    PAGOS_MOCK.set('pay-recon-pend', { status: 'pending', external_reference: pago.referencia_interna, transaction_amount: 580, currency_id: 'MXN' });
    const { reconciliarPagosMercadoPago } = await import('../src/services/webhookPagos.js');
    await reconciliarPagosMercadoPago();
    assert.notStrictEqual((await pagoDe(A, folio)).estado, 'pagado');
    assert.strictEqual(await estadoPedido(A, folio), 'pendiente_pago');
  });

  await t('19. una reconsulta fallida responde 5xx para que MP reintente', async () => {
    // Sin el pago en el mock, el adaptador recibe 404 y lanza: eso es un fallo
    // transitorio desde el punto de vista del webhook. Responder 200 le diria a
    // MP que el aviso quedo entregado.
    const folio = 'MPWH-0019';
    await crearPagoReal(A, folio, 590);
    const st = await enviarWebhook({ token: TOKEN_A, paymentId: 'pay-que-explota' });
    assert.ok(st >= 500, `respondió ${st} a un fallo transitorio: MP no reintentaría`);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  if (srv) { try { await srv.detener(); } catch {} }
  await new Promise(r => mock.close(r));
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-pagos-webhook-mercadopago: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
