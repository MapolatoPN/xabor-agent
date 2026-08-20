// ─── Expiración real: el deadline de Xabor no es la expiración del proveedor ─
//
// Tres cosas que esta suite se niega a confundir:
//
//   1. `pagos.xabor_espera_hasta` — hasta cuándo XABOR espera el pago. Es una
//      decisión de producto, configurable por negocio.
//   2. `pagos.expires_at` — expiración declarada por el PROVEEDOR. Es un hecho
//      suyo, y es lo único que puede sacar un checkout de la reconciliación.
//   3. `pedidos_activos.estado` — el estado OPERATIVO del pedido.
//
// Vencer en Xabor jamás significa "cancelado en el proveedor": ni Clip ni
// Mercado Pago documentan una cancelación real de checkout. Por eso un intento
// vencido SIGUE siendo reconciliable, y el dinero que llega después es dinero
// real que se asienta — como `pago_tardio`, sin liberar cocina.
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
const NEG_B = SEED.negocioB;
const SECRETO_MP = 'secreto-expiracion';
const PUERTO = Number(process.env.TEST_PORT_EXP || 4331);
const PUERTO_REINICIO = Number(process.env.TEST_PORT_EXP_REINICIO || 4332);
const PUERTO_CLIP = Number(process.env.TEST_PORT_EXP_CLIP || 4333);
const PUERTO_MP = Number(process.env.TEST_PORT_EXP_MP || 4334);
const base = `http://localhost:${PUERTO}`;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mocks (forma DOCUMENTADA de cada API) ───────────────────────────────────
let checkoutsClip = 0;
const CHECKOUTS = new Map();          // linkId -> { referencia, estado, monto, expiraAt }
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-exp-${++checkoutsClip}`;
      const eco = body.expires_at ? new Date(Date.parse(body.expires_at)).toISOString() : new Date(Date.now() + 3 * 24 * 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount), expiraAt: eco,
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
      const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED'
        : c.estado === 'EXPIRED' ? 'CHECKOUT_EXPIRED' : 'CHECKOUT_PENDING';
      res.end(JSON.stringify({
        object_type: 'payment_link',
        payment_request_id: id,
        status,
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
const PREFERENCIAS = new Map();
let checkoutsMP = 0;
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-exp-${++checkoutsMP}`;
      PREFERENCIAS.set(id, { external_reference: p.external_reference });
      res.writeHead(200, { 'Content-Type': 'application/json' });
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

// ── Fixture ─────────────────────────────────────────────────────────────────
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
    { accessToken: 'token-exp', publicKey: 'pk-test', webhookSecret: SECRETO_MP },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'mercado_pago', SEED.superadminUsuarioId);
  const { asegurarRoutingTokenIntegracion } = await import('../src/services/database.js');
  return asegurarRoutingTokenIntegracion(negocioId, 'mercado_pago');
}

async function pedido(folio, monto, { negocioId = NEG, estadoPedido = 'pendiente_pago' } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (folio) DO UPDATE SET estado=$3, datos=$4`,
    [folio, negocioId, estadoPedido, JSON.stringify({
      id: folio, negocioId, canal: 'tienda_online', total: monto, estado: estadoPedido,
      modalidad: 'recoger en tienda', forma_pago: 'enlace de pago', pago_confirmado: false,
      cliente: { nombre: 'Cliente expiración', telefono: '8997500009' },
      items: [{ nombre: 'Producto', cantidad: 1, precio_unitario: monto }],
      timestamp: new Date().toISOString(),
    })]);
}

const crearEnlace = async (folio, negocioId = NEG) => {
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  return crearEnlacePago({ negocioId, pedidoId: folio, actor: SEED.superadminUsuarioId });
};

async function filas(folio, negocioId = NEG) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [negocioId, folio]);
  return rows;
}
const filaId = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [id])).rows[0];
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
async function esperar(condicion, queEsperaba, ms = 10000) {
  const limite = Date.now() + ms;
  for (;;) {
    if (await condicion()) return;
    if (Date.now() > limite) throw new Error(`tiempo agotado esperando: ${queEsperaba}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

/** Empuja el deadline INTERNO al pasado. No toca `expires_at`: son otra cosa. */
const vencerYa = (pagoId) => pool.query(
  `UPDATE pagos SET xabor_espera_hasta = NOW() - interval '2 minutes' WHERE id=$1`, [pagoId]);

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
  const ts = '1700000000', requestId = 'req-exp';
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
  const term = await crearEdge(NEG, { nombre: 'PC EXP' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora exp', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora exp' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'EX-%'`, [n]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [n]);
    await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='pago_online_espera_minutos'`, [n]);
  }
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'EX-%'`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='PC EXP')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='PC EXP' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

let srv = null, srvReinicio = null, TOKEN_MP = null;
const envServidor = {
  CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
  XABOR_MP_API_BASE: `http://localhost:${PUERTO_MP}`,
  XABOR_URL_PUBLICA: base,
};

