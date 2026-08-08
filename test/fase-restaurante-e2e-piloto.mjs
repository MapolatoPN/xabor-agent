// Restaurante / Mesas / Meseros — recorrido de punta a punta del piloto,
// con tenant propio ("Restaurante Prueba Final") y por las rutas HTTP
// reales: es el camino exacto que hará el operador, desde la activación en
// Superadmin hasta la venta RM- en Caja.
//
// Cubre el checklist de cierre: módulo apagado → 403; activar; 5 mesas;
// abrir mesa; mesero; dos rondas; cuenta acumulada; mover mesa; dividir;
// pagos; propina; ticket final; cierre; venta RM-; Caja/Reportes; reapertura
// y reverso por rol; historial preservado. Más aislamiento multi-tenant
// contra un segundo negocio.
//
// NO toca negocios reales: crea y limpia sus propios tenants.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4947';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// ── Tenants propios, re-ejecutables ───────────────────────────────────────
const SLUG_A = 'restaurante-prueba-final';
const SLUG_B = 'restaurante-prueba-b';
async function limpiarTenants() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug IN ($1,$2)`, [SLUG_A, SLUG_B]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  await pool.query(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM usuarios WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM negocios WHERE id = ANY($1)`, [ids]);
}
await limpiarTenants();

async function crearTenant(nombre, slug) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id`, [nombre, slug]);
  const mk = async (rol, etiqueta) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
      [n.id, etiqueta, `${slug}-${rol}-${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.local`]);
    await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, n.id, rol]);
    return u.id;
  };
  const admin = await mk('admin', `Administrador ${nombre}`);
  const mesero = await mk('staff', `Mesero ${nombre}`);
  for (const [tipo, hab, orden] of [['efectivo', true, 0], ['terminal', true, 1], ['transferencia', false, 2]]) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,$3,$4)
      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`, [n.id, tipo, hab, orden]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Cocina',TRUE,0) RETURNING id`, [n.id]);
  const productos = {};
  for (const [clave, pnombre, precio] of [['A', 'Producto de prueba A', 120], ['B', 'Producto de prueba B', 45]]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
       VALUES ($1,$2,$3,$4,'',$5,TRUE,0) RETURNING id, nombre, precio`, [n.id, cat.id, `PF${clave}${Math.floor(Math.random() * 1e6).toString(36)}`, pnombre, precio]);
    productos[clave] = { id: p.id, nombre: p.nombre, precio: Number(p.precio) };
  }
  return { id: n.id, admin, mesero, productos };
}

const A = await crearTenant('Restaurante Prueba Final', SLUG_A);
const B = await crearTenant('Restaurante Prueba B', SLUG_B);
// 'pos' habilitado en ambos: /api/ventas (Caja/Reportes) vive detrás de ese
// módulo, igual que en producción.
for (const n of [A, B]) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n.id]);
}

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const ck = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const superadmin = ck(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const adminA = ck(A.admin, A.id, 'admin');
const meseroA = ck(A.mesero, A.id, 'staff');
const adminB = ck(B.admin, B.id, 'admin');

// ═════════ 1) Módulo apagado → fail-closed ═════════
await t('ACTIVACION', '1. sin contratar el módulo, toda la operación de mesas responde 403', async () => {
  for (const [m, p] of [['GET', '/api/restaurante/mesas'], ['POST', '/api/restaurante/mesas/abrir'], ['GET', '/api/restaurante/indicadores']]) {
    const r = await api(base, p, { cookie: adminA, method: m, body: m === 'POST' ? { mesa: 1 } : undefined });
    assert.strictEqual(r.status, 403, `${p} debía dar 403 con el módulo sin contratar, dio ${r.status}`);
  }
});

// ═════════ 2-3) Activar y configurar mesas desde Superadmin (sin SQL) ═════════
await t('ACTIVACION', '2. Superadmin ve Restaurante en la fuente única y lo activa con el selector existente', async () => {
  const lista = await api(base, '/api/superadmin/modulos-disponibles', { cookie: superadmin });
  assert.strictEqual(lista.status, 200);
  assert.ok(lista.body.modulos.some(m => m.clave === 'restaurante' && m.nombre === 'Restaurante (mesas y meseros)'));
  const r = await api(base, `/api/superadmin/negocios/${A.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { restaurante: 'activo' } } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: adminA });
  assert.strictEqual(mesas.status, 200, 'con el módulo activo la operación abre');
});
await t('ACTIVACION', '3. número de mesas = 5 desde Superadmin, sin SQL y sin tabla de mesas', async () => {
  const malo = await api(base, `/api/superadmin/negocios/${A.id}/restaurante-config`, { cookie: superadmin, method: 'PUT', body: { numMesas: 0 } });
  assert.strictEqual(malo.status, 400, '0 fuera de rango');
  const ok = await api(base, `/api/superadmin/negocios/${A.id}/restaurante-config`, { cookie: superadmin, method: 'PUT', body: { numMesas: 5 } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const { rows } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='restaurante_num_mesas'`, [A.id]);
  assert.strictEqual(rows.length, 1, 'se guarda como configuración, no como tabla nueva');
});
await t('ACTIVACION', '4. el negocio ve exactamente 5 mesas, todas libres', async () => {
  const r = await api(base, '/api/restaurante/mesas', { cookie: meseroA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mesas.length, 5);
  assert.ok(r.body.mesas.every(m => m.ocupada === false));
});

// ═════════ 5-12) Operación de la mesa ═════════
let cuentaId = null;
await t('OPERACION', '5-6. el mesero abre la Mesa 1 y queda asignado a la cuenta', async () => {
  const r = await api(base, '/api/restaurante/mesas/abrir', { cookie: meseroA, method: 'POST', body: { mesa: 1, personas: 3 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  cuentaId = r.body.cuenta.id;
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: meseroA });
  assert.strictEqual(c.body.mesa, 1);
  assert.strictEqual(c.body.personas, 3);
  assert.ok(c.body.mesero?.nombre?.includes('Mesero'), 'el que abre queda como mesero');
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: meseroA });
  assert.strictEqual(mesas.body.mesas.find(m => m.mesa === 1).ocupada, true);
});
await t('OPERACION', '7-9. dos productos del menú y primera ronda: la comanda inicial lleva solo lo pendiente', async () => {
  const r = await api(base, `/api/restaurante/cuentas/${cuentaId}/items`, { cookie: meseroA, method: 'POST', body: { items: [
    { producto: A.productos.A.nombre, cantidad: 2, precio_unitario: A.productos.A.precio },
    { producto: A.productos.B.nombre, cantidad: 3, precio_unitario: A.productos.B.precio, modificadores: ['sin hielo'] },
  ] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const c1 = await api(base, `/api/restaurante/cuentas/${cuentaId}/comanda`, { cookie: meseroA, method: 'POST' });
  assert.strictEqual(c1.status, 200);
  assert.strictEqual(c1.body.comanda, 1);
  assert.strictEqual(c1.body.tipo, 'inicial');
  assert.strictEqual(c1.body.items.length, 2);
  assert.strictEqual(c1.body.mesa, 1);
});
await t('OPERACION', '10-12. segundo consumo, segunda ronda solo con lo nuevo y cuenta acumulada correcta', async () => {
  await api(base, `/api/restaurante/cuentas/${cuentaId}/items`, { cookie: meseroA, method: 'POST', body: { items: [
    { producto: A.productos.B.nombre, cantidad: 1, precio_unitario: A.productos.B.precio },
  ] } });
  const c2 = await api(base, `/api/restaurante/cuentas/${cuentaId}/comanda`, { cookie: meseroA, method: 'POST' });
  assert.strictEqual(c2.body.comanda, 2);
  assert.strictEqual(c2.body.tipo, 'adicional');
  assert.strictEqual(c2.body.items.length, 1, 'la ronda adicional nunca reimprime lo anterior');
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: meseroA });
  // 2 x 120 + 4 x 45 = 420
  assert.strictEqual(c.body.total, 420);
  assert.strictEqual(c.body.saldo, 420);
  assert.strictEqual(c.body.comandasEmitidas, 2);
});

// ═════════ 13) Mover mesa ═════════
await t('OPERACION', '13. mover la cuenta a la Mesa 4 libera la 1 y conserva items y comandas', async () => {
  const r = await api(base, `/api/restaurante/cuentas/${cuentaId}/mover`, { cookie: meseroA, method: 'POST', body: { mesa: 4 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: meseroA });
  assert.strictEqual(c.body.mesa, 4);
  assert.strictEqual(c.body.total, 420, 'mover no altera el consumo');
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: meseroA });
  assert.strictEqual(mesas.body.mesas.find(m => m.mesa === 1).ocupada, false);
  assert.strictEqual(mesas.body.mesas.find(m => m.mesa === 4).ocupada, true);
});

// ═════════ 14-16) Dividir, pagar y propina ═════════
await t('CUENTA', '14. dividir en 3 partes iguales cierra exacto al centavo', async () => {
  const r = await api(base, `/api/restaurante/cuentas/${cuentaId}/dividir?partes=3`, { cookie: meseroA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.partes.length, 3);
  assert.strictEqual(Math.round(r.body.partes.reduce((a, b) => a + b, 0) * 100) / 100, 420);
});
await t('CUENTA', '15-16. tres cobros (efectivo/terminal) con propina: saldo a 0 y propinas acumuladas aparte', async () => {
  const p1 = await api(base, `/api/restaurante/cuentas/${cuentaId}/pagos`, { cookie: meseroA, method: 'POST', body: { metodo: 'efectivo', monto: 140, cubre: 'persona 1' } });
  assert.strictEqual(p1.status, 200, JSON.stringify(p1.body));
  assert.strictEqual(p1.body.saldoRestante, 280);
  const p2 = await api(base, `/api/restaurante/cuentas/${cuentaId}/pagos`, { cookie: meseroA, method: 'POST', body: { metodo: 'terminal', monto: 140, propina: 25, cubre: 'persona 2' } });
  assert.strictEqual(p2.body.saldoRestante, 140);
  const p3 = await api(base, `/api/restaurante/cuentas/${cuentaId}/pagos`, { cookie: adminA, method: 'POST', body: { metodo: 'efectivo', monto: 140, propina: 15, cubre: 'persona 3' } });
  assert.strictEqual(p3.body.saldoRestante, 0);
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: adminA });
  assert.strictEqual(c.body.pagado, 420);
  assert.strictEqual(c.body.propinas, 40, 'la propina nunca se suma al consumo');
  assert.strictEqual(c.body.saldo, 0);
  assert.strictEqual(c.body.pagos.length, 3);
});
await t('CUENTA', 'un método no habilitado se rechaza y un cobro que excede el saldo también', async () => {
  const cta = await api(base, '/api/restaurante/mesas/abrir', { cookie: meseroA, method: 'POST', body: { mesa: 5, personas: 1 } });
  const id = cta.body.cuenta.id;
  await api(base, `/api/restaurante/cuentas/${id}/items`, { cookie: meseroA, method: 'POST', body: { items: [{ producto: A.productos.B.nombre, cantidad: 1, precio_unitario: 45 }] } });
  const malo = await api(base, `/api/restaurante/cuentas/${id}/pagos`, { cookie: meseroA, method: 'POST', body: { metodo: 'transferencia', monto: 45 } });
  assert.strictEqual(malo.status, 400);
  const exceso = await api(base, `/api/restaurante/cuentas/${id}/pagos`, { cookie: meseroA, method: 'POST', body: { metodo: 'efectivo', monto: 500 } });
  assert.strictEqual(exceso.status, 409);
  await api(base, `/api/restaurante/cuentas/${id}/pagos`, { cookie: meseroA, method: 'POST', body: { metodo: 'efectivo', monto: 45 } });
  await api(base, `/api/restaurante/cuentas/${id}/cerrar`, { cookie: adminA, method: 'POST' });
});

// ═════════ 17-20) Ticket final, cierre, venta RM- y Caja ═════════
let ventaFolio = null;
await t('CIERRE', '17-19. cerrar emite ticket final una sola vez y genera la venta RM- con su folio', async () => {
  const r = await api(base, `/api/restaurante/cuentas/${cuentaId}/cerrar`, { cookie: adminA, method: 'POST' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  ventaFolio = r.body.ventaFolio;
  assert.match(ventaFolio, /^RM-/, 'la venta de restaurante usa folio determinista RM-');
  assert.strictEqual(r.body.total, 420);
  assert.strictEqual(r.body.propinas, 40);
  const repetido = await api(base, `/api/restaurante/cuentas/${cuentaId}/cerrar`, { cookie: adminA, method: 'POST' });
  assert.strictEqual(repetido.body.yaCerrada, true, 'cerrar dos veces no reimprime ni duplica la venta');
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: meseroA });
  assert.strictEqual(mesas.body.mesas.find(m => m.mesa === 4).ocupada, false, 'la mesa queda libre');
});
await t('CIERRE', '20. la venta aparece en Caja/Reportes con su total y su propina, y una sola fila', async () => {
  const { rows } = await pool.query(`SELECT negocio_id, estado, datos FROM pedidos_activos WHERE folio = $1`, [ventaFolio]);
  assert.strictEqual(rows.length, 1, 'una sola venta por cuenta (folio determinista + ON CONFLICT)');
  assert.strictEqual(rows[0].negocio_id, A.id);
  assert.strictEqual(rows[0].estado, 'entregado');
  assert.strictEqual(Number(rows[0].datos.total), 420);
  assert.strictEqual(Number(rows[0].datos.propinas), 40);
  assert.strictEqual(rows[0].datos.origen, 'restaurante');
  const ventas = await api(base, '/api/ventas', { cookie: adminA });
  assert.strictEqual(ventas.status, 200);
  const txt = JSON.stringify(ventas.body);
  assert.ok(txt.includes(ventaFolio), 'la venta RM- es visible en Caja/Reportes del negocio');
});

// ═════════ 21-23) Reapertura, reverso y historial ═════════
await t('REVERSO', '21. reabrir una venta ya contabilizada exige el reverso (no el atajo) y solo admin', async () => {
  const staff = await api(base, `/api/restaurante/cuentas/${cuentaId}/reabrir`, { cookie: meseroA, method: 'POST' });
  assert.strictEqual(staff.status, 403, 'un mesero nunca reabre');
  const directo = await api(base, `/api/restaurante/cuentas/${cuentaId}/reabrir`, { cookie: adminA, method: 'POST' });
  assert.strictEqual(directo.status, 409, 'con venta contabilizada, reabrir directo se rechaza');
});
await t('REVERSO', '22. el reverso exige motivo, cancela la venta en reportes y reabre la cuenta', async () => {
  const sinMotivo = await api(base, `/api/restaurante/cuentas/${cuentaId}/revertir-venta`, { cookie: adminA, method: 'POST', body: {} });
  assert.strictEqual(sinMotivo.status, 400, 'motivo obligatorio');
  const staff = await api(base, `/api/restaurante/cuentas/${cuentaId}/revertir-venta`, { cookie: meseroA, method: 'POST', body: { motivo: 'x' } });
  assert.strictEqual(staff.status, 403, 'solo admin revierte');
  const r = await api(base, `/api/restaurante/cuentas/${cuentaId}/revertir-venta`, { cookie: adminA, method: 'POST', body: { motivo: 'cobro duplicado en terminal' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const { rows } = await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1`, [ventaFolio]);
  assert.strictEqual(rows[0].estado, 'cancelado', 'la venta queda cancelada, NO borrada');
  assert.ok(rows[0].datos.cancelacion, 'queda auditoría del reverso');
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: adminA });
  assert.strictEqual(c.body.estado, 'abierta', 'la cuenta vuelve a estar abierta');
});
await t('REVERSO', '23. el historial se preserva: items, comandas y pagos siguen ahí, y el re-cierre usa folio nuevo', async () => {
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: adminA });
  assert.strictEqual(c.body.total, 420, 'el consumo no se perdió');
  assert.strictEqual(c.body.pagos.length, 3, 'los pagos siguen registrados');
  assert.strictEqual(c.body.comandasEmitidas, 2, 'las comandas emitidas se conservan');
  const recierre = await api(base, `/api/restaurante/cuentas/${cuentaId}/cerrar`, { cookie: adminA, method: 'POST' });
  assert.strictEqual(recierre.status, 200);
  assert.notStrictEqual(recierre.body.ventaFolio, ventaFolio, 'el re-cierre genera folio nuevo, no reutiliza el revertido');
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE 'RM-%' AND estado <> 'cancelado'`, [A.id]);
  assert.ok(rows[0].c >= 1, 'la venta vigente vuelve a estar en reportes');
});

// ═════════ Multi-tenant ═════════
await t('MULTITENANT', 'B con el módulo apagado: toda la operación de restaurante responde 403 (fail-closed)', async () => {
  for (const [m, p] of [['GET', '/api/restaurante/mesas'], ['POST', '/api/restaurante/mesas/abrir'], ['GET', '/api/restaurante/indicadores']]) {
    const r = await api(base, p, { cookie: adminB, method: m, body: m === 'POST' ? { mesa: 1 } : undefined });
    assert.strictEqual(r.status, 403);
  }
});
await t('MULTITENANT', 'con B activo: no ve las mesas ocupadas de A ni puede leer, pagar, cerrar o reabrir su cuenta', async () => {
  await api(base, `/api/superadmin/negocios/${B.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { restaurante: 'activo' } } });
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: adminB });
  assert.strictEqual(mesas.status, 200);
  assert.ok(mesas.body.mesas.every(m => m.ocupada === false), 'B arranca con todas sus mesas libres');
  assert.strictEqual(mesas.body.mesas.length, 12, 'B sin configurar usa el default de 12 mesas');

  const leer = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: adminB });
  assert.strictEqual(leer.status, 404, 'una cuenta ajena no existe para B');
  const items = await api(base, `/api/restaurante/cuentas/${cuentaId}/items`, { cookie: adminB, method: 'POST', body: { items: [{ producto: 'X', cantidad: 1, precio_unitario: 10 }] } });
  assert.ok([403, 404].includes(items.status), `B no agrega consumo a una cuenta de A (dio ${items.status})`);
  const pago = await api(base, `/api/restaurante/cuentas/${cuentaId}/pagos`, { cookie: adminB, method: 'POST', body: { metodo: 'efectivo', monto: 10 } });
  assert.ok([403, 404].includes(pago.status));
  const cerrar = await api(base, `/api/restaurante/cuentas/${cuentaId}/cerrar`, { cookie: adminB, method: 'POST' });
  assert.ok([403, 404].includes(cerrar.status));
  const reabrir = await api(base, `/api/restaurante/cuentas/${cuentaId}/reabrir`, { cookie: adminB, method: 'POST' });
  assert.ok([403, 404].includes(reabrir.status));
});
await t('MULTITENANT', 'B no puede usar al mesero de A ni ver las ventas RM- de A', async () => {
  const abrir = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminB, method: 'POST', body: { mesa: 2, personas: 2, meseroUsuarioId: A.mesero } });
  assert.strictEqual(abrir.status, 400, 'un usuario de otro negocio jamás puede ser mesero aquí');
  const ventas = await api(base, '/api/ventas', { cookie: adminB });
  assert.strictEqual(ventas.status, 200);
  assert.ok(!JSON.stringify(ventas.body).includes(ventaFolio), 'las ventas de A no aparecen en la caja de B');
});

