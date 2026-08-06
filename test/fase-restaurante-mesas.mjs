// Módulo de restaurante (Frente C): mesas, comandas, división de cuenta,
// pagos y concurrencia (C9). Ejercita el servicio directo (carreras con
// Promise.all) y las rutas HTTP reales (roles, módulo, aislamiento).
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-restaurante-mesas.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4950';

const { pool } = await import('../src/services/database.js');
const {
  listarMesas, abrirMesa, obtenerCuenta, agregarItems, enviarComanda, cancelarItem,
  registrarPago, dividirEnPartesIguales, cerrarCuenta, moverMesa, reabrirCuenta, indicadoresRestaurante,
  revertirVentaCuenta,
} = await import('../src/services/restauranteService.js');
const { obtenerVentas, obtenerResumenVentas, obtenerPedidosActivos } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Setup ──
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(SEED.negocioA, 'restaurante', 'activo');
await fijarModulo(SEED.negocioB, 'restaurante', 'activo');
// /api/ventas y /api/ventas/resumen viven detrás del módulo 'pos' -- la
// integración contable se verifica también por HTTP real.
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');

// Métodos de pago habilitados: el seed de pruebas crea los negocios por SQL
// directo (sin pasar por crearNegocioCompleto ni por el backfill de la
// migración 025), así que aquí se habilitan explícitamente efectivo y
// terminal -- transferencia queda deshabilitada A PROPÓSITO para probar el
// rechazo de métodos no habilitados.
for (const negocio of [SEED.negocioA, SEED.negocioB]) {
  for (const [tipo, habilitado, orden] of [['efectivo', true, 0], ['terminal', true, 1], ['transferencia', false, 2]]) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,$3,$4)
       ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`,
      [negocio, tipo, habilitado, orden]
    );
  }
}

// Usuario admin propio del negocio B (el seed solo crea usuarios de A).
const { rows: [uB] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1, 'Admin B Rest', $2, 'x') RETURNING id`,
  [SEED.negocioB, `admin-b-rest-${Date.now()}@test.local`]
);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [uB.id, SEED.negocioB]);
const ADMIN_B = uB.id;
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const STAFF_A = SEED.staffNegocioAUsuarioId;

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN_A, negocioId: SEED.negocioA, rol: 'admin' }))}`;
const cookieStaffA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: STAFF_A, negocioId: SEED.negocioA, rol: 'staff' }))}`;
const cookieAdminB = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN_B, negocioId: SEED.negocioB, rol: 'admin' }))}`;

async function api(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// ═══════════ Migración ═══════════
await t('MIGRACION', '039: tablas e índice único de mesa abierta presentes', async () => {
  const tablas = await pool.query(`SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name IN ('restaurante_cuentas','restaurante_cuenta_items','restaurante_cuenta_pagos')`);
  assert.strictEqual(tablas.rows[0].c, 3);
  const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_restaurante_mesa_abierta'`);
  assert.strictEqual(idx.rows.length, 1);
});

// ═══════════ Apertura atómica (C3/C9) ═══════════
await t('APERTURA', 'dos dispositivos abren la Mesa 1 al mismo tiempo -> exactamente uno gana', async () => {
  const intentos = await Promise.allSettled([
    abrirMesa(SEED.negocioA, { mesaNumero: 1, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A }),
    abrirMesa(SEED.negocioA, { mesaNumero: 1, personas: 4, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A }),
  ]);
  const ok = intentos.filter(i => i.status === 'fulfilled');
  const rechazados = intentos.filter(i => i.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'exactamente una apertura debe ganar');
  assert.strictEqual(rechazados.length, 1);
  assert.strictEqual(rechazados[0].reason.code, 'MESA_OCUPADA');
});

await t('APERTURA', 'HTTP: 201 al abrir, 409 en mesa ocupada, 400 mesa inválida, mesero de otro negocio rechazado', async () => {
  const r1 = await api('/api/restaurante/mesas/abrir', { cookie: cookieAdminA, method: 'POST', body: { mesa: 2, personas: 3 } });
  assert.strictEqual(r1.status, 201);
  const r2 = await api('/api/restaurante/mesas/abrir', { cookie: cookieAdminA, method: 'POST', body: { mesa: 2, personas: 2 } });
  assert.strictEqual(r2.status, 409);
  const r3 = await api('/api/restaurante/mesas/abrir', { cookie: cookieAdminA, method: 'POST', body: { mesa: 0 } });
  assert.strictEqual(r3.status, 400);
  const r4 = await api('/api/restaurante/mesas/abrir', { cookie: cookieAdminA, method: 'POST', body: { mesa: 3, meseroUsuarioId: ADMIN_B } });
  assert.strictEqual(r4.status, 400, 'un usuario de otro negocio jamás puede ser mesero aquí');
});

