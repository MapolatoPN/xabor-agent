// ─── Candado de precuenta, cobro identificado y mesas fuera del tablero ────
//
// Revisión del cierre de mesas en Obispado (17-nov-2026). Lo que esta suite
// garantiza, contra el servidor y Postgres reales:
//   · cada precuenta impresa queda registrada con número y folio
//     PC-XXXXXXXX-N (las mismas 8 letras que la venta RM-…), por Edge o por
//     el navegador, completa o de la cuenta dividida, e idempotente;
//   · con 'restaurante_candado_precuenta', lo que salió en la precuenta no se
//     quita, rebaja, cancela ni descuenta sin la clave de un ADMINISTRADOR
//     (la de staff no basta), y una cuenta que cambió desde su precuenta no se
//     cierra sin imprimir otra o sin esa clave. Lo agregado después, libre;
//   · sin la bandera, todo sigue como antes;
//   · un descuento de más del 10 % desde una sesión de staff se autoriza con
//     la clave de un supervisor, sin abrir la sesión del administrador;
//   · con 'restaurante_cobro_identificado', cobrar y cerrar piden el PIN de
//     quien cobra y el pago queda a su nombre;
//   · mover de mesa solo dentro del tablero y con bitácora; las cuentas que ya
//     estén fuera se listan aparte.
// Negocios propios (slug candado-precuenta-*), se reconstruyen en cada corrida.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-restaurante-candado-precuenta.mjs
import assert from 'assert';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_CANDADO || '4993';

const { pool } = await import('../src/services/database.js');
const { abrirMesa, agregarItems, enviarComanda, registrarPago, listarMesas } = await import('../src/services/restauranteService.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { hashPin } = await import('../src/services/password.js');
const { renglonesDeTicket } = await import('../src/printing/formato/ticket.js');
const { renderCuenta } = await import('../edge/renderers/index.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Negocios de prueba ──────────────────────────────────────────────────────
const SLUGS = ['candado-precuenta-a', 'candado-precuenta-b', 'candado-precuenta-c'];
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = ANY($1)`, [SLUGS]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]).catch(() => {});
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_cuenta_bitacora WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_precuentas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_item_eventos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_cuenta_porciones WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM configuracion WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM sucursales WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuarios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocios WHERE id = ANY($1)`);
}
await limpiar();

async function negocio(nombre, slug) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [nombre, slug]);
  for (const m of ['restaurante', 'pos', 'usuarios', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n.id, m]);
  }
  for (const [tipo, orden] of [['efectivo', 0], ['terminal', 1]]) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,$3)
      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [n.id, tipo, orden]);
  }
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [n.id]);
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'ordenes_por_persona','true')`, [n.id]);
  // El tablero de Obispado dibuja 40 mesas.
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'restaurante_num_mesas','40')`, [n.id]);
  return n.id;
}
async function usuario(negocioId, nombre, rol, { pin = null, clave = null } = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash, pin_hash, pin_autorizacion_hash) VALUES ($1,$2,$3,'x',$4,$5) RETURNING id`,
    [negocioId, nombre, `candado-${rol}-${Math.random().toString(36).slice(2)}@test.local`,
     pin ? hashPin(pin) : null, clave ? hashPin(clave) : null]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, negocioId, rol]);
  return u.id;
}
async function bandera(negocioId, clave, valor) {
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [negocioId, clave]);
  if (valor !== null) await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)`, [negocioId, clave, valor]);
}
const CANDADO = 'restaurante_candado_precuenta';
const COBRO = 'restaurante_cobro_identificado';

