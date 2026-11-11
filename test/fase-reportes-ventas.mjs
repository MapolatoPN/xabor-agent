// Reportes → Ventas: una sola definición de venta para la tarjeta, la tabla y
// el CSV, con los días cortados en la zona del negocio y siempre filtrado por
// el negocio de la sesión.
//
// Origen (11-nov-2026): la tarjeta y la suma de la columna Total de la tabla
// no cuadraban. La diferencia era exactamente la de los pedidos de Rappi por
// integración: llegan sin `forma_pago` y el FILTER de la tarjeta
// (`NOT (forma_pago = 'por_cobrar' AND …)`) da NULL con NULL y los dejaba
// fuera. Ver src/services/reporteVentas.js.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-reportes-ventas.mjs
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_REPVENTAS || '4974';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const {
  clasificarPedido, importesDePedido, construirReporteVentas, rangoDeReporte, REPORTE_VENTAS_MAX_DIAS,
} = await import('../src/services/reporteVentas.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const c = (n) => Math.round(Number(n) * 100);

// ─── A. Reglas, sin base ────────────────────────────────────────────────────
const RAPPI = { canal: 'rappi', pago: 'rappi_pay', subtotal: 393, descuento: 20, costo_envio: 0, total: 393,
  modalidad: 'entrega a domicilio', items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 180 }] };

await t('REGLA', '1. un pedido de Rappi sin forma_pago ES venta (el hueco de octubre)', async () => {
  assert.strictEqual(clasificarPedido({ folio: 'XAB-1', estado: 'entregado', datos: RAPPI }), 'venta');
  const r = construirReporteVentas([{ folio: 'XAB-1', estado: 'entregado', datos: RAPPI, creado_at: new Date() }]);
  assert.strictEqual(r.resumen.total_ventas, 393);
  assert.strictEqual(r.ventas[0].forma_pago, 'rappi', 'se muestra como Rappi, no «no especificado»');
});

await t('REGLA', '2. lo que no es venta: cancelado, cobro pendiente y mesa sin consumo; la cortesía sí', async () => {
  const caso = (estado, datos, folio = 'XAB-2') => clasificarPedido({ folio, estado, datos });
  assert.strictEqual(caso('cancelado', { total: 200, forma_pago: 'efectivo', pago_confirmado: true }), 'cancelado');
  assert.strictEqual(caso('pendiente_pago', { total: 99, forma_pago: 'enlace_pago' }), 'por_cobrar');
  assert.strictEqual(caso('entregado', { total: 150, forma_pago: 'por_cobrar' }), 'por_cobrar');
  assert.strictEqual(caso('entregado', { total: 150, forma_pago: 'terminal', pago_confirmado: false }), 'por_cobrar',
    'manda la marca de pago, no la etiqueta (igual que la Caja)');
  assert.strictEqual(caso('entregado', { total: 150, forma_pago: 'terminal', pago_confirmado: 'false' }), 'por_cobrar');
  assert.strictEqual(caso('entregado', { total: 0, items: [] }, 'RM-AAAA0001-0'), 'sin_consumo');
  assert.strictEqual(caso('entregado', { total: 0, subtotal: 209, descuento: 209, items: [{ nombre: 'Pastel', cantidad: 1, precio_unitario: 209 }] },
    'RM-AAAA0002-0'), 'venta', 'la cortesía conserva sus productos y es venta en $0');
  assert.strictEqual(caso('entregado', { total: 120, forma_pago: 'efectivo' }), 'venta', 'sin marca de pago (pedidos viejos) sigue siendo venta');
});

await t('REGLA', '3. importes: bruta − descuento + envío = total, sin inventar ni restar dos veces', async () => {
  const tienda = importesDePedido({ subtotal: 300, costo_envio: 50, descuento: 30, total: 320 });
  assert.deepStrictEqual(tienda, { bruta: 30000, descuento: 3000, envio: 5000, neta: 32000, descuento_plataforma: 0 });
  const rappi = importesDePedido(RAPPI);
  assert.strictEqual(rappi.descuento, 0, 'el descuento que Rappi informa no está restado de su total');
  assert.strictEqual(rappi.descuento_plataforma, 2000, 'pero se informa aparte');
  const sinSubtotal = importesDePedido({ total: 100, items: [{ precio_unitario: 60, cantidad: 2 }] });
  assert.deepStrictEqual([sinSubtotal.bruta, sinSubtotal.descuento], [12000, 2000], 'sin subtotal se usan los renglones');
  const cargoRaro = importesDePedido({ subtotal: 80, total: 100 });
  assert.deepStrictEqual([cargoRaro.bruta, cargoRaro.descuento], [10000, 0], 'nunca un descuento negativo');
  const nada = importesDePedido({ total: 75, costo_envio: 25 });
  assert.deepStrictEqual([nada.bruta, nada.descuento, nada.envio], [5000, 0, 2500]);
});