// ═══════════ Comanda (C4/C9) ═══════════
let cuentaC = null;
await t('COMANDA', 'comanda inicial lleva SOLO lo pendiente; la adicional SOLO lo nuevo', async () => {
  cuentaC = await abrirMesa(SEED.negocioA, { mesaNumero: 5, personas: 4, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(cuentaC.id, SEED.negocioA, [
    { producto: 'Tacos de carnitas', cantidad: 3, precio_unitario: 25 },
    { producto: 'Refresco', cantidad: 4, precio_unitario: 20, modificadores: ['bien frío'] },
  ], STAFF_A);
  const c1 = await enviarComanda(cuentaC.id, SEED.negocioA, STAFF_A);
  assert.strictEqual(c1.comanda, 1);
  assert.strictEqual(c1.tipo, 'inicial');
  assert.strictEqual(c1.items.length, 2);
  assert.strictEqual(c1.mesa, 5);
  await agregarItems(cuentaC.id, SEED.negocioA, [{ producto: 'Flan', cantidad: 2, precio_unitario: 30 }], STAFF_A);
  const c2 = await enviarComanda(cuentaC.id, SEED.negocioA, STAFF_A);
  assert.strictEqual(c2.comanda, 2);
  assert.strictEqual(c2.tipo, 'adicional');
  assert.strictEqual(c2.items.length, 1, 'la comanda adicional solo lleva lo nuevo -- nunca reimprime lo anterior');
  assert.strictEqual(c2.items[0].producto, 'Flan');
});

await t('COMANDA', 'doble envío concurrente -> una sola comanda, el otro recibe SIN_ITEMS_PENDIENTES', async () => {
  await agregarItems(cuentaC.id, SEED.negocioA, [{ producto: 'Agua', cantidad: 1, precio_unitario: 15 }], STAFF_A);
  const [r1, r2] = await Promise.allSettled([
    enviarComanda(cuentaC.id, SEED.negocioA, STAFF_A),
    enviarComanda(cuentaC.id, SEED.negocioA, STAFF_A),
  ]);
  const ok = [r1, r2].filter(r => r.status === 'fulfilled');
  const fallo = [r1, r2].filter(r => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'exactamente un envío gana');
  assert.strictEqual(fallo[0].reason.code, 'SIN_ITEMS_PENDIENTES');
  const cuenta = await obtenerCuenta(cuentaC.id, SEED.negocioA);
  assert.strictEqual(cuenta.comandasEmitidas, 3, 'nunca se emite una comanda duplicada');
});

// ═══════════ Cancelación auditada ═══════════
await t('CANCELAR', 'staff no cancela (HTTP 403); admin exige motivo; queda auditoría y el total excluye lo cancelado', async () => {
  const cuenta = await obtenerCuenta(cuentaC.id, SEED.negocioA);
  const flan = cuenta.items.find(i => i.producto === 'Flan');
  const rStaff = await api(`/api/restaurante/cuentas/${cuentaC.id}/items/${flan.id}/cancelar`, { cookie: cookieStaffA, method: 'POST', body: { motivo: 'x' } });
  assert.strictEqual(rStaff.status, 403);
  await assert.rejects(() => cancelarItem(flan.id, cuentaC.id, SEED.negocioA, ADMIN_A, ''), e => e.code === 'MOTIVO_REQUERIDO');
  const totalAntes = cuenta.total;
  const item = await cancelarItem(flan.id, cuentaC.id, SEED.negocioA, ADMIN_A, 'cliente lo devolvió');
  assert.strictEqual(item.ya_enviado, true, 'el flan ya había salido en la comanda 2');
  const despues = await obtenerCuenta(cuentaC.id, SEED.negocioA);
  assert.strictEqual(despues.total, totalAntes - 60, '2 flanes de $30 fuera del total');
  const filaCancelada = despues.items.find(i => i.id === flan.id);
  assert.strictEqual(filaCancelada.estado, 'cancelado');
  assert.strictEqual(filaCancelada.motivo_cancelacion, 'cliente lo devolvió');
  assert.ok(filaCancelada.cancelado_por_nombre, 'debe registrar quién canceló');
});

// ═══════════ Pagos y división (C5/C6/C9) ═══════════
await t('PAGOS', 'método no habilitado 400; pago que excede el saldo 409', async () => {
  // transferencia está deshabilitada por defecto (migración 025).
  await assert.rejects(
    () => registrarPago(cuentaC.id, SEED.negocioA, { metodo: 'transferencia', monto: 10 }, ADMIN_A),
    e => e.code === 'METODO_NO_HABILITADO'
  );
  const cuenta = await obtenerCuenta(cuentaC.id, SEED.negocioA);
  await assert.rejects(
    () => registrarPago(cuentaC.id, SEED.negocioA, { metodo: 'efectivo', monto: cuenta.saldo + 100 }, ADMIN_A),
    e => e.code === 'PAGO_EXCEDE_SALDO'
  );
});

await t('PAGOS', 'división por productos y métodos mixtos: 2 refrescos en efectivo, 2 en terminal, resto mixto; saldo llega exacto a 0', async () => {
  // Cuenta: 3 tacos ($75) + 4 refrescos ($80) + agua ($15) = $170 (flan cancelado).
  const c0 = await obtenerCuenta(cuentaC.id, SEED.negocioA);
  assert.strictEqual(c0.total, 170);
  const p1 = await registrarPago(cuentaC.id, SEED.negocioA, { metodo: 'efectivo', monto: 40, cubre: '2 refrescos (persona 1)' }, STAFF_A);
  assert.strictEqual(p1.saldoRestante, 130);
  const p2 = await registrarPago(cuentaC.id, SEED.negocioA, { metodo: 'terminal', monto: 40, propina: 10, cubre: '2 refrescos (persona 2)' }, STAFF_A);
  assert.strictEqual(p2.saldoRestante, 90);
  const p3 = await registrarPago(cuentaC.id, SEED.negocioA, { metodo: 'efectivo', monto: 90, cubre: 'tacos y agua (persona 3)' }, STAFF_A);
  assert.strictEqual(p3.saldoRestante, 0);
  const final = await obtenerCuenta(cuentaC.id, SEED.negocioA);
  assert.strictEqual(final.pagado, 170);
  assert.strictEqual(final.propinas, 10);
  assert.strictEqual(final.pagos.length, 3, 'una sola cuenta, 3 pagos -- nunca pedidos ni productos duplicados');
});

await t('PAGOS', 'partes iguales cierran al centavo (100/3)', async () => {
  const partes = dividirEnPartesIguales(100, 3);
  assert.deepStrictEqual(partes, [33.34, 33.33, 33.33]);
  assert.strictEqual(Math.round(partes.reduce((a, b) => a + b, 0) * 100) / 100, 100);
});

await t('PAGOS', 'dos cajas cobran a la vez el mismo saldo -> exactamente un pago gana', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 7, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Combo', cantidad: 1, precio_unitario: 100 }], ADMIN_A);
  const [r1, r2] = await Promise.allSettled([
    registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 100 }, ADMIN_A),
    registrarPago(cta.id, SEED.negocioA, { metodo: 'terminal', monto: 100 }, STAFF_A),
  ]);
  const ok = [r1, r2].filter(r => r.status === 'fulfilled');
  const fallo = [r1, r2].filter(r => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'el pago repetido nunca duplica el cobro');
  assert.strictEqual(fallo[0].reason.code, 'PAGO_EXCEDE_SALDO');
  const cuenta = await obtenerCuenta(cta.id, SEED.negocioA);
  assert.strictEqual(cuenta.pagado, 100);
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
});

