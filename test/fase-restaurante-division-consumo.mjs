// ─── Restaurante: división de cuenta por consumo real ───────────────────────
//
// Cada persona paga lo que consumió: renglones completos, unidades de un
// renglón o fracciones de un renglón compartido; nunca se cobra dos veces el
// mismo consumo, ni con dos cajas a la vez. El descuento se prorratea por
// mayores residuos y todo cierra al centavo. Después de cobrar productos se
// puede dividir el remanente en partes iguales, pero ya no se vuelve a
// consumo. Con un pago vigente, el descuento queda congelado y un renglón
// cobrado es inmutable; el reverso (admin, con motivo) libera sin borrar.
// Servicio directo, rutas HTTP reales, la aritmética pura y la pantalla en
// Chrome. Deja el negocio de prueba como lo encontró.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_DIVISION || '4963';
const CAPTURAS = process.env.CAPTURAS_DIR || join(__dirname, '.capturas-cuenta');
mkdirSync(CAPTURAS, { recursive: true });

const { pool } = await import('../src/services/database.js');
const {
  abrirMesa, agregarItems, enviarComanda, registrarPago, cerrarCuenta, obtenerCuenta, aplicarDescuentoCuenta,
  cambiarCantidadItem, quitarItemPendiente, cancelarItem,
  estadoDivision, cobrarConsumo, cobrarParteIgual, revertirCobro,
} = await import('../src/services/restauranteService.js');
const div = await import('../src/services/divisionConsumo.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const A = SEED.negocioA, B = SEED.negocioB;
const ADMIN_A = SEED.adminNegocioAUsuarioId, STAFF_A = SEED.staffNegocioAUsuarioId;

// ── Setup ──
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
for (const n of [A, B]) { await fijarModulo(n, 'restaurante', 'activo'); await fijarModulo(n, 'pos', 'activo'); }
for (const n of [A, B]) for (const [tipo, habilitado] of [['efectivo', true], ['terminal', true], ['transferencia', false]]) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`, [n, tipo, habilitado]);
}
// Un admin propio de B para el aislamiento.
const { rows: [uB] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1, 'Admin B Division', $2, 'x') RETURNING id`,
  [B, `admin-b-div-${Date.now()}@test.local`]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [uB.id, B]);
