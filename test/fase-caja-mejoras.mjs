// Caja: plataformas, arqueo por denominaciones, propinas y cuentas de mesa.
//
// Lo que esta suite protege (petición del dueño, 25-sep-2026):
//   1. Los pedidos de plataforma (Rappi; listo para Uber Eats y DiDi Food) ya
//      no se suman a "Clip / enlace": tienen su propia naturaleza. Ventas del
//      día sigue siendo la suma de TODAS las naturalezas.
//   2. El arqueo guarda cómo se contó (denominaciones o solo total), y el
//      servidor rechaza un conteo cuyos billetes no suman lo contado.
//   3. El esperado = fondo + efectivo + entradas − retiros − gastos −
//      devoluciones en efectivo − propinas con tarjeta pagadas desde caja
//      (solo si el negocio lo configura).
//   4. Una venta de mesa en $0 dice qué fue (cancelada / cortesía) y una
//      cuenta abierta cuenta en "Por cobrar".
//   5. Un cobro mixto reparte su parte en efectivo al efectivo esperado.
// Y, sobre todo: un corte cerrado ANTES de esto no cambia.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const SERVIDOR = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

const { pool } = await import('../src/services/database.js');
const {
  calcularCorteVivo, cerrarCorte, obtenerCorteCerrado, listarCortes, ticketCorte, rangoUtcDeFecha,
  plataformaDePedido, claseDeVenta, partesDelCobro, propinasPorClase, estadoVentaSinCobro,
  normalizarArqueo, vistaCorteParaRol, PLATAFORMAS, DENOMINACIONES, CLAVE_PROPINAS_TARJETA_EFECTIVO,
} = await import('../src/services/cortesCaja.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const USUARIO = SEED.adminNegocioAUsuarioId;
const TZ = 'America/Matamoros';
// Días PROPIOS de esta suite (la base es compartida entre suites): ninguna
// otra siembra en agosto de 2025.
const D_PLAT = '2025-08-12';
const D_MESA = '2025-08-13';
const D_CIERRE = '2025-08-14';
const D_MALO = '2025-08-15';
const D_VIEJO = '2025-08-16';
const D_CIEGO = '2025-08-17';
const DIAS = [D_PLAT, D_MESA, D_CIERRE, D_MALO, D_VIEJO, D_CIEGO];
const MESAS = [471, 472, 473, 474, 475, 476];
const suf = Date.now().toString().slice(-6);
const n2 = (n) => Math.round(n * 100) / 100;

async function del(sql, params) { try { await pool.query(sql, params); } catch { /* ignorado */ } }
async function limpiar() {
  await del(`DELETE FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = ANY($2::date[])`, [NEG, DIAS]);
  await del(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = ANY($2::date[])`, [NEG, DIAS]);
  await del(`DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha = ANY($2::date[])`, [NEG, DIAS]);
  await del(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE 'CJ-%'`, [NEG]);
  await del(`DELETE FROM restaurante_cuentas WHERE negocio_id = $1 AND mesa_numero = ANY($2::int[])`, [NEG, MESAS]);
}

function instante(fecha, hora, minuto = 0) {
  const { inicio } = rangoUtcDeFecha(fecha, TZ);
  return new Date(inicio.getTime() + hora * 3600000 + minuto * 60000);
}
async function venta(folio, fecha, hora, datos, estado = 'entregado') {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos, created_at) VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [folio, NEG, estado, JSON.stringify({ pago_confirmado: true, items: [], ...datos }), instante(fecha, hora).toISOString()]);
}
async function cuenta(mesa, fecha, hora, { estado = 'abierta', descuento = 0 } = {}) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, personas, mesero_usuario_id, estado, abierta_por, abierta_at, descuento_monto)
     VALUES ($1,$2,2,$3,$4,$3,$5,$6) RETURNING id::text AS id`,
    [NEG, mesa, USUARIO, estado, instante(fecha, hora).toISOString(), descuento]);
  return c.id;
}
async function item(cuentaId, precio, cantidad = 1, estado = 'enviado') {
  await pool.query(
    `INSERT INTO restaurante_cuenta_items (cuenta_id, negocio_id, producto, cantidad, precio_unitario, estado, agregado_por)
     VALUES ($1,$2,'Producto prueba',$3,$4,$5,$6)`, [cuentaId, NEG, cantidad, precio, estado, USUARIO]);
}
async function abono(cuentaId, metodo, monto, propina = 0) {
  await pool.query(
    `INSERT INTO restaurante_cuenta_pagos (cuenta_id, negocio_id, metodo, monto, propina, registrado_por)
     VALUES ($1,$2,$3,$4,$5,$6)`, [cuentaId, NEG, metodo, monto, propina, USUARIO]);
}
async function fijarPropinasEnEfectivo(valor) {
  if (valor === null) {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG, CLAVE_PROPINAS_TARJETA_EFECTIVO]);
    return;
  }
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`, [NEG, CLAVE_PROPINAS_TARJETA_EFECTIVO, valor]);
}

