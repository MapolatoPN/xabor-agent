// WEBHOOK REAL DE CLIP (checkout-api) + coherencia del panel tras refresh.
//
// Producción demostró (XAB-0179) que Clip NO envía el esquema documentado
// {resource, resource_status, me_reference_id}: envía
//   { id: "<payment_request_id>", origin: "checkout-api", event_type: "INSERT"|"UPDATE" }
// El handler descartaba TODOS esos avisos y el dinero solo se asentaba en el
// tick de 5 minutos del reconciliador.
//
// Reglas que esta suite fija:
//   · el webhook JAMÁS asienta: solo dispara la MISMA reconsulta autenticada.
//   · `id` se resuelve por pagos.referencia_externa (payment_request_id),
//     NUNCA por pagos.id (que es el external_reference que viaja HACIA Clip).
//   · event_type es informativo (INSERT/UPDATE/desconocido → requery igual).
//   · origin != checkout-api → fail closed, sin siquiera consultar.
//   · duplicados → una sola transición, una sola emisión, un solo pago.
//   · tras asentar, el pedido servido al panel queda pago_confirmado (el
//     replay del refresh sale de ese store).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import assert from 'assert';
import { randomBytes } from 'crypto';
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
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 200 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}

const NEG = SEED.negocioA;
const suf = Date.now().toString().slice(-6);
const PUERTO = String(4800 + (Number(suf) % 90));
const PUERTO_CLIP = Number(PUERTO) + 100;
const TEL = `8997800${suf.slice(-3)}`;
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;

// ── Mock de Clip ────────────────────────────────────────────────────────────
let nCheckouts = 0;
let getsAlProveedor = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-ck-${suf}-${++nCheckouts}`;
      const expiresAt = body.expires_at
        ? new Date(Date.parse(body.expires_at)).toISOString()
        : new Date(Date.now() + 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount), expiresAt,
      });
      res.end(JSON.stringify({
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), expires_at: expiresAt,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      getsAlProveedor++;
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED' : 'CHECKOUT_PENDING';
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: id, status,
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: '2026-08-22T00:00:00Z', expires_at: c.expiresAt || null,
        last_status_message: status,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => clipMock.listen(PUERTO_CLIP, r));

let BASE = null;
const webhook = (cuerpo) => fetch(`${BASE}/webhook/clip`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
});
const filaPago = async (folio) => (await pool.query(
  `SELECT id, estado, referencia_externa, monto FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`,
  [NEG, folio])).rows[0];
const pedidoDe = async (folio) => (await pool.query(
  `SELECT estado, datos FROM pedidos_activos WHERE negocio_id = $1 AND folio = $2`, [NEG, folio])).rows[0];
const emisionesDe = async (folio) => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM pedido_emisiones WHERE negocio_id = $1 AND folio = $2`,
  [NEG, folio])).rows[0].n;

async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id = $1 AND pedido_folio IN (SELECT folio FROM pedidos_activos WHERE datos->'cliente'->>'telefono' = $2)`, [NEG, TEL]);
  await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id = $1 AND folio IN (SELECT folio FROM pedidos_activos WHERE datos->'cliente'->>'telefono' = $2)`, [NEG, TEL]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->'cliente'->>'telefono' = $2`, [NEG, TEL]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'CKA %'`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'CKA %'`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip')`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip'`, [NEG]);
}

async function pedidoConCheckout(total = 100) {
  const { registrarPedido } = await import('../src/orders/orderManager.js');
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  const p = await registrarPedido({
    cliente: { nombre: 'Cliente CKA', telefono: TEL },
    modalidad: 'recoger en tienda',
    items: [{ nombre: `CKA Producto ${suf}`, cantidad: 1, precio_unitario: total }],
    subtotal: total, costo_envio: 0, descuento: 0, total, forma_pago: 'efectivo',
    canal: 'test', negocioId: NEG,
  }, 'test');
  await crearEnlacePago({ negocioId: NEG, pedidoId: p.id, actor: null });
  const pago = await filaPago(p.id);
  return { folio: p.id, pago, checkoutId: pago.referencia_externa };
}

