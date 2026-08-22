// P0 FINANCIERO XAB-0176 — el cliente pagó $370 por un pedido de $310
// porque el envío existía DOS veces: como producto del menú (que el LLM
// agrega legítimamente como item) y como costo_envio canónico de reglas, y
// `total = subtotal + costoEnvio` sumó ambos.
//
// Esta suite fija la regla nueva: UNA SOLA fuente de verdad para el envío
// (el costo canónico de reglas). Los productos legacy de envío se
// reconocen ESTRUCTURALMENTE por la marca de catálogo
// `menu_productos.opciones.tipo_item = 'envio'` — jamás por nombre.
//
// Rojo-primero: los casos 1, 3, 4, 5 y 13 fallan sin el fix (total inflado).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const PUERTO_CLIP = Number(process.env.TEST_PORT_EDC_CLIP || 4661);
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { validarOrdenPropuesta, esProductoEnvio } = await import('../src/orders/validadorOrden.js');
const { registrarPedido } = await import('../src/orders/orderManager.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const TEL = `8997500${suf.slice(-3)}`;
const PROD_A = `EDC Focaccia ${suf}`;
const ENVIO_A = `EDC Cargo Envio ${suf}`;      // marcado tipo_item='envio'
const PROD_B = `EDC Torta ${suf}`;
const SIN_MARCA_B = `EDC Envio Express ${suf}`; // nombre parecido, SIN marca

// ── Mock Clip mínimo (para demostrar el monto del payment request) ──────────
const REQUESTS = [];
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      REQUESTS.push(body);
      const expiresAt = body.expires_at
        ? new Date(Date.parse(body.expires_at)).toISOString()
        : new Date(Date.now() + 3600e3).toISOString();
      res.end(JSON.stringify({
        payment_request_id: `clip-edc-${REQUESTS.length}`, object_type: 'payment_link',
        status: 'CHECKOUT_CREATED', payment_request_url: `https://pago.mock.clip/edc-${REQUESTS.length}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        expires_at: expiresAt,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => clipMock.listen(PUERTO_CLIP, r));

const reglas = ({ costoEnvio, zonas = [], gratisDesde = 0 }) => ({
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
  pedidos: {
    costo_envio: costoEnvio, pedido_minimo_entrega: 0,
    zonas_entrega: zonas, entrega_gratis_desde: gratisDesde,
  },
  cierres_especiales: [], promociones: [], politicas: [],
});

const orden = ({ conItemEnvio = true, modalidad = 'entrega a domicilio', envioLLM = 60, totalLLM = 310, extras = {} } = {}) => ({
  cliente: { nombre: 'Cliente EDC', telefono: TEL, calle: 'Calle 1', colonia: 'Centro', entre_calles: null },
  modalidad,
  items: [
    { nombre: PROD_A, cantidad: 1, precio_unitario: 250 },
    ...(conItemEnvio ? [{ nombre: ENVIO_A, cantidad: 1, precio_unitario: 60 }] : []),
  ],
  subtotal: 250, costo_envio: envioLLM, descuento: 0, total: totalLLM,
  forma_pago: 'efectivo',
  canal: 'test', programado_para: null, negocioId: NEG_A,
  ...extras,
});

async function limpiar() {
  await pool.query(`DELETE FROM pagos WHERE negocio_id = ANY($1) AND pedido_folio IN (SELECT folio FROM pedidos_activos WHERE datos->'cliente'->>'telefono' = $2)`, [[NEG_A, NEG_B], TEL]);
  await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id = ANY($1) AND folio IN (SELECT folio FROM pedidos_activos WHERE datos->'cliente'->>'telefono' = $2)`, [[NEG_A, NEG_B], TEL]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->'cliente'->>'telefono' = $2`, [[NEG_A, NEG_B], TEL]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = ANY($1) AND nombre LIKE 'EDC %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1) AND nombre LIKE 'EDC %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal='pagos' AND proveedor='clip')`, [NEG_A]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal='pagos' AND proveedor='clip'`, [NEG_A]);
  await pool.query(`DELETE FROM configuracion WHERE clave = 'reglas_atencion' AND negocio_id = ANY($1)`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1) AND tipo IN ('efectivo','enlace_pago')`, [[NEG_A, NEG_B]]);
}

try {
  await limpiar();

  // Fixture: catálogo de A (mercancía + cargo de envío MARCADO), catálogo de
  // B (mercancía + un producto de nombre parecido a envío SIN marca).
  for (const [neg, filas] of [
    [NEG_A, [[PROD_A, 250, null], [ENVIO_A, 60, { tipo_item: 'envio' }]]],
    [NEG_B, [[PROD_B, 80, null], [SIN_MARCA_B, 50, null]]],
  ]) {
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'EDC Cat (test)',TRUE,991) RETURNING id`, [neg]);
    for (const [nombre, precio, opciones] of filas) {
      await pool.query(
        `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden, opciones)
         VALUES ($1,$2,$3,$4,TRUE,FALSE,1,$5)`, [neg, cat.id, nombre, precio, opciones ? JSON.stringify(opciones) : null]);
    }
  }
  for (const neg of [NEG_A, NEG_B]) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden, disponible_para_bot)
       VALUES ($1,'efectivo',TRUE,1,TRUE) ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado=TRUE, disponible_para_bot=TRUE`, [neg]);
  }
  await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas({ costoEnvio: 60, zonas: [{ nombre: 'Fuera', costo: 120 }] })) }, NEG_A);
  await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas({ costoEnvio: 80 })) }, NEG_B);

  await t('0. esProductoEnvio: SOLO la marca estructural decide (jamas el nombre)', async () => {
    assert.strictEqual(esProductoEnvio({ nombre: 'Envío', opciones: null }), false, 'reconocio por nombre');
    assert.strictEqual(esProductoEnvio({ nombre: 'Cualquiera', opciones: { tipo_item: 'envio' } }), true);
    assert.strictEqual(esProductoEnvio({ opciones: { tipo_item: 'producto' } }), false);
  });

  await t('1. domicilio + item legacy de envio + canonico $60 => total $310 (el caso XAB-0176)', async () => {
    const v = await validarOrdenPropuesta(orden(), NEG_A);
    assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
    assert.strictEqual(v.orden.subtotal, 250, `subtotal=${v.orden.subtotal} (el envio entro como mercancia)`);
    assert.strictEqual(v.orden.costo_envio, 60);
    assert.strictEqual(v.orden.total, 310, `total=${v.orden.total} — DOBLE COBRO`);
    assert.ok(v.ajustes.some((a) => a.tipo === 'item_envio_legacy_ignorado'), 'sin observabilidad del item ignorado');
  });

  await t('2. mismo pedido SIN item legacy => total $310 identico', async () => {
    const v = await validarOrdenPropuesta(orden({ conItemEnvio: false }), NEG_A);
    assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
    assert.strictEqual(v.orden.total, 310);
    assert.ok(!v.ajustes.some((a) => a.tipo === 'item_envio_legacy_ignorado'));
  });

  await t('3. item legacy $60 pero zona canonica $120 => gana la zona: total $370, jamas $430', async () => {
    const v = await validarOrdenPropuesta(orden({ envioLLM: 120, totalLLM: 370 }), NEG_A);
    assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
    assert.strictEqual(v.orden.costo_envio, 120, 'el precio del item legacy jamas es autoridad de zona');
    assert.strictEqual(v.orden.total, 370, `total=${v.orden.total}`);
  });

  await t('4. envio gratis canonico (umbral) + item legacy => total $250', async () => {
    await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas({ costoEnvio: 60, gratisDesde: 200 })) }, NEG_A);
    const v = await validarOrdenPropuesta(orden({ envioLLM: 0, totalLLM: 250 }), NEG_A);
    assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
    assert.strictEqual(v.orden.costo_envio, 0);
    assert.strictEqual(v.orden.total, 250, `total=${v.orden.total} (el item legacy revivio el cobro)`);
    await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas({ costoEnvio: 60, zonas: [{ nombre: 'Fuera', costo: 120 }] })) }, NEG_A);
  });

  await t('5. recoger en tienda + item legacy de envio => total $250 (cero envio, siempre)', async () => {
    const v = await validarOrdenPropuesta(orden({ modalidad: 'recoger en tienda', envioLLM: 0, totalLLM: 250 }), NEG_A);
    assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
    assert.strictEqual(v.orden.costo_envio, 0);
    assert.strictEqual(v.orden.total, 250, `total=${v.orden.total} — cobro envio en recoger`);
  });

  await t('6. negocio sin productos marcados: intacto, y un nombre parecido a envio SIN marca es mercancia', async () => {
    const v = await validarOrdenPropuesta({
      cliente: { nombre: 'Cliente EDC B', telefono: TEL },
      modalidad: 'entrega a domicilio',
      items: [{ nombre: PROD_B, cantidad: 1, precio_unitario: 80 }, { nombre: SIN_MARCA_B, cantidad: 1, precio_unitario: 50 }],
      subtotal: 130, costo_envio: 80, descuento: 0, total: 210, forma_pago: 'efectivo',
    }, NEG_B);
    assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
    assert.strictEqual(v.orden.subtotal, 130, 'un producto sin marca fue tratado como envio (heuristica prohibida)');
    assert.strictEqual(v.orden.total, 210);
    assert.ok(!v.ajustes.some((a) => a.tipo === 'item_envio_legacy_ignorado'));
  });

  await t('7. total del LLM correcto => cero total_mismatch falso', async () => {
    const v = await validarOrdenPropuesta(orden(), NEG_A);
    assert.strictEqual(v.ok, true);
    assert.ok(!v.ajustes.some((a) => a.tipo === 'total_mismatch'),
      `mismatch falso: ${JSON.stringify(v.ajustes)}`);
  });

  await t('8. total del LLM incorrecto => si hay total_mismatch real', async () => {
    const v = await validarOrdenPropuesta(orden({ totalLLM: 300 }), NEG_A);
    assert.strictEqual(v.ok, true);
    const m = v.ajustes.find((a) => a.tipo === 'total_mismatch');
    assert.ok(m, 'no detecto el total incorrecto');
    assert.strictEqual(m.llm, 300);
    assert.strictEqual(m.real, 310);
  });

  let folioRegistrado = null;
  await t('9. la obligacion nace del total canonico: pedido registrado con total $310', async () => {
    const p = await registrarPedido(orden(), 'test');
    folioRegistrado = p.id;
    const { rows: [fila] } = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folioRegistrado, NEG_A]);
    assert.strictEqual(Number(fila.datos.total), 310, `total persistido=${fila.datos.total}`);
    assert.strictEqual(Number(fila.datos.subtotal), 250);
    assert.strictEqual(Number(fila.datos.costo_envio), 60);
  });

  await t('10. payment request a Clip = total canonico ($310, no $370)', async () => {
    const { guardarCredencialesClip } = await import('../src/services/integracionesService.js');
    const { marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
    await guardarCredencialesClip(NEG_A, `EDCTESTKEY${suf}`, `EDCTESTSECRET${suf}`, SEED.superadminUsuarioId);
    await marcarProveedorPrincipal(NEG_A, 'clip', SEED.superadminUsuarioId);
    const { crearEnlacePago } = await import('../src/services/pagosService.js');
    const antes = REQUESTS.length;
    const enlace = await crearEnlacePago({ negocioId: NEG_A, pedidoId: folioRegistrado, actor: null });
    assert.ok(enlace?.url, 'no se creo el enlace');
    assert.strictEqual(REQUESTS.length, antes + 1);
    assert.strictEqual(Number(REQUESTS[REQUESTS.length - 1].amount), 310,
      `Clip recibio ${REQUESTS[REQUESTS.length - 1].amount}`);
  });

  await t('11. el registro compartido multiproveedor (pagos.monto, mismo camino de MP) = total canonico', async () => {
    const { rows: [pago] } = await pool.query(
      `SELECT monto FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [NEG_A, folioRegistrado]);
    // resolverIntentoDePago escribe pagos.monto ANTES de llamar a CUALQUIER
    // adaptador (Clip y Mercado Pago comparten esa fila y ese monto): si el
    // registro dice 310, ningun proveedor puede cobrar otra cosa.
    assert.strictEqual(Number(pago.monto), 310, `pagos.monto=${pago.monto}`);
  });

  await t('12. dos tenants con reglas de envio distintas: cero cruce', async () => {
    const va = await validarOrdenPropuesta(orden(), NEG_A);
    const vb = await validarOrdenPropuesta({
      cliente: { nombre: 'Cliente EDC B', telefono: TEL },
      modalidad: 'entrega a domicilio',
      items: [{ nombre: PROD_B, cantidad: 1, precio_unitario: 80 }],
      subtotal: 80, costo_envio: 80, descuento: 0, total: 160, forma_pago: 'efectivo',
    }, NEG_B);
    assert.strictEqual(va.orden.total, 310);
    assert.strictEqual(vb.orden.total, 160);
    assert.strictEqual(va.orden.costo_envio, 60);
    assert.strictEqual(vb.orden.costo_envio, 80);
  });

  await t('13. envio gratis + item legacy: la exencion aplica UNA vez y el item no la revierte', async () => {
    await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas({ costoEnvio: 60, gratisDesde: 200 })) }, NEG_A);
    const v = await validarOrdenPropuesta(orden({ envioLLM: 0, totalLLM: 250 }), NEG_A);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.orden.total, 250);
    assert.strictEqual(v.ajustes.filter((a) => a.tipo === 'item_envio_legacy_ignorado').length, 1,
      'el ajuste de observabilidad debe registrarse exactamente una vez');
    await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas({ costoEnvio: 60, zonas: [{ nombre: 'Fuera', costo: 120 }] })) }, NEG_A);
  });

  await t('14. el subtotal de mercancia real queda intacto (precio del catalogo, sin efectos colaterales)', async () => {
    const v = await validarOrdenPropuesta(orden(), NEG_A);
    assert.strictEqual(v.orden.subtotal, 250);
    const item = v.orden.items.find((i) => i.nombre === PROD_A);
    assert.ok(item, 'desaparecio la mercancia real');
    assert.strictEqual(item.precio_unitario, 250);
    assert.strictEqual(v.orden.items.length, 1, 'el item de envio no debe viajar como mercancia canonica');
  });

  await t('15. una orden de SOLO envio no es una orden: fail-closed', async () => {
    const v = await validarOrdenPropuesta(orden({ extras: { items: [{ nombre: ENVIO_A, cantidad: 1, precio_unitario: 60 }] } }), NEG_A);
    assert.strictEqual(v.ok, false);
    assert.ok(v.rechazos.some((r) => r.codigo === 'ORDEN_SIN_ITEMS'), JSON.stringify(v.rechazos));
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  clipMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-envio-doble-cobro: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
