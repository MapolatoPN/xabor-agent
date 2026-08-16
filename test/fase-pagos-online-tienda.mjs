// ─── Pago en línea en la Tienda Online ─────────────────────────────────────
//
// El defecto que cierra esta suite: la tienda ofrecía "Pagar en línea", nunca
// creaba el enlace, y aun así IMPRIMÍA LA COMANDA. El negocio cocinaba sin
// haber cobrado un peso.
//
// La regla que se fija aquí: un pedido con pago en línea nace `pendiente_pago`,
// no genera comanda, y sólo la genera cuando el pago queda confirmado por el
// camino verificado. Efectivo y terminal conservan su comportamiento: se cobran
// en persona, así que la comanda sale de inmediato.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { listarProveedores, validarPuedeActivarse, obtenerAdaptador } =
  await import('../src/services/paymentProviders.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const ADMIN = `xabor_sesion=${encodeURIComponent(
  crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
const SLUG = 'pagos-online-test';
const PUERTO = String(process.env.TEST_PORT_PAGOS || 4271);
const base = `http://localhost:${PUERTO}`;
const token = () => randomBytes(24).toString('hex');
let PRODUCTO = null;

const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const carrito = (tk, metodoPago, extra = {}) => ({
  checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente pago', telefono: '8997100001' },
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

async function metodos(activos) {
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [NEG]);
  for (const tipo of activos) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,TRUE)
       ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG, tipo]);
  }
}

// Clip con credenciales de FORMA valida: su testConnection solo valida forma,
// no hace red ni cobra nada. Es lo que necesita el gate de "hay con que cobrar"
// sin tocar ninguna API real.
async function conectarProveedor() {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
}
async function desconectarProveedor() {
  // Sin .catch: si la tabla o la columna cambian, la prueba debe reventar. Un
  // borrado que falla en silencio dejaria el proveedor conectado y el caso 13
  // pasaria por el motivo equivocado.
  await pool.query(
    `DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos'`, [NEG]);
}

async function limpiar() {
  await desconectarProveedor();
  await pool.query(`DELETE FROM pagos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
    [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Pagos (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Pagos (test)'`, [NEG]);
}

// Impresora y ruta REALES: sin esto, "cero comandas" no distingue entre "el
// gate funcionó" y "aquí nunca se imprime nada".
async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC PAGOS' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora pagos', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora pagos' },
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
     VALUES ($1,'Pagos (test)',TRUE,970) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto pagos',300,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
     VALUES ($1,'publicada',$2,'Pagos',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  await montarImpresion();
  await conectarProveedor();
}

