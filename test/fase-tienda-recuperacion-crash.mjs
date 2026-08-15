// ─── Consistencia del checkout ante un crash a media creación ──────────────
//
// La ventana peligrosa: el pedido ya es durable (registrarPedido terminó) pero
// las derivaciones todavía no. Si en ese punto el proceso muere, lo que NO
// puede pasar es que un reintento con el mismo token cree un segundo pedido,
// ni que la promoción vuelva al bote como si el pedido no existiera.
//
// Los fallos no se esperan: se INYECTAN en el punto exacto, con
// XABOR_TIENDA_FALLA_EN. Cada escenario levanta su propio servidor con el
// punto de fallo puesto, provoca el fallo, apaga la inyección y reintenta.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const ADMIN = `xabor_sesion=${encodeURIComponent(
  crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
const SLUG = 'recuperacion-crash';
const PUERTO_BASE = Number(process.env.TEST_PORT || 4213);

let PRODUCTO = null;
const token = () => randomBytes(24).toString('hex');

// Cada escenario corre en su propio servidor: así el punto de fallo inyectado
// vive en el proceso que de verdad atiende la petición.
async function conServidor(env, fn) {
  const puerto = String(PUERTO_BASE + (conServidor.n = (conServidor.n || 0) + 1));
  const srv = await arrancarServidor(
    { PORT: puerto, XABOR_TIENDA_LIMITE_CHECKOUT: '500', XABOR_TIENDA_LIMITE_COTIZAR: '500', ...env },
    { timeoutMs: 90000 });
  try {
    // initDB() resiembra en CADA arranque el modo legado de Nonna Maye. Si se
    // deja, habria DOS negocios candidatos y el servidor rechazaria toda
    // conexion legada -- correcto para el producto, inservible para esta suite,
    // que necesita que el negocio de prueba sea el unico legado.
    await pool.query(
      `DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'print_agent_legacy_activo'`,
      [SEED.nonnaMayeId]).catch(() => {});
    return await fn(`http://localhost:${puerto}`, srv);
  } finally {
    // Se guarda el log del hijo: cuando algo devuelve 500, el detalle solo
    // existe ahi y el proceso ya murio cuando se lee.
    ultimoLog = srv.obtenerSalida();
    await srv.detener();
  }
}
let ultimoLog = '';

const comprar = (base, cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const carrito = (tk, extra = {}) => ({
  checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente crash', telefono: '8998000001' },
  metodoPago: 'efectivo', ...extra,
});

// ── Consultas de verificación ──
async function pedidosDelToken(tk) {
  const { rows } = await pool.query(
    `SELECT folio, datos FROM pedidos_activos
      WHERE negocio_id = $1 AND datos->'tienda'->>'checkout_token' = $2`, [NEG, tk]);
  return rows;
}
async function trabajosDeFolio(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id = $1 AND origen_tipo = 'pedido' AND origen_id = $2`, [NEG, folio]);
  return r.n;
}
async function usosDeCodigo(codigo, { soloConfirmados = true } = {}) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos u
       JOIN tienda_promociones p ON p.id = u.promocion_id
      WHERE u.negocio_id = $1 AND p.codigo = $2
        ${soloConfirmados ? "AND u.pedido_folio NOT LIKE 'reserva:%'" : ''}`, [NEG, codigo]);
  return r.n;
}
async function contadorUsos(codigo) {
  const { rows: [r] } = await pool.query(
    `SELECT usos FROM tienda_promociones WHERE negocio_id = $1 AND codigo = $2`, [NEG, codigo]);
  return Number(r?.usos ?? -1);
}
async function filaTiendaPedido(tk) {
  const { rows: [r] } = await pool.query(
    `SELECT pedido_folio, estado, tracking_token FROM tienda_pedidos
      WHERE negocio_id = $1 AND checkout_token = $2`, [NEG, tk]);
  return r || null;
}

async function crearPromo(base, datos) {
  const r = await fetch(`${base}/api/admin/tienda/promociones`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN },
    body: JSON.stringify(datos),
  });
  assert.strictEqual(r.status, 200, 'no se creó la promoción: ' + (await r.text()));
}

async function limpiar() {
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_legacy_emitida WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM notificaciones_repartidor WHERE pedido_folio IN
    (SELECT folio FROM pedidos_activos WHERE negocio_id = $1)`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM repartidores WHERE negocio_id = $1 AND telefono LIKE '8998%'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
    [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM pedidos WHERE negocio_id = $1 AND telefono LIKE '8998%'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Crash (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Crash (test)'`, [NEG]);
}

// Una impresora y una ruta de verdad. Sin esto no hay trabajo de comanda que
// contar, y "<= 1" no distingue entre "no se duplicó" y "nunca se imprimió".
async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  const { rows: [suc] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
    [NEG]).catch(() => {});
  const term = await crearEdge(NEG, { nombre: 'PC CRASH' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora crash', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora crash' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
  return { sucursalId: suc.id, impresoraId: imp.id };
}

// ── Observadores de los dos consumidores que NO deduplican solos ──
// El print-agent legacy (raíz "/") y el panel (/ws/panel). Contarlos de verdad
// es la única forma de distinguir "no se duplicó" de "nunca pasó nada".
function abrirWS(base, ruta, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http://', 'ws://') + ruta,
      cookie ? { headers: { Cookie: cookie } } : undefined);
    const to = setTimeout(() => reject(new Error('timeout abriendo WS ' + ruta)), 8000);
    ws.on('open', () => { clearTimeout(to); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Devuelve un arreglo VIVO: se llena conforme llegan los mensajes.
//
// Se engancha DESPUES de dejar pasar el volcado inicial: al conectarse, tanto
// el panel como el print-agent legacy reciben el tablero completo como una
// ráfaga de 'nuevo_pedido'. Contarlo sería contar historia vieja, no la
// emisión que se está probando.
function espiar(ws, filtro) {
  const vistos = [];
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw.toString()); } catch { return; }
    if (filtro(d)) vistos.push(d);
  });
  return vistos;
}

