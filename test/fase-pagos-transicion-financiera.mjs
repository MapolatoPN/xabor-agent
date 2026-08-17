// ─── Transición financiera única y concurrencia del intento de pago ────────
//
// Dos bloqueos vivían aquí, y los dos eran de dinero:
//
//   1. El webhook de Clip llamaba a confirmarPagoIdempotente y TIRABA su
//      resultado. Sobre el enlace del proveedor anterior (estado 'invalidado')
//      esa función devolvía null y el webhook liberaba la cocina igual: dinero
//      real cobrado, ledger diciendo invalidado, y el intento nuevo todavía
//      cobrable. Ahora hay UNA transición -- asentarPagoRealVerificado -- y
//      nadie deriva sin que ella lo confirme.
//   2. `crearRegistroPago` es un INSERT directo. Veinte peticiones simultáneas
//      del mismo intento entraban las veinte, y el índice único actuaba de
//      control de concurrencia: el caller veía un 23505 crudo. El UNIQUE es la
//      última barrera, no el mecanismo.
//
// Ninguna prueba toca Clip ni Mercado Pago reales: ambos adaptadores apuntan a
// mocks locales. Cero dinero real en juego.
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
const SECRETO_MP = 'secreto-transicion-financiera';
const PUERTO = Number(process.env.TEST_PORT_TRANSFIN || 4291);
const PUERTO_FALLO = Number(process.env.TEST_PORT_TRANSFIN_FALLO || 4292);
const PUERTO_CLIP = Number(process.env.TEST_PORT_TRANSFIN_CLIP || 4293);
const PUERTO_MP = Number(process.env.TEST_PORT_TRANSFIN_MP || 4294);
const PUERTO_NULO = Number(process.env.TEST_PORT_TRANSFIN_NULO || 4295);
const base = `http://localhost:${PUERTO}`;

// Los adaptadores corren en DOS procesos: el servidor hijo (que atiende los
// webhooks) y éste (que crea los pagos por la vía real). Los dos tienen que
// apuntar a los mocks, o este proceso llamaría a las APIs de verdad.
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mock de Clip ────────────────────────────────────────────────────────────
// Cuenta CADA creación de checkout: es lo que permite demostrar que veinte
// peticiones simultáneas generan un solo cobro externo.
let checkoutsCreados = 0;
const CHECKOUTS = new Map();          // linkId -> { referencia, estado }
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-link-${++checkoutsCreados}`;
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING',
        monto: Number(body.amount),
      });
      res.end(JSON.stringify({
        payment_request_id: id,
        payment_request_url: `https://pago.mock.clip/${id}`,
        status: 'CHECKOUT',
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
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

// ── Mock de Mercado Pago ────────────────────────────────────────────────────
const PAGOS_MP = new Map();           // paymentId -> cuerpo de /v1/payments/:id
let contadorPref = 0;
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-tf-${++contadorPref}`;
      PREFERENCIAS.set(id, { external_reference: p.external_reference });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, init_point: `https://mp.test/checkout/${id}` }));
    });
    return;
  }
  const m = req.url.startsWith('/v1/payments/search') ? null : /^\/v1\/payments\/([^/?]+)/.exec(req.url);
  if (m) {
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
    { accessToken: 'token-tf', publicKey: 'pk-test', webhookSecret: SECRETO_MP },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'mercado_pago', SEED.superadminUsuarioId);
  const { asegurarRoutingTokenIntegracion } = await import('../src/services/database.js');
  return asegurarRoutingTokenIntegracion(NEG, 'mercado_pago');
}