// ═══════════ Cierre, reapertura y movimiento (C2/C9) ═══════════
await t('CIERRE', 'con saldo pendiente 409; en cero cierra, libera la mesa y rechaza pagos posteriores', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 8, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Torta', cantidad: 1, precio_unitario: 50 }], ADMIN_A);
  await assert.rejects(() => cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A), e => e.code === 'SALDO_PENDIENTE');
  await registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 50 }, ADMIN_A);
  const r = await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  assert.strictEqual(r.ok, true);
  const { mesas } = await listarMesas(SEED.negocioA);
  assert.strictEqual(mesas.find(m => m.mesa === 8).ocupada, false, 'la mesa queda libre al cerrar');
  await assert.rejects(
    () => registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 10 }, ADMIN_A),
    e => e.code === 'CUENTA_NO_ABIERTA'
  );
});

await t('MOVER', 'a mesa ocupada 409; a libre ok; reabrir contabilizada bloqueado; reverso choca si la mesa ya fue tomada', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 9, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await assert.rejects(() => moverMesa(cta.id, SEED.negocioA, 5), e => e.code === 'MESA_OCUPADA'); // la 5 sigue abierta (cuentaC)
  const m = await moverMesa(cta.id, SEED.negocioA, 10);
  assert.strictEqual(m.mesa_numero, 10);
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A); // total 0, cierra y CONTABILIZA
  const otra = await abrirMesa(SEED.negocioA, { mesaNumero: 10, personas: 1, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  // Política nueva: una cuenta con venta contabilizada JAMÁS se reabre en
  // silencio -- ni siquiera cuando la mesa está libre. El camino es el
  // reverso explícito de admin.
  await assert.rejects(() => reabrirCuenta(cta.id, SEED.negocioA), e => e.code === 'VENTA_CONTABILIZADA');
  // Y el reverso respeta la mesa ocupada: falla COMPLETO (la venta sigue
  // contabilizada, nada a medias).
  await assert.rejects(() => revertirVentaCuenta(cta.id, SEED.negocioA, ADMIN_A, 'ajuste de prueba'), e => e.code === 'MESA_OCUPADA');
  const sigue = await obtenerCuenta(cta.id, SEED.negocioA);
  assert.strictEqual(sigue.estado, 'cerrada', 'el reverso fallido no deja la cuenta a medias');
  assert.ok(sigue.ventaFolio, 'la venta sigue contabilizada tras el reverso fallido');
  await cerrarCuenta(otra.id, SEED.negocioA, ADMIN_A);
  const rev = await revertirVentaCuenta(cta.id, SEED.negocioA, ADMIN_A, 'ajuste de prueba');
  assert.strictEqual(rev.ok, true);
  const reabierta = await obtenerCuenta(cta.id, SEED.negocioA);
  assert.strictEqual(reabierta.estado, 'abierta');
  assert.strictEqual(reabierta.ventaFolio, null);
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
});

