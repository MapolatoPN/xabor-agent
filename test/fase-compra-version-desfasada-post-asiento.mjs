// ─── La frontera POST-ASIENTO: dinero sí, compra no ─────────────────────────
//
// Hay DOS fronteras distintas donde un cobro puede llegar desfasado, y no son
// intercambiables:
//
//   PRE-ASIENTO   el webhook llega, se compara la versión ANTES de asentar y el
//                 pago se registra marcado `version_desfasada`. Cubierto por el
//                 caso 5 de `fase-primera-compra-durable`.
//
//   POST-ASIENTO  el dinero YA se asentó correctamente contra la v1 y quedó
//                 `derivacion_pendiente`. Antes de saldar esa deuda el pedido
//                 cambia a v2. Cuando la recuperación entra a consumirla, la
//                 revalidación bajo FOR UPDATE encuentra otra versión y sale
//                 por `version_desfasada_post_asiento`.  ← ESTA suite
//
// La segunda no tenía prueba: una mutación que insertaba la compra real en esa
// rama dejaba toda la batería verde. Un cobro que Xabor no cocina se estaba
// pudiendo convertir en "este cliente ya compró" sin que nada se quejara.
//
// Lo que debe pasar en esa rama, y se verifica aquí entero:
//   · el dinero se queda `pagado` -- entró de verdad, no se repudia;
//   · CERO compras reales: no se cocinó nada;
//   · la promoción NO se consume: el cupo vuelve al pool;
//   · CERO comanda, cero paso a operación;
//   · la deuda se cierra con la anomalía correcta, para que alguien lo mire.
//
// El asiento sin derivación se provoca con `XABOR_PAGOS_FALLA_EN=despues_de_asentar`,
// la inyección que ya existe en webhookPagos.js -- inerte fuera de pruebas.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const NEG = SEED.negocioA;
const SLUG = 'post-asiento-test';
const PUERTO = Number(process.env.TEST_PORT_PA || 4371);
const PUERTO_CLIP = Number(process.env.TEST_PORT_PA_CLIP || 4372);
const base = `http://localhost:${PUERTO}`;
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_URL_PUBLICA = base;

const tel = (p) => `899${p}${String(Date.now()).slice(-5)}`;
const tokenNuevo = () => randomBytes(24).toString('hex');

let nClip = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const b = JSON.parse(cuerpo || '{}');
      const id = `clip-pa-${++nClip}`;
      CHECKOUTS.set(id, { referencia: b.metadata?.external_reference || null,
                          estado: 'PENDING', monto: Number(b.amount) });
      res.end(JSON.stringify({ payment_request_id: id,
                               payment_request_url: `https://pago.mock/${id}`, status: 'CHECKOUT' }));
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
        payment_request_url: 'https://x', created_at: '2026-08-18T00:00:00.000Z', expired_at: null,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise(r => clipMock.listen(PUERTO_CLIP, r));

let PRODUCTO = null;
const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const carrito = (telefono, extra = {}) => ({
  checkoutToken: tokenNuevo(), items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente PA', telefono },
  metodoPago: 'enlace_pago', ...extra,
});

