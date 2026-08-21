// ─── P0 Tienda: la UI pública conectada al pago en línea ───────────────────
//
// La auditoría encontró que el backend de pago de la tienda (POST/GET
// /api/tienda/seguimiento/:token/pago → pagosService.crearEnlacePago) existía
// y estaba probado, pero NINGUNA página lo llamaba: el cliente que elegía
// "Pagar en línea" veía "Pedido recibido" y jamás recibía el enlace.
//
// Esta suite cierra ese flujo por las RUTAS reales:
//   checkout → pendiente_pago → POST pago (enlace idempotente) → Clip (mock)
//   → webhook verificado → pagado → comanda → GET estado para el seguimiento.
// Y fija el cableado de las páginas públicas: /t/:slug y /seguimiento/:token
// deben contener la superficie de pago (si alguien la borra, esto se pone rojo).
//
// Cero Clip real. Cero producción. Mismos mocks/fixtures de la batería.
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

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const SLUG = 'pago-ui-test';
const PUERTO = String(process.env.TEST_PORT_TPU || 4381);
const PUERTO_CLIP = Number(process.env.TEST_PORT_TPU_CLIP || 4382);
const base = `http://localhost:${PUERTO}`;
const token = () => randomBytes(24).toString('hex');
let PRODUCTO = null;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mock de Clip v2 (forma documentada; el GET refleja external_reference) ──
let checkoutsClip = 0;
const CHECKOUTS = new Map();      // id -> { referencia, estado, monto, expiresAt }
const REQUESTS = [];
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      REQUESTS.push(body);
      const id = `clip-tpu-${++checkoutsClip}`;
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
        created_at: '2026-08-20T00:00:00Z', expires_at: c.expiresAt || null,
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

// ── Helpers de rutas públicas ───────────────────────────────────────────────
const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const postPago = (tk) => fetch(`${base}/api/tienda/seguimiento/${encodeURIComponent(tk)}/pago`, { method: 'POST' })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const getPago = (tk) => fetch(`${base}/api/tienda/seguimiento/${encodeURIComponent(tk)}/pago`)
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const carrito = (tk, metodoPago, extra = {}) => ({
  checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente pago UI', telefono: '8997200001' },
  metodoPago, ...extra,
});

async function pedidoDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG]);
  return r || null;
}
async function trabajosDeFolio(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id = $1 AND origen_tipo = 'pedido' AND origen_id = $2`, [NEG, folio]);
  return r.n;
}
async function pagosDeFolio(folio) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 ORDER BY created_at`, [NEG, folio]);
  return rows;
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 150 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}

