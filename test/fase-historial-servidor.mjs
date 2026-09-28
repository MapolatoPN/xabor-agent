// Historial por días del negocio, Envíos activos solo con lo vivo y mesas sin
// consumo fuera de las cuentas de ventas — lado servidor, con Postgres real.
//
// Auditoría del 28-sep-2026 (Mapolato Obispado). Ver también la suite de
// panel fase-historial-modalidad.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-historial-servidor.mjs
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_HISTSRV || '4972';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { calcularCorteVivo } = await import('../src/services/cortesCaja.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const SLUG = 'historial-srv-prueba';
const PREF = 'HST-';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [SLUG]);
  if (!rows.length) return;
  const id = rows[0].id;
  const q = (sql) => pool.query(sql, [id]).catch(() => {});
  await q(`DELETE FROM restaurante_cuenta_items WHERE negocio_id = $1`);
  await q(`DELETE FROM restaurante_cuentas WHERE negocio_id = $1`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = $1`);
  await q(`DELETE FROM compras_reales WHERE negocio_id = $1`);
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = $1`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
  await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
  await q(`DELETE FROM negocios WHERE id = $1`);
}
await limpiar();

const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Historial Prueba', $1) RETURNING id`, [SLUG]);
const N = neg.id;
for (const m of ['pos', 'caja', 'restaurante']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [N, m]);
}
const { rows: [adm] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Mario Admin',$2,'x') RETURNING id`,
  [N, `hist-srv-${Date.now()}@test.local`]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [adm.id, N]);

// Días del negocio (zona por omisión: America/Matamoros), calculados en SQL.
const dia = (desfase) => `((date_trunc('day', now() AT TIME ZONE 'America/Matamoros') + interval '12 hours' + interval '${desfase} days') AT TIME ZONE 'America/Matamoros') AT TIME ZONE 'UTC'`;
// `datos.timestamp` sale de la misma hora que created_at: es lo que la memoria
// del servidor usa para decidir si un envío es de hoy.
async function pedido(folio, estado, datos, desfase = 0, minutos = 0) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at)
     VALUES ($1, $2, $3, $4, ${dia(desfase)} - make_interval(mins => $5))`,
    [folio, estado, JSON.stringify({ id: folio, negocioId: N, ...datos }), N, minutos]);
  await pool.query(
    `UPDATE pedidos_activos SET datos = datos || jsonb_build_object('timestamp', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      WHERE folio = $1`, [folio]);
}
// Hoy
await pedido(`${PREF}0001`, 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', total: 120, forma_pago: 'efectivo', items: [{ nombre: 'Licuado', cantidad: 2, precio_unitario: 60 }] }, 0, 30);
await pedido(`${PREF}0002`, 'cancelado', { canal: 'tienda_online', modalidad: 'entrega a domicilio', total: 294, forma_pago: 'enlace_pago', expirado_por_pago: true, motivo_cancelacion: 'no se recibio el pago dentro de la ventana', items: [] }, 0, 20);
await pedido(`${PREF}0003`, 'cancelado', { canal: 'whatsapp', modalidad: 'recoger en tienda', total: 90, cancelacion: { motivo: 'Duplicado', por: adm.id, at: new Date().toISOString() }, items: [] }, 0, 10);
await pedido(`${PREF}0004`, 'nuevo', { canal: 'pos', modalidad: 'entrega a domicilio', total: 150, forma_pago: 'efectivo', cliente: { nombre: 'Hoy Vivo' }, items: [] }, 0, 5);
// Mesa sin consumo (se cancelaron 2 productos) y cortesía, hoy.
const { rows: [ctaVacia] } = await pool.query(
  `INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, personas, mesero_usuario_id, estado, abierta_por, venta_folio)
   VALUES ($1, 7, 2, $2, 'cerrada', $2, 'RM-HST00001-0') RETURNING id`, [N, adm.id]);
for (const [prod, precio] of [['Sopa', 45], ['Agua', 35]]) {
  await pool.query(`INSERT INTO restaurante_cuenta_items (cuenta_id, negocio_id, producto, cantidad, precio_unitario, estado, agregado_por, comanda_num)
    VALUES ($1,$2,$3,1,$4,'cancelado',$5,1)`, [ctaVacia.id, N, prod, precio, adm.id]);
}
await pedido('RM-HST00001-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 7, total: 0, subtotal: 0, forma_pago: 'sin pago', items: [], cuenta_id: ctaVacia.id }, 0, 40);
await pedido('RM-HST00002-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 2, total: 0, subtotal: 209, descuento: 209, motivo_descuento: 'Cumpleaños', forma_pago: 'sin pago', items: [{ nombre: 'Pastel', cantidad: 1, precio_unitario: 209 }] }, 0, 50);
await pedido('RM-HST00003-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 5, total: 300, subtotal: 300, forma_pago: 'efectivo', items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 300 }] }, 0, 60);
// Ayer y hace 10 días
await pedido(`${PREF}0010`, 'entregado', { canal: 'pos', modalidad: 'entrega a domicilio', total: 200, forma_pago: 'efectivo', items: [] }, -1, 0);
await pedido(`${PREF}0011`, 'nuevo', { canal: 'tienda_online', modalidad: 'entrega a domicilio', total: 450, forma_pago: 'enlace_pago', pago_confirmado: true, cliente: { nombre: 'Viejo Pagado' }, items: [] }, -10, 0);
await pedido(`${PREF}0012`, 'cancelado', { canal: 'tienda_online', modalidad: 'entrega a domicilio', total: 255, forma_pago: 'enlace_pago', expirado_por_pago: true, items: [] }, -10, 10);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: adm.id, negocioId: N, rol: 'admin' }))}`;
async function api(path) {
  const r = await fetch(srv.base + path, { headers: { Cookie: cookie } });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const folios = (lista) => lista.map(p => p.id);
const hoyLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());