// La configuración de propinas del negocio A se fotografía y se restaura: otra
// suite (o una persona) pudo haberla dejado puesta.
const { rows: [cfgPrevia] } = await pool.query(
  `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG, CLAVE_PROPINAS_TARJETA_EFECTIVO]);

try {
  await limpiar();
  await fijarPropinasEnEfectivo(null);

  // ── Unidades puras ────────────────────────────────────────────────────────
  await t('U1. detecta Rappi por la convención del mostrador, por canal y por forma de pago', () => {
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'RAPPI 9420' } })?.clave, 'rappi');
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'rappi 0745' } })?.clave, 'rappi');
    assert.strictEqual(plataformaDePedido({ canal: 'rappi', cliente: { nombre: 'JORGE ANDRES' } })?.clave, 'rappi');
    assert.strictEqual(plataformaDePedido({ forma_pago: 'Rappi' })?.clave, 'rappi');
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'Juan Pérez' }, canal: 'pos' }), null);
  });

  await t('U2. queda lista para Uber Eats y DiDi Food, sin confundir un apodo con una plataforma', () => {
    assert.deepStrictEqual(PLATAFORMAS.map(p => p.clave), ['rappi', 'uber_eats', 'didi_food']);
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'UBER 1234' } })?.clave, 'uber_eats');
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'Uber Eats #88' } })?.clave, 'uber_eats');
    assert.strictEqual(plataformaDePedido({ canal: 'didi_food' })?.clave, 'didi_food');
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'DIDI 4455' } })?.clave, 'didi_food');
    // "Didi" y "Uberto" son nombres de gente: no son plataformas.
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'Didi Pérez' } }), null);
    assert.strictEqual(plataformaDePedido({ cliente: { nombre: 'Uberto Salas' } }), null);
  });

  await t('U3. un Rappi cobrado en el mostrador (efectivo o terminal) se concilia donde entró el dinero', () => {
    const rappi = PLATAFORMAS[0];
    assert.strictEqual(claseDeVenta('enlace de pago', rappi), 'plataformas');
    assert.strictEqual(claseDeVenta(null, rappi), 'plataformas');
    assert.strictEqual(claseDeVenta('efectivo', rappi), 'efectivo');
    assert.strictEqual(claseDeVenta('terminal (tarjeta presente)', rappi), 'tarjeta');
    assert.strictEqual(claseDeVenta('enlace de pago', null), 'enlace');
  });

  await t('U4. un cobro mixto se reparte solo si sus partes cuadran con el total', () => {
    assert.deepStrictEqual(partesDelCobro({ forma_pago: 'mixto', mixto_efectivo: 300, mixto_terminal: 150 }, 400),
      [{ clase: 'efectivo', monto: 250 }, { clase: 'tarjeta', monto: 150 }], 'el cambio sale del efectivo');
    assert.deepStrictEqual(partesDelCobro({ forma_pago: 'mixto', pagos: [
      { metodo: 'efectivo', monto: 465 }, { metodo: 'terminal', monto: 134, propina: 20 }] }, 599),
      [{ clase: 'efectivo', monto: 465 }, { clase: 'tarjeta', monto: 134 }]);
    assert.strictEqual(partesDelCobro({ forma_pago: 'mixto', pagos: [{ metodo: 'efectivo', monto: 100 }] }, 599), null,
      'unas partes que no cuadran no se inventan');
    assert.strictEqual(partesDelCobro({ forma_pago: 'mixto' }, 599), null);
    assert.strictEqual(partesDelCobro({ forma_pago: 'efectivo' }, 599), null);
  });

  await t('U5. las propinas se separan por el medio con que se pagaron, sin contarlas dos veces', () => {
    const r = propinasPorClase({ propinas: 50, pagos: [
      { metodo: 'terminal', monto: 300, propina: 30 }, { metodo: 'efectivo', monto: 100, propina: 20 }] });
    assert.strictEqual(r.tarjeta, 30);
    assert.strictEqual(r.efectivo, 20);
    assert.strictEqual(propinasPorClase({ forma_pago: 'terminal', propina: 12.5 }).tarjeta, 12.5);
  });

  await t('U6. una venta en $0 dice qué fue: cortesía, cancelada o sin consumo', () => {
    const cortesia = estadoVentaSinCobro({ datos: { subtotal: 185, descuento: 185, canal: 'pos' }, total: 0 });
    assert.deepStrictEqual([cortesia.estado_cuenta, cortesia.monto_real], ['cortesia', 185]);
    const vacia = estadoVentaSinCobro({ datos: { canal: 'restaurante_mesa', items: [] }, total: 0, items: null });
    assert.deepStrictEqual([vacia.estado_cuenta, vacia.detalle_cuenta], ['cancelada', 'sin consumo']);
    const todoCancelado = estadoVentaSinCobro({ datos: { canal: 'restaurante_mesa', items: [] }, total: 0,
      items: { n: 2, monto_cancelado: '350.00' } });
    assert.deepStrictEqual([todoCancelado.estado_cuenta, todoCancelado.monto_real], ['cancelada', 350]);
    assert.strictEqual(estadoVentaSinCobro({ datos: { canal: 'pos' }, total: 0 }), null, 'un $0 del POS sin descuento no se inventa');
    assert.strictEqual(estadoVentaSinCobro({ datos: { canal: 'restaurante_mesa' }, total: 10 }), null);
  });

  await t('U7. el conteo por denominaciones tiene que sumar lo contado', () => {
    assert.deepStrictEqual(DENOMINACIONES, [1000, 500, 200, 100, 50, 20]);
    const ok = normalizarArqueo({ modo: 'denominaciones', denominaciones: { 500: 2, 20: '3' }, monedas: 12.5 }, 1072.5);
    assert.deepStrictEqual(ok, { modo: 'denominaciones', denominaciones: { 500: 2, 20: 3 }, monedas: 12.5, total: 1072.5 });
    assert.deepStrictEqual(normalizarArqueo({ modo: 'total' }, 80), { modo: 'total', total: 80 });
    assert.strictEqual(normalizarArqueo({ modo: 'denominaciones' }, null), null, 'sin conteo no hay arqueo');
    for (const [malo, contado] of [
      [{ modo: 'denominaciones', denominaciones: { 500: 2 } }, 900],
      [{ modo: 'denominaciones', denominaciones: { 500: -1 } }, 0],
      [{ modo: 'denominaciones', denominaciones: { 500: 1.5 } }, 750],
      [{ modo: 'denominaciones', denominaciones: { 2000: 1 } }, 2000],
      [{ modo: 'denominaciones', denominaciones: {}, monedas: -5 }, 0],
    ]) {
      assert.throws(() => normalizarArqueo(malo, contado), e => e.code === 'CONTEO_INVALIDO', `aceptó ${JSON.stringify(malo)}`);
    }
  });

  await t('U8. el admin ve el esperado; cualquier otro rol cuenta a ciegas hasta cerrar', () => {
    const vivo = { cerrado: false, efectivo_esperado: 900, ventas_efectivo: 400 };
    assert.strictEqual(vistaCorteParaRol(vivo, 'admin').efectivo_esperado, 900);
    const staff = vistaCorteParaRol(vivo, 'staff');
    assert.strictEqual(staff.efectivo_esperado, null);
    assert.strictEqual(staff.esperado_oculto, true);
    assert.strictEqual(vivo.efectivo_esperado, 900, 'no debe mutar el objeto original');
    assert.strictEqual(vistaCorteParaRol({ cerrado: true, efectivo_esperado: 900 }, 'staff').efectivo_esperado, 900,
      'un corte cerrado ya se contó: se ve completo');
  });

  // ── Fixture: el día de hoy de Obispado, en chico ─────────────────────────
  await pool.query(`INSERT INTO caja_fondos (negocio_id, fecha, fondo) VALUES ($1,$2,500)
    ON CONFLICT (negocio_id, fecha) DO UPDATE SET fondo = EXCLUDED.fondo`, [NEG, D_PLAT]);
  await venta(`CJ-${suf}-E1`, D_PLAT, 9, { total: 735, forma_pago: 'efectivo', cliente: { nombre: 'Cliente mostrador' } });
  await venta(`CJ-${suf}-T1`, D_PLAT, 10, { total: 244, forma_pago: 'terminal (tarjeta presente)', cliente: { nombre: 'C' } });
  await venta(`CJ-${suf}-L1`, D_PLAT, 11, { total: 310, forma_pago: 'enlace de pago', cliente: { nombre: 'Clip real' } });
  await venta(`CJ-${suf}-R1`, D_PLAT, 12, { total: 279, forma_pago: 'enlace de pago', canal: 'pos', cliente: { nombre: 'RAPPI 9420' } });
  await venta(`CJ-${suf}-R2`, D_PLAT, 13, { total: 520, forma_pago: 'enlace_pago', cliente: { nombre: 'RAPPI 5522' } });
  await venta(`CJ-${suf}-R3`, D_PLAT, 14, { total: 150, canal: 'rappi', cliente: { nombre: 'JORGE ANDRES' } });   // integración: sin forma de pago
  await venta(`CJ-${suf}-R4`, D_PLAT, 15, { total: 90, forma_pago: 'efectivo', cliente: { nombre: 'RAPPI 1111' } }); // pagó en el mostrador
  await venta(`CJ-${suf}-U1`, D_PLAT, 16, { total: 200, forma_pago: 'enlace de pago', cliente: { nombre: 'UBER 3321' } });
  await venta(`CJ-${suf}-D1`, D_PLAT, 16, { total: 180, forma_pago: 'enlace de pago', cliente: { nombre: 'Didi Pérez' } }); // persona
  await venta(`CJ-${suf}-M1`, D_PLAT, 17, { total: 400, forma_pago: 'mixto', mixto_efectivo: 300, mixto_terminal: 150, cliente: { nombre: 'Mixto POS' } });
  await venta(`CJ-${suf}-P1`, D_PLAT, 18, { total: 225, forma_pago: 'enlace de pago', pago_confirmado: false, cliente: { nombre: 'Pendiente' } });

  await t('1. Rappi sale de Clip / enlace y tiene su propia naturaleza', async () => {
    const c = await calcularCorteVivo(NEG, D_PLAT);
    assert.strictEqual(c.ventas_enlace, n2(310 + 180), 'en Clip / enlace solo debe quedar el enlace real (y la clienta "Didi")');
    assert.strictEqual(c.ventas_plataformas, n2(279 + 520 + 150 + 200));
    const rappi = c.plataformas.find(p => p.clave === 'rappi');
    assert.deepStrictEqual([rappi.num, rappi.total], [3, 949]);
    assert.deepStrictEqual(c.plataformas.find(p => p.clave === 'uber_eats'), { clave: 'uber_eats', nombre: 'Uber Eats', num: 1, total: 200 });
  });

  await t('2. VENTAS DEL DÍA sigue siendo la suma de todas las naturalezas', async () => {
    const c = await calcularCorteVivo(NEG, D_PLAT);
    const suma = n2(c.ventas_efectivo + c.ventas_tarjeta + c.ventas_enlace + c.ventas_plataformas + c.ventas_otros);
    assert.strictEqual(c.ventas_totales, suma);
    assert.strictEqual(c.ventas_totales, n2(735 + 244 + 310 + 279 + 520 + 150 + 90 + 200 + 180 + 400), 'se perdió o se duplicó una venta');
    assert.strictEqual(c.ventas_otros, 0, 'el Rappi de la integración (sin forma de pago) ya no cae en Otros');
  });

  await t('3. un Rappi cobrado en efectivo se queda en efectivo, marcado como Rappi', async () => {
    const c = await calcularCorteVivo(NEG, D_PLAT);
    const fila = c.pedidos.find(p => p.folio === `CJ-${suf}-R4`);
    assert.strictEqual(fila.clase, 'efectivo');
    assert.strictEqual(fila.plataforma, 'rappi');
  });

  await t('4. el mixto del POS reparte su parte en efectivo al esperado', async () => {
    const c = await calcularCorteVivo(NEG, D_PLAT);
    assert.strictEqual(c.ventas_efectivo, n2(735 + 90 + 250), 'efectivo = 735 + Rappi en mostrador 90 + parte del mixto 250');
    assert.strictEqual(c.ventas_tarjeta, n2(244 + 150));
    assert.strictEqual(c.efectivo_esperado, n2(500 + 735 + 90 + 250));
    const fila = c.pedidos.find(p => p.folio === `CJ-${suf}-M1`);
    assert.strictEqual(fila.clase, 'mixto');
    assert.deepStrictEqual(fila.partes, [{ clase: 'efectivo', monto: 250 }, { clase: 'tarjeta', monto: 150 }]);
  });

  await t('5. lo pendiente se lista con su detalle y no suma a ninguna naturaleza', async () => {
    const c = await calcularCorteVivo(NEG, D_PLAT);
    assert.deepStrictEqual(c.pendiente, { num: 1, total: 225 });
    assert.strictEqual(c.pendientes.length, 1);
    assert.strictEqual(c.pendientes[0].folio, `CJ-${suf}-P1`);
    assert.strictEqual(c.pendientes[0].clase, 'por_cobrar');
    assert.ok(!c.pedidos.some(p => p.folio === `CJ-${suf}-P1`));
  });

  await t('6. fondo registrado vs. nunca registrado', async () => {
    assert.strictEqual((await calcularCorteVivo(NEG, D_PLAT)).fondo_registrado, true);
    const sinFondo = await calcularCorteVivo(NEG, D_MESA);
    assert.strictEqual(sinFondo.fondo_registrado, false);
    assert.strictEqual(sinFondo.fondo_inicial, 0);
  });

  // ── Mesas y propinas ─────────────────────────────────────────────────────
  const cVacia = await cuenta(471, D_MESA, 9);
  await pool.query(`UPDATE restaurante_cuentas SET estado = 'cerrada', cerrada_at = NOW() WHERE id = $1`, [cVacia]);
  await venta(`CJ-${suf}-MV`, D_MESA, 9, { total: 0, subtotal: 0, forma_pago: 'sin pago', canal: 'restaurante_mesa',
    cuenta_id: cVacia, cliente: { nombre: 'Mesa 471' }, items: [] });
  const cCancel = await cuenta(472, D_MESA, 10);
  await item(cCancel, 175, 2, 'cancelado');
  await pool.query(`UPDATE restaurante_cuentas SET estado = 'cerrada', cerrada_at = NOW() WHERE id = $1`, [cCancel]);
  await venta(`CJ-${suf}-MC`, D_MESA, 10, { total: 0, subtotal: 0, forma_pago: 'sin pago', canal: 'restaurante_mesa',
    cuenta_id: cCancel, cliente: { nombre: 'Mesa 472' }, items: [] });
  await venta(`CJ-${suf}-MX`, D_MESA, 11, { total: 0, subtotal: 185, descuento: 185, forma_pago: 'sin pago', canal: 'restaurante_mesa',
    cliente: { nombre: 'Mesa 473' }, items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 185 }] });
  // Venta de mesa pagada mixto con propina en terminal y en efectivo.
  await venta(`CJ-${suf}-MP`, D_MESA, 12, { total: 599, forma_pago: 'mixto', canal: 'restaurante_mesa', cliente: { nombre: 'Mesa 474' },
    propinas: 50, pagos: [{ metodo: 'efectivo', monto: 465, propina: 20 }, { metodo: 'terminal', monto: 134, propina: 30 }] });
  // Cuenta ABIERTA del día con un abono en efectivo, otra abierta de OTRO día
  // y una cancelada a mano.
  const cAbierta = await cuenta(475, D_MESA, 13, { descuento: 50 });
  await item(cAbierta, 400); await item(cAbierta, 100, 1, 'cancelado');
  await abono(cAbierta, 'efectivo', 150);
  await cuenta(476, D_PLAT, 20);
  const cMano = await cuenta(474, D_MESA, 14, { estado: 'cancelada' });
  await item(cMano, 90);

  await t('7. una venta de mesa en $0 dice qué fue, con su monto real', async () => {
    const c = await calcularCorteVivo(NEG, D_MESA);
    const por = (f) => c.pedidos.find(p => p.folio === `CJ-${suf}-${f}`);
    assert.deepStrictEqual([por('MV').estado_cuenta, por('MV').detalle_cuenta, por('MV').monto_real], ['cancelada', 'sin consumo', 0]);
    assert.deepStrictEqual([por('MC').estado_cuenta, por('MC').monto_real], ['cancelada', 350]);
    assert.deepStrictEqual([por('MX').estado_cuenta, por('MX').monto_real], ['cortesia', 185]);
    for (const f of ['MV', 'MC', 'MX']) assert.strictEqual(por(f).clase, 'sin_cobro', `${f} no es dinero`);
    assert.strictEqual(c.ventas_otros, 0, 'un $0 ya no aparece como "Otros"');
  });

  await t('8. la cuenta abierta del día cuenta en Por cobrar por su saldo', async () => {
    const c = await calcularCorteVivo(NEG, D_MESA);
    const abierta = c.cuentas_mesa.find(x => x.cuenta_id === cAbierta);
    assert.deepStrictEqual([abierta.estado_cuenta, abierta.total, abierta.pagado, abierta.saldo], ['abierta', 350, 150, 200],
      'total = consumo vivo 400 − descuento 50; el producto cancelado no cuenta');
    assert.deepStrictEqual(c.cuentas_abiertas, { num: 1, total: 350, pagado: 150, saldo: 200, abonos_efectivo: 150 });
    assert.deepStrictEqual(c.por_cobrar, { num: 1, total: 200 });
    assert.ok(!c.cuentas_mesa.some(x => x.mesa === 476), 'una cuenta abierta de otro día no es de este corte');
    const mano = c.cuentas_mesa.find(x => x.cuenta_id === cMano);
    assert.deepStrictEqual([mano.estado_cuenta, mano.clase, mano.monto_real], ['cancelada', 'sin_cobro', 90]);
  });

  await t('9. el abono en efectivo de una cuenta abierta NO entra al esperado (se informa aparte)', async () => {
    const c = await calcularCorteVivo(NEG, D_MESA);
    assert.strictEqual(c.ventas_efectivo, 465, 'solo la parte en efectivo del mixto de la mesa 474');
    assert.strictEqual(c.efectivo_esperado, 465);
  });

  await t('10. propinas con tarjeta: sin configurar se informan pero no tocan el esperado', async () => {
    const c = await calcularCorteVivo(NEG, D_MESA);
    assert.strictEqual(c.propinas_tarjeta, 30, 'la propina en efectivo (20) no es de tarjeta');
    assert.strictEqual(c.propinas_tarjeta_en_efectivo, false);
    assert.strictEqual(c.propinas_pagadas_efectivo, 0);
    assert.strictEqual(c.efectivo_esperado, 465);
  });

  await t('11. propinas con tarjeta: configuradas "sí", salen del efectivo esperado', async () => {
    await fijarPropinasEnEfectivo('true');
    const c = await calcularCorteVivo(NEG, D_MESA);
    assert.strictEqual(c.propinas_tarjeta_en_efectivo, true);
    assert.strictEqual(c.propinas_pagadas_efectivo, 30);
    assert.strictEqual(c.efectivo_esperado, 435, '465 − 30 de propina pagada al mesero desde la caja');
    await fijarPropinasEnEfectivo('false');
    assert.strictEqual((await calcularCorteVivo(NEG, D_MESA)).efectivo_esperado, 465, '"no" vuelve a dejarlo igual');
  });

  // ── Cierre ───────────────────────────────────────────────────────────────
  await pool.query(`INSERT INTO caja_fondos (negocio_id, fecha, fondo) VALUES ($1,$2,300)
    ON CONFLICT (negocio_id, fecha) DO UPDATE SET fondo = EXCLUDED.fondo`, [NEG, D_CIERRE]);
  await venta(`CJ-${suf}-C1`, D_CIERRE, 12, { total: 1000, forma_pago: 'efectivo', cliente: { nombre: 'X' } });
  await venta(`CJ-${suf}-C2`, D_CIERRE, 13, { total: 205, forma_pago: 'enlace de pago', cliente: { nombre: 'RAPPI 5431' } });

  await t('12. cerrar con denominaciones guarda fondo, esperado, contado, diferencia, usuario, hora y el conteo', async () => {
    const { corte } = await cerrarCorte(NEG, {
      fecha: D_CIERRE, efectivoContado: 1290, usuarioId: USUARIO, rol: 'admin',
      arqueo: { modo: 'denominaciones', denominaciones: { 1000: 1, 200: 1, 50: 1, 20: 2 }, monedas: 0 },
    });
    assert.strictEqual(Number(corte.fondo_inicial), 300);
    assert.strictEqual(Number(corte.efectivo_esperado), 1300);
    assert.strictEqual(Number(corte.efectivo_contado), 1290);
    assert.strictEqual(Number(corte.diferencia), -10);
    assert.strictEqual(corte.usuario_id, USUARIO);
    assert.ok(corte.cerrado_at, 'falta la hora de cierre');
    const s = corte.snapshot_json;
    assert.deepStrictEqual(s.arqueo, { modo: 'denominaciones', denominaciones: { 1000: 1, 200: 1, 50: 1, 20: 2 },
      monedas: 0, total: 1290, a_ciegas: false, rol: 'admin' });
    assert.strictEqual(s.ventas_plataformas, 205, 'el snapshot conserva Plataformas');
    assert.strictEqual(Number(corte.ventas_enlace), 0, 'el Rappi no se firmó como enlace');
    assert.strictEqual(Number(corte.ventas_totales), 1205);
  });

  await t('13. un conteo que no suma lo contado se rechaza y no deja corte', async () => {
    await venta(`CJ-${suf}-X1`, D_MALO, 12, { total: 100, forma_pago: 'efectivo', cliente: { nombre: 'X' } });
    await assert.rejects(() => cerrarCorte(NEG, { fecha: D_MALO, efectivoContado: 900, usuarioId: USUARIO, rol: 'admin',
      arqueo: { modo: 'denominaciones', denominaciones: { 500: 2 } } }), e => e.code === 'CONTEO_INVALIDO');
    assert.strictEqual(await obtenerCorteCerrado(NEG, D_MALO), null, 'quedó un corte con un conteo que no cuadra');
    // Solo total y "sin contar" siguen funcionando igual que antes.
    const { corte } = await cerrarCorte(NEG, { fecha: D_MALO, efectivoContado: 100, usuarioId: USUARIO, rol: 'admin', arqueo: { modo: 'total' } });
    assert.deepStrictEqual(corte.snapshot_json.arqueo, { modo: 'total', total: 100, a_ciegas: false, rol: 'admin' });
  });

  await t('14. quien no es admin cuenta a ciegas y el corte lo registra', async () => {
    await venta(`CJ-${suf}-Z1`, D_CIEGO, 12, { total: 60, forma_pago: 'efectivo', cliente: { nombre: 'X' } });
    const { corte } = await cerrarCorte(NEG, { fecha: D_CIEGO, efectivoContado: 60, usuarioId: USUARIO, rol: 'staff',
      arqueo: { modo: 'total' } });
    assert.strictEqual(corte.snapshot_json.arqueo.a_ciegas, true);
  });

  await t('15. histórico y ticket muestran Plataformas y el conteo, y caben en 32 columnas', async () => {
    const lista = await listarCortes(NEG, { limite: 400 });
    const fila = lista.find(c => new Date(c.fecha_operativa).toISOString().slice(0, 10) === D_CIERRE);
    assert.strictEqual(Number(fila.ventas_plataformas), 205);
    const ticket = ticketCorte(await obtenerCorteCerrado(NEG, D_CIERRE), { negocioNombre: 'Mapolato' });
    assert.match(ticket, /Plataformas\s+\$205\.00/);
    assert.match(ticket, /Conteo:/);
    assert.match(ticket, /1 x \$1000\s+\$1,000\.00/);
    assert.match(ticket, /2 x \$20\s+\$40\.00/);
    for (const l of ticket.split('\n')) assert.ok(l.length <= 32, `línea de ${l.length}: "${l}"`);
  });

  await t('16. un corte cerrado ANTES de Plataformas no cambia: ni su histórico ni su ticket', async () => {
    // Se siembra como lo dejaba el código anterior: el Rappi dentro de enlace
    // y un snapshot sin los campos nuevos.
    const snapshotViejo = { timezone: TZ, pedidos: [{ folio: `CJ-${suf}-V1`, clase: 'enlace', total: 279, forma_pago: 'enlace de pago' }] };
    await pool.query(
      `INSERT INTO cortes_caja (negocio_id, fecha_operativa, estado, folio, usuario_id, fondo_inicial, ventas_totales,
         ventas_efectivo, ventas_tarjeta, ventas_enlace, ventas_otros, efectivo_esperado, efectivo_contado, diferencia,
         pedidos_count, snapshot_json)
       VALUES ($1,$2,'cerrado',$3,$4,0,279,0,0,279,0,0,0,0,1,$5::jsonb)`,
      [NEG, D_VIEJO, `COR-V${suf}`, USUARIO, JSON.stringify(snapshotViejo)]);
    const viejo = await obtenerCorteCerrado(NEG, D_VIEJO);
    const lista = await listarCortes(NEG, { limite: 400 });
    const fila = lista.find(c => c.id === viejo.id);
    assert.strictEqual(Number(fila.ventas_plataformas), 0);
    assert.strictEqual(Number(fila.ventas_enlace), 279, 'se reclasificó historia cerrada');
    const ticket = ticketCorte(viejo);
    assert.ok(!/Plataformas/.test(ticket), 'reimprimir un corte viejo cambió su papel');
    assert.ok(!/Conteo:/.test(ticket));
    assert.strictEqual(ticketCorte(viejo), ticket);
  });

  // ── Contrato de las rutas ────────────────────────────────────────────────
  await t('17. la ruta de Caja pasa el rol y el conteo, y responde 400 a un conteo inválido', () => {
    const get = SERVIDOR.slice(SERVIDOR.indexOf("app.get('/api/corte-caja',"), SERVIDOR.indexOf("app.get('/api/corte-caja/historial'"));
    assert.match(get, /vistaCorteParaRol\(\{[\s\S]*\}, req\.rol\)/, 'el corte vivo debe pasar por la vista del rol');
    assert.match(get, /ventas_plataformas: Number\(s\.ventas_plataformas\) \|\| 0/, 'un corte cerrado debe leer Plataformas del snapshot');
    const cerrar = SERVIDOR.slice(SERVIDOR.indexOf("app.post('/api/corte-caja/cerrar'"), SERVIDOR.indexOf("app.get('/api/corte-caja/:fecha/ticket'"));
    assert.match(cerrar, /arqueo: req\.body\?\.arqueo \|\| null/);
    assert.match(cerrar, /rol: req\.rol \|\| null/);
    assert.match(cerrar, /CONTEO_INVALIDO/);
    // Y la Caja sigue siendo solo de admin.
    for (const ruta of ["app.get('/api/corte-caja',", "app.post('/api/corte-caja/cerrar',"]) {
      assert.ok(SERVIDOR.includes(`${ruta} requireAdminSeguro`), `${ruta} dejó de exigir admin`);
    }
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  await limpiar();
  await fijarPropinasEnEfectivo(cfgPrevia ? cfgPrevia.valor : null).catch(() => {});
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