const pagosDe = async (folio) => (await pool.query(
  `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [NEG, folio])).rows;
const pedidoDe = async (folio) => (await pool.query(
  `SELECT estado, datos, created_at FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`,
  [folio, NEG])).rows[0] || null;
const comprasDe = async (telefono) => (await pool.query(
  `SELECT * FROM compras_reales WHERE negocio_id=$1 AND cliente_telefono=$2`, [NEG, telefono])).rows;

const webhookClip = (ref) => fetch(`${base}/webhook/clip`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: ref }),
}).then(r => r.status).catch(() => 0);

async function esperar(cond, que, ms = 12000) {
  const lim = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > lim) throw new Error(`tiempo agotado esperando: ${que}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

async function conectarClip() {
  const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
}

async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM compras_reales WHERE negocio_id=$1 AND origen <> 'legacy_desconocido'`, [NEG]);
  await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [NEG]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='PostAsiento (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='PostAsiento (test)'`, [NEG]);
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
     VALUES ($1,'PostAsiento (test)',TRUE,941) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto PA',400,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
     VALUES ($1,'publicada',$2,'PA',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  await conectarClip();
}

/**
 * Deja el dinero ASENTADO y la deuda ABIERTA, sin derivar: exactamente el
 * estado desde el que se alcanza la frontera post-asiento.
 */
async function asentarSinDerivar(telefono, extra = {}) {
  const r = await comprar(carrito(telefono, extra));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const folio = r.body.folio;

  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  const enlace = await crearEnlacePago({ negocioId: NEG, pedidoId: folio, actor: SEED.superadminUsuarioId });
  CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

  const pago = (await pagosDe(folio))[0];
  await webhookClip(pago.referencia_interna);   // el servidor muere tras asentar
  await esperar(async () => (await pagosDe(folio))[0].estado === 'pagado', 'el asiento del dinero');

  const asentado = (await pagosDe(folio))[0];
  assert.strictEqual(asentado.derivacion_pendiente, true,
    'la deuda no quedo abierta: el escenario post-asiento no se alcanzo');
  return { folio, pagoId: asentado.id };
}

let srv = null;
try {
  await preparar();
  srv = await arrancarServidor({
    PORT: String(PUERTO), XABOR_RUTAS_PRUEBA: '1',
    XABOR_TIENDA_LIMITE_CHECKOUT: '2000', XABOR_TIENDA_LIMITE_LECTURA: '5000',
    CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`, XABOR_URL_PUBLICA: base,
    // El corte: se asienta el dinero y se muere antes de saldar la deuda.
    XABOR_PAGOS_FALLA_EN: 'despues_de_asentar',
  }, { timeoutMs: 90000 });

  await t('1. POST-ASIENTO: el pedido cambia entre el cobro y la recuperacion', async () => {
    const T = tel('60');
    const { folio, pagoId } = await asentarSinDerivar(T);

    // El pedido cambia DESPUES de que el dinero ya entro: v1 -> v2.
    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','1234'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    const { consumirDeudaDeDerivacion } = await import('../src/services/database.js');
    const r = await consumirDeudaDeDerivacion(pagoId, NEG);

    assert.strictEqual(r.resultado, 'version_desfasada_post_asiento',
      `la recuperacion no entro en la rama esperada (dio "${r.resultado}")`);

    const pago = (await pagosDe(folio))[0];
    assert.strictEqual(pago.estado, 'pagado', 'se repudio dinero que si entro');
    assert.strictEqual(pago.derivacion_pendiente, false, 'la deuda quedo colgando');
    assert.strictEqual(pago.metadata_sanitizada.anomalia, 'version_desfasada_post_asiento');

    // EL DIENTE: dinero sí, compra no.
    assert.strictEqual((await comprasDe(T)).length, 0,
      'un cobro que Xabor NO cocina quedo registrado como compra real');

    // Y no se cocino: el pedido no paso a operacion.
    const ped = await pedidoDe(folio);
    assert.notStrictEqual(ped.estado, 'nuevo', 'el pedido entro a cocina pese al desfase');
    assert.notStrictEqual(ped.datos?.pago_confirmado, true,
      'el pedido quedo marcado como pagado pese a no poder justificarse');
  });

  await t('2. la promocion NO se consume en la rama post-asiento', async () => {
    const { rows: [promo] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, canales, activa)
       VALUES ($1,'Post asiento','monto_fijo','POSTASIENTO',FALSE,50,'["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    const T = tel('61');
    const { folio, pagoId } = await asentarSinDerivar(T, { codigo: 'POSTASIENTO' });

    // La reserva existe y esta viva mientras el dinero espera derivarse.
    const reservados = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos
        WHERE promocion_id=$1 AND pedido_folio=$2`, [promo.id, folio])).rows[0].n;
    assert.strictEqual(reservados, 1, 'la reserva de la promocion no existe: el fixture no sirve');

    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','999'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    const { consumirDeudaDeDerivacion } = await import('../src/services/database.js');
    const r = await consumirDeudaDeDerivacion(pagoId, NEG);
    assert.strictEqual(r.resultado, 'version_desfasada_post_asiento');

    const usos = (await pool.query(
      `SELECT estado, consumida_at FROM tienda_promocion_usos
        WHERE promocion_id=$1 AND pedido_folio=$2`, [promo.id, folio])).rows;
    for (const u of usos) {
      assert.notStrictEqual(u.estado, 'consumida',
        'la promocion se consumio con un cobro que no llego a cocinarse');
      assert.strictEqual(u.consumida_at, null, 'quedo marcado un consumo que no ocurrio');
    }
    assert.strictEqual((await comprasDe(T)).length, 0);
  });

  await t('3. reintentar la recuperacion no cambia nada: la deuda ya esta saldada', async () => {
    const T = tel('62');
    const { folio, pagoId } = await asentarSinDerivar(T);
    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','777'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    const { consumirDeudaDeDerivacion } = await import('../src/services/database.js');
    assert.strictEqual((await consumirDeudaDeDerivacion(pagoId, NEG)).resultado,
      'version_desfasada_post_asiento');
    // Segunda pasada del job: idempotente, y sigue sin crear compra.
    const otra = await consumirDeudaDeDerivacion(pagoId, NEG);
    assert.strictEqual(otra.resultado, 'sin_deuda');
    assert.strictEqual((await comprasDe(T)).length, 0,
      'la segunda pasada del job creo la compra que la primera nego');
  });

  await t('4. control: sin desfase, la MISMA ruta si registra la compra', async () => {
    // Sin esto, los tres casos de arriba pasarian igual si la marca estuviera
    // rota en toda la ruta post-asiento -- verde por la razon equivocada.
    const T = tel('63');
    const { folio, pagoId } = await asentarSinDerivar(T);

    const { consumirDeudaDeDerivacion } = await import('../src/services/database.js');
    const r = await consumirDeudaDeDerivacion(pagoId, NEG);   // el pedido NO cambio
    assert.strictEqual(r.resultado, 'autorizado',
      `la derivacion normal no se autorizo (dio "${r.resultado}")`);

    const compras = await comprasDe(T);
    assert.strictEqual(compras.length, 1,
      'la ruta post-asiento no registra la compra ni cuando la version coincide');
    assert.strictEqual(compras[0].origen, 'pago_online');
    // Y con la identidad completa del pedido, no con un NOW() inventado.
    const ped = await pedidoDe(folio);
    assert.strictEqual(new Date(compras[0].pedido_creado_at).getTime(),
      new Date(ped.created_at).getTime(),
      'la compra se marco con un instante que no es el del pedido');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya estaba abajo */ }
  clipMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-compra-version-desfasada-post-asiento: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('Fallos: ' + fallos.join(' | ')); }
process.exit(fallidas ? 1 : 0);