async function pedidoPendiente(folio, monto) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,'pendiente_pago',$3)
     ON CONFLICT (folio) DO UPDATE SET estado='pendiente_pago', datos=$3`,
    [folio, NEG, JSON.stringify({
      id: folio, negocioId: NEG, canal: 'tienda_online', total: monto, estado: 'pendiente_pago',
      modalidad: 'recoger en tienda', forma_pago: 'enlace de pago', pago_confirmado: false,
      cliente: { nombre: 'Cliente transición', telefono: '8997400001' },
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
async function filaDe(folio, proveedor) {
  return (await filas(folio)).find(f => f.proveedor === proveedor) || null;
}
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

// El webhook responde 200 antes de procesar: hay que esperar al efecto, nunca
// asumirlo. Sin condición explícita, un `sleep` fijo convertiría una regresión
// en un fallo intermitente.
async function esperar(condicion, queEsperaba, ms = 8000) {
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
    body: JSON.stringify({
      resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: referencia,
    }),
  });
  return r.status;
}

function firmarMP(dataId, requestId, ts, secreto) {
  const id = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  return createHmac('sha256', secreto).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
}
async function webhookMP(token, paymentId, { puerto = PUERTO } = {}) {
  const ts = '1700000000', requestId = 'req-tf';
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

// Impresora y ruta REALES: sin esto, "una sola comanda" no distingue entre
// "la exclusividad funcionó" y "aquí nunca se imprime nada".
async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC TRANSICION' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora transición', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora transición' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'TF-%'`, [NEG]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'TF-%'`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [NEG]);
  // Sin .catch: si una tabla cambia de nombre, la prueba debe reventar, no
  // seguir con una impresora fantasma que haria pasar "cero comandas" por el
  // motivo equivocado.
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  // La terminal tambien: si una corrida anterior murio antes de limpiar, la
  // siguiente reventaba con NOMBRE_DUPLICADO. Una suite que solo pasa contra
  // una base virgen no es una regresion.
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='PC TRANSICION')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='PC TRANSICION' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

let srv = null, srvFallo = null, srvNulo = null, TOKEN_MP = null;
try {
  await limpiar();
  await montarImpresion();
  srv = await arrancarServidor({
    PORT: String(PUERTO),
    CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
    XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
    XABOR_URL_PUBLICA: base,
  }, { timeoutMs: 90000 });

  // ═══ 1. CONCURRENCIA REAL ═══
  await t('1. 20 crearEnlacePago simultáneos: 20/20, mismo pago, misma URL, UNA creación externa', async () => {
    await conectarClip();
    const folio = 'TF-0001';
    await pedidoPendiente(folio, 500);
    const antes = checkoutsCreados;

    const rs = await Promise.allSettled(Array.from({ length: 20 }, () => crearEnlace(folio)));

    const rechazados = rs.filter(r => r.status === 'rejected');
    assert.strictEqual(rechazados.length, 0,
      `${rechazados.length}/20 fallaron; primero: ${rechazados[0]?.reason?.message}`);
    // Un 23505 en la cara del caller significa que el UNIQUE actuó de control
    // de concurrencia: veinte intentos de crear veinte cobros.
    assert.ok(!rechazados.some(r => r.reason?.code === '23505'),
      'el índice único llegó hasta el caller: hubo N intentos de crear N cobros');

    const ids = new Set(rs.map(r => r.value.pagoId));
    const urls = new Set(rs.map(r => r.value.url));
    assert.strictEqual(ids.size, 1, `los 20 devolvieron ${ids.size} pagos distintos`);
    assert.strictEqual(urls.size, 1, `los 20 devolvieron ${urls.size} URLs distintas`);

    assert.strictEqual(checkoutsCreados - antes, 1,
      `se crearon ${checkoutsCreados - antes} checkouts en el proveedor; debía ser exactamente 1`);
    assert.strictEqual((await filas(folio)).length, 1, 'quedó más de una fila de pago');
  });

  // ═══ 2. EL PAGO TARDÍO DEL PROVEEDOR ANTERIOR ═══
  await t('2. Clip invalidado por cambio a MP y luego pagado de verdad: el ledger lo reconoce', async () => {
    const folio = 'TF-0002';
    await pedidoPendiente(folio, 620);
    await conectarClip();
    const enlaceClip = await crearEnlace(folio);
    const clipLinkId = enlaceClip.referenciaExterna;

    TOKEN_MP = await conectarMP();                  // el negocio cambia de proveedor
    await crearEnlace(folio);                       // ahora el intento vivo es de MP

    const clipAntes = await filaDe(folio, 'clip');
    assert.strictEqual(clipAntes.estado, 'invalidado', 'el intento de Clip no quedó invalidado');
    assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago');
    assert.strictEqual(await comandasDe(folio), 0, 'salió comanda antes de cobrar');

    // El cliente paga el enlace VIEJO. Dinero real sobre una fila invalidada.
    CHECKOUTS.get(clipLinkId).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(clipAntes.referencia_interna), 200);

    await esperar(async () => (await filaDe(folio, 'clip'))?.estado === 'pagado',
      'que el ledger asiente el cobro de Clip');
    // El asiento y la derivación son dos pasos: el pago queda 'pagado' primero y
    // el pedido se libera enseguida. Medir en medio convertiría la latencia en
    // un fallo intermitente, así que se espera la condición de verdad.
    await esperar(async () => (await pedidoDe(folio)).estado !== 'pendiente_pago',
      'que la derivación libere el pedido');

    const clip = await filaDe(folio, 'clip');
    assert.ok(clip.paid_at, 'no se registró cuándo entró el dinero');
    assert.strictEqual(clip.metadata_sanitizada.honrado_tras_invalidacion, true,
      'no quedó constancia de que se honró un cobro tras invalidar');
    assert.ok(clip.motivo_invalidacion, 'se borró la historia de por qué se había invalidado');

    // El intento hermano deja de poder cobrarse.
    const mp = await filaDe(folio, 'mercado_pago');
    assert.strictEqual(mp.estado, 'invalidado',
      `el intento de MP quedó '${mp.estado}': seguiría siendo cobrable con el dinero ya dentro`);

    const pedido = await pedidoDe(folio);
    assert.notStrictEqual(pedido.estado, 'pendiente_pago', 'el pedido no se liberó');
    assert.strictEqual(pedido.datos.pago_confirmado, true, 'el pedido no quedó marcado como pagado');
    // La comanda sale después de marcar el pedido: se espera esa condición en
    // vez de medirla al vuelo, y luego se comprueba que no salga ninguna más.
    await esperar(async () => await comandasDe(folio) >= 1, 'la comanda del pago honrado');
    await new Promise(r => setTimeout(r, 800));
    assert.strictEqual(await comandasDe(folio), 1, 'no salió exactamente una comanda');
  });

  // ═══ 3. IDEMPOTENCIA DEL MISMO AVISO ═══
  await t('3. el mismo webhook de Clip cinco veces: mismo resultado, cero segunda comanda', async () => {
    const folio = 'TF-0002';
    const antes = await filaDe(folio, 'clip');
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(await webhookClip(antes.referencia_interna), 200);
    }
    // Dar margen a que los cinco terminen de procesarse antes de medir.
    await new Promise(r => setTimeout(r, 1500));

    const despues = await filaDe(folio, 'clip');
    assert.strictEqual(despues.estado, 'pagado');
    assert.strictEqual(despues.paid_at.toISOString(), antes.paid_at.toISOString(),
      'la fecha de cobro se movió: la transición no fue idempotente');
    assert.strictEqual((await filas(folio)).length, 2, 'aparecieron filas de pago nuevas');
    assert.strictEqual(await comandasDe(folio), 1, 'cinco avisos produjeron más de una comanda');
  });

  // ═══ 4. DOBLE COBRO REAL ═══
  await t('4. MP ya pagado y luego el Clip viejo también: doble cobro detectado, ninguno pisado', async () => {
    const folio = 'TF-0004';
    await pedidoPendiente(folio, 740);
    await conectarClip();
    const enlaceClip = await crearEnlace(folio);
    const clipLinkId = enlaceClip.referenciaExterna;

    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const mpFila = await filaDe(folio, 'mercado_pago');
    const clipFila = await filaDe(folio, 'clip');

    // Primero entra el dinero por Mercado Pago.
    PAGOS_MP.set('pay-tf-4', {
      id: 'pay-tf-4', status: 'approved', external_reference: mpFila.referencia_interna,
      transaction_amount: 740, currency_id: 'MXN',
    });
    assert.strictEqual(await webhookMP(TOKEN_MP, 'pay-tf-4'), 200);
    await esperar(async () => (await filaDe(folio, 'mercado_pago'))?.estado === 'pagado',
      'que MP quede asentado');
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del pago de MP');

    // Y DESPUÉS resulta que el enlace viejo de Clip también se pagó.
    CHECKOUTS.get(clipLinkId).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(clipFila.referencia_interna), 200);
    await esperar(async () => (await filaDe(folio, 'clip'))?.estado === 'pagado',
      'que el segundo cobro real quede registrado');

    const clip = await filaDe(folio, 'clip');
    const mp = await filaDe(folio, 'mercado_pago');
    // Los DOS cobros son reales: ninguno se esconde ni se pisa.
    assert.strictEqual(mp.estado, 'pagado', 'se pisó el cobro que ya estaba asentado');
    assert.strictEqual(clip.estado, 'pagado', 'el segundo cobro real quedó sin registrar');
    assert.strictEqual(clip.metadata_sanitizada.anomalia, 'doble_cobro_real',
      'el doble cobro no quedó marcado en la fila de Clip');
    assert.strictEqual(mp.metadata_sanitizada.anomalia, 'doble_cobro_real',
      'el doble cobro no quedó marcado en la fila de MP');
    assert.strictEqual(clip.metadata_sanitizada.anomalia_pagos.length, 2,
      'la anomalía no señala las dos filas implicadas');

    assert.strictEqual(await comandasDe(folio), 1,
      'el segundo cobro generó una segunda comanda');
  });

  // ═══ 5. LA TRANSICIÓN FALLA: NADA SE LIBERA ═══
  await t('5. si la transición financiera falla, el pedido NO se marca pagado ni sale comanda', async () => {
    const folio = 'TF-0005';
    await pedidoPendiente(folio, 810);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = await filaDe(folio, 'clip');
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    // Servidor gemelo con el fallo inyectado EXACTAMENTE en la transición.
    srvFallo = await arrancarServidor({
      PORT: String(PUERTO_FALLO),
      CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
      XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
      XABOR_URL_PUBLICA: `http://localhost:${PUERTO_FALLO}`,
      XABOR_PAGOS_FALLA_EN: 'transicion_financiera',
    }, { timeoutMs: 90000 });

    assert.strictEqual(await webhookClip(clip.referencia_interna, { puerto: PUERTO_FALLO }), 200);
    await new Promise(r => setTimeout(r, 1500));

    const despues = await filaDe(folio, 'clip');
    assert.notStrictEqual(despues.estado, 'pagado', 'se asentó el pago pese al fallo');
    const pedido = await pedidoDe(folio);
    assert.strictEqual(pedido.estado, 'pendiente_pago', 'el pedido se liberó tras un fallo');
    assert.notStrictEqual(pedido.datos.pago_confirmado, true, 'el pedido se marcó pagado tras un fallo');
    assert.strictEqual(await comandasDe(folio), 0, '¡salió comanda con la transición fallida!');
  });

  await t('5b. un resultado no-ok de la transición tampoco confirma nada', async () => {
    const { asentarPagoRealVerificado } = await import('../src/services/database.js');
    const clip = await filaDe('TF-0005', 'clip');
    process.env.XABOR_PAGOS_FALLA_EN = 'transicion_financiera_null';
    try {
      const r = await asentarPagoRealVerificado({ pagoId: clip.id, negocioId: NEG });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.resultado, 'fallo_inyectado');
    } finally {
      delete process.env.XABOR_PAGOS_FALLA_EN;
    }
    assert.notStrictEqual((await filaDe('TF-0005', 'clip')).estado, 'pagado');
  });

  // Estos dos casos son los que tienen dientes contra "el webhook vuelve a
  // ignorar el resultado de la transicion". El caso 5 no bastaba: alli la
  // transicion LANZA, y una excepcion aborta el handler haya compuerta o no.
  // Aqui la transicion devuelve ok:false sin lanzar, asi que la unica cosa que
  // impide liberar la cocina es que alguien mire ese resultado.
  await t('5c. transición no-ok en el webhook de CLIP: ni pedido liberado ni comanda', async () => {
    const folio = 'TF-0008';
    await pedidoPendiente(folio, 900);
    await conectarClip();
    const enlace = await crearEnlace(folio);
    const clip = await filaDe(folio, 'clip');
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    srvNulo = await arrancarServidor({
      PORT: String(PUERTO_NULO),
      CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
      XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
      XABOR_URL_PUBLICA: `http://localhost:${PUERTO_NULO}`,
      XABOR_PAGOS_FALLA_EN: 'transicion_financiera_null',
    }, { timeoutMs: 90000 });

    assert.strictEqual(await webhookClip(clip.referencia_interna, { puerto: PUERTO_NULO }), 200);
    await new Promise(r => setTimeout(r, 1500));

    const pedido = await pedidoDe(folio);
    assert.strictEqual(pedido.estado, 'pendiente_pago',
      'el webhook liberó el pedido pese a que la transición NO lo confirmó');
    assert.notStrictEqual(pedido.datos.pago_confirmado, true,
      'el webhook marcó el pedido pagado sin que el ledger lo asentara');
    assert.strictEqual(await comandasDe(folio), 0,
      '¡salió comanda con una transición que no confirmó nada!');
  });

  await t('5d. transición no-ok en el webhook de MERCADO PAGO: mismo veredicto', async () => {
    const folio = 'TF-0009';
    await pedidoPendiente(folio, 950);
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const mp = await filaDe(folio, 'mercado_pago');
    PAGOS_MP.set('pay-tf-9', {
      id: 'pay-tf-9', status: 'approved', external_reference: mp.referencia_interna,
      transaction_amount: 950, currency_id: 'MXN',
    });

    assert.strictEqual(await webhookMP(TOKEN_MP, 'pay-tf-9', { puerto: PUERTO_NULO }), 200);
    await new Promise(r => setTimeout(r, 1500));

    const pedido = await pedidoDe(folio);
    assert.strictEqual(pedido.estado, 'pendiente_pago',
      'el webhook de MP liberó el pedido sin confirmación del ledger');
    assert.strictEqual(await comandasDe(folio), 0,
      '¡salió comanda con una transición que no confirmó nada!');
  });

  // ═══ 6. clip_link_id NO SE CONTAMINA ═══
  await t('6. el preference_id de Mercado Pago jamás termina en datos.clip_link_id', async () => {
    const folio = 'TF-0006';
    await pedidoPendiente(folio, 300);
    TOKEN_MP = await conectarMP();
    const enlace = await crearEnlace(folio);
    const fila = await filaDe(folio, 'mercado_pago');
    assert.match(fila.preference_id, /^pref-tf-/, 'no se guardó el preference_id en su columna');

    const pedido = await pedidoDe(folio);
    assert.strictEqual(pedido.datos.clip_link_id, undefined,
      `un id de Mercado Pago acabó en clip_link_id: ${pedido.datos.clip_link_id}`);
    assert.ok(!String(enlace.referenciaExterna || '').startsWith('clip-'),
      'fixture: la referencia externa debía ser de MP');
  });

  await t('7. un pedido Clip real sí escribe clip_link_id: la reconciliación legacy sigue viva', async () => {
    const folio = 'TF-0007';
    await pedidoPendiente(folio, 410);
    await conectarClip();
    const enlace = await crearEnlace(folio);

    const pedido = await pedidoDe(folio);
    assert.strictEqual(pedido.datos.clip_link_id, enlace.referenciaExterna,
      'un pedido de Clip dejó de escribir clip_link_id: la reconciliación legacy se quedaría ciega');

    // Y el job legacy sigue encontrándolo por su consulta real.
    const { obtenerPagosPendientesConLink } = await import('../src/services/database.js');
    const pendientes = await obtenerPagosPendientesConLink();
    const mio = pendientes.find(p => p.folio === folio);
    assert.ok(mio, 'obtenerPagosPendientesConLink ya no ve el pedido de Clip');
    assert.strictEqual(mio.clip_link_id, enlace.referenciaExterna);

    // Y ese id sí resuelve contra la API de Clip -- que era justo lo que un
    // preference de MP habría roto.
    const { consultarEstadoPago } = await import('../src/services/clip-api.js');
    const real = await consultarEstadoPago(mio.clip_link_id, NEG);
    assert.ok(real, 'el id guardado no resuelve contra Clip');

    // El pedido de MP del caso 6 NO debe aparecer en esa cola legacy.
    assert.ok(!pendientes.some(p => p.folio === 'TF-0006'),
      'el pedido de Mercado Pago se coló en la cola de reconciliación de Clip');
  });

  // ═══ 8-10. ESTADO TERMINAL vs DOBLE COBRO: QUIEN GANA EL ORDEN ═══
  //
  // La rama de doble cobro hacia `UPDATE pagos SET estado='pagado'` sobre
  // cualquier fila que no estuviera ya pagada. Si corria ANTES del guard de
  // estados terminales, la sola existencia de un hermano cobrado resucitaba una
  // fila 'reembolsado' o 'cancelado' y borraba esa historia. El guard terminal
  // tiene prioridad; 'vencido' no es terminal y sigue su propia politica.

  /** Deja el pedido con A en un estado terminal y B con dinero real asentado. */
  async function terminalConHermanoPagado(folio, monto, estadoTerminal, pagoMP) {
    await pedidoPendiente(folio, monto);
    await conectarClip();
    const enlaceClip = await crearEnlace(folio);
    const A = await filaDe(folio, 'clip');

    // A pasa al estado terminal: un reembolso ya devolvio ese dinero, o el
    // intento se dio de baja a proposito.
    await pool.query(
      `UPDATE pagos SET estado=$2,
                        metadata_sanitizada = metadata_sanitizada || $3::jsonb
        WHERE id=$1`,
      [A.id, estadoTerminal, JSON.stringify({ historia_previa: `paso a ${estadoTerminal}` })]);

    // B se crea con el otro proveedor y recibe dinero real.
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const B = await filaDe(folio, 'mercado_pago');
    PAGOS_MP.set(pagoMP, {
      id: pagoMP, status: 'approved', external_reference: B.referencia_interna,
      transaction_amount: monto, currency_id: 'MXN',
    });
    assert.strictEqual(await webhookMP(TOKEN_MP, pagoMP), 200);
    await esperar(async () => (await filaDe(folio, 'mercado_pago'))?.estado === 'pagado',
      'que el hermano quede cobrado');
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del cobro de B');

    return { A, B, checkoutClip: enlaceClip.referenciaExterna };
  }

  for (const estadoTerminal of ['reembolsado', 'cancelado']) {
    await t(`8[${estadoTerminal}]. hermano pagado NO resucita una fila terminal`, async () => {
      const folio = `TF-T-${estadoTerminal.slice(0, 4)}`;
      const monto = estadoTerminal === 'reembolsado' ? 660 : 670;
      const { A, B, checkoutClip } = await terminalConHermanoPagado(
        folio, monto, estadoTerminal, `pay-tf-${estadoTerminal}`);
      const comandasAntes = await comandasDe(folio);

      // Y AHORA vuelve una confirmacion sobre A.
      CHECKOUTS.get(checkoutClip).estado = 'COMPLETED';
      assert.strictEqual(await webhookClip(A.referencia_interna), 200);
      await esperar(
        async () => Boolean((await filaDe(folio, 'clip')).metadata_sanitizada.anomalia),
        'que quede evidencia del cobro sobre estado terminal');

      const finalA = await filaDe(folio, 'clip');
      const finalB = await filaDe(folio, 'mercado_pago');

      assert.strictEqual(finalA.estado, estadoTerminal,
        `RESUCITO una fila '${estadoTerminal}' a '${finalA.estado}' por tener un hermano pagado`);
      assert.strictEqual(finalB.estado, 'pagado', 'se movio el cobro que si era real');
      assert.strictEqual(finalA.paid_at, null, 'se le puso fecha de cobro a una fila terminal');
      // La historia previa sigue ahi: no se borro nada.
      assert.strictEqual(finalA.metadata_sanitizada.historia_previa, `paso a ${estadoTerminal}`,
        'se borro la historia del reembolso/cancelacion');

      // Evidencia visible, en las dos filas.
      assert.strictEqual(finalA.metadata_sanitizada.anomalia, 'cobro_sobre_estado_terminal');
      assert.strictEqual(finalA.metadata_sanitizada.estado_terminal_conservado, estadoTerminal);
      assert.deepStrictEqual(finalA.metadata_sanitizada.hermanos_pagados, [finalB.id],
        'la anomalia no señala el hermano cobrado');
      assert.strictEqual(finalB.metadata_sanitizada.conflicto_con_pago_terminal, finalA.id,
        'el conflicto no se ve desde la fila que si tiene el dinero');
      assert.strictEqual(finalB.metadata_sanitizada.anomalia, 'doble_cobro_real',
        'el conflicto no quedo marcado como anomalia en la fila cobrada');

      // Nada se derivo por esto.
      assert.strictEqual(await comandasDe(folio), comandasAntes,
        'salio una comanda nueva por un cobro sobre estado terminal');
      assert.strictEqual(finalA.derivacion_pendiente, false,
        'quedo deuda de derivacion sobre una fila terminal');
    });
  }

  await t('9. VENCIDO no es terminal: el dinero real sobre A se registra, sin segunda comanda', async () => {
    // El contraste que demuestra que no se confunden. 'vencido' significa
    // "Xabor dejo de esperar", no "este dinero no existe": el cobro entra y se
    // registra como doble cobro real, que es la politica vigente.
    const folio = 'TF-T-venc';
    const { A, B, checkoutClip } = await terminalConHermanoPagado(
      folio, 680, 'vencido', 'pay-tf-vencido');
    const comandasAntes = await comandasDe(folio);

    CHECKOUTS.get(checkoutClip).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(A.referencia_interna), 200);
    await esperar(async () => (await filaDe(folio, 'clip')).estado === 'pagado',
      'que el dinero real sobre el intento vencido quede asentado');

    const finalA = await filaDe(folio, 'clip');
    const finalB = await filaDe(folio, 'mercado_pago');
    assert.strictEqual(finalA.estado, 'pagado', 'se repudio dinero real de un intento vencido');
    assert.ok(finalA.paid_at, 'no quedo fecha del cobro real');
    assert.strictEqual(finalB.estado, 'pagado', 'se piso el primer cobro');
    assert.strictEqual(finalA.metadata_sanitizada.anomalia, 'doble_cobro_real');
    assert.strictEqual(finalB.metadata_sanitizada.anomalia, 'doble_cobro_real');
    assert.strictEqual(finalA.metadata_sanitizada.anomalia_pagos.length, 2);
    // Y jamas una segunda comanda.
    assert.strictEqual(await comandasDe(folio), comandasAntes,
      'el segundo cobro real genero una segunda comanda');
    assert.strictEqual(finalA.derivacion_pendiente, false,
      'quedo deuda de derivacion: el job sacaria la comanda repetida');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  if (srv) await srv.detener();
  if (srvFallo) await srvFallo.detener();
  if (srvNulo) await srvNulo.detener();
  clipMock.close(); mpMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-pagos-transicion-financiera: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