await t('REGLA', '4. tarjeta = Σ tabla = venta neta, al centavo; propina y cancelados aparte', async () => {
  const filas = [
    { folio: 'XAB-10', estado: 'entregado', datos: { total: 0.1, subtotal: 0.1, forma_pago: 'efectivo' } },
    { folio: 'XAB-11', estado: 'entregado', datos: { total: 0.2, subtotal: 0.2, forma_pago: 'efectivo' } },
    { folio: 'XAB-12', estado: 'entregado', datos: { total: 450, subtotal: 500, descuento: 50, propinas: 45, forma_pago: 'terminal', canal: 'restaurante_mesa', modalidad: 'mesa' } },
    { folio: 'XAB-13', estado: 'cancelado', datos: { total: 200, subtotal: 200, forma_pago: 'efectivo' } },
    { folio: 'XAB-14', estado: 'entregado', datos: { total: 150, forma_pago: 'por_cobrar' } },
  ];
  const r = construirReporteVentas(filas);
  const suma = r.ventas.reduce((s, v) => s + c(v.total), 0);
  assert.strictEqual(c(r.resumen.total_ventas), suma, 'la tarjeta no es la suma de la tabla');
  assert.strictEqual(r.resumen.total_ventas, 450.3);
  assert.strictEqual(r.resumen.num_pedidos, r.ventas.length);
  const d = r.desglose;
  assert.strictEqual(c(d.venta_bruta) - c(d.descuentos) + c(d.envios_cobrados), c(d.venta_neta), 'el desglose no cuadra');
  assert.strictEqual(d.venta_neta, r.resumen.total_ventas);
  assert.deepStrictEqual(d.cancelados, { num: 1, total: 200 });
  assert.deepStrictEqual(d.por_cobrar, { num: 1, total: 150 });
  assert.strictEqual(d.propinas, 45, 'la propina se informa');
  assert.ok(!r.ventas.some(v => v.folio === 'XAB-13' || v.folio === 'XAB-14'), 'en la tabla solo hay ventas');
  for (const v of r.ventas) assert.strictEqual(c(v.venta_bruta) - c(v.descuento) + c(v.envio), c(v.total), `${v.folio} no cuadra`);
});

await t('REGLA', '5. días del reporte: hoy, semana (domingo), mes, rango y errores', async () => {
  const hoy = '2026-11-11'; // miércoles
  assert.deepStrictEqual(rangoDeReporte({ periodo: 'hoy' }, hoy), { desde: hoy, hasta: hoy });
  assert.deepStrictEqual(rangoDeReporte({ periodo: 'semana' }, hoy), { desde: '2026-11-08', hasta: hoy });
  assert.deepStrictEqual(rangoDeReporte({ periodo: 'semana' }, '2026-11-08'), { desde: '2026-11-08', hasta: '2026-11-08' });
  assert.deepStrictEqual(rangoDeReporte({ periodo: 'mes' }, hoy), { desde: '2026-11-01', hasta: hoy });
  assert.deepStrictEqual(rangoDeReporte({ desde: '2026-10-01', hasta: '2026-10-31' }, hoy), { desde: '2026-10-01', hasta: '2026-10-31' });
  assert.deepStrictEqual(rangoDeReporte({ desde: '2026-10-01' }, hoy), { desde: '2026-10-01', hasta: hoy }, 'sin hasta: hasta hoy');
  for (const q of [{ periodo: 'mañana' }, { desde: '2026-13-01' }, { desde: '2026-10-31', hasta: '2026-10-01' }, {},
    { desde: '2025-01-01', hasta: '2026-10-01' }, { desde: "2026-10-01' OR 1=1" }]) {
    assert.ok(rangoDeReporte(q, hoy).error, `${JSON.stringify(q)} no dio error`);
  }
  assert.ok(!rangoDeReporte({ desde: '2025-11-11', hasta: '2026-11-11' }, hoy).error, `${REPORTE_VENTAS_MAX_DIAS} días sí caben`);
});

