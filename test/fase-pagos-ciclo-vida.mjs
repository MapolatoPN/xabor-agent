// ─── Ciclo de vida financiero: versión, identidad de checkout, crash, orden ──
//
// Cuatro cosas que el dinero necesita y que no se cubrían antes:
//
//   A. Pagar la v1 de un pedido NO es pagar la v2. El dinero es real y se
//      asienta; la cocina no se libera.
//   B. Una fila = un checkout externo. Reutilizar una fila que ya tenía
//      identidad de proveedor obligaba a sobrescribirla, y con eso desaparecía
//      el checkout que un webhook tardío todavía puede nombrar.
//   C. Morir entre el commit financiero y la liberación del pedido dejaba un
//      cobro que nadie iba a derivar nunca: la reconciliación de proveedor ya
//      no lo mira (está 'pagado') y la marca del pedido aún no existe.
//   D. Un evento atrasado no puede resucitar un cobro cerrado.
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
const SECRETO_MP = 'secreto-ciclo-vida';
const PUERTO = Number(process.env.TEST_PORT_CICLO || 4301);
const PUERTO_CRASH = Number(process.env.TEST_PORT_CICLO_CRASH || 4302);
const PUERTO_CLIP = Number(process.env.TEST_PORT_CICLO_CLIP || 4303);
const PUERTO_MP = Number(process.env.TEST_PORT_CICLO_MP || 4304);
const base = `http://localhost:${PUERTO}`;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mocks ───────────────────────────────────────────────────────────────────
let checkoutsClip = 0;
const CHECKOUTS = new Map();          // linkId -> { referencia, estado }
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-cv-${++checkoutsClip}`;
      const eco = body.expires_at ? new Date(Date.parse(body.expires_at)).toISOString() : new Date(Date.now() + 3 * 24 * 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING',
        monto: Number(body.amount),
        expiraAt: eco,
      });
      res.end(JSON.stringify({
        payment_request_id: id, payment_request_url: `https://pago.mock.clip/${id}`, status: 'CHECKOUT',
        expires_at: eco,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      CONSULTAS_CLIP.push(id);
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
        expires_at: c.expiraAt || null,
        last_status_message: 'Payment request is active',
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
const CONSULTAS_CLIP = [];

const PAGOS_MP = new Map();
const BUSQUEDAS_MP = new Map();       // external_reference -> paymentId
let checkoutsMP = 0;
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-cv-${++checkoutsMP}`;
      PREFERENCIAS.set(id, { external_reference: p.external_reference });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, init_point: `https://mp.test/checkout/${id}` }));
    });
    return;
  }
  if (req.url.startsWith('/v1/payments/search')) {
    const ref = new URL(req.url, 'http://x').searchParams.get('external_reference');
    const pagoId = BUSQUEDAS_MP.get(ref);
    const results = pagoId && PAGOS_MP.has(pagoId) ? [PAGOS_MP.get(pagoId)] : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
    return;
  }
  const m = /^\/v1\/payments\/([^/?]+)/.exec(req.url);
  if (m) {
    const pago = PAGOS_MP.get(decodeURIComponent(m[1]));
    if (!pago) { res.writeHead(404); res.end('{"message":"not found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pago));
    return;
  }
  res.writeHead(404); res.end('{}');
});
const PREFERENCIAS = new Map();

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
    { accessToken: 'token-cv', publicKey: 'pk-test', webhookSecret: SECRETO_MP },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'mercado_pago', SEED.superadminUsuarioId);
  const { asegurarRoutingTokenIntegracion } = await import('../src/services/database.js');
  return asegurarRoutingTokenIntegracion(NEG, 'mercado_pago');
}

