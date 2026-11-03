// Dólares en Mesas (migración 126, aprobada por Mario el 3-nov-2026).
//
// Lo que esta suite protege:
//   1. Un pago de mesa en dólares solo entra con los dólares encendidos y al
//      tipo de cambio del servidor; billetes enteros; el abono y la propina
//      van en pesos y los cubre lo que dio el cliente (USD + pesos); el
//      cambio, en pesos; si los pesos solos cubren, se rechaza.
//   2. Funciona igual en un abono suelto, en la división por consumo y en
//      partes iguales, y un reverso lo deshace.
//   3. Al cerrar, la venta lleva el detalle en dólares en su renglón de
//      `pagos`, y la Caja suma los dólares, los pesos, el cambio y saca del
//      cajón de pesos la propina (que se le paga al mesero en pesos).
//   4. Los dólares abonados a una mesa abierta se avisan en la Caja.
//   5. El ticket PAGADO dice los dólares con lo que el Edge instalado ya
//      imprime (la etiqueta del pago y el cambio).
//   6. La base no acepta un renglón en dólares sin sus dólares, ni dólares
//      en un renglón que no es en dólares.
//
// Uso: mismas env vars que la batería. Aplica la 125 y la 126 al arrancar.
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const MESAS_HTML = readFileSync(join(RAIZ, 'panel', 'mesas.html'), 'utf8');
const PANEL = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
const PUERTO = process.env.TEST_PORT_MESAS_DOLARES || process.env.TEST_PORT || '4238';

const { pool } = await import('../src/services/database.js');
await pool.query(readFileSync(join(RAIZ, 'migrations', '125_pos_dolares.sql'), 'utf8'));
await pool.query(readFileSync(join(RAIZ, 'migrations', '126_mesas_dolares.sql'), 'utf8'));
await pool.query(readFileSync(join(RAIZ, 'migrations', '126_mesas_dolares.sql'), 'utf8'));   // idempotente