let srv = null;
try {
  await limpiar();
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'CKA Cat (test)',TRUE,993) RETURNING id`, [NEG]);
  await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,100,TRUE,FALSE,1)`, [NEG, cat.id, `CKA Producto ${suf}`]);
  await pool.query(
    `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden, disponible_para_bot)
     VALUES ($1,'efectivo',TRUE,1,TRUE) ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG]);
  const { guardarCredencialesClip, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
  await guardarCredencialesClip(NEG, `CKAKEY${suf}`, `CKASECRET${suf}`, SEED.superadminUsuarioId);
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);

  srv = await arrancarServidor(
    { PORT: PUERTO, CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}` }, { timeoutMs: 60000 });
  BASE = srv.base;

  let fx1 = null;
  await t('1. {id, origin:checkout-api, event_type:INSERT} + Clip PENDING => NO asienta (fail closed)', async () => {
    fx1 = await pedidoConCheckout();
    const r = await webhook({ id: fx1.checkoutId, origin: 'checkout-api', event_type: 'INSERT' });
    assert.strictEqual(r.status, 200, 'el webhook debe acusar recibo');
    await esperar(700);
    assert.strictEqual((await filaPago(fx1.folio)).estado, 'pendiente', 'asento sin dinero real');
  });

  await t('2. mismo payload con Clip COMPLETED => asienta por el camino rapido', async () => {
    CHECKOUTS.get(fx1.checkoutId).estado = 'COMPLETED';
    const r = await webhook({ id: fx1.checkoutId, origin: 'checkout-api', event_type: 'INSERT' });
    assert.strictEqual(r.status, 200);
    const ok = await esperarHasta(async () => (await filaPago(fx1.folio)).estado === 'pagado');
    assert.ok(ok, `no asento: ${(await filaPago(fx1.folio)).estado}`);
  });

  await t('3. event_type UPDATE + Clip COMPLETED => asienta', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    const r = await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' });
    assert.strictEqual(r.status, 200);
    const ok = await esperarHasta(async () => (await filaPago(fx.folio)).estado === 'pagado');
    assert.ok(ok, 'UPDATE no asento');
  });

  await t('4. el id se resuelve por referencia_externa; enviar pagos.id NO asienta', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    assert.notStrictEqual(fx.pago.id, fx.checkoutId, 'fixture invalido: los dos ids coinciden');
    const r = await webhook({ id: fx.pago.id, origin: 'checkout-api', event_type: 'UPDATE' });
    assert.strictEqual(r.status, 200);
    await esperar(700);
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pendiente',
      'resolvio el webhook por pagos.id: confusion de identificadores');
    const r2 = await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' });
    assert.strictEqual(r2.status, 200);
    const ok = await esperarHasta(async () => (await filaPago(fx.folio)).estado === 'pagado');
    assert.ok(ok, 'el id correcto no asento');
  });

  await t('5. origin distinto de checkout-api => no asienta ni consulta al proveedor', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    const antes = getsAlProveedor;
    const r = await webhook({ id: fx.checkoutId, origin: 'otra-api', event_type: 'UPDATE' });
    assert.strictEqual(r.status, 200);
    await esperar(700);
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pendiente', 'un origin desconocido asento');
    assert.strictEqual(getsAlProveedor, antes, 'consulto al proveedor con un origin no soportado');
  });

  await t('6. body no interpretable (texto, array, vacio) => 200 y cero efectos', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    for (const cuerpo of ['no soy json', '[1,2,3]', '']) {
      const r = await webhook(cuerpo);
      // 200 (el handler lo ignora) o 400 (express.json rechaza un JSON
      // malformado antes de llegar aqui): ambos son fail-closed. Lo que se
      // exige es que NADA cambie.
      assert.ok([200, 400].includes(r.status), `status inesperado ${r.status} para ${JSON.stringify(cuerpo)}`);
    }
    await esperar(700);
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pendiente');
  });

  await t('7. esquema historico {resource,resource_status,me_reference_id} sigue asentando', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    const r = await webhook({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: String(fx.pago.id), payment_request_id: fx.checkoutId,
    });
    assert.strictEqual(r.status, 200);
    const ok = await esperarHasta(async () => (await filaPago(fx.folio)).estado === 'pagado');
    assert.ok(ok, 'se rompio el camino historico');
  });

  await t('8. INSERT + UPDATE + UPDATE del mismo checkout => una transicion, una emision, un pago', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    const rs = await Promise.all([
      webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'INSERT' }),
      webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' }),
      webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' }),
    ]);
    for (const r of rs) assert.strictEqual(r.status, 200);
    const ok = await esperarHasta(async () => (await filaPago(fx.folio)).estado === 'pagado');
    assert.ok(ok, 'ningun duplicado asento');
    await esperar(900);
    assert.strictEqual(await emisionesDe(fx.folio), 1, 'emisiones duplicadas');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [NEG, fx.folio]);
    assert.strictEqual(rows[0].n, 1, 'se crearon pagos duplicados');
  });

  await t('9. event_type desconocido: dispara requery pero NO asienta si Clip dice PENDING', async () => {
    const fx = await pedidoConCheckout();
    const antes = getsAlProveedor;
    const r = await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'FUTURO_DESCONOCIDO' });
    assert.strictEqual(r.status, 200);
    await esperar(700);
    assert.ok(getsAlProveedor > antes, 'no consulto al proveedor con un event_type nuevo');
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pendiente', 'un event_type desconocido asento solo');
  });

  await t('10. si el checkout del proveedor apunta a otra referencia, NO se asienta', async () => {
    const fx = await pedidoConCheckout();
    const ck = CHECKOUTS.get(fx.checkoutId);
    ck.estado = 'COMPLETED';
    ck.referencia = randomBytes(18).toString('hex');
    const r = await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' });
    assert.strictEqual(r.status, 200);
    await esperar(800);
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pendiente',
      'asento un checkout cuya referencia no es de esta fila');
  });

  await t('11. asentar un pago deja el pedido servido al panel con pago_confirmado (replay coherente)', async () => {
    // OJO: el webhook HTTP lo procesa el servidor HIJO, con su propia memoria.
    // El invariante que importa -- "asentar sincroniza el store que alimenta el
    // replay del panel" -- se ejercita AQUI, en el proceso donde vive el
    // pedido, por el MISMO camino que usan webhook y reconciliador.
    const fx = await pedidoConCheckout();
    const { obtenerPedidos } = await import('../src/orders/orderManager.js');
    const antes = obtenerPedidos(NEG).find((p) => p.id === fx.folio);
    assert.ok(antes, 'el pedido no esta en el store del panel');
    assert.notStrictEqual(antes.pago_confirmado, true, 'nacio marcado como pagado');

    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    const { verificarYAsentarClip, derivarPedidoPorPagoAsentado } = await import('../src/services/webhookPagos.js');
    const { rows: [completo] } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [NEG, fx.folio]);
    const r = await verificarYAsentarClip({ pago: completo, checkoutId: fx.checkoutId });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    await derivarPedidoPorPagoAsentado({ pagoId: completo.id, negocioId: NEG, folio: fx.folio });

    const servido = obtenerPedidos(NEG).find((x) => x.id === fx.folio);
    assert.ok(servido, 'el pedido desaparecio del store');
    assert.strictEqual(servido.pago_confirmado, true,
      'el replay seguiria mostrando PENDIENTE tras un refresh');
    assert.strictEqual((await pedidoDe(fx.folio)).datos.pago_confirmado, true, 'la base y la memoria discrepan');
  });

  await t('12. reconstruccion desde la base (equivalente a restart) conserva pagado', async () => {
    const { cargarPedidosDesdeDB, obtenerPedidos } = await import('../src/orders/orderManager.js');
    const { rows: [pagado] } = await pool.query(
      `SELECT folio FROM pedidos_activos
        WHERE negocio_id = $1 AND datos->>'pago_confirmado' = 'true' AND datos->'cliente'->>'telefono' = $2
        LIMIT 1`, [NEG, TEL]);
    assert.ok(pagado, 'no hay pedido pagado para probar el restart');
    await cargarPedidosDesdeDB();
    const p = obtenerPedidos(NEG).find((x) => x.id === pagado.folio);
    assert.ok(p, 'el pedido desaparecio tras recargar desde la base');
    assert.ok(p.pago_confirmado === true || p.datos?.pago_confirmado === true,
      'tras un restart el panel mostraria pendiente un pedido pagado');
  });

  await t('13. un webhook duplicado posterior NO devuelve el pedido a pendiente', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' });
    assert.ok(await esperarHasta(async () => (await filaPago(fx.folio)).estado === 'pagado'), 'no asento');
    await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' });
    await esperar(800);
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pagado', 'un duplicado degrado el pago');
    // El duplicado tampoco puede degradar la BASE (el store del panel del
    // proceso servidor se prueba en el caso 11, que corre en esta memoria).
    assert.strictEqual((await pedidoDe(fx.folio)).datos.pago_confirmado, true,
      'el duplicado dejo el pedido como no pagado en la base');
  });

  await t('14. el reconciliador despues del webhook tampoco lo revierte', async () => {
    const fx = await pedidoConCheckout();
    CHECKOUTS.get(fx.checkoutId).estado = 'COMPLETED';
    await webhook({ id: fx.checkoutId, origin: 'checkout-api', event_type: 'UPDATE' });
    assert.ok(await esperarHasta(async () => (await filaPago(fx.folio)).estado === 'pagado'), 'no asento');
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const { rows: [completo] } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [NEG, fx.folio]);
    await verificarYAsentarClip({ pago: completo, checkoutId: fx.checkoutId });
    assert.strictEqual((await filaPago(fx.folio)).estado, 'pagado', 'la reconciliacion degrado un pago asentado');
    assert.strictEqual(await emisionesDe(fx.folio), 1, 'la reconciliacion duplico la emision');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try {
    if (srv) { srv.detener(); await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); }); }
  } catch { /* abajo */ }
  clipMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-clip-webhook-checkout-api: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