async function pedido(folio, monto, extra = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (folio) DO UPDATE SET estado=$3, datos=$4`,
    [folio, NEG, extra.estadoPedido || 'pendiente_pago', JSON.stringify({
      id: folio, negocioId: NEG, canal: 'tienda_online', total: monto, estado: extra.estadoPedido || 'pendiente_pago',
      modalidad: extra.modalidad || 'recoger en tienda', forma_pago: 'enlace de pago', pago_confirmado: false,
      cliente: { nombre: 'Cliente ciclo', telefono: '8997500001' },
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

async function webhookClip(referencia, { puerto = PUERTO } = {}) {
  const r = await fetch(`http://localhost:${puerto}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: referencia }),
  });
  return r.status;
}
function firmarMP(dataId, requestId, ts, secreto) {
  const id = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  return createHmac('sha256', secreto).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
}
async function webhookMP(token, paymentId, { puerto = PUERTO } = {}) {
  const ts = '1700000000', requestId = 'req-cv';
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
  const term = await crearEdge(NEG, { nombre: 'PC CICLO' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora ciclo', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora ciclo' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'CV-%'`, [NEG]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'CV-%'`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='PC CICLO')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='PC CICLO' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

let srv = null, srvCrash = null, TOKEN_MP = null;
try {
  await limpiar();
  await montarImpresion();
  const envServidor = {
    CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
    XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
    XABOR_URL_PUBLICA: base,
  };
  srv = await arrancarServidor({ PORT: String(PUERTO), ...envServidor }, { timeoutMs: 90000 });

  // ═══ P0 A — PAGO DE UNA VERSIÓN VIEJA ═══
  await t('A1. pagan la v1 ($500) con el pedido ya en v2 ($700): dinero asentado, cocina cerrada', async () => {
    const folio = 'CV-0001';
    await pedido(folio, 500);
    await conectarClip();
    const v1 = await crearEnlace(folio);
    const filaV1 = (await filas(folio))[0];

    await pedido(folio, 700);                       // el pedido cambia de precio
    await crearEnlace(folio);                       // se genera el checkout de v2

    CHECKOUTS.get(v1.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(filaV1.referencia_interna), 200);
    await esperar(async () => (await filaId(filaV1.id)).estado === 'pagado',
      'que el dinero de la v1 quede asentado');

    const pagada = await filaId(filaV1.id);
    assert.strictEqual(Number(pagada.monto), 500, 'el monto asentado no es el que se cobró');
    assert.strictEqual(pagada.metadata_sanitizada.anomalia, 'version_desfasada',
      'no quedó marcada la discrepancia de versión');
    assert.strictEqual(pagada.metadata_sanitizada.monto_actual, 700);
    assert.strictEqual(pagada.derivacion_pendiente, false,
      'quedó deuda de derivación: el job liberaría el pedido por su cuenta');

    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'pendiente_pago', '¡liberó un pedido de $700 con un cobro de $500!');
    assert.notStrictEqual(p.datos.pago_confirmado, true, 'marcó como pagado un pedido que no lo está');
    assert.strictEqual(await comandasDe(folio), 0, 'salió comanda cerrando la diferencia en silencio');
  });

  await t('A2. sobrepago (v1 $700, pedido ahora $500): mismo criterio, nadie decide por el negocio', async () => {
    const folio = 'CV-0002';
    await pedido(folio, 700);
    const v1 = await crearEnlace(folio);
    const filaV1 = (await filas(folio))[0];
    await pedido(folio, 500);
    await crearEnlace(folio);

    CHECKOUTS.get(v1.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(filaV1.referencia_interna), 200);
    await esperar(async () => (await filaId(filaV1.id)).estado === 'pagado', 'el asiento del sobrepago');

    const pagada = await filaId(filaV1.id);
    assert.strictEqual(pagada.metadata_sanitizada.anomalia, 'version_desfasada');
    assert.strictEqual(Number(pagada.monto), 700);
    assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago');
    assert.strictEqual(await comandasDe(folio), 0, 'el sobrepago libero cocina sin que nadie lo revisara');
  });

  await t('A3. cambio SOLO de proveedor, misma versión y monto: sigue liberando como antes', async () => {
    const folio = 'CV-0003';
    await pedido(folio, 620);
    await conectarClip();
    const clip = await crearEnlace(folio);
    const filaClip = (await filas(folio)).find(f => f.proveedor === 'clip');
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);

    CHECKOUTS.get(clip.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(filaClip.referencia_interna), 200);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del pago honrado');

    const p = await pedidoDe(folio);
    assert.notStrictEqual(p.estado, 'pendiente_pago', 'no liberó un pago de la MISMA versión');
    assert.strictEqual(p.datos.pago_confirmado, true);
    // La deuda se salda DESPUÉS de emitir, así que medirla justo tras contar la
    // comanda es una carrera: hay que esperar la condición, no suponerla.
    await esperar(async () => (await filaId(filaClip.id)).derivacion_pendiente === false,
      'que la deuda de derivación quede saldada');
  });

  // ═══ P0 B — UNA FILA NO PUEDE SER DOS CHECKOUTS ═══
  await t('B0. MISMA versión, checkout A ya fallido: se crea B sin tocar la identidad de A', async () => {
    // Aquí no cambia el pedido: cambia solo el destino de A. Es el caso donde
    // la tentación de reutilizar la fila es máxima -- y donde reutilizarla
    // obligaría a sobrescribir referencia_externa y url.
    const folio = 'CV-0009';
    await pedido(folio, 375);
    await conectarClip();
    const a = await crearEnlace(folio);
    const filaA = (await filas(folio))[0];
    await pool.query(`UPDATE pagos SET estado='fallido' WHERE id=$1`, [filaA.id]);

    const b = await crearEnlace(folio);
    assert.notStrictEqual(b.pagoId, filaA.id, 'reutilizó la fila de un checkout que ya existía');
    const A = await filaId(filaA.id);
    assert.strictEqual(A.referencia_externa, a.referenciaExterna, 'sobrescribió el id de proveedor de A');
    assert.strictEqual(A.url, a.url, 'sobrescribió la URL histórica de A');
    assert.strictEqual((await filas(folio)).length, 2, 'A y B deben coexistir');
  });

  await t('B1. checkout A invalidado y checkout B creado: siguen siendo distinguibles', async () => {
    const folio = 'CV-0010';
    await pedido(folio, 480);
    await conectarClip();
    const a = await crearEnlace(folio);
    const filaA = (await filas(folio))[0];
    await pedido(folio, 530);                       // fuerza otro intento
    const b = await crearEnlace(folio);

    const todas = await filas(folio);
    assert.strictEqual(todas.length, 2, `esperaba dos checkouts; hay ${todas.length}`);
    const A = todas.find(f => f.id === filaA.id);
    const B = todas.find(f => f.id === b.pagoId);

    assert.strictEqual(A.referencia_externa, a.referenciaExterna, 'se sobrescribió el id de proveedor de A');
    assert.strictEqual(A.url, a.url, 'se sobrescribió la URL histórica de A');
    assert.strictEqual(A.estado, 'invalidado', `A quedó '${A.estado}'`);
    assert.ok(A.motivo_invalidacion, 'A se retiró de circulación sin decir por qué');
    assert.notStrictEqual(B.referencia_interna, A.referencia_interna, 'A y B comparten referencia interna');
    assert.notStrictEqual(B.referencia_externa, A.referencia_externa, 'A y B comparten id de proveedor');
    assert.strictEqual(B.version_pedido_hash !== A.version_pedido_hash, true, 'A y B comparten versión');
  });

  await t('B2. el webhook tardío de A consulta A, jamás B', async () => {
    const folio = 'CV-0010';
    const [A, B] = await filas(folio);
    CONSULTAS_CLIP.length = 0;
    CHECKOUTS.get(A.referencia_externa).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(A.referencia_interna), 200);
    await esperar(async () => (await filaId(A.id)).estado === 'pagado', 'el asiento del checkout A');

    assert.ok(CONSULTAS_CLIP.includes(A.referencia_externa), 'no se consultó el checkout A');
    assert.ok(!CONSULTAS_CLIP.includes(B.referencia_externa),
      '¡se consultó el checkout B para verificar un cobro de A!');
    // A es de la versión vieja: dinero real, sin liberación.
    assert.strictEqual((await filaId(A.id)).metadata_sanitizada.anomalia, 'version_desfasada');
  });

  await t('B3. si A y B terminan ambos cobrados, el doble cobro real es detectable', async () => {
    const folio = 'CV-0010';
    const [, B] = await filas(folio);
    CHECKOUTS.get(B.referencia_externa).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(B.referencia_interna), 200);
    await esperar(async () => (await filaId(B.id)).estado === 'pagado', 'el asiento del checkout B');

    const [a2, b2] = await filas(folio);
    assert.strictEqual(a2.estado, 'pagado');
    assert.strictEqual(b2.estado, 'pagado');
    const conAnomalia = [a2, b2].filter(f => f.metadata_sanitizada.anomalia === 'doble_cobro_real');
    assert.strictEqual(conAnomalia.length, 2,
      'los dos cobros reales del mismo pedido no quedaron señalados como doble cobro');
    assert.strictEqual(a2.referencia_externa !== b2.referencia_externa, true,
      'sin dos ids distintos el doble cobro sería indistinguible de un aviso repetido');
  });

  // ═══ P0 C — CRASH DESPUÉS DEL COMMIT FINANCIERO ═══
  await t('C1. MERCADO PAGO: muerte justo después de asentar → la reconciliación lo recupera', async () => {
    const folio = 'CV-0020';
    await pedido(folio, 830);
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const mp = (await filas(folio)).find(f => f.proveedor === 'mercado_pago');
    PAGOS_MP.set('pay-cv-20', {
      id: 'pay-cv-20', status: 'approved', external_reference: mp.referencia_interna,
      transaction_amount: 830, currency_id: 'MXN',
    });

    // Servidor gemelo que muere EXACTAMENTE entre el commit financiero y el
    // pedido. No se reenvía el webhook: para el proveedor ya quedó entregado.
    srvCrash = await arrancarServidor({
      PORT: String(PUERTO_CRASH), ...envServidor,
      XABOR_URL_PUBLICA: `http://localhost:${PUERTO_CRASH}`,
      XABOR_PAGOS_FALLA_EN: 'despues_de_asentar',
    }, { timeoutMs: 90000 });

    // La petición muere: el webhook de MP responde después de procesar, así que
    // la muerte se ve como 5xx. Da igual -- lo que importa es que el dinero YA
    // quedó asentado y la obligación de derivar quedó escrita.
    const estado = await webhookMP(TOKEN_MP, 'pay-cv-20', { puerto: PUERTO_CRASH });
    assert.ok(estado >= 500, `esperaba que la muerte se propagara; llegó ${estado}`);
    await esperar(async () => (await filaId(mp.id)).estado === 'pagado', 'el commit financiero');

    const tras = await filaId(mp.id);
    assert.strictEqual(tras.derivacion_pendiente, true,
      'no quedó deuda durable: este pedido estaría cobrado y sin liberar para siempre');
    assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago', 'fixture: el crash debía impedir la liberación');
    assert.strictEqual(await comandasDe(folio), 0);

    await srvCrash.detener(); srvCrash = null;

    // El servidor sano corre la recuperación al arrancar y cada minuto.
    const { reconciliarDerivacionesPendientes } = await import('../src/services/webhookPagos.js');
    await reconciliarDerivacionesPendientes();

    const p = await pedidoDe(folio);
    assert.notStrictEqual(p.estado, 'pendiente_pago', 'la recuperación no liberó el pedido');
    assert.strictEqual(p.datos.pago_confirmado, true);
    assert.strictEqual(await comandasDe(folio), 1, 'no salió exactamente una comanda');
    const saldado = await filaId(mp.id);
    assert.strictEqual(saldado.derivacion_pendiente, false, 'la deuda no se saldó');
    assert.ok(saldado.derivacion_saldada_at, 'no quedó registrado cuándo se saldó');
  });

  await t('C2. la recuperación es idempotente: correrla cinco veces no genera comandas de más', async () => {
    const { reconciliarDerivacionesPendientes } = await import('../src/services/webhookPagos.js');
    for (let i = 0; i < 5; i++) await reconciliarDerivacionesPendientes();
    assert.strictEqual(await comandasDe('CV-0020'), 1);
  });

  await t('C3. CLIP usa exactamente la misma deuda: mismo crash, misma recuperación', async () => {
    const folio = 'CV-0021';
    await pedido(folio, 640);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = (await filas(folio)).find(f => f.proveedor === 'clip');
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    srvCrash = await arrancarServidor({
      PORT: String(PUERTO_CRASH), ...envServidor,
      XABOR_URL_PUBLICA: `http://localhost:${PUERTO_CRASH}`,
      XABOR_PAGOS_FALLA_EN: 'despues_de_asentar',
    }, { timeoutMs: 90000 });
    assert.strictEqual(await webhookClip(clip.referencia_interna, { puerto: PUERTO_CRASH }), 200);
    await esperar(async () => (await filaId(clip.id)).derivacion_pendiente === true,
      'la deuda durable del camino de Clip');
    await srvCrash.detener(); srvCrash = null;

    const { reconciliarDerivacionesPendientes } = await import('../src/services/webhookPagos.js');
    await reconciliarDerivacionesPendientes();
    assert.strictEqual((await pedidoDe(folio)).datos.pago_confirmado, true);
    assert.strictEqual(await comandasDe(folio), 1);
    assert.strictEqual((await filaId(clip.id)).derivacion_pendiente, false);
  });

  // ═══ P0 D — MÁQUINA DE ESTADOS MONÓTONA ═══
  await t('D1. un evento atrasado no resucita un cobro cerrado', async () => {
    const { actualizarEstadoPagoPorId } = await import('../src/services/database.js');
    const folio = 'CV-0030';
    await pedido(folio, 300);
    await conectarClip();
    await crearEnlace(folio);
    const fila = (await filas(folio))[0];

    for (const terminal of ['invalidado', 'cancelado', 'vencido', 'reembolsado']) {
      await pool.query(`UPDATE pagos SET estado=$2 WHERE id=$1`, [fila.id, terminal]);
      const ok = await actualizarEstadoPagoPorId(fila.id, NEG, 'pendiente');
      assert.strictEqual(ok, false, `${terminal} -> pendiente fue aceptado`);
      assert.strictEqual((await filaId(fila.id)).estado, terminal,
        `${terminal} cambió de estado por un evento atrasado`);
    }
  });

  await t('D2. las transiciones legítimas siguen funcionando', async () => {
    const { actualizarEstadoPagoPorId } = await import('../src/services/database.js');
    const fila = (await filas('CV-0030'))[0];
    await pool.query(`UPDATE pagos SET estado='pendiente' WHERE id=$1`, [fila.id]);
    assert.strictEqual(await actualizarEstadoPagoPorId(fila.id, NEG, 'requiere_revision'), true);
    assert.strictEqual(await actualizarEstadoPagoPorId(fila.id, NEG, 'invalidado'), true);
    // y desde ahí, ya no se sale
    assert.strictEqual(await actualizarEstadoPagoPorId(fila.id, NEG, 'requiere_revision'), false);
  });

  await t('D3. tampoco se llega a "pagado" por esta puerta: el dinero tiene una sola', async () => {
    const { actualizarEstadoPagoPorId } = await import('../src/services/database.js');
    const fila = (await filas('CV-0030'))[0];
    await pool.query(`UPDATE pagos SET estado='pendiente' WHERE id=$1`, [fila.id]);
    assert.strictEqual(await actualizarEstadoPagoPorId(fila.id, NEG, 'pagado'), false,
      'se pudo marcar pagado sin verificar dinero, sin cerrar hermanos y sin comparar versión');
    assert.strictEqual((await filaId(fila.id)).estado, 'pendiente');
  });

  // ═══ TRANSFERENCIA MANUAL ═══
  await t('E1. MP ya pagado + admin confirma la transferencia: doble cobro, una sola comanda', async () => {
    const folio = 'CV-0040';
    await pedido(folio, 910);
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const mp = (await filas(folio)).find(f => f.proveedor === 'mercado_pago');

    // El cliente paga por Mercado Pago.
    PAGOS_MP.set('pay-cv-40', {
      id: 'pay-cv-40', status: 'approved', external_reference: mp.referencia_interna,
      transaction_amount: 910, currency_id: 'MXN',
    });
    assert.strictEqual(await webhookMP(TOKEN_MP, 'pay-cv-40'), 200);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del pago de MP');

    // Y además había depositado por transferencia, que el admin confirma.
    const { rows: [transf] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                          moneda, monto, estado, version_pedido_hash)
       VALUES ($1,$2,'manual_transfer',$3,'transferencia','MXN',910,'requiere_revision',$4)
       RETURNING *`,
      [NEG, folio, `${NEG}:${folio}:transferencia-manual`, mp.version_pedido_hash]);

    const { confirmarPagoManual } = await import('../src/services/database.js');
    const r = await confirmarPagoManual(NEG, transf.id, SEED.superadminUsuarioId);
    assert.strictEqual(r.ok, false, 'la confirmación manual no detectó el otro cobro real');
    assert.strictEqual(r.resultado, 'doble_cobro');

    const t2 = await filaId(transf.id);
    const mp2 = await filaId(mp.id);
    assert.strictEqual(t2.estado, 'pagado', 'el depósito real del cliente quedó sin registrar');
    assert.strictEqual(mp2.estado, 'pagado', 'se pisó el cobro de Mercado Pago');
    assert.strictEqual(t2.metadata_sanitizada.anomalia, 'doble_cobro_real');
    assert.strictEqual(mp2.metadata_sanitizada.anomalia, 'doble_cobro_real');
    assert.strictEqual(await comandasDe(folio), 1, 'la confirmación manual generó una segunda comanda');
  });

  await t('E2. transferencia confirmada primero: el enlace externo abierto deja de ser cobrable', async () => {
    const folio = 'CV-0041';
    await pedido(folio, 450);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = (await filas(folio)).find(f => f.proveedor === 'clip');
    assert.strictEqual(clip.estado, 'pendiente', 'fixture: el enlace debía quedar abierto');

    const { rows: [transf] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                          moneda, monto, estado, version_pedido_hash)
       VALUES ($1,$2,'manual_transfer',$3,'transferencia','MXN',450,'requiere_revision',$4)
       RETURNING *`,
      [NEG, folio, `${NEG}:${folio}:transferencia-primero`, clip.version_pedido_hash]);

    const { confirmarPagoManual } = await import('../src/services/database.js');
    const r = await confirmarPagoManual(NEG, transf.id, SEED.superadminUsuarioId);
    assert.strictEqual(r.ok, true, `la confirmación manual falló: ${r.resultado}`);

    const clipDespues = await filaId(clip.id);
    assert.strictEqual(clipDespues.estado, 'invalidado',
      `el enlace de Clip quedó '${clipDespues.estado}': seguiría ofreciéndose con el pedido ya pagado`);
    assert.strictEqual(clipDespues.referencia_externa, enlace.referenciaExterna,
      'al cerrarlo se le borró la identidad, y un cobro real por ese enlace quedaría huérfano');
    assert.strictEqual(r.pago.derivacion_pendiente, true,
      'la confirmación manual no dejó deuda durable de derivación');
  });

  // ═══ RECONCILIACIÓN Y EXPIRACIÓN ═══
  await t('F1. MP superseded, webhook perdido, y después cobrado: la reconciliación lo descubre', async () => {
    const folio = 'CV-0050';
    await pedido(folio, 550);
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const mp = (await filas(folio)).find(f => f.proveedor === 'mercado_pago');
    // Se supersede sin cancelar de verdad: MP no recibió ninguna cancelación.
    await pool.query(`UPDATE pagos SET estado='invalidado', invalidated_at=NOW(),
                      motivo_invalidacion='superado en la prueba' WHERE id=$1`, [mp.id]);

    // El cliente paga igual y el webhook nunca llega.
    PAGOS_MP.set('pay-cv-50', {
      id: 'pay-cv-50', status: 'approved', external_reference: mp.referencia_interna,
      transaction_amount: 550, currency_id: 'MXN',
    });
    BUSQUEDAS_MP.set(mp.referencia_interna, 'pay-cv-50');

    const { reconciliarPagosMercadoPago } = await import('../src/services/webhookPagos.js');
    await reconciliarPagosMercadoPago();

    const tras = await filaId(mp.id);
    assert.strictEqual(tras.estado, 'pagado',
      'un checkout superseded pero todavía pagable quedó fuera de la reconciliación');
    assert.strictEqual(tras.metadata_sanitizada.honrado_tras_invalidacion, true);
  });

  await t('F2. Clip histórico con webhook perdido: se descubre sin depender del clip_link_id del pedido', async () => {
    const folio = 'CV-0051';
    await pedido(folio, 470);
    await conectarClip();
    const primero = await crearEnlace(folio);
    const filaA = (await filas(folio))[0];
    await pedido(folio, 495);
    await crearEnlace(folio);                       // sobrescribe datos.clip_link_id con el de B

    const p = await pedidoDe(folio);
    assert.notStrictEqual(p.datos.clip_link_id, primero.referenciaExterna,
      'fixture: datos.clip_link_id debía haber quedado apuntando al segundo checkout');

    // El PRIMER checkout es el que se cobra, y su webhook se pierde.
    CHECKOUTS.get(primero.referenciaExterna).estado = 'COMPLETED';
    const { pagosReconciliablesDeProveedor } = await import('../src/services/database.js');
    const reconciliables = await pagosReconciliablesDeProveedor('clip', 50);
    assert.ok(reconciliables.some(r => r.id === filaA.id),
      'el checkout viejo no entra en la reconciliación: su cobro nunca se descubriría');
  });

  await t('F3. un pedido ENTREGADO que sigue sin pagar no se pierde de vista', async () => {
    const folio = 'CV-0052';
    await pedido(folio, 380);
    await conectarClip();
    await crearEnlace(folio);
    const fila = (await filas(folio))[0];
    await pool.query(`UPDATE pedidos_activos SET estado='entregado' WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG]);

    const { pagosReconciliablesDeProveedor } = await import('../src/services/database.js');
    const reconciliables = await pagosReconciliablesDeProveedor('clip', 50);
    assert.ok(reconciliables.some(r => r.id === fila.id),
      'entregar el pedido lo sacó de la reconciliación: justo el que más importa cobrar');
  });

  await t('F4. un cobro ya resuelto sale del universo reconciliable', async () => {
    const { pagosReconciliablesDeProveedor } = await import('../src/services/database.js');
    const pagados = await pagosReconciliablesDeProveedor('mercado_pago', 100);
    assert.ok(!pagados.some(r => r.estado === 'pagado'), 'se sigue consultando un cobro ya asentado');
    // Y uno con expiración vencida tampoco: ahí sí hay una fecha real del proveedor.
    const folio = 'CV-0053';
    await pedido(folio, 210);
    await conectarClip();
    await crearEnlace(folio);
    const fila = (await filas(folio))[0];
    await pool.query(`UPDATE pagos SET expires_at = NOW() - INTERVAL '1 hour' WHERE id=$1`, [fila.id]);
    const clip = await pagosReconciliablesDeProveedor('clip', 100);
    assert.ok(!clip.some(r => r.id === fila.id), 'se sigue consultando un checkout ya expirado');
  });

  // ═══ CONCURRENCIA DE CAMBIO ═══
  await t('G1. quien espera el claim relee el pedido: nunca crea el checkout de una versión muerta', async () => {
    const folio = 'CV-0060';
    await pedido(folio, 400);
    await conectarClip();
    const antes = checkoutsClip;

    // La petición entra al claim y se queda dormida ANTES de leer el pedido.
    process.env.XABOR_PAGOS_RETARDO_INTENTO_MS = '1200';
    const enVuelo = crearEnlace(folio);
    await new Promise(r => setTimeout(r, 300));
    await pedido(folio, 900);                       // el pedido cambia mientras duerme
    const r = await enVuelo;
    delete process.env.XABOR_PAGOS_RETARDO_INTENTO_MS;

    const todas = await filas(folio);
    assert.strictEqual(todas.length, 1, `creó ${todas.length} checkouts para el mismo pedido`);
    assert.strictEqual(checkoutsClip - antes, 1, 'se creó más de un checkout externo');
    assert.strictEqual(Number(todas[0].monto), 900,
      `creó el checkout de la versión muerta ($${todas[0].monto} en vez de $900)`);
    assert.strictEqual(todas[0].id, r.pagoId);
  });

  await t('G2. cambio de proveedor con peticiones concurrentes: nunca dos checkouts externos', async () => {
    const folio = 'CV-0061';
    await pedido(folio, 700);
    await conectarClip();
    const antesClip = checkoutsClip, antesMP = checkoutsMP;

    process.env.XABOR_PAGOS_RETARDO_INTENTO_MS = '1200';
    const a = crearEnlace(folio);
    await new Promise(r => setTimeout(r, 300));
    TOKEN_MP = await conectarMP();                  // el negocio cambia de proveedor en plena carrera
    const b = crearEnlace(folio);
    const [ra, rb] = await Promise.all([a, b]);
    delete process.env.XABOR_PAGOS_RETARDO_INTENTO_MS;

    assert.strictEqual(ra.pagoId, rb.pagoId, 'la carrera devolvió dos pagos distintos');
    assert.strictEqual((checkoutsClip - antesClip) + (checkoutsMP - antesMP), 1,
      'la carrera creó más de un checkout externo');
    assert.strictEqual((await filas(folio)).length, 1);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  delete process.env.XABOR_PAGOS_RETARDO_INTENTO_MS;
  if (srv) await srv.detener();
  if (srvCrash) await srvCrash.detener();
  clipMock.close(); mpMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-pagos-ciclo-vida: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