let srv = null;
try {
  await preparar();
  srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

  // ═══ El P0: pago en línea no cocina antes de cobrar ═══
  await t('1. pago EN LÍNEA: el pedido nace pendiente_pago y NO genera comanda', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'enlace_pago'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = await pedidoDe(r.body.folio);
    assert.ok(p, 'el pedido no quedó persistido');
    assert.strictEqual(p.estado, 'pendiente_pago',
      `el pedido nació '${p.estado}': entraría a cocina sin haber cobrado`);
    assert.strictEqual(await trabajosDeFolio(r.body.folio), 0,
      '¡SE IMPRIMIÓ LA COMANDA SIN QUE EL CLIENTE PAGARA!');
    assert.strictEqual(p.datos.pago_confirmado, false, 'no quedó marcado como por cobrar');
  });

  await t('2. EFECTIVO conserva su comportamiento: comanda inmediata', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'efectivo'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = await pedidoDe(r.body.folio);
    assert.strictEqual(p.estado, 'nuevo', 'el efectivo dejó de entrar a cocina de inmediato');
    assert.strictEqual(await trabajosDeFolio(r.body.folio), 1,
      'el pedido en efectivo no generó su comanda');
  });

  await t('3. el pago confirmado libera la comanda: exactamente UNA', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'enlace_pago'));
    const folio = r.body.folio;
    assert.strictEqual(await trabajosDeFolio(folio), 0, 'imprimió antes de pagar');

    // Confirmación por el ÚNICO camino autorizado. Se invoca dentro del
    // proceso del servidor a través de su propia ruta de prueba de estado,
    // no reimplementando la transición aquí.
    const { rows: [p] } = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
    assert.ok(p, 'el pedido no existe');
    // La transición vive en el proceso servidor; se dispara por el mismo
    // mecanismo que usa el webhook: marcar el pago y confirmar el pedido.
    const rc = await fetch(`${base}/test/confirmar-pago-tienda`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
      body: JSON.stringify({ folio }),
    });
    assert.strictEqual(rc.status, 200, `no se pudo confirmar: ${await rc.text()}`);
    await new Promise(r2 => setTimeout(r2, 600));

    const despues = await pedidoDe(folio);
    assert.strictEqual(despues.estado, 'nuevo', 'el pedido no pasó a cocina tras confirmar el pago');
    assert.strictEqual(await trabajosDeFolio(folio), 1,
      'tras confirmar el pago no quedó exactamente 1 comanda');
  });

  await t('4. confirmar el mismo pago cinco veces deja UNA sola comanda', async () => {
    const tk = token();
    const r = await comprar(carrito(tk, 'enlace_pago'));
    const folio = r.body.folio;
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/test/confirmar-pago-tienda`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
        body: JSON.stringify({ folio }),
      });
    }
    await new Promise(r2 => setTimeout(r2, 700));
    assert.strictEqual(await trabajosDeFolio(folio), 1,
      'cinco confirmaciones produjeron más de una comanda');
    assert.strictEqual((await pedidoDe(folio)).estado, 'nuevo');
  });

  // ═══ Registro de proveedores ═══
  await t('5. Mercado Pago está implementado y PayPal registrado SIN fingir', async () => {
    const lista = listarProveedores();
    const mp = lista.find(p => p.id === 'mercado_pago');
    const pp = lista.find(p => p.id === 'paypal');
    assert.ok(mp, 'Mercado Pago no está en el registro');
    assert.strictEqual(mp.implementado, true, 'Mercado Pago sigue sin adaptador');
    assert.ok(obtenerAdaptador('mercado_pago'), 'no se resuelve el adaptador de Mercado Pago');
    assert.ok(pp, 'PayPal no está registrado');
    assert.strictEqual(pp.implementado, false, 'PayPal se declara implementado sin estarlo');
    assert.strictEqual(validarPuedeActivarse('paypal'), false,
      'PayPal podría activarse sin adaptador: eso es fingir una integración');
    assert.strictEqual(obtenerAdaptador('paypal'), null);
  });

  await t('6. el adaptador de Mercado Pago cumple la interfaz completa', async () => {
    const a = obtenerAdaptador('mercado_pago');
    for (const m of ['createPaymentLink', 'getPaymentStatus', 'cancelPayment', 'verifyWebhook',
                     'testConnection', 'getCapabilities']) {
      assert.strictEqual(typeof a[m], 'function', `falta ${m}`);
    }
    const cap = a.getCapabilities();
    assert.strictEqual(cap.createLink, true);
    assert.strictEqual(cap.webhookSignature, true, 'MP sí firma sus webhooks');
  });

  await t('7. sin credenciales del negocio, Mercado Pago falla cerrado', async () => {
    const a = obtenerAdaptador('mercado_pago');
    await assert.rejects(
      () => a.createPaymentLink({ total: 100, descripcion: 'x', cliente: {}, referencia: 'r', credenciales: {} }),
      /no está configurado/i,
      'creó un enlace sin credenciales del negocio');
    const prueba = await a.testConnection({});
    assert.strictEqual(prueba.ok, false);
  });

  await t('8. la firma del webhook de Mercado Pago es fail-closed', async () => {
    const { verifyWebhook } = obtenerAdaptador('mercado_pago');
    const req = { headers: { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'r1' }, query: { 'data.id': '99' } };
    assert.strictEqual(verifyWebhook(req, {}).verificado, false, 'aceptó sin secreto configurado');
    assert.strictEqual(verifyWebhook(req, { webhookSecret: 'abc' }).verificado, false, 'aceptó una firma falsa');
    assert.strictEqual(verifyWebhook({ headers: {}, query: {} }, { webhookSecret: 'abc' }).verificado, false,
      'aceptó sin cabecera');

    // Y con la firma correcta sí verifica: si esto fallara, el fail-closed
    // sería "nunca acepta nada", que no es una defensa sino una avería.
    const { createHmac } = await import('crypto');
    const secreto = 'secreto-de-prueba';
    const v1 = createHmac('sha256', secreto).update('id:99;request-id:r1;ts:1;').digest('hex');
    const ok = verifyWebhook(
      { headers: { 'x-signature': `ts=1,v1=${v1}`, 'x-request-id': 'r1' }, query: { 'data.id': '99' } },
      { webhookSecret: secreto });
    assert.strictEqual(ok.verificado, true, `la firma legítima fue rechazada: ${ok.motivo}`);
  });

  await t('9. la traducción de estados de Mercado Pago nunca inventa un "pagado"', async () => {
    const { traducirEstado } = await import('../src/services/providers/mercadoPagoProvider.js');
    assert.strictEqual(traducirEstado('approved'), 'pagado');
    assert.strictEqual(traducirEstado('rejected'), 'fallido');
    assert.strictEqual(traducirEstado('pending'), 'pendiente');
    assert.strictEqual(traducirEstado('cancelled'), 'cancelado');
    assert.strictEqual(traducirEstado('refunded'), 'reembolsado');
    // Lo desconocido NUNCA es pagado.
    assert.strictEqual(traducirEstado('un_estado_que_mp_invente_mañana'), 'requiere_revision');
    assert.strictEqual(traducirEstado(null), 'requiere_revision');
  });

  await t('10. un negocio sin proveedor en línea sigue vendiendo en efectivo', async () => {
    await metodos(['efectivo']);
    try {
      const tk = token();
      const r = await comprar(carrito(tk, 'efectivo'));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual((await pedidoDe(r.body.folio)).estado, 'nuevo');
      // Y el método en línea ya no se ofrece.
      const cat = await fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`).then(x => x.json());
      const ids = (cat.metodos || []).map(m => m.id);
      assert.ok(!ids.includes('enlace_pago'), 'ofrece pago en línea sin tenerlo habilitado');
    } finally {
      await metodos(['efectivo', 'enlace_pago']);
    }
  });

  // ═══ P0-1: el pago confirmado no puede perder la comanda por un crash ═══
  await t('11. crash ENTRE la transición y la emisión → la comanda se recupera, y sólo una', async () => {
    // El agujero: se movía el pedido a 'nuevo' y DESPUÉS se emitía. Un crash
    // en medio dejaba el dinero cobrado, el pedido en 'nuevo', y a la cocina
    // sin papel -- y ningún reintento lo arreglaba, porque el pedido ya no
    // estaba pendiente_pago y se daba por procesado.
    const tk = token();
    const r = await comprar(carrito(tk, 'enlace_pago'));
    const folio = r.body.folio;
    assert.strictEqual(await trabajosDeFolio(folio), 0, 'imprimió antes de pagar');

    // Servidor con el fallo inyectado EXACTAMENTE en esa ventana.
    if (srv) { try { await srv.detener(); } catch {} }
    srv = await arrancarServidor(
      { PORT: PUERTO, XABOR_PAGOS_FALLA_EN: 'antes_de_emitir_por_pago' }, { timeoutMs: 90000 });
    const rc = await fetch(`${base}/test/confirmar-pago-tienda`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
      body: JSON.stringify({ folio }),
    });
    assert.ok(rc.status >= 400, 'la confirmación no falló pese al fallo inyectado');

    // La deuda quedó escrita y el pedido ya no está pendiente_pago: el estado
    // exacto en el que antes se perdía la comanda para siempre.
    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'nuevo', 'la transición no se persistió');
    assert.strictEqual(p.datos.emision_pendiente, true,
      'no quedó marca durable de que faltaba emitir: la comanda se habría perdido');
    assert.strictEqual(await trabajosDeFolio(folio), 0, 'emitió pese al fallo');

    // PROCESO NUEVO, sin inyección: la reconciliación de arranque recoge la
    // deuda sin que nadie reintente desde fuera.
    if (srv) { try { await srv.detener(); } catch {} }
    srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });
    await new Promise(x => setTimeout(x, 2500));

    assert.strictEqual(await trabajosDeFolio(folio), 1,
      'tras el crash y el reinicio no quedó exactamente 1 comanda');
    const despues = await pedidoDe(folio);
    assert.strictEqual(despues.estado, 'nuevo');
    assert.ok(!('emision_pendiente' in despues.datos), 'la deuda no se saldó tras emitir');
  });

  await t('12. cinco confirmaciones más tras la recuperación → sigue habiendo 1 comanda', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT folio FROM pedidos_activos
        WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online' AND estado = 'nuevo'
        ORDER BY updated_at DESC LIMIT 1`, [NEG]);
    assert.ok(r, 'no hay pedido recuperado que reintentar');
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/test/confirmar-pago-tienda`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
        body: JSON.stringify({ folio: r.folio }),
      });
    }
    await new Promise(x => setTimeout(x, 700));
    assert.strictEqual(await trabajosDeFolio(r.folio), 1,
      'cinco reintentos posteriores produjeron comandas de más');
  });

  // ═══ P0-3: no ofrecer pago en línea sin proveedor real ═══
  await t('13. con enlace_pago habilitado pero SIN integración, la tienda NO lo ofrece', async () => {
    // Misma fila habilitada, pero sin proveedor conectado: no basta.
    await desconectarProveedor();
    const cat = await fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`).then(x => x.json());
    const ids = (cat.metodos || []).map(m => m.id);
    assert.ok(!ids.includes('enlace_pago'),
      'ofrece "Pagar en línea" sin proveedor: cada pedido quedaría condenado a pendiente_pago');
    assert.ok(ids.includes('efectivo'), 'el efectivo dejó de funcionar');
  });

  await t('14. y el checkout tampoco lo acepta por la puerta de atrás', async () => {
    const r = await comprar(carrito(token(), 'enlace_pago'));
    assert.ok(r.status >= 400,
      'aceptó un método de pago que la tienda no ofrece: pedido condenado a pendiente_pago');
    await conectarProveedor();
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  if (srv) { try { await srv.detener(); } catch {} }
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-pagos-online-tienda: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
