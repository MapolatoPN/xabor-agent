// ─── Tienda Online: SOLO pago en línea + pendiente_pago no es operativo ─────
//
// Regla de negocio que esta suite fija (aprobada):
//   "Todo pedido que aparece en cocina proveniente de la Tienda Online ya
//    está pagado" y "un cliente puede abandonar el pago sin que el
//    restaurante prepare absolutamente nada".
//
// Vocabulario preciso (nada de 'exactly-once' global):
//   · La TRANSICIÓN pendiente_pago→operativo es un reclamo durable único
//     (reclamarEmisionPorPago + advisory lock).
//   · Los EFECTOS (comanda Edge, emisión P0-11, oferta a repartidores) son
//     idempotentes/deduplicados cada uno por su propia clave persistente.
//   · El aviso WS al panel es lógico (identidad de pedido + dedupe del
//     consumidor); el sonido del panel es best-effort.
// Lo que se asierta aquí son los DURABLES: filas de comanda, filas de
// emisión, estado del pedido -- bajo concurrencia y reintento entre procesos.
//
// Cero Clip real. Cero producción.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import assert from 'assert';
import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const SLUG = 'solo-online-test';
const PUERTO = String(process.env.TEST_PORT_TSP || 4391);
const PUERTO_CLIP = Number(process.env.TEST_PORT_TSP_CLIP || 4392);
const base = `http://localhost:${PUERTO}`;
const token = () => randomBytes(24).toString('hex');
const ADMIN = `xabor_sesion=${encodeURIComponent(
  crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
let PRODUCTO = null;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mock de Clip v2 ─────────────────────────────────────────────────────────
let checkoutsClip = 0;
const CHECKOUTS = new Map();
const REQUESTS = [];
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      REQUESTS.push(body);
      const id = `clip-tsp-${++checkoutsClip}`;
      const expiresAt = body.expires_at
        ? new Date(Date.parse(body.expires_at)).toISOString()
        : new Date(Date.now() + 3 * 24 * 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount), expiresAt,
      });
      res.end(JSON.stringify({
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        expires_at: expiresAt,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED'
        : c.estado === 'EXPIRED' ? 'CHECKOUT_EXPIRED' : 'CHECKOUT_PENDING';
      const g = {
        object_type: 'payment_link', payment_request_id: id, status,
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
        created_at: '2026-08-21T00:00:00Z', expires_at: c.expiresAt || null,
        last_status_message: status,
      };
      if (c.estado === 'EXPIRED') g.expired_at = c.expiresAt || null;
      res.end(JSON.stringify(g));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise(r => clipMock.listen(PUERTO_CLIP, r));

// ── Helpers de rutas ────────────────────────────────────────────────────────
const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const metodosPublicos = () => fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`)
  .then(r => r.json()).then(d => d.metodos || []);
