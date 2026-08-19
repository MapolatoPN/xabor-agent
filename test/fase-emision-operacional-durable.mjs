// ─── P0-11 FASE 1: suite dedicada de la deuda operacional durable ───────────
//
// No es una coleccion de asserts estructurales: cada caso ejerce DB y
// funciones/rutas PRODUCTIVAS reales -- el mismo /test/pedido que usa el
// resto de la bateria, el checkout real de la tienda, el webhook real de
// Clip, la ruta real de cancelacion, la ruta real de cambio de estado, y el
// scheduler real de programados via un reinicio de servidor (mismo patron
// que fase-programado-memoria-panel.mjs).
//
// Identidad de la deuda: (negocio_id, folio, pedido_creado_at) -- igual
// razon que compras_reales (058, el folio se recicla).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool, actualizarConfiguracion, crearUsuarioConPassword, cancelarPedidoActivo, conEmisionOperacionalExclusiva } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { reconciliarEmisionesOperacionalesPendientes, registrarPedido, convertirPedidoAProgramado } = await import('../src/orders/orderManager.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const SLUG = 'emision-op-durable-test';
const PUERTO = Number(process.env.TEST_PORT_EOD || 4531);
const PUERTO_CLIP = Number(process.env.TEST_PORT_EOD_CLIP || 4532);
const base = `http://localhost:${PUERTO}`;
// crearEnlacePago corre DENTRO de este proceso de prueba (no via HTTP), asi
// que necesita su propio process.env, no solo el que se le pasa al hijo de
// arrancarServidor -- mismo patron que fase-pagos-expiracion.mjs y
// fase-compra-version-desfasada-post-asiento.mjs.
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_URL_PUBLICA = base;

const cookieA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;

const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 15000, intervaloMs = 200 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > lim) return null;
    await esperar(intervaloMs);
  }
}

// ── Mock de Clip: mismo patron ya establecido (lib-meta-mock cubre WA; Clip
// se mockea localmente igual que en fase-compra-version-desfasada-post-asiento) ──
let nClip = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const b = JSON.parse(cuerpo || '{}');
      const id = `clip-eod-${++nClip}`;
      CHECKOUTS.set(id, { referencia: b.metadata?.external_reference || null, estado: 'PENDING', monto: Number(b.amount) });
      res.end(JSON.stringify({ payment_request_id: id, payment_request_url: `https://pago.mock/${id}`, status: 'CHECKOUT' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const c = CHECKOUTS.get(decodeURIComponent(req.url.split('/').pop()));
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: 'x',
        status: c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED' : 'CHECKOUT_PENDING',
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: 'https://x', created_at: '2026-08-19T00:00:00.000Z', expired_at: null,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise(r => clipMock.listen(PUERTO_CLIP, r));
const metaMock = await arrancarMetaMock();

let PRODUCTO = null;
const tel = (p) => `899${p}${String(Date.now()).slice(-6)}`;
const tokenNuevo = () => randomBytes(24).toString('hex');
const comprarTienda = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const carritoEnlace = (telefono, extra = {}) => ({
  checkoutToken: tokenNuevo(), items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente EOD', telefono },
  metodoPago: 'enlace_pago', ...extra,
});
const webhookClip = (ref) => fetch(`${base}/webhook/clip`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: ref }),
}).then(r => r.status).catch(() => 0);

async function crearPedidoOperativo(cookie = cookieA) {
  const r = await fetch(base + '/test/pedido', { method: 'POST', headers: { Cookie: cookie } });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `/test/pedido fallo: ${JSON.stringify(body)}`);
  return body.pedido.id;
}