// Confirmación por el camino REAL: webhook de Clip (no firmado) que el
// servidor re-verifica contra el mock antes de asentar. Contrato moderno:
// me_reference_id = pagos.id (UUID de 36).
async function pagarEnMock(fila) {
  const ck = fila.referencia_externa;
  assert.ok(CHECKOUTS.has(ck), `el mock no conoce el checkout ${ck}`);
  CHECKOUTS.get(ck).estado = 'COMPLETED';
  const r = await fetch(`${base}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: String(fila.id), payment_request_id: ck,
    }),
  });
  assert.strictEqual(r.status, 200, 'el webhook no acuso 200');
}

// ── Fixture (mismo patrón que fase-pagos-online-tienda) ─────────────────────
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

async function limpiar() {
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM pagos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
    [NEG]).catch(() => {});
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id IN ($1,$2)`, [NEG, NEG_B]);
  // Misma higiene que carreras-cliente: compras_reales del telefono propio de
  // esta suite, para no envenenar promociones de primera compra de otros.
  await pool.query(
    `DELETE FROM compras_reales WHERE negocio_id = $1 AND cliente_telefono = '8997200001'`,
    [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'PagoUI (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'PagoUI (test)'`, [NEG]);
}

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC PAGO UI' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora pago ui', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora pago ui' },
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
     VALUES ($1,'PagoUI (test)',TRUE,975) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto pago UI',300,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
  await metodos(['efectivo', 'enlace_pago']);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'Pago UI',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  await montarImpresion();
  await conectarProveedor();
}

// Un pedido pendiente_pago con enlace ya creado: el fixture de la mayoría.
async function pedidoConEnlace() {
  const tk = token();
  const r = await comprar(carrito(tk, 'enlace_pago'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const pago = await postPago(r.body.trackingToken);
  assert.strictEqual(pago.status, 200, JSON.stringify(pago.body));
  const [fila] = await pagosDeFolio(r.body.folio);
  assert.ok(fila, 'no se creo la fila de pagos');
  return { folio: r.body.folio, tracking: r.body.trackingToken, fila, url: pago.body.url };
}

let srv = null;
try {
  await preparar();
  srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

  // ═══ 1. Regla del canal: la tienda en línea SOLO cobra en línea ═══════════
  // (Antes este caso aseraba que el efectivo imprimía comanda inmediata; esa
  // regla se invirtió a propósito: tienda_online no ofrece "paga después".)
  await t('1. checkout con EFECTIVO: rechazado por el servidor, cero pedido — la tienda solo cobra en línea', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'efectivo'));
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'METODO_PAGO_INVALIDO');
    const { rows } = await pool.query(
      `SELECT 1 FROM tienda_pedidos WHERE negocio_id=$1 AND checkout_token=$2 AND pedido_folio IS NOT NULL`, [NEG, tk]);
    assert.strictEqual(rows.length, 0, 'el efectivo creo un pedido');
    // Y la tienda publica ofrece UNICAMENTE pago en linea.
    const m = await fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`).then(x => x.json());
    assert.deepStrictEqual((m.metodos || []).map(x => x.id), ['enlace_pago']);
  });

  // ═══ 2. enlace_pago: nace pendiente_pago, cero comandas ══════════════════
  await t('2. checkout con ENLACE_PAGO: pendiente_pago y CERO comandas hasta que entre el dinero', async () => {
    const r = await comprar(carrito(token(), 'enlace_pago'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await pedidoDe(r.body.folio)).estado, 'pendiente_pago');
    await esperar(700);
    assert.strictEqual(await trabajosDeFolio(r.body.folio), 0, 'imprimio sin cobrar');
  });

  // ═══ 3. El frontend dispone del token y las páginas llevan el cableado ═══
  await t('3. el checkout devuelve trackingToken y las páginas públicas contienen la superficie de pago', async () => {
    const r = await comprar(carrito(token(), 'enlace_pago'));
    assert.match(String(r.body.trackingToken || ''), /^[a-f0-9]{48}$/,
      'el checkout no devolvio un trackingToken utilizable');
    assert.strictEqual(r.body.metodoPago?.pagaDespues, false,
      'la respuesta no distingue que enlace_pago se paga antes');
    // El cableado vive en los HTML públicos: si alguien lo borra, esto se pone
    // rojo aunque el backend siga perfecto (exactamente el P0 de la auditoria).
    const tienda = await fetch(`${base}/t/${SLUG}`).then(x => x.text());
    assert.ok(tienda.includes("/pago'") && tienda.includes('Pagar ahora')
      && tienda.includes('Falta completar tu pago'),
      '/t/:slug ya no lleva la superficie de pago en linea');
    const seg = await fetch(`${base}/seguimiento/x`).then(x => x.text());
    assert.ok(seg.includes("/pago'") && seg.includes('pagarAhora')
      && seg.includes('Pagar ahora'),
      '/seguimiento ya no lleva la superficie de pago en linea');
  });

  // ═══ 4. POST pago devuelve el enlace del servidor ════════════════════════
  let fx = null; // fixture compartido para 5, 6, 7, 12, 13
  await t('4. POST /seguimiento/:token/pago crea el enlace por el camino moderno (pagos.id de 36 como external_reference)', async () => {
    fx = await pedidoConEnlace();
    assert.ok(fx.url && fx.url.startsWith('https://pago.mock.clip/'),
      `la URL no vino del proveedor del negocio: ${fx.url}`);
    assert.strictEqual(fx.fila.estado, 'pendiente');
    const enviado = REQUESTS[REQUESTS.length - 1]?.metadata?.external_reference;
    assert.strictEqual(enviado, String(fx.fila.id), 'external_reference no es pagos.id');
    assert.strictEqual(String(enviado).length, 36);
  });

  // ═══ 5. Idempotencia del POST ════════════════════════════════════════════
  await t('5. POST repetido devuelve el MISMO enlace: una fila, un checkout, cero doble cobro', async () => {
    const antes = checkoutsClip;
    const r2 = await postPago(fx.tracking);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body.url, fx.url, 'el segundo POST devolvio otra URL');
    assert.strictEqual(r2.body.reutilizado, true, 'el backend no reporto reutilizacion');
    assert.strictEqual(checkoutsClip, antes, 'se creo un segundo checkout en el proveedor');
    assert.strictEqual((await pagosDeFolio(fx.folio)).length, 1, 'aparecio una segunda fila de pagos');
  });

  // ═══ 6. GET pendiente ════════════════════════════════════════════════════
  await t('6. GET estado con pago pendiente: esperandoPago=true, pagoEstado=pendiente, folio correcto', async () => {
    const g = await getPago(fx.tracking);
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.body.folio, fx.folio);
    assert.strictEqual(g.body.esperandoPago, true);
    assert.strictEqual(g.body.pagoEstado, 'pendiente');
  });

  // ═══ 7. Pago real (webhook verificado) → pagado + comanda exactamente una ═
  await t('7. el cliente paga en Clip (mock): webhook verificado asienta, GET dice pagado y sale UNA comanda', async () => {
    await pagarEnMock(fx.fila);
    const pagada = await esperarHasta(async () => {
      const [f] = await pagosDeFolio(fx.folio);
      return f?.estado === 'pagado' ? f : null;
    });
    assert.ok(pagada, `el pago no se asento (estado: ${(await pagosDeFolio(fx.folio))[0]?.estado})`);
    const g = await esperarHasta(async () => {
      const x = await getPago(fx.tracking);
      return (x.body.pagoEstado === 'pagado' && x.body.esperandoPago === false) ? x : null;
    });
    assert.ok(g, 'el GET nunca reporto pagado/no-esperando');
    const comandas = await esperarHasta(async () => (await trabajosDeFolio(fx.folio)) === 1 ? 1 : null);
    assert.strictEqual(comandas, 1, `comandas: ${await trabajosDeFolio(fx.folio)} (debe ser exactamente 1)`);
    assert.notStrictEqual((await pedidoDe(fx.folio)).estado, 'pendiente_pago');
  });

  // ═══ 12. Pagado: la UI ya no puede volver a cobrar ═══════════════════════
  await t('12. tras el pago, POST devuelve no_requiere_pago con url null: la UI oculta "Pagar ahora"', async () => {
    const r = await postPago(fx.tracking);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.estado, 'no_requiere_pago');
    assert.strictEqual(r.body.url, null);
  });

  // ═══ 13. Refresh: consultar N veces no crea nada ═════════════════════════
  await t('13. cinco GET seguidos (refresh del seguimiento) no crean checkouts ni filas nuevas', async () => {
    const antesCk = checkoutsClip;
    const antesFilas = (await pagosDeFolio(fx.folio)).length;
    for (let i = 0; i < 5; i++) assert.strictEqual((await getPago(fx.tracking)).status, 200);
    assert.strictEqual(checkoutsClip, antesCk, 'un GET creo un checkout');
    assert.strictEqual((await pagosDeFolio(fx.folio)).length, antesFilas);
  });

  // ═══ 8. Vencido ══════════════════════════════════════════════════════════
  await t('8. enlace vencido: GET reporta vencido; el pedido cancelado NO ofrece regenerar (POST responde cancelado)', async () => {
    const v = await pedidoConEnlace();
    await pool.query(
      `UPDATE pagos SET xabor_espera_hasta = NOW() - interval '2 minutes' WHERE id = $1`, [v.fila.id]);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    const g = await esperarHasta(async () => {
      const x = await getPago(v.tracking);
      return x.body.pagoEstado === 'vencido' ? x : null;
    });
    assert.ok(g, 'el GET nunca reporto vencido');
    assert.strictEqual(g.body.esperandoPago, false, 'un pedido expirado no puede seguir esperando pago');
    const p = await postPago(v.tracking);
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.body.estado, 'cancelado', 'un pedido expirado no puede generar otro enlace');
    assert.strictEqual(p.body.url, null);
    assert.strictEqual(await trabajosDeFolio(v.folio), 0, 'un vencido imprimio comanda');
  });

  // ═══ 9. Token inválido: fail closed ══════════════════════════════════════
  await t('9. token invalido o inexistente: 404 sin filtrar nada interno (GET y POST)', async () => {
    for (const malo of ['zzz', randomBytes(24).toString('hex')]) {
      const g = await getPago(malo);
      assert.strictEqual(g.status, 404, `GET con token ${malo.slice(0, 8)}… respondio ${g.status}`);
      assert.ok(!JSON.stringify(g.body).includes(NEG), 'la respuesta filtro el negocio_id');
      const p = await postPago(malo);
      assert.strictEqual(p.status, 404, `POST con token ${malo.slice(0, 8)}… respondio ${p.status}`);
    }
  });

  // ═══ 10. Cross-tenant: un vínculo forjado de otro negocio no filtra nada ═
  // El estado forjado (fila de tienda_pedidos del negocio B apuntando al folio
  // de A) es INALCANZABLE por la superficie pública: pedido_folio solo lo
  // escribe el servidor desde un pedido del MISMO negocio resuelto por slug.
  // Aun así, si existiera, el tenant no se cruza: todas las consultas
  // descendentes van acotadas por tp.negocio_id. Lo que se fija aquí es la
  // FUGA (cero datos de A, cero enlace, cero escritura sobre A), no el status.
  await t('10. un tracking de OTRO negocio apuntando al folio ajeno no revela ni cobra nada del tenant A', async () => {
    const forjado = randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO tienda_pedidos (negocio_id, checkout_token, tracking_token, estado, pedido_folio)
       VALUES ($1, $2, $3, 'creado', $4)`,
      [NEG_B, token(), forjado, fx.folio]);
    const filasAntesA = await pagosDeFolio(fx.folio);
    const g = await getPago(forjado);
    if (g.status === 200) {
      // Nada del pago REAL de A (que esta 'pagado') puede asomarse por B.
      assert.strictEqual(g.body.pagoEstado, null,
        `el estado del pago de A se filtro por el vinculo de B: ${g.body.pagoEstado}`);
      assert.notStrictEqual(g.body.esperandoPago, true, 'B no puede poner a A "esperando pago"');
    } else {
      assert.strictEqual(g.status, 404);
    }
    const p = await postPago(forjado);
    if (p.status === 200) {
      assert.strictEqual(p.body.url, null, 'B obtuvo un ENLACE DE COBRO por el pedido de A');
      assert.notStrictEqual(p.body.estado, 'pendiente_pago', 'B reactivo el cobro del pedido de A');
    } else {
      assert.strictEqual(p.status, 404);
    }
    // Y del lado de A nada cambio: mismas filas de pago, mismo estado.
    const filasDespuesA = await pagosDeFolio(fx.folio);
    assert.strictEqual(filasDespuesA.length, filasAntesA.length, 'el vinculo forjado creo un pago en A');
    assert.strictEqual(filasDespuesA[0].estado, filasAntesA[0].estado);
  });

  // ═══ 11. El navegador no es autoridad del total ══════════════════════════
  await t('11. un total manipulado desde el navegador no cambia ni el pedido ni el monto del cobro', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'enlace_pago', {
      total: 1, subtotal: 1, monto: 0.01, precio: 1,
      items: [{ productoId: PRODUCTO, cantidad: 1, precio: 0.01, precio_unitario: 0.01 }],
    }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = await pedidoDe(r.body.folio);
    assert.strictEqual(Number(p.datos.total), 300, `el total manipulado prospero: ${p.datos.total}`);
    const pago = await postPago(r.body.trackingToken);
    assert.strictEqual(pago.status, 200);
    const [fila] = await pagosDeFolio(r.body.folio);
    assert.strictEqual(Number(fila.monto), 300, `el monto del cobro no es el del servidor: ${fila.monto}`);
    assert.strictEqual(REQUESTS[REQUESTS.length - 1].amount, 300, 'a Clip viajo un monto manipulado');
  });

  // ═══ 14. Avalancha de POST: un solo checkout ═════════════════════════════
  await t('14. cinco POST de pago simultaneos (reintentos de red) -> un checkout, una fila, una URL', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'enlace_pago'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const antes = checkoutsClip;
    const respuestas = await Promise.all(
      Array.from({ length: 5 }, () => postPago(r.body.trackingToken)));
    const oks = respuestas.filter(x => x.status === 200 && x.body.url);
    assert.ok(oks.length >= 1, `ninguna de las 5 obtuvo enlace: ${JSON.stringify(respuestas.map(x => x.status))}`);
    const urls = new Set(oks.map(x => x.body.url));
    assert.strictEqual(urls.size, 1, `hubo ${urls.size} URLs distintas para el mismo pedido`);
    assert.strictEqual(checkoutsClip, antes + 1,
      `el proveedor recibio ${checkoutsClip - antes} POST de creacion (debe ser 1)`);
    assert.strictEqual((await pagosDeFolio(r.body.folio)).length, 1);
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

console.log(`\n═══ fase-tienda-pago-online-ui: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