// ═══════════ Concurrencia ampliada (revisión de integración) ═══════════
await t('CONCURRENCIA', 'cierre y pago simultáneos: jamás queda una cuenta cerrada con saldo pendiente', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 12, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Plato', cantidad: 1, precio_unitario: 80 }], ADMIN_A);
  // Pagar y cerrar A LA VEZ: FOR UPDATE serializa. O el pago entra primero
  // (cierre gana después) o el cierre corre primero (falla SALDO_PENDIENTE
  // y el pago entra; se cierra después). Nunca ambas cosas inconsistentes.
  const [rPago, rCierre] = await Promise.allSettled([
    registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 80 }, ADMIN_A),
    cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A),
  ]);
  const cuenta = await obtenerCuenta(cta.id, SEED.negocioA);
  if (cuenta.estado === 'cerrada') {
    assert.strictEqual(cuenta.saldo, 0, 'cerrada implica saldo exactamente cero');
  } else {
    assert.strictEqual(rCierre.status, 'rejected', 'si sigue abierta es porque el cierre perdió la carrera');
    assert.strictEqual(cuenta.pagado, 80);
    await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  }
});

await t('CONCURRENCIA', 'dos cuentas se mueven a la misma mesa libre al mismo tiempo -> exactamente una gana', async () => {
  const a = await abrirMesa(SEED.negocioA, { mesaNumero: 13, personas: 1, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  const b = await abrirMesa(SEED.negocioA, { mesaNumero: 14, personas: 1, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  const [r1, r2] = await Promise.allSettled([
    moverMesa(a.id, SEED.negocioA, 15),
    moverMesa(b.id, SEED.negocioA, 15),
  ]);
  const ok = [r1, r2].filter(r => r.status === 'fulfilled');
  const fallo = [r1, r2].filter(r => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'la mesa 15 solo puede quedar con una cuenta');
  assert.strictEqual(fallo[0].reason.code, 'MESA_OCUPADA');
  await cerrarCuenta(a.id, SEED.negocioA, ADMIN_A);
  await cerrarCuenta(b.id, SEED.negocioA, ADMIN_A);
});

await t('CONCURRENCIA', 'cancelación durante envío de comanda: estados finales consistentes, sin duplicados', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 16, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  const [item] = await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Sopa', cantidad: 1, precio_unitario: 45 }], ADMIN_A);
  await Promise.allSettled([
    enviarComanda(cta.id, SEED.negocioA, ADMIN_A),
    cancelarItem(item.id, cta.id, SEED.negocioA, ADMIN_A, 'cliente se arrepintió'),
  ]);
  const cuenta = await obtenerCuenta(cta.id, SEED.negocioA);
  const fila = cuenta.items.find(i => i.id === item.id);
  assert.strictEqual(fila.estado, 'cancelado', 'la cancelación siempre prevalece (guard estado != cancelado)');
  assert.strictEqual(cuenta.total, 0, 'el item cancelado nunca suma');
  assert.ok(cuenta.comandasEmitidas <= 1, 'a lo sumo una comanda emitida, jamás duplicada');
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
});

await t('CONCURRENCIA', 'reverso concurrente de la misma venta -> exactamente uno gana', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 17, personas: 1, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  // Dos admins revierten a la vez: FOR UPDATE serializa; el segundo ya no
  // encuentra venta contabilizada (SIN_VENTA_QUE_REVERTIR). La cuenta
  // reabre UNA vez y reversos avanza exactamente 1.
  const [r1, r2] = await Promise.allSettled([
    revertirVentaCuenta(cta.id, SEED.negocioA, ADMIN_A, 'reverso concurrente 1'),
    revertirVentaCuenta(cta.id, SEED.negocioA, ADMIN_A, 'reverso concurrente 2'),
  ]);
  const ok = [r1, r2].filter(r => r.status === 'fulfilled');
  const fallo = [r1, r2].filter(r => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'solo un reverso procede');
  assert.strictEqual(fallo[0].reason.code, 'SIN_VENTA_QUE_REVERTIR');
  const cuenta = await obtenerCuenta(cta.id, SEED.negocioA);
  assert.strictEqual(cuenta.estado, 'abierta');
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
});

// ═══════════ Aislamiento multiempresa (C9) ═══════════
await t('AISLAMIENTO', 'dos negocios abren su propia Mesa 1 a la vez; la cuenta de A es invisible e intocable desde B', async () => {
  const ctaB = await abrirMesa(SEED.negocioB, { mesaNumero: 1, personas: 2, meseroUsuarioId: ADMIN_B, abiertaPor: ADMIN_B });
  assert.ok(ctaB.id, 'negocio B abre SU Mesa 1 aunque la Mesa 1 de A esté abierta');
  const cuentaDeA = (await listarMesas(SEED.negocioA)).mesas.find(m => m.mesa === 1);
  assert.strictEqual(cuentaDeA.ocupada, true);
  const rGet = await api(`/api/restaurante/cuentas/${cuentaDeA.cuentaId}`, { cookie: cookieAdminB });
  assert.strictEqual(rGet.status, 404, 'cuenta de A desde sesión de B = inexistente');
  const rPago = await api(`/api/restaurante/cuentas/${cuentaDeA.cuentaId}/pagos`, { cookie: cookieAdminB, method: 'POST', body: { metodo: 'efectivo', monto: 5 } });
  assert.strictEqual(rPago.status, 404);
  await cerrarCuenta(ctaB.id, SEED.negocioB, ADMIN_B);
});

await t('AISLAMIENTO', 'módulo restaurante apagado -> 403 en todas las rutas', async () => {
  await fijarModulo(SEED.negocioB, 'restaurante', 'no_configurado');
  const r = await api('/api/restaurante/mesas', { cookie: cookieAdminB });
  assert.strictEqual(r.status, 403);
  await fijarModulo(SEED.negocioB, 'restaurante', 'activo');
});

// ═══════════ Integración contable: cierre -> venta consolidada (fase caja/reportes) ═══════════
const VENTANA = () => [new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 60e3).toISOString()];
const folioEsperado = (cuentaId, reversos = 0) => `RM-${String(cuentaId).replace(/-/g, '').slice(0, 8).toUpperCase()}-${reversos}`;

await t('CONTABLE', 'migración 040: columnas venta_folio/contabilizada_at/reversos e índice único presentes', async () => {
  const cols = await pool.query(`SELECT count(*)::int AS c FROM information_schema.columns
    WHERE table_name='restaurante_cuentas' AND column_name IN ('venta_folio','contabilizada_at','reversos')`);
  assert.strictEqual(cols.rows[0].c, 3);
  const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_restaurante_venta_folio'`);
  assert.strictEqual(idx.rows.length, 1);
});

let ctaV = null;
await t('CONTABLE', 'cerrar genera EXACTAMENTE UNA venta consolidada: total recalculado, mixto por método, propina separada', async () => {
  const [desde, hasta] = VENTANA();
  const resumenAntes = await obtenerResumenVentas(desde, hasta, SEED.negocioA);
  ctaV = await abrirMesa(SEED.negocioA, { mesaNumero: 21, personas: 3, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(ctaV.id, SEED.negocioA, [
    { producto: 'Parrillada', cantidad: 1, precio_unitario: 60 },
    { producto: 'Limonada', cantidad: 2, precio_unitario: 20 },
  ], STAFF_A);
  await enviarComanda(ctaV.id, SEED.negocioA, STAFF_A);          // comanda inicial: NO es venta
  await agregarItems(ctaV.id, SEED.negocioA, [{ producto: 'Café', cantidad: 1, precio_unitario: 0 }], STAFF_A);
  await enviarComanda(ctaV.id, SEED.negocioA, STAFF_A);          // comanda adicional: tampoco
  // Antes del cierre: NINGUNA fila de venta para esta cuenta.
  const antes = await pool.query(`SELECT count(*)::int AS c FROM pedidos_activos WHERE datos->>'cuenta_id' = $1`, [ctaV.id]);
  assert.strictEqual(antes.rows[0].c, 0, 'ni la comanda inicial ni la adicional crean ventas');
  await registrarPago(ctaV.id, SEED.negocioA, { metodo: 'efectivo', monto: 60 }, STAFF_A);
  await registrarPago(ctaV.id, SEED.negocioA, { metodo: 'terminal', monto: 40, propina: 15 }, STAFF_A);
  const r = await cerrarCuenta(ctaV.id, SEED.negocioA, STAFF_A);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.yaCerrada, undefined);
  assert.strictEqual(r.ventaFolio, folioEsperado(ctaV.id, 0));
  assert.strictEqual(r.total, 100, 'total recalculado en servidor (60+40), la propina NO suma');
  assert.strictEqual(r.propinas, 15);
  // Exactamente UNA fila de venta, estado entregado, del negocio A.
  const filas = await pool.query(`SELECT folio, estado, negocio_id, datos, entregado_at FROM pedidos_activos WHERE datos->>'cuenta_id' = $1`, [ctaV.id]);
  assert.strictEqual(filas.rows.length, 1, 'una cuenta cerrada = exactamente una venta');
  const fila = filas.rows[0];
  assert.strictEqual(fila.folio, r.ventaFolio);
  assert.strictEqual(fila.estado, 'entregado');
  assert.strictEqual(fila.negocio_id, SEED.negocioA);
  assert.ok(fila.entregado_at, 'nace entregada: jamás entra al tablero de comandas ni dispara cocina');
  assert.strictEqual(fila.datos.origen, 'restaurante');
  assert.strictEqual(fila.datos.canal, 'restaurante_mesa');
  assert.strictEqual(fila.datos.modalidad, 'mesa');
  assert.strictEqual(fila.datos.forma_pago, 'mixto', 'dos métodos distintos = mixto');
  assert.deepStrictEqual(fila.datos.pagos, [
    { metodo: 'efectivo', monto: 60, propina: 0 },
    { metodo: 'terminal', monto: 40, propina: 15 },
  ], 'cada método conserva su monto y su propina');
  assert.strictEqual(fila.datos.total, 100);
  assert.strictEqual(fila.datos.propinas, 15);
  assert.strictEqual(fila.datos.items.length, 3);
  // Y el RESUMEN de ventas sube exactamente una venta / $100.
  const resumenDespues = await obtenerResumenVentas(desde, hasta, SEED.negocioA);
  assert.strictEqual(resumenDespues.num_pedidos - resumenAntes.num_pedidos, 1);
  assert.strictEqual(Math.round((resumenDespues.total_ventas - resumenAntes.total_ventas) * 100) / 100, 100);
});

await t('CONTABLE', 'HTTP /api/ventas muestra la venta UNA vez con origen restaurante; la cuenta expone ventaFolio', async () => {
  const [desde, hasta] = VENTANA();
  const rV = await api(`/api/ventas?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`, { cookie: cookieAdminA });
  assert.strictEqual(rV.status, 200);
  const deEsta = rV.body.filter(v => v.folio === folioEsperado(ctaV.id, 0));
  assert.strictEqual(deEsta.length, 1, 'la venta consolidada aparece exactamente una vez en /api/ventas');
  assert.strictEqual(Number(deEsta[0].total), 100);
  assert.strictEqual(deEsta[0].canal, 'restaurante_mesa');
  assert.strictEqual(deEsta[0].modalidad, 'mesa');
  assert.strictEqual(deEsta[0].forma_pago, 'mixto');
  const rC = await api(`/api/restaurante/cuentas/${ctaV.id}`, { cookie: cookieAdminA });
  assert.strictEqual(rC.body.ventaFolio, folioEsperado(ctaV.id, 0));
  assert.ok(rC.body.contabilizadaAt, 'la cuenta expone cuándo se contabilizó');
});

await t('CONTABLE', 'doble cierre concurrente -> UNA venta; reintento posterior responde idempotente con el mismo folio', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 22, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Molcajete', cantidad: 1, precio_unitario: 250 }], ADMIN_A);
  await registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 250 }, ADMIN_A);
  const [r1, r2] = await Promise.allSettled([
    cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A),
    cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A),
  ]);
  assert.strictEqual(r1.status, 'fulfilled');
  assert.strictEqual(r2.status, 'fulfilled');
  const normales = [r1.value, r2.value].filter(v => !v.yaCerrada);
  const idempotentes = [r1.value, r2.value].filter(v => v.yaCerrada);
  assert.strictEqual(normales.length, 1, 'exactamente un cierre real');
  assert.strictEqual(idempotentes.length, 1, 'el perdedor responde yaCerrada, nunca error ni doble venta');
  assert.strictEqual(idempotentes[0].ventaFolio, normales[0].ventaFolio);
  const filas = await pool.query(`SELECT count(*)::int AS c FROM pedidos_activos WHERE datos->>'cuenta_id' = $1`, [cta.id]);
  assert.strictEqual(filas.rows[0].c, 1);
  // Reintento tardío (respuesta HTTP perdida): mismo folio, sigue una sola venta.
  const r3 = await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  assert.strictEqual(r3.yaCerrada, true);
  assert.strictEqual(r3.ventaFolio, normales[0].ventaFolio);
  const filas2 = await pool.query(`SELECT count(*)::int AS c FROM pedidos_activos WHERE datos->>'cuenta_id' = $1`, [cta.id]);
  assert.strictEqual(filas2.rows[0].c, 1);
});