const A = await negocio('Candado A', SLUGS[0]);
const B = await negocio('Candado B', SLUGS[1]);
const C = await negocio('Candado C', SLUGS[2]);
// Claves (inventadas para la suite): Mario 7311, su papá 7422, la caja 6533 (staff).
const MARIO = await usuario(A, 'Mario Candado', 'admin', { clave: '7311' });
const PAPA = await usuario(A, 'Papá Candado', 'admin', { clave: '7422' });
const CAJA = await usuario(A, 'Caja Candado', 'staff', { clave: '6533', pin: '1357' });
const MESERO = await usuario(A, 'Mesero Candado', 'mesero', { pin: '2468' });
// C: un negocio SIN ningún administrador con clave (solo staff con clave).
const ADMIN_C = await usuario(C, 'Admin C', 'admin');
const STAFF_C = await usuario(C, 'Staff C', 'staff', { clave: '9135' });
// B: una clave de administrador de OTRO negocio no vale en A.
const AJENO = await usuario(B, 'Admin ajeno', 'admin', { clave: '8246' });

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const base = srv.base;
const sesion = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const cookieMario = sesion(MARIO, A, 'admin');
const cookieCaja = sesion(CAJA, A, 'staff');
const cookieAdminC = sesion(ADMIN_C, C, 'admin');
const cookieStaffC = sesion(STAFF_C, C, 'staff');
async function api(path, { cookie = cookieCaja, method = 'GET', body } = {}) {
  const r = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json, setCookie: r.headers.get('set-cookie') };
}
const cta = (id) => `/api/restaurante/cuentas/${id}`;
const precuenta = (id, opts = {}) => api(`${cta(id)}/precuenta`, { method: 'POST', body: { solicitudId: opts.solicitudId || randomUUID() }, ...opts });

let mesa = 1;
const it = (producto, cantidad, precio, extra = {}) => ({ producto, cantidad, precio_unitario: precio, ...extra });
async function nuevaCuenta(negocioId = A, items = [it('Enchiladas', 2, 120), it('Agua', 1, 35)], { enviar = true, mesero = CAJA } = {}) {
  const c = await abrirMesa(negocioId, { mesaNumero: mesa++, personas: 2, meseroUsuarioId: mesero, abiertaPor: mesero });
  if (items.length) await agregarItems(c.id, negocioId, items, mesero);
  if (enviar && items.length) await enviarComanda(c.id, negocioId, mesero);
  return c.id;
}
const items = async (cuentaId) => (await pool.query(
  `SELECT id, producto, cantidad, estado, comanda_num FROM restaurante_cuenta_items WHERE cuenta_id = $1 ORDER BY created_at, producto`, [cuentaId])).rows;
const itemDe = async (cuentaId, producto) => (await items(cuentaId)).find(i => i.producto === producto && i.estado !== 'cancelado');
const bitacora = async (cuentaId, tipo) => (await pool.query(
  `SELECT * FROM restaurante_cuenta_bitacora WHERE cuenta_id = $1 AND tipo = $2 ORDER BY created_at`, [cuentaId, tipo])).rows;
