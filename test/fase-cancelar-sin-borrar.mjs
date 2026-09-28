// Cancelar sin borrar, y lo cancelado no regresa a cocina (auditoría del
// 28-sep-2026, Mapolato Obispado).
//
// Hallazgos: el 🚫 del panel marcaba el pedido y luego lo BORRABA (36 folios
// desaparecidos sin rastro desde el 27-ago); el 🗑️ con contraseña lo borraba
// sin motivo; un pedido cuyo enlace de pago vencía se cancelaba solo en la
// base, seguía en el tablero y un clic lo podía mandar a cocina. Desde la
// tarjeta simple (28-sep) 🚫 y 🗑️ son un solo «Cancelar pedido» en «⋯ Más»:
// el administrador cancela con su sesión y el resto del personal con la
// contraseña del administrador (DELETE /pedidos/:id).
//
// Servidor y Postgres reales; el tablero con Puppeteer; el vencimiento del
// enlace de pago en proceso (el mismo job que corre cada 5 minutos).
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-cancelar-sin-borrar.mjs
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_CANCELAR_SIN_BORRAR || '4979';
const CLAVE_ADMIN = 'clave-de-prueba-borrar';

const { pool, actualizarEstadoPedidoDB } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ── Negocio de prueba (se reconstruye en cada corrida) ──────────────────────
const SLUG = 'cancelar-sin-borrar';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [SLUG]);
  if (!rows.length) return;
  const id = rows[0].id;
  const q = (sql) => pool.query(sql, [id]).catch(() => {});
  await q(`DELETE FROM pagos WHERE negocio_id = $1`);
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = $1`);
  await q(`DELETE FROM compras_reales WHERE negocio_id = $1`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
  // El POS también deja el pedido histórico y el cliente técnico del mostrador.
  await q(`DELETE FROM pedidos WHERE negocio_id = $1`);
  await q(`DELETE FROM clientes WHERE negocio_id = $1`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = $1`);
  await q(`DELETE FROM menu_productos WHERE negocio_id = $1`);
  await q(`DELETE FROM menu_categorias WHERE negocio_id = $1`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = $1`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
  await q(`DELETE FROM configuracion WHERE negocio_id = $1`);
  await q(`DELETE FROM sucursales WHERE negocio_id = $1`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
  await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
  await q(`DELETE FROM negocios WHERE id = $1`);
}
await limpiar();

const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Cancelar Sin Borrar', $1) RETURNING id`, [SLUG]);
const N = neg.id;
for (const m of ['pos', 'caja', 'menu']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [N, m]);
}
await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)`, [N]);
await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [N]);
async function persona(nombre, rol) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [N, nombre, `${SLUG}-${rol}-${Math.random().toString(36).slice(2)}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, N, rol]);
  return u.id;
}
const ADMIN = await persona('Admin Borrar', 'admin');
const STAFF = await persona('Sara Staff', 'staff');
const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Comida',TRUE,0) RETURNING id`, [N]);
const { rows: [torta] } = await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
   VALUES ($1,$2,'TORTA','Torta','',80,TRUE,0) RETURNING id`, [N, cat.id]);

const srv = await arrancarServidor({ PORT: PUERTO, ADMIN_PASSWORD: CLAVE_ADMIN }, { timeoutMs: 30000 });
const galleta = (id, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: id, negocioId: N, rol }))}`;
const cookieAdmin = galleta(ADMIN, 'admin');
const cookieStaff = galleta(STAFF, 'staff');
async function api(path, { cookie = cookieAdmin, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(srv.base + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
let n = 0;
async function nuevoPedido(nombre = `Cliente ${++n}`) {
  const r = await api('/api/pos/pedidos', { method: 'POST', body: {
    tipo: 'recoger', cliente: { nombre, telefono: `87811${String(20000 + n).slice(-5)}` },
    items: [{ producto_id: torta.id, cantidad: 1 }], formaPago: 'efectivo' } });
  assert(r.status === 200, `crear pedido: ${JSON.stringify(r.body)}`);
  return r.body.pedido.id;
}
const fila = async (folio) => (await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, N])).rows[0];
const enTablero = async (folio) => ((await api('/pedidos')).body || []).some(p => p.id === folio);

try {
  // ═══════════ 🚫 Cancelar (administrador) ═══════════
  let cancelado = null;
  await t('CANCELAR', '1. «🚫 Cancelar» conserva el pedido: queda cancelado con motivo y quién, y sale del tablero', async () => {
    cancelado = await nuevoPedido('Rosa');
    assert(await enTablero(cancelado), 'el pedido nuevo debe estar en el tablero');
    const r = await api(`/api/admin/pedido/${cancelado}/cancelar`, { method: 'POST', body: { motivo: 'El cliente llamó para cancelar' } });
    assert(r.status === 200, JSON.stringify(r.body));
    const f = await fila(cancelado);
    assert(f, 'la fila se borró: cancelar no debe borrar');
    assert(f.estado === 'cancelado', `estado: ${f.estado}`);
    assert(f.datos.cancelacion?.motivo === 'El cliente llamó para cancelar', `motivo: ${JSON.stringify(f.datos.cancelacion)}`);
    assert(f.datos.cancelacion?.por === ADMIN, 'falta quién canceló');
    assert(!(await enTablero(cancelado)), 'sigue en el tablero');
  });
  await t('CANCELAR', '2. el historial lo muestra cancelado con motivo y quién; cancelarlo otra vez no hace nada', async () => {
    const h = await api('/api/historial?periodo=hoy');
    const p = (h.body || []).find(x => x.id === cancelado);
    assert(p && p._estado === 'cancelado' && p._cancelado_por_nombre === 'Admin Borrar', `historial: ${JSON.stringify(p && { e: p._estado, q: p._cancelado_por_nombre })}`);
    const otra = await api(`/api/admin/pedido/${cancelado}/cancelar`, { method: 'POST', body: { motivo: 'otra vez' } });
    assert(otra.status === 404, `segunda cancelación: ${otra.status}`);
    assert((await fila(cancelado)).datos.cancelacion.motivo === 'El cliente llamó para cancelar', 'el motivo original se conserva');
  });

  // ═══════════ Cancelar del personal (con la contraseña de administrador) ═══════════
  await t('QUITAR', '3. cancelar con contraseña, sin motivo o con la contraseña equivocada, no toca nada', async () => {
    const folio = await nuevoPedido('Omar');
    const sin = await api(`/pedidos/${folio}`, { method: 'DELETE', cookie: cookieStaff, headers: { 'X-Admin-Pin': CLAVE_ADMIN }, body: {} });
    assert(sin.status === 400 && sin.body?.codigo === 'MOTIVO_REQUERIDO', `sin motivo: ${sin.status} ${JSON.stringify(sin.body)}`);
    const mala = await api(`/pedidos/${folio}`, { method: 'DELETE', cookie: cookieStaff, headers: { 'X-Admin-Pin': 'otra' }, body: { motivo: 'x' } });
    assert(mala.status === 403, `contraseña equivocada: ${mala.status}`);
    assert((await fila(folio)).estado === 'nuevo' && await enTablero(folio), 'el pedido debía seguir igual');
  });
  await t('QUITAR', '4. con motivo y contraseña no borra: cancela con el motivo tal cual y quién, y lo retira del tablero', async () => {
    const folio = await nuevoPedido('Katia');
    const r = await api(`/pedidos/${folio}`, { method: 'DELETE', cookie: cookieStaff, headers: { 'X-Admin-Pin': CLAVE_ADMIN }, body: { motivo: 'Pedido de prueba' } });
    assert(r.status === 200, JSON.stringify(r.body));
    const f = await fila(folio);
    assert(f && f.estado === 'cancelado', `fila: ${JSON.stringify(f && f.estado)}`);
    assert(f.datos.cancelacion?.motivo === 'Pedido de prueba', `motivo: ${f.datos.cancelacion?.motivo}`);
    assert(f.datos.cancelacion?.por === STAFF, 'queda quién lo quitó');
    assert(!(await enTablero(folio)), 'sigue en el tablero');
  });

  // ═══════════ Lo cancelado no regresa a cocina ═══════════
  await t('REVIVIR', '5. un pedido cancelado en la base que sigue en el tablero no vuelve a cocina: 409 y sale del tablero', async () => {
    const folio = await nuevoPedido('Eva');
    // Así queda cuando vence su enlace de pago o lo cancela otra pantalla.
    await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);
    assert(await enTablero(folio), 'la memoria todavía lo tiene (el caso que se prueba)');
    const r = await api(`/pedidos/${folio}/estado`, { method: 'PATCH', body: { estado: 'en_preparacion' } });
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_CANCELADO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(folio)).estado === 'cancelado', 'revivió en la base');
    assert(!(await enTablero(folio)), 'debía salir del tablero');
  });
  await t('REVIVIR', '6. la base se defiende sola: actualizarEstadoPedidoDB no cambia un pedido cancelado', async () => {
    const folio = await nuevoPedido('Nico');
    await actualizarEstadoPedidoDB(folio, 'en_preparacion');
    assert((await fila(folio)).estado === 'en_preparacion', 'un pedido vivo sí cambia');
    await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);
    for (const estado of ['listo', 'nuevo', 'entregado']) {
      await actualizarEstadoPedidoDB(folio, estado);
      assert((await fila(folio)).estado === 'cancelado', `${estado} revivió un cancelado`);
    }
  });
  await t('ESTADO', '7. un pedido vivo cambia de estado como siempre', async () => {
    const folio = await nuevoPedido('Lupe');
    const r = await api(`/pedidos/${folio}/estado`, { method: 'PATCH', body: { estado: 'listo' } });
    assert(r.status === 200, JSON.stringify(r.body));
    assert((await fila(folio)).estado === 'listo', 'no cambió');
  });

  // ═══════════ Enlace de pago vencido (el job de cada 5 minutos, en proceso) ═══════════
  await t('VENCIDO', '8. al vencer el enlace de pago, el pedido sale del tablero y los paneles reciben el aviso', async () => {
    const om = await import('../src/orders/orderManager.js');
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    const eventos = [];
    om.setWsBroadcast((negocioId, msg) => eventos.push({ negocioId, ...msg }));
    const folio = `TST-VENC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const datos = { id: folio, negocioId: N, canal: 'tienda_online', modalidad: 'recoger en tienda', estado: 'pendiente_pago',
      cliente: { nombre: 'Pago Vencido', telefono: '8780000099' }, items: [{ nombre: 'Torta', cantidad: 1, precio_unitario: 80 }], total: 80 };
    await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'pendiente_pago',$2,$3)`, [folio, JSON.stringify(datos), N]);
    await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, monto, estado, xabor_espera_hasta)
       VALUES ($1,$2,'clip',$3,80,'pendiente', NOW() - interval '2 minutes')`, [N, folio, `ref-${folio}`]);
    om.agregarPedidoAMemoria({ ...datos });
    assert(om.obtenerPedidoPorId(folio, N), 'el pedido debía estar en la memoria');
    const vencidos = await expirarPagosVencidos(50);
    assert(vencidos >= 1, `vencidos: ${vencidos}`);
    const f = await fila(folio);
    assert(f.estado === 'cancelado' && f.datos.expirado_por_pago === true, `fila: ${f.estado}`);
    assert(!om.obtenerPedidoPorId(folio, N), 'siguió en el tablero');
    const aviso = eventos.find(e => e.tipo === 'cancelar_pedido' && e.id === folio);
    assert(aviso && aviso.negocioId === N && aviso.aviso === 'pago_no_recibido', `avisos: ${JSON.stringify(eventos)}`);
    om.setWsBroadcast(null);
  });

  // ═══════════ El tablero (Puppeteer) ═══════════
  const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ERRORES = [];
  try {
    const ctx = await navegador.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    await page.setCookie({ name: 'xabor_sesion', value: cookieAdmin.slice(cookieAdmin.indexOf('=') + 1), url: srv.base });
    const respuestas = [];
    page.on('dialog', d => d.accept(respuestas.shift() ?? '').catch(() => {}));
    page.on('pageerror', e => ERRORES.push(String(e.message || e)));
    await page.goto(srv.base + '/app', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof cambiarEstado === 'function' && typeof ws !== 'undefined' && ws && ws.readyState === 1, { timeout: 15000 });
    const tarjeta = (folio) => page.$(`#comanda-${folio}`);
    const esperarTarjeta = (folio) => page.waitForSelector(`#comanda-${folio}`, { timeout: 10000 });
    const esperarSinTarjeta = (folio) => page.waitForFunction((f) => !document.getElementById(`comanda-${f}`), { timeout: 10000 }, folio);
    const avisos = () => page.evaluate(() => [...document.querySelectorAll('#avisos-panel [role=alert]')].map(a => a.textContent));

    await t('TABLERO', '9. un pedido cancelado en otra pantalla desaparece al momento', async () => {
      const folio = await nuevoPedido('Pantalla Uno');
      await esperarTarjeta(folio);
      const r = await api(`/api/admin/pedido/${folio}/cancelar`, { method: 'POST', body: { motivo: 'desde otra pantalla' } });
      assert(r.status === 200, JSON.stringify(r.body));
      await esperarSinTarjeta(folio);
    });
    await t('TABLERO', '10. «Preparando» sobre un pedido que la base ya canceló: no lo pinta en preparación, lo retira y avisa', async () => {
      const folio = await nuevoPedido('Pantalla Dos');
      await esperarTarjeta(folio);
      await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);
      await page.evaluate((f) => document.querySelector(`#comanda-${f} .btn-preparando`).click(), folio);
      await esperarSinTarjeta(folio);
      await page.waitForFunction(() => [...document.querySelectorAll('#avisos-panel [role=alert]')]
        .some(a => /ya está cancelado/.test(a.textContent)), { timeout: 5000 });
      assert((await fila(folio)).estado === 'cancelado', 'revivió');
    });
    await t('TABLERO', '10b. «Entregado» sobre un pedido que la base ya canceló tampoco finge: avisa', async () => {
      const folio = await nuevoPedido('Pantalla Dos B');
      await esperarTarjeta(folio);
      await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);
      await page.evaluate(() => document.getElementById('avisos-panel')?.replaceChildren());
      await page.evaluate((f) => marcarEntregado(f), folio);
      await page.waitForFunction(() => [...document.querySelectorAll('#avisos-panel [role=alert]')]
        .some(a => /ya está cancelado/.test(a.textContent)), { timeout: 5000 });
      await esperarSinTarjeta(folio);
      assert((await fila(folio)).estado === 'cancelado', 'se dio por entregado');
    });
    // Un solo «Cancelar pedido», dentro de «⋯ Más» (la tarjeta simple).
    const cancelarDesdeMas = async (folio, motivo) => {
      // /app abre Inicio: el tablero tiene que estar a la vista para tocarlo.
      await page.evaluate((f) => { mostrarTab('comandas'); if (!comandasAbiertas.has(f)) toggleComanda(f); alternarMenuComanda(f); }, folio);
      await page.click(`#menu-${folio} .menu-peligro`);
      await page.waitForFunction(() => document.getElementById('modal-cancelar-overlay').style.display === 'flex', { timeout: 5000 });
      await page.$eval('#cancelar-motivo', (el, m) => { el.value = m; }, motivo);
      await page.click('#btn-confirmar-cancelar');
    };
    await t('TABLERO', '11. «Cancelar pedido» pide el motivo; el pedido queda cancelado con él, no borrado', async () => {
      const folio = await nuevoPedido('Pantalla Tres');
      await esperarTarjeta(folio);
      await cancelarDesdeMas(folio, 'Se capturó dos veces');
      await esperarSinTarjeta(folio);
      const f = await fila(folio);
      assert(f && f.estado === 'cancelado' && f.datos.cancelacion?.motivo === 'Se capturó dos veces' && f.datos.cancelacion?.por === ADMIN,
        `fila: ${JSON.stringify(f && { e: f.estado, c: f.datos.cancelacion })}`);
    });
    await t('TABLERO', '12. «Cancelar pedido» sin motivo no manda nada', async () => {
      const folio = await nuevoPedido('Pantalla Cuatro');
      await esperarTarjeta(folio);
      const enviados = [];
      const mirar = (req) => { if (req.url().includes(`/pedidos/${folio}`) && req.method() !== 'GET') enviados.push(`${req.method()} ${req.url()}`); };
      page.on('request', mirar);
      await cancelarDesdeMas(folio, '   ');
      await esperar(600);
      page.off('request', mirar);
      assert(enviados.length === 0, `sin motivo no debe salir la petición: ${enviados}`);
      assert(/motivo/.test(await page.$eval('#cancelar-fb', el => el.textContent)), 'no dijo que falta el motivo');
      await page.evaluate(() => cerrarModalCancelar());
      assert(await tarjeta(folio), 'la tarjeta desapareció');
      assert((await fila(folio)).estado === 'nuevo', 'cambió sin motivo');
    });
    await t('TABLERO', '13. el aviso de enlace vencido se ve en el panel y quita la tarjeta', async () => {
      const folio = await nuevoPedido('Pantalla Cinco');
      await esperarTarjeta(folio);
      await page.evaluate((f) => ws.onmessage({ data: JSON.stringify({ tipo: 'cancelar_pedido', id: f, motivo: 'no se recibió el pago a tiempo', aviso: 'pago_no_recibido' }) }), folio);
      await esperarSinTarjeta(folio);
      const a = await avisos();
      assert(a.some(x => /se canceló solo: no se recibió el pago a tiempo/.test(x)), `avisos: ${a}`);
    });
    await t('TABLERO', '14. ninguna pantalla lanzó errores de JavaScript', async () => {
      assert(ERRORES.length === 0, ERRORES.join(' | '));
    });
  } finally {
    await navegador.close().catch(() => {});
  }
} finally {
  srv.detener();
  await limpiar().catch(() => {});
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