await t('CONTABLE', 'ventana de fallo: venta ya insertada pero cuenta sin marcar -> el reintento NO duplica (ON CONFLICT)', async () => {
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 23, personas: 1, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Tostada', cantidad: 1, precio_unitario: 35 }], ADMIN_A);
  await registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 35 }, ADMIN_A);
  // Simula el crash: la fila de venta existe con el folio determinista, pero
  // la cuenta quedó abierta (transacción anterior rota a medias en el peor
  // escenario hipotético). El folio es determinista, así que el reintento
  // aterriza en la MISMA fila.
  const folio = folioEsperado(cta.id, 0);
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, entregado_at)
     VALUES ($1, 'entregado', $2, $3, NOW())`,
    [folio, JSON.stringify({ id: folio, origen: 'restaurante', cuenta_id: cta.id, total: 35, estado: 'entregado' }), SEED.negocioA]
  );
  const r = await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ventaFolio, folio);
  const filas = await pool.query(`SELECT count(*)::int AS c FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.strictEqual(filas.rows[0].c, 1, 'jamás una segunda fila con el mismo folio');
});

await t('CONTABLE', 'reverso admin: venta cancelada con motivo auditado, cuenta reabre y el re-cierre genera folio NUEVO', async () => {
  const [desde, hasta] = VENTANA();
  const cta = await abrirMesa(SEED.negocioA, { mesaNumero: 24, personas: 2, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  await agregarItems(cta.id, SEED.negocioA, [{ producto: 'Fajitas', cantidad: 1, precio_unitario: 120 }], ADMIN_A);
  await registrarPago(cta.id, SEED.negocioA, { metodo: 'efectivo', monto: 120 }, ADMIN_A);
  await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  const folio0 = folioEsperado(cta.id, 0);
  // Sin motivo: rechazado.
  await assert.rejects(() => revertirVentaCuenta(cta.id, SEED.negocioA, ADMIN_A, '  '), e => e.code === 'MOTIVO_REQUERIDO');
  const rev = await revertirVentaCuenta(cta.id, SEED.negocioA, ADMIN_A, 'se cobró de más');
  assert.strictEqual(rev.ok, true);
  assert.strictEqual(rev.ventaRevertida, folio0);
  assert.strictEqual(rev.ventaCancelada, true);
  // La venta original queda CANCELADA con auditoría -- historial intacto, fuera de reportes.
  const { rows: [vieja] } = await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1`, [folio0]);
  assert.strictEqual(vieja.estado, 'cancelado');
  assert.strictEqual(vieja.datos.cancelacion.motivo, 'se cobró de más');
  assert.ok(vieja.datos.cancelacion.por, 'quién revirtió queda auditado');
  const ventas = await obtenerVentas(desde, hasta, SEED.negocioA);
  assert.strictEqual(ventas.filter(v => v.folio === folio0).length, 0, 'la venta revertida ya no cuenta en reportes');
  // Los pagos NUNCA se borran.
  const cuenta = await obtenerCuenta(cta.id, SEED.negocioA);
  assert.strictEqual(cuenta.estado, 'abierta');
  assert.strictEqual(cuenta.pagos.length, 1);
  // Re-cierre: folio NUEVO (reversos=1), y las ventas netas de la cuenta son UNA.
  const r2 = await cerrarCuenta(cta.id, SEED.negocioA, ADMIN_A);
  assert.strictEqual(r2.ventaFolio, folioEsperado(cta.id, 1));
  const ventas2 = await obtenerVentas(desde, hasta, SEED.negocioA);
  assert.strictEqual(ventas2.filter(v => v.folio === r2.ventaFolio).length, 1);
  assert.strictEqual(ventas2.filter(v => v.folio === folio0).length, 0);
});

await t('CONTABLE', 'permisos HTTP: staff no revierte (403); reabrir contabilizada responde 409 VENTA_CONTABILIZADA; sin venta que revertir 409', async () => {
  const rStaff = await api(`/api/restaurante/cuentas/${ctaV.id}/revertir-venta`, { cookie: cookieStaffA, method: 'POST', body: { motivo: 'x' } });
  assert.strictEqual(rStaff.status, 403, 'el reverso es exclusivo de admin');
  const rReabrir = await api(`/api/restaurante/cuentas/${ctaV.id}/reabrir`, { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(rReabrir.status, 409);
  assert.strictEqual(rReabrir.body.code, 'VENTA_CONTABILIZADA');
  const abierta = await abrirMesa(SEED.negocioA, { mesaNumero: 25, personas: 1, meseroUsuarioId: ADMIN_A, abiertaPor: ADMIN_A });
  const rSin = await api(`/api/restaurante/cuentas/${abierta.id}/revertir-venta`, { cookie: cookieAdminA, method: 'POST', body: { motivo: 'x' } });
  assert.strictEqual(rSin.status, 409);
  assert.strictEqual(rSin.body.code, 'SIN_VENTA_QUE_REVERTIR');
  await cerrarCuenta(abierta.id, SEED.negocioA, ADMIN_A);
});

await t('CONTABLE', 'las ventas RM- jamás entran al tablero de comandas ni rompen el contador XAB-', async () => {
  const activos = await obtenerPedidosActivos();
  assert.strictEqual(activos.filter(p => String(p.id || '').startsWith('RM-')).length, 0,
    'ni las entregadas ni las canceladas por reverso aparecen como pedidos operables');
  // El contador de folios XAB ignora los RM- (un CAST roto lo resetearía a 0
  // y provocaría colisiones de folio tras un reinicio).
  const { obtenerMaxFolioNum } = await import('../src/services/database.js');
  const n = await obtenerMaxFolioNum();
  assert.ok(Number.isInteger(n) && n >= 0, `max folio XAB debe seguir siendo numérico (obtuvo ${n})`);
});

await t('CONTABLE', 'aislamiento multiempresa: las ventas RM- de A no existen para B', async () => {
  const [desde, hasta] = VENTANA();
  const ventasB = await obtenerVentas(desde, hasta, SEED.negocioB);
  assert.strictEqual(ventasB.filter(v => v.folio === folioEsperado(ctaV.id, 0)).length, 0);
  const rRev = await api(`/api/restaurante/cuentas/${ctaV.id}/revertir-venta`, { cookie: cookieAdminB, method: 'POST', body: { motivo: 'x' } });
  assert.strictEqual(rRev.status, 404, 'cuenta de A desde sesión de B = inexistente, también para el reverso');
});

// ═══════════ Indicadores (C10) ═══════════
await t('INDICADORES', 'expone modulo/mesas/meseros/pagos/prueba para el onboarding', async () => {
  const ind = await indicadoresRestaurante(SEED.negocioA);
  assert.strictEqual(ind.modulo_mesas_activo, true);
  assert.strictEqual(ind.meseros_configurados, true);
  assert.strictEqual(ind.pagos_listos, true);
  assert.strictEqual(ind.prueba_mesa_completada, true, 'ya se cerró al menos una cuenta en esta suite');
  assert.strictEqual(ind.impresion_revisada, null, 'confirmación manual del checklist, no derivable');
  const rHttp = await api('/api/restaurante/indicadores', { cookie: cookieAdminA });
  assert.strictEqual(rHttp.status, 200);
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await srv.detener();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