const pagarTodo = async (cuentaId, negocioId = A) => {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT COALESCE(SUM(cantidad*precio_unitario),0) FROM restaurante_cuenta_items WHERE cuenta_id = c.id AND estado <> 'cancelado') - c.descuento_monto
            - (SELECT COALESCE(SUM(monto),0) FROM restaurante_cuenta_pagos WHERE cuenta_id = c.id AND revertido_at IS NULL) AS saldo
       FROM restaurante_cuentas c WHERE c.id = $1`, [cuentaId]);
  if (Number(r.saldo) > 0) await registrarPago(cuentaId, negocioId, { metodo: 'efectivo', monto: Number(r.saldo) }, CAJA);
};
const folioDe = (cuentaId, n) => `PC-${cuentaId.replace(/-/g, '').slice(0, 8).toUpperCase()}-${n}`;

try {
  // ═══════════ A. Registro de la precuenta ═══════════
  await t('REGISTRO', '1. imprimir registra la precuenta N.º 1 con folio PC-XXXXXXXX-1 y lo pone en el papel', async () => {
    const c = await nuevaCuenta();
    const r = await precuenta(c);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.destino, 'navegador', 'sin Caja por Edge la precuenta va al navegador');
    assert.strictEqual(r.body.registro?.folio, folioDe(c, 1));
    assert.strictEqual(r.body.precuenta.folio, folioDe(c, 1), 'el papel no lleva el folio');
    assert.ok(!Number.isNaN(Date.parse(r.body.precuenta.emitidoAt)), 'el papel no lleva la hora');
    const { rows } = await pool.query(`SELECT * FROM restaurante_precuentas WHERE cuenta_id = $1`, [c]);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual([rows[0].numero, rows[0].tipo, Number(rows[0].total), rows[0].solicitada_por], [1, 'completa', 275, CAJA]);
    // La venta del cierre comparte las 8 letras: el papel se casa con la venta.
    await pagarTodo(c);
    const cierre = await api(`${cta(c)}/cerrar`, { method: 'POST' });
    assert.strictEqual(cierre.status, 200, JSON.stringify(cierre.body));
    assert.strictEqual(cierre.body.ventaFolio.slice(3, 11), folioDe(c, 1).slice(3, 11));
  });

  await t('REGISTRO', '2. un reintento con la misma solicitud devuelve la misma precuenta; otro toque, la N.º 2', async () => {
    const c = await nuevaCuenta();
    const solicitudId = randomUUID();
    const r1 = await precuenta(c, { solicitudId });
    const r2 = await precuenta(c, { solicitudId });
    assert.strictEqual(r2.body.registro.folio, r1.body.registro.folio);
    const r3 = await precuenta(c);
    assert.strictEqual(r3.body.registro.numero, 2);
    const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM restaurante_precuentas WHERE cuenta_id = $1`, [c]);
    assert.strictEqual(n.n, 2);
  });

  await t('REGISTRO', '3. dos cajas imprimiendo a la vez sacan números distintos, sin error', async () => {
    const c = await nuevaCuenta();
    const rs = await Promise.all([precuenta(c), precuenta(c), precuenta(c)]);
    assert.deepStrictEqual(rs.map(r => r.status), [200, 200, 200], JSON.stringify(rs.map(r => r.body)));
    assert.deepStrictEqual(rs.map(r => r.body.registro.numero).sort(), [1, 2, 3]);
  });

  await t('REGISTRO', '4. la precuenta de la cuenta dividida registra un papel por persona, con su folio', async () => {
    const c = await nuevaCuenta(A, [it('Café', 1, 40, { persona: { numero: 1, nombre: '' } }), it('Pan', 2, 25, { persona: { numero: 2, nombre: '' } })]);
    const r = await api(`${cta(c)}/precuenta-division`, { method: 'POST', body: { modo: 'personas', solicitudId: randomUUID() } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.precuentas.map(p => p.folio), [folioDe(c, 1), folioDe(c, 2)]);
    const { rows } = await pool.query(`SELECT numero, tipo, total FROM restaurante_precuentas WHERE cuenta_id = $1 ORDER BY numero`, [c]);
    assert.deepStrictEqual(rows.map(x => [x.numero, x.tipo, Number(x.total)]), [[1, 'division', 40], [2, 'division', 50]]);
  });

  await t('REGISTRO', '5. el folio sale impreso por Edge y por el formato del servidor', async () => {
    const payload = { precuenta: true, mesa: 7, folio: 'PC-ABCDEF12-3', emitidoAt: new Date().toISOString(), items: [], total: 10 };
    assert.ok(renderCuenta(payload, { ancho: 42 }).toString('latin1').includes('Folio: PC-ABCDEF12-3'), 'Edge no imprime el folio');
    assert.ok(renglonesDeTicket(payload, { ancho: 42 }).some(r => typeof r.texto === 'string' && r.texto.includes('PC-ABCDEF12-3')), 'el formato del servidor no imprime el folio');
  });

  await t('REGISTRO', '6. la cuenta dice su última precuenta y si sigue vigente; nunca la firma', async () => {
    const c = await nuevaCuenta();
    await precuenta(c);
    let r = await api(cta(c));
    assert.strictEqual(r.body.candado.precuenta.folio, folioDe(c, 1));
    assert.strictEqual(r.body.candado.vigente, true);
    assert.ok(!JSON.stringify(r.body).includes('"firma"'), 'la firma no debe salir del servidor');
    await agregarItems(c, A, [it('Postre', 1, 60)], CAJA);
    r = await api(cta(c));
    assert.strictEqual(r.body.candado.vigente, false, 'agregar después de la precuenta la deja vencida');
  });

  await t('REGISTRO', '7. el mesero de tablet imprime y queda como quien la pidió', async () => {
    const login = await api('/api/auth/mesero/login', { cookie: null, method: 'POST', body: { negocio: SLUGS[0], meseroUsuarioId: MESERO, pin: '2468' } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const cookieTablet = login.setCookie.split(';')[0];
    const c = await nuevaCuenta(A, undefined, { mesero: MESERO });
    const r = await precuenta(c, { cookie: cookieTablet });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const { rows: [p] } = await pool.query(`SELECT solicitada_por FROM restaurante_precuentas WHERE cuenta_id = $1`, [c]);
    assert.strictEqual(p.solicitada_por, MESERO);
  });

  // ═══════════ B. Sin bandera: todo como antes ═══════════
  await t('SIN BANDERA', '8. con precuenta impresa y sin candado, quitar y descontar siguen sin clave', async () => {
    await bandera(A, CANDADO, null);
    const c = await nuevaCuenta(A, [it('Tacos', 3, 30)], { enviar: false });
    await precuenta(c);
    const tacos = await itemDe(c, 'Tacos');
    const r = await api(`${cta(c)}/items/${tacos.id}/cantidad`, { method: 'PATCH', body: { cantidad: 1 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = await api(`${cta(c)}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 5, motivo: 'Cliente frecuente' } });
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  });

  // ═══════════ C. Candado encendido ═══════════
  await bandera(A, CANDADO, 'true');

  await t('CANDADO', '9. quitar un pendiente que salió en la precuenta pide clave de supervisor; la de staff no basta', async () => {
    const c = await nuevaCuenta(A, [it('Tacos', 2, 30), it('Refresco', 1, 25)], { enviar: false });
    await precuenta(c);
    const tacos = await itemDe(c, 'Tacos');
    const sin = await api(`${cta(c)}/items/${tacos.id}`, { method: 'DELETE', body: {} });
    assert.deepStrictEqual([sin.status, sin.body?.code], [409, 'CANDADO_PRECUENTA'], JSON.stringify(sin.body));
    assert.strictEqual(sin.body.detalle?.folio, folioDe(c, 1));
    const staff = await api(`${cta(c)}/items/${tacos.id}`, { method: 'DELETE', body: { supervisor_pin: '6533' } });
    assert.deepStrictEqual([staff.status, staff.body?.code], [401, 'PIN_INCORRECTO'], 'la clave de staff no es de supervisor');
    assert.ok(await itemDe(c, 'Tacos'), 'el platillo se quitó sin autorización');
    const ok = await api(`${cta(c)}/items/${tacos.id}`, { method: 'DELETE', body: { supervisor_pin: '7422' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(!(await itemDe(c, 'Tacos')));
    const { rows: [ev] } = await pool.query(`SELECT tipo, autorizado_por, solicitado_por FROM restaurante_item_eventos WHERE cuenta_id = $1`, [c]);
    assert.deepStrictEqual([ev.tipo, ev.autorizado_por, ev.solicitado_por], ['quitado_antes_de_enviar', PAPA, CAJA]);
    const [b] = await bitacora(c, 'autorizacion_supervisor');
    assert.deepStrictEqual([b.autorizado_por, b.solicitado_por, b.detalle.accion, b.detalle.precuenta], [PAPA, CAJA, 'quitar_platillo', folioDe(c, 1)]);
  });

  await t('CANDADO', '10. lo que se agregó DESPUÉS de la precuenta se quita sin clave', async () => {
    const c = await nuevaCuenta(A, [it('Tacos', 2, 30)], { enviar: false });
    await precuenta(c);
    await agregarItems(c, A, [it('Cerveza', 1, 45)], CAJA);
    const cerveza = await itemDe(c, 'Cerveza');
    const r = await api(`${cta(c)}/items/${cerveza.id}`, { method: 'DELETE', body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  await t('CANDADO', '11. rebajar la cantidad pide clave; subirla, no', async () => {
    const c = await nuevaCuenta(A, [it('Tacos', 3, 30)], { enviar: false });
    await precuenta(c);
    const tacos = await itemDe(c, 'Tacos');
    const baja = await api(`${cta(c)}/items/${tacos.id}/cantidad`, { method: 'PATCH', body: { cantidad: 1 } });
    assert.deepStrictEqual([baja.status, baja.body?.code], [409, 'CANDADO_PRECUENTA']);
    assert.strictEqual((await itemDe(c, 'Tacos')).cantidad, 3);
    const sube = await api(`${cta(c)}/items/${tacos.id}/cantidad`, { method: 'PATCH', body: { cantidad: 4 } });
    assert.strictEqual(sube.status, 200, JSON.stringify(sube.body));
    const conClave = await api(`${cta(c)}/items/${tacos.id}/cantidad`, { method: 'PATCH', body: { cantidad: 2, supervisor_pin: '7311' } });
    assert.strictEqual(conClave.status, 200, JSON.stringify(conClave.body));
    const { rows: [ev] } = await pool.query(`SELECT cantidad, autorizado_por FROM restaurante_item_eventos WHERE cuenta_id = $1 AND tipo = 'cantidad_reducida'`, [c]);
    assert.deepStrictEqual([ev.cantidad, ev.autorizado_por], [2, MARIO]);
  });

  await t('CANDADO', '12. cancelar lo enviado: con la clave de staff se rechaza, con la de un administrador pasa', async () => {
    const c = await nuevaCuenta();
    await precuenta(c);
    const ench = await itemDe(c, 'Enchiladas');
    const staff = await api(`${cta(c)}/items/${ench.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'error_captura', pin: '6533', cantidad: 1 } });
    assert.deepStrictEqual([staff.status, staff.body?.code], [409, 'CANDADO_PRECUENTA'], JSON.stringify(staff.body));
    assert.strictEqual((await itemDe(c, 'Enchiladas')).cantidad, 2, 'se canceló con la clave de staff');
    const admin = await api(`${cta(c)}/items/${ench.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'error_captura', pin: '7422', cantidad: 1 } });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.body));
    const [b] = await bitacora(c, 'autorizacion_supervisor');
    assert.deepStrictEqual([b.autorizado_por, b.detalle.accion], [PAPA, 'cancelar_platillo']);
  });

  await t('CANDADO', '13. sin precuenta, cancelar con la clave de staff sigue como siempre', async () => {
    const c = await nuevaCuenta();
    const ench = await itemDe(c, 'Enchiladas');
    const r = await api(`${cta(c)}/items/${ench.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'error_captura', pin: '6533', cantidad: 1 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  await t('CANDADO', '14. descontar después de la precuenta pide clave, y el descuento queda a nombre de quien autorizó', async () => {
    const c = await nuevaCuenta();
    await precuenta(c);
    const sin = await api(`${cta(c)}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 5, motivo: 'Cliente frecuente' } });
    assert.deepStrictEqual([sin.status, sin.body?.code], [409, 'CANDADO_PRECUENTA']);
    const admin = await api(`${cta(c)}/descuento`, { cookie: cookieMario, method: 'POST', body: { tipo: 'porcentaje', valor: 5, motivo: 'Cliente frecuente' } });
    assert.deepStrictEqual([admin.status, admin.body?.code], [409, 'CANDADO_PRECUENTA'], 'la SESIÓN de administrador no basta: hace falta su clave');
    const ok = await api(`${cta(c)}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 5, motivo: 'Cliente frecuente', supervisor_pin: '7422' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const { rows: [k] } = await pool.query(`SELECT descuento_por, descuento_monto FROM restaurante_cuentas WHERE id = $1`, [c]);
    assert.deepStrictEqual([k.descuento_por, Number(k.descuento_monto)], [PAPA, 13.75]);
  });

  await t('CANDADO', '15. una cuenta que cambió desde su precuenta no se cierra; con una precuenta nueva, sí', async () => {
    const c = await nuevaCuenta();
    await precuenta(c);
    await agregarItems(c, A, [it('Café', 1, 40)], CAJA);
    await pagarTodo(c);
    const r = await api(`${cta(c)}/cerrar`, { method: 'POST' });
    assert.deepStrictEqual([r.status, r.body?.code], [409, 'PRECUENTA_VENCIDA'], JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.detalle.totalPrecuenta, r.body.detalle.totalActual], [275, 315]);
    const { rows: [k] } = await pool.query(`SELECT estado FROM restaurante_cuentas WHERE id = $1`, [c]);
    assert.strictEqual(k.estado, 'abierta');
    await precuenta(c);
    const ok = await api(`${cta(c)}/cerrar`, { method: 'POST' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  await t('CANDADO', '16. o con la clave de un supervisor, y queda en la bitácora', async () => {
    const c = await nuevaCuenta();
    await precuenta(c);
    await agregarItems(c, A, [it('Café', 1, 40)], CAJA);
    await pagarTodo(c);
    const ok = await api(`${cta(c)}/cerrar`, { method: 'POST', body: { supervisor_pin: '7311' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const [b] = await bitacora(c, 'autorizacion_supervisor');
    assert.deepStrictEqual([b.autorizado_por, b.detalle.accion, Number(b.detalle.total_actual)], [MARIO, 'cerrar_vencida', 315]);
  });

  await t('CANDADO', '17. con la precuenta vigente se cierra sin pedir nada', async () => {
    const c = await nuevaCuenta();
    await precuenta(c);
    await pagarTodo(c);
    const ok = await api(`${cta(c)}/cerrar`, { method: 'POST' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  await t('CANDADO', '18. la clave de un administrador de OTRO negocio no autoriza aquí', async () => {
    const c = await nuevaCuenta(A, [it('Tacos', 2, 30)], { enviar: false });
    await precuenta(c);
    const tacos = await itemDe(c, 'Tacos');
    const r = await api(`${cta(c)}/items/${tacos.id}`, { method: 'DELETE', body: { supervisor_pin: '8246' } });
    assert.deepStrictEqual([r.status, r.body?.code], [401, 'PIN_INCORRECTO']);
    assert.ok(await itemDe(c, 'Tacos'));
  });

  await t('CANDADO', '19. sin ningún administrador con clave: la sesión de administrador autoriza (y queda dicho); la de staff no', async () => {
    await bandera(C, CANDADO, 'true');
    const c = await nuevaCuenta(C, [it('Tacos', 2, 30), it('Agua', 1, 20)], { enviar: false, mesero: STAFF_C });
    await precuenta(c, { cookie: cookieStaffC });
    const [tacos, agua] = [await itemDe(c, 'Tacos'), await itemDe(c, 'Agua')];
    const staff = await api(`${cta(c)}/items/${tacos.id}`, { cookie: cookieStaffC, method: 'DELETE', body: {} });
    assert.deepStrictEqual([staff.status, staff.body?.code, staff.body?.detalle?.sinSupervisores], [409, 'CANDADO_PRECUENTA', true]);
    const admin = await api(`${cta(c)}/items/${agua.id}`, { cookie: cookieAdminC, method: 'DELETE', body: {} });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.body));
    const [b] = await bitacora(c, 'autorizacion_supervisor');
    assert.deepStrictEqual([b.autorizado_por, b.detalle.sin_clave], [ADMIN_C, true]);
  });

  // ═══════════ D. Descuento mayor al 10 % con clave de supervisor ═══════════
  await t('DESCUENTO', '20. staff pide 20 %: sin clave se rechaza ofreciendo la del supervisor; con ella pasa', async () => {
    await bandera(A, CANDADO, null);
    const c = await nuevaCuenta();
    const sin = await api(`${cta(c)}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 20, motivo: 'Queja' } });
    assert.deepStrictEqual([sin.status, sin.body?.code, sin.body?.detalle?.requiereSupervisor], [403, 'DESCUENTO_NO_AUTORIZADO', true]);
    const staff = await api(`${cta(c)}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 20, motivo: 'Queja', supervisor_pin: '6533' } });
    assert.strictEqual(staff.status, 401, 'la clave de staff no sube el tope');
    const ok = await api(`${cta(c)}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 20, motivo: 'Queja', supervisor_pin: '7311' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const { rows: [k] } = await pool.query(`SELECT descuento_por FROM restaurante_cuentas WHERE id = $1`, [c]);
    assert.strictEqual(k.descuento_por, MARIO);
    const [b] = await bitacora(c, 'autorizacion_supervisor');
    assert.deepStrictEqual([b.autorizado_por, b.solicitado_por, b.detalle.accion], [MARIO, CAJA, 'descuento']);
  });

  // ═══════════ E. Cobro identificado ═══════════
  await bandera(A, COBRO, 'true');

  await t('COBRO', '21. sin decir quién cobra, el pago no entra', async () => {
    const c = await nuevaCuenta();
    const r = await api(`${cta(c)}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 100 } });
    assert.deepStrictEqual([r.status, r.body?.code], [400, 'COBRA_REQUERIDO']);
    const mal = await api(`${cta(c)}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 100, cobra: { usuario_id: MESERO, pin: '1111' } } });
    assert.deepStrictEqual([mal.status, mal.body?.code], [401, 'COBRA_PIN_INCORRECTO']);
    const ajeno = await api(`${cta(c)}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 100, cobra: { usuario_id: AJENO, pin: '8246' } } });
    assert.deepStrictEqual([ajeno.status, ajeno.body?.code], [401, 'COBRA_PIN_INCORRECTO'], 'alguien de otro negocio no cobra aquí');
    const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id = $1`, [c]);
    assert.strictEqual(n.n, 0);
  });

  await t('COBRO', '22. con el PIN del mesero, el pago queda a su nombre y la sesión de la caja en la bitácora', async () => {
    const c = await nuevaCuenta();
    const r = await api(`${cta(c)}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 100, cobra: { usuario_id: MESERO, pin: '2468' } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const { rows: [p] } = await pool.query(`SELECT registrado_por FROM restaurante_cuenta_pagos WHERE cuenta_id = $1`, [c]);
    assert.strictEqual(p.registrado_por, MESERO);
    const [b] = await bitacora(c, 'cobro_identificado');
    assert.deepStrictEqual([b.solicitado_por, b.sesion_usuario_id, b.detalle.accion, Number(b.detalle.monto)], [MESERO, CAJA, 'pago', 100]);
  });

  await t('COBRO', '23. cerrar también pide quién cobra; queda como quien cerró. La clave de autorización también vale', async () => {
    const c = await nuevaCuenta();
    await registrarPago(c, A, { metodo: 'efectivo', monto: 275 }, CAJA);
    const sin = await api(`${cta(c)}/cerrar`, { method: 'POST' });
    assert.deepStrictEqual([sin.status, sin.body?.code], [400, 'COBRA_REQUERIDO']);
    const ok = await api(`${cta(c)}/cerrar`, { method: 'POST', body: { cobra: { usuario_id: CAJA, pin: '6533' } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const { rows: [k] } = await pool.query(`SELECT cerrada_por, estado FROM restaurante_cuentas WHERE id = $1`, [c]);
    assert.deepStrictEqual([k.estado, k.cerrada_por], ['cerrada', CAJA]);
  });

  await t('COBRO', '24. el cobro por consumo de la cuenta dividida queda a nombre de quien cobra', async () => {
    const c = await nuevaCuenta(A, [it('Café', 1, 40), it('Pan', 2, 25)]);
    const { rows: [cafe] } = await pool.query(`SELECT id FROM restaurante_cuenta_items WHERE cuenta_id = $1 AND producto = 'Café'`, [c]);
    const r = await api(`${cta(c)}/cobros-consumo`, { method: 'POST', body: {
      seleccion: [{ itemId: cafe.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 40 }], cobra: { usuario_id: MESERO, pin: '2468' },
    } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const { rows } = await pool.query(`SELECT registrado_por FROM restaurante_cuenta_pagos WHERE cuenta_id = $1
      UNION ALL SELECT registrado_por FROM restaurante_cuenta_porciones WHERE cuenta_id = $1`, [c]);
    assert.deepStrictEqual([...new Set(rows.map(x => x.registrado_por))], [MESERO]);
  });
  await bandera(A, COBRO, null);

  // ═══════════ F. Mesas fuera del tablero ═══════════
  await t('MESAS', '25. mover a una mesa que el tablero no dibuja se rechaza', async () => {
    const c = await nuevaCuenta();
    const r = await api(`${cta(c)}/mover`, { method: 'POST', body: { mesa: 150 } });
    assert.deepStrictEqual([r.status, r.body?.code], [400, 'MESA_FUERA_DE_TABLERO']);
    const { rows: [k] } = await pool.query(`SELECT mesa_numero FROM restaurante_cuentas WHERE id = $1`, [c]);
    assert.ok(k.mesa_numero <= 40);
  });

  await t('MESAS', '26. mover dentro del tablero deja rastro: de qué mesa a cuál y quién', async () => {
    const c = await nuevaCuenta();
    const { rows: [antes] } = await pool.query(`SELECT mesa_numero FROM restaurante_cuentas WHERE id = $1`, [c]);
    const r = await api(`${cta(c)}/mover`, { method: 'POST', body: { mesa: 40 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const [b] = await bitacora(c, 'mesa_movida');
    assert.deepStrictEqual([b.detalle.de, b.detalle.a, b.solicitado_por], [antes.mesa_numero, 40, CAJA]);
  });

  await t('MESAS', '27. una cuenta que ya estaba fuera del tablero se lista aparte; el tablero marca la precuenta', async () => {
    const fuera = await abrirMesa(A, { mesaNumero: 150, personas: 2, meseroUsuarioId: CAJA, abiertaPor: CAJA });
    const c = await nuevaCuenta();
    await precuenta(c);
    const t1 = await listarMesas(A);
    assert.strictEqual(t1.numMesas, 40);
    assert.ok(t1.fueraDeTablero.some(m => m.cuentaId === fuera.id && m.mesa === 150), 'la mesa 150 no aparece');
    assert.ok(!t1.mesas.some(m => m.mesa === 150));
    assert.strictEqual(t1.mesas.find(m => m.cuentaId === c).precuentas, 1);
    // Y desde ahí se regresa al tablero.
    const r = await api(`${cta(fuera.id)}/mover`, { method: 'POST', body: { mesa: 39 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!(await listarMesas(A)).fueraDeTablero.some(m => m.cuentaId === fuera.id));
  });

  // ═══════════ G. Contrato ═══════════
  await t('CONTRATO', '28. la 140 está en el runner del predeploy, y la pantalla sabe pedir clave y quién cobra', async () => {
    const runner = readFileSync(new URL('../scripts/predeploy-run-032-033.mjs', import.meta.url), 'utf8');
    assert.ok(runner.includes("'140-restaurante-candado-precuenta'"), 'la 140 no llegaría a producción');
    const html = readFileSync(new URL('../panel/mesas.html', import.meta.url), 'utf8');
    for (const f of ['id="dlg-supervisor"', 'id="dlg-cobra"', 'supervisor_pin', "'PRECUENTA_VENCIDA'", 'fueraDeTablero', 'Folio: ']) {
      assert.ok(html.includes(f), `mesas.html no tiene ${f}`);
    }
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  srv.detener();
  await limpiar().catch(() => {});
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