const ADMIN_B = uB.id;
// Mesas 50-79 son de esta suite.
await pool.query(`UPDATE restaurante_cuentas SET estado = 'cancelada' WHERE negocio_id = $1 AND estado = 'abierta' AND mesa_numero BETWEEN 50 AND 79`, [A]);
// Sin impresoras: precuenta y ticket vuelven al navegador (el payload viaja en la respuesta).
await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [A]);
await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [A]);
await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [A]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const base = srv.base;
const cookie = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const cookieAdmin = cookie(ADMIN_A, A, 'admin');
const cookieStaff = cookie(STAFF_A, A, 'staff');
const cookieAdminB = cookie(ADMIN_B, B, 'admin');
async function api(path, { cookie: ck = cookieAdmin, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}
let mesaLibre = 50;
async function nuevaCuenta(items, { enviar = true } = {}) {
  const cta = await abrirMesa(A, { mesaNumero: mesaLibre++, personas: 4, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(cta.id, A, items, STAFF_A);
  if (enviar) await enviarComanda(cta.id, A, STAFF_A);
  return cta.id;
}
const it = (producto, cantidad, precio, extra = {}) => ({ producto, cantidad, precio_unitario: precio, ...extra });
const MENU_REAL = () => [
  it('Protein Pancakes', 1, 169), it('Chilaquiles Sencillos', 1, 225, { modificadores: ['Salsa: Mole', 'Proteína: Bistec en salsa'] }),
  it('Chilaquiles Sencillos', 1, 255), it('Refresco', 1, 39), it('Jugo naranja 1 litro', 1, 95),
  it('Caramel Macchiato Helado', 1, 39), it('Café Americano', 1, 39),
];
const renglon = (estado, nombre) => estado.renglones.find(r => r.producto === nombre);
const renglones = (estado, nombre) => estado.renglones.filter(r => r.producto === nombre);
async function ventasDeCuenta(cuentaId) {
  const { rows } = await pool.query(`SELECT folio, estado, datos FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'cuenta_id' = $2`, [A, cuentaId]);
  return rows;
}
async function pedidosTotales() {
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1`, [A]);
  return r.n;
}
const pagoEf = (monto, recibido = null, propina = 0) => ({ metodo: 'efectivo', monto, ...(recibido != null ? { recibido } : {}), propina });
const pagoTj = (monto, propina = 0) => ({ metodo: 'terminal', monto, propina });

try {
  await t('MIGRACION', '083: cobro_id y tipo de cobro en pagos, tabla de porciones, reverso y remanente', async () => {
    const { rows } = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name, column_name) IN (('restaurante_cuenta_pagos','cobro_id'),('restaurante_cuenta_pagos','tipo_cobro'),('restaurante_cuenta_pagos','revertido_at'),
        ('restaurante_cuenta_porciones','importe_centavos'),('restaurante_cuenta_porciones','numerador'),('restaurante_cuentas','division_remanente'))`);
    assert.strictEqual(rows.length, 6, JSON.stringify(rows));
  });

  // ═══════════ 1-3. Cuatro productos: A paga dos, B otro, cobrar resto ═══════════
  let cuenta1 = null, folio1 = null;
  await t('CONSUMO', '1. cuenta con 4 productos → persona A paga 2 productos completos', async () => {
    cuenta1 = await nuevaCuenta([it('Protein Pancakes', 1, 169), it('Chilaquiles Sencillos', 1, 225), it('Refresco', 1, 39), it('Café Americano', 1, 39)]);
    const antes = await estadoDivision(cuenta1, A);
    assert.strictEqual(antes.modo, 'consumo');
    assert.strictEqual(antes.consumoBloqueado, false);
    assert.strictEqual(antes.renglones.length, 4);
    assert.ok(antes.renglones.every(r => r.estado === 'pendiente' && r.fraccionPendiente === '1'));
    const sel = [{ itemId: renglon(antes, 'Protein Pancakes').id, numerador: 1, denominador: 1 }, { itemId: renglon(antes, 'Refresco').id, cantidad: 1 }];
    const r = await api(`/api/restaurante/cuentas/${cuenta1}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(208, 210)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.importe, 208);
    assert.strictEqual(r.body.cambio, 2);
    assert.strictEqual(r.body.saldoRestante, 264);
    assert.strictEqual(r.body.porciones.length, 2);
    const despues = await estadoDivision(cuenta1, A);
    assert.strictEqual(renglon(despues, 'Protein Pancakes').estado, 'pagado');
    assert.strictEqual(renglon(despues, 'Refresco').estado, 'pagado');
    assert.strictEqual(renglon(despues, 'Chilaquiles Sencillos').estado, 'pendiente');
    assert.strictEqual(despues.saldo, 264);
    assert.strictEqual(despues.cobros.length, 1);
    assert.strictEqual(despues.cobros[0].tipo, 'consumo');
    assert.strictEqual(despues.cobros[0].porciones.length, 2);
    assert.strictEqual(despues.consumoBloqueado, false, 'cobrar por consumo no cierra la selección');
  });

  await t('CONSUMO', '2. persona B paga otro producto con terminal', async () => {
    const e = await estadoDivision(cuenta1, A);
    const r = await api(`/api/restaurante/cuentas/${cuenta1}/cobros-consumo`, { method: 'POST', body: { seleccion: [{ itemId: renglon(e, 'Chilaquiles Sencillos').id, numerador: 1, denominador: 1 }], pagos: [pagoTj(225)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.saldoRestante, 39);
    const e2 = await estadoDivision(cuenta1, A);
    assert.strictEqual(e2.renglones.filter(r => r.estado === 'pagado').length, 3);
    assert.strictEqual(e2.cobros.length, 2);
  });

  await t('CONSUMO', '3. cobrar resto cubre todo lo pendiente sin seleccionarlo a mano', async () => {
    const r = await api(`/api/restaurante/cuentas/${cuenta1}/cobros-consumo`, { method: 'POST', body: { seleccion: 'resto', pagos: [pagoEf(39, 39)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.importe, 39);
    assert.strictEqual(r.body.saldoRestante, 0);
    const e = await estadoDivision(cuenta1, A);
    assert.ok(e.renglones.every(x => x.estado === 'pagado'));
    assert.strictEqual(e.saldo, 0);
    const vacio = await api(`/api/restaurante/cuentas/${cuenta1}/cobros-consumo`, { method: 'POST', body: { seleccion: 'resto', pagos: [pagoEf(1)] } });
    assert.strictEqual(vacio.status, 400, 'sin nada pendiente no hay resto que cobrar');
    assert.strictEqual(vacio.body.code, 'SELECCION_VACIA');
  });

  // ═══════════ 4-5. Fracciones ═══════════
  await t('FRACCION', '4. 3 tacos: una persona paga 2/3 y otra 1/3; el renglón cierra exacto', async () => {
    const cuenta = await nuevaCuenta([it('Tacos', 3, 25)]);                         // 75
    const e = await estadoDivision(cuenta, A);
    const tacos = renglon(e, 'Tacos');
    const a = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: tacos.id, cantidad: 2 }], pagos: [pagoEf(50, 50)] }, ADMIN_A);
    assert.strictEqual(a.importe, 50);
    assert.strictEqual(a.porciones[0].fraccion, '2/3');
    const e2 = await estadoDivision(cuenta, A);
    const t2 = renglon(e2, 'Tacos');
    assert.strictEqual(t2.estado, 'parcial');
    assert.strictEqual(t2.fraccionPendiente, '1/3');
    assert.strictEqual(t2.cobrado, 50);
    assert.strictEqual(t2.pendiente, 25);
    await assert.rejects(() => cobrarConsumo(cuenta, A, { seleccion: [{ itemId: tacos.id, cantidad: 2 }], pagos: [pagoEf(50)] }, ADMIN_A),
      e3 => e3.code === 'CONSUMO_YA_PAGADO' && e3.detalle.pendiente === '1/3', 'solo queda un taco');
    const b = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: tacos.id, numerador: 1, denominador: 3 }], pagos: [pagoTj(25)] }, ADMIN_A);
    assert.strictEqual(b.importe, 25);
    assert.strictEqual(b.saldoRestante, 0);
    assert.strictEqual(renglon(await estadoDivision(cuenta, A), 'Tacos').estado, 'pagado');
  });

  await t('FRACCION', '5. pizza compartida 1/2 + 1/2 con precio impar: 127.50 + 127.51 = 255.01', async () => {
    const cuenta = await nuevaCuenta([it('Pizza', 1, 255.01)]);
    const e = await estadoDivision(cuenta, A);
    const pizza = renglon(e, 'Pizza');
    const p1 = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: pizza.id, numerador: 1, denominador: 2 }], pagos: [pagoEf(127.5, 130)] }, ADMIN_A);
    assert.strictEqual(p1.importe, 127.5);
    assert.strictEqual(p1.cambio, 2.5);
    const p2 = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: pizza.id, numerador: 1, denominador: 2 }], pagos: [pagoTj(127.51)] }, ADMIN_A);
    assert.strictEqual(p2.importe, 127.51, 'la mitad que completa se lleva el centavo que falta');
    const e2 = await estadoDivision(cuenta, A);
    assert.strictEqual(renglon(e2, 'Pizza').estado, 'pagado');
    assert.strictEqual(e2.saldo, 0);
    assert.strictEqual(e2.pagado, 255.01);
  });

  // ═══════════ 6-7. Descuento prorrateado por mayores residuos ═══════════
  await t('DESCUENTO', '6. descuento con centavos difíciles: los netos por renglón suman exactamente subtotal − descuento', async () => {
    const cuenta = await nuevaCuenta(MENU_REAL());                                     // 861.00
    await aplicarDescuentoCuenta(cuenta, A, { tipo: 'importe', valor: 86.17, motivo: 'promo difícil' }, { usuarioId: ADMIN_A, rol: 'admin' });
    const e = await estadoDivision(cuenta, A);
    assert.strictEqual(e.subtotal, 861);
    assert.strictEqual(e.total, 774.83);
    const sumaNetos = e.renglones.reduce((s, r) => s + r.netoCentavos, 0);
    const sumaDesc = e.renglones.reduce((s, r) => s + Math.round(r.descuento * 100), 0);
    assert.strictEqual(sumaNetos, 77483, `netos ${sumaNetos}`);
    assert.strictEqual(sumaDesc, 8617, `descuentos ${sumaDesc}`);
    // Cada renglón se cobra por consumo, uno por uno: la suma de cobros es el total neto.
    let cobrado = 0;
    for (const r of e.renglones) {
      const c = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: r.id, numerador: 1, denominador: 1 }], pagos: [pagoEf(r.neto, r.neto)] }, ADMIN_A);
      cobrado += Math.round(c.importe * 100);
    }
    assert.strictEqual(cobrado, 77483);
    const cierre = await cerrarCuenta(cuenta, A, ADMIN_A);
    assert.strictEqual(cierre.total, 774.83);
    assert.strictEqual(cierre.descuento, 86.17);
  });

  await t('DESCUENTO', '7. mayores residuos: la suma cierra exacta para muchos descuentos y el sobrante va a los mayores residuos, no al renglón mayor', async () => {
    const r = [{ id: 'a', brutoCentavos: 16900 }, { id: 'b', brutoCentavos: 22500 }, { id: 'c', brutoCentavos: 25500 }, { id: 'd', brutoCentavos: 3900 }, { id: 'e', brutoCentavos: 9500 }, { id: 'f', brutoCentavos: 3900 }, { id: 'g', brutoCentavos: 3900 }];
    const total = 86100;
    for (let D = 0; D <= 2000; D += 7) {
      const n = div.netosDeRenglones(r, D);
      assert.strictEqual(n.reduce((s, x) => s + x.netoCentavos, 0), total - D, `D=${D}`);
      assert.strictEqual(n.reduce((s, x) => s + x.descuentoCentavos, 0), D, `D=${D}`);
      // Nadie recibe más de un centavo por encima de su parte exacta.
      for (const x of n) assert.ok(x.descuentoCentavos - (D * x.brutoCentavos / total) < 1 + 1e-9 && x.descuentoCentavos - (D * x.brutoCentavos / total) > -1, `D=${D} ${x.id}`);
    }
    // Con D = 3 el sobrante son 3 centavos y van a los TRES mayores residuos
    // (a, b, c), no todo al renglón de mayor importe.
    const n3 = div.netosDeRenglones(r, 3);
    assert.deepStrictEqual(n3.map(x => x.descuentoCentavos), [1, 1, 1, 0, 0, 0, 0]);
    // Partes iguales en centavos: 100/3 y 1000.01/7 cierran exacto.
    assert.deepStrictEqual(div.partesIgualesCentavos(10000, 3), [3334, 3333, 3333]);
    const p7 = div.partesIgualesCentavos(100001, 7);
    assert.strictEqual(p7.reduce((s, x) => s + x, 0), 100001);
    assert.ok(Math.max(...p7) - Math.min(...p7) <= 1);
  });

  // ═══════════ 8-9. Renglón cobrado = inmutable ═══════════
  await t('INMUTABLE', '8. un producto parcialmente pagado no cambia de cantidad ni se quita (409 ITEM_TIENE_COBRO)', async () => {
    const cuenta = await nuevaCuenta([it('Cerveza', 4, 45)], { enviar: false });     // pendiente, editable hasta que se cobre
    const e = await estadoDivision(cuenta, A);
    const cerveza = renglon(e, 'Cerveza');
    await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: cerveza.id, cantidad: 1 }], pagos: [pagoEf(45, 45)] }, ADMIN_A);
    const cant = await api(`/api/restaurante/cuentas/${cuenta}/items/${cerveza.id}/cantidad`, { method: 'PATCH', body: { cantidad: 5 } });
    assert.strictEqual(cant.status, 409, JSON.stringify(cant.body));
    assert.strictEqual(cant.body.code, 'ITEM_TIENE_COBRO');
    const del = await api(`/api/restaurante/cuentas/${cuenta}/items/${cerveza.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 409);
    assert.strictEqual(del.body.code, 'ITEM_TIENE_COBRO');
    await assert.rejects(() => cambiarCantidadItem(cerveza.id, cuenta, A, 2), x => x.code === 'ITEM_TIENE_COBRO');
    await assert.rejects(() => quitarItemPendiente(cerveza.id, cuenta, A), x => x.code === 'ITEM_TIENE_COBRO');
    assert.strictEqual(renglon(await estadoDivision(cuenta, A), 'Cerveza').cantidad, 4, 'la cantidad no cambió');
  });

  await t('INMUTABLE', '9. un producto pagado no se cancela; tras revertir el cobro, sí', async () => {
    const cuenta = await nuevaCuenta([it('Flan', 1, 60), it('Agua', 1, 20)]);
    const e = await estadoDivision(cuenta, A);
    const flan = renglon(e, 'Flan');
    const c = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: flan.id, numerador: 1, denominador: 1 }], pagos: [pagoEf(60, 60)] }, ADMIN_A);
    const cancel = await api(`/api/restaurante/cuentas/${cuenta}/items/${flan.id}/cancelar`, { method: 'POST', body: { motivo: 'no lo quiso' } });
    assert.strictEqual(cancel.status, 409, JSON.stringify(cancel.body));
    assert.strictEqual(cancel.body.code, 'ITEM_TIENE_COBRO');
    await assert.rejects(() => cancelarItem(flan.id, cuenta, A, ADMIN_A, 'motivo'), x => x.code === 'ITEM_TIENE_COBRO');
    const rev = await api(`/api/restaurante/cuentas/${cuenta}/cobros/${c.cobroId}/revertir`, { method: 'POST', body: { motivo: 'se cobró antes de que lo cancelaran' } });
    assert.strictEqual(rev.status, 200, JSON.stringify(rev.body));
    assert.strictEqual(rev.body.porcionesLiberadas, 1);
    const cancel2 = await api(`/api/restaurante/cuentas/${cuenta}/items/${flan.id}/cancelar`, { method: 'POST', body: { motivo: 'no lo quiso' } });
    assert.strictEqual(cancel2.status, 200, JSON.stringify(cancel2.body));
    const e2 = await estadoDivision(cuenta, A);
    assert.ok(!renglon(e2, 'Flan'), 'el cancelado ya no aparece en la división');
    assert.strictEqual(e2.saldo, 20);
  });

  // ═══════════ 10. Descuento congelado ═══════════
  await t('DESCUENTO', '10. descuento después del primer pago → 409 DESCUENTO_CONGELADO; tras revertir el cobro se puede', async () => {
    const cuenta = await nuevaCuenta([it('Filete', 2, 100)]);
    const e = await estadoDivision(cuenta, A);
    const c = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: renglon(e, 'Filete').id, cantidad: 1 }], pagos: [pagoEf(100, 100)] }, ADMIN_A);
    const d = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 10, motivo: 'tarde' } });
    assert.strictEqual(d.status, 409, JSON.stringify(d.body));
    assert.strictEqual(d.body.code, 'DESCUENTO_CONGELADO');
    const q = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'DELETE' });
    assert.strictEqual(q.status, 409);
    assert.strictEqual(q.body.code, 'DESCUENTO_CONGELADO');
    await revertirCobro(cuenta, A, c.cobroId, { usuarioId: ADMIN_A, motivo: 'para aplicar el descuento' });
    const d2 = await api(`/api/restaurante/cuentas/${cuenta}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 10, motivo: 'ahora sí' } });
    assert.strictEqual(d2.status, 200, JSON.stringify(d2.body));
    assert.strictEqual(d2.body.total, 180);
    // Los netos históricos no se recalculan sobre lo cobrado: el cobro revertido no cuenta y el nuevo neto rige.
    const e2 = await estadoDivision(cuenta, A);
    assert.strictEqual(renglon(e2, 'Filete').neto, 180);
    assert.strictEqual(renglon(e2, 'Filete').estado, 'pendiente');
  });

  // ═══════════ 11. Concurrencia ═══════════
  await t('CONCURRENCIA', '11. dos cajas cobran el mismo renglón a la vez: una gana, la otra 409 CONSUMO_YA_PAGADO con detalle', async () => {
    const cuenta = await nuevaCuenta([it('Hamburguesa', 1, 180)]);
    const e = await estadoDivision(cuenta, A);
    const h = renglon(e, 'Hamburguesa');
    const res = await Promise.allSettled([
      cobrarConsumo(cuenta, A, { seleccion: [{ itemId: h.id, numerador: 1, denominador: 1 }], pagos: [pagoEf(180, 200)] }, ADMIN_A),
      cobrarConsumo(cuenta, A, { seleccion: [{ itemId: h.id, numerador: 1, denominador: 1 }], pagos: [pagoTj(180)] }, STAFF_A),
    ]);
    const ok = res.filter(x => x.status === 'fulfilled'), mal = res.filter(x => x.status === 'rejected');
    assert.strictEqual(ok.length, 1, JSON.stringify(res.map(x => x.status === 'rejected' ? x.reason.code : 'ok')));
    assert.strictEqual(mal[0].reason.code, 'CONSUMO_YA_PAGADO');
    assert.strictEqual(mal[0].reason.detalle.pendiente, '0');
    const e2 = await estadoDivision(cuenta, A);
    assert.strictEqual(e2.pagado, 180, 'jamás doble cobro');
    assert.strictEqual(e2.cobros.length, 1);
    assert.strictEqual(e2.saldo, 0);
  });

  // ═══════════ 12-14. Mixto, cambio, propina ═══════════
  let cuentaMix = null;
  await t('MIXTO', '12. una persona paga su selección con $200 efectivo + $194 terminal: un solo cobro, dos pagos', async () => {
    cuentaMix = await nuevaCuenta([it('Protein Pancakes', 1, 169), it('Chilaquiles Sencillos', 1, 225), it('Refresco', 1, 39)]);   // 433
    const e = await estadoDivision(cuentaMix, A);
    const sel = [{ itemId: renglon(e, 'Protein Pancakes').id, numerador: 1, denominador: 1 }, { itemId: renglon(e, 'Chilaquiles Sencillos').id, numerador: 1, denominador: 1 }];   // 394
    const mal = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(200, 200), pagoTj(190)] } });
    assert.strictEqual(mal.status, 409, 'los pagos deben sumar exactamente la selección');
    assert.strictEqual(mal.body.code, 'MONTO_NO_COINCIDE');
    assert.strictEqual(mal.body.detalle.importeEsperado, 394);
    const r = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(200, 200), pagoTj(194)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.importe, 394);
    assert.strictEqual(r.body.pagos.length, 2);
    const { rows } = await pool.query(`SELECT cobro_id, tipo_cobro, metodo, monto FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND revertido_at IS NULL ORDER BY metodo`, [cuentaMix]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].cobro_id, rows[1].cobro_id, 'mismo cobro_id');
    assert.strictEqual(rows[0].cobro_id, r.body.cobroId);
    assert.ok(rows.every(x => x.tipo_cobro === 'consumo'));
    const e2 = await estadoDivision(cuentaMix, A);
    assert.strictEqual(e2.cobros.length, 1, 'un cobro, no dos');
    assert.strictEqual(e2.cobros[0].pagos.length, 2);
    assert.strictEqual(e2.saldo, 39);
    assert.strictEqual((await ventasDeCuenta(cuentaMix)).length, 0, 'ningún cobro crea una venta');
  });

  await t('CAMBIO', '13. efectivo recibido y cambio funcionan en un cobro por consumo; recibir de menos se rechaza', async () => {
    const e = await estadoDivision(cuentaMix, A);
    const sel = [{ itemId: renglon(e, 'Refresco').id, numerador: 1, denominador: 1 }];
    const poco = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(39, 30)] } });
    assert.strictEqual(poco.status, 400);
    assert.strictEqual(poco.body.code, 'EFECTIVO_INSUFICIENTE');
    const r = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(39, 50)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.cambio, 11);
    assert.strictEqual(r.body.pagos[0].recibido, 50);
    assert.strictEqual(r.body.pagos[0].cambio, 11);
    assert.strictEqual(r.body.saldoRestante, 0);
  });

  await t('PROPINA', '14. la propina sigue aparte: no reduce el saldo, no entra a la venta y el billete debe cubrirla', async () => {
    const cuenta = await nuevaCuenta([it('Café Americano', 2, 39)]);                  // 78
    const e = await estadoDivision(cuenta, A);
    const cafe = renglon(e, 'Café Americano');
    await assert.rejects(() => cobrarConsumo(cuenta, A, { seleccion: [{ itemId: cafe.id, cantidad: 1 }], pagos: [pagoEf(39, 45, 10)] }, ADMIN_A), x => x.code === 'EFECTIVO_INSUFICIENTE');
    const a = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: cafe.id, cantidad: 1 }], pagos: [pagoEf(39, 50, 10)] }, ADMIN_A);
    assert.strictEqual(a.cambio, 1);
    assert.strictEqual(a.saldoRestante, 39, 'la propina no baja el saldo');
    const b = await cobrarConsumo(cuenta, A, { seleccion: 'resto', pagos: [pagoTj(39, 5)] }, ADMIN_A);
    assert.strictEqual(b.saldoRestante, 0);
    const c = await obtenerCuenta(cuenta, A);
    assert.strictEqual(c.propinas, 15);
    const cierre = await cerrarCuenta(cuenta, A, ADMIN_A);
    assert.strictEqual(cierre.total, 78);
    assert.strictEqual(cierre.propinas, 15);
    const [v] = await ventasDeCuenta(cuenta);
    assert.strictEqual(Number(v.datos.total), 78);
    assert.strictEqual(Number(v.datos.propinas), 15);
  });

  // ═══════════ 15-16. Consumo + remanente en partes iguales ═══════════
  let cuentaRem = null;
  await t('REMANENTE', '15. cobrar productos por consumo y después dividir TODO el remanente entre N personas', async () => {
    cuentaRem = await nuevaCuenta([it('Protein Pancakes', 1, 169), it('Chilaquiles Sencillos', 1, 225), it('Refresco', 1, 39), it('Jugo naranja 1 litro', 1, 95)]);   // 528
    const e = await estadoDivision(cuentaRem, A);
    await cobrarConsumo(cuentaRem, A, { seleccion: [{ itemId: renglon(e, 'Jugo naranja 1 litro').id, numerador: 1, denominador: 1 }], pagos: [pagoEf(95, 100)] }, ADMIN_A);
    const e2 = await estadoDivision(cuentaRem, A, { partes: 3 });
    assert.strictEqual(e2.saldo, 433);
    assert.deepStrictEqual(e2.partesIguales, { partes: 3, pagadas: 0, restantes: 3, montos: [144.34, 144.33, 144.33], fijas: false });
    const mal = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-partes`, { method: 'POST', body: { partes: 3, pagos: [pagoEf(150, 150)] } });
    assert.strictEqual(mal.status, 409, 'la parte la calcula el servidor');
    assert.strictEqual(mal.body.code, 'MONTO_NO_COINCIDE');
    assert.deepStrictEqual(mal.body.detalle.partes, [144.34, 144.33, 144.33]);
    const r = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-partes`, { method: 'POST', body: { partes: 3, pagos: [pagoEf(144.34, 150)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.parte, 1);
    assert.strictEqual(r.body.restantes, 2);
    assert.strictEqual(r.body.cambio, 5.66);
    assert.strictEqual(r.body.saldoRestante, 288.66);
    const e3 = await estadoDivision(cuentaRem, A);
    assert.ok(e3.remanente && e3.remanente.partes === 3, 'la primera parte formaliza la división');
    assert.deepStrictEqual(e3.partesIguales, { partes: 3, pagadas: 1, restantes: 2, montos: [144.33, 144.33], fijas: true });
  });

  await t('REMANENTE', '16. después de dividir el remanente ya no se vuelve a consumo, N queda fijo, y las partes restantes cierran la cuenta', async () => {
    const e = await estadoDivision(cuentaRem, A);
    assert.strictEqual(e.consumoBloqueado, true);
    assert.strictEqual(e.modo, 'generico');
    const consumo = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-consumo`, { method: 'POST', body: { seleccion: [{ itemId: renglon(e, 'Refresco').id, numerador: 1, denominador: 1 }], pagos: [pagoEf(39)] } });
    assert.strictEqual(consumo.status, 409, JSON.stringify(consumo.body));
    assert.strictEqual(consumo.body.code, 'REMANENTE_DIVIDIDO');
    const cambiaN = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-partes`, { method: 'POST', body: { partes: 4, pagos: [pagoEf(72.17)] } });
    assert.strictEqual(cambiaN.status, 409);
    assert.strictEqual(cambiaN.body.code, 'PARTES_YA_FIJADAS');
    const p2 = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-partes`, { method: 'POST', body: { pagos: [pagoTj(144.33)] } });
    assert.strictEqual(p2.status, 201, JSON.stringify(p2.body));
    const p3 = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-partes`, { method: 'POST', body: { pagos: [pagoEf(144.33, 144.33)] } });
    assert.strictEqual(p3.status, 201, JSON.stringify(p3.body));
    assert.strictEqual(p3.body.saldoRestante, 0);
    const agotadas = await api(`/api/restaurante/cuentas/${cuentaRem}/cobros-partes`, { method: 'POST', body: { pagos: [pagoEf(1)] } });
    assert.ok([409].includes(agotadas.status), JSON.stringify(agotadas.body));
    assert.ok(['PARTES_AGOTADAS', 'NADA_QUE_COBRAR'].includes(agotadas.body.code));
  });

  // ═══════════ 17-19. Cierre ═══════════
  await t('CIERRE', '17. cerrar exige saldo cero, con o sin porciones', async () => {
    const cuenta = await nuevaCuenta([it('Tacos', 3, 25)]);
    const e = await estadoDivision(cuenta, A);
    await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: renglon(e, 'Tacos').id, cantidad: 2 }], pagos: [pagoEf(50, 50)] }, ADMIN_A);
    const r = await api(`/api/restaurante/cuentas/${cuenta}/cerrar`, { method: 'POST' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'SALDO_PENDIENTE');
    await cobrarConsumo(cuenta, A, { seleccion: 'resto', pagos: [pagoEf(25, 25)] }, ADMIN_A);
    const r2 = await api(`/api/restaurante/cuentas/${cuenta}/cerrar`, { method: 'POST' });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.total, 75);
  });

  await t('CIERRE', '18-19. el cierre genera UNA sola venta; ningún cobro por consumo o parte creó pedido ni venta', async () => {
    const antes = await pedidosTotales();
    const r = await api(`/api/restaurante/cuentas/${cuentaRem}/cerrar`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    folio1 = r.body.ventaFolio;
    assert.strictEqual(await pedidosTotales(), antes + 1, 'exactamente una fila nueva, y solo al cerrar');
    const ventas = await ventasDeCuenta(cuentaRem);
    assert.strictEqual(ventas.length, 1);
    assert.strictEqual(Number(ventas[0].datos.total), 528);
    assert.strictEqual(ventas[0].datos.forma_pago, 'mixto');
    const porMetodo = Object.fromEntries(ventas[0].datos.pagos.map(p => [p.metodo, p.monto]));
    assert.deepStrictEqual(porMetodo, { efectivo: 383.67, terminal: 144.33 });
    const repetido = await api(`/api/restaurante/cuentas/${cuentaRem}/cerrar`, { method: 'POST' });
    assert.strictEqual(repetido.body.yaCerrada, true);
    assert.strictEqual(await pedidosTotales(), antes + 1);
    assert.strictEqual((await ventasDeCuenta(cuenta1)).length, 0, 'la cuenta 1 sigue sin venta hasta que se cierre');
  });

  // ═══════════ 20. Aislamiento ═══════════
  await t('AISLAMIENTO', '20. otro negocio no ve, no cobra ni revierte la cuenta ajena (404)', async () => {
    const e = await estadoDivision(cuentaMix, A);
    const cobro = e.cobros[0].cobroId;
    const ver = await api(`/api/restaurante/cuentas/${cuentaMix}/division`, { cookie: cookieAdminB });
    assert.strictEqual(ver.status, 404);
    const cobrar = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros-consumo`, { cookie: cookieAdminB, method: 'POST', body: { seleccion: 'resto', pagos: [pagoEf(1)] } });
    assert.strictEqual(cobrar.status, 404);
    const partes = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros-partes`, { cookie: cookieAdminB, method: 'POST', body: { partes: 2, pagos: [pagoEf(1)] } });
    assert.strictEqual(partes.status, 404);
    const rev = await api(`/api/restaurante/cuentas/${cuentaMix}/cobros/${cobro}/revertir`, { cookie: cookieAdminB, method: 'POST', body: { motivo: 'ajeno' } });
    assert.strictEqual(rev.status, 404);
    await assert.rejects(() => cobrarConsumo(cuentaMix, B, { seleccion: 'resto', pagos: [pagoEf(1)] }, ADMIN_B), x => x.code === 'CUENTA_NO_ENCONTRADA');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND revertido_at IS NULL`, [cuentaMix]);
    assert.strictEqual(rows[0].n, 3, 'nada cambió desde B');
  });

  // ═══════════ 21-23. Refresh, doble clic, centavos ═══════════
  await t('REFRESH', '21. la pantalla se reconstruye desde la base: el estado de división refleja porciones y cobros tal como están guardados', async () => {
    const e = await estadoDivision(cuentaMix, A);
    const { rows: porciones } = await pool.query(`SELECT item_id, numerador, denominador, importe_centavos, cobro_id FROM restaurante_cuenta_porciones WHERE cuenta_id = $1 AND revertido_at IS NULL`, [cuentaMix]);
    assert.strictEqual(porciones.length, 3);
    for (const p of porciones) {
      const r = e.renglones.find(x => x.id === p.item_id);
      assert.ok(r, 'cada porción guardada aparece en un renglón');
      assert.strictEqual(r.estado, 'pagado');
      assert.ok(r.porciones.some(x => x.cobroId === p.cobro_id && x.importeCentavos === p.importe_centavos));
    }
    const { rows: pagos } = await pool.query(`SELECT count(DISTINCT cobro_id)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND revertido_at IS NULL`, [cuentaMix]);
    assert.strictEqual(e.cobros.length, pagos[0].n);
    assert.strictEqual(e.pagado, 433);
    assert.strictEqual(e.saldo, 0);
    assert.strictEqual(e.renglones.reduce((s, r) => s + r.cobradoCentavos, 0), 43300);
  });

  await t('IDEMPOTENCIA', '22. doble clic: el mismo cobroId no duplica; sin cobroId, la segunda vez el consumo ya está pagado', async () => {
    const cuenta = await nuevaCuenta([it('Limonada', 1, 45), it('Tostadas', 1, 70)]);
    const e = await estadoDivision(cuenta, A);
    const sel = [{ itemId: renglon(e, 'Limonada').id, numerador: 1, denominador: 1 }];
    const cobroId = randomUUID();
    const [a, b] = await Promise.all([
      api(`/api/restaurante/cuentas/${cuenta}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(45, 45)], cobroId } }),
      api(`/api/restaurante/cuentas/${cuenta}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(45, 45)], cobroId } }),
    ]);
    const estados = [a.status, b.status].sort();
    assert.deepStrictEqual(estados, [200, 201], JSON.stringify([a.body, b.body]));
    const repetido = a.status === 200 ? a.body : b.body;
    assert.strictEqual(repetido.repetido, true);
    assert.strictEqual(repetido.cobroId, cobroId);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 AND revertido_at IS NULL`, [cuenta]);
    assert.strictEqual(rows[0].n, 1, 'un solo pago');
    const otra = await api(`/api/restaurante/cuentas/${cuenta}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(45, 45)] } });
    assert.strictEqual(otra.status, 409);
    assert.strictEqual(otra.body.code, 'CONSUMO_YA_PAGADO');
    assert.strictEqual((await estadoDivision(cuenta, A)).pagado, 45);
  });

  await t('CENTAVOS', '23. precios y fracciones difíciles con descuento del 33.33 %: cada cobro y el total cierran exactos', async () => {
    const cuenta = await nuevaCuenta([it('Ceviche', 3, 33.33), it('Pulpo', 1, 199.99), it('Mezcal', 5, 7.77), it('Postre', 1, 0.01)]);   // 100 + 199.99 + 38.85 + 0.01 = 338.85
    await aplicarDescuentoCuenta(cuenta, A, { tipo: 'porcentaje', valor: 33.33, motivo: 'difícil' }, { usuarioId: ADMIN_A, rol: 'admin' });
    const e = await estadoDivision(cuenta, A);
    const totalC = Math.round(e.total * 100);
    assert.strictEqual(e.renglones.reduce((s, r) => s + r.netoCentavos, 0), totalC);
    const ceviche = renglon(e, 'Ceviche'), pulpo = renglon(e, 'Pulpo'), mezcal = renglon(e, 'Mezcal');
    let suma = 0;
    const cobrar = async (sel, metodo = 'efectivo') => {
      // Se pide el importe al servidor con un pago a propósito incorrecto, y se paga lo que dijo.
      const sonda = await api(`/api/restaurante/cuentas/${cuenta}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [pagoEf(0.01)] } });
      assert.strictEqual(sonda.body.code, 'MONTO_NO_COINCIDE', JSON.stringify(sonda.body));
      const importe = sonda.body.detalle.importeEsperado;
      const r = await api(`/api/restaurante/cuentas/${cuenta}/cobros-consumo`, { method: 'POST', body: { seleccion: sel, pagos: [metodo === 'efectivo' ? pagoEf(importe, importe) : pagoTj(importe)] } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      suma += Math.round(r.body.importe * 100);
      return r.body;
    };
    await cobrar([{ itemId: ceviche.id, cantidad: 1 }]);
    await cobrar([{ itemId: ceviche.id, cantidad: 1 }], 'terminal');
    await cobrar([{ itemId: pulpo.id, numerador: 1, denominador: 3 }]);
    await cobrar([{ itemId: pulpo.id, numerador: 1, denominador: 3 }, { itemId: mezcal.id, cantidad: 2 }]);
    await cobrar([{ itemId: mezcal.id, numerador: 1, denominador: 5 }]);
    const resto = await cobrar('resto', 'terminal');
    assert.strictEqual(resto.saldoRestante, 0);
    assert.strictEqual(suma, totalC, `cobrado ${suma} vs total ${totalC}`);
    const e2 = await estadoDivision(cuenta, A);
    assert.ok(e2.renglones.every(r => r.estado === 'pagado' && r.pendienteCentavos === 0 && r.cobradoCentavos === r.netoCentavos));
    const cierre = await cerrarCuenta(cuenta, A, ADMIN_A);
    assert.strictEqual(Math.round(cierre.total * 100), totalC);
  });

  // ═══════════ 24-25. Precuenta y ticket ═══════════
  await t('PRECUENTA', '24. la precuenta refleja los pagos parciales por consumo: pagado y saldo', async () => {
    const cuenta = await nuevaCuenta([it('Enchiladas', 1, 120), it('Agua', 2, 20)]);   // 160
    const e = await estadoDivision(cuenta, A);
    await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: renglon(e, 'Enchiladas').id, numerador: 1, denominador: 1 }], pagos: [pagoEf(120, 120)] }, ADMIN_A);
    const pre = await api(`/api/restaurante/cuentas/${cuenta}/precuenta`, { method: 'POST', body: { solicitudId: `pre-div-${Date.now()}` } });
    assert.strictEqual(pre.status, 200, JSON.stringify(pre.body));
    assert.strictEqual(pre.body.destino, 'navegador');
    assert.strictEqual(pre.body.precuenta.pagado, 120);
    assert.strictEqual(pre.body.precuenta.saldo, 40);
    assert.strictEqual(pre.body.precuenta.total, 160);
    assert.deepStrictEqual(pre.body.precuenta.pagos, [{ metodo: 'efectivo', monto: 120, propina: 0 }]);
  });

  await t('TICKET', '25. el ticket final sigue correcto tras cobros por consumo y mixtos: pagos por método, total y PAGADO', async () => {
    const r = await api(`/api/restaurante/cuentas/${cuentaMix}/cerrar`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.impresion.destino, 'navegador');
    const tk = r.body.impresion.ticket;
    assert.strictEqual(tk.ticketPagado, true);
    assert.strictEqual(tk.total, 433);
    assert.strictEqual(tk.pagado, 433);
    assert.strictEqual(tk.items.length, 3);
    const porMetodo = {};
    for (const p of tk.pagos) porMetodo[p.metodo] = Math.round(((porMetodo[p.metodo] || 0) + p.monto) * 100) / 100;
    assert.deepStrictEqual(porMetodo, { efectivo: 239, terminal: 194 });
    assert.strictEqual(tk.efectivoRecibido, 250);
    assert.strictEqual(tk.cambio, 11);
  });

  // ═══════════ Reverso ═══════════
  await t('REVERSO', 'revertir un cobro libera sus porciones sin borrar, audita quién/cuándo/motivo, exige admin y motivo', async () => {
    const cuenta = await nuevaCuenta([it('Sopa', 2, 60)]);
    const e = await estadoDivision(cuenta, A);
    const c = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: renglon(e, 'Sopa').id, cantidad: 1 }], pagos: [pagoEf(60, 60)] }, ADMIN_A);
    const staff = await api(`/api/restaurante/cuentas/${cuenta}/cobros/${c.cobroId}/revertir`, { cookie: cookieStaff, method: 'POST', body: { motivo: 'x' } });
    assert.strictEqual(staff.status, 403, 'el reverso es de admin');
    const sinMotivo = await api(`/api/restaurante/cuentas/${cuenta}/cobros/${c.cobroId}/revertir`, { method: 'POST', body: {} });
    assert.strictEqual(sinMotivo.status, 400);
    assert.strictEqual(sinMotivo.body.code, 'MOTIVO_REQUERIDO');
    const inexistente = await api(`/api/restaurante/cuentas/${cuenta}/cobros/${randomUUID()}/revertir`, { method: 'POST', body: { motivo: 'nada' } });
    assert.strictEqual(inexistente.status, 404);
    const rev = await api(`/api/restaurante/cuentas/${cuenta}/cobros/${c.cobroId}/revertir`, { method: 'POST', body: { motivo: 'se equivocó de comensal' } });
    assert.strictEqual(rev.status, 200, JSON.stringify(rev.body));
    assert.deepStrictEqual({ pagos: rev.body.pagosRevertidos, porciones: rev.body.porcionesLiberadas, monto: rev.body.montoRevertido }, { pagos: 1, porciones: 1, monto: 60 });
    const otraVez = await api(`/api/restaurante/cuentas/${cuenta}/cobros/${c.cobroId}/revertir`, { method: 'POST', body: { motivo: 'otra vez' } });
    assert.strictEqual(otraVez.status, 404, 'ya revertido no se revierte dos veces');
    const e2 = await estadoDivision(cuenta, A);
    assert.strictEqual(renglon(e2, 'Sopa').estado, 'pendiente');
    assert.strictEqual(e2.saldo, 120);
    assert.strictEqual(e2.cobros.length, 0);
    const cta = await obtenerCuenta(cuenta, A);
    assert.strictEqual(cta.pagos.length, 0);
    assert.strictEqual(cta.pagosRevertidos.length, 1);
    assert.strictEqual(cta.pagosRevertidos[0].motivo_reverso, 'se equivocó de comensal');
    assert.ok(cta.pagosRevertidos[0].revertido_at && cta.pagosRevertidos[0].revertido_por_nombre, 'quién y cuándo');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM restaurante_cuenta_porciones WHERE cuenta_id = $1`, [cuenta]);
    assert.strictEqual(rows[0].n, 1, 'la porción sigue en la base, marcada como revertida');
    // Se puede volver a cobrar ese consumo.
    const c2 = await cobrarConsumo(cuenta, A, { seleccion: [{ itemId: renglon(e2, 'Sopa').id, cantidad: 2 }], pagos: [pagoTj(120)] }, STAFF_A);
    assert.strictEqual(c2.saldoRestante, 0);
  });

  await t('GENERICO', 'un abono suelto también cierra la selección por producto; lo que queda se cobra como resto', async () => {
    const cuenta = await nuevaCuenta([it('Tacos', 3, 25), it('Refresco', 1, 39)]);   // 114
    await registrarPago(cuenta, A, { metodo: 'efectivo', monto: 50, recibido: 50 }, ADMIN_A);
    const e = await estadoDivision(cuenta, A);
    assert.strictEqual(e.consumoBloqueado, true);
    assert.strictEqual(e.modo, 'generico');
    await assert.rejects(() => cobrarConsumo(cuenta, A, { seleccion: [{ itemId: renglon(e, 'Refresco').id, numerador: 1, denominador: 1 }], pagos: [pagoEf(39)] }, ADMIN_A), x => x.code === 'REMANENTE_DIVIDIDO');
    const r = await api(`/api/restaurante/cuentas/${cuenta}/cobros-partes`, { method: 'POST', body: { partes: 1, pagos: [pagoTj(64)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.saldoRestante, 0);
  });

  // ═══════════ Pantalla ═══════════
  if (process.env.SALTAR_UI) console.log('  --  [UI] omitida (SALTAR_UI)'); else await t('UI', 'en Chrome: el modal Dividir cuenta sin prompt(), selección táctil por renglón, cobrar selección, cobrar resto, partes iguales con stepper y capturas', async () => {
    const puppeteer = (await import('puppeteer')).default;
    const cuenta = await nuevaCuenta([it('Protein Pancakes', 1, 169), it('Chilaquiles Sencillos', 1, 225, { modificadores: ['Salsa: Mole', 'Proteína: Bistec en salsa'] }), it('Refresco', 4, 39), it('Café Americano', 1, 39)]);   // 589
    const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const pag = await nav.newPage();
      const errores = [];
      pag.on('pageerror', e => errores.push(e.message));
      let prompts = 0;
      pag.on('dialog', d => { if (d.type() === 'prompt') prompts++; d.accept().catch(() => {}); });
      await pag.setViewport({ width: 1024, height: 900 });
      await pag.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN_A, negocioId: A, rol: 'admin' })), domain: 'localhost', path: '/' });
      await pag.goto(`${base}/restaurante`, { waitUntil: 'networkidle0', timeout: 60000 });
      await pag.waitForSelector('#grid .mesa', { timeout: 15000 });
      await pag.evaluate((id) => abrirCuenta(id), cuenta);
      await pag.waitForFunction(() => document.getElementById('cu-secundarias')?.textContent.includes('Dividir cuenta'), { timeout: 15000 });
      await pag.evaluate(() => abrirDividir());
      await pag.waitForFunction(() => document.getElementById('dlg-dividir').open && document.querySelectorAll('#dv-cuerpo .dv-renglon').length === 4, { timeout: 15000 });
      assert.strictEqual(prompts, 0, 'ningún prompt() del navegador');
      const texto = () => pag.$eval('#dv-cuerpo', el => el.textContent.replace(/\s+/g, ' '));
      let tx = await texto();
      assert.ok(tx.includes('Protein Pancakes') && tx.includes('Salsa: Mole') && tx.includes('$169.00') && tx.includes('4×') && tx.includes('Selección actual'), tx.slice(0, 200));
      // Toca dos renglones: pancakes completos y 2 de 4 refrescos.
      await pag.evaluate(() => { const r = [...document.querySelectorAll('.dv-renglon')].find(x => x.textContent.includes('Protein Pancakes')); dvToggle(r.dataset.item); });
      await pag.evaluate(() => { const r = [...document.querySelectorAll('.dv-renglon')].find(x => x.textContent.includes('Refresco')); dvUnidades(r.dataset.item, 1); dvUnidades(r.dataset.item, 1); });
      await pag.waitForFunction(() => document.getElementById('dv-sel-total')?.textContent === '$247.00', { timeout: 5000 });
      await pag.screenshot({ path: join(CAPTURAS, 'division-1-consumo-seleccion.png') });
      // Cobrar selección: importe fijado por el servidor, efectivo $300 → cambio $53.
      await pag.evaluate(() => { window.__prompts = 0; });
      await pag.evaluate(() => dvCobrarSeleccion());
      await pag.waitForFunction(() => document.getElementById('dlg-pago').open, { timeout: 5000 });
      assert.strictEqual(await pag.$eval('#pg-monto', el => el.value), '247.00');
      assert.strictEqual(await pag.$eval('#pg-monto', el => el.readOnly), true, 'el importe no es editable');
      await pag.type('#pg-recibido', '300');
      await pag.waitForFunction(() => document.getElementById('pg-cambio').textContent.includes('$53.00'), { timeout: 5000 });
      await pag.screenshot({ path: join(CAPTURAS, 'division-2-cobrar-seleccion.png') });
      await pag.evaluate(() => registrarPago());
      await pag.waitForFunction(() => (document.getElementById('msg')?.textContent || '').includes('Consumo cobrado: $247.00'), { timeout: 15000 });
      await pag.waitForFunction(() => [...document.querySelectorAll('.dv-renglon.pagado')].length === 1 && [...document.querySelectorAll('.dv-renglon.parcial')].length === 1, { timeout: 15000 });
      tx = await texto();
      assert.ok(tx.includes('✓ PAGADO') && tx.includes('Pagado $78.00 · Pendiente $78.00'), tx.slice(0, 300));
      await pag.screenshot({ path: join(CAPTURAS, 'division-3-estado-renglones.png') });
      // Partes iguales del remanente ($342): 3 personas con stepper.
      await pag.evaluate(() => dvTab('iguales'));
      await pag.waitForFunction(() => document.getElementById('dv-partes-n') !== null, { timeout: 5000 });
      await pag.evaluate(() => dvPartes(-1));
      await pag.waitForFunction(() => document.getElementById('dv-partes-n')?.textContent === '3', { timeout: 10000 });
      tx = await texto();
      assert.ok(tx.includes('$114.00') && tx.includes('Persona 3'), tx.slice(0, 300));
      await pag.screenshot({ path: join(CAPTURAS, 'division-4-partes-iguales.png') });
      await pag.evaluate(() => dvCobrarParte(114));
      await pag.waitForFunction(() => document.getElementById('dlg-pago').open, { timeout: 5000 });
      await pag.select('#pg-metodo', 'terminal');
      await pag.evaluate(() => registrarPago());
      await pag.waitForFunction(() => (document.getElementById('msg')?.textContent || '').includes('Parte 1 de 3 cobrada'), { timeout: 15000 });
      await pag.waitForFunction(() => document.getElementById('dv-tab-consumo')?.disabled === true, { timeout: 15000 });
      tx = await texto();
      assert.ok(tx.includes('✓ pagada') && tx.includes('(fijas)'), tx.slice(0, 300));
      // Cobrar resto desde partes iguales: las dos partes restantes.
      await pag.evaluate(() => dvCobrarParte(114));
      await pag.waitForFunction(() => document.getElementById('dlg-pago').open, { timeout: 5000 });
      await pag.evaluate(() => registrarPago());
      await pag.waitForFunction(() => (document.getElementById('msg')?.textContent || '').includes('Parte 2 de 3 cobrada'), { timeout: 15000 });
      await pag.evaluate(() => dvCobrarParte(114));
      await pag.waitForFunction(() => document.getElementById('dlg-pago').open, { timeout: 5000 });
      await pag.evaluate(() => registrarPago());
      await pag.waitForFunction(() => (document.getElementById('msg')?.textContent || '').includes('Parte 3 de 3 cobrada'), { timeout: 15000 });
      await pag.waitForFunction(() => (document.getElementById('cu-totales')?.textContent || '').includes('Saldo$0.00') || (document.getElementById('cu-totales')?.textContent || '').replace(/\s+/g, '').includes('Saldo$0.00'), { timeout: 15000 });
      await pag.screenshot({ path: join(CAPTURAS, 'division-5-cobros.png') });
      const e = await estadoDivision(cuenta, A);
      assert.strictEqual(e.saldo, 0);
      assert.strictEqual(e.cobros.length, 4);
      assert.deepStrictEqual(errores, [], 'errores de JavaScript en la pantalla');
      assert.strictEqual(prompts, 0);
    } finally { await nav.close(); }
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  console.log(`Capturas en: ${CAPTURAS}`);
  srv.detener();
  await pool.query(`DELETE FROM usuario_negocios WHERE usuario_id = $1`, [ADMIN_B]).catch(() => {});
  await pool.query(`DELETE FROM usuarios WHERE id = $1`, [ADMIN_B]).catch(() => {});
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
