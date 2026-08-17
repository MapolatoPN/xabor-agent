// ─── Promociones y dinero: reservar no es consumir ──────────────────────────
//
// El defecto que abre esta suite: en la Tienda, llegar al checkout con una
// promoción limitada la daba por GASTADA. La reserva se convertía en uso
// definitivo dentro de `finalizarCheckout`, junto con la comanda y el tablero,
// aunque el pedido naciera `pendiente_pago` y no hubiera entrado un solo peso.
// Si el cliente no pagaba nunca, el cupo quedaba quemado para siempre: la fila
// ya tenía folio real, así que el reciclador de reservas -- que solo mira las
// filas con prefijo `reserva:` -- jamás la volvía a tocar.
//
// El ciclo correcto es el mismo que ya tiene el dinero:
//
//   crear checkout          → RESERVA   (cuenta contra el límite)
//   dinero asentado + deuda → CONSUME   (dentro de consumirDeudaDeDerivacion)
//   vence la espera Xabor   → LIBERA    (dentro de vencerEsperaDePago)
//
// Ninguna prueba toca Clip ni Mercado Pago reales. Cero dinero real en juego.
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

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const SECRETO_MP = 'secreto-promos';
const SLUG = 'promos-pagos-test';
const PUERTO = Number(process.env.TEST_PORT_PROMO || 4341);
const PUERTO_CLIP = Number(process.env.TEST_PORT_PROMO_CLIP || 4342);
const PUERTO_MP = Number(process.env.TEST_PORT_PROMO_MP || 4343);
const PUERTO_ROTO = Number(process.env.TEST_PORT_PROMO_ROTO || 4344);
const base = `http://localhost:${PUERTO}`;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

const tokenNuevo = () => randomBytes(24).toString('hex');

// ── Mocks con la forma DOCUMENTADA de cada API ──────────────────────────────
let checkoutsClip = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-promo-${++checkoutsClip}`;
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount),
      });
      res.end(JSON.stringify({
        payment_request_id: id, payment_request_url: `https://pago.mock.clip/${id}`, status: 'CHECKOUT',
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: id,
        status: c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED' : 'CHECKOUT_PENDING',
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
        created_at: '2026-08-17T00:00:00.000Z', expired_at: null,
        last_status_message: 'Payment request is active',
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

const PAGOS_MP = new Map();
let checkoutsMP = 0;
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const id = `pref-promo-${++checkoutsMP}`;
      res.end(JSON.stringify({ id, init_point: `https://mp.test/checkout/${id}` }));
    });
    return;
  }
  if (req.url.startsWith('/v1/payments/search')) {
    const ref = new URL(req.url, 'http://x').searchParams.get('external_reference');
    const results = [...PAGOS_MP.values()].filter(p => p.external_reference === ref);
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

await new Promise(r => clipMock.listen(PUERTO_CLIP, r));
await new Promise(r => mpMock.listen(PUERTO_MP, r));

// ── Fixture de tienda ───────────────────────────────────────────────────────
let PRODUCTO = null;

const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/** Compra que EXIGE 200: si el checkout falla, el mensaje trae el motivo real. */
async function comprarOk(cuerpo) {
  const r = await comprar(cuerpo);
  assert.strictEqual(r.status, 200, `checkout rechazado: ${JSON.stringify(r.body)}`);
  return r;
}

const carrito = (tk, extra = {}) => ({
  checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente promo', telefono: '8997600001' },
  metodoPago: 'enlace_pago', ...extra,
});

async function conectarClip(negocioId = NEG) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'clip', SEED.superadminUsuarioId);
}
async function conectarMP(negocioId = NEG) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'mercado_pago',
    { accessToken: 'token-promo', publicKey: 'pk-test', webhookSecret: SECRETO_MP },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'mercado_pago', SEED.superadminUsuarioId);
  const { asegurarRoutingTokenIntegracion } = await import('../src/services/database.js');
  return asegurarRoutingTokenIntegracion(negocioId, 'mercado_pago');
}

/** Crea una promoción de código y devuelve su id. */
async function promo({ codigo, limiteUsos = null, limitePorCliente = null, valor = 50,
                       negocioId = NEG, tipo = 'monto_fijo' } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO tienda_promociones
       (negocio_id, nombre, tipo, codigo, automatica, valor, limite_usos, limite_por_cliente,
        canales, activa)
     VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,'["tienda_online"]'::jsonb,TRUE)
     RETURNING id`,
    [negocioId, `Promo ${codigo}`, tipo, codigo, valor, limiteUsos, limitePorCliente]);
  return p.id;
}

const promoDe = async (id) => (await pool.query(
  `SELECT * FROM tienda_promociones WHERE id=$1`, [id])).rows[0];
const usosDe = async (id) => (await pool.query(
  `SELECT * FROM tienda_promocion_usos WHERE promocion_id=$1 ORDER BY created_at`, [id])).rows;

async function pedidoDe(folio, negocioId = NEG) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, negocioId]);
  return r || null;
}
async function comandasDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2`, [NEG, folio]);
  return r.n;
}
async function pagosDe(folio, negocioId = NEG) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [negocioId, folio]);
  return rows;
}
const filaId = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [id])).rows[0];

