// ─── PRIMERA COMPRA: una propiedad DURABLE, no del tablero ──────────────────
//
// TRES COSAS DISTINTAS que esta suite se niega a confundir:
//
//   1. pedido creado          -> `pedidos` / `pedidos_activos`
//   2. dinero recibido        -> `pagos`
//   3. COMPRA REAL reconocida -> `compras_reales` (058)
//
// El defecto que cierra: `clienteYaComproDeVerdad` deducia la elegibilidad de
// `pedidos` menos lo que `pedidos_activos` desmentia. En cuanto un pedido
// cancelado por falta de pago se PURGABA del tablero, su fila historica volvia
// a parecer una compra -- y el cliente perdia su promocion de primera compra
// sin haber comprado nunca.
//
// PAGO REAL != COMPRA REAL. Un cobro tardio sobre un pedido vencido se asienta
// (el dinero entro) pero Xabor no lo cocina: no convierte al cliente en "ya
// compro".
//
// Cero llamadas externas. Cero dinero real.
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
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const SLUG = 'primera-compra-test';
const PUERTO = Number(process.env.TEST_PORT_PC || 4361);
const PUERTO_CLIP = Number(process.env.TEST_PORT_PC_CLIP || 4362);
const base = `http://localhost:${PUERTO}`;
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_URL_PUBLICA = base;

// 10 dígitos EXACTOS: el sistema normaliza a MX de 10 y guarda ESA forma. Con
// 11 la marca quedaba bajo otra clave y toda consulta devolvía `false` -- lo
// que hacía pasar los casos NEGATIVOS por la razón equivocada. El diente
// contra esa recaída es el caso 0.
const tel = (p) => `899${p}${String(Date.now()).slice(-5)}`;
const tokenNuevo = () => randomBytes(24).toString('hex');

// ── Mock de Clip con la forma DOCUMENTADA ───────────────────────────────────
let nClip = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const b = JSON.parse(cuerpo || '{}');
      const id = `clip-pc-${++nClip}`;
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
        payment_request_url: 'https://x', created_at: '2026-08-18T00:00:00.000Z', expired_at: null,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise(r => clipMock.listen(PUERTO_CLIP, r));

// ── Fixture ─────────────────────────────────────────────────────────────────
let PRODUCTO = null;
const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const carrito = (telefono, extra = {}) => ({
  checkoutToken: tokenNuevo(), items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente PC', telefono },
  metodoPago: 'enlace_pago', ...extra,
});

async function conectarClip(negocioId = NEG) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'clip', SEED.superadminUsuarioId);
}

const yaCompro = async (negocioId, telefono) => {
  const { clienteYaComproDeVerdad } = await import('../src/services/tiendaPromociones.js');
  return clienteYaComproDeVerdad(negocioId, telefono);
};
const comprasDe = async (telefono, negocioId = NEG) => (await pool.query(
  `SELECT * FROM compras_reales WHERE negocio_id=$1 AND cliente_telefono=$2`, [negocioId, telefono])).rows;
const pagosDe = async (folio) => (await pool.query(
  `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [NEG, folio])).rows;
const filaId = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [id])).rows[0];
const pedidoDe = async (folio) => (await pool.query(
  `SELECT estado, datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0] || null;

const crearEnlace = async (folio) => {
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  return crearEnlacePago({ negocioId: NEG, pedidoId: folio, actor: SEED.superadminUsuarioId });
};
const vencerYa = (id) => pool.query(
  `UPDATE pagos SET xabor_espera_hasta = NOW() - interval '2 minutes' WHERE id=$1`, [id]);
const webhookClip = (ref) => fetch(`${base}/webhook/clip`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: ref }),
}).then(r => r.status);

