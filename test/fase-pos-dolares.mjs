// Dólares en el mostrador — Fase 1 (aprobada por Mario el 2-nov-2026).
//
// Lo que esta suite protege:
//   1. El tipo de cambio se lee sin adivinar («17,50» sí, «1,750.00» no), en
//      su rango, y los dólares van en billetes enteros.
//   2. La bitácora (125): sin renglones nadie acepta dólares; cada cambio es
//      un renglón; un salto de más de 10 % pide confirmación; se sabe qué tipo
//      de cambio estaba vigente a cierta hora. 'dolares' queda reservada en
//      formas_cobro.
//   3. La Caja: la venta suma en pesos, el cambio en pesos SALE del efectivo
//      esperado, los dólares se esperan y se cuentan en dólares, y nada de eso
//      cae en «Efectivo».
//   4. La ruta de cobro: apagados no se cobra; el tipo de cambio lo pone el
//      servidor y rechaza el que la pantalla no mostró; los dólares deben
//      cubrir el total; el pedido guarda su tipo de cambio.
//   5. ✏️ Pago: a dólares con el tipo de cambio de la HORA DEL COBRO, y de
//      vuelta sin dejar detalle ni cambio.
//   6. Factura 01, el panel hace la misma cuenta que el servidor, y el bot y
//      la tienda no leen dólares.
//
// Uso: mismas env vars que la batería. La suite aplica la 125 al arrancar
// (idempotente) y restaura la bitácora de los negocios A y B al terminar.
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const MIGRACION = readFileSync(join(RAIZ, 'migrations', '125_pos_dolares.sql'), 'utf8');
const PANEL = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
const PUERTO = process.env.TEST_PORT_POS_DOLARES || process.env.TEST_PORT || '4237';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const D = await import('../src/services/dolares.js');
const {
  calcularCorteVivo, cerrarCorte, clasificarFormaPago, propinasPorClase, vistaCorteParaRol, ticketCorte,
  obtenerCorteCerrado, rangoUtcDeFecha,
} = await import('../src/services/cortesCaja.js');
const { mapFormaPago } = await import('../src/services/facturapi.js');
const { formaPagoSatDeVenta } = await import('../src/services/formaPagoSat.js');
const { formaPagoDeVenta } = await import('../src/services/autofacturaEmision.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const codigo = (c) => (e) => { assert.strictEqual(e.code, c, `se esperaba ${c} y llegó ${e.code} (${e.message})`); return true; };

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const TZ = 'America/Matamoros';
const DIA = '2025-08-11';        // días propios: nadie más siembra ventas en agosto de 2025
const DIA_CIERRE = '2025-08-12';
const suf = Date.now().toString().slice(-6);
const cookie = (usuarioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: NEG, rol }))}`;
const ADMIN = cookie(SEED.adminNegocioAUsuarioId, 'admin');
const OPERADOR = cookie(SEED.staffNegocioAUsuarioId, 'staff');

async function del(sql, params) { try { await pool.query(sql, params); } catch { /* ignorado */ } }
function instante(fecha, hora) {
  const { inicio } = rangoUtcDeFecha(fecha, TZ);
  return new Date(inicio.getTime() + hora * 3600000);
}
async function venta(folio, fecha, hora, datos) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos, created_at) VALUES ($1,$2,'entregado',$3::jsonb,$4)`,
    [folio, NEG, JSON.stringify({ pago_confirmado: true, items: [], ...datos }), instante(fecha, hora).toISOString()]);
}
const filasUsd = async (negocioId) => (await pool.query(
  `SELECT activo, tipo_cambio::float8 AS tipo_cambio FROM dolares_tipo_cambio WHERE negocio_id = $1 ORDER BY created_at, id`,
  [negocioId])).rows;

// La 125 es idempotente: aplicarla aquí deja correr la suite en cualquier base.
await pool.query(MIGRACION);
await pool.query(MIGRACION);

// La bitácora de A y B se aparta y se repone al final, tal cual.
const { rows: respaldoUsd } = await pool.query(
  `SELECT negocio_id, activo, tipo_cambio, usuario_id, created_at FROM dolares_tipo_cambio
    WHERE negocio_id = ANY($1::uuid[]) ORDER BY id`, [[NEG, NEG_B]]);
async function vaciarUsd() { await pool.query(`DELETE FROM dolares_tipo_cambio WHERE negocio_id = ANY($1::uuid[])`, [[NEG, NEG_B]]); }