async function esperar(condicion, queEsperaba, ms = 10000) {
  const limite = Date.now() + ms;
  for (;;) {
    if (await condicion()) return;
    if (Date.now() > limite) throw new Error(`tiempo agotado esperando: ${queEsperaba}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

/** Genera el enlace de pago del pedido por la vía real del servicio. */
const crearEnlace = async (folio, negocioId = NEG) => {
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  return crearEnlacePago({ negocioId, pedidoId: folio, actor: SEED.superadminUsuarioId });
};

const vencerYa = (pagoId) => pool.query(
  `UPDATE pagos SET xabor_espera_hasta = NOW() - interval '2 minutes' WHERE id=$1`, [pagoId]);

async function webhookClip(referencia) {
  const r = await fetch(`${base}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: referencia }),
  });
  return r.status;
}
function firmarMP(dataId, requestId, ts, secreto) {
  const id = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  return createHmac('sha256', secreto).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
}
async function webhookMP(tokenRuteo, paymentId) {
  const ts = '1700000000', requestId = 'req-promo';
  const r = await fetch(
    `${base}/webhook/pagos/mercado_pago/${tokenRuteo}?data.id=${paymentId}&type=payment`, {
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
  const term = await crearEdge(NEG, { nombre: 'PC PROMO' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora promo', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora promo' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [n]);
    await pool.query(
      `DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='tienda_online'`, [n]);
  }
  delete process.env.XABOR_TIENDA_FALLA_EN;
  delete process.env.XABOR_TIENDA_RETARDO_EN;
  delete process.env.XABOR_TIENDA_RETARDO_MS;
  await pool.query(`DELETE FROM pedidos WHERE negocio_id=$1 AND folio LIKE 'ARCH-%'`, [NEG]);
  await pool.query(`DELETE FROM tienda_campanas WHERE negocio_id=$1 AND nombre LIKE 'Campania metricas%'`, [NEG]);
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='PC PROMO')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='PC PROMO' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='Promos (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='Promos (test)'`, [NEG]);
}

async function preparar() {
  await limpiar();
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(
      `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
       ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG, m]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
     VALUES ($1,'Promos (test)',TRUE,960) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto promo',300,TRUE,1) RETURNING id`, [NEG, cat.id]);
  PRODUCTO = p.id;
  await pool.query(
    `INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [NEG, PRODUCTO]);

  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, tiempo_preparacion_minutos: 10 },
  };
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor=$2`, [NEG, JSON.stringify(reglas)]);
  await pool.query(`UPDATE metodos_pago SET habilitado=FALSE WHERE negocio_id=$1`, [NEG]);
  for (const tipo of ['efectivo', 'enlace_pago']) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,TRUE)
       ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado=TRUE`, [NEG, tipo]);
  }
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'Promos',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  await montarImpresion();
  await conectarClip();
}

let srv = null;
try {
  await preparar();
  srv = await arrancarServidor({
    PORT: String(PUERTO), XABOR_RUTAS_PRUEBA: '1',
    // El limite de checkouts por IP es operativo y configurable por env. Esta
    // suite manda cientos desde localhost; el rate limit no es lo que se esta
    // probando aqui y lo cubre su propia suite.
    XABOR_TIENDA_LIMITE_CHECKOUT: '2000', XABOR_TIENDA_LIMITE_LECTURA: '5000',
    CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
    XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
    XABOR_URL_PUBLICA: base,
  }, { timeoutMs: 90000 });

  // ═══ EL DEFECTO, REPRODUCIDO ══════════════════════════════════════════════
  await t('R. llegar al checkout NO puede gastar la promoción: sin pago, el cupo vuelve', async () => {
    const id = await promo({ codigo: 'REPRO1', limiteUsos: 1, valor: 50 });

    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'REPRO1' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const folio = r.body.folio;
    const ped = await pedidoDe(folio);
    assert.strictEqual(ped.estado, 'pendiente_pago', 'fixture: el pedido debía nacer sin pagar');
    assert.strictEqual(await comandasDe(folio), 0, 'fixture: no debía salir comanda');

    // Mientras el cobro sigue vivo, la promoción está RESERVADA: cuenta contra
    // el límite (nadie más puede tomarla) pero no está consumida.
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      'la reserva debe contar contra el cupo mientras el cobro sigue vivo');
    const enReserva = await usosDe(id);
    assert.strictEqual(enReserva.length, 1);
    // Marcada como reservada Y sin folio definitivo: si ya trae el folio real
    // como uso consumido, el reciclador nunca la volvera a mirar.
    assert.strictEqual(enReserva[0].estado, 'reservada',
      `el cupo quedó '${enReserva[0].estado}' con cero pesos cobrados`);
    assert.strictEqual(enReserva[0].pedido_folio, folio,
      'la reserva debe estar amarrada al pedido, no a un token provisional');

    // El cliente nunca paga y la espera de Xabor vence.
    const enlace = await crearEnlace(folio);
    assert.ok(enlace.url, 'fixture: debía crearse el checkout');
    const pago = (await pagosDe(folio))[0];
    await vencerYa(pago.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    assert.strictEqual(await expirarPagosVencidos(), 1);

    // Y el cupo vuelve a estar disponible: nadie se quedó con él.
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
    assert.strictEqual(Number((await promoDe(id)).usos), 0,
      'EL CUPO QUEDÓ QUEMADO PARA SIEMPRE: llegar al checkout gastó la promoción');
    assert.strictEqual((await usosDe(id)).length, 0,
      'quedó una fila de uso de una promoción que nadie pagó');

    // Otro cliente sí puede usarla.
    const r2 = await comprar(carrito(tokenNuevo(), {
      codigo: 'REPRO1', cliente: { nombre: 'Cliente B', telefono: '8997600002' } }));
    assert.strictEqual(r2.status, 200,
      `el segundo cliente no pudo usar el cupón liberado: ${JSON.stringify(r2.body)}`);
  });

  // ═══ CICLO COMPLETO: RESERVA → CONSUMO ═══════════════════════════════════
  await t('1. reserva → pago: la promoción se consume UNA vez, con el dinero', async () => {
    const id = await promo({ codigo: 'PAGA1', limiteUsos: 3, valor: 40 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'PAGA1' }));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];

    assert.strictEqual((await usosDe(id))[0].estado, 'reservada');
    assert.strictEqual(Number((await promoDe(id)).usos), 1, 'la reserva no contó contra el cupo');

    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(pago.referencia_interna), 200);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del pago');

    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, 'apareció una segunda fila de uso');
    assert.strictEqual(usos[0].estado, 'consumida', 'el cupo no quedó consumido con el dinero dentro');
    assert.ok(usos[0].consumida_at, 'no quedó registrado cuándo se consumió');
    assert.strictEqual(usos[0].pedido_folio, folio);
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      'consumir movió el contador: la reserva ya lo contaba');
    assert.strictEqual((await pedidoDe(folio)).datos.pago_confirmado, true);
  });

  await t('2. promo ILIMITADA: sin límite no hay nada que agotar, y sigue el ciclo', async () => {
    const id = await promo({ codigo: 'INFINITA', limiteUsos: null, valor: 25 });
    const folios = [];
    for (let i = 0; i < 4; i++) {
      const r = await comprar(carrito(tokenNuevo(), {
        codigo: 'INFINITA', cliente: { nombre: `C${i}`, telefono: `899760100${i}` } }));
      assert.strictEqual(r.status, 200, `la compra ${i} falló: ${JSON.stringify(r.body)}`);
      folios.push(r.body.folio);
    }
    assert.strictEqual(Number((await promoDe(id)).usos), 4);
    assert.strictEqual((await usosDe(id)).filter(u => u.estado === 'reservada').length, 4,
      'una promo ilimitada tampoco consume al llegar al checkout');

    // Uno paga, otro vence: cada uno sigue su camino.
    const e0 = await crearEnlace(folios[0]);
    const p0 = (await pagosDe(folios[0]))[0];
    CHECKOUTS.get(e0.referenciaExterna).estado = 'COMPLETED';
    await webhookClip(p0.referencia_interna);
    await esperar(async () => await comandasDe(folios[0]) === 1, 'la comanda de la ilimitada');

    await crearEnlace(folios[1]);
    await vencerYa((await pagosDe(folios[1]))[0].id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();

    const usos = await usosDe(id);
    assert.strictEqual(usos.find(u => u.pedido_folio === folios[0]).estado, 'consumida');
    assert.ok(!usos.find(u => u.pedido_folio === folios[1]), 'la vencida no se liberó');
    assert.strictEqual(Number((await promoDe(id)).usos), 3);
  });

  await t('3. promo de 2 usos: reservas + consumidas nunca pasan de 2', async () => {
    const id = await promo({ codigo: 'DOS', limiteUsos: 2, valor: 30 });
    const a1 = await comprar(carrito(tokenNuevo(), {
      codigo: 'DOS', cliente: { nombre: 'A', telefono: '8997602001' } }));
    const a2 = await comprar(carrito(tokenNuevo(), {
      codigo: 'DOS', cliente: { nombre: 'B', telefono: '8997602002' } }));
    assert.strictEqual(a1.status, 200);
    assert.strictEqual(a2.status, 200);

    const a3 = await comprar(carrito(tokenNuevo(), {
      codigo: 'DOS', cliente: { nombre: 'C', telefono: '8997602003' } }));
    assert.notStrictEqual(a3.status, 200,
      `entró un tercero sobre una promo de 2 usos: ${JSON.stringify(a3.body)}`);
    assert.strictEqual(Number((await promoDe(id)).usos), 2);

    // Uno paga (consume), el otro vence (libera) -> queda 1 cupo y C sí entra.
    const e1 = await crearEnlace(a1.body.folio);
    CHECKOUTS.get(e1.referenciaExterna).estado = 'COMPLETED';
    await webhookClip((await pagosDe(a1.body.folio))[0].referencia_interna);
    await esperar(async () => await comandasDe(a1.body.folio) === 1, 'la comanda de A');

    await crearEnlace(a2.body.folio);
    await vencerYa((await pagosDe(a2.body.folio))[0].id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual(Number((await promoDe(id)).usos), 1);

    const a3b = await comprar(carrito(tokenNuevo(), {
      codigo: 'DOS', cliente: { nombre: 'C', telefono: '8997602003' } }));
    assert.strictEqual(a3b.status, 200,
      `C no pudo tomar el cupo liberado: ${JSON.stringify(a3b.body)}`);
    assert.strictEqual(Number((await promoDe(id)).usos), 2);
  });

  // ═══ CONCURRENCIA DEL ÚLTIMO CUPO ════════════════════════════════════════
  await t('4. 20 checkouts simultáneos por el ÚLTIMO cupo: gana exactamente uno', async () => {
    const id = await promo({ codigo: 'ULTIMO', limiteUsos: 1, valor: 60 });
    const intentos = Array.from({ length: 20 }, (_, i) => comprar(carrito(tokenNuevo(), {
      codigo: 'ULTIMO', cliente: { nombre: `Sim${i}`, telefono: `89976030${String(i).padStart(2, '0')}` },
    })));
    const res = await Promise.all(intentos);
    const ok = res.filter(r => r.status === 200);
    const rechazados = res.filter(r => r.status === 409);

    assert.strictEqual(ok.length, 1,
      `${ok.length} clientes se llevaron un cupón de 1 uso (409s: ${rechazados.length})`);
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `quedaron ${usos.length} filas de uso para un cupo de 1`);
    assert.strictEqual(usos[0].estado, 'reservada');
    // Y el que ganó sí lleva el descuento aplicado de verdad.
    assert.strictEqual(Number((await pedidoDe(ok[0].body.folio)).datos.descuento), 60);
  });

  // ═══ EL CASO MÁS IMPORTANTE DE LA FASE ═══════════════════════════════════
  await t('5. A reserva último cupo → vence → B lo toma y paga → entra dinero VIEJO de A', async () => {
    const id = await promo({ codigo: 'REASIGNA', limiteUsos: 1, valor: 70 });

    // A toma el último cupo y genera su checkout.
    const rA = await comprarOk(carrito(tokenNuevo(), {
      codigo: 'REASIGNA', cliente: { nombre: 'A', telefono: '8997604001' } }));
    const folioA = rA.body.folio;
    const enlaceA = await crearEnlace(folioA);
    const pagoA = (await pagosDe(folioA))[0];

    // A no paga: vence.
    await vencerYa(pagoA.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual(Number((await promoDe(id)).usos), 0, 'el cupo de A no se liberó');

    // B toma el cupo liberado y SÍ paga.
    const rB = await comprarOk(carrito(tokenNuevo(), {
      codigo: 'REASIGNA', cliente: { nombre: 'B', telefono: '8997604002' } }));
    const folioB = rB.body.folio;
    const enlaceB = await crearEnlace(folioB);
    CHECKOUTS.get(enlaceB.referenciaExterna).estado = 'COMPLETED';
    await webhookClip((await pagosDe(folioB))[0].referencia_interna);
    await esperar(async () => await comandasDe(folioB) === 1, 'la comanda de B');

    // Y AHORA el cliente A paga su enlace viejo, que Clip nunca canceló.
    CHECKOUTS.get(enlaceA.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(pagoA.referencia_interna), 200);
    await esperar(async () => (await filaId(pagoA.id)).estado === 'pagado',
      'que el dinero real de A quede asentado');

    // 1) El dinero de A es real y está reconocido.
    const finalA = await filaId(pagoA.id);
    assert.strictEqual(finalA.estado, 'pagado', 'se repudió dinero real de A');
    assert.strictEqual(finalA.metadata_sanitizada.anomalia, 'pago_tardio',
      'el cobro de A no quedó marcado para revisión');
    assert.strictEqual(finalA.derivacion_pendiente, false);
    // 2) La promo de A NO revive.
    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `hay ${usos.length} usos de un cupón de 1 uso`);
    assert.strictEqual(usos[0].pedido_folio, folioB, 'el cupón se le atribuyó al cliente equivocado');
    assert.strictEqual(usos[0].estado, 'consumida');
    // 3) Total consumido = 1, y B conserva la suya.
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      'segunda apropiación del cupo: el contador se pasó del límite');
    assert.strictEqual((await pedidoDe(folioB)).datos.pago_confirmado, true);
    // 4) A no cocina.
    assert.strictEqual((await pedidoDe(folioA)).estado, 'cancelado');
    assert.strictEqual(await comandasDe(folioA), 0, '¡salió comanda del pedido vencido de A!');
  });

  // ═══ CARRERA EXPIRACIÓN vs SETTLEMENT ════════════════════════════════════
  await t('6. expiración y cobro disparados a la vez: la promo queda en un solo mundo', async () => {
    const { verificarYAsentarClip, derivarPedidoPorPagoAsentado } =
      await import('../src/services/webhookPagos.js');
    const { vencerEsperaDePago } = await import('../src/services/database.js');

    for (let i = 0; i < 5; i++) {
      const id = await promo({ codigo: `CARRERA${i}`, limiteUsos: 1, valor: 35 });
      const r = await comprarOk(carrito(tokenNuevo(), {
        codigo: `CARRERA${i}`, cliente: { nombre: `R${i}`, telefono: `899760500${i}` } }));
      const folio = r.body.folio;
      const enlace = await crearEnlace(folio);
      const pago = (await pagosDe(folio))[0];
      CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
      await vencerYa(pago.id);

      const [asiento] = await Promise.all([
        verificarYAsentarClip({ pago: await filaId(pago.id), checkoutId: enlace.referenciaExterna }),
        vencerEsperaDePago(pago.id, NEG),
      ]);
      if (asiento.ok) await derivarPedidoPorPagoAsentado({ pagoId: pago.id, negocioId: NEG, folio });

      const ped = await pedidoDe(folio);
      const usos = await usosDe(id);
      const cancelado = ped.estado === 'cancelado';
      const comandas = await comandasDe(folio);

      if (cancelado) {
        assert.strictEqual(usos.length, 0, `[${i}] pedido cancelado pero la promo siguió apartada`);
        assert.strictEqual(Number((await promoDe(id)).usos), 0, `[${i}] cupo no devuelto`);
        assert.strictEqual(comandas, 0, `[${i}] comanda de un pedido cancelado`);
      } else {
        assert.strictEqual(usos.length, 1, `[${i}] pedido cobrado sin uso de promo`);
        assert.strictEqual(usos[0].estado, 'consumida',
          `[${i}] pedido cobrado con la promo todavía '${usos[0].estado}'`);
        assert.strictEqual(comandas, 1, `[${i}] pedido cobrado sin comanda`);
      }
      assert.strictEqual((await filaId(pago.id)).estado, 'pagado', `[${i}] el dinero real se perdió`);
    }
  });

  // ═══ WEBHOOK REPETIDO ════════════════════════════════════════════════════
  await t('7. el mismo webhook 50 veces: un consumo, una comanda', async () => {
    const id = await promo({ codigo: 'REPETIDO', limiteUsos: 1, valor: 45 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'REPETIDO' }));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    for (let i = 0; i < 50; i++) {
      assert.strictEqual(await webhookClip(pago.referencia_interna), 200, `el aviso ${i + 1} no fue acusado`);
    }
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda');
    await new Promise(x => setTimeout(x, 600));

    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `50 avisos dejaron ${usos.length} usos`);
    assert.strictEqual(usos[0].estado, 'consumida');
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      '50 avisos movieron el contador más de una vez');
    assert.strictEqual(await comandasDe(folio), 1, '50 avisos sacaron más de una comanda');
  });

  // ═══ CAMBIO DE PROVEEDOR ═════════════════════════════════════════════════
  await t('8. cambia el proveedor: UNA reserva, y la paga el checkout que sea', async () => {
    const id = await promo({ codigo: 'PROVEEDOR', limiteUsos: 1, valor: 55 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'PROVEEDOR' }));
    const folio = r.body.folio;
    const clip = await crearEnlace(folio);
    assert.strictEqual((await usosDe(id)).length, 1);

    // El negocio cambia de proveedor. Se invalida el intento de Clip y se abre
    // uno de Mercado Pago -- pero la promoción es del PEDIDO, no del checkout.
    await conectarMP();
    const clipFila = (await pagosDe(folio)).find(x => x.proveedor === 'clip');
    await pool.query(
      `UPDATE pagos SET estado='invalidado', invalidated_at=NOW(),
                        motivo_invalidacion='cambio de proveedor en la prueba'
        WHERE id=$1`, [clipFila.id]);
    await crearEnlace(folio);
    const mp = (await pagosDe(folio)).find(x => x.proveedor === 'mercado_pago');
    assert.ok(mp, 'no se abrió el intento con el proveedor nuevo');

    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `cambiar de proveedor creó ${usos.length} reservas`);
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      'cambiar de proveedor consumió un segundo cupo');

    // Y paga el enlace VIEJO de Clip, antes de vencer: esa única reserva se
    // consume una sola vez.
    CHECKOUTS.get(clip.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(clipFila.referencia_interna), 200);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del pago por Clip');

    const finales = await usosDe(id);
    assert.strictEqual(finales.length, 1);
    assert.strictEqual(finales[0].estado, 'consumida');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
    assert.strictEqual(await comandasDe(folio), 1, 'una operación, una comanda');
    await conectarClip();
  });

  // ═══ CAMBIO DE VERSIÓN ═══════════════════════════════════════════════════
  await t('9. el pedido cambia de versión: la reserva vieja no justifica el precio nuevo', async () => {
    const id = await promo({ codigo: 'VERSION', limiteUsos: 2, valor: 20 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'VERSION' }));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];

    // El pedido se edita: otro total, otra versión.
    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','999'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(pago.referencia_interna), 200);
    await esperar(async () => (await filaId(pago.id)).estado === 'pagado',
      'que el dinero de la v1 quede asentado');

    const finalPago = await filaId(pago.id);
    assert.strictEqual(finalPago.estado, 'pagado', 'se repudió dinero real de la v1');
    assert.strictEqual(finalPago.metadata_sanitizada.anomalia, 'version_desfasada');
    assert.strictEqual(finalPago.derivacion_pendiente, false);

    // La promo NO se consume: la reserva justificaba la v1, no la v2.
    const usos = await usosDe(id);
    assert.strictEqual(usos.filter(u => u.pedido_folio === folio).length, 0,
      'se consumió una promoción que ya no justifica el precio cobrado');
    assert.strictEqual(await comandasDe(folio), 0, 'cocinó una versión que nadie pagó');

    // Y la reserva NO queda atrapada para siempre. Aquí el expirador ya no
    // sirve -- el pago está 'pagado' y dejó de ser vencible --, así que la
    // política es soltarla en la misma transacción del asiento: la obligación
    // terminó sin liberar el pedido, y ese cupo no representa nada.
    assert.strictEqual(Number((await promoDe(id)).usos), 0,
      'la reserva de una versión muerta se quedó bloqueando el cupo para siempre');
    const otro = await comprarOk(carrito(tokenNuevo(), {
      codigo: 'VERSION', cliente: { nombre: 'Otro', telefono: '8997608001' } }));
    assert.ok(otro.body.folio, 'nadie pudo volver a usar el cupo devuelto');
  });

  // ═══ DOBLE COBRO ═════════════════════════════════════════════════════════
  await t('10. dos cobros reales sobre el mismo pedido: un solo consumo, una comanda', async () => {
    const id = await promo({ codigo: 'DOBLE', limiteUsos: 1, valor: 65 });
    await conectarClip();
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'DOBLE' }));
    const folio = r.body.folio;

    const clip = await crearEnlace(folio);
    const clipFila = (await pagosDe(folio)).find(x => x.proveedor === 'clip');

    // Y uno de Mercado Pago sobre el mismo pedido.
    const tokenMP = await conectarMP();
    await pool.query(
      `UPDATE pagos SET estado='invalidado', invalidated_at=NOW(),
                        motivo_invalidacion='se abre el intento de MP en la prueba'
        WHERE id=$1`, [clipFila.id]);
    await crearEnlace(folio);
    const mpFila = (await pagosDe(folio)).find(x => x.proveedor === 'mercado_pago');

    // Primero entra el dinero por Mercado Pago.
    PAGOS_MP.set('pay-promo-10', {
      id: 'pay-promo-10', status: 'approved', external_reference: mpFila.referencia_interna,
      transaction_amount: Number(mpFila.monto), currency_id: 'MXN',
    });
    assert.strictEqual(await webhookMP(tokenMP, 'pay-promo-10'), 200);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del cobro de MP');
    assert.strictEqual((await usosDe(id))[0].estado, 'consumida');

    // Y DESPUÉS resulta que el enlace de Clip también se pagó.
    CHECKOUTS.get(clip.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(clipFila.referencia_interna), 200);
    await esperar(async () => (await filaId(clipFila.id)).estado === 'pagado',
      'que el segundo cobro real quede registrado');

    assert.strictEqual((await filaId(clipFila.id)).metadata_sanitizada.anomalia, 'doble_cobro_real');
    assert.strictEqual((await filaId(mpFila.id)).metadata_sanitizada.anomalia, 'doble_cobro_real');
    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `el doble cobro dejó ${usos.length} usos de la promo`);
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      'el segundo cobro se apropió de un segundo cupo');
    assert.strictEqual(await comandasDe(folio), 1, 'el segundo cobro sacó una segunda comanda');
    await conectarClip();
  });

  // ═══ CRASH ANTES Y DESPUÉS DEL SETTLEMENT ════════════════════════════════
  await t('11. crash entre asentar el dinero y derivar: al recuperar, un solo consumo', async () => {
    const id = await promo({ codigo: 'CRASH', limiteUsos: 1, valor: 50 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'CRASH' }));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    const { verificarYAsentarClip, derivarPedidoPorPagoAsentado, reconciliarDerivacionesPendientes } =
      await import('../src/services/webhookPagos.js');

    // Se asienta el dinero y el proceso muere ANTES de derivar: la deuda queda
    // viva y la promoción todavía reservada.
    const asiento = await verificarYAsentarClip({
      pago: await filaId(pago.id), checkoutId: enlace.referenciaExterna });
    assert.strictEqual(asiento.ok, true, JSON.stringify(asiento));
    assert.strictEqual((await filaId(pago.id)).derivacion_pendiente, true, 'no quedó deuda viva');
    assert.strictEqual((await usosDe(id))[0].estado, 'reservada',
      'la promo se consumió fuera de la transición durable');
    assert.strictEqual(await comandasDe(folio), 0);

    // El job de recuperación termina el trabajo.
    await reconciliarDerivacionesPendientes(50);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda recuperada');

    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1);
    assert.strictEqual(usos[0].estado, 'consumida');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);

    // Y recuperar dos veces más no vuelve a consumir nada.
    await derivarPedidoPorPagoAsentado({ pagoId: pago.id, negocioId: NEG, folio });
    await reconciliarDerivacionesPendientes(50);
    assert.strictEqual((await usosDe(id)).length, 1, 'la recuperación consumió dos veces');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
    assert.strictEqual(await comandasDe(folio), 1);
  });

  await t('12. vencer dos veces: el cupo se devuelve una sola vez', async () => {
    const id = await promo({ codigo: 'CRASHEXP', limiteUsos: 1, valor: 50 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'CRASHEXP' }));
    const folio = r.body.folio;
    await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];
    await vencerYa(pago.id);

    const { vencerEsperaDePago } = await import('../src/services/database.js');
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');

    // La liberación es parte de la MISMA transacción que cancela el pedido, así
    // que no hay estado intermedio que recuperar -- y repetirla no devuelve el
    // cupo dos veces.
    const primera = await vencerEsperaDePago(pago.id, NEG);
    assert.strictEqual(primera.ok, true);
    assert.strictEqual(primera.promocionesLiberadas, 1, 'la liberación no ocurrió con el vencimiento');
    assert.strictEqual(Number((await promoDe(id)).usos), 0);
    assert.strictEqual((await usosDe(id)).length, 0);

    await vencerEsperaDePago(pago.id, NEG);
    await expirarPagosVencidos();
    assert.strictEqual(Number((await promoDe(id)).usos), 0,
      'repetir el vencimiento dejó el contador inconsistente');
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  // ═══ TRANSFERENCIA MANUAL ════════════════════════════════════════════════
  await t('13. transferencia confirmada a mano: mismo ciclo, un solo consumo', async () => {
    const id = await promo({ codigo: 'TRANSFER', limiteUsos: 1, valor: 40 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'TRANSFER' }));
    const folio = r.body.folio;
    assert.strictEqual((await usosDe(id))[0].estado, 'reservada');

    const { calcularVersionPedidoHash, confirmarPagoManual } =
      await import('../src/services/database.js');
    const datos = (await pedidoDe(folio)).datos;
    const { rows: [transf] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                          moneda, monto, estado, version_pedido_hash)
       VALUES ($1,$2,'transferencia',$3,'transferencia','MXN',$4,'requiere_revision',$5)
       RETURNING id`,
      [NEG, folio, `transf-${folio}`, Number(datos.total), calcularVersionPedidoHash(datos)]);

    await confirmarPagoManual(NEG, transf.id, SEED.superadminUsuarioId);
    const { derivarPedidoPorPagoAsentado } = await import('../src/services/webhookPagos.js');
    await derivarPedidoPorPagoAsentado({ pagoId: transf.id, negocioId: NEG, folio });
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda de la transferencia');

    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1);
    assert.strictEqual(usos[0].estado, 'consumida',
      'la transferencia manual no cerró el ciclo de la promoción');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);

    // Confirmar dos veces no consume dos veces.
    await confirmarPagoManual(NEG, transf.id, SEED.superadminUsuarioId).catch(() => {});
    await derivarPedidoPorPagoAsentado({ pagoId: transf.id, negocioId: NEG, folio });
    assert.strictEqual((await usosDe(id)).length, 1);
    assert.strictEqual(await comandasDe(folio), 1);
  });

  // ═══ MULTIEMPRESA ════════════════════════════════════════════════════════
  await t('14. dos negocios, el MISMO código: cero escrituras cruzadas', async () => {
    const idA = await promo({ codigo: 'MISMOCODE', limiteUsos: 1, valor: 30, negocioId: NEG });
    const idB = await promo({ codigo: 'MISMOCODE', limiteUsos: 1, valor: 30, negocioId: NEG_B });

    // Reservas a mano en cada negocio, con el MISMO folio a propósito: si
    // alguna operación se olvidara del tenant, se vería aquí.
    const FOLIO = 'PROMO-CRUCE-1';
    for (const [neg, id] of [[NEG, idA], [NEG_B, idB]]) {
      await pool.query(
        `INSERT INTO tienda_promocion_usos (negocio_id, promocion_id, pedido_folio, estado, pedido_version)
         VALUES ($1,$2,$3,'reservada','v1')`, [neg, id, FOLIO]);
      await pool.query(`UPDATE tienda_promociones SET usos = 1 WHERE id=$1`, [id]);
    }

    const { consumirReservasDePedido, liberarReservasDePedido } =
      await import('../src/services/promoReservas.js');

    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const c = await consumirReservasDePedido(cli, { negocioId: NEG, folio: FOLIO, version: 'v1' });
      assert.strictEqual(c.consumidas, 1);
      await cli.query('COMMIT');
    } finally { cli.release(); }

    assert.strictEqual((await usosDe(idA))[0].estado, 'consumida');
    assert.strictEqual((await usosDe(idB))[0].estado, 'reservada',
      '¡el settlement del negocio A consumió la promoción del negocio B!');

    const cli2 = await pool.connect();
    try {
      await cli2.query('BEGIN');
      const l = await liberarReservasDePedido(cli2, { negocioId: NEG_B, folio: FOLIO });
      assert.strictEqual(l.liberadas, 1);
      await cli2.query('COMMIT');
    } finally { cli2.release(); }

    assert.strictEqual((await usosDe(idA)).length, 1,
      '¡el expirador del negocio B borró el uso del negocio A!');
    assert.strictEqual((await usosDe(idA))[0].estado, 'consumida');
    assert.strictEqual((await usosDe(idB)).length, 0);
    assert.strictEqual(Number((await promoDe(idA)).usos), 1, 'el contador de A se movió desde B');
    assert.strictEqual(Number((await promoDe(idB)).usos), 0);

    // Sin tenant no se opera: jamás se deduce.
    const cli3 = await pool.connect();
    try {
      await cli3.query('BEGIN');
      await assert.rejects(() => consumirReservasDePedido(cli3, { negocioId: '', folio: FOLIO }),
        'aceptó consumir sin negocio');
      await assert.rejects(() => liberarReservasDePedido(cli3, { negocioId: null, folio: FOLIO }),
        'aceptó liberar sin negocio');
      await cli3.query('ROLLBACK');
    } finally { cli3.release(); }
  });

  // ═══ RESERVA Y CHECKOUT AMBIGUO ══════════════════════════════════════════
  await t('15. creación ambigua del checkout: la reserva se CONSERVA hasta que venza', async () => {
    // El POST salió, el proveedor pudo haber creado el checkout y la respuesta
    // se perdió. Soltar la promo ahí sería regalar el cupo mientras existe un
    // enlace externo cobrable al precio con descuento.
    const id = await promo({ codigo: 'AMBIGUA', limiteUsos: 1, valor: 50 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'AMBIGUA' }));
    const folio = r.body.folio;
    assert.strictEqual((await usosDe(id))[0].estado, 'reservada');

    process.env.XABOR_PAGOS_FALLA_EN = 'finalizacion_antes_de_commit';
    await assert.rejects(() => crearEnlace(folio), 'la creación debía fallar');
    delete process.env.XABOR_PAGOS_FALLA_EN;

    const pago = (await pagosDe(folio))[0];
    assert.strictEqual(pago.metadata_sanitizada.creacion_ambigua_abierta, true,
      'fixture: la creación debía quedar ambigua');
    // La reserva sigue en pie, y el cupo sigue apartado.
    assert.strictEqual((await usosDe(id)).length, 1, 'se soltó la promo por una respuesta perdida');
    assert.strictEqual((await usosDe(id))[0].estado, 'reservada');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
    const otro = await comprar(carrito(tokenNuevo(), {
      codigo: 'AMBIGUA', cliente: { nombre: 'Otro', telefono: '8997607001' } }));
    assert.notStrictEqual(otro.status, 200,
      `otro cliente se llevó un cupo que sigue apartado por un checkout que puede existir: ${JSON.stringify(otro.body)}`);

    // Cuando la espera de Xabor termina, ahí sí se suelta.
    await vencerYa(pago.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual((await usosDe(id)).length, 0, 'al vencer no se devolvió el cupo');
    assert.strictEqual(Number((await promoDe(id)).usos), 0);
  });

  await t('16. el proceso muere justo tras vencer: pedido y cupo se mueven juntos', async () => {
    // La liberación vive DENTRO de la transacción del vencimiento. Por eso un
    // fallo inmediatamente posterior al COMMIT no puede dejar medio mundo:
    // o el pedido está cancelado y el cupo devuelto, o nada de lo dos.
    const id = await promo({ codigo: 'ATOMICO', limiteUsos: 1, valor: 50 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'ATOMICO' }));
    const folio = r.body.folio;
    await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];
    await vencerYa(pago.id);

    const { vencerEsperaDePago } = await import('../src/services/database.js');
    process.env.XABOR_PAGOS_FALLA_EN = 'expiracion_tras_commit';
    await assert.rejects(() => vencerEsperaDePago(pago.id, NEG), 'el fallo inyectado no se propagó');
    delete process.env.XABOR_PAGOS_FALLA_EN;

    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado',
      'fixture: el vencimiento sí había hecho COMMIT');
    assert.strictEqual((await usosDe(id)).length, 0,
      'el pedido quedó cancelado y el cupón apartado por nadie');
    assert.strictEqual(Number((await promoDe(id)).usos), 0,
      'el contador no se movió junto con la cancelación');

    // Y otro cliente sí puede tomarlo, que es la prueba de que volvió al pozo.
    const otro = await comprarOk(carrito(tokenNuevo(), {
      codigo: 'ATOMICO', cliente: { nombre: 'Otro', telefono: '8997609001' } }));
    assert.ok(otro.body.folio);
  });

  // ═══ P0-1: NINGUNA RESERVA SIN RECLAMAR EL CUPO ══════════════════════════
  await t('17. reserva sin fila provisional: se reclama el cupo o no hay reserva', async () => {
    const { registrarUsosPromociones } = await import('../src/services/tiendaPromociones.js');
    const id = await promo({ codigo: 'RECLAMO', limiteUsos: 1, valor: 50 });
    const aplicadas = [{ id, campaniaId: null, nombre: 'Promo RECLAMO', descuento: 50 }];

    // La reserva provisional NO existe: el token no corresponde a ninguna. Es
    // el camino de respaldo, y por ahí es por donde se colaba una reserva que
    // no contaba contra el límite.
    const r1 = await registrarUsosPromociones({
      negocioId: NEG, folio: 'PROMO-P01-A', aplicadas, telefono: '8997610001',
      estadoFinal: 'reservada', pedidoVersion: 'v1', checkoutToken: 'no-existe-1',
    });
    assert.strictEqual(r1.registrados, 1);
    const usos1 = await usosDe(id);
    assert.strictEqual(usos1.length, 1);
    assert.strictEqual(usos1[0].estado, 'reservada');
    assert.strictEqual(Number((await promoDe(id)).usos), 1,
      'la reserva de respaldo entró SIN contar contra el límite');

    // Y con el cupo ya tomado, el respaldo falla cerrado: ni fila, ni contador
    // por encima del límite.
    await assert.rejects(
      () => registrarUsosPromociones({
        negocioId: NEG, folio: 'PROMO-P01-B', aplicadas, telefono: '8997610002',
        estadoFinal: 'reservada', pedidoVersion: 'v1', checkoutToken: 'no-existe-2',
      }),
      e => e.codigo === 'CUPO_AGOTADO',
      'el respaldo aceptó una segunda reserva sobre un cupón de 1 uso');

    assert.strictEqual((await usosDe(id)).length, 1,
      `quedaron ${(await usosDe(id)).length} filas para un cupón de 1 uso`);
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
  });

  await t('18. 20 recuperaciones simultáneas por el hueco: una sola reserva contada', async () => {
    const { registrarUsosPromociones } = await import('../src/services/tiendaPromociones.js');
    const id = await promo({ codigo: 'HUECO', limiteUsos: 1, valor: 50 });
    const aplicadas = [{ id, campaniaId: null, nombre: 'Promo HUECO', descuento: 50 }];

    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      registrarUsosPromociones({
        negocioId: NEG, folio: `PROMO-P01-C${i}`, aplicadas, telefono: `899761100${i % 10}`,
        estadoFinal: 'reservada', pedidoVersion: 'v1', checkoutToken: `no-existe-c${i}`,
      })));
    const ok = res.filter(x => x.status === 'fulfilled' && x.value.registrados === 1);

    assert.strictEqual(ok.length, 1,
      `${ok.length} recuperaciones se llevaron un cupón de 1 uso por el camino de respaldo`);
    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `quedaron ${usos.length} filas para un cupo de 1`);
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
  });

  await t('19. INVARIANTE: reservas + consumidas nunca supera el contador de ninguna promo',
    async () => {
      // Barrido sobre TODO lo que dejaron los casos anteriores. Si alguna puerta
      // hubiera creado una fila sin contarla, aquí se vería.
      const { rows } = await pool.query(
        `SELECT p.id, p.limite_usos, p.usos,
                (SELECT COUNT(*)::int FROM tienda_promocion_usos u
                  WHERE u.negocio_id = p.negocio_id AND u.promocion_id = p.id) AS filas
           FROM tienda_promociones p WHERE p.negocio_id = $1`, [NEG]);
      for (const r of rows) {
        assert.ok(Number(r.filas) <= Number(r.usos),
          `promo ${r.id}: ${r.filas} filas de uso contra un contador de ${r.usos}`);
        if (r.limite_usos != null) {
          assert.ok(Number(r.filas) <= Number(r.limite_usos),
            `promo ${r.id}: ${r.filas} usos sobre un límite de ${r.limite_usos}`);
        }
      }
    });

  // ═══ P0-2: PRIMERA COMPRA ES PRIMERA COMPRA REAL ═════════════════════════
  await t('20. no pagar no te convierte en cliente viejo', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, solo_primera_compra,
          canales, activa)
       VALUES ($1,'Bienvenida','monto_fijo','PRIMERA',FALSE,50,TRUE,
               '["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    // Telefono unico por corrida: el seed y las suites hermanas dejan clientes
    // con numeros fijos, y "cliente nuevo" tiene que significar nuevo de verdad.
    const TEL = `8996${String(Date.now()).slice(-6)}`;
    const cli = (nombre) => ({ nombre, telefono: TEL });
    const { clienteYaComproDeVerdad } = await import('../src/services/tiendaPromociones.js');
    assert.strictEqual(await clienteYaComproDeVerdad(NEG, TEL), false,
      'fixture: este teléfono no debía tener compras previas');

    // Primer intento: es cliente nuevo, la promo aplica.
    const r1 = await comprarOk(carrito(tokenNuevo(), { codigo: 'PRIMERA', cliente: cli('Nuevo') }));
    const folio1 = r1.body.folio;
    assert.strictEqual((await usosDe(p.id))[0].estado, 'reservada');

    // No paga: vence, y la reserva se libera.
    await crearEnlace(folio1);
    await vencerYa((await pagosDe(folio1))[0].id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual((await usosDe(p.id)).length, 0, 'la reserva no se liberó');

    // Y vuelve a intentar: devolvimos el cupo, así que también la elegibilidad.
    const r2 = await comprarOk(carrito(tokenNuevo(), { codigo: 'PRIMERA', cliente: cli('Nuevo') }));
    const folio2 = r2.body.folio;
    assert.strictEqual(Number((await pedidoDe(folio2)).datos.descuento), 50,
      'un cliente que nunca compró perdió su promoción de primera compra');

    // Ahora sí paga: ya es cliente.
    const e2 = await crearEnlace(folio2);
    CHECKOUTS.get(e2.referenciaExterna).estado = 'COMPLETED';
    await webhookClip((await pagosDe(folio2))[0].referencia_interna);
    await esperar(async () => await comandasDe(folio2) === 1, 'la comanda de la primera compra real');
    assert.strictEqual((await usosDe(p.id))[0].estado, 'consumida');

    // Y a partir de aquí ya NO es primerizo.
    const r3 = await comprar(carrito(tokenNuevo(), { codigo: 'PRIMERA', cliente: cli('Nuevo') }));
    assert.notStrictEqual(r3.status, 200,
      `un cliente que ya compró volvió a usar la promo de primera compra: ${JSON.stringify(r3.body)}`);
  });

  await t('21. el histórico archivado también cuenta como compra previa', async () => {
    // `pedidos_activos` se limpia; `pedidos` es el archivo. Un cliente de hace
    // meses no puede volverse primerizo porque su pedido dejó de estar activo.
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, solo_primera_compra,
          canales, activa)
       VALUES ($1,'Bienvenida 2','monto_fijo','PRIMERA2',FALSE,50,TRUE,
               '["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    const TEL = `8995${String(Date.now()).slice(-6)}`;
    const { clienteYaComproDeVerdad } = await import('../src/services/tiendaPromociones.js');
    assert.strictEqual(await clienteYaComproDeVerdad(NEG, TEL), false);

    // `pedidos.telefono` referencia `clientes`: el archivo histórico no existe
    // sin el cliente detrás.
    await pool.query(
      `INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Viejo',$2)
       ON CONFLICT DO NOTHING`, [TEL, NEG]);
    await pool.query(
      `INSERT INTO pedidos (folio, telefono, nombre_cliente, items, total, modalidad,
                            canal, forma_pago, negocio_id)
       VALUES ($1,$2,'Viejo','[]'::jsonb,300,'recoger','tienda_online','efectivo',$3)`,
      [`ARCH-${TEL}`, TEL, NEG]);

    assert.strictEqual(await clienteYaComproDeVerdad(NEG, TEL), true,
      'el histórico archivado dejó de contar como compra previa');
    const r = await comprar(carrito(tokenNuevo(), {
      codigo: 'PRIMERA2', cliente: { nombre: 'Viejo', telefono: TEL } }));
    assert.notStrictEqual(r.status, 200,
      'un cliente con compras archivadas pasó por primerizo');

    // Y jamás cruza de negocio.
    assert.strictEqual(await clienteYaComproDeVerdad(NEG_B, TEL), false,
      'la compra de un negocio hizo viejo al cliente en otro');
    await pool.query(`DELETE FROM pedidos WHERE folio = $1`, [`ARCH-${TEL}`]);
    await pool.query(`DELETE FROM clientes WHERE telefono=$1 AND negocio_id=$2`, [TEL, NEG]);
    void p;
  });

  // ═══ P0-3: CAMBIO DE VERSIÓN + PROMO, DE VERDAD ══════════════════════════
  await t('22. v1 → v2: la reserva se supersede, v2 reserva de nuevo, paga y consume UNA vez',
    async () => {
      const id = await promo({ codigo: 'V2OK', limiteUsos: 1, valor: 30 });
      const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'V2OK' }));
      const folio = r.body.folio;
      const reservaV1 = (await usosDe(id))[0];
      assert.strictEqual(reservaV1.estado, 'reservada');
      const versionV1 = reservaV1.pedido_version;

      // El pedido cambia: otro total (la promo de monto fijo sigue aplicando).
      await pool.query(
        `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','450'::jsonb)
          WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

      // Crear el checkout de v2 resincroniza la reserva ANTES de cobrar nada.
      const enlace = await crearEnlace(folio);
      assert.ok(enlace.url, 'no se creó el checkout de la versión nueva');

      const usos = await usosDe(id);
      assert.strictEqual(usos.length, 1, `quedaron ${usos.length} reservas para el mismo pedido`);
      assert.strictEqual(usos[0].estado, 'reservada');
      assert.notStrictEqual(usos[0].pedido_version, versionV1,
        'la reserva se quedó anclada a la versión vieja');
      assert.strictEqual(Number((await promoDe(id)).usos), 1,
        'resincronizar consumió un segundo cupo de un cupón de 1 uso');

      // Y v2 se paga: consumo exacto y una sola comanda.
      const pago = (await pagosDe(folio)).find(x => x.estado !== 'invalidado');
      CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
      assert.strictEqual(await webhookClip(pago.referencia_interna), 200);
      await esperar(async () => await comandasDe(folio) === 1, 'la comanda de la v2');

      const finales = await usosDe(id);
      assert.strictEqual(finales.length, 1);
      assert.strictEqual(finales[0].estado, 'consumida');
      assert.strictEqual(Number((await promoDe(id)).usos), 1);
      assert.strictEqual(await comandasDe(folio), 1, 'salió más de una comanda');
    });

  await t('23. si la promo ya no aplica a v2: no hay checkout, y el cupo vuelve al pozo',
    async () => {
      // Promo con mínimo de compra: al bajar el pedido por debajo, deja de
      // aplicar. Cobrar el total con el descuento viejo sería regalar dinero.
      const { rows: [p] } = await pool.query(
        `INSERT INTO tienda_promociones
           (negocio_id, nombre, tipo, codigo, automatica, valor, minimo_compra,
            limite_usos, canales, activa)
         VALUES ($1,'Minimo','monto_fijo','MINIMO',FALSE,30,200,1,
                 '["tienda_online"]'::jsonb,TRUE)
         RETURNING id`, [NEG]);

      const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'MINIMO' }));
      const folio = r.body.folio;
      assert.strictEqual((await usosDe(p.id)).length, 1);
      assert.strictEqual(Number((await promoDe(p.id)).usos), 1);

      // El pedido se recorta por debajo del mínimo.
      await pool.query(
        `UPDATE pedidos_activos
            SET datos = jsonb_set(jsonb_set(datos,'{total}','20'::jsonb),'{subtotal}','50'::jsonb)
          WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

      await assert.rejects(() => crearEnlace(folio),
        e => /promocion ya no aplica|promoci..n ya no aplica/i.test(e.message),
        'se creó un checkout con un total que llevaba un descuento ya inválido');

      assert.strictEqual((await usosDe(p.id)).length, 0,
        'la reserva de una versión muerta se quedó bloqueando el cupo');
      assert.strictEqual(Number((await promoDe(p.id)).usos), 0, 'el cupo no volvió al pozo');
      assert.strictEqual(await comandasDe(folio), 0, 'cocinó un pedido sin cobrar');

      // Y otro cliente sí puede usar ese cupón liberado.
      const otro = await comprarOk(carrito(tokenNuevo(), {
        codigo: 'MINIMO', cliente: { nombre: 'Otro', telefono: '8997614001' } }));
      assert.ok(otro.body.folio);
    });

  await t('24. pago TARDÍO de v1 con v2 ya reservada: no toca la reserva de v2', async () => {
    const id = await promo({ codigo: 'TARDIOV1', limiteUsos: 1, valor: 30 });
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'TARDIOV1' }));
    const folio = r.body.folio;

    // Checkout de la v1.
    const enlaceV1 = await crearEnlace(folio);
    const pagoV1 = (await pagosDe(folio))[0];

    // El pedido cambia y se abre el checkout de la v2: la reserva pasa a v2.
    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','480'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
    await crearEnlace(folio);
    const reservaV2 = (await usosDe(id))[0];
    assert.strictEqual(reservaV2.estado, 'reservada');

    // Y AHORA paga el enlace viejo de la v1.
    CHECKOUTS.get(enlaceV1.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(pagoV1.referencia_interna), 200);
    await esperar(async () => (await filaId(pagoV1.id)).estado === 'pagado',
      'que el dinero de la v1 quede asentado');

    const finalV1 = await filaId(pagoV1.id);
    assert.strictEqual(finalV1.estado, 'pagado', 'se repudió dinero real de la v1');
    assert.strictEqual(finalV1.metadata_sanitizada.anomalia, 'version_desfasada');
    assert.strictEqual(finalV1.derivacion_pendiente, false);

    // La reserva de la v2 sigue exactamente donde estaba: ni consumida por un
    // cobro que no le corresponde, ni liberada por accidente.
    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1, `la reserva de v2 quedó en ${usos.length} filas`);
    assert.strictEqual(usos[0].id, reservaV2.id, 'se cambió la reserva de la v2');
    assert.strictEqual(usos[0].estado, 'reservada',
      'el pago tardío de la v1 consumió la reserva de la v2');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
    assert.strictEqual(await comandasDe(folio), 0, 'cocinó una versión que nadie pagó');
  });

  // ═══ P1: MÉTRICAS ════════════════════════════════════════════════════════
  await t('25. el backoffice no cuenta una reserva como venta', async () => {
    const { listarPromociones, listarCampanas } = await import('../src/services/tiendaPromociones.js');
    const { rows: [camp] } = await pool.query(
      `INSERT INTO tienda_campanas (negocio_id, nombre, influencer, activa)
       VALUES ($1,'Campania metricas','@alguien',TRUE) RETURNING id`, [NEG]);
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, campania_id, nombre, tipo, codigo, automatica, valor, canales, activa)
       VALUES ($1,$2,'Metricas','monto_fijo','METRICA',FALSE,40,'["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG, camp.id]);

    // Una reserva viva (checkout sin pagar) y un uso consumido de verdad.
    await pool.query(
      `INSERT INTO tienda_promocion_usos
         (negocio_id, promocion_id, campania_id, pedido_folio, cliente_telefono,
          monto_descuento, monto_venta, cliente_nuevo, estado)
       VALUES ($1,$2,$3,'MET-RESERVADA','8997615001',40,500,TRUE,'reservada'),
              ($1,$2,$3,'MET-CONSUMIDA','8997615002',40,700,TRUE,'consumida')`,
      [NEG, p.id, camp.id]);
    await pool.query(`UPDATE tienda_promociones SET usos = 2 WHERE id=$1`, [p.id]);

    const fila = (await listarPromociones(NEG)).find(x => x.id === p.id);
    assert.strictEqual(fila.metricas.usos, 1,
      'una reserva sin pagar se contó como uso real de la promoción');
    assert.strictEqual(fila.metricas.ventas, 700,
      'una reserva sin pagar se contó como venta generada');
    assert.strictEqual(fila.metricas.descuento, 40,
      'se reportó descuento otorgado por un cupón que nadie pagó');
    assert.strictEqual(fila.metricas.clientesNuevos, 1);
    assert.strictEqual(fila.metricas.reservasActivas, 1,
      'las reservas vivas no se reportan por separado');
    assert.strictEqual(fila.metricas.ticketPromedio, 700);

    const campania = (await listarCampanas(NEG)).find(x => x.id === camp.id);
    assert.strictEqual(campania.metricas.usos, 1, 'la campaña contó la reserva como uso');
    assert.strictEqual(campania.metricas.ventas, 700, 'la campaña contó la reserva como venta');

    await pool.query(`DELETE FROM tienda_promocion_usos WHERE promocion_id=$1`, [p.id]);
    await pool.query(`DELETE FROM tienda_promociones WHERE id=$1`, [p.id]);
    await pool.query(`DELETE FROM tienda_campanas WHERE id=$1`, [camp.id]);
  });

  // ═══ P0-4: LA BARRERA DE RECÁLCULO ES DURABLE ════════════════════════════
  await t('26. promo inválida en v2: los 5 reintentos siguientes tampoco cobran', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, minimo_compra,
          limite_usos, canales, activa)
       VALUES ($1,'Minimo retry','monto_fijo','MINRETRY',FALSE,30,200,1,
               '["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);

    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'MINRETRY' }));
    const folio = r.body.folio;
    assert.strictEqual((await usosDe(p.id)).length, 1);
    const antes = checkoutsClip;

    // El pedido cae por debajo del mínimo: la promo deja de aplicar.
    await pool.query(
      `UPDATE pedidos_activos
          SET datos = jsonb_set(jsonb_set(datos,'{total}','20'::jsonb),'{subtotal}','50'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    await assert.rejects(() => crearEnlace(folio), /ya no aplica|recalcular/i,
      'el primer intento debía fallar');
    assert.strictEqual((await usosDe(p.id)).length, 0, 'el cupo no volvió al pozo');
    assert.strictEqual(Number((await promoDe(p.id)).usos), 0);

    // Y la barrera queda ESCRITA en el pedido, no solo en la respuesta.
    const marcado = await pedidoDe(folio);
    assert.strictEqual(marcado.datos.tienda.promocion_recalculo_pendiente, true,
      'no quedó constancia durable de que el precio del pedido dejó de ser válido');
    assert.ok(marcado.datos.tienda.promocion_recalculo_motivo);

    // Los reintentos NO pueden colarse por el hueco: ya no hay reserva que
    // resincronizar, pero el total sigue llevando el descuento viejo.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => crearEnlace(folio), /ya no aplica|recalcular/i,
        `el reintento ${i + 1} creó un cobro con el descuento viejo`);
    }
    assert.strictEqual(checkoutsClip - antes, 0,
      `POST al proveedor tras perder la promoción = ${checkoutsClip - antes}; debía ser 0`);
    assert.strictEqual((await pagosDe(folio)).filter(x => x.url).length, 0,
      'quedó un checkout creado sobre un precio inválido');
  });

  await t('27. sólo un RECÁLCULO server-side real levanta la barrera', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, minimo_compra,
          limite_usos, canales, activa)
       VALUES ($1,'Minimo recalculo','monto_fijo','MINRECALC',FALSE,30,200,1,
               '["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    const r = await comprarOk(carrito(tokenNuevo(), { codigo: 'MINRECALC' }));
    const folio = r.body.folio;

    await pool.query(
      `UPDATE pedidos_activos
          SET datos = jsonb_set(jsonb_set(datos,'{total}','20'::jsonb),'{subtotal}','50'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
    await assert.rejects(() => crearEnlace(folio));

    const { recalcularPromocionesDelPedido } = await import('../src/services/tiendaPromociones.js');
    const rec = await recalcularPromocionesDelPedido(NEG, folio);
    assert.strictEqual(rec.ok, true, JSON.stringify(rec));

    // El servidor recalculó: sin promoción (no llega al mínimo) y con el total
    // que de verdad corresponde -- no el que traía con el descuento viejo.
    const ped = await pedidoDe(folio);
    assert.notStrictEqual(ped.datos.tienda.promocion_recalculo_pendiente, true,
      'la barrera siguió puesta tras un recálculo real');
    assert.strictEqual(Number(ped.datos.descuento), 0, 'se conservó el descuento inválido');
    assert.strictEqual(Number(ped.datos.total), 50, 'el total no se recalculó server-side');
    assert.strictEqual(ped.datos.tienda.promociones.length, 0);

    // Y ahora sí se puede cobrar.
    const enlace = await crearEnlace(folio);
    assert.ok(enlace.url, 'tras recalcular seguía sin poder cobrarse');
    assert.strictEqual(Number((await pagosDe(folio))[0].monto), 50,
      'se cobró un monto distinto al recalculado');
    assert.strictEqual(Number((await promoDe(p.id)).usos), 0, 'el cupo no quedó libre');
  });

  // ═══ P0-5: LA ATRIBUCIÓN CRÍTICA NO SE TRAGA NADA ════════════════════════
  for (const frontera of [
    'atribucion_tras_begin',
    'atribucion_tras_convertir',
    'atribucion_tras_insert',
    'atribucion_tras_reclamar',
    'atribucion_antes_de_commit',
  ]) {
    await t(`28[${frontera}]: rollback coherente y el error SÍ se propaga`, async () => {
      const { registrarUsosPromociones } = await import('../src/services/tiendaPromociones.js');
      const id = await promo({ codigo: `FR-${frontera.slice(11, 17)}`, limiteUsos: 1, valor: 40 });
      const aplicadas = [{ id, campaniaId: null, nombre: 'Frontera', descuento: 40 }];
      const folio = `PROMO-FR-${frontera.slice(11, 17)}`;
      const TOKEN = `tok-fr-${frontera.slice(11, 17)}`;

      // La frontera "tras convertir" solo se alcanza si existe la reserva
      // provisional: sin ella el flujo se va por el respaldo y la inyección
      // nunca dispararía -- un verde que no probaría nada.
      const conReserva = frontera === 'atribucion_tras_convertir';
      if (conReserva) {
        await pool.query(
          `INSERT INTO tienda_promocion_usos
             (negocio_id, promocion_id, pedido_folio, cliente_telefono, estado)
           VALUES ($1,$2,$3,'8997620001','reservada')`, [NEG, id, `reserva:${TOKEN}`]);
        await pool.query(`UPDATE tienda_promociones SET usos = 1 WHERE id=$1`, [id]);
      }
      const usosEsperadosTrasFallo = conReserva ? 1 : 0;

      process.env.XABOR_TIENDA_FALLA_EN = frontera;
      try {
        await assert.rejects(
          () => registrarUsosPromociones({
            negocioId: NEG, folio, aplicadas, telefono: '8997620001',
            estadoFinal: 'reservada', pedidoVersion: 'v1', checkoutToken: TOKEN,
          }),
          'la atribución se tragó el fallo y volvió como si hubiera funcionado');
      } finally {
        // En `finally`: si el assert falla, la inyección no puede quedarse
        // encendida contaminando los casos siguientes.
        delete process.env.XABOR_TIENDA_FALLA_EN;
      }

      // Rollback completo: la transacción no dejó NADA nuevo. Lo que existía
      // antes (la reserva provisional, ya contada) sigue exactamente igual.
      const tras = await usosDe(id);
      assert.strictEqual(tras.length, usosEsperadosTrasFallo,
        `quedaron ${tras.length} filas de uso tras fallar en '${frontera}'`);
      if (conReserva) {
        assert.ok(tras[0].pedido_folio.startsWith('reserva:'),
          'el rollback no devolvió la reserva a su folio provisional');
      }
      assert.strictEqual(Number((await promoDe(id)).usos), usosEsperadosTrasFallo,
        `el contador se movió pese al rollback en '${frontera}'`);

      // Y el reintento, ya sin fallo, sí registra -- una sola vez.
      const ok = await registrarUsosPromociones({
        negocioId: NEG, folio, aplicadas, telefono: '8997620001',
        estadoFinal: 'reservada', pedidoVersion: 'v1', checkoutToken: TOKEN,
      });
      assert.strictEqual(ok.registrados, 1);
      assert.strictEqual((await usosDe(id)).length, 1);
      assert.strictEqual((await usosDe(id))[0].estado, 'reservada');
      assert.strictEqual(Number((await promoDe(id)).usos), 1);
    });
  }

  await t('29. checkout ONLINE con la atribución rota: ni éxito, ni derivación marcada', async () => {
    const id = await promo({ codigo: 'ATRIBONLINE', limiteUsos: 1, valor: 40 });
    const srvRoto = await arrancarServidor({
      PORT: String(PUERTO_ROTO), XABOR_RUTAS_PRUEBA: '1',
      XABOR_TIENDA_LIMITE_CHECKOUT: '2000', XABOR_TIENDA_LIMITE_LECTURA: '5000',
      XABOR_TIENDA_FALLA_EN: 'atribucion_antes_de_commit',
      CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
      XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
      XABOR_URL_PUBLICA: `http://localhost:${PUERTO_ROTO}`,
    }, { timeoutMs: 90000 });
    try {
      const tk = tokenNuevo();
      const r = await fetch(`http://localhost:${PUERTO_ROTO}/api/tienda/${SLUG}/checkout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(carrito(tk, { codigo: 'ATRIBONLINE' })),
      }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));

      assert.notStrictEqual(r.status, 200,
        'el checkout respondió ÉXITO con la atribución de la promoción rota');

      // El pedido SÍ existe (es durable desde antes) pero la derivación de
      // atribución NO puede quedar marcada como hecha.
      const { rows: [tp] } = await pool.query(
        `SELECT pedido_folio, estado FROM tienda_pedidos
          WHERE negocio_id=$1 AND checkout_token=$2`, [NEG, tk]);
      assert.ok(tp?.pedido_folio, 'fixture: el pedido debía haberse creado');
      const { rows: [d] } = await pool.query(
        `SELECT jsonb_exists(derivaciones, 'atribucion') AS hecha FROM tienda_pedidos
          WHERE negocio_id=$1 AND checkout_token=$2`, [NEG, tk]);
      assert.notStrictEqual(d?.hecha, true,
        '¡la atribución quedó marcada como HECHA tras un ROLLBACK: nadie volvería a intentarla!');
      // La reserva provisional del checkout SI existe y esta contada: la tomo
      // el paso anterior, con su barrera de cupo, y es correcta. Lo que no
      // puede haber es una fila atada al folio como si la atribucion hubiera
      // ocurrido.
      const filas = await usosDe(id);
      assert.strictEqual(filas.length, 1, `quedaron ${filas.length} filas de uso`);
      assert.ok(filas[0].pedido_folio.startsWith('reserva:'),
        'la atribución dejó la fila atada al folio pese al ROLLBACK');
      assert.strictEqual(filas[0].estado, 'reservada');
      assert.strictEqual(Number((await promoDe(id)).usos), 1,
        'el contador no cuadra con la reserva provisional');
    } finally {
      try { await srvRoto.detener(); } catch { /* ya estaba abajo */ }
    }
  });

  // ═══ EL RECICLADOR GANA ANTES DEL RETRY ══════════════════════════════════
  for (const modo of [
    { nombre: 'PAGO ONLINE', estadoFinal: 'reservada', esperado: 'reservada' },
    { nombre: 'EFECTIVO', estadoFinal: 'consumida', esperado: 'consumida' },
  ]) {
    await t(`30[${modo.nombre}]: el reciclador ató la fila al folio antes del retry`, async () => {
      // El reciclador convierte `reserva:<token>` en el folio real sin decidir
      // si el pedido ya vale por sí mismo. Si el retry se limitara a un
      // ON CONFLICT DO NOTHING, la promoción de un pedido de efectivo quedaría
      // eternamente 'reservada' -- y nadie la consumiría nunca, porque el
      // consumo vive en la transición financiera que ese pedido no tiene.
      const { registrarUsosPromociones } = await import('../src/services/tiendaPromociones.js');
      const id = await promo({ codigo: `RECICLA${modo.estadoFinal.slice(0, 3)}`, limiteUsos: 1, valor: 40 });
      const folio = `PROMO-RECICLA-${modo.estadoFinal.slice(0, 3)}`;
      const TOKEN = `tok-recicla-${modo.estadoFinal}`;

      // 1) Reserva provisional, contada.
      await pool.query(
        `INSERT INTO tienda_promocion_usos
           (negocio_id, promocion_id, pedido_folio, cliente_telefono, estado)
         VALUES ($1,$2,$3,'8997621001','reservada')`, [NEG, id, `reserva:${TOKEN}`]);
      await pool.query(`UPDATE tienda_promociones SET usos = 1 WHERE id=$1`, [id]);

      // 2) El reciclador la ata al folio real (así de exacto lo hace hoy).
      await pool.query(
        `UPDATE tienda_promocion_usos SET pedido_folio = $3
          WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$4`,
        [NEG, id, folio, `reserva:${TOKEN}`]);

      // 3) Y AHORA llega el retry del checkout.
      const r = await registrarUsosPromociones({
        negocioId: NEG, folio, aplicadas: [{ id, campaniaId: null, nombre: 'R', descuento: 40 }],
        telefono: '8997621001', montoVenta: 300, estadoFinal: modo.estadoFinal,
        pedidoVersion: 'v1', checkoutToken: TOKEN,
      });
      assert.strictEqual(r.registrados, 1, 'el retry ignoró una fila que tenía que reconciliar');

      const usos = await usosDe(id);
      assert.strictEqual(usos.length, 1, `quedaron ${usos.length} filas para un cupo de 1`);
      assert.strictEqual(usos[0].estado, modo.esperado,
        `la fila quedó '${usos[0].estado}' en vez de '${modo.esperado}'`);
      assert.strictEqual(Number(usos[0].monto_venta), 300, 'no se reconciliaron los montos');
      assert.strictEqual(usos[0].pedido_version, 'v1');
      if (modo.esperado === 'consumida') {
        assert.ok(usos[0].consumida_at, 'una consumida sin fecha de consumo');
      }
      // El cupo NO se vuelve a contar: esa fila ya estaba contada.
      assert.strictEqual(Number((await promoDe(id)).usos), 1,
        'reconciliar volvió a reclamar un cupo que ya estaba tomado');
    });
  }

  await t('31. una promoción ya CONSUMIDA no retrocede a reservada', async () => {
    const { registrarUsosPromociones } = await import('../src/services/tiendaPromociones.js');
    const id = await promo({ codigo: 'NORETRO', limiteUsos: 1, valor: 40 });
    const folio = 'PROMO-NORETRO';
    await pool.query(
      `INSERT INTO tienda_promocion_usos
         (negocio_id, promocion_id, pedido_folio, cliente_telefono, estado, consumida_at)
       VALUES ($1,$2,$3,'8997622001','consumida',NOW())`, [NEG, id, folio]);
    await pool.query(`UPDATE tienda_promociones SET usos = 1 WHERE id=$1`, [id]);

    // Un retry tardío del checkout, que cree que el pedido sigue esperando pago.
    await registrarUsosPromociones({
      negocioId: NEG, folio, aplicadas: [{ id, campaniaId: null, nombre: 'N', descuento: 40 }],
      telefono: '8997622001', estadoFinal: 'reservada', pedidoVersion: 'v1',
      checkoutToken: 'tok-tardio',
    });

    const usos = await usosDe(id);
    assert.strictEqual(usos.length, 1);
    assert.strictEqual(usos[0].estado, 'consumida',
      '¡una promoción con dinero detrás volvió a estado reservada: el expirador la devolvería!');
    assert.strictEqual(Number((await promoDe(id)).usos), 1);
  });

  // ═══ P0-6: EL PRECIO SALE DEL CONJUNTO REALMENTE RESERVADO ═══════════════
  //
  // `calcularPromociones` dice cuáles SERÍAN aplicables; el cupo lo decide la
  // base, una por una. Si otro cliente se lleva el último justo antes del
  // reclamo, nada del precio puede seguir saliendo del cálculo previo.

  /** Pedido a domicilio con envío real, listo para recalcular. */
  async function pedidoDomicilio(folio, { subtotal, envio, descuento, promos = [], envioGratis = false }) {
    const total = Math.max(0, subtotal - descuento + (envioGratis ? 0 : envio));
    await pool.query(
      `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
       VALUES ($1,$2,'pendiente_pago',$3)
       ON CONFLICT (folio) DO UPDATE SET estado='pendiente_pago', datos=$3`,
      [folio, NEG, JSON.stringify({
        id: folio, negocioId: NEG, canal: 'tienda_online', estado: 'pendiente_pago',
        modalidad: 'domicilio', forma_pago: 'enlace de pago', pago_confirmado: false,
        subtotal, descuento, costo_envio: envio, total,
        cliente: { nombre: 'Cliente carrera', telefono: '8997630001' },
        items: [{ nombre: 'Producto', cantidad: 1, precio_unitario: subtotal }],
        tienda: { promociones: promos, envio_gratis: envioGratis, envio_base: envio },
        timestamp: new Date().toISOString(),
      })]);
    return total;
  }

  /** Lanza el recálculo y, en plena ventana, deja que B se lleve el cupo. */
  async function recalculoConCarrera(folio, robar) {
    const { recalcularPromocionesDelPedido } = await import('../src/services/tiendaPromociones.js');
    process.env.XABOR_TIENDA_RETARDO_EN = 'recalculo_antes_de_reclamar';
    process.env.XABOR_TIENDA_RETARDO_MS = '600';
    try {
      const corriendo = recalcularPromocionesDelPedido(NEG, folio);
      await new Promise(r => setTimeout(r, 250));
      await robar();                       // B se lleva el último cupo
      return await corriendo;
    } finally {
      delete process.env.XABOR_TIENDA_RETARDO_EN;
      delete process.env.XABOR_TIENDA_RETARDO_MS;
    }
  }

  /** Toma el último cupo como lo haría cualquier otro checkout. */
  const robarCupo = (id, folioB) => async () => {
    const { rowCount } = await pool.query(
      `UPDATE tienda_promociones SET usos = usos + 1, updated_at = NOW()
        WHERE id = $1 AND negocio_id = $2 AND (limite_usos IS NULL OR usos < limite_usos)`,
      [id, NEG]);
    assert.strictEqual(rowCount, 1, 'fixture: B no pudo llevarse el cupo');
    await pool.query(
      `INSERT INTO tienda_promocion_usos (negocio_id, promocion_id, pedido_folio, estado)
       VALUES ($1,$2,$3,'reservada')`, [NEG, id, folioB]);
  };

  await t('32. ENVÍO GRATIS: B se lleva el último cupo en plena ventana; A paga su envío',
    async () => {
      const { rows: [p] } = await pool.query(
        `INSERT INTO tienda_promociones
           (negocio_id, nombre, tipo, codigo, automatica, valor, limite_usos,
            canales, modalidades, activa)
         VALUES ($1,'Envio gratis carrera','envio_gratis',NULL,TRUE,0,1,
                 '["tienda_online"]'::jsonb,'["domicilio"]'::jsonb,TRUE)
         RETURNING id`, [NEG]);

      const folio = 'PROMO-CARR-ENV';
      // A llega con el envío ya regalado por la versión anterior.
      await pedidoDomicilio(folio, {
        subtotal: 400, envio: 60, descuento: 0, envioGratis: true,
        promos: [{ id: p.id, nombre: 'Envio gratis carrera', tipo: 'envio_gratis', descuento: 0, envio_gratis: true }],
      });

      const r = await recalculoConCarrera(folio, robarCupo(p.id, 'PROMO-CARR-ENV-B'));
      assert.strictEqual(r.ok, true, JSON.stringify(r));

      // A NO obtiene envío gratis.
      assert.strictEqual(r.envioGratis, false, 'A se quedó con un envío gratis que perdió');
      assert.strictEqual(r.envio, 60, 'no se le cobró el envío a A');
      assert.strictEqual(r.total, 460, `total ${r.total}: debía ser 400 + 60 de envío`);
      assert.strictEqual(r.ahorro, 0, 'el ahorro siguió contando un envío gratis que no se dio');
      assert.deepStrictEqual(r.promociones, [], 'quedó una promoción que no se pudo reclamar');
      assert.deepStrictEqual(r.perdidas, [p.id]);

      // Ni una reserva falsa: el cupo es de B.
      const usos = await usosDe(p.id);
      assert.strictEqual(usos.length, 1, `quedaron ${usos.length} reservas para un cupo de 1`);
      assert.strictEqual(usos[0].pedido_folio, 'PROMO-CARR-ENV-B', 'la reserva se le atribuyó a A');
      assert.strictEqual(Number((await promoDe(p.id)).usos), 1);

      // Y el pedido queda con el precio real.
      const ped = await pedidoDe(folio);
      assert.strictEqual(Number(ped.datos.total), 460);
      assert.strictEqual(Number(ped.datos.costo_envio), 60);
      assert.strictEqual(ped.datos.tienda.envio_gratis, false,
        'el pedido siguió diciendo que tenía envío gratis');
      assert.strictEqual(Number(ped.datos.tienda.ahorro), 0);
      assert.strictEqual(ped.datos.tienda.promociones.length, 0);

      // La versión escrita es la del total FINAL.
      const { calcularVersionPedidoHash } = await import('../src/services/database.js');
      assert.strictEqual(r.version, calcularVersionPedidoHash({ total: 460, modalidad: 'domicilio' }),
        'la versión se calculó sobre un total que nunca se escribió');

      // Y el cobro sale por ese total, sin volver a mover la versión.
      await conectarClip();
      const enlace = await crearEnlace(folio);
      assert.ok(enlace.url);
      const pago = (await pagosDe(folio))[0];
      assert.strictEqual(Number(pago.monto), 460, 'se cobró un total distinto al recalculado');
      assert.strictEqual(pago.version_pedido_hash, r.version,
        'crearEnlace volvió a mover la versión tras el recálculo');
    });

  await t('33. promoción MONETARIA: B se lleva el cupo; A paga sin descuento', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, limite_usos, canales, activa)
       VALUES ($1,'Monto carrera','monto_fijo','MONTOCARR',FALSE,80,1,
               '["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);

    const folio = 'PROMO-CARR-MON';
    await pedidoDomicilio(folio, {
      subtotal: 500, envio: 40, descuento: 80,
      promos: [{ id: p.id, nombre: 'Monto carrera', codigo: 'MONTOCARR', tipo: 'monto_fijo', descuento: 80 }],
    });

    const r = await recalculoConCarrera(folio, robarCupo(p.id, 'PROMO-CARR-MON-B'));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.descuento, 0, 'se conservó un descuento que no se pudo reclamar');
    assert.strictEqual(r.total, 540, `total ${r.total}: debía ser 500 + 40 de envío`);
    assert.strictEqual(r.ahorro, 0);
    assert.deepStrictEqual(r.promociones, []);

    const ped = await pedidoDe(folio);
    assert.strictEqual(Number(ped.datos.descuento), 0);
    assert.strictEqual(Number(ped.datos.total), 540);
    assert.strictEqual((await usosDe(p.id)).length, 1);
    assert.strictEqual((await usosDe(p.id))[0].pedido_folio, 'PROMO-CARR-MON-B');
  });

  await t('34. dos promociones y sólo una pierde el cupo: la otra sí queda', async () => {
    const { rows: [monto] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, limite_usos,
          acumulable, prioridad, canales, activa)
       VALUES ($1,'Combo monto','monto_fijo','COMBOMON',TRUE,50,NULL,
               TRUE,10,'["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    const { rows: [env] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, limite_usos,
          acumulable, prioridad, canales, modalidades, activa)
       VALUES ($1,'Combo envio','envio_gratis',NULL,TRUE,0,1,
               TRUE,20,'["tienda_online"]'::jsonb,'["domicilio"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);

    const folio = 'PROMO-CARR-DOS';
    await pedidoDomicilio(folio, {
      subtotal: 600, envio: 70, descuento: 50, envioGratis: true,
      promos: [
        { id: monto.id, nombre: 'Combo monto', tipo: 'monto_fijo', descuento: 50 },
        { id: env.id, nombre: 'Combo envio', tipo: 'envio_gratis', descuento: 0, envio_gratis: true },
      ],
    });

    // B sólo se lleva el cupo del ENVÍO GRATIS. El de monto es ilimitado.
    const r = await recalculoConCarrera(folio, robarCupo(env.id, 'PROMO-CARR-DOS-B'));
    assert.strictEqual(r.ok, true, JSON.stringify(r));

    assert.strictEqual(r.descuento, 50, 'se perdió el descuento que SÍ se pudo reclamar');
    assert.strictEqual(r.envioGratis, false, 'se conservó el envío gratis que perdió');
    assert.strictEqual(r.envio, 70);
    assert.strictEqual(r.total, 620, `total ${r.total}: debía ser 600 - 50 + 70`);
    assert.strictEqual(r.ahorro, 50, 'el ahorro contó un envío gratis que no se dio');
    assert.deepStrictEqual(r.promociones, [monto.id]);
    assert.deepStrictEqual(r.perdidas, [env.id]);

    const ped = await pedidoDe(folio);
    assert.strictEqual(Number(ped.datos.total), 620);
    assert.strictEqual(ped.datos.tienda.envio_gratis, false);
    assert.strictEqual(ped.datos.tienda.promociones.length, 1);
    assert.strictEqual(ped.datos.tienda.promociones[0].id, monto.id);

    // La reserva que SÍ quedó lleva la versión del total final, no la del
    // total que se había calculado con las dos promociones.
    const { calcularVersionPedidoHash } = await import('../src/services/database.js');
    const usos = await usosDe(monto.id);
    assert.strictEqual(usos.length, 1);
    assert.strictEqual(usos[0].pedido_version,
      calcularVersionPedidoHash({ total: 620, modalidad: 'domicilio' }),
      'la reserva quedó sellada con la versión de un precio que nunca existió');
    assert.strictEqual(usos[0].pedido_version, r.version);

    // Y el cobro respeta ese total sin volver a mover nada.
    await conectarClip();
    const enlace = await crearEnlace(folio);
    assert.ok(enlace.url);
    const pago = (await pagosDe(folio))[0];
    assert.strictEqual(Number(pago.monto), 620);
    assert.strictEqual(pago.version_pedido_hash, r.version,
      'crearEnlace movió la versión tras el recálculo');
    assert.strictEqual((await usosDe(monto.id))[0].estado, 'reservada');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya estaba abajo */ }
  clipMock.close(); mpMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-promociones-pagos: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