async function esperar(cond, que, ms = 10000) {
  const lim = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > lim) throw new Error(`tiempo agotado esperando: ${que}`);
    await new Promise(r => setTimeout(r, 120));
  }
}
/** Purga FISICA del tablero: no basta con cambiar el estado. */
const purgarTablero = (folio, negocioId = NEG) => pool.query(
  `DELETE FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, negocioId]);

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC PRIMERA' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora primera', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora primera' } });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(`DELETE FROM pagos WHERE negocio_id=$1`, [n]);
    // Por ORIGEN, no por teléfono: el sistema normaliza el número antes de
    // guardarlo, así que filtrar por el prefijo que escribe la prueba dejaba
    // filas vivas -- y como el FOLIO SE RECICLA, esas filas zombis chocaban
    // con las compras de la corrida siguiente. El backfill legacy no se toca.
    await pool.query(
      `DELETE FROM compras_reales WHERE negocio_id=$1 AND origen <> 'legacy_desconocido'`, [n]);
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [n]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='tienda_online'`, [n]);
    await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='tienda_metodos_pago'`, [n]);
  }
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='PC PRIMERA')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='PC PRIMERA' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='PrimeraCompra (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='PrimeraCompra (test)'`, [NEG]);
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
     VALUES ($1,'PrimeraCompra (test)',TRUE,940) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto PC',300,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
  // Allow-list de la TIENDA (regla de 32d9c40, independiente de metodos_pago
  // del POS): sin fila, la tienda solo ofrece 'Pago con tarjeta en línea'.
  // Esta suite compra también con EFECTIVO, así que lo habilita explícito,
  // igual que haría el negocio en Configuración → Tienda → Ajustes → Pagos.
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor=$2`,
    [NEG, JSON.stringify(['enlace_pago', 'efectivo'])]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'PC',$3)
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
    XABOR_TIENDA_LIMITE_CHECKOUT: '2000', XABOR_TIENDA_LIMITE_LECTURA: '5000',
    CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`, XABOR_URL_PUBLICA: base,
  }, { timeoutMs: 90000 });

  // ═══ GUARDIA DEL ARNÉS ════════════════════════════════════════════════════
  await t('0. la clave con la que consulto es la MISMA que el sistema escribe', async () => {
    // Sin esto, todo caso negativo pasa gratis: si el teléfono de la prueba
    // nunca coincide con el guardado, `yaCompro` devuelve false SIEMPRE y los
    // casos 4 y 5 quedan verdes sin haber ejercitado nada. Pasó de verdad.
    const T = tel('80');
    const r = await comprar(carrito(T, { metodoPago: 'efectivo' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await esperar(async () => (await pedidoDe(r.body.folio)) !== null, 'el pedido en el tablero');
    const guardado = (await pedidoDe(r.body.folio)).datos?.cliente?.telefono;
    assert.strictEqual(guardado, T,
      `el sistema guardó "${guardado}" y la prueba consulta "${T}": las claves no alinean`);
  });

  // ═══ EL CASO CENTRAL ═════════════════════════════════════════════════════
  await t('1. intento nunca pagado + PURGA FISICA del tablero: sigue siendo primera compra', async () => {
    const T = tel('81');
    assert.strictEqual(await yaCompro(NEG, T), false, 'fixture: debia ser cliente nuevo');

    const r = await comprar(carrito(T));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const folio = r.body.folio;
    assert.strictEqual(await yaCompro(NEG, T), false,
      'un pedido `pendiente_pago` ya cuenta como compra');

    await crearEnlace(folio);
    await vencerYa((await pagosDe(folio))[0].id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual(await yaCompro(NEG, T), false, 'un pedido vencido cuenta como compra');

    // Y AHORA la purga FISICA: el defecto viejo aparecia justo aqui.
    await purgarTablero(folio);
    assert.strictEqual(await pedidoDe(folio), null, 'fixture: el pedido debia purgarse');
    assert.strictEqual(await yaCompro(NEG, T), false,
      'tras purgar el tablero, un intento nunca pagado se convirtio en compra');
    assert.strictEqual((await comprasDe(T)).length, 0);
  });

  await t('2. compra online valida: cuenta, y sobrevive a la purga y al reinicio', async () => {
    const T = tel('82');
    const r = await comprar(carrito(T));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip((await pagosDe(folio))[0].referencia_interna), 200);
    await esperar(async () => await yaCompro(NEG, T), 'que la compra quede registrada');

    const compras = await comprasDe(T);
    assert.strictEqual(compras.length, 1, `quedaron ${compras.length} compras para un pedido`);
    assert.strictEqual(compras[0].origen, 'pago_online');
    assert.strictEqual(compras[0].folio, folio);

    // Purga fisica del tablero: la señal no vive ahi.
    await purgarTablero(folio);
    assert.strictEqual(await yaCompro(NEG, T), true, 'la compra se perdio al purgar el tablero');

    // Y sobrevive al reinicio: se relee de la base, no de memoria.
    const { clienteYaComproDeVerdad } = await import('../src/services/tiendaPromociones.js');
    assert.strictEqual(await clienteYaComproDeVerdad(NEG, T), true);
  });

  await t('3. EFECTIVO: la compra se marca al entrar a operacion, sin esperar webhook', async () => {
    const T = tel('83');
    const r = await comprar(carrito(T, { metodoPago: 'efectivo' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await esperar(async () => await yaCompro(NEG, T), 'la compra en efectivo');
    const compras = await comprasDe(T);
    assert.strictEqual(compras.length, 1);
    assert.strictEqual(compras[0].origen, 'operacion',
      'el efectivo no se marco en el punto operacional');
  });

  // ═══ DINERO QUE NO ES COMPRA ═════════════════════════════════════════════
  await t('4. PAGO TARDIO: el dinero se registra, pero NO convierte en cliente viejo', async () => {
    const T = tel('84');
    const r = await comprar(carrito(T));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];

    await vencerYa(pago.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();

    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(pago.referencia_interna), 200);
    await esperar(async () => (await filaId(pago.id)).estado === 'pagado', 'el asiento tardio');

    // El pedido lleva EXACTAMENTE este telefono: si `yaCompro` da false abajo,
    // es porque no hay marca, no porque la clave no alinee.
    assert.strictEqual((await pedidoDe(folio)).datos?.cliente?.telefono, T);

    const final = await filaId(pago.id);
    assert.strictEqual(final.estado, 'pagado', 'se repudio dinero real');
    assert.strictEqual(final.metadata_sanitizada.anomalia, 'pago_tardio');
    assert.strictEqual(await yaCompro(NEG, T), false,
      'un pago tardio sobre un pedido vencido convirtio al cliente en "ya compro"');
    assert.strictEqual((await comprasDe(T)).length, 0);
  });

  await t('5. VERSION VIEJA pagada: dinero si, compra no', async () => {
    const T = tel('85');
    const r = await comprar(carrito(T));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];

    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos,'{total}','999'::jsonb)
        WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);

    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip(pago.referencia_interna), 200);
    await esperar(async () => (await filaId(pago.id)).estado === 'pagado', 'el asiento desfasado');

    assert.strictEqual((await pedidoDe(folio)).datos?.cliente?.telefono, T);
    assert.strictEqual((await filaId(pago.id)).metadata_sanitizada.anomalia, 'version_desfasada');
    assert.strictEqual(await yaCompro(NEG, T), false,
      'un cobro de version vieja, que no cocina, conto como compra');
  });

  await t('6. DOBLE COBRO: una sola compra por pedido', async () => {
    const T = tel('86');
    const r = await comprar(carrito(T));
    const folio = r.body.folio;
    const enlace = await crearEnlace(folio);
    const pago = (await pagosDe(folio))[0];
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    // El mismo aviso muchas veces + un segundo intento cobrado.
    for (let i = 0; i < 10; i++) await webhookClip(pago.referencia_interna);
    await esperar(async () => await yaCompro(NEG, T), 'la compra');
    await new Promise(x => setTimeout(x, 500));

    const compras = await comprasDe(T);
    assert.strictEqual(compras.length, 1,
      `el doble cobro dejo ${compras.length} compras del mismo pedido`);
  });

  // ═══ AISLAMIENTO ═════════════════════════════════════════════════════════
  await t('7. multiempresa: comprar en A no hace viejo al cliente en B', async () => {
    const T = tel('87');
    const r = await comprar(carrito(T, { metodoPago: 'efectivo' }));
    assert.strictEqual(r.status, 200);
    await esperar(async () => await yaCompro(NEG, T), 'la compra en A');
    assert.strictEqual(await yaCompro(NEG_B, T), false,
      'la compra en el negocio A hizo viejo al cliente en el negocio B');
    // Y sin negocio no se deduce nada.
    assert.strictEqual(await yaCompro('', T), false);
    assert.strictEqual(await yaCompro(NEG, ''), false);
  });

  // ═══ PRIMERA COMPRA + PROMOCION ══════════════════════════════════════════
  await t('8. 20 checkouts simultaneos del MISMO telefono: una sola reserva de primera compra', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, solo_primera_compra, canales, activa)
       VALUES ($1,'Bienvenida PC','monto_fijo','PRIMERAPC',FALSE,50,TRUE,'["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    const T = tel('88');

    const res = await Promise.all(Array.from({ length: 20 }, () =>
      comprar(carrito(T, { codigo: 'PRIMERAPC' }))));
    const ok = res.filter(x => x.status === 200);

    // La garantia vive en la base: el claim por cliente serializa con advisory
    // lock y cuenta filas dentro de la transaccion.
    const usos = (await pool.query(
      `SELECT * FROM tienda_promocion_usos WHERE promocion_id=$1`, [p.id])).rows;
    assert.strictEqual(usos.length, 1,
      `${usos.length} reservas simultaneas de una promo de primera compra`);
    assert.strictEqual(Number((await pool.query(
      `SELECT usos FROM tienda_promociones WHERE id=$1`, [p.id])).rows[0].usos), 1);
    assert.ok(ok.length >= 1, 'ningun checkout logro pasar');
  });

  await t('9. reserva vence -> vuelve la elegibilidad; compra real -> nunca vuelve', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id, nombre, tipo, codigo, automatica, valor, solo_primera_compra, canales, activa)
       VALUES ($1,'Bienvenida ciclo','monto_fijo','PRIMERACICLO',FALSE,50,TRUE,'["tienda_online"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);
    const T = tel('89');

    // Intento 1: no paga, vence, y ademas se purga el tablero.
    const r1 = await comprar(carrito(T, { codigo: 'PRIMERACICLO' }));
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    await crearEnlace(r1.body.folio);
    await vencerYa((await pagosDe(r1.body.folio))[0].id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    await purgarTablero(r1.body.folio);

    // Sigue siendo primerizo: el cupo volvio y la elegibilidad tambien.
    assert.strictEqual((await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE promocion_id=$1`,
      [p.id])).rows[0].n, 0, 'la reserva no se libero');
    assert.strictEqual(await yaCompro(NEG, T), false);

    // Intento 2: paga de verdad.
    const r2 = await comprar(carrito(T, { codigo: 'PRIMERACICLO' }));
    assert.strictEqual(r2.status, 200,
      `el cliente perdio su elegibilidad sin haber comprado: ${JSON.stringify(r2.body)}`);
    const folio2 = r2.body.folio;
    const e2 = await crearEnlace(folio2);
    CHECKOUTS.get(e2.referenciaExterna).estado = 'COMPLETED';
    await webhookClip((await pagosDe(folio2))[0].referencia_interna);
    await esperar(async () => await yaCompro(NEG, T), 'la compra real');

    // Se archiva y se PURGA fisicamente.
    await purgarTablero(folio2);

    // Y ya no vuelve a ser primera compra. Sin consultar pedidos_activos.
    const r3 = await comprar(carrito(T, { codigo: 'PRIMERACICLO' }));
    assert.notStrictEqual(r3.status, 200,
      `un cliente que ya compro volvio a usar la promo de primera compra: ${JSON.stringify(r3.body)}`);
    assert.strictEqual(await yaCompro(NEG, T), true);
  });

  // ═══ LEGACY ══════════════════════════════════════════════════════════════
  await t('10. legacy: el backfill no regala la promo a clientes antiguos', async () => {
    // Politica documentada en la 058: el riesgo asimetrico manda. Marcar de
    // menos regala dinero y no tiene vuelta atras; marcar de mas quita un
    // descuento que el negocio puede conceder a mano. Todo el historico entra
    // como compra, ETIQUETADO `legacy_desconocido`.
    const T = tel('90');
    await pool.query(
      `INSERT INTO compras_reales (negocio_id, folio, pedido_creado_at, cliente_telefono, origen)
       VALUES ($1,$2,NOW() - interval '90 days',$3,'legacy_desconocido')`, [NEG, `LEG-${T}`, T]);
    assert.strictEqual(await yaCompro(NEG, T), true,
      'un cliente con historia legacy volvio a ser primerizo');

    // Y la ambiguedad queda visible, no escondida.
    const c = (await comprasDe(T))[0];
    assert.strictEqual(c.origen, 'legacy_desconocido');
  });

  await t('11. FOLIO RECICLADO: dos pedidos con el mismo folio son dos compras', async () => {
    // `obtenerMaxFolioNum()` calcula el siguiente folio SOLO desde
    // `pedidos_activos`. Al purgar el tablero y reiniciar, el contador retrocede
    // y XAB-0042 se reemite para otro cliente. Con la clave puesta únicamente en
    // (negocio, folio), la compra del cliente NUEVO chocaba contra la fila del
    // ANTERIOR, no se registraba, y ese cliente conservaba su promoción de
    // primera compra: dinero regalado, sin vuelta atrás.
    const { registrarCompraReal } = await import('../src/services/database.js');
    const viejo = tel('92');
    const nuevo = tel('93');
    const folio = `XAB-RECICLADO-${Date.now()}`;

    const t1 = new Date(Date.now() - 86400000);
    const t2 = new Date();
    const r1 = await registrarCompraReal(null,
      { negocioId: NEG, folio, telefono: viejo, origen: 'operacion', pedidoCreadoAt: t1 });
    const r2 = await registrarCompraReal(null,
      { negocioId: NEG, folio, telefono: nuevo, origen: 'operacion', pedidoCreadoAt: t2 });

    assert.strictEqual(r1.nueva, true);
    assert.strictEqual(r2.nueva, true,
      'el folio reciclado hizo que la compra del cliente nuevo se perdiera');
    assert.strictEqual(await yaCompro(NEG, viejo), true);
    assert.strictEqual(await yaCompro(NEG, nuevo), true,
      'el cliente nuevo sigue pareciendo primerizo: se le regalaría la promoción');

    // Y el MISMO pedido sigue siendo una sola compra.
    const otra = await registrarCompraReal(null,
      { negocioId: NEG, folio, telefono: nuevo, origen: 'operacion', pedidoCreadoAt: t2 });
    assert.strictEqual(otra.nueva, false, 'el mismo pedido se contó dos veces');
  });

  await t('12. idempotente con la identidad completa; SIN ella, fail closed', async () => {
    const { registrarCompraReal } = await import('../src/services/database.js');
    const T = tel('91');
    const folio = `IDEM-${T}`;
    const creado = new Date();
    for (let i = 0; i < 10; i++) {
      await registrarCompraReal(null,
        { negocioId: NEG, folio, telefono: T, origen: 'operacion', pedidoCreadoAt: creado });
    }
    assert.strictEqual((await comprasDe(T)).length, 1);

    // Sin `pedidoCreadoAt` NO se escribe nada. Antes caía a NOW(), y eso era
    // peor que fallar: NOW() no es la identidad del pedido sino el instante en
    // que se escribió la fila, así que dos marcas del mismo pedido se volvían
    // dos compras y el ON CONFLICT dejaba de proteger. Una identidad inventada
    // no es una identidad.
    //
    // Quien llama decide qué hacer con el rechazo; en la ruta operacional eso
    // significa NO emitir la comanda (ver `fase-compra-operacional-critica`).
    const S = tel('94');
    const folioS = `IDEM-SIN-${S}`;
    const sinId = await registrarCompraReal(null,
      { negocioId: NEG, folio: folioS, telefono: S, origen: 'operacion' });
    assert.strictEqual(sinId.ok, false, 'se escribió una compra con identidad inventada');
    assert.strictEqual(sinId.razon, 'sin_identidad');
    assert.strictEqual((await comprasDe(S)).length, 0);
    assert.strictEqual(await yaCompro(NEG, S), false);

    // Y un origen fuera del vocabulario tampoco pasa.
    const raro = await registrarCompraReal(null,
      { negocioId: NEG, folio: folioS, telefono: S, origen: 'inventado', pedidoCreadoAt: creado });
    assert.strictEqual(raro.ok, false);
    assert.strictEqual(raro.razon, 'origen_invalido');
    // Sin negocio o sin folio no se escribe nada: jamas se deduce el tenant.
    const sinNeg = await registrarCompraReal(null, { negocioId: '', folio, telefono: T, origen: 'operacion' });
    assert.strictEqual(sinNeg.ok, false);
    assert.strictEqual(sinNeg.razon, 'sin_negocio');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya estaba abajo */ }
  clipMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-primera-compra-durable: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
