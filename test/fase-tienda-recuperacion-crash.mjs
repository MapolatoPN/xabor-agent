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
    return await fn(`http://localhost:${puerto}`, srv);
  } finally { await srv.detener(); }
}

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
  assert.strictEqual(r.status, 200, 'no se creó la promoción');
}

async function limpiar() {
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
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

    // Se fuerza la expiración de la reserva y se corre la reconciliación.
    await pool.query(
      `UPDATE tienda_promocion_usos SET created_at = NOW() - INTERVAL '1 hour'
        WHERE negocio_id = $1 AND pedido_folio LIKE 'reserva:%'`, [NEG]);
    const { reconciliarReservasVencidas } = await import('../src/services/tiendaPromociones.js');
    const resumen = await reconciliarReservasVencidas(NEG);

    assert.strictEqual(resumen.liberadas, 0,
      'liberó un cupo cuyo checkout SÍ produjo pedido: quedaría pedido con descuento y cupón intacto');
    assert.strictEqual(await usosDeCodigo('RECONCILIA'), 1, 'el uso no quedó atribuido al pedido real');
    assert.strictEqual(await contadorUsos('RECONCILIA'), 1, 'el contador se descuadró');

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

  // ─── C) Crash antes de emitir la comanda ───
  await t('C. crash antes de emitir → retry deja 1 pedido y 1 juego de comandas', async () => {
    const tk = token();
    await conServidor({ XABOR_TIENDA_FALLA_EN: 'antes_de_emitir' }, async (base) => {
      const r = await comprar(base, carrito(tk));
      assert.ok(r.status >= 400, 'no falló pese a la inyección');
    });
    const [pedido] = await pedidosDelToken(tk);
    assert.ok(pedido, 'el pedido debería existir');
    const trabajosAntes = await trabajosDeFolio(pedido.folio);

    let r;
    await conServidor({}, async (base) => { r = await comprar(base, carrito(tk)); });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.folio, pedido.folio);
    assert.strictEqual((await pedidosDelToken(tk)).length, 1, 'se duplicó el pedido');

    // Sin impresoras configuradas no hay trabajos, y eso está bien: lo que se
    // exige es que reemitir NO multiplique lo que haya.
    const trabajosDespues = await trabajosDeFolio(pedido.folio);
    assert.ok(trabajosDespues <= Math.max(trabajosAntes, 1),
      `los trabajos de impresión se multiplicaron: ${trabajosAntes} → ${trabajosDespues}`);
  });

  await t('C2. reemitir el mismo pedido N veces no crea comandas nuevas', async () => {
    const tk = token();
    let folio;
    await conServidor({}, async (base) => {
      const r = await comprar(base, carrito(tk));
      folio = r.body.folio;
      // Cinco reintentos idénticos.
      for (let i = 0; i < 5; i++) {
        const rr = await comprar(base, carrito(tk));
        assert.strictEqual(rr.body.folio, folio, 'un reintento devolvió otro folio');
      }
    });
    assert.strictEqual((await pedidosDelToken(tk)).length, 1);
    const trabajos = await trabajosDeFolio(folio);
    assert.ok(trabajos <= 1, `seis intentos dejaron ${trabajos} trabajos de impresión`);
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

    const trabajos = await trabajosDeFolio(finales[0].folio);
    assert.ok(trabajos <= 1, `quedaron ${trabajos} juegos de comanda`);
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

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-recuperacion-crash: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