try {
  await limpiar();
  await montarImpresion();
  srv = await arrancarServidor({ PORT: String(PUERTO), ...envServidor }, { timeoutMs: 90000 });

  const {
    expirarPagosVencidos, verificarYAsentarClip, reconciliarPagosMercadoPago,
  } = await import('../src/services/webhookPagos.js');
  const {
    vencerEsperaDePago, pagosConEsperaVencida, pagosReconciliablesDeProveedor,
    minutosDeEsperaDePago, ESPERA_PAGO_MINUTOS_DEFAULT,
    ESPERA_PAGO_MINUTOS_MIN, ESPERA_PAGO_MINUTOS_MAX,
  } = await import('../src/services/database.js');

  // ═══ 1. EXPIRACIÓN NORMAL ═════════════════════════════════════════════════
  await t('1. vence el plazo: el intento queda vencido y el pedido deja de esperar', async () => {
    const folio = 'EX-0001';
    await pedido(folio, 300);
    await conectarClip();
    await crearEnlace(folio);
    const f = (await filas(folio))[0];

    // El deadline se puso al FINALIZAR la creación, no al insertar la fila:
    // antes de eso no había nada que pagar.
    assert.ok(f.xabor_espera_hasta, 'no se escribió el deadline interno');
    const minutos = (new Date(f.xabor_espera_hasta) - Date.now()) / 60000;
    assert.ok(minutos > 25 && minutos <= 30, `deadline fuera de rango: ${minutos.toFixed(1)} min`);
    // `expires_at` lo dice el PROVEEDOR, no nosotros. Desde CLIP expires_at,
    // Clip DECLARA la expiración efectiva del checkout (expires_at, eco de la
    // solicitada) y esa -- y solo esa -- es la que puede vivir aquí: debe
    // coincidir con lo que el proveedor devolvió (≈ T solicitada), jamás una
    // decisión interna distinta.
    assert.ok(f.expires_at, 'el proveedor declaró una expiración y no quedó registrada');
    assert.ok(Math.abs(new Date(f.expires_at) - new Date(f.xabor_espera_hasta)) < 1000,
      'pagos.expires_at no es el valor declarado por el proveedor (eco de la T solicitada)');
    assert.strictEqual(f.metadata_sanitizada?.provider_expires_at ? true : false, true,
      'sin rastro de que expires_at vino del proveedor');

    await vencerYa(f.id);
    assert.strictEqual(await expirarPagosVencidos(), 1);

    const v = await filaId(f.id);
    assert.strictEqual(v.estado, 'vencido');
    assert.ok(v.metadata_sanitizada.vencido_por_xabor_at, 'sin rastro de cuándo venció');
    // La historia del checkout se conserva ENTERA: es lo que lo mantiene
    // reconciliable.
    assert.strictEqual(v.referencia_externa, f.referencia_externa, 'se borró la identidad externa');
    assert.strictEqual(v.url, f.url, 'se borró la URL del checkout');

    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'cancelado', 'el pedido siguió esperando un pago que ya no llega');
    assert.strictEqual(p.datos.expirado_por_pago, true,
      'no se distingue de una cancelación manual del negocio');
    assert.strictEqual(await comandasDe(folio), 0, '¡salió comanda de un pedido nunca pagado!');
  });

  await t('1b. el plazo es política del NEGOCIO y se recorta a un rango sano', async () => {
    assert.strictEqual(await minutosDeEsperaDePago(NEG), ESPERA_PAGO_MINUTOS_DEFAULT,
      'sin configurar debía usarse el default');
    const poner = (v) => pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'pago_online_espera_minutos',$2)
       ON CONFLICT (negocio_id, clave) DO UPDATE SET valor=$2`, [NEG, JSON.stringify(v)]);

    await poner(45);
    assert.strictEqual(await minutosDeEsperaDePago(NEG), 45);
    await poner(0);
    assert.strictEqual(await minutosDeEsperaDePago(NEG), ESPERA_PAGO_MINUTOS_MIN,
      'un 0 haría vencer todo al instante');
    await poner(999999);
    assert.strictEqual(await minutosDeEsperaDePago(NEG), ESPERA_PAGO_MINUTOS_MAX,
      'un valor enorme dejaría pedidos colgados para siempre');
    await poner('no es un número');
    assert.strictEqual(await minutosDeEsperaDePago(NEG), ESPERA_PAGO_MINUTOS_DEFAULT);
    // Y sin tenant no se inventa nada.
    assert.strictEqual(await minutosDeEsperaDePago(''), ESPERA_PAGO_MINUTOS_DEFAULT);

    await pool.query(
      `DELETE FROM configuracion WHERE negocio_id=$1 AND clave='pago_online_espera_minutos'`, [NEG]);
  });

  // ═══ 2. DOS EXPIRADORES SIMULTÁNEOS ═══════════════════════════════════════
  await t('2. dos expiradores a la vez sobre el mismo pedido: UNA sola transición', async () => {
    const folio = 'EX-0002';
    await pedido(folio, 410);
    await crearEnlace(folio);
    const f = (await filas(folio))[0];
    await vencerYa(f.id);

    // Directo a la función, que es donde vive la exclusividad. El setInterval
    // sólo dispara: si el lock no estuviera, aquí saldrían dos transiciones.
    const [a, b] = await Promise.all([
      vencerEsperaDePago(f.id, NEG),
      vencerEsperaDePago(f.id, NEG),
    ]);
    const ok = [a, b].filter(r => r.ok).length;
    assert.strictEqual(ok, 1, `${ok} transiciones exitosas; debía ser exactamente 1`);
    const perdedor = [a, b].find(r => !r.ok);
    assert.strictEqual(perdedor.razon, 'ya_no_vencible:vencido',
      `el segundo no vio el estado ya movido: ${perdedor.razon}`);

    assert.strictEqual((await filaId(f.id)).estado, 'vencido');
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
  });

  await t('2b. el job entero es reejecutable: correrlo dos veces no cambia nada', async () => {
    const folio = 'EX-0003';
    await pedido(folio, 250);
    await crearEnlace(folio);
    const f = (await filas(folio))[0];
    await vencerYa(f.id);

    const [x, y] = await Promise.all([expirarPagosVencidos(), expirarPagosVencidos()]);
    assert.strictEqual(x + y, 1, `el job venció ${x + y} veces el mismo pedido`);
    assert.strictEqual(await expirarPagosVencidos(), 0, 'una tercera vuelta volvió a "vencer" algo');
    const marcaPrimera = (await filaId(f.id)).metadata_sanitizada.vencido_por_xabor_at;
    await expirarPagosVencidos();
    assert.strictEqual((await filaId(f.id)).metadata_sanitizada.vencido_por_xabor_at, marcaPrimera,
      'una segunda vuelta reescribió la marca de vencimiento');
  });

  // ═══ 3. EL PAGO GANA LA CARRERA ═══════════════════════════════════════════
  await t('3. el dinero entra antes del deadline: el expirador no toca nada', async () => {
    const folio = 'EX-0004';
    await pedido(folio, 520);
    const r = await crearEnlace(folio);
    const f = (await filas(folio))[0];

    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(f.referencia_interna), 200);
    await esperar(async () => await comandasDe(folio) === 1, 'la comanda del pago a tiempo');

    // Aunque el deadline ya hubiera pasado en el reloj, el pedido está pagado.
    await vencerYa(f.id);
    const candidatos = (await pagosConEsperaVencida(50)).map(p => p.id);
    assert.ok(!candidatos.includes(f.id), 'un pago ya cobrado entró a la cola del expirador');
    const res = await vencerEsperaDePago(f.id, NEG);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.razon, 'ya_no_vencible:pagado');

    assert.strictEqual((await filaId(f.id)).estado, 'pagado');
    const p = await pedidoDe(folio);
    assert.notStrictEqual(p.estado, 'cancelado', '¡canceló un pedido YA PAGADO!');
    assert.strictEqual(await comandasDe(folio), 1);
  });

  await t('3b. hermano pagado: el intento vencible tampoco arrastra el pedido', async () => {
    // El pedido tiene dinero real por OTRO intento. Vencer el intento viejo no
    // puede cancelar un pedido que ya se cobró.
    const folio = 'EX-0005';
    await pedido(folio, 600);
    const r = await crearEnlace(folio);
    const cobrado = (await filas(folio))[0];
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(cobrado.referencia_interna), 200);
    await esperar(async () => (await filaId(cobrado.id)).estado === 'pagado', 'el asiento');

    const { rows: [huerfano] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                          moneda, monto, estado, xabor_espera_hasta)
       VALUES ($1,$2,'clip',$3,'enlace_pago','MXN',600,'pendiente', NOW() - interval '5 minutes')
       RETURNING id`, [NEG, folio, `ref-huerfano-${folio}`]);

    const res = await vencerEsperaDePago(huerfano.id, NEG);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.razon, 'ya_hay_pago_real');
    assert.notStrictEqual((await pedidoDe(folio)).estado, 'cancelado',
      'canceló un pedido con dinero real dentro');
  });

  await t('3c. CARRERA REAL vencimiento vs cobro: nunca queda un mundo incoherente', async () => {
    // Los dos caminos disparados a la vez, sobre la MISMA obligación. Cuál gana
    // no importa; lo que no puede pasar es terminar en los dos mundos: pedido
    // cancelado y cocina liberada, o dinero derivable sobre un pedido vencido.
    for (let i = 0; i < 6; i++) {
      const folio = `EX-03C-${i}`;
      await pedido(folio, 500 + i);
      const r = await crearEnlace(folio);
      const f = (await filas(folio))[0];
      CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
      await vencerYa(f.id);

      const [asiento] = await Promise.all([
        verificarYAsentarClip({ pago: await filaId(f.id), checkoutId: r.referenciaExterna }),
        vencerEsperaDePago(f.id, NEG),
      ]);
      if (asiento.ok) {
        await (await import('../src/services/webhookPagos.js')).derivarPedidoPorPagoAsentado(
          { pagoId: f.id, negocioId: NEG, folio });
      }

      const fin = await filaId(f.id);
      const ped = await pedidoDe(folio);
      const comandas = await comandasDe(folio);
      // El dinero SIEMPRE se asienta: llegó, es real.
      assert.strictEqual(fin.estado, 'pagado', `[${i}] el dinero real no quedó asentado`);
      const cancelado = ped.estado === 'cancelado';
      const tardio = fin.metadata_sanitizada.anomalia === 'pago_tardio';
      assert.strictEqual(cancelado, tardio,
        `[${i}] mundo incoherente: pedido cancelado=${cancelado} pero pago_tardio=${tardio}`);
      assert.strictEqual(comandas, cancelado ? 0 : 1,
        `[${i}] comandas=${comandas} con el pedido en '${ped.estado}'`);
      assert.strictEqual(fin.derivacion_pendiente, false,
        `[${i}] quedó deuda de derivación viva tras la carrera`);
      if (cancelado) {
        assert.notStrictEqual(ped.datos.pago_confirmado, true,
          `[${i}] pedido cancelado marcado como pagado`);
      }
    }
  });

  // ═══ 4. VENCE PRIMERO Y EL PAGO LLEGA DESPUÉS ═════════════════════════════
  await t('4. pago TARDÍO: el dinero se asienta, la cocina NO se libera', async () => {
    const folio = 'EX-0006';
    await pedido(folio, 780);
    const r = await crearEnlace(folio);
    const f = (await filas(folio))[0];
    await vencerYa(f.id);
    assert.strictEqual(await expirarPagosVencidos(), 1);
    assert.strictEqual((await filaId(f.id)).estado, 'vencido');

    // El cliente paga igual: Clip no ofrece cancelación real, el enlace vive.
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(f.referencia_interna), 200);
    await esperar(async () => (await filaId(f.id)).estado === 'pagado',
      'que el dinero tardío quede asentado igual');

    const pagada = await filaId(f.id);
    assert.strictEqual(Number(pagada.monto), 780, 'se perdió el monto real cobrado');
    assert.strictEqual(pagada.metadata_sanitizada.anomalia, 'pago_tardio',
      'el cobro tardío no quedó marcado para revisión');
    assert.strictEqual(pagada.derivacion_pendiente, false,
      'quedó deuda de derivación: el job liberaría un pedido ya vencido');
    assert.ok(pagada.metadata_sanitizada.vencido_por_xabor_at,
      'se borró la historia del vencimiento al asentar');

    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'cancelado', 'el pedido resucitó con un pago tardío');
    assert.notStrictEqual(p.datos.pago_confirmado, true);
    assert.strictEqual(await comandasDe(folio), 0, '¡salió comanda de un pedido ya vencido!');
  });

  // ═══ 5. WEBHOOK DUPLICADO DESPUÉS DE VENCER ═══════════════════════════════
  await t('5. el webhook se repite tras el vencimiento: idempotente, sin doble cobro', async () => {
    const folio = 'EX-0006';                       // el mismo del caso 4
    const f = (await filas(folio))[0];
    const antes = await filaId(f.id);

    for (let i = 0; i < 3; i++) {
      assert.strictEqual(await webhookClip(f.referencia_interna), 200,
        `el reenvío ${i + 1} no fue acusado`);
    }
    await new Promise(r => setTimeout(r, 400));

    const despues = await filaId(f.id);
    assert.strictEqual(despues.estado, 'pagado');
    assert.strictEqual(String(despues.paid_at), String(antes.paid_at),
      'un reenvío movió la fecha de cobro');
    assert.notStrictEqual(despues.metadata_sanitizada.anomalia, 'doble_cobro_real',
      'un reenvío se contó como un segundo cobro real');
    assert.strictEqual((await filas(folio)).length, 1, 'apareció una fila nueva por un reenvío');
    assert.strictEqual(await comandasDe(folio), 0, 'un reenvío terminó liberando la cocina');
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
  });

  // ═══ 6. CLIP VENCIDO EN XABOR SIGUE SIENDO RECONCILIABLE ══════════════════
  await t('6. Clip: vencer en Xabor NO saca el checkout de la reconciliación', async () => {
    const folio = 'EX-0007';
    await pedido(folio, 340);
    const r = await crearEnlace(folio);
    const f = (await filas(folio))[0];
    await vencerYa(f.id);
    assert.strictEqual(await expirarPagosVencidos(), 1);

    // Éste es el invariante que sostiene todo lo demás: Clip no documenta
    // ninguna cancelación de checkout, así que el enlace sigue cobrable y
    // dejar de mirarlo sería perder dinero real en silencio.
    const cola = (await pagosReconciliablesDeProveedor('clip', 100)).map(p => p.id);
    assert.ok(cola.includes(f.id),
      'un intento vencido en Xabor salió de la reconciliación de Clip');

    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    const res = await verificarYAsentarClip({ pago: await filaId(f.id), checkoutId: r.referenciaExterna });
    assert.strictEqual(res.ok, false, 'un cobro sobre pedido vencido no puede reportarse como derivable');
    assert.strictEqual(res.razon, 'transicion_pago_tardio');
    assert.strictEqual((await filaId(f.id)).estado, 'pagado', 'el dinero real no quedó asentado');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  await t('6b. `expires_at` del PROVEEDOR sí puede sacarlo: son cosas distintas', async () => {
    const folio = 'EX-0008';
    await pedido(folio, 210);
    await crearEnlace(folio);
    const f = (await filas(folio))[0];
    // Esto lo escribe el proveedor, no Xabor: es la única expiración que
    // significa "ya no puede recibir dinero".
    await pool.query(`UPDATE pagos SET expires_at = NOW() - interval '1 hour' WHERE id=$1`, [f.id]);
    const cola = (await pagosReconciliablesDeProveedor('clip', 100)).map(p => p.id);
    assert.ok(!cola.includes(f.id),
      'un checkout que el proveedor declaró expirado se sigue consultando para siempre');
  });

  // ═══ 7. MERCADO PAGO VENCIDO EN XABOR SIGUE RECONCILIABLE ═════════════════
  await t('7. Mercado Pago: vencido en Xabor, el cobro tardío se recupera sin webhook', async () => {
    const folio = 'EX-0009';
    await pedido(folio, 915);
    TOKEN_MP = await conectarMP();
    await crearEnlace(folio);
    const f = (await filas(folio)).find(x => x.proveedor === 'mercado_pago');
    assert.ok(f, 'fixture: no se creó el intento de Mercado Pago');
    assert.ok(f.xabor_espera_hasta, 'el intento de MP no recibió deadline interno');

    await vencerYa(f.id);
    assert.strictEqual(await expirarPagosVencidos(), 1);
    assert.strictEqual((await filaId(f.id)).estado, 'vencido');

    const cola = (await pagosReconciliablesDeProveedor('mercado_pago', 100)).map(p => p.id);
    assert.ok(cola.includes(f.id),
      'un intento vencido en Xabor salió de la reconciliación de Mercado Pago');

    // MP tampoco documenta que una preferencia expirada deje de poder pagarse:
    // el dinero puede entrar, y entra.
    PAGOS_MP.set('pay-exp-07', {
      id: 'pay-exp-07', status: 'approved', external_reference: f.referencia_interna,
      transaction_amount: 915, currency_id: 'MXN',
    });
    await reconciliarPagosMercadoPago(50);

    const pagada = await filaId(f.id);
    assert.strictEqual(pagada.estado, 'pagado', 'la reconciliación no recuperó el cobro tardío');
    assert.strictEqual(pagada.metadata_sanitizada.anomalia, 'pago_tardio');
    assert.strictEqual(pagada.derivacion_pendiente, false);
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
    assert.strictEqual(await comandasDe(folio), 0);
  });

  // ═══ 8. EL PEDIDO CAMBIA ANTES DE VENCER ══════════════════════════════════
  await t('8. pedido modificado antes de vencer: el intento viejo no arrastra al pedido', async () => {
    const folio = 'EX-0010';
    await pedido(folio, 400);
    await conectarClip();
    await crearEnlace(folio);
    const v1 = (await filas(folio))[0];

    // El negocio cambia su política JUSTO entre los dos intentos: si el intento
    // nuevo heredara el reloj del viejo en vez de calcular el suyo, aquí se
    // vería.
    await pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'pago_online_espera_minutos','120')
       ON CONFLICT (negocio_id, clave) DO UPDATE SET valor='120'`, [NEG]);
    await pedido(folio, 640);                       // el cliente cambia el pedido
    await crearEnlace(folio);
    await pool.query(
      `DELETE FROM configuracion WHERE negocio_id=$1 AND clave='pago_online_espera_minutos'`, [NEG]);

    const todas = await filas(folio);
    const v2 = todas.find(x => x.id !== v1.id);
    assert.ok(v2, 'el cambio de versión debía abrir un intento nuevo');
    assert.strictEqual((await filaId(v1.id)).estado, 'invalidado',
      'el intento viejo siguió vigente tras cambiar el pedido');
    assert.ok(v2.xabor_espera_hasta, 'el intento nuevo no recibió su propio plazo');
    const minutosV2 = (new Date(v2.xabor_espera_hasta) - Date.now()) / 60000;
    assert.ok(minutosV2 > 115 && minutosV2 <= 120,
      `el intento nuevo heredó el reloj del viejo en vez del suyo: ${minutosV2.toFixed(1)} min`);

    // El intento invalidado ya no es vencible: no puede cancelar el pedido que
    // sigue esperando el cobro nuevo.
    await vencerYa(v1.id);
    const cola = (await pagosConEsperaVencida(50)).map(p => p.id);
    assert.ok(!cola.includes(v1.id), 'un intento invalidado entró a la cola del expirador');
    assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago');

    // Y el nuevo sí vence, con su propio reloj.
    await vencerYa(v2.id);
    assert.strictEqual(await expirarPagosVencidos(), 1);
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
  });

  await t('8b. si quedara OTRO intento vivo, vencer uno no cancela el pedido', async () => {
    // Defensa en profundidad: `idx_pagos_vigente_unico` hace casi imposible dos
    // intentos vivos a la vez, pero una base sin ese índice no puede terminar
    // cancelando un pedido que todavía espera otro cobro.
    const folio = 'EX-0011';
    await pedido(folio, 480);
    await pool.query(`DROP INDEX IF EXISTS idx_pagos_vigente_unico`);
    try {
      const { rows: [viejo] } = await pool.query(
        `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                            moneda, monto, estado, xabor_espera_hasta)
         VALUES ($1,$2,'clip',$3,'enlace_pago','MXN',480,'pendiente', NOW() - interval '5 minutes')
         RETURNING id`, [NEG, folio, `ref-viejo-${folio}`]);
      await pool.query(
        `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                            moneda, monto, estado, xabor_espera_hasta)
         VALUES ($1,$2,'clip',$3,'enlace_pago','MXN',480,'pendiente', NOW() + interval '20 minutes')`,
        [NEG, folio, `ref-nuevo-${folio}`]);

      const res = await vencerEsperaDePago(viejo.id, NEG);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.pedidoVencido, false,
        'canceló un pedido que todavía tenía un intento con plazo por delante');
      assert.ok(res.otroIntentoVivo, 'no reportó el intento vivo que lo detuvo');
      assert.strictEqual((await filaId(viejo.id)).estado, 'vencido',
        'el intento viejo debía morir aunque el pedido siga');
      assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago');
    } finally {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_vigente_unico
           ON pagos (negocio_id, pedido_folio, tipo)
           WHERE estado IN ('creando','pendiente','requiere_revision')`);
    }
  });

  // ═══ 9. CAMBIO DE PROVEEDOR ANTES DE VENCER ═══════════════════════════════
  await t('9. cambia el proveedor antes de vencer: cada intento con su reloj y su cola', async () => {
    const folio = 'EX-0012';
    await pedido(folio, 725);
    await conectarClip();
    await crearEnlace(folio);
    const clip = (await filas(folio))[0];
    assert.strictEqual(clip.proveedor, 'clip');

    TOKEN_MP = await conectarMP();                  // el negocio cambia de proveedor
    await pedido(folio, 730);                       // y el pedido cambia: nuevo intento
    await crearEnlace(folio);
    const mp = (await filas(folio)).find(x => x.proveedor === 'mercado_pago');
    assert.ok(mp, 'no se abrió el intento con el proveedor nuevo');
    assert.ok(mp.xabor_espera_hasta, 'el intento del proveedor nuevo no recibió plazo');

    // El enlace de Clip sigue existiendo allá afuera: nadie lo canceló, porque
    // Clip no ofrece cancelación. Sigue en SU cola de reconciliación.
    const colaClip = (await pagosReconciliablesDeProveedor('clip', 100)).map(p => p.id);
    assert.ok(colaClip.includes(clip.id),
      'el checkout de Clip desapareció de su reconciliación al cambiar de proveedor');

    await vencerYa(mp.id);
    assert.strictEqual(await expirarPagosVencidos(), 1);
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
    // Y el de Clip, aunque el pedido ya venció, sigue vigilado.
    const colaDespues = (await pagosReconciliablesDeProveedor('clip', 100)).map(p => p.id);
    assert.ok(colaDespues.includes(clip.id),
      'tras vencer el pedido se dejó de vigilar un enlace de Clip todavía cobrable');
  });

  // ═══ 10. REINICIO DEL SERVIDOR ════════════════════════════════════════════
  await t('10. reinicio: lo que venció con el proceso caído se recupera al arrancar', async () => {
    const vencible = 'EX-0013';
    const aTiempo = 'EX-0014';
    await pedido(vencible, 190);
    await conectarClip();
    await crearEnlace(vencible);
    await pedido(aTiempo, 260);
    await crearEnlace(aTiempo);
    const fv = (await filas(vencible))[0];
    const fa = (await filas(aTiempo))[0];

    // El proceso muere y el deadline pasa mientras no hay nadie mirando.
    await srv.detener();
    srv = null;
    await vencerYa(fv.id);

    srvReinicio = await arrancarServidor(
      { PORT: String(PUERTO_REINICIO), ...envServidor,
        XABOR_URL_PUBLICA: `http://localhost:${PUERTO_REINICIO}` },
      { timeoutMs: 90000 });

    await esperar(async () => (await filaId(fv.id)).estado === 'vencido',
      'que el arranque recupere lo vencido mientras el proceso estaba caído');
    assert.strictEqual((await pedidoDe(vencible)).estado, 'cancelado');

    // Y el que aún tiene plazo NO se toca por reiniciar.
    assert.strictEqual((await filaId(fa.id)).estado, 'pendiente',
      'el reinicio venció un pago que todavía tenía plazo');
    assert.strictEqual((await pedidoDe(aTiempo)).estado, 'pendiente_pago');

    srv = srvReinicio; srvReinicio = null;
  });

  // ═══ 11. SIN EXPIRACIÓN CRUZADA ENTRE NEGOCIOS ════════════════════════════
  await t('11. el expirador nunca cruza de negocio', async () => {
    const folio = 'EX-0015';
    await pedido(folio, 555, { negocioId: NEG_B });
    const { rows: [pagoB] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo,
                          moneda, monto, estado, xabor_espera_hasta)
       VALUES ($1,$2,'clip',$3,'enlace_pago','MXN',555,'pendiente', NOW() - interval '10 minutes')
       RETURNING id`, [NEG_B, folio, `ref-b-${folio}`]);

    // Con el tenant equivocado no existe. No "falla": no existe.
    const ajeno = await vencerEsperaDePago(pagoB.id, NEG);
    assert.strictEqual(ajeno.ok, false);
    assert.strictEqual(ajeno.razon, 'no_encontrado');
    assert.strictEqual((await filaId(pagoB.id)).estado, 'pendiente',
      '¡venció el pago de otro negocio!');
    assert.strictEqual((await pedidoDe(folio, NEG_B)).estado, 'pendiente_pago');

    // Sin negocio tampoco: jamás se deduce el tenant.
    for (const malo of ['', '   ', null, undefined]) {
      const r = await vencerEsperaDePago(pagoB.id, malo);
      assert.strictEqual(r.ok, false, `aceptó vencer con negocioId=${JSON.stringify(malo)}`);
      assert.strictEqual(r.razon, 'sin_negocio');
    }

    // Con SU propio negocio sí. Cada fila de la cola trae su tenant y el job la
    // vence con ese, nunca con uno heredado del ciclo anterior.
    const cola = await pagosConEsperaVencida(50);
    const suyo = cola.find(p => p.id === pagoB.id);
    assert.ok(suyo, 'la cola global no vio el pago del otro negocio');
    assert.strictEqual(suyo.negocio_id, NEG_B, 'la fila de la cola perdió su tenant');
    const propio = await vencerEsperaDePago(pagoB.id, NEG_B);
    assert.strictEqual(propio.ok, true);
    assert.strictEqual((await pedidoDe(folio, NEG_B)).estado, 'cancelado');
    assert.strictEqual((await pedidoDe('EX-0014')).estado, 'pendiente_pago',
      'vencer en el negocio B tocó un pedido del negocio A');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya estaba abajo */ }
  try { if (srvReinicio) await srvReinicio.detener(); } catch { /* ya estaba abajo */ }
  clipMock.close(); mpMock.close();
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_vigente_unico
       ON pagos (negocio_id, pedido_folio, tipo)
       WHERE estado IN ('creando','pendiente','requiere_revision')`).catch(() => {});
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-pagos-expiracion: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