await t('HISTORIAL', '1. ?periodo=hoy trae solo lo cerrado de hoy, por hora de venta (más reciente primero)', async () => {
  const r = await api('/api/historial?periodo=hoy');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(folios(r.body), [`${PREF}0003`, `${PREF}0002`, `${PREF}0001`, 'RM-HST00001-0', 'RM-HST00002-0', 'RM-HST00003-0']);
});
await t('HISTORIAL', '2. _creado_at es la hora real de la venta, con zona', async () => {
  const r = await api('/api/historial?periodo=hoy');
  const p = r.body.find(x => x.id === `${PREF}0001`);
  const { rows: [f] } = await pool.query(`SELECT (created_at AT TIME ZONE 'UTC') AS t FROM pedidos_activos WHERE folio = $1`, [`${PREF}0001`]);
  assert.strictEqual(new Date(p._creado_at).getTime(), new Date(f.t).getTime());
  assert.ok(/Z$|[+-]\d\d:\d\d$/.test(p._creado_at), `sin zona: ${p._creado_at}`);
});
await t('HISTORIAL', '3. ?periodo=ayer y un rango explícito', async () => {
  const ayer = await api('/api/historial?periodo=ayer');
  assert.deepStrictEqual(folios(ayer.body), [`${PREF}0010`]);
  const d = new Date(Date.parse(`${hoyLocal}T00:00:00Z`) - 10 * 86400000).toISOString().slice(0, 10);
  const r = await api(`/api/historial?desde=${d}&hasta=${d}`);
  assert.deepStrictEqual(folios(r.body), [`${PREF}0012`], 'solo lo CERRADO de ese día (el nuevo no)');
});
await t('HISTORIAL', '4. fechas y periodos inválidos responden 400, no una lista vacía', async () => {
  for (const q of ['periodo=mañana', 'desde=2026-13-01&hasta=2026-13-02', 'desde=2026-09-20&hasta=2026-09-10', 'desde=2026-01-01&hasta=2026-09-01', 'desde=2026-09-01']) {
    const r = await api('/api/historial?' + q);
    assert.strictEqual(r.status, 400, `${q} dio ${r.status}`);
  }
});
await t('HISTORIAL', '5. la mesa trae sus renglones (para «sin consumo») y el cancelado trae quién canceló', async () => {
  const r = await api('/api/historial?periodo=hoy');
  const vacia = r.body.find(x => x.id === 'RM-HST00001-0');
  assert.deepStrictEqual(vacia._cuenta, { n: 2, cancelados: 2, monto_cancelado: 80 });
  const c = r.body.find(x => x.id === `${PREF}0003`);
  assert.strictEqual(c._cancelado_por_nombre, 'Mario Admin');
  assert.strictEqual(r.body.find(x => x.id === `${PREF}0001`)._cuenta, undefined, 'un pedido que no es de mesa no lleva _cuenta');
});
await t('HISTORIAL', '6. sin parámetros sigue respondiendo (últimos 100), solo entregados y cancelados', async () => {
  const r = await api('/api/historial');
  assert.strictEqual(r.status, 200);
  const f = folios(r.body);
  assert.ok(f.includes(`${PREF}0012`) && f.includes(`${PREF}0010`) && !f.includes(`${PREF}0004`) && !f.includes(`${PREF}0011`));
});