// ═════════ Desactivación segura del módulo ═════════
let cuentaAbiertaId = null;
await t('DESACTIVAR', 'con una mesa abierta, apagar Restaurante responde 409 y no cambia nada', async () => {
  const cta = await api(base, '/api/restaurante/mesas/abrir', { cookie: meseroA, method: 'POST', body: { mesa: 2, personas: 2 } });
  assert.strictEqual(cta.status, 201, JSON.stringify(cta.body));
  cuentaAbiertaId = cta.body.cuenta.id;
  await api(base, `/api/restaurante/cuentas/${cuentaAbiertaId}/items`, { cookie: meseroA, method: 'POST', body: { items: [
    { producto: A.productos.A.nombre, cantidad: 1, precio_unitario: A.productos.A.precio },
  ] } });
  await api(base, `/api/restaurante/cuentas/${cuentaAbiertaId}/pagos`, { cookie: meseroA, method: 'POST', body: { metodo: 'efectivo', monto: 20, cubre: 'anticipo' } });

  for (const estado of ['no_contratado', 'suspendido']) {
    const r = await api(base, `/api/superadmin/negocios/${A.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { restaurante: estado } } });
    assert.strictEqual(r.status, 409, `apagar a ${estado} con mesas abiertas debe dar 409, dio ${r.status}`);
    assert.match(r.body.error, /cuenta\(s\) abiertas\. Cierra las mesas antes de desactivar Restaurante/);
    assert.strictEqual(r.body.codigo, 'RESTAURANTE_CON_CUENTAS_ABIERTAS');
  }
  const { rows } = await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='restaurante'`, [A.id]);
  assert.strictEqual(rows[0].estado, 'activo', 'el módulo NO cambió de estado');
  const c = await api(base, `/api/restaurante/cuentas/${cuentaAbiertaId}`, { cookie: adminA });
  assert.strictEqual(c.status, 200, 'la operación sigue funcionando');
  assert.strictEqual(c.body.estado, 'abierta', 'la cuenta sigue abierta: nadie la cerró ni la borró');
  assert.strictEqual(c.body.total, A.productos.A.precio, 'el consumo queda intacto');
  assert.strictEqual(c.body.pagado, 20, 'el pago queda intacto');
});
await t('DESACTIVAR', 'al cerrar la cuenta sí se puede desactivar, y el historial se conserva', async () => {
  const saldo = (await api(base, `/api/restaurante/cuentas/${cuentaAbiertaId}`, { cookie: adminA })).body.saldo;
  await api(base, `/api/restaurante/cuentas/${cuentaAbiertaId}/pagos`, { cookie: adminA, method: 'POST', body: { metodo: 'efectivo', monto: saldo } });
  const cierre = await api(base, `/api/restaurante/cuentas/${cuentaAbiertaId}/cerrar`, { cookie: adminA, method: 'POST' });
  assert.strictEqual(cierre.status, 200, JSON.stringify(cierre.body));

  const r = await api(base, `/api/superadmin/negocios/${A.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { restaurante: 'no_contratado' } } });
  assert.strictEqual(r.status, 200, 'sin cuentas abiertas, desactivar es normal');
  const bloqueado = await api(base, '/api/restaurante/mesas', { cookie: adminA });
  assert.strictEqual(bloqueado.status, 403, 'con el módulo apagado la operación queda cerrada');
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM restaurante_cuentas WHERE negocio_id=$1`, [A.id]);
  assert.ok(rows[0].c >= 3, 'las cuentas históricas NO se borran al desactivar');
  const ventas = await pool.query(`SELECT COUNT(*)::int c FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'RM-%'`, [A.id]);
  assert.ok(ventas.rows[0].c >= 1, 'las ventas RM- siguen en Caja');
});
await t('DESACTIVAR', 'reactivar conserva la configuración de mesas y el historial', async () => {
  const r = await api(base, `/api/superadmin/negocios/${A.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { restaurante: 'activo' } } });
  assert.strictEqual(r.status, 200);
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: adminA });
  assert.strictEqual(mesas.status, 200);
  assert.strictEqual(mesas.body.mesas.length, 5, 'las 5 mesas configuradas se conservaron');
  const readiness = await api(base, `/api/superadmin/negocios/${A.id}/restaurante-readiness`, { cookie: superadmin });
  assert.strictEqual(readiness.body.numMesas, 5);
  assert.strictEqual(readiness.body.usandoDefault, false);
});
await t('DESACTIVAR', 'apagar otro módulo no se ve afectado por las mesas abiertas de Restaurante', async () => {
  const cta = await api(base, '/api/restaurante/mesas/abrir', { cookie: meseroA, method: 'POST', body: { mesa: 3, personas: 1 } });
  assert.strictEqual(cta.status, 201);
  const r = await api(base, `/api/superadmin/negocios/${A.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { pos: 'suspendido' } } });
  assert.strictEqual(r.status, 200, 'el guard es solo para el módulo restaurante');
  await api(base, `/api/superadmin/negocios/${A.id}/modulos`, { cookie: superadmin, method: 'PATCH', body: { modulos: { pos: 'activo' } } });
  // Cerrar la mesa de esta prueba para no dejar la cuenta colgada.
  await api(base, `/api/restaurante/cuentas/${cta.body.cuenta.id}/cerrar`, { cookie: adminA, method: 'POST' });
});

