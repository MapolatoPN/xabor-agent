// ─── Restaurante: el flujo de cobro completo ────────────────────────────────
//
// Ticket PAGADO al cerrar (Edge si hay Caja/Ticket, navegador si no, nunca
// los dos; reimpresión sin volver a cerrar ni cobrar), efectivo recibido y
// cambio (solo el abono es venta), y descuento de cuenta con motivo y
// auditoría (misma autorización que el POS; nunca por debajo de lo ya
// cobrado). Servicio directo, rutas HTTP reales, trabajos de Edge y la
// pantalla en Chrome.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_COBRO || '4961';

const { pool } = await import('../src/services/database.js');
const {
  abrirMesa, agregarItems, enviarComanda, registrarPago, cerrarCuenta, obtenerCuenta,
  aplicarDescuentoCuenta, quitarDescuentoCuenta, construirTicketCuenta,
} = await import('../src/services/restauranteService.js');
const { obtenerResumenVentas } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearEdge } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta, actualizarImpresora } = await import('../src/services/impresionService.js');
const { renderCuenta } = await import('../edge/renderers/index.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const A = SEED.negocioA;
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const STAFF_A = SEED.staffNegocioAUsuarioId;

// ── Setup: módulos, métodos de pago, mesas libres e impresión limpia ──
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(A, 'restaurante', 'activo');
await fijarModulo(A, 'pos', 'activo');
for (const [tipo, habilitado] of [['efectivo', true], ['terminal', true], ['transferencia', false]]) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`, [A, tipo, habilitado]);
}
// Mesas 30-45 son de esta suite: cualquier cuenta abierta que quedara ahí se cancela.
await pool.query(`UPDATE restaurante_cuentas SET estado = 'cancelada' WHERE negocio_id = $1 AND estado = 'abierta' AND mesa_numero BETWEEN 30 AND 45`, [A]);
await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [A]);
await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [A]);
await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [A]);
await pool.query(`DELETE FROM edge_instalaciones WHERE terminal_id IN (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = $1)`, [A]).catch(() => {});
await pool.query(`DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`, [A]);
await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal') ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [A]);
const EDGE = await crearEdge(A, { nombre: 'PC Caja Cobro' });
const IMP_COCINA = await crearImpresora(A, { terminalId: EDGE.id, nombre: 'COCINA', transporte: 'mock' });
const IMP_CAJA = await crearImpresora(A, { terminalId: EDGE.id, nombre: 'CAJA', transporte: 'mock' });
await crearRuta(A, { impresoraId: IMP_COCINA.id, ambito: 'documento', clave: 'comanda' });
// La ruta Caja/Ticket se crea más adelante: primero se prueba el navegador.

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const base = srv.base;
const cookie = (usuarioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: A, rol }))}`;
const cookieAdmin = cookie(ADMIN_A, 'admin');
const cookieStaff = cookie(STAFF_A, 'staff');

async function api(path, { cookie: ck = cookieAdmin, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}
let mesaLibre = 30;
async function nuevaCuenta(items) {
  const cta = await abrirMesa(A, { mesaNumero: mesaLibre++, personas: 2, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(cta.id, A, items, STAFF_A);
  await enviarComanda(cta.id, A, STAFF_A);
  return cta.id;
}
const TACOS = (n = 2) => ({ producto: 'Tacos', cantidad: n, precio_unitario: 25 });
const REFRESCO = () => ({ producto: 'Refresco', cantidad: 1, precio_unitario: 20, modificadores: ['Sin hielo'] });
async function trabajos(origenTipo, origenId) {
  const { rows } = await pool.query(
    `SELECT impresora_nombre, documento, estado, payload FROM impresion_trabajos
      WHERE negocio_id = $1 AND origen_tipo = $2 AND origen_id = $3 ORDER BY impresora_nombre`, [A, origenTipo, origenId]);
  return rows;
}
async function ventaDe(folio) {
  const { rows } = await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE negocio_id = $1 AND folio = $2`, [A, folio]);
  return rows[0] || null;
}
const hoy = () => { const d = new Date(); return [new Date(d.getTime() - 86400000).toISOString(), new Date(d.getTime() + 86400000).toISOString()]; };

try {
  // ═══════════ Migración ═══════════
  await t('MIGRACION', '082: descuento y reimpresiones en la cuenta, efectivo recibido y cambio en el pago', async () => {
    const { rows } = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name, column_name) IN (('restaurante_cuentas','descuento_monto'),('restaurante_cuentas','descuento_motivo'),
        ('restaurante_cuentas','descuento_por'),('restaurante_cuentas','ticket_impresiones'),('restaurante_cuenta_pagos','recibido'),('restaurante_cuenta_pagos','cambio'))`);
    assert.strictEqual(rows.length, 6, `faltan columnas: ${JSON.stringify(rows)}`);
  });

  // ═══════════ 1. Ticket de cuenta pagada ═══════════
  let cuenta1 = null, folio1 = null;
  await t('TICKET', 'sin impresora de Caja: al cerrar, el ticket PAGADO vuelve para el navegador y no hay trabajo Edge', async () => {
    cuenta1 = await nuevaCuenta([TACOS(2), REFRESCO()]);            // 70
    const p = await registrarPago(cuenta1, A, { metodo: 'efectivo', monto: 70, recibido: 100 }, ADMIN_A);
    assert.strictEqual(p.cambio, 30);
    const r = await api(`/api/restaurante/cuentas/${cuenta1}/cerrar`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    folio1 = r.body.ventaFolio;
    assert.strictEqual(r.body.impresion.destino, 'navegador', JSON.stringify(r.body.impresion));
    const tk = r.body.impresion.ticket;
    assert.strictEqual(tk.ticketPagado, true);
    assert.strictEqual(tk.leyenda, 'PAGADO');
    assert.strictEqual(tk.folio, folio1);
    assert.strictEqual(tk.items.length, 2);
    assert.strictEqual(tk.items[1].modificadores[0], 'Sin hielo');
    assert.strictEqual(tk.subtotal, 70);
    assert.strictEqual(tk.descuento, 0);
    assert.strictEqual(tk.total, 70);
    assert.deepStrictEqual(tk.pagos, [{ metodo: 'efectivo', monto: 70, propina: 0, recibido: 100, cambio: 30 }]);
    assert.strictEqual(tk.efectivoRecibido, 100);
    assert.strictEqual(tk.cambio, 30);
    assert.strictEqual(tk.reimpresion, false);
    assert.strictEqual((await trabajos('restaurante_cuenta', folio1)).length, 0, 'sin ruta de Caja no se crea trabajo Edge');
    const venta = await ventaDe(folio1);
    assert.strictEqual(Number(venta.datos.total), 70, 'la venta es el abono, nunca el efectivo recibido');
    assert.strictEqual(venta.datos.pagos[0].recibido, 100);
    assert.strictEqual(venta.datos.cambio, 30);
  });

  await t('TICKET', 'reintentar el cierre no reimprime ni duplica; reimprimir numera cada ticket y no toca la venta', async () => {
    const otra = await api(`/api/restaurante/cuentas/${cuenta1}/cerrar`, { method: 'POST' });
    assert.strictEqual(otra.body.yaCerrada, true);
    assert.strictEqual(otra.body.impresion, null, 'el reintento no imprime solo');
    const antes = await ventaDe(folio1);
    const r1 = await api(`/api/restaurante/cuentas/${cuenta1}/ticket`, { method: 'POST' });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert.strictEqual(r1.body.numero, 1);
    assert.strictEqual(r1.body.ventaFolio, folio1);
    assert.strictEqual(r1.body.impresion.destino, 'navegador');
    assert.strictEqual(r1.body.impresion.ticket.reimpresion, true);
    assert.strictEqual(r1.body.impresion.ticket.reimpresionNumero, 1);
    const r2 = await api(`/api/restaurante/cuentas/${cuenta1}/ticket`, { method: 'POST' });
    assert.strictEqual(r2.body.numero, 2);
    const c = await obtenerCuenta(cuenta1, A);
    assert.strictEqual(c.estado, 'cerrada');
    assert.strictEqual(c.ticketImpresiones, 2);
    assert.strictEqual(c.pagos.length, 1, 'reimprimir no registra pagos');
    assert.deepStrictEqual((await ventaDe(folio1)).datos, antes.datos, 'la venta no cambia con las reimpresiones');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'cuenta_id' = $2`, [A, cuenta1]);
    assert.strictEqual(rows[0].n, 1, 'una sola venta por cuenta');
    const abierta = await nuevaCuenta([TACOS(1)]);
    const na = await api(`/api/restaurante/cuentas/${abierta}/ticket`, { method: 'POST' });
    assert.strictEqual(na.status, 409, 'una cuenta abierta no tiene ticket pagado');
    assert.strictEqual(na.body.code, 'TICKET_NO_DISPONIBLE');
    // El mesero (sesión de estación) no reimprime tickets ni descuenta: las
    // rutas nuevas cuelgan del MISMO guardia que pagos y cierre
    // (requireAuthSeguro rechaza la sesión de estación; probado en
    // fase-restaurante-operacion-v2). Se fija por contrato en el código.
    const fuente = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
    for (const ruta of ['/api/restaurante/cuentas/:cuentaId/ticket', '/api/restaurante/cuentas/:cuentaId/descuento']) {
      const linea = fuente.split('\n').find(l => l.includes(`'${ruta}'`) && l.includes('app.post('));
      assert.ok(linea && linea.includes('requireAuthSeguro'), `${ruta} debe usar requireAuthSeguro (caja/admin, nunca mesero)`);
    }
  });

  let folio2 = null;
  await t('TICKET', 'con impresora de Caja/Ticket: el ticket sale por Edge, jamás por cocina, y el navegador no imprime', async () => {
    await crearRuta(A, { impresoraId: IMP_CAJA.id, ambito: 'documento', clave: 'cuenta' });
    const cuenta = await nuevaCuenta([TACOS(2)]);                    // 50
    await registrarPago(cuenta, A, { metodo: 'terminal', monto: 50, propina: 5 }, ADMIN_A);
    const r = await api(`/api/restaurante/cuentas/${cuenta}/cerrar`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    folio2 = r.body.ventaFolio;
    assert.strictEqual(r.body.impresion.destino, 'edge');
    assert.strictEqual(r.body.impresion.creados, 1);
    assert.strictEqual(r.body.impresion.ticket, undefined, 'con Edge el navegador no recibe nada que imprimir');
    const tj = await trabajos('restaurante_cuenta', folio2);
    assert.strictEqual(tj.length, 1);
    assert.strictEqual(tj[0].impresora_nombre, 'CAJA');
    assert.strictEqual(tj[0].documento, 'cuenta');
    assert.strictEqual(tj[0].payload.ticketPagado, true);
    assert.strictEqual(tj[0].payload.folio, folio2);
    assert.strictEqual(tj[0].payload.propina, 5);
    const { rows: cocina } = await pool.query(
      `SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND impresora_id = $2 AND origen_id LIKE $3`, [A, IMP_COCINA.id, folio2 + '%']);
    assert.strictEqual(cocina[0].n, 0, '¡el ticket llegó a la impresora de cocina!');
    const papel = renderCuenta(tj[0].payload).toString('latin1');
    assert.ok(papel.includes('PAGADO'), 'el papel de Edge dice PAGADO');
    assert.ok(papel.includes(`Folio: ${folio2}`));
    assert.ok(papel.includes('terminal') && papel.includes('$50.00'));
    assert.ok(!papel.includes('PRECUENTA'));
    const re = await api(`/api/restaurante/cuentas/${cuenta}/ticket`, { method: 'POST' });
    assert.strictEqual(re.body.impresion.destino, 'edge');
    const rj = await trabajos('restaurante_cuenta_reimpresion', `${folio2}#1`);
    assert.strictEqual(rj.length, 1);
    assert.strictEqual(rj[0].payload.reimpresion, true);
    assert.ok(renderCuenta(rj[0].payload).toString('latin1').includes('REIMPRESION'));
  });

  await t('TICKET', 'si la impresora de Caja está apagada el cobro no se deshace: la venta existe y el ticket cae al navegador', async () => {
    await actualizarImpresora(A, IMP_CAJA.id, { activa: false });
    try {
      const cuenta = await nuevaCuenta([TACOS(1)]);
      await registrarPago(cuenta, A, { metodo: 'efectivo', monto: 25, recibido: 25 }, ADMIN_A);
      const r = await api(`/api/restaurante/cuentas/${cuenta}/cerrar`, { method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(await ventaDe(r.body.ventaFolio), 'la venta quedó registrada');
      assert.strictEqual(r.body.impresion.destino, 'navegador');
      assert.strictEqual(r.body.impresion.ticket.cambio, null, 'sin cambio no se imprime cambio');
    } finally {
      await actualizarImpresora(A, IMP_CAJA.id, { activa: true });
    }
  });

  // ═══════════ 2. Efectivo recibido y cambio ═══════════
  await t('CAMBIO', 'saldo $180 y recibe $200: abono $180, cambio $20; la venta es $180', async () => {
    const cuenta = await nuevaCuenta([{ producto: 'Pizza', cantidad: 2, precio_unitario: 90 }]);
    const r = await api(`/api/restaurante/cuentas/${cuenta}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 180, recibido: 200 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.pago.monto), 180);
    assert.strictEqual(r.body.cambio, 20);
    assert.strictEqual(r.body.saldoRestante, 0);
    const c = await obtenerCuenta(cuenta, A);
    assert.strictEqual(Number(c.pagos[0].recibido), 200);
    assert.strictEqual(Number(c.pagos[0].cambio), 20);
    assert.strictEqual(c.saldo, 0);
    const cierre = await cerrarCuenta(cuenta, A, ADMIN_A);
    assert.strictEqual(cierre.total, 180);
    assert.strictEqual(cierre.cambio, 20);
    assert.strictEqual(Number((await ventaDe(cierre.ventaFolio)).datos.total), 180);
  });

  await t('CAMBIO', 'recibir menos que el abono se rechaza en servidor (400) y no registra nada; el sobrepago sigue bloqueado (409)', async () => {
    const cuenta = await nuevaCuenta([{ producto: 'Pizza', cantidad: 2, precio_unitario: 90 }]);
    const r = await api(`/api/restaurante/cuentas/${cuenta}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 180, recibido: 150 } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'EFECTIVO_INSUFICIENTE');
    assert.strictEqual((await obtenerCuenta(cuenta, A)).pagos.length, 0);
    const sobre = await api(`/api/restaurante/cuentas/${cuenta}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 190, recibido: 200 } });
    assert.strictEqual(sobre.status, 409, 'un abono mayor al saldo sigue prohibido');
    assert.strictEqual(sobre.body.code, 'PAGO_EXCEDE_SALDO');
    const tarjeta = await api(`/api/restaurante/cuentas/${cuenta}/pagos`, { method: 'POST', body: { metodo: 'terminal', monto: 180, recibido: 200 } });
    assert.strictEqual(tarjeta.status, 400, 'el efectivo recibido solo aplica a efectivo');
    assert.strictEqual((await obtenerCuenta(cuenta, A)).pagos.length, 0);
  });

  await t('CAMBIO', 'propina en efectivo: sale del billete, no de la venta; pagos parciales llevan cada uno su cambio', async () => {
    const cuenta = await nuevaCuenta([{ producto: 'Pizza', cantidad: 2, precio_unitario: 90 }]);
    // Persona 1: abona 100, deja 10 de propina, entrega 150 -> cambio 40.
    const p1 = await registrarPago(cuenta, A, { metodo: 'efectivo', monto: 100, propina: 10, recibido: 150 }, ADMIN_A);
    assert.strictEqual(p1.cambio, 40);
    assert.strictEqual(p1.saldoRestante, 80);
    // Un billete que cubre el abono pero no la propina se rechaza.
    await assert.rejects(() => registrarPago(cuenta, A, { metodo: 'efectivo', monto: 80, propina: 10, recibido: 85 }, ADMIN_A),
      e => e.code === 'EFECTIVO_INSUFICIENTE');
    // Persona 2: el resto con terminal.
    const p2 = await registrarPago(cuenta, A, { metodo: 'terminal', monto: 80 }, ADMIN_A);
    assert.strictEqual(p2.cambio, null);
    const cierre = await cerrarCuenta(cuenta, A, ADMIN_A);
    assert.strictEqual(cierre.total, 180);
    assert.strictEqual(cierre.propinas, 10, 'la propina va aparte');
    assert.strictEqual(cierre.cambio, 40);
    const venta = (await ventaDe(cierre.ventaFolio)).datos;
    assert.strictEqual(venta.forma_pago, 'mixto');
    assert.strictEqual(Number(venta.total), 180);
    assert.strictEqual(Number(venta.propinas), 10);
    const efectivo = venta.pagos.find(p => p.metodo === 'efectivo');
    assert.strictEqual(efectivo.recibido, 150);
    assert.strictEqual(efectivo.cambio, 40);
    assert.strictEqual(venta.pagos.find(p => p.metodo === 'terminal').recibido, undefined);
  });

  // ═══════════ 4. Descuentos ═══════════
  await t('DESCUENTO', 'porcentaje o importe con motivo obligatorio; staff hasta 10 %, admin sin límite; auditado', async () => {
    const cuenta = await nuevaCuenta([{ producto: 'Filete', cantidad: 2, precio_unitario: 100 }]);   // 200
    const staffOk = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', cookie: cookieStaff, body: { tipo: 'porcentaje', valor: 10, motivo: 'cortesía' } });
    assert.strictEqual(staffOk.status, 200, JSON.stringify(staffOk.body));
    assert.strictEqual(staffOk.body.descuento.monto, 20);
    assert.strictEqual(staffOk.body.total, 180);
    const staffNo = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', cookie: cookieStaff, body: { tipo: 'porcentaje', valor: 15, motivo: 'cortesía' } });
    assert.strictEqual(staffNo.status, 403, JSON.stringify(staffNo.body));
    assert.strictEqual(staffNo.body.code, 'DESCUENTO_NO_AUTORIZADO');
    const sinMotivo = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'importe', valor: 30 } });
    assert.strictEqual(sinMotivo.status, 400);
    assert.strictEqual(sinMotivo.body.code, 'MOTIVO_REQUERIDO');
    const excesivo = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'importe', valor: 250, motivo: 'todo' } });
    assert.strictEqual(excesivo.status, 400, 'nunca por encima del subtotal');
    const admin = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'importe', valor: 60, motivo: 'queja atendida' } });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.body));
    assert.strictEqual(admin.body.total, 140);
    const c = await obtenerCuenta(cuenta, A);
    assert.strictEqual(c.subtotal, 200);
    assert.strictEqual(c.total, 140);
    assert.strictEqual(c.descuento.monto, 60);
    assert.strictEqual(c.descuento.tipo, 'importe');
    assert.strictEqual(c.descuento.motivo, 'queja atendida');
    assert.strictEqual(c.descuento.por, ADMIN_A, 'queda quién');
    assert.ok(c.descuento.at, 'queda cuándo');
    assert.ok(c.descuento.porNombre);
    const quitar = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'DELETE' });
    assert.strictEqual(quitar.status, 200);
    const c2 = await obtenerCuenta(cuenta, A);
    assert.strictEqual(c2.descuento, null);
    assert.strictEqual(c2.total, 200);
  });

  await t('DESCUENTO', 'con pagos registrados: nunca por debajo de lo cobrado; se refleja en precuenta, ticket, venta y resumen de ventas', async () => {
    const cuenta = await nuevaCuenta([{ producto: 'Filete', cantidad: 2, precio_unitario: 100 }]);   // 200
    await registrarPago(cuenta, A, { metodo: 'efectivo', monto: 180, recibido: 180 }, ADMIN_A);
    const incompatible = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'importe', valor: 50, motivo: 'promo' } });
    assert.strictEqual(incompatible.status, 409, JSON.stringify(incompatible.body));
    assert.strictEqual(incompatible.body.code, 'DESCUENTO_INCOMPATIBLE');
    const ok = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'importe', valor: 20, motivo: 'promo del día' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.saldo, 0);
    // Precuenta con descuento, por Edge (la ruta Caja existe): subtotal, descuento y total.
    const pre = await api(`/api/restaurante/cuentas/${cuenta}/precuenta`, { method: 'POST', body: { solicitudId: `pre-${Date.now()}-descuento` } });
    assert.strictEqual(pre.status, 200, JSON.stringify(pre.body));
    assert.strictEqual(pre.body.destino, 'edge');
    const { rows: [pj] } = await pool.query(`SELECT payload FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = 'restaurante_precuenta' AND origen_id LIKE $2 ORDER BY created_at DESC LIMIT 1`, [A, cuenta + ':%']);
    assert.strictEqual(pj.payload.subtotal, 200);
    assert.strictEqual(pj.payload.descuento, 20);
    assert.strictEqual(pj.payload.descuentoMotivo, 'promo del día');
    assert.strictEqual(pj.payload.total, 180);
    assert.ok(renderCuenta(pj.payload).toString('latin1').includes('Descuento (promo del d'), 'el papel de la precuenta muestra el descuento con motivo');
    const [desde, hasta] = hoy();
    const antes = await obtenerResumenVentas(desde, hasta, A);
    const r = await api(`/api/restaurante/cuentas/${cuenta}/cerrar`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.subtotal, 200);
    assert.strictEqual(r.body.descuento, 20);
    assert.strictEqual(r.body.total, 180);
    const venta = (await ventaDe(r.body.ventaFolio)).datos;
    assert.strictEqual(Number(venta.subtotal), 200);
    assert.strictEqual(Number(venta.descuento), 20);
    assert.strictEqual(venta.motivo_descuento, 'promo del día');
    assert.strictEqual(venta.descuento_por, ADMIN_A);
    assert.strictEqual(Number(venta.total), 180, 'la venta es el neto');
    const despues = await obtenerResumenVentas(desde, hasta, A);
    const delta = Math.round((Number(despues.total_ventas ?? despues.total ?? 0) - Number(antes.total_ventas ?? antes.total ?? 0)) * 100) / 100;
    assert.strictEqual(delta, 180, `el resumen de ventas sube exactamente el neto (subió ${delta})`);
    const tj = await trabajos('restaurante_cuenta', r.body.ventaFolio);
    assert.strictEqual(tj.length, 1);
    assert.strictEqual(tj[0].payload.descuento, 20);
    assert.strictEqual(tj[0].payload.descuentoMotivo, 'promo del día');
    assert.strictEqual(tj[0].payload.total, 180);
    const papel = renderCuenta(tj[0].payload).toString('latin1');
    assert.ok(papel.includes('Subtotal') && papel.includes('Descuento (promo del d') && papel.includes('PAGADO'));
  });

  await t('CONCURRENCIA', 'descuento y cobro simultáneos: exactamente uno gana y el total nunca queda por debajo de lo pagado', async () => {
    const cuenta = await nuevaCuenta([{ producto: 'Filete', cantidad: 2, precio_unitario: 100 }]);   // 200
    const res = await Promise.allSettled([
      registrarPago(cuenta, A, { metodo: 'efectivo', monto: 200, recibido: 200 }, ADMIN_A),
      aplicarDescuentoCuenta(cuenta, A, { tipo: 'importe', valor: 50, motivo: 'carrera' }, { usuarioId: ADMIN_A, rol: 'admin' }),
    ]);
    const ok = res.filter(x => x.status === 'fulfilled').length;
    assert.strictEqual(ok, 1, `debía ganar exactamente uno (ganaron ${ok}): ${JSON.stringify(res.map(x => x.status === 'rejected' ? x.reason.code : 'ok'))}`);
    const c = await obtenerCuenta(cuenta, A);
    assert.ok(c.total + 0.005 >= c.pagado, `total ${c.total} por debajo de pagado ${c.pagado}`);
    const codigo = res.find(x => x.status === 'rejected').reason.code;
    assert.ok(['DESCUENTO_INCOMPATIBLE', 'PAGO_EXCEDE_SALDO'].includes(codigo), codigo);
    // Dos descuentos a la vez se serializan: queda uno, consistente.
    const dos = await Promise.allSettled([
      aplicarDescuentoCuenta(cuenta, A, { tipo: 'porcentaje', valor: 5, motivo: 'a' }, { usuarioId: ADMIN_A, rol: 'admin' }),
      aplicarDescuentoCuenta(cuenta, A, { tipo: 'porcentaje', valor: 8, motivo: 'b' }, { usuarioId: ADMIN_A, rol: 'admin' }),
    ]);
    const c2 = await obtenerCuenta(cuenta, A);
    assert.ok(c2.total + 0.005 >= c2.pagado);
    if (c2.descuento) assert.ok([10, 16].includes(c2.descuento.monto), JSON.stringify(c2.descuento));
    assert.ok(dos.every(x => x.status === 'fulfilled' || ['DESCUENTO_INCOMPATIBLE'].includes(x.reason.code)));
  });

  await t('TICKET', 'construirTicketCuenta es fiel a la cuenta: mismo snapshot para Edge y navegador', async () => {
    const c = await obtenerCuenta(cuenta1, A);
    const tk = construirTicketCuenta(c, { negocio: 'Prueba', reimpresion: true, numero: 3 });
    assert.strictEqual(tk.negocio, 'Prueba');
    assert.strictEqual(tk.folio, folio1);
    assert.strictEqual(tk.total, 70);
    assert.strictEqual(tk.reimpresion, true);
    assert.strictEqual(tk.reimpresionNumero, 3);
    assert.ok(tk.fecha, 'lleva la fecha de cierre');
  });

  // ═══════════ Pantalla: cambio antes de confirmar, descuento, cierre y reimpresión ═══════════
  await t('UI', 'en Chrome: el cambio se ve antes de confirmar, el descuento se refleja, el cierre imprime PAGADO una vez y reimprimir imprime otra con REIMPRESIÓN', async () => {
    const puppeteer = (await import('puppeteer')).default;
    const cuenta = await nuevaCuenta([TACOS(2), REFRESCO()]);       // 70
    await actualizarImpresora(A, IMP_CAJA.id, { activa: false });   // que imprima el navegador
    const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const pag = await nav.newPage();
      const errores = [];
      pag.on('pageerror', e => errores.push(e.message));
      pag.on('dialog', d => d.accept().catch(() => {}));
      await pag.setViewport({ width: 1280, height: 900 });
      await pag.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN_A, negocioId: A, rol: 'admin' })), domain: 'localhost', path: '/' });
      await pag.goto(`${base}/restaurante`, { waitUntil: 'networkidle0', timeout: 60000 });
      await pag.waitForSelector('#grid .mesa', { timeout: 15000 });
      await pag.evaluate(() => { window.__impresos = []; window.imprimirDocumentoTermico = (html) => { window.__impresos.push(html); }; });
      await pag.evaluate((id) => abrirCuenta(id), cuenta);
      await pag.waitForFunction(() => document.getElementById('cu-secundarias')?.textContent.includes('Descuento'), { timeout: 15000 });
      // Descuento 10 % (antes de cobrar): totales muestran subtotal, descuento y total.
      await pag.evaluate(() => abrirDescuento());
      await pag.select('#ds-tipo', 'porcentaje');
      await pag.type('#ds-valor', '10');
      await pag.type('#ds-motivo', 'cortesía');
      await pag.evaluate(() => aplicarDescuento());
      await pag.waitForSelector('#cu-descuento', { timeout: 15000 });
      const totales = await pag.$eval('#cu-totales', el => el.textContent.replace(/\s+/g, ' '));
      assert.ok(totales.includes('Subtotal') && totales.includes('$70.00') && totales.includes('cortesía') && totales.includes('-$7.00') && totales.includes('$63.00'), totales);
      // Pago en efectivo: recibe $100 sobre $63 -> el cambio se ve antes de confirmar.
      await pag.evaluate(() => abrirPago());
      await pag.waitForFunction(() => document.getElementById('dlg-pago').open, { timeout: 5000 });
      const abono = await pag.$eval('#pg-monto', el => el.value);
      assert.strictEqual(abono, '63.00', 'el abono propuesto es el saldo');
      await pag.type('#pg-recibido', '100');
      await pag.waitForFunction(() => document.getElementById('pg-cambio').textContent.includes('$37.00'), { timeout: 5000 });
      await pag.type('#pg-recibido', '0');   // 1000 -> cambio 937
      await pag.waitForFunction(() => document.getElementById('pg-cambio').textContent.includes('$937.00'), { timeout: 5000 });
      await pag.$eval('#pg-recibido', el => { el.value = '50'; el.dispatchEvent(new Event('input')); });
      await pag.waitForFunction(() => document.getElementById('pg-cambio').textContent.includes('Faltan') && document.getElementById('pg-registrar').disabled, { timeout: 5000 });
      await pag.$eval('#pg-recibido', el => { el.value = '100'; el.dispatchEvent(new Event('input')); });
      await pag.waitForFunction(() => !document.getElementById('pg-registrar').disabled, { timeout: 5000 });
      await pag.evaluate(() => registrarPago());
      await pag.waitForFunction(() => (document.getElementById('msg')?.textContent || '').includes('Cambio: $37.00'), { timeout: 15000 });
      await pag.waitForFunction(() => document.getElementById('cu-totales').textContent.includes('cambio $37.00'), { timeout: 15000 });
      // Cerrar: imprime PAGADO una vez por el navegador y ofrece reimprimir.
      await pag.evaluate(() => cerrarCuenta());
      await pag.waitForFunction(() => document.getElementById('dlg-cerrada').open, { timeout: 15000 });
      const cerrada = await pag.$eval('#dlg-cerrada', el => el.textContent.replace(/\s+/g, ' '));
      assert.ok(cerrada.includes('PAGADO') && cerrada.includes('RM-') && cerrada.includes('$63.00') && cerrada.includes('Cambio entregado: $37.00'), cerrada);
      let impresos = await pag.evaluate(() => window.__impresos);
      assert.strictEqual(impresos.length, 1, 'el cierre imprime exactamente un ticket');
      assert.ok(impresos[0].includes('<h1>PAGADO</h1>') && impresos[0].includes('Descuento (cortesía)') && impresos[0].includes('Efectivo recibido') && impresos[0].includes('$37.00'), impresos[0].slice(0, 300));
      assert.ok(!impresos[0].includes('REIMPRESI'));
      await pag.evaluate(() => reimprimirTicket());
      await pag.waitForFunction(() => window.__impresos.length === 2, { timeout: 15000 });
      impresos = await pag.evaluate(() => window.__impresos);
      assert.ok(impresos[1].includes('REIMPRESI') && impresos[1].includes('<h1>PAGADO</h1>'));
      const c = await obtenerCuenta(cuenta, A);
      assert.strictEqual(c.estado, 'cerrada');
      assert.strictEqual(c.ticketImpresiones, 1);
      assert.strictEqual(c.pagos.length, 1, 'reimprimir no cobró otra vez');
      assert.deepStrictEqual(errores, [], 'errores de JavaScript en la pantalla');
    } finally {
      await nav.close();
      await actualizarImpresora(A, IMP_CAJA.id, { activa: true });
    }
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  srv.detener();
  // La infraestructura de impresión del negocio A es estado COMPARTIDO entre
  // suites: se deja como se encontró (sin impresoras), o las suites que
  // cuentan trabajos de impresión ven papel que no es suyo.
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [A]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [A]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [A]).catch(() => {});
  await pool.query(`DELETE FROM edge_instalaciones WHERE terminal_id IN (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = $1)`, [A]).catch(() => {});
  await pool.query(`DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`, [A]).catch(() => {});
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