// ─── B. Con Postgres real y el servidor ────────────────────────────────────
const SLUGS = ['reportes-ventas-a', 'reportes-ventas-b'];
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = ANY($1)`, [SLUGS]);
  for (const { id } of rows) {
    const q = (sql) => pool.query(sql, [id]).catch(() => {});
    await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
    await q(`DELETE FROM configuracion WHERE negocio_id = $1`);
    await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
    await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
    await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
    await q(`DELETE FROM negocios WHERE id = $1`);
  }
}
await limpiar();

async function negocio(slug, nombre) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [nombre, slug]);
  for (const m of ['pos', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
  }
  const usuario = async (rol) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
      [n.id, `${rol} ${slug}`, `${slug}-${rol}-${Date.now()}@test.local`]);
    await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, n.id, rol]);
    return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u.id, negocioId: n.id, rol }))}`;
  };
  return { id: n.id, admin: await usuario('admin'), staff: await usuario('staff') };
}
const A = await negocio(SLUGS[0], 'Reportes Ventas A');
const B = await negocio(SLUGS[1], 'Reportes Ventas B');

// created_at es timestamp SIN zona que guarda UTC: se escribe la hora UTC tal cual.
async function pedido(neg, folio, estado, datos, utc) {
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)`,
    [folio, estado, JSON.stringify({ id: folio, negocioId: neg, ...datos }), neg, utc]);
}
// 7-oct-2020: Matamoros en horario de verano (UTC-5). Mediodía local = 17:00Z.
const DIA = '2020-10-07';
await pedido(A.id, 'RPV-0001', 'entregado', RAPPI, '2020-10-07 17:00:00');
await pedido(A.id, 'RPV-0002', 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', subtotal: 120, total: 120, forma_pago: 'efectivo', items: [] }, '2020-10-07 17:10:00');
await pedido(A.id, 'RPV-0003', 'entregado', { canal: 'tienda_online', modalidad: 'entrega a domicilio', subtotal: 300, costo_envio: 50, descuento: 30, total: 320, forma_pago: 'enlace_pago', pago_confirmado: true, items: [] }, '2020-10-07 17:20:00');
await pedido(A.id, 'RM-RPV00001-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', subtotal: 500, descuento: 50, total: 450, propinas: 45, forma_pago: 'terminal', items: [{ nombre: 'Comida', cantidad: 1, precio_unitario: 500 }] }, '2020-10-07 17:30:00');
await pedido(A.id, 'RPV-0005', 'cancelado', { canal: 'pos', subtotal: 200, total: 200, forma_pago: 'efectivo', items: [] }, '2020-10-07 17:40:00');
await pedido(A.id, 'RPV-0006', 'entregado', { canal: 'presencial', modalidad: 'recoger en tienda', subtotal: 150, total: 150, forma_pago: 'por_cobrar', pago_confirmado: false, items: [] }, '2020-10-07 17:50:00');
await pedido(A.id, 'RPV-0007', 'pendiente_pago', { canal: 'tienda_online', modalidad: 'recoger en tienda', subtotal: 99, total: 99, forma_pago: 'enlace_pago', items: [] }, '2020-10-07 18:00:00');
await pedido(A.id, 'RM-RPV00002-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', total: 0, subtotal: 0, forma_pago: 'sin pago', items: [] }, '2020-10-07 18:10:00');
// Bordes del día (CDT): 23:30 local del 7 = 04:30Z del 8; 23:59:59.5 local del 7; 00:30 local del 8 = 05:30Z del 8.
await pedido(A.id, 'RPV-0009', 'entregado', { canal: 'pos', subtotal: 10, total: 10, forma_pago: 'efectivo', items: [] }, '2020-10-08 04:30:00');
await pedido(A.id, 'RPV-0010', 'entregado', { canal: 'pos', subtotal: 1, total: 1, forma_pago: 'efectivo', items: [] }, '2020-10-08 04:59:59.5');
await pedido(A.id, 'RPV-0011', 'entregado', { canal: 'pos', subtotal: 1000, total: 1000, forma_pago: 'efectivo', items: [] }, '2020-10-08 05:30:00');
// Otro negocio, mismo día y misma hora.
await pedido(B.id, 'RPVB-0001', 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', subtotal: 77, total: 77, forma_pago: 'efectivo', items: [] }, '2020-10-07 17:05:00');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, galleta) {
  const r = await fetch(srv.base + path, { headers: galleta ? { Cookie: galleta } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const folios = (r) => r.body.ventas.map(v => v.folio);

try {
  await t('HTTP', '6. tarjeta, desglose y tabla salen de la misma cuenta (con Rappi dentro)', async () => {
    const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.admin);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(folios(r).sort(), ['RM-RPV00001-0', 'RPV-0001', 'RPV-0002', 'RPV-0003', 'RPV-0009', 'RPV-0010'].sort());
    const suma = r.body.ventas.reduce((s, v) => s + c(v.total), 0);
    assert.strictEqual(c(r.body.resumen.total_ventas), suma, 'tarjeta ≠ Σ tabla');
    assert.strictEqual(r.body.resumen.total_ventas, 1294);
    assert.strictEqual(r.body.resumen.num_pedidos, 6);
    const d = r.body.desglose;
    assert.deepStrictEqual(
      { bruta: d.venta_bruta, desc: d.descuentos, envio: d.envios_cobrados, neta: d.venta_neta },
      { bruta: 1324, desc: 80, envio: 50, neta: 1294 });
    assert.deepStrictEqual(d.cancelados, { num: 1, total: 200 });
    assert.deepStrictEqual(d.por_cobrar, { num: 2, total: 249 });
    assert.deepStrictEqual(d.mesas_sin_consumo, { num: 1 });
    assert.strictEqual(d.propinas, 45);
    assert.strictEqual(d.descuentos_plataforma_no_restados, 20);
    assert.strictEqual(r.body.timezone, 'America/Matamoros');
  });

  await t('HTTP', '7. el día se corta en la zona del negocio (CDT), con el último segundo incluido', async () => {
    const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.admin);
    assert.ok(folios(r).includes('RPV-0009'), 'las 23:30 locales del 7 (04:30Z del 8) son del 7');
    assert.ok(folios(r).includes('RPV-0010'), 'las 23:59:59.5 locales son del 7 (antes «hasta 23:59:59» las perdía)');
    assert.ok(!folios(r).includes('RPV-0011'), 'las 00:30 locales del 8 no son del 7');
    assert.strictEqual(r.body.rango.inicio_utc, '2020-10-07T05:00:00.000Z');
    assert.strictEqual(r.body.rango.fin_utc, '2020-10-08T05:00:00.000Z');
    const sig = await api('/api/reportes/ventas?desde=2020-10-08&hasta=2020-10-08', A.admin);
    assert.deepStrictEqual(folios(sig), ['RPV-0011']);
  });

  await t('HTTP', '8. si el negocio cambia de zona, el corte se mueve con ella (no con el navegador)', async () => {
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'timezone','America/Hermosillo')`, [A.id]);
    try {
      const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.admin);
      assert.strictEqual(r.body.timezone, 'America/Hermosillo');
      assert.ok(folios(r).includes('RPV-0011'), 'en Hermosillo (UTC-7) las 05:30Z del 8 son las 22:30 del 7');
      assert.strictEqual(r.body.rango.inicio_utc, '2020-10-07T07:00:00.000Z');
    } finally {
      await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'timezone'`, [A.id]);
    }
  });

  await t('SEGURIDAD', '9. cada negocio ve solo lo suyo, y el query no puede pedir otro negocio', async () => {
    const b = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, B.admin);
    assert.deepStrictEqual(folios(b), ['RPVB-0001']);
    assert.strictEqual(b.body.resumen.total_ventas, 77);
    for (const q of [`negocioId=${A.id}`, `negocio_id=${A.id}`, `negocio=${SLUGS[0]}`]) {
      const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}&${q}`, B.admin);
      assert.deepStrictEqual(folios(r), ['RPVB-0001'], `${q} cruzó de negocio`);
    }
    const a = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.admin);
    assert.ok(!folios(a).includes('RPVB-0001'), 'A vio la venta de B');
  });

  await t('SEGURIDAD', '10. solo admin: el operador recibe 403 y sin sesión 401', async () => {
    const op = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.staff);
    assert.strictEqual(op.status, 403, `operador: ${op.status}`);
    const anon = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`);
    assert.strictEqual(anon.status, 401, `sin sesión: ${anon.status}`);
  });

  await t('HTTP', '11. parámetros inválidos dan 400 con mensaje, no un reporte vacío', async () => {
    for (const q of ['periodo=mañana', 'desde=2026-13-01', 'desde=2026-10-31&hasta=2026-10-01', '', 'desde=2020-01-01&hasta=2026-01-01']) {
      const r = await api(`/api/reportes/ventas?${q}`, A.admin);
      assert.strictEqual(r.status, 400, `${q || '(vacío)'} dio ${r.status}`);
      assert.ok(r.body && r.body.error, 'sin mensaje');
    }
    const hoy = await api('/api/reportes/ventas?periodo=hoy', A.admin);
    const hoyLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());
    assert.strictEqual(hoy.status, 200);
    assert.strictEqual(hoy.body.rango.desde, hoyLocal, '«hoy» es el del negocio');
  });

  await t('HTTP', '12. la ruta vieja /api/ventas/resumen ya cuenta a Rappi sin forma_pago', async () => {
    const desde = '2020-10-07T05:00:00.000Z', hasta = '2020-10-07T23:59:59.000Z';
    const res = (await api(`/api/ventas/resumen?desde=${desde}&hasta=${hasta}`, A.admin)).body;
    const lista = (await api(`/api/ventas?desde=${desde}&hasta=${hasta}`, A.admin)).body;
    const tabla = lista.reduce((s, v) => s + c(v.total), 0);
    assert.ok(lista.some(v => v.folio === 'RPV-0001'), 'precondición: Rappi está en la tabla vieja');
    assert.strictEqual(c(res.total_ventas) + c(res.por_cobrar_total), tabla,
      `tarjeta vieja ${res.total_ventas} + por cobrar ${res.por_cobrar_total} ≠ tabla ${tabla / 100}`);
  });
} finally {
  srv.detener();
}

// ─── C. El panel usa la ruta nueva y no corta días con su reloj ─────────────
const PANEL = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const cuerpoDe = (nombre) => {
  const i = PANEL.indexOf(`function ${nombre}(`);
  assert.ok(i >= 0, `no existe ${nombre}`);
  const j = PANEL.indexOf('\nfunction ', i + 10);
  const k = PANEL.indexOf('\nasync function ', i + 10);
  return PANEL.slice(i, Math.min(...[j, k].filter(x => x > 0)));
};
await t('PANEL', '13. Reportes pide /api/reportes/ventas con días o periodo, nunca instantes del navegador', async () => {
  const cargar = cuerpoDe('cargarVentas');
  assert.match(cargar, /\/api\/reportes\/ventas\?/);
  assert.doesNotMatch(cargar, /\/api\/ventas(\/resumen)?\?/, 'sigue pidiendo las rutas viejas');
  const custom = cuerpoDe('setPeriodoCustom');
  assert.doesNotMatch(custom, /new Date\(|toISOString/, 'el rango se arma con el reloj del navegador');
  assert.doesNotMatch(PANEL, /function isoInicioMes|function isoInicioSem|isoHoy\(\)/, 'quedan cortes de día con el reloj local');
  assert.match(cuerpoDe('cargarInicio'), /\/api\/reportes\/ventas\?periodo=hoy/, 'Inicio no usa la misma definición');
});
await t('PANEL', '14. los nombres nuevos del panel se declaran una sola vez', async () => {
  for (const n of ['cargarVentas', 'setPeriodo', 'setPeriodoCustom', 'exportarCSV', 'pintarDesgloseVentas']) {
    const veces = PANEL.match(new RegExp(`function ${n}\\(`, 'g'))?.length || 0;
    assert.strictEqual(veces, 1, `${n} declarada ${veces} veces`);
  }
  for (const n of ['ventasReporte', 'ventasPeticion', 'ventasData']) {
    const veces = PANEL.match(new RegExp(`(let|const|var) ${n}\\b`, 'g'))?.length || 0;
    assert.strictEqual(veces, 1, `${n} declarada ${veces} veces`);
  }
});

await limpiar().catch(() => {});
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