const postPago = (tk) => fetch(`${base}/api/tienda/seguimiento/${encodeURIComponent(tk)}/pago`, { method: 'POST' })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const getPago = (tk) => fetch(`${base}/api/tienda/seguimiento/${encodeURIComponent(tk)}/pago`)
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const getSeguimiento = (tk) => fetch(`${base}/api/tienda/seguimiento/${encodeURIComponent(tk)}`)
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const patchEstado = (folio, estado) => fetch(`${base}/pedidos/${encodeURIComponent(folio)}/estado`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
  body: JSON.stringify({ estado }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const webhookClip = (cuerpo) => fetch(`${base}/webhook/clip`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
}).then(r => r.status);

const carrito = (tk, metodoPago, extra = {}) => ({
  checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente solo online', telefono: '8997300001' },
  metodoPago, ...extra,
});

async function pedidoDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, datos, created_at FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG]);
  return r || null;
}
async function comandasDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id = $1 AND origen_tipo = 'pedido' AND origen_id = $2`, [NEG, folio]);
  return r.n;
}
async function emisionesDe(folio) {
  const { rows } = await pool.query(
    `SELECT estado, origen FROM pedido_emisiones WHERE negocio_id = $1 AND folio = $2`, [NEG, folio]);
  return rows;
}
async function ofertasRepartidorDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notificaciones_repartidor WHERE pedido_folio = $1`, [folio]).catch(() => ({ rows: [{ n: 0 }] }));
  return r?.n ?? 0;
}
async function pagosDe(folio) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 ORDER BY created_at`, [NEG, folio]);
  return rows;
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 150 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}

// Volcado inicial del tablero: abre el WS del panel y captura el replay.
function volcadoTablero(ms = 1500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http://', 'ws://') + '/ws/panel', { headers: { Cookie: ADMIN } });
    const vistos = [];
    const to = setTimeout(() => { ws.close(); resolve(vistos); }, ms);
    ws.on('message', (raw) => {
      let d; try { d = JSON.parse(raw.toString()); } catch { return; }
      if (d.tipo === 'nuevo_pedido' && d.pedido) vistos.push(d.pedido);
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

async function pagarEnMock(fila) {
  const ck = fila.referencia_externa;
  CHECKOUTS.get(ck).estado = 'COMPLETED';
  assert.strictEqual(await webhookClip({
    resource: 'CHECKOUT', resource_status: 'COMPLETED',
    me_reference_id: String(fila.id), payment_request_id: ck,
  }), 200);
}

// Checkout + enlace: el fixture de la mayoría de los casos.
async function checkoutConEnlace() {
  const tk = token();
  const r = await comprar(carrito(tk, 'enlace_pago'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const pago = await postPago(r.body.trackingToken);
  assert.strictEqual(pago.status, 200, JSON.stringify(pago.body));
  const [fila] = await pagosDe(r.body.folio);
  return { folio: r.body.folio, tracking: r.body.trackingToken, fila, url: pago.body.url };
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Allow-list PROPIA de la tienda (configuracion.tienda_metodos_pago). Sin
// fila = default: solo pago con tarjeta en linea.
async function permitir(lista) {
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, JSON.stringify(lista)]);
}
async function permitirDefault() {
  await pool.query(
    `DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`, [NEG]);
}

async function metodos(activos) {
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [NEG]);
  for (const tipo of activos) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,TRUE)
       ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG, tipo]);
  }
}
async function conectarProveedor() {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
}
async function desconectarProveedor() {
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos'`, [NEG]);
}

async function limpiar() {
  await desconectarProveedor().catch(() => {});
  await pool.query(`DELETE FROM pagos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM compras_reales WHERE negocio_id = $1 AND cliente_telefono LIKE '89973%'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
    [NEG]).catch(() => {});
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM pedido_emisiones WHERE negocio_id = $1 AND folio IN
       (SELECT folio FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' IN ('tienda_online','whatsapp')
        UNION SELECT folio FROM pedido_emisiones WHERE negocio_id = $1 AND folio LIKE 'TSP-%')`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND (datos->>'canal' = 'tienda_online' OR folio LIKE 'TSP-%')`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'SoloOnline (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'SoloOnline (test)'`, [NEG]);
}

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC TSP' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora tsp', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora tsp' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function preparar() {
  await limpiar();
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG, m]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
     VALUES ($1,'SoloOnline (test)',TRUE,985) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto solo online',250,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, JSON.stringify(reglas)]);
  // Efectivo TAMBIÉN habilitado a propósito: la tienda debe ignorarlo aunque
  // el negocio lo tenga para sus otros canales (POS lo sigue usando).
  await metodos(['efectivo', 'enlace_pago']);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'Solo Online',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  await montarImpresion();
  await conectarProveedor();

  // Fixture del caso L: dos pendiente_pago pre-existentes, uno de tienda y
  // uno de OTRO canal (anticipo estilo WhatsApp), cargados por el server al
  // arrancar.
  for (const [folio, canal] of [['TSP-L-TIENDA', 'tienda_online'], ['TSP-L-WA', 'whatsapp']]) {
    await pool.query(
      `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
       VALUES ($1,$2,'pendiente_pago',$3)
       ON CONFLICT (folio) DO UPDATE SET estado='pendiente_pago', datos=$3`,
      [folio, NEG, JSON.stringify({
        id: folio, negocioId: NEG, canal, total: 100, estado: 'pendiente_pago',
        modalidad: 'recoger en tienda', forma_pago: canal === 'tienda_online' ? 'enlace_pago' : 'transferencia (anticipo)',
        pago_confirmado: false,
        cliente: { nombre: 'Fixture L', telefono: '8997300099' },
        items: [{ nombre: 'Producto', cantidad: 1, precio_unitario: 100 }],
        timestamp: new Date().toISOString(),
      })]);
  }
}