// Probar que algo NO llega exige esperar un poco: no hay evento de "ya no va a
// llegar nada". Es sincronización de la prueba, no del producto -- el código
// bajo prueba no espera nada.
const asentar = (ms = 600) => new Promise(r => setTimeout(r, ms));

async function filasLegacyEmitidas(folio) {
  const { rows } = await pool.query(
    `SELECT print_job_id, destinatarios FROM impresion_legacy_emitida
      WHERE negocio_id = $1 AND print_job_id = $2`, [NEG, `${folio}:comanda`]);
  return rows;
}
async function historialDeFolio(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pedidos WHERE negocio_id = $1 AND folio = $2`, [NEG, folio]);
  return r.n;
}
async function derivacionesDe(tk) {
  const { rows: [r] } = await pool.query(
    `SELECT derivaciones FROM tienda_pedidos WHERE negocio_id = $1 AND checkout_token = $2`,
    [NEG, tk]);
  return r?.derivaciones || {};
}

// Modo legacy: sin Edge montado (si Edge se hace cargo, el camino viejo ni se
// intenta) y con la configuración que lo elige explícitamente.
async function ponerModoLegacy(activo) {
  if (activo) {
    await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]);
    await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]);
    await pool.query(
      `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
      [NEG]);
  }
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor)
     VALUES ($1,'print_agent_legacy_activo',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`,
    [NEG, activo ? 'true' : 'false']);
}

async function preparar() {
  await limpiar();
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG, m]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
     VALUES ($1,'Crash (test)',TRUE,960) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto crash',200,TRUE,1) RETURNING id`, [NEG, cat.id]);
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
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [NEG]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'efectivo',TRUE)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'Crash',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
}