// ═════════ Readiness (la pantalla que decide el piloto) ═════════
await t('READINESS', 'el negocio operado reporta LISTO; uno sin productos ni mesas reporta configuración pendiente', async () => {
  const listo = await api(base, `/api/superadmin/negocios/${A.id}/restaurante-readiness`, { cookie: superadmin });
  assert.strictEqual(listo.status, 200, JSON.stringify(listo.body));
  assert.strictEqual(listo.body.estado, 'LISTO');
  assert.strictEqual(listo.body.moduloEstado, 'activo');
  assert.strictEqual(listo.body.numMesas, 5);
  assert.strictEqual(listo.body.usandoDefault, false);
  assert.ok(listo.body.usuariosActivos >= 2);
  assert.strictEqual(listo.body.productosActivos, 2);

  await pool.query(`UPDATE menu_productos SET disponible = FALSE WHERE negocio_id = $1`, [B.id]);
  const pendiente = await api(base, `/api/superadmin/negocios/${B.id}/restaurante-readiness`, { cookie: superadmin });
  assert.strictEqual(pendiente.body.estado, 'CONFIGURACION_PENDIENTE');
  assert.strictEqual(pendiente.body.productosActivos, 0, 'sin productos disponibles no está listo');
  assert.strictEqual(pendiente.body.numMesas, 12);
  assert.strictEqual(pendiente.body.usandoDefault, true, 'el default de 12 se reporta, y nunca bloquea la activación');
});

// ── Limpieza ──
await limpiarTenants();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