// registrarPedido DIRECTO (sin emitirPedido despues): exactamente lo que
// hace whatsapp-meta.js para un pedido programado (linea ~1046: SOLO llama
// emitirPedido en el `else`, nunca cuando trae programado_para) y lo que
// necesita el caso 8 para poder cancelar ANTES de que cualquier worker
// corra -- si se usara /test/pedido, su emitirPedido fire-and-forget corre
// en una carrera real contra la cancelacion del test.
let contadorSinEmitir = 0;
async function crearPedidoActivoSinEmitir(negocioId = NEG, extra = {}) {
  contadorSinEmitir++;
  const orden = {
    cliente: { nombre: 'Cliente EOD', telefono: tel(`5${String(contadorSinEmitir).padStart(2, '0')}`) },
    modalidad: 'entrega a domicilio',
    items: [{ nombre: 'Producto EOD directo', cantidad: 1, precio_unitario: 200, notas: '' }],
    subtotal: 200, costo_envio: 0, descuento: 0, total: 200,
    canal: 'prueba_admin', negocioId,
    ...extra,
  };
  return registrarPedido(orden, 'prueba_admin');
}

// ── Consultas de evidencia ──
const pagosDe = async (folio, negocioId = NEG) => (await pool.query(
  `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [negocioId, folio])).rows;
const pedidoDe = async (folio, negocioId = NEG) => (await pool.query(
  `SELECT estado, datos, created_at FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`,
  [folio, negocioId])).rows[0] || null;
const comprasDe = async (telefono, negocioId = NEG) => (await pool.query(
  `SELECT * FROM compras_reales WHERE negocio_id=$1 AND cliente_telefono=$2`, [negocioId, telefono])).rows;
const trabajosDe = async (folio, negocioId = NEG) => (await pool.query(
  `SELECT id, estado FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id=$2`, [negocioId, folio])).rows;
const deudasDeFolio = async (folio, negocioId = NEG) => (await pool.query(
  `SELECT * FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2 ORDER BY created_at`, [negocioId, folio])).rows;
const deudaExacta = async (folio, negocioId, creadoAt) => (await pool.query(
  `SELECT * FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2 AND pedido_creado_at=$3`,
  [negocioId, folio, creadoAt])).rows[0] || null;

async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM compras_reales WHERE negocio_id IN ($1,$2) AND origen <> 'legacy_desconocido'`, [NEG, NEG_B]);
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono LIKE '52199%')`);
  await pool.query(`DELETE FROM repartidores WHERE telefono LIKE '52199%'`);
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id IN ($1,$2)`, [NEG, NEG_B]);
  await pool.query(
    `DELETE FROM pedido_emisiones WHERE negocio_id IN ($1,$2) AND folio LIKE 'XAB-%' AND created_at > NOW() - INTERVAL '1 hour'`,
    [NEG, NEG_B]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='EOD (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='EOD (test)'`, [NEG]);
}