try {
  await preparar();
  await montarImpresion();

  // ─── A) Crash DESPUÉS de registrarPedido, ANTES de vincular ───
  await t('A. crash tras crear el pedido y antes de vincularlo → el retry NO crea otro', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_registrar' }, async (base) => {
      const r = await comprar(base, carrito(tk));
      assert.ok(r.status >= 400, 'el checkout no falló pese al fallo inyectado');
    });
    // El pedido YA existe y la fila de tienda_pedidos no tiene folio.
    const antes = await pedidosDelToken(tk);
    assert.strictEqual(antes.length, 1, `esperaba 1 pedido huérfano, hay ${antes.length}`);
    const fila = await filaTiendaPedido(tk);
    assert.strictEqual(fila?.pedido_folio, null, 'el vínculo no debería existir todavía');

    // Retry sin inyección: tiene que recuperar, no crear.
    let respuesta;
    await conServidor({}, async (base) => { respuesta = await comprar(base, carrito(tk)); });
    assert.strictEqual(respuesta.status, 200, JSON.stringify(respuesta.body));
    assert.strictEqual(respuesta.body.folio, antes[0].folio, 'devolvió un folio distinto');

    const despues = await pedidosDelToken(tk);
    assert.strictEqual(despues.length, 1, `¡SE DUPLICÓ EL PEDIDO! quedaron ${despues.length}`);
    const filaFinal = await filaTiendaPedido(tk);
    assert.strictEqual(filaFinal.pedido_folio, antes[0].folio, 'el vínculo no se reparó');
    assert.strictEqual(filaFinal.estado, 'creado');
  });

  await t('A2. el retry devuelve el MISMO tracking token, no uno nuevo', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_registrar' }, async (base) => {
      await comprar(base, carrito(tk));
    });
    const trackingReservado = (await filaTiendaPedido(tk))?.tracking_token;
    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk)); });
    assert.strictEqual(r.body.trackingToken, trackingReservado,
      'el cliente recibiría una liga de seguimiento distinta a la reservada');
  });

  await t('A3. la BASE impide el duplicado aunque el código fallara', async () => {
    // Se intenta insertar a mano un segundo pedido con el mismo token: el
    // índice único tiene que rechazarlo. Sin esto, la garantía dependería solo
    // de que el código nunca se equivoque.
    const tk = token();
    await conServidor({}, async (base) => {
      const r = await comprar(base, carrito(tk));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    });
    const [p] = await pedidosDelToken(tk);
    let rechazado = false;
    try {
      await pool.query(
        `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
         VALUES ($1, $2, 'nuevo', $3)`,
        [`DUP-${Date.now()}`, NEG, JSON.stringify(p.datos)]);
    } catch (e) { rechazado = e.code === '23505'; }
    assert.ok(rechazado, 'la base ACEPTÓ un segundo pedido con el mismo checkout_token');
  });

  // ─── B) Crash tras vincular, antes de confirmar la promoción ───
  await t('B. crash tras vincular: la reserva vencida NO devuelve el cupón, lo reconcilia', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_vincular' }, async (base) => {
      await crearPromo(base, { nombre: 'Reconciliable', tipo: 'monto_fijo', valor: 20,
        codigo: 'RECONCILIA', limiteUsos: 1 });
      const r = await comprar(base, carrito(tk, { codigo: 'RECONCILIA' }));
      assert.ok(r.status >= 400, 'no falló pese a la inyección');
    });

    const [pedido] = await pedidosDelToken(tk);
    assert.ok(pedido, 'el pedido debería existir: el fallo fue después de crearlo');
    assert.strictEqual(await contadorUsos('RECONCILIA'), 1, 'el cupo se soltó pese a haber pedido');

    // El RETRY NORMAL debe dejar la promoción confirmada. Sin llamar a mano a
    // ninguna reconciliación: un cliente que reintenta no ejecuta scripts de
    // mantenimiento.
    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk, { codigo: 'RECONCILIA' })); });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.folio, pedido.folio);

    assert.strictEqual(await usosDeCodigo('RECONCILIA'), 1,
      'tras el retry la promoción sigue como reserva, no atribuida al pedido');
    assert.strictEqual(await contadorUsos('RECONCILIA'), 1, 'el contador se descuadró');
    const { rows: [reservas] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos u
         JOIN tienda_promociones p ON p.id = u.promocion_id
        WHERE u.negocio_id = $1 AND p.codigo = 'RECONCILIA' AND u.pedido_folio LIKE 'reserva:%'`, [NEG]);
    assert.strictEqual(reservas.n, 0, 'quedó la reserva sin confirmar tras el retry');

    // Y el cupón sigue agotado para el siguiente cliente, como debe ser.
    await conServidor({}, async (base) => {
      const otro = await comprar(base, {
        ...carrito(token(), { codigo: 'RECONCILIA' }),
        cliente: { nombre: 'Otro', telefono: '8998000099' } });
      const seLlevoDescuento = otro.status === 200 && (otro.body.ahorro || 0) > 0;
      assert.ok(!seLlevoDescuento, 'el cupón de un solo uso volvió a estar disponible');
    });
  });

  await t('B2. el uso reconciliado apunta al folio REAL, no a la reserva', async () => {
    const { rows } = await pool.query(
      `SELECT u.pedido_folio FROM tienda_promocion_usos u
         JOIN tienda_promociones p ON p.id = u.promocion_id
        WHERE u.negocio_id = $1 AND p.codigo = 'RECONCILIA'`, [NEG]);
    assert.strictEqual(rows.length, 1);
    assert.ok(!rows[0].pedido_folio.startsWith('reserva:'),
      `el uso quedó como reserva: ${rows[0].pedido_folio}`);
    const { rows: existe } = await pool.query(
      `SELECT 1 FROM pedidos_activos WHERE negocio_id = $1 AND folio = $2`, [NEG, rows[0].pedido_folio]);
    assert.strictEqual(existe.length, 1, 'el uso apunta a un pedido que no existe');
  });

  await t('B3. si NADIE reintenta, el barrido de reservas vencidas reconcilia igual', async () => {
    // El retry es el camino normal, pero un cliente puede cerrar la pestaña y
    // no volver. Entonces la reserva caduca -- y aun así no puede devolver el
    // cupo, porque el pedido existe.
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_vincular' }, async (base) => {
      await crearPromo(base, { nombre: 'Sin retry', tipo: 'monto_fijo', valor: 20,
        codigo: 'SINRETRY', limiteUsos: 1 });
      await comprar(base, carrito(tk, { codigo: 'SINRETRY' }));
    });
    const [pedido] = await pedidosDelToken(tk);
    assert.ok(pedido, 'el pedido debería existir');

    await pool.query(
      `UPDATE tienda_promocion_usos SET created_at = NOW() - INTERVAL '1 hour'
        WHERE negocio_id = $1 AND pedido_folio LIKE 'reserva:%'`, [NEG]);
    const { reconciliarReservasVencidas } = await import('../src/services/tiendaPromociones.js');
    const resumen = await reconciliarReservasVencidas(NEG);
    assert.strictEqual(resumen.liberadas, 0,
      'liberó un cupo cuyo checkout SÍ produjo pedido');
    assert.strictEqual(await usosDeCodigo('SINRETRY'), 1, 'no quedó atribuido al pedido real');
    assert.strictEqual(await contadorUsos('SINRETRY'), 1);
  });

  // ─── C) Crash antes de emitir la comanda ───
  await t('C. crash antes de emitir → 0 comandas; el retry deja EXACTAMENTE 1', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      const r = await comprar(base, carrito(tk));
      assert.ok(r.status >= 400, 'no falló pese a la inyección');
    });
    const [pedido] = await pedidosDelToken(tk);
    assert.ok(pedido, 'el pedido debería existir');
    assert.strictEqual(await trabajosDeFolio(pedido.folio), 0,
      'el crash fue ANTES de emitir: no debería haber comandas todavía');

    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk)); });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.folio, pedido.folio);
    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');
    assert.strictEqual(await trabajosDeFolio(pedido.folio), 1,
      'el retry no dejó exactamente una comanda por destino');
  });

  await t('C2. cinco reintentos posteriores: sigue habiendo 1 pedido y 1 comanda', async () => {
    const tk = token();
    let folio;
    await conServidor({}, async (base) => {
      const r = await comprar(base, carrito(tk));
      folio = r.body.folio;
      assert.strictEqual(await trabajosDeFolio(folio), 1, 'el checkout normal no imprimió');
      for (let i = 0; i < 5; i++) {
        const rr = await comprar(base, carrito(tk));
        assert.strictEqual(rr.body.folio, folio, 'un reintento devolvió otro folio');
      }
    });
    assert.strictEqual((await pedidosDelToken(tk)).length, 1);
    assert.strictEqual(await trabajosDeFolio(folio), 1,
      'seis intentos dejaron más de una comanda por destino');
  });

  await t('C3. crash tras vincular (folio YA existe): el retry emite la comanda faltante', async () => {
    // Este es el caso que un `return` temprano dejaba a medias: hay folio, así
    // que el reintento respondía 200 sin emitir nada. La cocina nunca veía el
    // papel y el cliente creía que todo estaba listo.
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_vincular' }, async (base) => {
      const r = await comprar(base, carrito(tk));
      assert.ok(r.status >= 400, 'no falló pese a la inyección');
    });
    const [pedido] = await pedidosDelToken(tk);
    const fila = await filaTiendaPedido(tk);
    assert.strictEqual(fila.pedido_folio, pedido.folio, 'el vínculo debería existir ya');
    assert.strictEqual(await trabajosDeFolio(pedido.folio), 0, 'no debería haber comanda aún');

    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk)); });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.folio, pedido.folio);
    assert.strictEqual(await trabajosDeFolio(pedido.folio), 1,
      'el retry devolvió 200 pero la comanda nunca se emitió');
  });

  // ─── D) Concurrencia + fallo inyectado ───
  await t('D. 10 intentos concurrentes tras un crash → 1 pedido, 1 atribución, 1 juego de comandas', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_registrar' }, async (base) => {
      await crearPromo(base, { nombre: 'Concurrente', tipo: 'monto_fijo', valor: 15,
        codigo: 'CONCURRE', limiteUsos: 10 });
      await comprar(base, carrito(tk, { codigo: 'CONCURRE' }));
    });
    const huerfano = await pedidosDelToken(tk);
    assert.strictEqual(huerfano.length, 1, 'no quedó el pedido huérfano esperado');

    let respuestas;
    await conServidor({}, async (base) => {
      respuestas = await Promise.all(
        Array.from({ length: 10 }, () => comprar(base, carrito(tk, { codigo: 'CONCURRE' }))));
    });
    const exitosas = respuestas.filter(r => r.status === 200);
    assert.ok(exitosas.length >= 1, 'ninguno de los 10 recuperó el pedido');
    const folios = new Set(exitosas.map(r => r.body.folio));
    assert.strictEqual(folios.size, 1, `los 10 intentos produjeron ${folios.size} folios distintos`);

    const finales = await pedidosDelToken(tk);
    assert.strictEqual(finales.length, 1, `¡${finales.length} pedidos para un solo checkout!`);

    const { rows: [atrib] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos u
         JOIN tienda_promociones p ON p.id = u.promocion_id
        WHERE u.negocio_id = $1 AND p.codigo = 'CONCURRE'`, [NEG]);
    assert.strictEqual(atrib.n, 1, `la promoción se atribuyó ${atrib.n} veces`);
    assert.strictEqual(await contadorUsos('CONCURRE'), 1, 'el contador global se descuadró');

    assert.strictEqual(await trabajosDeFolio(finales[0].folio), 1,
      'los 10 intentos concurrentes no dejaron exactamente una comanda por destino');
  });

  await t('D2. repartidores: reintentar finalizar NO manda ofertas duplicadas', async () => {
    // Un pedido a domicilio elegible para la red de repartidores. Lo que se
    // exige es que la oferta salga UNA vez, aunque el checkout se finalice
    // varias: cada notificación es un WhatsApp real a una persona.
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG, JSON.stringify(['recoger', 'domicilio'])]);
    const { rows: [rep] } = await pool.query(
      `INSERT INTO repartidores (negocio_id, nombre, telefono, activo)
       VALUES ($1,'Repartidor crash','8998777001',TRUE)
       ON CONFLICT DO NOTHING RETURNING id`, [NEG]).catch(() => ({ rows: [] }));

    const tk = token();
    let folio;
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'despues_de_emitir' }, async (base) => {
      const r = await comprar(base, {
        checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
        modalidad: 'domicilio', direccion: 'Calle Crash 10', colonia: 'Centro',
        cliente: { nombre: 'Domicilio crash', telefono: '8998000200' }, metodoPago: 'efectivo' });
      assert.ok(r.status >= 400, 'no falló pese a la inyección');
      // Que falle no basta: tiene que fallar por la INYECCIÓN, después de
      // crear el pedido. Si falla antes (config, dirección), la prueba no
      // estaría probando lo que dice.
      assert.ok(!/domicilio|dirección|direccion|zona|mínimo/i.test(JSON.stringify(r.body)),
        `falló ANTES de crear el pedido: ${JSON.stringify(r.body)}`);
    });
    [{ folio } = {}] = await pedidosDelToken(tk);
    assert.ok(folio, 'el pedido debería existir');
    const trasCrash = await trabajosDeFolio(folio);
    const { rows: [n1] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notificaciones_repartidor WHERE pedido_folio = $1`, [folio])
      .catch(() => ({ rows: [{ n: 0 }] }));

    // Tres reintentos: la emisión ya está marcada, así que no vuelve a correr.
    await conServidor({}, async (base) => {
      for (let i = 0; i < 3; i++) await comprar(base, carrito(tk));
    });
    const { rows: [n2] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notificaciones_repartidor WHERE pedido_folio = $1`, [folio])
      .catch(() => ({ rows: [{ n: 0 }] }));

    assert.strictEqual(n2.n, n1.n,
      `se mandaron ofertas de más a repartidores: ${n1.n} → ${n2.n}`);
    assert.strictEqual(await trabajosDeFolio(folio), trasCrash,
      'los reintentos volvieron a emitir la comanda');
    assert.strictEqual((await pedidosDelToken(tk)).length, 1);
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG, JSON.stringify(['recoger'])]);
    if (rep?.id) await pool.query(`DELETE FROM repartidores WHERE id = $1`, [rep.id]).catch(() => {});
  });

  await t('D3. el ledger registra qué derivaciones se completaron', async () => {
    const tk = token();
    await conServidor({}, async (base) => { await comprar(base, carrito(tk)); });
    const { rows: [r] } = await pool.query(
      `SELECT derivaciones FROM tienda_pedidos WHERE negocio_id = $1 AND checkout_token = $2`,
      [NEG, tk]);
    const hechas = Object.keys(r.derivaciones || {});
    assert.ok(hechas.includes('emision'), `el ledger no marcó la emisión: ${hechas.join(', ')}`);
    assert.ok(hechas.includes('historial'), `el ledger no marcó el historial: ${hechas.join(', ')}`);
  });

  await t('D4. crash ENTRE derivaciones: cada reanudación retoma solo lo que falta', async () => {
    // Se recorre la lista de puntos de fallo en orden. Tras cada crash, un
    // reintento; al final, exactamente un pedido y una comanda.
    const tk = token();
    const puntos = ['despues_de_registrar', 'despues_de_vincular', 'antes_de_emitir', 'despues_de_emitir'];
    for (const punto of puntos) {
      await conServidor({ XABOR_TIENDA_FALLA_EN: punto }, async (base) => {
        await comprar(base, carrito(tk));
      });
    }
    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk)); });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const finales = await pedidosDelToken(tk);
    assert.strictEqual(finales.length, 1, `cuatro crashes dejaron ${finales.length} pedidos`);
    assert.strictEqual(await trabajosDeFolio(finales[0].folio), 1,
      'cuatro crashes y una reanudación no dejaron exactamente una comanda');
  });

  // ─── E) Fallo ANTES de crear el pedido: sí se suelta todo ───
  await t('E. si el checkout falla ANTES de crear el pedido, token y promoción se liberan', async () => {
    const tk = token();
    await conServidor({}, async (base) => {
      await crearPromo(base, { nombre: 'Liberable crash', tipo: 'monto_fijo', valor: 10,
        codigo: 'LIBERACRASH', limiteUsos: 2, limitePorCliente: 1 });
      // Domicilio sin dirección: revienta en construirOrdenPOS, ANTES de
      // registrarPedido, pero DESPUÉS de reservar la promoción.
      await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
        [NEG, JSON.stringify(['recoger', 'domicilio'])]);
      const r = await comprar(base, {
        checkoutToken: tk, items: [{ productoId: PRODUCTO, cantidad: 1 }],
        modalidad: 'domicilio', codigo: 'LIBERACRASH',
        cliente: { nombre: 'Sin dir', telefono: '8998000050' }, metodoPago: 'efectivo',
      });
      assert.ok(r.status >= 400, 'el pedido inválido se creó');
    });

    assert.strictEqual((await pedidosDelToken(tk)).length, 0, 'se creó un pedido que no debía existir');
    assert.strictEqual(await filaTiendaPedido(tk), null, 'la reserva del token no se liberó');
    assert.strictEqual(await contadorUsos('LIBERACRASH'), 0, 'el cupo quedó quemado sin pedido');
    assert.strictEqual(await usosDeCodigo('LIBERACRASH', { soloConfirmados: false }), 0,
      'quedó una fila de reserva colgada');

    // Y el mismo cliente puede reintentar bien y sí obtiene la promoción.
    await conServidor({}, async (base) => {
      const ok = await comprar(base, carrito(token(), { codigo: 'LIBERACRASH' }));
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.ok((ok.body.ahorro || 0) > 0, 'el cliente perdió la promoción por un intento inválido');
    });
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG, JSON.stringify(['recoger'])]);
  });

  // ─── Invariantes finales ───
  await t('F. ningún checkout de esta suite dejó dos pedidos', async () => {
    const { rows } = await pool.query(
      `SELECT datos->'tienda'->>'checkout_token' AS tk, COUNT(*)::int AS n
         FROM pedidos_activos
        WHERE negocio_id = $1 AND datos->'tienda'->>'checkout_token' IS NOT NULL
        GROUP BY 1 HAVING COUNT(*) > 1`, [NEG]);
    assert.deepStrictEqual(rows, [], `checkouts con más de un pedido: ${JSON.stringify(rows)}`);
  });

  await t('G. no quedó ninguna reserva de promoción colgada', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos
        WHERE negocio_id = $1 AND pedido_folio LIKE 'reserva:%'`, [NEG]);
    assert.strictEqual(r.n, 0, `${r.n} reservas sin confirmar ni liberar`);
  });

  await t('H. todo pedido creado quedó vinculado a su checkout', async () => {
    const { rows } = await pool.query(
      `SELECT p.folio FROM pedidos_activos p
        WHERE p.negocio_id = $1 AND p.datos->>'canal' = 'tienda_online'
          AND NOT EXISTS (
            SELECT 1 FROM tienda_pedidos tp
             WHERE tp.negocio_id = p.negocio_id AND tp.pedido_folio = p.folio)`, [NEG]);
    assert.deepStrictEqual(rows.map(r => r.folio), [],
      'hay pedidos de tienda sin vínculo en tienda_pedidos');
  });

  await t('I. la inyección de fallos NO puede activarse en producción', async () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'tiendaCheckout.js'), 'utf8');
    assert.ok(/NODE_ENV === 'production'/.test(src),
      'fallaInyectada no está bloqueada en producción');
    const bloque = src.slice(src.indexOf('function fallaInyectada'), src.indexOf('function fallaInyectada') + 400);
    assert.ok(bloque.indexOf("NODE_ENV === 'production'") < bloque.indexOf('XABOR_TIENDA_FALLA_EN'),
      'el guardia de producción no es lo primero que se evalúa');
  });

  // ─── Borrar una campaña no revienta (SET NULL acotado) ───
  await t('J. borrar una campaña con promociones no falla y solo nulea campania_id', async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO tienda_campanas (negocio_id, nombre) VALUES ($1,'Campaña borrable') RETURNING id`, [NEG]);
    const { rows: [pr] } = await pool.query(
      `INSERT INTO tienda_promociones (negocio_id, nombre, tipo, automatica, valor, campania_id)
       VALUES ($1,'Con campaña','porcentaje',TRUE,5,$2) RETURNING id`, [NEG, c.id]);
    await pool.query(`DELETE FROM tienda_campanas WHERE id = $1`, [c.id]);
    const { rows: [q] } = await pool.query(
      `SELECT negocio_id, campania_id FROM tienda_promociones WHERE id = $1`, [pr.id]);
    assert.strictEqual(q.campania_id, null, 'campania_id no se nuleó');
    assert.strictEqual(q.negocio_id, NEG, 'negocio_id se perdió al borrar la campaña');
    await pool.query(`DELETE FROM tienda_promociones WHERE id = $1`, [pr.id]);
  });

  // ═══ K) Concurrencia del ledger: el claim tiene que ser atómico ═══
  //
  // El bug que cierran estos casos: derivacion() consultaba "¿está pendiente?",
  // ejecutaba y marcaba después. Dos finalizadores simultáneos leían
  // "pendiente" a la vez y los dos ejecutaban la misma derivación. Para
  // `emision` eso eran dos comandas legacy y dos avisos al panel.
  //
  // Se prueban los DOS consumidores que no deduplican por su cuenta: el
  // print-agent legacy y el panel.

  await t('K1. legacy: 10 reintentos SIMULTÁNEOS dejan UN SOLO broadcast', async () => {
    await ponerModoLegacy(true);
    const tk = token();
    let folio = null;

    // Checkout que muere antes de emitir: el pedido existe, la comanda no.
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      const r = await comprar(base, carrito(tk));
      assert.ok(r.status >= 400, 'el checkout no falló pese al fallo inyectado');
    });
    folio = (await pedidosDelToken(tk))[0]?.folio;
    assert.ok(folio, 'no quedó el pedido huérfano');
    assert.strictEqual((await filasLegacyEmitidas(folio)).length, 0,
      'no debería haber salido nada por legacy todavía');

    await conServidor({}, async (base) => {
      const espia = await abrirWS(base, '/');
      await asentar(400); // volcado inicial del tablero
      const legacy = espiar(espia, d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);
      const rs = await Promise.all(Array.from({ length: 10 }, () => comprar(base, carrito(tk))));
      await asentar();
      espia.close();
      assert.ok(rs.every(r => r.status === 200), 'algún reintento no respondió 200');
      assert.strictEqual(legacy.length, 1,
        `el print-agent legacy recibió ${legacy.length} comandas del folio ${folio} (debe ser exactamente 1)`);
      assert.strictEqual(legacy[0].printJobId, `${folio}:comanda`,
        'el mensaje legacy salió sin printJobId determinista: nada podría deduplicarlo');
      assert.strictEqual(legacy[0].tipoDocumento, 'comanda');
    });

    const filas = await filasLegacyEmitidas(folio);
    assert.strictEqual(filas.length, 1, 'el ledger de impresión legacy no registró exactamente una emisión');
  });

  await t('K2. dos finalizadores simultáneos: solo UNO entra a la derivación emision', async () => {
    // El aviso al panel se emite DENTRO de la derivación y no lo deduplica
    // ningún ledger: contarlo mide directamente cuántos procesos entraron.
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      await comprar(base, carrito(tk));
    });
    const folio = (await pedidosDelToken(tk))[0]?.folio;

    await conServidor({}, async (base) => {
      const panel = await abrirWS(base, '/ws/panel', ADMIN);
      // El panel recibe un volcado inicial del tablero al conectarse: se deja
      // pasar y se cuenta solo lo que llega DESPUÉS.
      await asentar(400);
      const avisos = espiar(panel, d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);
      await Promise.all([comprar(base, carrito(tk)), comprar(base, carrito(tk))]);
      await asentar();
      panel.close();
      assert.strictEqual(avisos.length, 1,
        `la derivación emision corrió ${avisos.length} veces con dos finalizadores simultáneos`);
    });
  });

  await t('K3. crash DESPUÉS de imprimir por legacy y ANTES de marcar → el retry NO reimprime', async () => {
    // El caso que un lock no puede resolver: el efecto externo ya ocurrió y la
    // marca no llegó a escribirse. Solo la idempotencia real del efecto salva
    // el papel. El proceso además MUERE entre los dos intentos: la memoria
    // tiene que estar en la base, no en el proceso.
    const tk = token();
    let folio = null;

    await conServidor({ XABOR_TIENDA_FALLA_EN: 'emitido_sin_marcar' }, async (base) => {
      const espia = await abrirWS(base, '/');
      await asentar(400); // volcado inicial del tablero
      const legacy = espiar(espia, d => d.tipo === 'nuevo_pedido');
      const r = await comprar(base, carrito(tk));
      await asentar();
      espia.close();
      assert.ok(r.status >= 400, 'el checkout no falló pese al fallo inyectado');
      assert.strictEqual(legacy.length, 1, 'el papel no llegó a salir: el escenario no se reprodujo');
      folio = legacy[0].pedido?.id;
    });

    assert.ok(!('emision' in await derivacionesDe(tk)),
      'la marca se escribió pese al fallo: el escenario no se reprodujo');
    assert.strictEqual((await filasLegacyEmitidas(folio)).length, 1,
      'el ledger de impresión no recordó la emisión que sí ocurrió');

    // Servidor NUEVO -- proceso nuevo, memoria en cero.
    await conServidor({}, async (base) => {
      const espia = await abrirWS(base, '/');
      await asentar(400); // volcado inicial del tablero
      const legacy = espiar(espia, d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);
      const r = await comprar(base, carrito(tk));
      await asentar();
      espia.close();
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(legacy.length, 0,
        '¡PAPEL DUPLICADO! el reintento volvió a mandar la comanda al print-agent legacy');
    });

    assert.strictEqual((await filasLegacyEmitidas(folio)).length, 1,
      'el ledger de impresión legacy quedó con más de una emisión');
    assert.ok('emision' in await derivacionesDe(tk), 'el reintento no completó la derivación');
    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');
  });

  await t('K4. cinco reintentos más tras la recuperación: ni una comanda legacy extra', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      await comprar(base, carrito(tk));
    });
    const folio = (await pedidosDelToken(tk))[0]?.folio;
    await conServidor({}, async (base) => {
      const espia = await abrirWS(base, '/');
      await asentar(400); // volcado inicial del tablero
      const legacy = espiar(espia, d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);
      for (let i = 0; i < 6; i++) {
        const r = await comprar(base, carrito(tk));
        assert.strictEqual(r.status, 200, `reintento ${i}: ${JSON.stringify(r.body)}`);
      }
      await asentar();
      espia.close();
      assert.strictEqual(legacy.length, 1, `salieron ${legacy.length} comandas legacy en seis intentos`);
    });
    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');
  });

  await t('K5. el panel además deduplica por folio del lado del consumidor', async () => {
    // Segunda línea de defensa, la que sigue valiendo si un día el evento se
    // emite dos veces por otra causa. Se comprueba en el código que corre en
    // el navegador, no en una imitación.
    const panel = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    const i = panel.indexOf('function agregarPedido(');
    assert.ok(i > 0, 'no se encontró agregarPedido en el panel');
    const cuerpo = panel.slice(i, i + 400);
    assert.ok(/getElementById\(`comanda-\$\{pedido\.id\}`\)\)\s*return/.test(cuerpo),
      'agregarPedido ya no descarta un folio que ya está en el tablero');
  });

  await t('K6. con Edge de vuelta: 10 concurrentes → 1 trabajo por destino y 1 aviso al panel', async () => {
    await ponerModoLegacy(false);
    await montarImpresion();
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      await comprar(base, carrito(tk));
    });
    const folio = (await pedidosDelToken(tk))[0]?.folio;
    assert.strictEqual(await trabajosDeFolio(folio), 0, 'había comandas antes del reintento');

    await conServidor({}, async (base) => {
      const panel = await abrirWS(base, '/ws/panel', ADMIN);
      await asentar(400);
      const avisos = espiar(panel, d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);
      const rs = await Promise.all(Array.from({ length: 10 }, () => comprar(base, carrito(tk))));
      await asentar();
      panel.close();
      assert.ok(rs.every(r => r.status === 200), 'algún reintento no respondió 200');
      assert.strictEqual(avisos.length, 1, `el panel recibió ${avisos.length} avisos del mismo pedido`);
    });

    assert.strictEqual(await trabajosDeFolio(folio), 1,
      'no quedó exactamente 1 trabajo de comanda por destino');
    assert.strictEqual((await filasLegacyEmitidas(folio)).length, 0,
      'con Edge a cargo, el camino legacy no debería haberse tocado siquiera');
  });

  await t('K7. bajo la misma concurrencia: 1 pedido, 1 atribución y 1 registro en historial', async () => {
    const tk = token();
    await conServidor({}, async (base) => {
      await crearPromo(base, { nombre: 'Concurrente ledger', tipo: 'monto_fijo', valor: 15,
        codigo: 'LEDGERCONC', limiteUsos: 5 });
    });
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      await comprar(base, carrito(tk, { codigo: 'LEDGERCONC' }));
    });
    const folio = (await pedidosDelToken(tk))[0]?.folio;
    // Se mide el DELTA, no el total: la tabla `pedidos` es historia acumulada
    // y el contador de folios puede reciclar un numero cuyo pedido_activo ya
    // se archivo. Lo que se afirma aqui es la propiedad real -- el reintento
    // no vuelve a guardar -- no la unicidad global del folio.
    const historialAntes = await historialDeFolio(folio);
    assert.ok(historialAntes >= 1, 'el pedido no llego al historial en el primer intento');

    await conServidor({}, async (base) => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => comprar(base, carrito(tk, { codigo: 'LEDGERCONC' }))));
      assert.ok(rs.every(r => r.status === 200), 'algún reintento no respondió 200');
    });

    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');
    assert.strictEqual(await usosDeCodigo('LEDGERCONC'), 1, 'la promoción se atribuyó más de una vez');
    assert.strictEqual(await contadorUsos('LEDGERCONC'), 1, 'el contador de usos se movió de más');
    assert.strictEqual(await historialDeFolio(folio), historialAntes,
      'el reintento volvió a escribir el pedido en el historial');
    assert.strictEqual(await trabajosDeFolio(folio), 1, 'no quedó exactamente 1 comanda');
  });

  // ═══ L) Semántica del éxito: 200 significa "confirmado", no "confío" ═══
  //
  // Perder el lock de una derivación NO es haberla terminado. Si otro proceso
  // la está ejecutando, este no puede responder 200 apostando a que al otro le
  // salga bien: si el ganador se cae, el cliente se queda con "pedido recibido"
  // y la cocina sin papel.
  //
  // El retardo se INYECTA para que la carrera sea determinista y no dependa de
  // la suerte del planificador.

  await t('L1. el que PIERDE el lock no responde 200 si el ganador falla', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      await comprar(base, carrito(tk));
    });
    const folio = (await pedidosDelToken(tk))[0]?.folio;
    assert.ok(folio, 'no quedó el pedido pendiente de emitir');

    let a, b;
    await conServidor({
      XABOR_TIENDA_RETARDO_EN: 'dentro_de_emision', XABOR_TIENDA_RETARDO_MS: '2500',
      XABOR_TIENDA_FALLA_EN: 'emitido_sin_marcar', XABOR_TIENDA_SONDEOS_MARCA: '4',
    }, async (base) => {
      const pa = comprar(base, carrito(tk));                 // A: toma el lock
      await asentar(500);
      const pb = comprar(base, carrito(tk));                 // B: lo pierde
      [a, b] = await Promise.all([pa, pb]);
    });

    assert.ok(a.status >= 400, 'el ganador no falló pese al fallo inyectado');
    assert.notStrictEqual(b.status, 200,
      '¡EL PERDEDOR DEL LOCK RESPONDIÓ 200! el cliente creería que su pedido está listo');
    assert.strictEqual(b.status, 409, `esperaba 409, dio ${b.status}: ${JSON.stringify(b.body)}`);
    assert.strictEqual(b.body?.codigo, 'CHECKOUT_EN_CURSO', JSON.stringify(b.body));
    assert.ok(!('emision' in await derivacionesDe(tk)), 'la marca quedó escrita pese al fallo');

    // Y el siguiente reintento sí recupera: el lock ya está libre.
    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk)); });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok('emision' in await derivacionesDe(tk), 'el reintento no completó la emisión');
    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');
    assert.strictEqual(await trabajosDeFolio(folio), 1, 'no quedó exactamente 1 comanda');
  });

  await t('L2. el que pierde el lock SÍ responde 200 cuando el ganador termina', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      await comprar(base, carrito(tk));
    });
    const folio = (await pedidosDelToken(tk))[0]?.folio;

    let a, b, avisos;
    await conServidor({
      XABOR_TIENDA_RETARDO_EN: 'dentro_de_emision', XABOR_TIENDA_RETARDO_MS: '1200',
    }, async (base) => {
      const panel = await abrirWS(base, '/ws/panel', ADMIN);
      await asentar(400); // volcado inicial del tablero
      avisos = espiar(panel, d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);
      const pa = comprar(base, carrito(tk));
      await asentar(400);
      const pb = comprar(base, carrito(tk));
      [a, b] = await Promise.all([pa, pb]);
      await asentar();
      panel.close();
    });

    assert.strictEqual(a.status, 200, `ganador: ${JSON.stringify(a.body)}`);
    assert.strictEqual(b.status, 200,
      `el perdedor esperó la marca y debía responder 200: ${JSON.stringify(b.body)}`);
    assert.strictEqual(a.body.folio, b.body.folio, 'devolvieron folios distintos');
    assert.strictEqual(avisos.length, 1, `la emisión corrió ${avisos.length} veces`);
    assert.strictEqual(await trabajosDeFolio(folio), 1, 'no quedó exactamente 1 comanda');
    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');
  });

  await t('L3. muchos checkouts DISTINTOS a la vez, con el pool por debajo: nadie se cuelga', async () => {
    // El interbloqueo que se corrige: el claim retenía una conexión del MISMO
    // pool que necesita el efecto. Con N peticiones = tamaño del pool, las N
    // retienen todo y las N esperan una más. Aquí se reproduce a propósito con
    // un pool diminuto: 12 checkouts contra 4 conexiones de trabajo y 3 de
    // claim. Antes del arreglo esto no falla: se CUELGA, por eso hay un tope
    // de tiempo duro -- una prueba que se cuelga no reporta nada.
    const N = 12;
    const tokens = Array.from({ length: N }, () => token());
    let resultados;
    await conServidor({ XABOR_PG_POOL_MAX: '4', XABOR_PG_POOL_CLAIMS_MAX: '3' }, async (base) => {
      const lote = Promise.all(tokens.map((tk, i) => comprar(base, carrito(tk, {
        cliente: { nombre: `Concurrente ${i}`, telefono: `89987000${String(i).padStart(2, '0')}` },
      }))));
      const tope = new Promise((_, rechazar) => setTimeout(
        () => rechazar(new Error('SE COLGÓ: 45 s sin que terminaran los 12 checkouts')), 45000));
      resultados = await Promise.race([lote, tope]);
    });

    for (const [i, r] of resultados.entries()) {
      assert.ok(Number.isInteger(r.status),
        `el checkout ${i} no terminó con un estado definido`);
    }
    const ok = resultados.filter(r => r.status === 200);
    assert.strictEqual(ok.length, N,
      `solo ${ok.length}/${N} terminaron bien: ${JSON.stringify(resultados.filter(r => r.status !== 200).map(r => r.body))}`);

    const folios = new Set(ok.map(r => r.body.folio));
    assert.strictEqual(folios.size, N, 'hubo folios repetidos entre checkouts distintos');
    for (const f of folios) {
      assert.strictEqual(await trabajosDeFolio(f), 1, `el folio ${f} no tiene exactamente 1 comanda`);
    }
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  if (fallidas) {
    const lineas = ultimoLog.split(/\r?\n/).filter(l => l.includes('[Tienda]'));
    if (lineas.length) console.log('-- log del servidor --');
    lineas.slice(-6).forEach(l => console.log(l));
  }
  await limpiar().catch(() => {});
  // Se devuelve a Nonna Maye su modo legado: es el estado real del producto,
  // no un residuo de esta suite.
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor)
     VALUES ($1,'print_agent_legacy_activo','true')
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true'`,
    [SEED.nonnaMayeId]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-recuperacion-crash: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