const {
  abrirMesa, agregarItems, enviarComanda, registrarPago, cerrarCuenta, obtenerCuenta, construirTicketCuenta,
  cobrarConsumo, cobrarParteIgual, revertirCobro, estadoDivision,
} = await import('../src/services/restauranteService.js');
const { calcularCorteVivo, ticketCorte } = await import('../src/services/cortesCaja.js');
const { dolaresDeVenta } = await import('../src/services/dolares.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { renderCuenta } = await import('../edge/renderers/index.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const codigo = (c) => (e) => { assert.strictEqual(e.code, c, `se esperaba ${c} y llegó ${e.code} (${e.message})`); return true; };

const A = SEED.negocioA;
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const STAFF_A = SEED.staffNegocioAUsuarioId;
const TC = 17;
const MESAS = [120, 140];   // mesas propias de esta suite

await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'restaurante','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [A]);
for (const tipo of ['efectivo', 'terminal']) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,true)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = true`, [A, tipo]);
}
await pool.query(`UPDATE restaurante_cuentas SET estado = 'cancelada' WHERE negocio_id = $1 AND estado = 'abierta' AND mesa_numero BETWEEN $2 AND $3`, [A, ...MESAS]);

// La bitácora de dólares del negocio A se aparta y se repone al final.
const { rows: respaldoUsd } = await pool.query(
  `SELECT activo, tipo_cambio, usuario_id, created_at FROM dolares_tipo_cambio WHERE negocio_id = $1 ORDER BY id`, [A]);
const ponerDolares = async (activo, tc = TC) => {
  await pool.query(`DELETE FROM dolares_tipo_cambio WHERE negocio_id = $1`, [A]);
  await pool.query(`INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio) VALUES ($1,$2,$3)`, [A, activo, tc]);
};

let mesaLibre = MESAS[0];
const ventas = [];
async function nuevaCuenta(precio = 179, cantidad = 1, producto = 'Hotcakes de Sarten') {
  const cta = await abrirMesa(A, { mesaNumero: mesaLibre++, personas: 2, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(cta.id, A, [{ producto, cantidad, precio_unitario: precio }], STAFF_A);
  await enviarComanda(cta.id, A, STAFF_A);
  return cta.id;
}
const usd = (monto, dolares, pesos = 0, extra = {}) =>
  ({ metodo: 'dolares', monto, usd: dolares, pesos, tipo_cambio_visto: TC, ...extra });
const filasPago = async (cuentaId) => (await pool.query(
  `SELECT metodo, monto::float8 AS monto, propina::float8 AS propina, recibido, cambio::float8 AS cambio,
          usd, tipo_cambio::float8 AS tipo_cambio, pesos_mxn::float8 AS pesos_mxn, revertido_at
     FROM restaurante_cuenta_pagos WHERE cuenta_id = $1 ORDER BY created_at, id`, [cuentaId])).rows;

let srv = null;
try {
  // ── 1. Abono suelto ───────────────────────────────────────────────────────
  await t('M1. con los dólares apagados no se registra un pago de mesa en dólares', async () => {
    await ponerDolares(false);
    const c = await nuevaCuenta();
    await assert.rejects(() => registrarPago(c, A, usd(179, 11), STAFF_A), codigo('DOLARES_APAGADOS'));
    assert.deepStrictEqual(await filasPago(c), [], 'quedó un pago');
  });

  await ponerDolares(true);
  let cuentaCombinada = null;
  await t('M2. abono de $179 con USD 5 + $100 a $17: cambio $6 y el renglón guarda dólares, tipo de cambio y pesos', async () => {
    cuentaCombinada = await nuevaCuenta();
    const r = await registrarPago(cuentaCombinada, A, usd(179, 5, 100), STAFF_A);
    assert.deepStrictEqual([r.cambio, r.saldoRestante, r.recibido], [6, 0, null]);
    const [fila] = await filasPago(cuentaCombinada);
    assert.deepStrictEqual(
      [fila.metodo, fila.monto, fila.cambio, fila.usd, fila.tipo_cambio, fila.pesos_mxn, fila.recibido],
      ['dolares', 179, 6, 5, 17, 100, null]);
  });

  await t('M3. se rechaza: otro tipo de cambio en pantalla, centavos de dólar, pesos que cubren solos, faltante y «recibido»', async () => {
    const c = await nuevaCuenta();
    await assert.rejects(() => registrarPago(c, A, usd(179, 11, 0, { tipo_cambio_visto: 18 }), STAFF_A),
      (e) => e.code === 'TIPO_CAMBIO_CAMBIO' && e.detalle?.tipo_cambio === 17);
    await assert.rejects(() => registrarPago(c, A, usd(179, 10.5), STAFF_A), codigo('DOLARES_INVALIDOS'));
    await assert.rejects(() => registrarPago(c, A, usd(179, 5, 200), STAFF_A), codigo('PESOS_CUBREN_SOLOS'));
    await assert.rejects(() => registrarPago(c, A, usd(179, 10), STAFF_A), (e) => e.code === 'DOLARES_NO_CUBREN' && e.necesarios === 11);
    await assert.rejects(() => registrarPago(c, A, usd(179, 11, 0, { recibido: 200 }), STAFF_A), codigo('MONTO_INVALIDO'));
    assert.deepStrictEqual(await filasPago(c), [], 'un rechazo dejó un pago');
  });

  await t('M4. la propina va en pesos y la cubren los dólares: $200 + $20 de propina con USD 13 → cambio $1', async () => {
    const c = await nuevaCuenta(200);
    await assert.rejects(() => registrarPago(c, A, usd(200, 12, 0, { propina: 20 }), STAFF_A), codigo('DOLARES_NO_CUBREN'),
      'USD 12 ($204) cubren el abono pero no la propina');
    const r = await registrarPago(c, A, usd(200, 13, 0, { propina: 20 }), STAFF_A);
    assert.strictEqual(r.cambio, 1);
  });

  // ── 2. División ───────────────────────────────────────────────────────────
  await t('M5. división por consumo: una persona paga su parte en dólares y otra con terminal', async () => {
    const c = await abrirMesa(A, { mesaNumero: mesaLibre++, personas: 2, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
    await agregarItems(c.id, A, [
      { producto: 'Hotcakes', cantidad: 1, precio_unitario: 179 },
      { producto: 'Cafe', cantidad: 1, precio_unitario: 45 },
    ], STAFF_A);
    await enviarComanda(c.id, A, STAFF_A);
    const div = await estadoDivision(c.id, A);
    const renglon = (n) => div.renglones.find(r => r.producto === n);
    const a = await cobrarConsumo(c.id, A, { seleccion: [{ itemId: renglon('Hotcakes').id, cantidad: 1 }], pagos: [usd(179, 11)] }, ADMIN_A);
    assert.deepStrictEqual([a.importe, a.cambio], [179, 8], 'USD 11 a $17 = $187 → $8');
    assert.strictEqual(a.pagos[0].usd, 11);
    const b = await cobrarConsumo(c.id, A, { seleccion: 'resto', pagos: [{ metodo: 'terminal', monto: 45 }] }, ADMIN_A);
    assert.strictEqual(b.saldoRestante, 0);
    await assert.rejects(() => cobrarConsumo(c.id, A, { seleccion: 'resto', pagos: [usd(1, 1)] }, ADMIN_A));
    ventas.push((await cerrarCuenta(c.id, A, ADMIN_A)).ventaFolio);
  });

  await t('M6. partes iguales en dólares, y revertir ese cobro lo deshace', async () => {
    const c = await nuevaCuenta(340);
    const p1 = await cobrarParteIgual(c, A, { partes: 2, pagos: [usd(170, 10)] }, ADMIN_A);
    assert.strictEqual(p1.cambio, 0, 'USD 10 a $17 = $170 exactos');
    const cta = await obtenerCuenta(c, A);
    assert.strictEqual(cta.saldo, 170);
    await revertirCobro(c, A, p1.cobroId, { usuarioId: ADMIN_A, motivo: 'prueba de reverso' });
    const despues = await obtenerCuenta(c, A);
    assert.deepStrictEqual([despues.saldo, despues.pagos.length], [340, 0]);
    assert.ok((await filasPago(c))[0].revertido_at, 'el pago no quedó revertido');
  });

  // ── 3. Cierre, Caja y ticket ──────────────────────────────────────────────
  await t('M7. una mesa abierta con dólares abonados se avisa en la Caja', async () => {
    const c = await nuevaCuenta(100);
    const antes = (await calcularCorteVivo(A)).cuentas_abiertas.abonos_usd || 0;
    await registrarPago(c, A, usd(60, 4), STAFF_A);
    const despues = (await calcularCorteVivo(A)).cuentas_abiertas.abonos_usd || 0;
    assert.strictEqual(despues - antes, 4);
  });

  await t('M8. al cerrar, la venta lleva los dólares en su renglón y la Caja los suma; la propina sale de los pesos', async () => {
    const antes = await calcularCorteVivo(A);
    const c = await nuevaCuenta(200);
    await registrarPago(c, A, usd(150, 11, 0, { propina: 20 }), STAFF_A);             // $187 cubren 150 + 20: cambio 17
    await registrarPago(c, A, { metodo: 'efectivo', monto: 50, recibido: 100 }, STAFF_A);
    const r = await cerrarCuenta(c, A, ADMIN_A);
    ventas.push(r.ventaFolio);
    const { rows: [venta] } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [r.ventaFolio]);
    assert.strictEqual(venta.datos.forma_pago, 'mixto');
    const lineaUsd = venta.datos.pagos.find(p => p.metodo === 'dolares');
    assert.deepStrictEqual([lineaUsd.usd, lineaUsd.equivalente_mxn, lineaUsd.tipo_cambio, lineaUsd.propina, lineaUsd.cambio], [11, 187, 17, 20, 17]);
    assert.strictEqual(venta.datos.cambio, 50, 'el cambio del efectivo no se mezcla con el de los dólares');
    assert.deepStrictEqual(dolaresDeVenta(venta.datos), { usd: 11, tipo_cambio: 17, equivalente_mxn: 187, pesos_mxn: 0, cambio: 17, propina: 20 });
    const despues = await calcularCorteVivo(A);
    const delta = (k) => Math.round(((despues.dolares[k] || 0) - (antes.dolares[k] || 0)) * 100) / 100;
    assert.deepStrictEqual([delta('recibidos_usd'), delta('cambio_mxn'), delta('propinas_mxn')], [11, 17, 20]);
    assert.strictEqual(Math.round((despues.ventas_dolares - antes.ventas_dolares) * 100) / 100, 150);
    assert.strictEqual(Math.round((despues.ventas_efectivo - antes.ventas_efectivo) * 100) / 100, 50);
    // pesos: + 50 de la venta en efectivo − 17 de cambio de los dólares − 20 de propina pagada al mesero en pesos
    assert.strictEqual(Math.round((despues.efectivo_esperado - antes.efectivo_esperado) * 100) / 100, 13);
    const fila = despues.pedidos.find(p => p.folio === r.ventaFolio);
    assert.deepStrictEqual([fila.clase, fila.dolares?.usd], ['mixto', 11]);
  });

  await t('M9. venta de mesa solo en dólares con pesos: entran $100, sale $6 de cambio', async () => {
    const antes = await calcularCorteVivo(A);
    const r = await cerrarCuenta(cuentaCombinada, A, ADMIN_A);
    ventas.push(r.ventaFolio);
    const despues = await calcularCorteVivo(A);
    assert.strictEqual(despues.pedidos.find(p => p.folio === r.ventaFolio)?.clase, 'dolares');
    assert.strictEqual(Math.round((despues.efectivo_esperado - antes.efectivo_esperado) * 100) / 100, 94);
    assert.strictEqual(despues.dolares.recibidos_usd - antes.dolares.recibidos_usd, 5);
  });

  await t('M10. el ticket PAGADO dice los dólares y el cambio con lo que el Edge ya imprime', async () => {
    const ticket = construirTicketCuenta(await obtenerCuenta(cuentaCombinada, A), { negocio: 'Prueba' });
    assert.deepStrictEqual([ticket.pagos[0].metodo, ticket.efectivoRecibido, ticket.cambio],
      ['Dólares USD 5 + $100.00 a $17.00', 185, 6]);
    const papel = renderCuenta(ticket).toString('latin1');
    for (const texto of ['Dólares USD 5 + $100.00 a $17.00', 'Efectivo recibido', 'Cambio', '$6.00']) {
      assert.ok(papel.includes(texto), `el papel del Edge no dice «${texto}»`);
    }
  });

  await t('M11. el ticket del corte suma las propinas de mesas pagadas en dólares', () => {
    const papel = ticketCorte({
      folio: 'COR-T', fecha_operativa: '2025-01-01', cerrado_at: new Date().toISOString(), pedidos_count: 1,
      ventas_efectivo: 0, ventas_tarjeta: 0, ventas_enlace: 0, ventas_otros: 0, ventas_totales: 150,
      fondo_inicial: 0, entradas: 0, retiros: 0, gastos: 0, devoluciones_efectivo: 0, efectivo_esperado: -20,
      efectivo_contado: null, diferencia: 0, cancelaciones_count: 0,
      snapshot_json: { ventas_dolares: 150, dolares: { pedidos: 1, recibidos_usd: 10, esperado_usd: 10, pesos_mxn: 0, cambio_mxn: 0, propinas_mxn: 20 }, arqueo_dolares: null },
    });
    assert.ok(/Propinas de dolares\s+\$20\.00/.test(papel), papel);
  });

  await t('M12. la base no acepta un renglón en dólares sin sus dólares, ni dólares en otro método', async () => {
    const c = await nuevaCuenta(10);
    const ins = `INSERT INTO restaurante_cuenta_pagos (cuenta_id, negocio_id, metodo, monto, registrado_por, usd, tipo_cambio)
                 VALUES ($1,$2,$3,10,$4,$5,$6)`;
    await assert.rejects(() => pool.query(ins, [c, A, 'dolares', STAFF_A, null, null]), (e) => e.code === '23514');
    await assert.rejects(() => pool.query(ins, [c, A, 'efectivo', STAFF_A, 1, 17]), (e) => e.code === '23514');
  });

  // ── 4. Rutas ──────────────────────────────────────────────────────────────
  srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 60000 });
  const cookie = (u, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: A, rol }))}`;
  const api = async (ruta, { metodo = 'GET', body, galleta = cookie(STAFF_A, 'staff') } = {}) => {
    const r = await fetch(srv.base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Cookie: galleta },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, d: await r.json().catch(() => ({})) };
  };

  await t('H1. la caja de Restaurante lee los dólares; el pago por HTTP rechaza otro tipo de cambio con el vigente', async () => {
    const cfg = await api('/api/restaurante/dolares');
    assert.deepStrictEqual([cfg.status, cfg.d.activo, cfg.d.tipo_cambio], [200, true, 17]);
    const c = await nuevaCuenta();
    const mal = await api(`/api/restaurante/cuentas/${c}/pagos`, { metodo: 'POST', body: usd(179, 11, 0, { tipo_cambio_visto: 18 }) });
    assert.deepStrictEqual([mal.status, mal.d.code, mal.d.detalle?.tipo_cambio], [409, 'TIPO_CAMBIO_CAMBIO', 17]);
    const bien = await api(`/api/restaurante/cuentas/${c}/pagos`, { metodo: 'POST', body: usd(179, 11) });
    assert.deepStrictEqual([bien.status, bien.d.cambio], [200, 8]);
  });

  await t('H2. cobro por consumo en dólares por HTTP', async () => {
    const c = await nuevaCuenta(90, 2, 'Molletes');
    const div = await api(`/api/restaurante/cuentas/${c}/division`);
    const r = await api(`/api/restaurante/cuentas/${c}/cobros-consumo`, { metodo: 'POST',
      body: { seleccion: [{ itemId: div.d.renglones[0].id, cantidad: 1 }], pagos: [usd(90, 5, 10)] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.d));
    assert.strictEqual(r.d.cambio, 5, 'USD 5 = $85 + $10 = $95 de $90');
  });

  // ── 5. Pantallas y guardas ────────────────────────────────────────────────
  await t('P1. Mesas: la opción Dólares nace oculta, cada nombre nuevo es único y el pago manda el tipo de cambio visto', () => {
    assert.match(MESAS_HTML, /<option value="dolares" id="pg-op-dolares" hidden disabled>/);
    for (const n of ['DOLARES_MESA', 'cargarDolaresMesa', 'calculoDolaresMesa', 'textoPagoMesa']) {
      const veces = (MESAS_HTML.match(new RegExp(`(?:function|const|let|var)\\s+${n}\\b`, 'g')) || []).length;
      assert.strictEqual(veces, 1, `${n} declarado ${veces} veces`);
    }
    assert.match(MESAS_HTML, /tipo_cambio_visto: DOLARES_MESA\.tipo_cambio/);
    assert.match(MESAS_HTML, /fetch\('\/api\/restaurante\/dolares'/);
    assert.match(PANEL, /\$\{usdTexto\(data\.cuentas_abiertas\.abonos_usd\)\} abonados a cuentas de mesa/, 'la Caja no avisa los dólares abonados');
  });

  await t('G1. el predeploy corre la 126 después de la 125', () => {
    const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const i125 = runner.indexOf("'125-pos-dolares'"), i126 = runner.indexOf("'126-mesas-dolares'");
    assert.ok(i125 > 0 && i126 > i125, 'la 126 no está en el predeploy, o va antes de la 125');
  });

  await t('G2. el bot y la tienda en línea siguen sin leer dólares', () => {
    const archivos = ['agent', 'channels', 'mesero-agente', 'mesero-whatsapp'].flatMap(dir =>
      readdirSync(join(RAIZ, 'src', dir)).filter(a => a.endsWith('.js')).map(a => join('src', dir, a)));
    for (const a of archivos) assert.ok(!/dolares\.js|pago_dolares|'dolares'/.test(readFileSync(join(RAIZ, a), 'utf8')), `${a} lee dólares`);
  });
} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (srv) srv.detener();
  await pool.query(`UPDATE restaurante_cuentas SET estado = 'cancelada' WHERE negocio_id = $1 AND estado = 'abierta' AND mesa_numero BETWEEN $2 AND $3`, [A, ...MESAS]).catch(() => {});
  if (ventas.length) await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio = ANY($2::text[])`, [A, ventas]).catch(() => {});
  await pool.query(`DELETE FROM dolares_tipo_cambio WHERE negocio_id = $1`, [A]).catch(() => {});
  for (const r of respaldoUsd) {
    await pool.query(`INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio, usuario_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [A, r.activo, r.tipo_cambio, r.usuario_id, r.created_at]).catch(() => {});
  }
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