async function preparar() {
  await limpiar();
  for (const neg of [NEG, NEG_B]) {
    for (const m of ['tienda_online', 'pos', 'menu']) {
      await pool.query(
        `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
         ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [neg, m]);
    }
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
     VALUES ($1,'EOD (test)',TRUE,943) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto EOD',300,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
  await pool.query(
    `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'enlace_pago',TRUE)
     ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado=TRUE`, [NEG]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'EOD',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip', { apiKey: 'test-key-no-real', apiSecret: 'test-secret-no-real' }, { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
}

async function crearAdminB() {
  const { rows: [existente] } = await pool.query(`SELECT id FROM usuarios WHERE email = 'admin-b-eod@test.local'`);
  if (existente) return existente.id;
  const u = await crearUsuarioConPassword({
    negocioId: NEG_B, nombre: 'Admin B (EOD)', email: 'admin-b-eod@test.local',
    password: 'ClaveAdminBEOD123!', rol: 'admin',
  });
  return u.id;
}

async function asentarPagoEnlace(telefono, extra = {}) {
  const r = await comprarTienda(carritoEnlace(telefono, extra));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const folio = r.body.folio;
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  const enlace = await crearEnlacePago({ negocioId: NEG, pedidoId: folio, actor: SEED.superadminUsuarioId });
  // `enlace.referenciaExterna` es el id del checkout DE CLIP (clave del mock,
  // usada para marcarlo COMPLETED); el webhook real identifica el pago por
  // `pagos.referencia_interna` (me_reference_id) -- son dos identificadores
  // distintos, confundirlos deja el webhook sin encontrar la fila.
  const pago = (await pagosDe(folio))[0];
  return { folio, referenciaClip: enlace.referenciaExterna, referenciaInterna: pago.referencia_interna, pagoId: pago.id };
}

let srv = null;
const ENV_BASE = {
  PORT: String(PUERTO), XABOR_RUTAS_PRUEBA: '1',
  XABOR_TIENDA_LIMITE_CHECKOUT: '2000', XABOR_TIENDA_LIMITE_LECTURA: '5000',
  CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`, XABOR_URL_PUBLICA: base,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
};

try {
  await preparar();
  const adminB = await crearAdminB();
  const cookieB = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: adminB, negocioId: NEG_B, rol: 'admin' }))}`;

  srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

  // ═══ 1. PEDIDO OPERACIONAL NORMAL ═══════════════════════════════════════
  await t('1. pedido operacional normal: existe pedidos_activos y EXACTAMENTE una deuda pendiente con identidad correcta', async () => {
    const folio = await crearPedidoOperativo();
    const activo = await pedidoDe(folio);
    assert.ok(activo, 'el pedido no quedo en pedidos_activos');
    assert.strictEqual(activo.estado, 'nuevo');

    const deudas = await deudasDeFolio(folio);
    assert.strictEqual(deudas.length, 1, `se esperaba EXACTAMENTE una deuda, hubo ${deudas.length}`);
    assert.strictEqual(deudas[0].negocio_id, NEG);
    assert.strictEqual(deudas[0].folio, folio);
    assert.strictEqual(
      new Date(deudas[0].pedido_creado_at).getTime(),
      new Date(activo.created_at).getTime(),
      'pedido_creado_at de la deuda no coincide con created_at del activo');
    assert.strictEqual(deudas[0].estado, 'pendiente');
  });

  // ═══ 2. PENDIENTE_PAGO ═══════════════════════════════════════════════════
  await t('2. pendiente_pago: deuda operacional = 0', async () => {
    const T = tel('01');
    const { folio } = await asentarPagoEnlace(T);
    const activo = await pedidoDe(folio);
    assert.strictEqual(activo.estado, 'pendiente_pago');
    assert.strictEqual((await deudasDeFolio(folio)).length, 0,
      'un pedido pendiente_pago no debe tener NINGUNA deuda operacional');
  });

  // ═══ 3. TRANSICION AUTORIZADA POR PAGO ═════════════════════════════════
  await t('3. transicion autorizada por pago: pendiente_pago -> nuevo -> deuda operacional = 1', async () => {
    const T = tel('02');
    const { folio, referenciaClip, referenciaInterna } = await asentarPagoEnlace(T);
    CHECKOUTS.get(referenciaClip).estado = 'COMPLETED';
    const status = await webhookClip(referenciaInterna);
    assert.strictEqual(status, 200, 'el webhook de Clip no respondio 200');

    await esperarHasta(async () => (await pedidoDe(folio))?.estado === 'nuevo', { timeoutMs: 15000 });
    const activo = await pedidoDe(folio);
    assert.strictEqual(activo.estado, 'nuevo', 'el pago no libero el pedido a cocina');

    const deuda = await esperarHasta(async () => {
      const d = await deudasDeFolio(folio);
      return d.length ? d : null;
    });
    assert.ok(deuda, 'no aparecio ninguna deuda operacional tras la transicion autorizada por pago');
    assert.strictEqual(deuda.length, 1, `se esperaba una sola deuda, hubo ${deuda.length}`);
  });

  // ═══ 4. PAGO TARDIO ══════════════════════════════════════════════════════
  await t('4. pago tardio: pendiente_pago expira, dinero llega despues -> deuda ejecutable = 0, compra/comanda = 0', async () => {
    const T = tel('03');
    const { folio, referenciaClip, referenciaInterna, pagoId } = await asentarPagoEnlace(T);

    const { vencerEsperaDePago } = await import('../src/services/database.js');
    const v = await vencerEsperaDePago(pagoId, NEG);
    assert.strictEqual(v.ok, true, `no se pudo vencer la espera: ${JSON.stringify(v)}`);
    const cancelado = await pedidoDe(folio);
    assert.strictEqual(cancelado.estado, 'cancelado', 'el pedido no quedo cancelado tras vencer la espera');
    assert.strictEqual((await deudasDeFolio(folio)).length, 0,
      'la transicion pendiente_pago->cancelado por vencimiento no debe crear NINGUNA deuda (P0-11A)');

    // El dinero llega DESPUES de que el pedido ya vencio -- pago tardio real.
    // El intento VENCIDO sigue siendo reconciliable (vencer en Xabor no es
    // cancelar en el proveedor): se completa el MISMO checkout en el mock y
    // se reenvia su propio webhook.
    CHECKOUTS.get(referenciaClip).estado = 'COMPLETED';
    const status = await webhookClip(referenciaInterna);
    assert.strictEqual(status, 200);
    await esperarHasta(async () => (await pagosDe(folio))[0].estado === 'pagado');
    const pagoFinal = (await pagosDe(folio))[0];
    assert.strictEqual(pagoFinal.estado, 'pagado', 'el dinero real no se asento');
    assert.strictEqual(pagoFinal.metadata_sanitizada.anomalia, 'pago_tardio');

    await esperar(1500); // margen para cualquier efecto tardio
    assert.strictEqual((await deudasDeFolio(folio)).length, 0, 'el pago tardio genero una deuda operacional ejecutable');
    assert.strictEqual((await comprasDe(T)).length, 0, 'el pago tardio genero una compra real');
    assert.strictEqual((await trabajosDe(folio)).length, 0, 'el pago tardio genero un trabajo de impresion');
    const pedidoFinal = await pedidoDe(folio);
    assert.strictEqual(pedidoFinal.estado, 'cancelado', 'el pago tardio resucito el pedido');
  });

  // ═══ 5. VERSION_DESFASADA (pre-asiento) ═════════════════════════════════
  await t('5. version_desfasada: dinero real se registra, version ya cambio -> deuda ejecutable = 0, cocina = 0', async () => {
    const T = tel('04');
    const { folio, referenciaClip, referenciaInterna } = await asentarPagoEnlace(T);

    // El pedido cambia ANTES de que el webhook llegue.
    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','999999'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    CHECKOUTS.get(referenciaClip).estado = 'COMPLETED';
    const status = await webhookClip(referenciaInterna);
    assert.strictEqual(status, 200);
    await esperarHasta(async () => (await pagosDe(folio))[0].estado === 'pagado');

    const pago = (await pagosDe(folio))[0];
    assert.strictEqual(pago.estado, 'pagado', 'el dinero real no se asento pese al desfase');
    assert.strictEqual(pago.metadata_sanitizada.anomalia, 'version_desfasada');

    await esperar(1500);
    assert.strictEqual((await deudasDeFolio(folio)).length, 0, 'version_desfasada genero una deuda operacional ejecutable');
    assert.strictEqual((await comprasDe(T)).length, 0, 'version_desfasada genero una compra real');
    const pedidoFinal = await pedidoDe(folio);
    assert.strictEqual(pedidoFinal.estado, 'pendiente_pago', 'version_desfasada libero el pedido a cocina');
  });

  // ═══ 6. PROGRAMADO FUTURO ════════════════════════════════════════════════
  await t('6. programado futuro: registrarPedido -> convertirPedidoAProgramado -> deuda operacional pendiente = 0', async () => {
    // Camino REAL de produccion (whatsapp-meta.js:1046): si `pedido.programado_para`
    // ya viene puesto, NUNCA se llama emitirPedido -- se convierte directo.
    const futuro = new Date(Date.now() + 3 * 3600e3).toISOString();
    const pedido = await crearPedidoActivoSinEmitir(NEG, { programado_para: futuro });
    const conv = await convertirPedidoAProgramado(pedido, futuro);
    assert.strictEqual(conv.ok, true, `la conversion a programado fallo: ${JSON.stringify(conv)}`);

    const activo = (await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [pedido.id, NEG])).rowCount;
    assert.strictEqual(activo, 0, 'el pedido sigue en pedidos_activos tras programarse');
    assert.strictEqual((await deudasDeFolio(pedido.id)).length, 0,
      'un programado futuro no debe tener NINGUNA deuda operacional (ni pendiente ni saldada): nunca se emitio');
  });

  // ═══ 7. ACTIVACION DE PROGRAMADO ═════════════════════════════════════════
  await t('7. activacion de programado: llega su hora, el scheduler productivo lo reinserta -> deuda = 1, emision una vez', async () => {
    const pasado = new Date(Date.now() - 5 * 60e3).toISOString();
    const pedido = await crearPedidoActivoSinEmitir(NEG, { programado_para: pasado });
    const folio = pedido.id;
    const conv = await convertirPedidoAProgramado(pedido, pasado);
    assert.strictEqual(conv.ok, true, `la conversion a programado fallo: ${JSON.stringify(conv)}`);
    assert.strictEqual((await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rowCount, 0);
    assert.strictEqual((await deudasDeFolio(folio)).length, 0, 'ya existia una deuda antes de que el scheduler activara: el fixture no representa el escenario');

    // El scheduler productivo (activarPedidosProgramados) corre UNA VEZ al
    // arrancar -- reiniciar equivale a "llega su hora", mismo patron que
    // fase-programado-memoria-panel.mjs caso 4.
    await srv.detener();
    srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

    const reactivado = await esperarHasta(async () =>
      (await pool.query(`SELECT created_at FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0] || null,
      { timeoutMs: 20000 });
    assert.ok(reactivado, 'el scheduler no reinserto el pedido en pedidos_activos');

    const deudaSaldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, NEG, reactivado.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(deudaSaldada, `la deuda de la activacion no se saldo (obtenido: ${JSON.stringify(await deudaExacta(folio, NEG, reactivado.created_at))})`);

    const todas = await deudasDeFolio(folio);
    assert.strictEqual(todas.length, 1, `se esperaba UNA sola deuda para el folio activado, hubo ${todas.length}`);
    assert.strictEqual((await comprasDe(pedido.cliente.telefono)).length, 1, 'la activacion no registro exactamente una compra real');
  });

  // ═══ 8. CANCELACION ANTES DE EMISION ═════════════════════════════════════
  await t('8. cancelacion antes de emision: cancelarPedidoActivo real + reconciliador -> deuda cancelada, cero efectos', async () => {
    // registrarPedido SIN emitirPedido: garantiza que la deuda sigue
    // 'pendiente' cuando se cancela -- ningun worker alcanzo a correr. Con
    // /test/pedido, su emitirPedido fire-and-forget corre en carrera real
    // contra la cancelacion del test (medido: a veces gana la emision).
    const pedido = await crearPedidoActivoSinEmitir();
    const folio = pedido.id;
    const activo = await pedidoDe(folio);
    assert.strictEqual(activo.estado, 'nuevo');
    const deudaAntes = await deudaExacta(folio, NEG, activo.created_at);
    assert.strictEqual(deudaAntes?.estado, 'pendiente', 'no nacio la deuda pendiente antes de cancelar');

    const ok = await cancelarPedidoActivo(folio, 'prueba EOD caso 8', NEG);
    assert.strictEqual(ok, true, 'cancelarPedidoActivo real no aplico el UPDATE');
    const cancelado = await pedidoDe(folio);
    assert.strictEqual(cancelado.estado, 'cancelado', 'la fila no quedo cancelada (UPDATE, no DELETE)');

    await reconciliarEmisionesOperacionalesPendientes(50);

    const deudaDespues = await deudaExacta(folio, NEG, activo.created_at);
    assert.strictEqual(deudaDespues?.estado, 'cancelada', `la deuda no quedo cancelada (obtenido: ${JSON.stringify(deudaDespues)})`);
    assert.strictEqual((await comprasDe(pedido.cliente.telefono)).length, 0, 'se registro una compra sobre un pedido cancelado');
    assert.strictEqual((await trabajosDe(folio)).length, 0, 'salio un trabajo de impresion sobre un pedido cancelado');
  });

  // ═══ 9. PEDIDO YA ENTREGADO / NO EMITIBLE ════════════════════════════════
  await t('9. pedido entregado: el recovery no lo resucita', async () => {
    const folio = await crearPedidoOperativo();
    const activo = await pedidoDe(folio);
    await esperarHasta(async () => (await deudaExacta(folio, NEG, activo.created_at))?.estado === 'saldada');

    // Forzar la deuda de vuelta a 'pendiente' simula el escenario real que
    // esta prueba necesita cubrir: una deuda que quedo pendiente (p. ej. por
    // un crash) para un pedido que YA avanzo a entregado antes de que el
    // recovery corriera.
    await pool.query(
      `UPDATE pedido_emisiones SET estado='pendiente' WHERE negocio_id=$1 AND folio=$2 AND pedido_creado_at=$3`,
      [NEG, folio, activo.created_at]);

    const re = await fetch(base + `/pedidos/${folio}/estado`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ estado: 'entregado' }),
    });
    assert.strictEqual(re.status, 200, `no se pudo marcar entregado: ${await re.text()}`);
    await esperarHasta(async () => (await pedidoDe(folio))?.estado === 'entregado');

    const comprasAntes = (await comprasDe(await (async () => {
      const { rows: [pp] } = await pool.query(`SELECT datos->'cliente'->>'telefono' AS tel FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
      return pp?.tel;
    })())).length;

    await reconciliarEmisionesOperacionalesPendientes(50);
    const deudaFinal = await deudaExacta(folio, NEG, activo.created_at);
    assert.strictEqual(deudaFinal?.estado, 'cancelada', `el recovery reactivo un pedido entregado (obtenido: ${JSON.stringify(deudaFinal)})`);
    const telFinal = (await pool.query(`SELECT datos->'cliente'->>'telefono' AS tel FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0]?.tel;
    assert.strictEqual((await comprasDe(telFinal)).length, comprasAntes, 'el recovery registro una compra nueva sobre un pedido entregado');
  });

  // ═══ 10. IDEMPOTENCIA DE DEUDA A TRAVES DE MULTIPLES UPDATES ═══════════
  await t('10. idempotencia: nuevo -> en_preparacion -> listo sigue siendo UNA sola deuda logica', async () => {
    const folio = await crearPedidoOperativo();
    const activo = await pedidoDe(folio);

    for (const estado of ['en_preparacion', 'listo']) {
      const r = await fetch(base + `/pedidos/${folio}/estado`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookieA },
        body: JSON.stringify({ estado }),
      });
      assert.strictEqual(r.status, 200, `no se pudo mover a ${estado}: ${await r.text()}`);
      await esperarHasta(async () => (await pedidoDe(folio))?.estado === estado);
    }

    const todas = await deudasDeFolio(folio);
    assert.strictEqual(todas.length, 1, `multiples UPDATEs de estado crearon ${todas.length} deudas en vez de una sola`);
  });

  // ═══ 11. MULTITENANT ═════════════════════════════════════════════════════
  await t('11. multitenant: la identidad/claim de negocio A nunca procesa B', async () => {
    const folioA = await crearPedidoOperativo(cookieA);
    const folioB = await crearPedidoOperativo(cookieB);
    const activoA = await pedidoDe(folioA, NEG);
    const activoB = await pedidoDe(folioB, NEG_B);
    assert.ok(activoA && activoB);

    const { conEmisionOperacionalExclusiva } = await import('../src/services/database.js');
    let vioOtroNegocio = false;
    const r = await conEmisionOperacionalExclusiva(NEG, folioB, activoB.created_at, async () => { vioOtroNegocio = true; });
    assert.strictEqual(vioOtroNegocio, false, 'el claim de negocio A pudo ejecutar el nucleo de un folio de negocio B');
    assert.strictEqual(r.razon, 'sin_deuda', `se esperaba sin_deuda cruzando de negocio (obtenido: ${JSON.stringify(r)})`);

    // Y la deuda REAL de B sigue intacta / procesable bajo su propio negocio.
    const deudaB = await deudaExacta(folioB, NEG_B, activoB.created_at);
    assert.ok(deudaB, 'la deuda real de B desaparecio tras el intento cruzado');
  });

  // ═══ 12. REPARTO: el recovery operacional nunca intenta notificar ═══════
  await t('12. reparto: el recovery operacional nunca intenta notificar repartidores', async () => {
    await actualizarConfiguracion({
      int_wa_phone_id: 'PNID_EOD12', int_wa_token: 'fake-token-eod12',
      repartidor_notif_modo: 'piloto', repartidor_notif_piloto_telefonos: '5219912345',
    }, NEG);
    await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp','PNID_EOD12','EOD12',TRUE) ON CONFLICT (canal, identificador) DO UPDATE SET negocio_id=$1, activo=TRUE`, [NEG]);
    await pool.query(`INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Repartidor EOD12','5219912345','tok-eod12',TRUE,$1)`, [NEG]);

    // registrarPedido SIN emitirPedido (igual que el caso 8): la deuda queda
    // 'pendiente' porque NADIE la emitio todavia -- ni el foreground ni nada
    // mas. Si se usara /test/pedido, su propio emitirPedido foreground
    // (intentarReparto:true, legitimo) mandaria la UNICA oferta real, y
    // aparentaria (equivocadamente) que la mando el recovery.
    const pedido = await crearPedidoActivoSinEmitir();
    const folio = pedido.id;
    const activo = await pedidoDe(folio);
    const deudaInicial = await deudaExacta(folio, NEG, activo.created_at);
    assert.strictEqual(deudaInicial?.estado, 'pendiente', 'la deuda no nacio pendiente: el fixture no representa "crash antes de cualquier intento"');

    // Filtrado por telefono del repartidor de ESTE caso, no un conteo global:
    // negocioA acumulo repartidores/credenciales de otras suites en esta
    // misma base compartida, y sus emisiones foreground (intentarReparto:true,
    // legitimas) pueden seguir en vuelo cuando este caso corre.
    const paraMiRepartidor = () => metaMock.obtenerMensajesEnviados().filter(m => m.to === '5219912345').length;
    const antesWA = paraMiRepartidor();
    await reconciliarEmisionesOperacionalesPendientes(50);
    await esperar(1500);
    const despuesWA = paraMiRepartidor();
    assert.strictEqual(despuesWA, antesWA, 'el recovery disparo una notificacion a Meta pese a modalidad no elegible/gate');

    const notif = (await pool.query(`SELECT COUNT(*)::int AS n FROM notificaciones_repartidor WHERE pedido_folio=$1`, [folio])).rows[0].n;
    assert.strictEqual(notif, 0, 'el recovery registro una notificacion a repartidores');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya abajo */ }
  clipMock.close();
  metaMock.detener();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-emision-operacional-durable: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