await t('ENVIOS', '7. Envíos activos no trae cancelados ni entregados, y separa lo de hoy de lo viejo', async () => {
  const r = await api('/api/pos/envios');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const mios = r.body.envios.filter(e => String(e.folio).startsWith(PREF));
  const por = Object.fromEntries(mios.map(e => [e.folio, e]));
  assert.deepStrictEqual(Object.keys(por).sort(), [`${PREF}0004`, `${PREF}0011`], `llegaron: ${Object.keys(por)}`);
  assert.strictEqual(por[`${PREF}0004`].deHoy, true);
  assert.strictEqual(por[`${PREF}0011`].deHoy, false);
});

await t('VENTAS', '8. la mesa sin consumo no es venta ni pedido; la cortesía sí cuenta; hay conteo de restaurante', async () => {
  const desde = new Date(Date.now() - 2 * 86400000).toISOString();
  const hasta = new Date(Date.now() + 2 * 86400000).toISOString();
  const lista = (await api(`/api/ventas?desde=${desde}&hasta=${hasta}`)).body;
  const f = lista.map(v => v.folio);
  assert.ok(!f.includes('RM-HST00001-0'), 'la mesa sin consumo no está en ventas');
  assert.ok(f.includes('RM-HST00002-0') && f.includes('RM-HST00003-0'), 'la cortesía y la venta de mesa sí');
  const res = (await api(`/api/ventas/resumen?desde=${desde}&hasta=${hasta}`)).body;
  assert.strictEqual(res.restaurante, 2, `restaurante: ${res.restaurante}`);
  assert.strictEqual(res.num_pedidos, f.length, 'el conteo coincide con la lista');
});

await t('CAJA', '9. en Caja la mesa sin consumo se lista con su etiqueta pero no cuenta como pedido cobrado', async () => {
  const corte = await calcularCorteVivo(N, hoyLocal);
  const fila = corte.pedidos.find(p => p.folio === 'RM-HST00001-0');
  assert.ok(fila, 'la mesa sin consumo sigue en la lista del día');
  assert.strictEqual(fila.estado_cuenta, 'cancelada');
  const cobradas = corte.pedidos.filter(p => p.estado_cuenta !== 'cancelada').length;
  assert.strictEqual(corte.pedidos_count, cobradas, `pedidos_count ${corte.pedidos_count} vs ${cobradas}`);
});

srv.detener();
await limpiar().catch(() => {});
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