async function limpiar() {
  await del(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE 'USD-%'`, [NEG]);
  await del(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa IN ($2::date, $3::date)`, [NEG, DIA, DIA_CIERRE]);
  await del(`DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha IN ($2::date, $3::date)`, [NEG, DIA, DIA_CIERRE]);
}

let srv = null;
const foliosPOS = [];
try {
  await limpiar();
  await vaciarUsd();

  // ── 1. Lectura y cuentas (puras) ──────────────────────────────────────────
  await t('L1. el tipo de cambio se lee con punto o coma y sin adivinar lo ambiguo', () => {
    for (const [entrada, esperado] of [['17.50', 17.5], ['17,50', 17.5], ['$17.5', 17.5], [' 18 ', 18], [17.5, 17.5], ['17.05', 17.05]]) {
      assert.strictEqual(D.leerTipoCambio(entrada), esperado, `«${entrada}»`);
    }
    for (const malo of ['1,750.00', '17.505', 'diecisiete', '', null, '17.5.0', 17.505, NaN, '-17']) {
      assert.ok(Number.isNaN(D.leerTipoCambio(malo)), `«${malo}» no debió leerse`);
    }
  });

  await t('L2. fuera de $10–$30 se rechaza diciendo lo que se escribió (un cero de más no pasa)', () => {
    assert.strictEqual(D.validarTipoCambio('10'), 10);
    assert.strictEqual(D.validarTipoCambio('30.00'), 30);
    assert.throws(() => D.validarTipoCambio('9.99'), codigo('TIPO_CAMBIO_FUERA_DE_RANGO'));
    assert.throws(() => D.validarTipoCambio('30.01'), codigo('TIPO_CAMBIO_FUERA_DE_RANGO'));
    assert.throws(() => D.validarTipoCambio('175'), (e) => e.code === 'TIPO_CAMBIO_FUERA_DE_RANGO' && /\$175\.00/.test(e.message));
    assert.throws(() => D.validarTipoCambio('1,750.00'), codigo('TIPO_CAMBIO_INVALIDO'));
  });

  await t('L3. los dólares recibidos son billetes enteros, de 1 al tope', () => {
    assert.strictEqual(D.leerDolaresRecibidos(20), 20);
    assert.strictEqual(D.leerDolaresRecibidos('20'), 20);
    for (const malo of [20.5, '20.5', 0, -5, '', null, 'veinte', D.USD_MAX_POR_COBRO + 1]) {
      assert.throws(() => D.leerDolaresRecibidos(malo), codigo('DOLARES_INVALIDOS'), `«${malo}»`);
    }
  });

  await t('L4. el cambio sale en pesos con centavos, y lo que no cubre dice cuántos dólares faltan', () => {
    assert.deepStrictEqual(D.calcularCobroDolares({ total: 350, usd: 30, tipoCambio: 17.5 }),
      { pago_dolares: { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525 }, cambio: 175 });
    assert.deepStrictEqual(D.calcularCobroDolares({ total: 350, usd: 20, tipoCambio: 17.5 }).cambio, 0, 'exacto');
    assert.strictEqual(D.calcularCobroDolares({ total: 345, usd: 30, tipoCambio: 17.35 }).cambio, 175.5);
    assert.throws(() => D.calcularCobroDolares({ total: 351, usd: 20, tipoCambio: 17.5 }),
      (e) => e.code === 'DOLARES_NO_CUBREN' && e.necesarios === 21 && e.faltan === 1);
    assert.strictEqual(D.dolaresParaCubrir(350, 17.5), 20);
    assert.strictEqual(D.dolaresParaCubrir(351, 17.5), 21);
    assert.strictEqual(D.dolaresParaCubrir(520.5, 17.35), 30, '30 × 17.35 = 520.50 exactos');
    assert.strictEqual(D.dolaresParaCubrir(0, 17.5), 0);
  });

  await t('L5. el detalle en dólares de un pedido se lee solo si está completo', () => {
    const bueno = { forma_pago: 'dolares', cambio: 175, pago_dolares: { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525 } };
    assert.deepStrictEqual(D.pagoDolaresDe(bueno), { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525, cambio: 175 });
    assert.strictEqual(D.pagoDolaresDe({ ...bueno, forma_pago: 'efectivo' }), null);
    assert.strictEqual(D.pagoDolaresDe({ forma_pago: 'dolares' }), null);
    assert.strictEqual(D.pagoDolaresDe({ ...bueno, pago_dolares: { usd: 30.5, tipo_cambio: 17.5, equivalente_mxn: 533.75 } }), null);
  });

  // ── 2. Bitácora ───────────────────────────────────────────────────────────
  await t('B1. sin renglones (o sin tabla) los dólares están APAGADOS', async () => {
    assert.deepStrictEqual(await D.configDolares(randomUUID()),
      { activo: false, tipo_cambio: null, actualizado_at: null, actualizado_por: null });
    const roto = { query: async () => { throw new Error('relation "dolares_tipo_cambio" does not exist'); } };
    const r = await D.configDolares(NEG, { ejecutor: roto });
    assert.strictEqual(r.activo, false);
    assert.strictEqual(r.error, true);
    await assert.rejects(() => D.configDolares(''), codigo('TENANT_CONTEXT_REQUIRED'));
  });

  await t('B2. encender pide tipo de cambio; cada cambio es un renglón y guardar lo mismo no escribe', async () => {
    await assert.rejects(() => D.guardarDolares(NEG_B, { activo: true }), codigo('TIPO_CAMBIO_REQUERIDO'));
    await assert.rejects(() => D.guardarDolares(NEG_B, { activo: 'si', tipoCambio: '17.5' }), codigo('ACTIVO_INVALIDO'));
    const r1 = await D.guardarDolares(NEG_B, { activo: true, tipoCambio: '17,50', usuarioId: SEED.adminNegocioAUsuarioId });
    assert.deepStrictEqual([r1.activo, r1.tipo_cambio, r1.sin_cambios], [true, 17.5, false]);
    const r2 = await D.guardarDolares(NEG_B, { activo: true, tipoCambio: '17.50' });
    assert.strictEqual(r2.sin_cambios, true, 'guardar lo mismo escribió');
    await D.guardarDolares(NEG_B, { activo: true, tipoCambio: '18.00' });          // +2.9 %: sin confirmar
    await D.guardarDolares(NEG_B, { activo: false });                               // apagar conserva el tipo
    assert.deepStrictEqual(await filasUsd(NEG_B),
      [{ activo: true, tipo_cambio: 17.5 }, { activo: true, tipo_cambio: 18 }, { activo: false, tipo_cambio: 18 }]);
    const cfg = await D.configDolares(NEG_B);
    assert.deepStrictEqual([cfg.activo, cfg.tipo_cambio], [false, 18]);
    assert.strictEqual((await D.configDolares(NEG)).activo, false, 'el negocio A ve la bitácora del B');
    const hist = await D.historialDolares(NEG_B);
    assert.deepStrictEqual(hist.map(h => [h.activo, h.tipo_cambio]), [[false, 18], [true, 18], [true, 17.5]]);
  });

  await t('B3. un salto de más de 10 % se rechaza hasta confirmarlo', async () => {
    await assert.rejects(() => D.guardarDolares(NEG_B, { activo: true, tipoCambio: '20' }),
      (e) => e.code === 'TIPO_CAMBIO_SALTO' && e.anterior === 18 && e.nuevo === 20);
    assert.strictEqual((await filasUsd(NEG_B)).length, 3, 'el salto sin confirmar escribió');
    const r = await D.guardarDolares(NEG_B, { activo: true, tipoCambio: '20', confirmarSalto: true });
    assert.deepStrictEqual([r.activo, r.tipo_cambio], [true, 20]);
  });

  await t('B4. se sabe qué tipo de cambio estaba vigente a cada hora', async () => {
    await pool.query(`DELETE FROM dolares_tipo_cambio WHERE negocio_id = $1`, [NEG_B]);
    const h0 = new Date('2025-08-11T15:00:00Z');
    await pool.query(
      `INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio, created_at) VALUES
         ($1, true, 17.50, $2), ($1, true, 18.00, $3), ($1, false, 18.00, $4)`,
      [NEG_B, h0.toISOString(), new Date(h0.getTime() + 3600000).toISOString(), new Date(h0.getTime() + 7200000).toISOString()]);
    assert.strictEqual(await D.tipoCambioVigenteEn(NEG_B, new Date(h0.getTime() - 1000)), null, 'antes del primero');
    assert.strictEqual((await D.tipoCambioVigenteEn(NEG_B, new Date(h0.getTime() + 1800000))).tipo_cambio, 17.5);
    assert.strictEqual((await D.tipoCambioVigenteEn(NEG_B, new Date(h0.getTime() + 5400000))).tipo_cambio, 18);
    assert.strictEqual((await D.tipoCambioVigenteEn(NEG_B, new Date(h0.getTime() + 9000000))).tipo_cambio, 18, 'apagados conservan el tipo');
  });

  await t('B5. la 125 reserva «dolares» en formas_cobro: dólares es fija', async () => {
    await assert.rejects(() => pool.query(
      `INSERT INTO formas_cobro (negocio_id, clave, nombre, tarjeta_caja) VALUES ($1,'dolares','Dólares 2','otros')`, [NEG]),
      (e) => e.code === '23514');
    await assert.rejects(() => pool.query(
      `INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio) VALUES ($1, true, NULL)`, [NEG]),
      (e) => e.code === '23514', 'activo sin tipo de cambio');
  });

  // ── 3. La Caja ────────────────────────────────────────────────────────────
  await t('U1. «dolares» es su propia naturaleza, con o sin la lista del negocio', () => {
    assert.strictEqual(clasificarFormaPago('dolares'), 'dolares');
    assert.strictEqual(clasificarFormaPago('DOLARES'), 'dolares');
    assert.strictEqual(clasificarFormaPago('dolares', new Map([['dolares', { tarjeta_caja: 'otros' }]])), 'dolares');
    assert.strictEqual(clasificarFormaPago('efectivo'), 'efectivo', 'el efectivo no cambia');
    const p = propinasPorClase({ forma_pago: 'dolares', propina: 20 });
    assert.ok(Object.values(p).every(Number.isFinite), `propinas con NaN: ${JSON.stringify(p)}`);
  });

  await venta(`USD-${suf}-E`, DIA, 13, { forma_pago: 'efectivo', total: 100, billete: 200, cambio: 100 });
  await venta(`USD-${suf}-D`, DIA, 14, { forma_pago: 'dolares', total: 350, cambio: 175,
    pago_dolares: { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525 } });
  await venta(`USD-${suf}-D2`, DIA, 15, { forma_pago: 'dolares', total: 345, cambio: 175.5,
    pago_dolares: { usd: 30, tipo_cambio: 17.35, equivalente_mxn: 520.5 }, devolucion: { monto: 45, motivo: 'test' } });
  await venta(`USD-${suf}-ROTO`, DIA, 16, { forma_pago: 'dolares', total: 50 });
  await pool.query(`INSERT INTO caja_fondos (negocio_id, fecha, fondo) VALUES ($1,$2,500)
    ON CONFLICT (negocio_id, fecha) DO UPDATE SET fondo = 500`, [NEG, DIA]);

  await t('C1. la venta suma en pesos, el cambio sale del efectivo y los dólares se esperan en dólares', async () => {
    const c = await calcularCorteVivo(NEG, DIA);
    assert.strictEqual(c.ventas_efectivo, 100, 'los dólares cayeron en Efectivo');
    assert.strictEqual(c.ventas_dolares, 745, 'ventas en dólares (en pesos), con la del pedido sin detalle');
    assert.strictEqual(c.ventas_totales, 845);
    assert.deepStrictEqual(
      [c.dolares.pedidos, c.dolares.recibidos_usd, c.dolares.esperado_usd, c.dolares.equivalente_mxn, c.dolares.cambio_mxn],
      [3, 60, 60, 1045.5, 350.5]);
    // fondo 500 + efectivo 100 − devolución 45 (de una venta en dólares: se devuelve en pesos) − cambio 350.50
    assert.strictEqual(c.devoluciones_efectivo, 45);
    assert.strictEqual(c.efectivo_esperado, 204.5);
    const d = c.pedidos.find(p => p.folio === `USD-${suf}-D`);
    assert.deepStrictEqual([d.clase, d.dolares], ['dolares', { usd: 30, tipo_cambio: 17.5, cambio: 175 }]);
  });

  await t('C2. un pedido en dólares sin su detalle se avisa en la Caja', async () => {
    const c = await calcularCorteVivo(NEG, DIA);
    assert.deepStrictEqual(c.dolares.sin_detalle, [`USD-${suf}-ROTO`]);
    assert.ok(c.reporte_financiero.calidad.avisos.some(a => a.includes(`USD-${suf}-ROTO`) && /✏️ Pago/.test(a)),
      'no hay aviso del pedido sin detalle');
  });

  await t('C3. quien cuenta a ciegas tampoco ve los dólares esperados', async () => {
    const c = await calcularCorteVivo(NEG, DIA);
    const ciego = vistaCorteParaRol({ cerrado: false, ...c }, 'staff');
    assert.deepStrictEqual([ciego.efectivo_esperado, ciego.dolares.esperado_usd, ciego.dolares.recibidos_usd], [null, null, null]);
    assert.strictEqual(vistaCorteParaRol({ cerrado: false, ...c }, 'admin').dolares.esperado_usd, 60);
  });

  await t('C4. al cerrar, los dólares contados quedan con su diferencia EN DÓLARES y salen en el ticket', async () => {
    await venta(`USD-${suf}-C`, DIA_CIERRE, 14, { forma_pago: 'dolares', total: 350, cambio: 175,
      pago_dolares: { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525 } });
    await assert.rejects(() => cerrarCorte(NEG, { fecha: DIA_CIERRE, efectivoContado: 0, dolaresContados: 2.5 }),
      codigo('CONTEO_INVALIDO'));
    assert.strictEqual(await obtenerCorteCerrado(NEG, DIA_CIERRE), null, 'un conteo inválido cerró el corte');
    const { corte } = await cerrarCorte(NEG, { fecha: DIA_CIERRE, efectivoContado: 0, dolaresContados: 28 });
    assert.deepStrictEqual(corte.snapshot_json.arqueo_dolares, { contado_usd: 28, esperado_usd: 30, diferencia_usd: -2 });
    assert.strictEqual(Number(corte.efectivo_esperado), -175, 'el cambio no salió del efectivo de un día sin fondo');
    const papel = ticketCorte(corte);
    for (const texto of ['DOLARES', 'USD 30', 'USD 28', 'FALTANTE', 'Cambio de dolares']) {
      assert.ok(papel.includes(texto), `el ticket no dice «${texto}»:\n${papel}`);
    }
  });

  await t('C5. un corte sin dólares imprime el mismo papel de siempre', async () => {
    const corte = {
      folio: 'COR-T', fecha_operativa: '2025-01-01', cerrado_at: new Date().toISOString(), pedidos_count: 1,
      ventas_efectivo: 10, ventas_tarjeta: 0, ventas_enlace: 0, ventas_otros: 0, ventas_totales: 10,
      fondo_inicial: 0, entradas: 0, retiros: 0, gastos: 0, devoluciones_efectivo: 0, efectivo_esperado: 10,
      efectivo_contado: 10, diferencia: 0, cancelaciones_count: 0,
      snapshot_json: { dolares: { pedidos: 0, recibidos_usd: 0, esperado_usd: 0, cambio_mxn: 0 }, arqueo_dolares: null },
    };
    assert.ok(!/DOLARES|USD|Dolares/.test(ticketCorte(corte)), 'un día sin dólares imprimió dólares');
  });

  // ── 4. Factura ────────────────────────────────────────────────────────────
  await t('F1. dólares en billete es efectivo para el SAT (01), en recibo, autofactura y global', () => {
    assert.strictEqual(mapFormaPago('dolares'), '01');
    assert.strictEqual(formaPagoSatDeVenta({ forma_pago: 'dolares' }), '01');
    assert.strictEqual(formaPagoDeVenta({ forma_pago: 'dolares' }), '01');
  });

  // ── 5. Rutas ──────────────────────────────────────────────────────────────
  await vaciarUsd();
  for (const modulo of ['pos', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG, modulo]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Dólares (test)',TRUE,987) RETURNING id`, [NEG]);
  const { rows: [prod] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,'Combo dolares',350,TRUE,FALSE,1) RETURNING id`, [NEG, cat.id]);
  srv = await arrancarServidor({ PORT: PUERTO, TZ }, { timeoutMs: 60000 });
  const api = (ruta, { galleta = ADMIN, ...opts } = {}) => fetch(srv.base + ruta, {
    ...opts, headers: { 'Content-Type': 'application/json', Cookie: galleta, ...(opts.headers || {}) },
  });
  const json = async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) });
  async function abrirPedido() {
    const { status, d } = await json(await api('/api/pedido-presencial', { method: 'POST',
      body: JSON.stringify({ items: [{ producto_id: prod.id, cantidad: 1 }], nombre: 'Cliente dólares' }) }));
    assert.strictEqual(status, 200, `no se pudo abrir el pedido: ${JSON.stringify(d)}`);
    foliosPOS.push(d.pedido.id);
    return d.pedido.id;
  }
  const cobrar = async (folio, cuerpo, galleta = OPERADOR) =>
    json(await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', galleta, body: JSON.stringify(cuerpo) }));
  const fila = async (folio) => (await pool.query(
    `SELECT datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG])).rows[0].datos;

  await t('R1. con los dólares apagados no se cobra en dólares y el pedido sigue por cobrar', async () => {
    const folio = await abrirPedido();
    const { status, d } = await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 30, tipo_cambio_visto: 17.5 });
    assert.strictEqual(status, 400, JSON.stringify(d));
    assert.strictEqual(d.code, 'DOLARES_APAGADOS');
    assert.notStrictEqual((await fila(folio)).pago_confirmado, true, 'el pedido quedó cobrado');
  });

  await t('R2. el cajero lee los dólares; solo el administrador los cambia', async () => {
    assert.deepStrictEqual((await json(await api('/api/pos/dolares', { galleta: OPERADOR }))).d.activo, false);
    const prohibido = await api('/api/admin/dolares', { method: 'PUT', galleta: OPERADOR,
      body: JSON.stringify({ activo: true, tipo_cambio: '17.50' }) });
    assert.strictEqual(prohibido.status, 403, 'el cajero cambió el tipo de cambio');
    const malo = await json(await api('/api/admin/dolares', { method: 'PUT', body: JSON.stringify({ activo: true, tipo_cambio: '1,750.00' }) }));
    assert.deepStrictEqual([malo.status, malo.d.code], [400, 'TIPO_CAMBIO_INVALIDO']);
    const ok = await json(await api('/api/admin/dolares', { method: 'PUT', body: JSON.stringify({ activo: true, tipo_cambio: '17,50' }) }));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.d));
    assert.deepStrictEqual([ok.d.activo, ok.d.tipo_cambio, ok.d.historial.length], [true, 17.5, 1]);
    const pos = (await json(await api('/api/pos/dolares', { galleta: OPERADOR }))).d;
    assert.deepStrictEqual([pos.activo, pos.tipo_cambio], [true, 17.5]);
  });

  await t('R3. si la pantalla mostraba otro tipo de cambio, se rechaza sin tocar el pedido', async () => {
    const folio = await abrirPedido();
    for (const visto of [18, undefined, '17.5x']) {
      const { status, d } = await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 30, tipo_cambio_visto: visto });
      assert.deepStrictEqual([status, d.code, d.tipo_cambio], [409, 'TIPO_CAMBIO_CAMBIO', 17.5], `visto=${visto}`);
    }
    assert.notStrictEqual((await fila(folio)).pago_confirmado, true);
  });

  await t('R4. cobrar USD 30 de $350 deja $175 de cambio y el pedido guarda su tipo de cambio', async () => {
    const folio = await abrirPedido();
    const { status, d } = await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 30, tipo_cambio_visto: '17.50' });
    assert.strictEqual(status, 200, JSON.stringify(d));
    assert.deepStrictEqual([d.total, d.cambio, d.pago_dolares], [350, 175, { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525 }]);
    const datos = await fila(folio);
    assert.deepStrictEqual(
      [datos.forma_pago, datos.pago_confirmado, Number(datos.cambio), Number(datos.billete), datos.pago_dolares],
      ['dolares', true, 175, 0, { usd: 30, tipo_cambio: 17.5, equivalente_mxn: 525 }]);
  });

  await t('R5. dólares que no cubren, o con centavos, se rechazan', async () => {
    const folio = await abrirPedido();
    const corto = await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 19, tipo_cambio_visto: 17.5 });
    assert.deepStrictEqual([corto.status, corto.d.code, corto.d.necesarios], [400, 'DOLARES_NO_CUBREN', 20]);
    const centavos = await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 20.5, tipo_cambio_visto: 17.5 });
    assert.deepStrictEqual([centavos.status, centavos.d.code], [400, 'DOLARES_INVALIDOS']);
    assert.notStrictEqual((await fila(folio)).pago_confirmado, true);
    assert.strictEqual((await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 20, tipo_cambio_visto: 17.5 })).d.cambio, 0);
  });

  await t('R6. cambiar el tipo de cambio de golpe pide confirmación, y lo nuevo manda en el cobro', async () => {
    const salto = await json(await api('/api/admin/dolares', { method: 'PUT', body: JSON.stringify({ activo: true, tipo_cambio: '21' }) }));
    assert.deepStrictEqual([salto.status, salto.d.code, salto.d.anterior, salto.d.nuevo], [409, 'TIPO_CAMBIO_SALTO', 17.5, 21]);
    const confirmado = await json(await api('/api/admin/dolares', { method: 'PUT',
      body: JSON.stringify({ activo: true, tipo_cambio: '21', confirmar_salto: true }) }));
    assert.strictEqual(confirmado.d.tipo_cambio, 21);
    const folio = await abrirPedido();
    assert.strictEqual((await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 20, tipo_cambio_visto: 17.5 })).status, 409);
    const { d } = await cobrar(folio, { forma_pago: 'dolares', usd_recibido: 20, tipo_cambio_visto: 21 });
    assert.deepStrictEqual([d.cambio, d.pago_dolares.tipo_cambio], [70, 21]);
    await api('/api/admin/dolares', { method: 'PUT', body: JSON.stringify({ activo: true, tipo_cambio: '17.50', confirmar_salto: true }) });
  });

  await t('R7. ✏️ Pago a dólares usa el tipo de cambio de la HORA DEL COBRO, y de vuelta no deja rastro', async () => {
    const folio = await abrirPedido();
    assert.strictEqual((await cobrar(folio, { forma_pago: 'efectivo', billete: 500 })).status, 200);
    const cobradoAt = new Date((await fila(folio)).cobrado_at);
    // La bitácora con horas fijas alrededor del cobro: 17.50 antes, 19.00 después.
    await vaciarUsd();
    await pool.query(`INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio, created_at) VALUES
      ($1, true, 17.50, $2), ($1, true, 19.00, $3)`,
      [NEG, new Date(cobradoAt.getTime() - 3600000).toISOString(), new Date(cobradoAt.getTime() + 60000).toISOString()]);
    const sinUsd = await json(await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'dolares' }) }));
    assert.deepStrictEqual([sinUsd.status, sinUsd.d.code], [400, 'DOLARES_INVALIDOS']);
    const a = await json(await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH',
      body: JSON.stringify({ forma_pago: 'dolares', usd_recibido: 30 }) }));
    assert.strictEqual(a.status, 200, JSON.stringify(a.d));
    assert.deepStrictEqual([a.d.pago_dolares.tipo_cambio, a.d.cambio], [17.5, 175], 'usó el tipo de cambio de ahora');
    const enDolares = await fila(folio);
    assert.deepStrictEqual([enDolares.forma_pago, Number(enDolares.billete), Number(enDolares.cambio)], ['dolares', 0, 175]);
    const b = await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
    assert.strictEqual(b.status, 200);
    const deVuelta = await fila(folio);
    assert.deepStrictEqual([deVuelta.forma_pago, Number(deVuelta.cambio), 'pago_dolares' in deVuelta], ['efectivo', 0, false]);
  });

  await t('R8. ✏️ Pago no cobra en dólares: un pedido por cobrar va a «Cobrar»', async () => {
    const folio = await abrirPedido();
    const r = await json(await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH',
      body: JSON.stringify({ forma_pago: 'dolares', usd_recibido: 30 }) }));
    assert.deepStrictEqual([r.status, r.d.code], [409, 'POR_COBRAR']);
    const op = await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH', galleta: OPERADOR,
      body: JSON.stringify({ forma_pago: 'dolares', usd_recibido: 30 }) });
    assert.strictEqual(op.status, 403, 'el cajero corrigió una forma de pago');
  });

  await t('R9. la Caja de hoy (HTTP) trae los dólares del día; un corte cerrado los trae del snapshot', async () => {
    const hoy = (await json(await api('/api/corte-caja'))).d;
    assert.ok(hoy.dolares && hoy.dolares.recibidos_usd >= 70, `dólares de hoy: ${JSON.stringify(hoy.dolares)}`);
    assert.ok(hoy.ventas_dolares >= 1050, `ventas en dólares de hoy: ${hoy.ventas_dolares}`);
    const cerrado = (await json(await api(`/api/corte-caja?fecha=${DIA_CIERRE}`))).d;
    assert.strictEqual(cerrado.cerrado, true);
    assert.deepStrictEqual([cerrado.ventas_dolares, cerrado.dolares.recibidos_usd, cerrado.arqueo_dolares.diferencia_usd], [350, 30, -2]);
  });

  // ── 6. Panel y guardas ────────────────────────────────────────────────────
  await t('P1. cada nombre nuevo del panel está declarado UNA vez', () => {
    const fuentes = PANEL + readdirSync(join(RAIZ, 'panel')).filter(a => a.endsWith('.js'))
      .map(a => readFileSync(join(RAIZ, 'panel', a), 'utf8')).join('\n');
    for (const n of ['DOLARES_POS', 'cargarDolaresPOS', 'aplicarDolaresPOS', 'usdTexto', 'cobroDolaresParaCubrir',
      'cobroDolaresBoton', 'arqDolaresVisible', 'pintarArqueoDolares', 'pintarDiferenciaDolares', 'arqDolaresDiferencia',
      'cargarDolaresConfig', 'fechaCambioDolares', 'pintarDolaresConfig', 'guardarDolaresConfig', 'CORTE_FILTROS_SI_HAY']) {
      const veces = (fuentes.match(new RegExp(`(?:function|const|let|var)\\s+${n}\\b`, 'g')) || []).length;
      assert.strictEqual(veces, 1, `${n} declarado ${veces} veces`);
    }
  });

  await t('P2. el panel calcula los dólares para cubrir igual que el servidor', () => {
    const fuente = PANEL.match(/function cobroDolaresParaCubrir\(total, tc\) \{[\s\S]*?\n\}/);
    assert.ok(fuente, 'no se encontró cobroDolaresParaCubrir en el panel');
    const delPanel = new Function(`${fuente[0]}; return cobroDolaresParaCubrir;`)();
    for (const tc of [10, 16.85, 17.35, 17.5, 18.2, 19.99, 30]) {
      for (const total of [1, 49.5, 99, 345, 350, 351, 520.5, 999.99, 1234.56]) {
        assert.strictEqual(delPanel(total, tc), D.dolaresParaCubrir(total, tc), `total ${total} tc ${tc}`);
      }
    }
  });

  await t('P3. el botón de Dólares nace oculto y el cobro manda el tipo de cambio que vio el cajero', () => {
    assert.match(PANEL, /data-cobro-pago="dolares" id="cobro-btn-dolares" onclick="cobroSelPago\(this\)" style="display:none;"/);
    assert.match(PANEL, /usd_recibido: usdRecibido, tipo_cambio_visto: DOLARES_POS\.tipo_cambio/);
    assert.match(PANEL, /id="pago-btn-dolares"[^>]*style="display:none;/, 'el botón de ✏️ Pago no nace oculto');
    assert.match(PANEL, /dolares_contados: dolaresContados/, 'el cierre no manda los dólares contados');
  });

  await t('G1. el bot y la tienda en línea no leen dólares', () => {
    const archivos = [
      ...['agent', 'channels', 'mesero-agente', 'mesero-whatsapp'].flatMap(dir =>
        readdirSync(join(RAIZ, 'src', dir)).filter(a => a.endsWith('.js')).map(a => join('src', dir, a))),
      join('src', 'services', 'tiendaOnline.js'),
      join('src', 'services', 'tiendaRutasCore.js'),
      join('src', 'services', 'tiendaCheckout.js'),
    ];
    assert.ok(archivos.length >= 20, `solo ${archivos.length} archivos revisados`);
    for (const a of archivos) {
      assert.ok(!/dolares\.js|dolares_tipo_cambio|pago_dolares/.test(readFileSync(join(RAIZ, a), 'utf8')), `${a} lee dólares`);
    }
  });

  await t('G2. el predeploy corre la 125 después de la 124', () => {
    const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const i124 = runner.indexOf("'124-factura-global'");
    const i125 = runner.indexOf("'125-pos-dolares'");
    assert.ok(i124 > 0 && i125 > i124, 'la 125 no está en la lista del predeploy, o va antes de la 124');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (srv) srv.detener();
  await limpiar().catch(() => {});
  if (foliosPOS.length) await del(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio = ANY($2::text[])`, [NEG, foliosPOS]);
  await vaciarUsd().catch(() => {});
  for (const r of respaldoUsd) {
    await del(`INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio, usuario_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [r.negocio_id, r.activo, r.tipo_cambio, r.usuario_id, r.created_at]);
  }
  await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre = 'Combo dolares'`, [NEG]);
  await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Dólares (test)'`, [NEG]);
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