let srv = null;
try {
  await preparar();
  srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

  // ═══ A. Allow-list propia: el default es SOLO tarjeta en línea ════════════
  await t('A. sin configuracion propia, la tienda ofrece SOLO tarjeta en línea (aunque el POS tenga efectivo)', async () => {
    const m = await metodosPublicos();
    assert.strictEqual(m.length, 1, `ofrecio ${m.length} metodos: ${JSON.stringify(m.map(x => x.id))}`);
    assert.strictEqual(m[0].id, 'enlace_pago');
    assert.strictEqual(m[0].pagaDespues, false);
    assert.strictEqual(m[0].etiqueta, 'Pago con tarjeta en línea');
  });

  // ═══ A2. La tienda que DELIBERADAMENTE permite efectivo ═══════════════════
  await t('A2. con allow-list [tarjeta, efectivo]: ofrece ambos y el efectivo crea un pedido operativo POR COBRAR', async () => {
    await permitir(['enlace_pago', 'efectivo']);
    try {
      const m = await metodosPublicos();
      assert.deepStrictEqual(m.map(x => x.id), ['enlace_pago', 'efectivo']);
      const r = await comprar(carrito(token(), 'efectivo'));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const p = await pedidoDe(r.body.folio);
      assert.strictEqual(p.estado, 'nuevo', 'el efectivo permitido debe entrar a cocina de inmediato');
      assert.strictEqual(p.datos.pago_confirmado, false, 'el efectivo queda POR COBRAR, no pagado');
      const comandas = await esperarHasta(async () => (await comandasDe(r.body.folio)) === 1 ? 1 : null);
      assert.strictEqual(comandas, 1, 'el efectivo permitido no imprimio su comanda');
    } finally { await permitirDefault(); }
  });

  // ═══ B. Métodos fuera de la allow-list: rechazados siempre ════════════════
  await t('B. un método habilitado en el POS pero fuera de la allow-list de la tienda -> rechazado, CERO pedido', async () => {
    // metodos_pago (POS) tiene efectivo habilitado desde el fixture, pero la
    // allow-list default de la tienda no lo permite: el POS no gobierna la
    // tienda, y el navegador no puede colar nada.
    for (const metodo of ['efectivo', 'terminal', 'transferencia']) {
      const tk = token();
      const r = await comprar(carrito(tk, metodo));
      assert.strictEqual(r.status, 400, `${metodo}: respondio ${r.status}`);
      assert.strictEqual(r.body.codigo, 'METODO_PAGO_INVALIDO', `${metodo}: ${JSON.stringify(r.body)}`);
      const { rows } = await pool.query(
        `SELECT 1 FROM tienda_pedidos WHERE negocio_id=$1 AND checkout_token=$2 AND pedido_folio IS NOT NULL`, [NEG, tk]);
      assert.strictEqual(rows.length, 0, `${metodo}: creo un pedido`);
    }
    // Y la API de configuracion valida contra el catalogo soportado.
    const rApi = await fetch(`${base}/api/admin/tienda`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
      body: JSON.stringify({ metodosPago: ['enlace_pago', 'bitcoin'] }),
    });
    const bApi = await rApi.json().catch(() => ({}));
    assert.strictEqual(rApi.status, 400, JSON.stringify(bApi));
    assert.strictEqual(bApi.codigo, 'METODO_NO_SOPORTADO');
    assert.deepStrictEqual((await metodosPublicos()).map(x => x.id), ['enlace_pago'],
      'el guardado invalido altero la allow-list');
  });

  // ═══ C. Fail closed sin pago en línea utilizable ══════════════════════════
  await t('C. tarjeta permitida pero pasarela no utilizable -> no se ofrece; solo-online falla cerrado; dual-mode sigue vendiendo offline', async () => {
    // C1: tienda default (solo online) con la pasarela caida -> nada que
    // ofrecer, fail closed con mensaje humano.
    await desconectarProveedor();
    assert.strictEqual((await metodosPublicos()).length, 0, 'sin proveedor siguio ofreciendo la pasarela');
    let r = await comprar(carrito(token(), 'enlace_pago'));
    assert.strictEqual(r.status, 503, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'PAGO_EN_LINEA_NO_DISPONIBLE');
    assert.match(r.body.error, /no están disponibles temporalmente/);
    // C2: allow-list SIN online + proveedor CONECTADO -> el proveedor no
    // reactiva un metodo que la tienda no permitio.
    await conectarProveedor();
    await permitir(['efectivo']);
    assert.deepStrictEqual((await metodosPublicos()).map(x => x.id), ['efectivo'],
      'el proveedor reactivo la tarjeta en linea fuera de la allow-list');
    r = await comprar(carrito(token(), 'enlace_pago'));
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'METODO_PAGO_INVALIDO');
    // C3: tienda dual [tarjeta, efectivo] con pasarela caida -> la tarjeta
    // desaparece pero el efectivo permitido SIGUE vendiendo.
    await desconectarProveedor();
    await permitir(['enlace_pago', 'efectivo']);
    assert.deepStrictEqual((await metodosPublicos()).map(x => x.id), ['efectivo']);
    r = await comprar(carrito(token(), 'efectivo'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await pedidoDe(r.body.folio)).estado, 'nuevo');
    // restaurar fixture: proveedor conectado + default solo-online
    await conectarProveedor();
    await permitirDefault();
  });

  // ═══ C4. Backoffice: proveedor resuelto y estado, sin hardcodear ══════════
  await t('C4. GET /api/admin/tienda expone la allow-list y el proveedor RESUELTO con su estado', async () => {
    const r = await fetch(`${base}/api/admin/tienda`, { headers: { Cookie: ADMIN } });
    const b = await r.json();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(b.pagos.permitidos, ['enlace_pago']);
    assert.deepStrictEqual(b.pagos.soportados, ['enlace_pago', 'efectivo', 'terminal', 'transferencia']);
    assert.strictEqual(b.pagos.proveedor.nombre, 'clip');
    assert.strictEqual(b.pagos.proveedor.utilizable, true);
  });

  // ═══ D. El checkout crea el registro técnico pendiente_pago ═══════════════
  let fx = null;        // fixture compartido D→E→F→N
  let fxG = null;       // fixture G→H
  let fxVencido = null; // fixture I→J
  await t('D. checkout valido -> pedido tecnico pendiente_pago + vinculo en tienda_pedidos', async () => {
    fx = await checkoutConEnlace();
    const p = await pedidoDe(fx.folio);
    assert.strictEqual(p.estado, 'pendiente_pago');
    const { rows: [tp] } = await pool.query(
      `SELECT estado, pedido_folio FROM tienda_pedidos WHERE negocio_id=$1 AND pedido_folio=$2`, [NEG, fx.folio]);
    assert.ok(tp, 'sin vinculo en tienda_pedidos');
    assert.ok(fx.url, 'sin enlace de pago');
  });

  // ═══ E. Antes de pagar: NADA operativo ════════════════════════════════════
  await t('E. sin pagar: cero comanda, cero emision de cocina, cero repartidores, invisible en tablero, y el panel NO puede moverlo (409)', async () => {
    await esperar(800);
    assert.strictEqual(await comandasDe(fx.folio), 0, 'imprimio sin pagar');
    const em = await emisionesDe(fx.folio);
    assert.strictEqual(em.length, 0, `hay deuda/fila de emision sin pagar: ${JSON.stringify(em)}`);
    assert.strictEqual(await ofertasRepartidorDe(fx.folio), 0, 'se ofrecio a repartidores sin pagar');
    const tablero = await volcadoTablero();
    assert.ok(!tablero.some(p => p.id === fx.folio),
      'el checkout sin pagar aparecio en el volcado del tablero');
    for (const destino of ['en_preparacion', 'listo', 'entregado', 'nuevo']) {
      const r = await patchEstado(fx.folio, destino);
      assert.strictEqual(r.status, 409, `${destino}: respondio ${r.status} (${JSON.stringify(r.body)})`);
      assert.strictEqual(r.body.codigo, 'PAGO_PENDIENTE');
    }
    assert.strictEqual((await pedidoDe(fx.folio)).estado, 'pendiente_pago', 'algun PATCH prospero');
  });

  // ═══ F. Pago confirmado -> el pedido se activa (una transición) ═══════════
  await t('F. pago confirmado por el flujo verificado -> transicion unica a operativo, comanda y visibilidad', async () => {
    await pagarEnMock(fx.fila);
    const activo = await esperarHasta(async () => {
      const p = await pedidoDe(fx.folio);
      return p.estado !== 'pendiente_pago' ? p : null;
    });
    assert.ok(activo, 'el pago no activo el pedido');
    assert.strictEqual(activo.estado, 'nuevo', `estado inicial operativo: ${activo.estado}`);
    assert.strictEqual(activo.datos.pago_confirmado, true);
    const comandas = await esperarHasta(async () => (await comandasDe(fx.folio)) === 1 ? 1 : null);
    assert.strictEqual(comandas, 1, `comandas: ${await comandasDe(fx.folio)}`);
    const em = await emisionesDe(fx.folio);
    assert.strictEqual(em.length, 1, `filas de emision: ${em.length}`);
    assert.strictEqual(em[0].estado, 'saldada', `emision: ${em[0].estado}`);
    const tablero = await volcadoTablero();
    assert.ok(tablero.some(p => p.id === fx.folio), 'el pedido pagado no aparece en el tablero');
    // Y ahora el panel SI puede operarlo.
    const r = await patchEstado(fx.folio, 'en_preparacion');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  // ═══ G. Concurrencia: webhook x N + reconciliador de otro proceso ═════════
  await t('G. ocho webhooks concurrentes + derivacion desde OTRO proceso sobre el mismo pago -> UNA comanda, UNA emision saldada', async () => {
    const g = await checkoutConEnlace();
    CHECKOUTS.get(g.fila.referencia_externa).estado = 'COMPLETED';
    const { derivarPedidoPorPagoAsentado } = await import('../src/services/webhookPagos.js');
    const avalancha = [
      ...Array.from({ length: 8 }, () => webhookClip({
        resource: 'CHECKOUT', resource_status: 'COMPLETED',
        me_reference_id: String(g.fila.id), payment_request_id: g.fila.referencia_externa,
      })),
    ];
    await Promise.all(avalancha);
    await esperarHasta(async () => (await pedidoDe(g.folio)).estado !== 'pendiente_pago');
    // Reintento desde ESTE proceso (equivale a un reconciliador en otra
    // instancia): la derivacion es reclamable una sola vez.
    const [fila] = await pagosDe(g.folio);
    await Promise.all(Array.from({ length: 3 }, () =>
      derivarPedidoPorPagoAsentado({ pagoId: fila.id, negocioId: NEG, folio: g.folio }).catch(() => {})));
    await esperar(1200);
    assert.strictEqual(await comandasDe(g.folio), 1, `comandas: ${await comandasDe(g.folio)}`);
    const em = await emisionesDe(g.folio);
    assert.strictEqual(em.length, 1, `filas de emision: ${em.length}`);
    assert.strictEqual(em[0].estado, 'saldada');
    assert.strictEqual((await pedidoDe(g.folio)).estado, 'nuevo');
    fxG = g;
  });

  // ═══ H. Reintentos tardíos: nada se duplica ═══════════════════════════════
  await t('H. cinco webhooks tardios + derivacion repetida sobre un pedido YA activado -> cero efectos nuevos', async () => {
    assert.ok(fxG, 'el caso G debio dejar su fixture');
    const { derivarPedidoPorPagoAsentado } = await import('../src/services/webhookPagos.js');
    const [fila] = await pagosDe(fxG.folio);
    await Promise.all([
      ...Array.from({ length: 5 }, () => webhookClip({
        resource: 'CHECKOUT', resource_status: 'COMPLETED',
        me_reference_id: String(fila.id), payment_request_id: fila.referencia_externa,
      })),
      derivarPedidoPorPagoAsentado({ pagoId: fila.id, negocioId: NEG, folio: fxG.folio }).catch(() => {}),
    ]);
    await esperar(1200);
    assert.strictEqual(await comandasDe(fxG.folio), 1, `comandas: ${await comandasDe(fxG.folio)}`);
    assert.strictEqual((await emisionesDe(fxG.folio)).length, 1);
    assert.strictEqual((await pagosDe(fxG.folio)).length, 1, 'aparecio otra fila de pago');
  });

  // ═══ I. Vencido: jamás se activa ══════════════════════════════════════════
  await t('I. el pago vence sin cobrarse -> pedido cancelado, cero comanda, cero emision, registro tecnico conservado', async () => {
    const v = await checkoutConEnlace();
    await pool.query(`UPDATE pagos SET xabor_espera_hasta = NOW() - interval '2 minutes' WHERE id = $1`, [v.fila.id]);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    const p = await esperarHasta(async () => {
      const x = await pedidoDe(v.folio);
      return x.estado === 'cancelado' ? x : null;
    });
    assert.ok(p, `el vencimiento no cancelo el pedido (estado: ${(await pedidoDe(v.folio)).estado})`);
    assert.strictEqual(await comandasDe(v.folio), 0);
    assert.strictEqual((await emisionesDe(v.folio)).length, 0, 'un vencido dejo emision');
    assert.strictEqual((await pagosDe(v.folio))[0].estado, 'vencido');
    fxVencido = v;
  });

  // ═══ J. Pago tardío sobre pedido cancelado: cero activación ═══════════════
  await t('J. un COMPLETED tardio sobre el pedido ya cancelado NO lo revive: cero comanda, cero emision', async () => {
    assert.ok(fxVencido, 'el caso I debio dejar su fixture');
    const ck = fxVencido.fila.referencia_externa;
    CHECKOUTS.get(ck).estado = 'COMPLETED';
    await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: String(fxVencido.fila.id), payment_request_id: ck,
    });
    await esperar(1200);
    assert.strictEqual((await pedidoDe(fxVencido.folio)).estado, 'cancelado', 'el pago tardio revivio el pedido');
    assert.strictEqual(await comandasDe(fxVencido.folio), 0, 'el pago tardio imprimio');
    assert.strictEqual((await emisionesDe(fxVencido.folio)).length, 0);
  });

  // ═══ K. requiere_revision: fail closed, sin activación automática ═════════
  await t('K. pago en requiere_revision -> cero activacion automatica, sin re-cobro, pendiente para revision', async () => {
    // K1: revision real por dinero que no cuadra (monto del proveedor
    // distinto): la verificacion la rechaza y NO activa nada.
    const k = await checkoutConEnlace();
    const ck = k.fila.referencia_externa;
    CHECKOUTS.get(ck).monto = 999;
    CHECKOUTS.get(ck).estado = 'COMPLETED';
    await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: String(k.fila.id), payment_request_id: ck,
    });
    await esperar(1200);
    assert.strictEqual((await pedidoDe(k.folio)).estado, 'pendiente_pago', 'monto ajeno activo el pedido');
    assert.strictEqual(await comandasDe(k.folio), 0);
    const [filaK] = await pagosDe(k.folio);
    assert.strictEqual(filaK.metadata_sanitizada?.anomalia, 'monto_distinto', 'sin anomalia durable');
    // K2: fila marcada requiere_revision (estado que CLIP-C u otros caminos
    // certificados producen): la tienda no ofrece re-cobro ni activa nada.
    await pool.query(`UPDATE pagos SET estado='requiere_revision' WHERE id=$1`, [k.fila.id]);
    const g = await getPago(k.tracking);
    assert.strictEqual(g.body.pagoEstado, 'requiere_revision');
    assert.strictEqual(g.body.esperandoPago, true);
    assert.strictEqual((await pedidoDe(k.folio)).estado, 'pendiente_pago');
  });

  // ═══ L. Otros canales conservan su comportamiento ═════════════════════════
  await t('L. un pendiente_pago de OTRO canal (anticipo WhatsApp) SI puede moverse desde el panel; el de tienda no', async () => {
    // Ambos fixtures existian ANTES de arrancar el server (los cargo el boot).
    const rWA = await patchEstado('TSP-L-WA', 'nuevo');
    assert.strictEqual(rWA.status, 200,
      `el canal whatsapp quedo bloqueado por la regla de tienda: ${rWA.status} ${JSON.stringify(rWA.body)}`);
    const rTienda = await patchEstado('TSP-L-TIENDA', 'nuevo');
    assert.strictEqual(rTienda.status, 409, `tienda sin pagar se movio: ${rTienda.status}`);
    assert.strictEqual(rTienda.body.codigo, 'PAGO_PENDIENTE');
  });

  // ═══ M. Tracking: pendiente ≠ confirmado ══════════════════════════════════
  await t('M. tracking publico: pendiente dice esperando pago; pagado dice pedido confirmado', async () => {
    const m = await checkoutConEnlace();
    let g = await getPago(m.tracking);
    assert.strictEqual(g.body.esperandoPago, true);
    assert.notStrictEqual(g.body.pagoEstado, 'pagado');
    await pagarEnMock(m.fila);
    g = await esperarHasta(async () => {
      const x = await getPago(m.tracking);
      return (x.body.pagoEstado === 'pagado' && x.body.esperandoPago === false) ? x : null;
    });
    assert.ok(g, 'el tracking nunca reporto pagado');
    const s = await getSeguimiento(m.tracking);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.body.etapas[0].etiqueta, 'Pedido confirmado',
      `primera etapa: ${s.body.etapas[0].etiqueta}`);
    // Y la pagina publica lleva el cableado que suprime la linea de tiempo
    // operativa mientras se espera el pago.
    const html = await fetch(`${base}/seguimiento/x`).then(x => x.text());
    assert.ok(html.includes('esperandoPago') && html.includes('¡Pedido confirmado!'),
      'la pagina de seguimiento perdio la presentacion pendiente/confirmado');
  });

  // ═══ N. Panel: presentación del pago y del origen ═════════════════════════
  await t('N. el panel presenta "Pago en línea · ✓ Pagado" y "🌐 Tienda en línea" (sin tocar valores internos)', async () => {
    // El pedido activado de F conserva su valor interno intacto...
    const p = await pedidoDe(fx.folio);
    assert.strictEqual(p.datos.forma_pago, 'enlace_pago', 'el valor interno cambio');
    assert.strictEqual(p.datos.canal, 'tienda_online');
    // ...y el panel servido lleva el mapper de presentacion y el filtro del
    // tablero (si alguien los borra, esto se pone rojo).
    const html = await fetch(`${base}/app`, { headers: { Cookie: ADMIN } }).then(x => x.text());
    assert.ok(html.includes('Pago con tarjeta en línea · ✓ Pagado') && html.includes('Pago con tarjeta en línea · Pendiente'),
      'el panel perdio la etiqueta humana del pago en linea');
    assert.ok(html.includes('🌐 Tienda en línea'), 'el panel perdio el distintivo de origen');
    assert.ok(html.includes("etiquetaFormaPago") && html.includes("etiquetaCanal"),
      'el panel perdio los mappers de presentacion');
    assert.ok(html.replace(/\s+/g, ' ').includes("canal === 'tienda_online' && pedido.estado === 'pendiente_pago'"),
      'el panel perdio la guarda del tablero contra checkouts sin pagar');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try { if (srv) await srv.detener(); } catch { /* abajo */ }
  clipMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-solo-pago-online: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
