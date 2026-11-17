// Reportes → Ventas, fase 2: ventas por día, promedio por día de la semana,
// mapa de calor día × hora, comparación contra el periodo anterior y la tabla
// por páginas. Todo sale del servidor con la MISMA definición de venta de la
// fase 1 (ver fase-reportes-ventas), en la zona del negocio y solo con datos
// del negocio de la sesión.
//
// Lo que se cuida aquí:
//   · los promedios son ÷ cuántos días de ese tipo hubo (un mes trae 5 jueves
//     y 4 lunes), con o sin venta, y solo con días ya cerrados;
//   · la hora y el día se leen en la zona del negocio;
//   · el mapa no se estira por una venta suelta, pero la informa;
//   · la comparación es del MISMO negocio;
//   · las páginas no repiten ni pierden renglones, y el CSV trae todo.
//
// Los importes son inventados: el repo es público.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-reportes-ventas-analisis.mjs
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_REPVENTAS_ANALISIS || '4976';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const {
  analizarVentas, construirReporteVentas, armarReporteVentas, periodoAnterior, paginaDeReporte, paginarVentas,
  VENTAS_POR_PAGINA,
} = await import('../src/services/reporteVentas.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const c = (n) => Math.round(Number(n) * 100);
const TZ = 'America/Matamoros';
const semanaDe = (a, dow) => a.por_dia_semana.find(s => s.dia_semana === dow);
const celda = (a, dow, hora) => a.mapa_calor.filas.find(f => f.dia_semana === dow).celdas.find(x => x.hora === hora);
const dd = (n) => String(n).padStart(2, '0');
// Octubre de 2026 empieza en jueves: 5 jueves, viernes y sábados; 4 de los demás.
const LUNES_OCT = [5, 12, 19, 26], JUEVES_OCT = [1, 8, 15, 22, 29];
// 10:00 de Matamoros en octubre (CDT, UTC-5) = 15:00Z.
const diezAm = (dia, mes = 10, y = 2026) => `${y}-${dd(mes)}-${dd(dia)}T15:00:00.000Z`;
const OCT = { desde: '2026-10-01', hasta: '2026-10-31', tz: TZ, hoy: '2026-11-14' };

// ─── A. Las cuentas, sin base ───────────────────────────────────────────────
await t('PROMEDIO', '1. es ÷ cuántos días de ese tipo hubo: 4 lunes de $1,000 le ganan a 5 jueves de $900', async () => {
  const puntos = [
    ...LUNES_OCT.map(d => ({ instante: diezAm(d), neta: 100000 })),
    ...JUEVES_OCT.map(d => ({ instante: diezAm(d), neta: 90000 })),
  ];
  const a = analizarVentas(puntos, OCT);
  const lun = semanaDe(a, 1), jue = semanaDe(a, 4);
  assert.deepStrictEqual([lun.dias, jue.dias], [4, 5], 'octubre de 2026 trae 4 lunes y 5 jueves');
  assert.deepStrictEqual([lun.venta_total, jue.venta_total], [4000, 4500], 'por suma, el jueves ganaría');
  assert.deepStrictEqual([lun.venta_promedio, jue.venta_promedio], [1000, 900], 'el promedio no es ÷ días con venta ni la suma');
  assert.deepStrictEqual([lun.tickets_promedio, lun.ticket_promedio], [1, 1000]);
  assert.strictEqual(a.mas_alto, 1, 'el más alto es el lunes (por promedio), no el jueves (por suma)');
  assert.strictEqual(a.mas_bajo, 2, 'el más bajo: el primer día en $0 de lunes a domingo (martes)');
  assert.deepStrictEqual(a.por_dia_semana.map(s => s.dia_semana), [1, 2, 3, 4, 5, 6, 0], 'de lunes a domingo');
  assert.deepStrictEqual(a.por_dia_semana.map(s => s.dias), [4, 4, 4, 5, 5, 5, 4]);
});

await t('PROMEDIO', '2. un lunes sin venta sigue contando: 3 lunes de $1,000 promedian $750', async () => {
  const a = analizarVentas(LUNES_OCT.slice(0, 3).map(d => ({ instante: diezAm(d), neta: 100000 })), OCT);
  const lun = semanaDe(a, 1);
  assert.strictEqual(lun.dias, 4);
  assert.strictEqual(lun.venta_promedio, 750, `÷ lunes con venta daría 1000: ${lun.venta_promedio}`);
  assert.strictEqual(lun.tickets_promedio, 0.75);
  assert.strictEqual(lun.ticket_promedio, 1000, 'el ticket promedio sí es ÷ tickets');
  const mar = semanaDe(a, 2);
  assert.deepStrictEqual([mar.venta_promedio, mar.tickets_promedio, mar.ticket_promedio], [0, 0, null], 'martes sin tickets: $0, sin ticket promedio');
});

await t('PROMEDIO', '3. hoy va en curso y lo que no llega no cuenta: ni en los promedios ni en el mapa', async () => {
  // Hoy = jueves 15 de octubre. Ventas el 1, el 8 y hoy.
  const puntos = [1, 8, 15].map(d => ({ instante: diezAm(d), neta: 50000 }));
  const a = analizarVentas(puntos, { ...OCT, hoy: '2026-10-15' });
  assert.strictEqual(a.dias_cerrados, 14);
  assert.deepStrictEqual([a.por_dia[13].estado, a.por_dia[14].estado, a.por_dia[15].estado], ['cerrado', 'en_curso', 'futuro']);
  assert.strictEqual(a.por_dia[14].venta, 500, 'la barra de hoy sí muestra lo que va');
  const jue = semanaDe(a, 4);
  assert.strictEqual(jue.dias, 2, `jueves cerrados: el 1 y el 8 (no el 15, ni el 22 ni el 29): ${jue.dias}`);
  assert.deepStrictEqual([jue.venta_total, jue.venta_promedio], [1000, 500], 'la venta de hoy se coló al promedio');
  assert.strictEqual(celda(a, 4, 10).tickets_promedio, 1, 'la venta de hoy se coló al mapa');
  assert.strictEqual(semanaDe(a, 0).dias, 2, 'domingos cerrados: 4 y 11');
  // Periodo que es solo hoy: ningún día cerrado, nada que promediar ni marcar.
  const soloHoy = analizarVentas([{ instante: diezAm(15), neta: 50000 }], { ...OCT, desde: '2026-10-15', hasta: '2026-10-15', hoy: '2026-10-15' });
  assert.strictEqual(soloHoy.dias_cerrados, 0);
  assert.ok(soloHoy.por_dia_semana.every(s => s.dias === 0 && s.venta_promedio === null));
  assert.deepStrictEqual([soloHoy.mas_bajo, soloHoy.mas_alto], [null, null]);
});

await t('ZONA', '4. el día y la hora se leen en la zona del negocio, también tras el cambio de horario', async () => {
  // 05:30Z del 7-oct = 00:30 del miércoles 7 en Matamoros (CDT); 22:30 del martes 6 en Hermosillo (UTC-7).
  const p = [{ instante: '2026-10-07T05:30:00.000Z', neta: 10000 }];
  const mat = analizarVentas(p, OCT);
  assert.strictEqual(mat.por_dia[6].venta, 100, 'Matamoros: es del 7');
  assert.strictEqual(celda(mat, 3, 0).tickets_promedio, 0.25, 'Matamoros: miércoles a las 0 h');
  const her = analizarVentas(p, { ...OCT, tz: 'America/Hermosillo' });
  assert.strictEqual(her.por_dia[5].venta, 100, 'Hermosillo: es del 6');
  assert.strictEqual(celda(her, 2, 22).tickets_promedio, 0.25, 'Hermosillo: martes a las 22 h');
  // Desde el 1-nov Matamoros va en UTC-6: 12:30Z del lunes 2 = 6:30 locales.
  const nov = analizarVentas([{ instante: '2026-11-02T12:30:00.000Z', neta: 10000 }],
    { desde: '2026-11-01', hasta: '2026-11-07', tz: TZ, hoy: '2026-11-14' });
  assert.deepStrictEqual(nov.mapa_calor.horas, [6], `en noviembre la hora es otra: ${nov.mapa_calor.horas}`);
  assert.strictEqual(celda(nov, 1, 6).venta_promedio, 100);
  // Un Date (lo que entrega pg) y una cadena dan lo mismo.
  assert.deepStrictEqual(analizarVentas([{ instante: new Date('2026-10-07T05:30:00Z'), neta: 10000 }], OCT), mat);
});

await t('MAPA', '5. columnas: de la primera a la última hora con ventas de verdad; una suelta se informa, no estira', async () => {
  const puntos = [];
  for (const d of [...LUNES_OCT, ...JUEVES_OCT]) {
    for (let i = 0; i < 20; i++) puntos.push({ instante: `2026-10-${dd(d)}T${i % 2 ? '13' : '17'}:${dd(i)}:00.000Z`, neta: 10000 });
  }
  // 180 tickets entre las 8 y las 12 h (13Z y 17Z) y uno suelto a las 3 am (08Z).
  puntos.push({ instante: '2026-10-09T08:00:00.000Z', neta: 30000 });
  const a = analizarVentas(puntos, OCT);
  assert.deepStrictEqual(a.mapa_calor.horas, [8, 9, 10, 11, 12], `las horas vacías de en medio sí van: ${a.mapa_calor.horas}`);
  assert.deepStrictEqual(a.mapa_calor.fuera, { tickets: 1, venta: 300, horas: [3] }, 'lo que no cabe se informa');
  assert.strictEqual(celda(a, 1, 10).tickets_promedio, 0, 'una hora vacía en medio va en ceros');
  assert.strictEqual(a.mapa_calor.filas.length, 7);
  assert.ok(a.mapa_calor.filas.every(f => f.celdas.length === 5));
  // Con pocos tickets (menos de 100) basta uno para que la hora cuente.
  const pocos = analizarVentas([{ instante: diezAm(5), neta: 100 }, { instante: '2026-10-05T08:00:00.000Z', neta: 100 }], OCT);
  assert.deepStrictEqual([pocos.mapa_calor.horas[0], pocos.mapa_calor.horas.at(-1)], [3, 10]);
  // Sin ventas: de 6 a 15 h.
  const nada = analizarVentas([], OCT);
  assert.deepStrictEqual(nada.mapa_calor.horas, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepStrictEqual(nada.mapa_calor.fuera, { tickets: 0, venta: 0, horas: [] });
});

await t('MAPA', '6. cada celda es un promedio (÷ días de ese tipo) y el máximo es la celda más alta', async () => {
  const puntos = [
    ...LUNES_OCT.map(d => ({ instante: diezAm(d), neta: 100000 })),
    ...JUEVES_OCT.map(d => ({ instante: diezAm(d), neta: 90000 })),
    { instante: diezAm(26), neta: 20000 }, // un segundo ticket un lunes
  ];
  const a = analizarVentas(puntos, OCT);
  assert.deepStrictEqual(celda(a, 1, 10), { hora: 10, venta_promedio: 1050, tickets_promedio: 1.25 });
  assert.deepStrictEqual(celda(a, 4, 10), { hora: 10, venta_promedio: 900, tickets_promedio: 1 });
  assert.strictEqual(a.mapa_calor.maximo, 1050);
  // Un día sin ninguno cerrado deja la celda en null (no hubo ese día), no en 0.
  const unDia = analizarVentas([{ instante: diezAm(5), neta: 100 }], { ...OCT, desde: '2026-10-05', hasta: '2026-10-05' });
  assert.strictEqual(celda(unDia, 2, 10).venta_promedio, null);
  assert.strictEqual(celda(unDia, 1, 10).venta_promedio, 1);
  assert.deepStrictEqual([unDia.mas_bajo, unDia.mas_alto], [null, null], 'con un solo día no hay más bajo ni más alto');
});

await t('PROMEDIO', '7. más bajo y más alto: solo si hay diferencia; en empate, el primero de la semana', async () => {
  const parejo = [];
  for (let d = 1; d <= 31; d++) parejo.push({ instante: diezAm(d), neta: 10000 });
  const a = analizarVentas(parejo, OCT);
  assert.deepStrictEqual([a.mas_bajo, a.mas_alto], [null, null], 'todos iguales: no se marca nada');
  const dosAltos = [...parejo, { instante: diezAm(3), neta: 50000 }, { instante: diezAm(4), neta: 62500 }];
  const b = analizarVentas(dosAltos, OCT);
  // Sábado: (5×100 + 500)/5 = 200; domingo: (4×100 + 625)/4 = 256.25.
  assert.strictEqual(b.mas_alto, 0, 'domingo gana por promedio');
  assert.strictEqual(b.mas_bajo, 1, 'empate en $100: gana el lunes, el primero');
});

await t('COMPARA', '8. el periodo anterior: mes → mes, del 1 a hoy → mismos días, rango → N días antes', async () => {
  const casos = [
    [['2026-10-01', '2026-10-31'], { desde: '2026-09-01', hasta: '2026-09-30', etiqueta: 'septiembre' }],
    [['2026-11-01', '2026-11-14'], { desde: '2026-10-01', hasta: '2026-10-14', etiqueta: '1 al 14 de octubre' }],
    [['2026-11-01', '2026-11-01'], { desde: '2026-10-01', hasta: '2026-10-01', etiqueta: '1 de octubre' }],
    [['2026-03-01', '2026-03-30'], { desde: '2026-02-01', hasta: '2026-02-28', etiqueta: '1 al 28 de febrero' }],
    [['2026-03-01', '2026-03-31'], { desde: '2026-02-01', hasta: '2026-02-28', etiqueta: 'febrero' }],
    [['2026-01-01', '2026-01-31'], { desde: '2025-12-01', hasta: '2025-12-31', etiqueta: 'diciembre de 2025' }],
    [['2026-10-05', '2026-10-11'], { desde: '2026-09-28', hasta: '2026-10-04', etiqueta: '28/09 al 04/10' }],
    [['2026-11-08', '2026-11-14'], { desde: '2026-11-01', hasta: '2026-11-07', etiqueta: '01/11 al 07/11' }],
    [['2026-11-14', '2026-11-14'], { desde: '2026-11-13', hasta: '2026-11-13', etiqueta: '13/11' }],
    [['2026-01-03', '2026-01-09'], { desde: '2025-12-27', hasta: '2026-01-02', etiqueta: '27/12/2025 al 02/01' }],
    [['2026-10-01', '2026-11-14'], { desde: '2026-08-17', hasta: '2026-09-30', etiqueta: '17/08 al 30/09' }],
  ];
  const largo = (d, h) => Math.round((Date.parse(h) - Date.parse(d)) / 86400000) + 1;
  for (const [[d, h], esperado] of casos) {
    const r = periodoAnterior(d, h);
    assert.deepStrictEqual(r, esperado, `${d}..${h}`);
    assert.ok(r.hasta < d, `${d}..${h}: el anterior se encima`);
    // Un rango cualquiera (etiqueta con «/») se compara con uno del mismo largo.
    if (r.etiqueta.includes('/')) assert.strictEqual(largo(r.desde, r.hasta), largo(d, h), `${d}..${h}: otro largo`);
  }
  assert.strictEqual(periodoAnterior('2026-10-31', '2026-10-01'), null);
  assert.strictEqual(periodoAnterior('2026-13-01', '2026-10-01'), null);
});

await t('COMPARA', '9. la comparación: % con un decimal, sin % si antes no hubo ventas, y avisa si incluye hoy', async () => {
  const fila = (folio, total, creado_at) => ({ folio, estado: 'entregado', creado_at,
    datos: { total, subtotal: total, forma_pago: 'efectivo', items: [] } });
  const base = { desde: '2026-10-01', hasta: '2026-10-31', tz: TZ, hoy: '2026-11-14' };
  const r = armarReporteVentas({ ...base, filas: [fila('A1', 150, diezAm(5))], filasAnteriores: [fila('A0', 100, diezAm(7, 9))] });
  assert.deepStrictEqual(r.comparacion, { desde: '2026-09-01', hasta: '2026-09-30', etiqueta: 'septiembre',
    venta_neta: 100, tickets: 1, cambio_pct: 50, incluye_hoy: false });
  const tercio = armarReporteVentas({ ...base, filas: [fila('A1', 100, diezAm(5))], filasAnteriores: [fila('A0', 300, diezAm(7, 9))] });
  assert.strictEqual(tercio.comparacion.cambio_pct, -66.7);
  const sinAntes = armarReporteVentas({ ...base, filas: [fila('A1', 100, diezAm(5))], filasAnteriores: [] });
  assert.strictEqual(sinAntes.comparacion.cambio_pct, null, 'contra $0 no hay porcentaje');
  // En el periodo anterior manda la misma definición: un cancelado no cuenta.
  const conCancelado = armarReporteVentas({ ...base, filas: [fila('A1', 100, diezAm(5))],
    filasAnteriores: [fila('A0', 100, diezAm(7, 9)), { ...fila('A9', 900, diezAm(8, 9)), estado: 'cancelado' }] });
  assert.deepStrictEqual([conCancelado.comparacion.venta_neta, conCancelado.comparacion.cambio_pct], [100, 0]);
  const mes = armarReporteVentas({ ...base, desde: '2026-11-01', hasta: '2026-11-14', filas: [], filasAnteriores: [] });
  assert.strictEqual(mes.comparacion.incluye_hoy, true);
  assert.strictEqual(mes.comparacion.etiqueta, '1 al 14 de octubre');
});

await t('PAGINAS', '10. página pedida: entero ≥ 1; todas solo con 1/true', async () => {
  assert.deepStrictEqual(paginaDeReporte({}), { pagina: 1, todas: false });
  assert.deepStrictEqual(paginaDeReporte({ pagina: '3' }), { pagina: 3, todas: false });
  assert.deepStrictEqual(paginaDeReporte({ todas: '1' }), { pagina: 1, todas: true });
  assert.deepStrictEqual(paginaDeReporte({ todas: 'true' }), { pagina: 1, todas: true });
  for (const no of ['0', 'si', '', undefined]) assert.strictEqual(paginaDeReporte({ todas: no }).todas, false, `todas=${no}`);
  for (const mala of ['0', '-1', 'abc', '1.5', '1e3', '9999999', ' ', ['1', '2'], '2;DROP']) {
    assert.ok(paginaDeReporte({ pagina: mala }).error, `pagina=${JSON.stringify(mala)} no dio error`);
  }
});

await t('PAGINAS', '11. 120 ventas: 50 + 50 + 20, una página de más se recorta y «todas» trae las 120', async () => {
  const ventas = Array.from({ length: 120 }, (_, i) => ({ folio: `V${i}` }));
  assert.strictEqual(VENTAS_POR_PAGINA, 50);
  const p1 = paginarVentas(ventas, { pagina: 1 });
  assert.deepStrictEqual(p1.paginacion, { pagina: 1, por_pagina: 50, total: 120, paginas: 3 });
  assert.deepStrictEqual([p1.ventas[0].folio, p1.ventas.at(-1).folio], ['V0', 'V49']);
  const p3 = paginarVentas(ventas, { pagina: 3 });
  assert.deepStrictEqual([p3.ventas.length, p3.ventas[0].folio], [20, 'V100']);
  const tarde = paginarVentas(ventas, { pagina: 99 });
  assert.deepStrictEqual([tarde.paginacion.pagina, tarde.ventas.length], [3, 20], 'una página de más da la última, no una vacía');
  const todas = paginarVentas(ventas, { pagina: 2, todas: true });
  assert.deepStrictEqual([todas.ventas.length, todas.paginacion.paginas], [120, 1]);
  const vacia = paginarVentas([], { pagina: 1 });
  assert.deepStrictEqual(vacia, { ventas: [], paginacion: { pagina: 1, por_pagina: 50, total: 0, paginas: 1 } });
  // La página es solo de la tabla: resumen, análisis y más vendidos son del periodo entero.
  const filas = Array.from({ length: 120 }, (_, i) => ({ folio: `XAB-${1000 + i}`, estado: 'entregado', creado_at: diezAm(1 + (i % 31)),
    datos: { total: 10, subtotal: 10, forma_pago: 'efectivo', items: [{ nombre: i < 100 ? 'Café' : 'Pan', cantidad: 1 }] } }));
  const base = { filas, desde: '2026-10-01', hasta: '2026-10-31', tz: TZ, hoy: '2026-11-14' };
  const r1 = armarReporteVentas({ ...base, pagina: 1 }), r3 = armarReporteVentas({ ...base, pagina: 3 });
  assert.deepStrictEqual([r1.ventas.length, r3.ventas.length], [50, 20]);
  for (const k of ['resumen', 'desglose', 'analisis', 'mas_vendidos', 'comparacion']) assert.deepStrictEqual(r3[k], r1[k], `${k} cambia con la página`);
  assert.strictEqual(r1.resumen.num_pedidos, 120);
  assert.deepStrictEqual(r1.mas_vendidos, [{ nombre: 'Café', cantidad: 100 }, { nombre: 'Pan', cantidad: 20 }]);
});

await t('PROMEDIO', '12. misma definición que la fase 1: Σ días = tarjeta; cancelado, por cobrar y propina fuera', async () => {
  const filas = [
    { folio: 'XAB-1', estado: 'entregado', creado_at: diezAm(5), datos: { total: 450, subtotal: 500, descuento: 50, propinas: 45, forma_pago: 'terminal' } },
    { folio: 'XAB-2', estado: 'entregado', creado_at: diezAm(5), datos: { canal: 'rappi', pago: 'rappi_pay', total: 393, subtotal: 393 } },
    { folio: 'XAB-3', estado: 'cancelado', creado_at: diezAm(5), datos: { total: 200, forma_pago: 'efectivo' } },
    { folio: 'XAB-4', estado: 'entregado', creado_at: diezAm(5), datos: { total: 150, forma_pago: 'por_cobrar' } },
    { folio: 'RM-AB000001-0', estado: 'entregado', creado_at: diezAm(5), datos: { total: 0, items: [] } },
  ];
  const r = construirReporteVentas(filas, OCT);
  const a = r.analisis;
  assert.strictEqual(a.por_dia.reduce((s, d) => s + c(d.venta), 0), c(r.resumen.total_ventas), 'Σ días ≠ tarjeta');
  assert.strictEqual(a.por_dia.reduce((s, d) => s + d.tickets, 0), r.resumen.num_pedidos);
  assert.deepStrictEqual([a.por_dia[4].venta, a.por_dia[4].tickets], [843, 2], 'Rappi dentro; cancelado, por cobrar, mesa vacía y propina fuera');
  assert.strictEqual(semanaDe(a, 1).venta_total, 843);
  assert.ok(!('analisis' in construirReporteVentas(filas)), 'sin opciones no hay análisis');
});

// ─── B. Con Postgres real y el servidor ────────────────────────────────────
const SLUGS = ['reportes-analisis-a', 'reportes-analisis-b'];
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
const A = await negocio(SLUGS[0], 'Reportes Analisis A');
const B = await negocio(SLUGS[1], 'Reportes Analisis B');

// created_at es timestamp SIN zona que guarda UTC: se escribe la hora UTC tal cual.
async function pedido(neg, folio, estado, datos, utc) {
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)`,
    [folio, estado, JSON.stringify({ id: folio, negocioId: neg, ...datos }), neg, utc]);
}
const venta = (total, producto = 'Producto A', cantidad = 1) => ({ canal: 'pos', modalidad: 'recoger en tienda', subtotal: total, total,
  forma_pago: 'efectivo', items: [{ nombre: producto, cantidad, precio_unitario: total / cantidad }] });
// Octubre de 2020 también empieza en jueves y va en CDT (UTC-5): 10:00 locales = 15:00Z.
for (const d of LUNES_OCT) await pedido(A.id, `RPA-L${dd(d)}`, 'entregado', venta(1000), `2020-10-${dd(d)} 15:00:00`);
for (const d of JUEVES_OCT) await pedido(A.id, `RPA-J${dd(d)}`, 'entregado', venta(900), `2020-10-${dd(d)} 15:00:00`);
// Miércoles 7 a las 23:30 locales = 04:30Z del jueves 8; con propina, que no es venta.
await pedido(A.id, 'RPA-W07', 'entregado', { ...venta(200), propinas: 50 }, '2020-10-08 04:30:00');
await pedido(A.id, 'RPA-X07', 'cancelado', venta(5000), '2020-10-07 16:00:00');
await pedido(A.id, 'RPA-Y07', 'entregado', { ...venta(3000), forma_pago: 'por_cobrar', pago_confirmado: false }, '2020-10-07 16:10:00');
// Sábado 10, de 8 a 9 am: 60 ventas de $10 para tener dos páginas. Las 10
// primeras en el MISMO instante: el folio las desempata.
for (let i = 1; i <= 60; i++) {
  const utc = new Date(Date.UTC(2020, 9, 10, 13, 0, i <= 10 ? 0 : i)).toISOString().replace('T', ' ').replace('Z', '');
  await pedido(A.id, `RPA-P${String(i).padStart(3, '0')}`, 'entregado', venta(10), utc);
}
// Septiembre de A: el 15 y el 30 a las 23:30 locales (04:30Z del 1-oct), que es de septiembre.
await pedido(A.id, 'RPA-S15', 'entregado', venta(500), '2020-09-15 15:00:00');
await pedido(A.id, 'RPA-S30', 'entregado', venta(50), '2020-10-01 04:30:00');
// Otro negocio: los mismos días y horas, con importes que se notarían.
const ventaB = (total) => venta(total, 'Producto de B', 5);
for (const d of LUNES_OCT) await pedido(B.id, `RPAB-L${dd(d)}`, 'entregado', ventaB(77777), `2020-10-${dd(d)} 15:00:00`);
await pedido(B.id, 'RPAB-W07', 'entregado', ventaB(55555), '2020-10-08 04:30:00');
await pedido(B.id, 'RPAB-H03', 'entregado', ventaB(4444), '2020-10-03 08:00:00'); // 3 am, hora que A no tiene
await pedido(B.id, 'RPAB-S15', 'entregado', ventaB(1000000), '2020-09-15 15:00:00');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, galleta) {
  const r = await fetch(srv.base + path, { headers: galleta ? { Cookie: galleta } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const OCT20 = 'desde=2020-10-01&hasta=2020-10-31';
const folios = (r) => r.body.ventas.map(v => v.folio);

try {
  await t('HTTP', '13. octubre de A: por día, promedios ÷ días del tipo y mapa, con la misma venta de la tarjeta', async () => {
    const r = await api(`/api/reportes/ventas?${OCT20}`, A.admin);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const a = r.body.analisis;
    assert.strictEqual(r.body.resumen.total_ventas, 9300);
    assert.strictEqual(r.body.resumen.num_pedidos, 70);
    assert.strictEqual(a.dias_cerrados, 31);
    assert.strictEqual(a.por_dia.length, 31);
    assert.strictEqual(a.por_dia.reduce((s, d) => s + c(d.venta), 0), c(r.body.resumen.total_ventas), 'Σ días ≠ tarjeta');
    const dia = (n) => a.por_dia[n - 1];
    assert.deepStrictEqual([dia(1).venta, dia(5).venta, dia(7).venta, dia(8).venta, dia(10).venta], [900, 1000, 200, 900, 600],
      'el 7 lleva la venta de las 23:30 (no el 8), sin cancelado, por cobrar ni propina; el 1 no lleva la del 30-sep');
    assert.deepStrictEqual([dia(7).dia_semana, dia(10).tickets], [3, 60]);
    const lun = semanaDe(a, 1), jue = semanaDe(a, 4), mie = semanaDe(a, 3), sab = semanaDe(a, 6);
    assert.deepStrictEqual([lun.dias, lun.venta_promedio, jue.dias, jue.venta_promedio], [4, 1000, 5, 900]);
    assert.deepStrictEqual([mie.venta_promedio, sab.venta_promedio, sab.tickets_promedio, sab.ticket_promedio], [50, 120, 12, 10]);
    assert.deepStrictEqual([a.mas_bajo, a.mas_alto], [2, 1], 'más bajo martes ($0), más alto lunes');
    assert.deepStrictEqual([a.mapa_calor.horas[0], a.mapa_calor.horas.at(-1)], [8, 23]);
    assert.deepStrictEqual(celda(a, 3, 23), { hora: 23, venta_promedio: 50, tickets_promedio: 0.25 }, 'miércoles a las 23 h');
    assert.deepStrictEqual(celda(a, 6, 8), { hora: 8, venta_promedio: 120, tickets_promedio: 12 });
    assert.strictEqual(a.mapa_calor.maximo, 1000);
    assert.strictEqual(r.body.timezone, TZ);
  });

  await t('HTTP', '14. comparación: el mes anterior con la misma definición y la misma zona; un rango, los días de antes', async () => {
    const r = await api(`/api/reportes/ventas?${OCT20}`, A.admin);
    assert.deepStrictEqual(r.body.comparacion, { desde: '2020-09-01', hasta: '2020-09-30', etiqueta: 'septiembre',
      venta_neta: 550, tickets: 2, cambio_pct: 1590.9, incluye_hoy: false }, 'la venta de las 23:30 del 30-sep es de septiembre');
    const sem = await api('/api/reportes/ventas?desde=2020-10-05&hasta=2020-10-11', A.admin);
    assert.strictEqual(sem.body.resumen.total_ventas, 2700);
    assert.deepStrictEqual(sem.body.comparacion, { desde: '2020-09-28', hasta: '2020-10-04', etiqueta: '28/09 al 04/10',
      venta_neta: 950, tickets: 2, cambio_pct: 184.2, incluye_hoy: false });
    const hoy = await api('/api/reportes/ventas?periodo=hoy', A.admin);
    assert.strictEqual(hoy.body.comparacion.incluye_hoy, true);
    assert.strictEqual(hoy.body.analisis.dias_cerrados, 0);
    assert.strictEqual(hoy.body.analisis.por_dia[0].estado, 'en_curso');
  });

  await t('PAGINAS', '15. 50 por página, sin repetir ni perder; el desempate es por folio; «todas» es el CSV', async () => {
    const p1 = await api(`/api/reportes/ventas?${OCT20}`, A.admin);
    const p2 = await api(`/api/reportes/ventas?${OCT20}&pagina=2`, A.admin);
    assert.deepStrictEqual(p1.body.paginacion, { pagina: 1, por_pagina: 50, total: 70, paginas: 2 });
    assert.deepStrictEqual([p1.body.ventas.length, p2.body.ventas.length], [50, 20]);
    const juntas = [...folios(p1), ...folios(p2)];
    assert.strictEqual(new Set(juntas).size, 70, 'se repitió un renglón entre páginas');
    const todas = await api(`/api/reportes/ventas?${OCT20}&todas=1`, A.admin);
    assert.deepStrictEqual(folios(todas), juntas, 'el CSV no trae lo mismo que las páginas, en el mismo orden');
    assert.deepStrictEqual(todas.body.paginacion, { pagina: 1, por_pagina: 70, total: 70, paginas: 1 });
    assert.strictEqual(todas.body.ventas.reduce((s, v) => s + c(v.total), 0), c(p1.body.resumen.total_ventas), 'Σ CSV ≠ tarjeta');
    const empatados = juntas.filter(f => /^RPA-P0(0\d|10)$/.test(f));
    assert.deepStrictEqual(empatados, ['RPA-P010', 'RPA-P009', 'RPA-P008', 'RPA-P007', 'RPA-P006', 'RPA-P005', 'RPA-P004', 'RPA-P003', 'RPA-P002', 'RPA-P001'],
      'los del mismo instante no salen en orden fijo');
    assert.strictEqual(juntas.indexOf('RPA-P010') + 1, juntas.indexOf('RPA-P009'), 'empatados no contiguos');
    for (const k of ['resumen', 'desglose', 'analisis', 'mas_vendidos', 'comparacion']) assert.deepStrictEqual(p2.body[k], p1.body[k], `${k} cambia con la página`);
    const tarde = await api(`/api/reportes/ventas?${OCT20}&pagina=99`, A.admin);
    assert.deepStrictEqual([tarde.status, tarde.body.paginacion.pagina, tarde.body.ventas.length], [200, 2, 20]);
    for (const mala of ['0', '-1', 'abc', '1.5', '1e3']) {
      const r = await api(`/api/reportes/ventas?${OCT20}&pagina=${encodeURIComponent(mala)}`, A.admin);
      assert.strictEqual(r.status, 400, `pagina=${mala} dio ${r.status}`);
      assert.ok(r.body && r.body.error, 'sin mensaje');
    }
    const doble = await api(`/api/reportes/ventas?${OCT20}&pagina=1&pagina=2`, A.admin);
    assert.strictEqual(doble.status, 400, 'pagina repetida');
  });

  await t('SEGURIDAD', '16. un negocio no ve datos de otro: ni en el análisis, ni en la comparación, ni en páginas ni CSV', async () => {
    const a = await api(`/api/reportes/ventas?${OCT20}&todas=1`, A.admin);
    assert.ok(!folios(a).some(f => f.startsWith('RPAB-')), 'A vio ventas de B en el CSV');
    assert.strictEqual(semanaDe(a.body.analisis, 1).venta_promedio, 1000, 'los lunes de B se sumaron a A');
    assert.strictEqual(celda(a.body.analisis, 3, 23).venta_promedio, 50, 'el miércoles de B se sumó a A');
    assert.ok(!a.body.analisis.mapa_calor.horas.includes(3) && a.body.analisis.mapa_calor.fuera.tickets === 0, 'la hora de B apareció en A');
    assert.strictEqual(a.body.comparacion.venta_neta, 550, 'el septiembre de B se metió en la comparación de A');
    assert.deepStrictEqual(a.body.mas_vendidos.map(m => m.nombre), ['Producto A'], 'los más vendidos de B salieron en A');
    const b = await api(`/api/reportes/ventas?${OCT20}`, B.admin);
    assert.strictEqual(b.body.resumen.total_ventas, 4 * 77777 + 55555 + 4444);
    assert.strictEqual(semanaDe(b.body.analisis, 1).venta_promedio, 77777);
    assert.strictEqual(b.body.comparacion.venta_neta, 1000000);
    assert.strictEqual(b.body.paginacion.total, 6);
    // El query no elige negocio: con el id o el slug de A, B sigue viendo lo suyo.
    for (const q of [`negocioId=${A.id}`, `negocio_id=${A.id}`, `negocio=${SLUGS[0]}`]) {
      for (const extra of ['', '&todas=1', '&pagina=2']) {
        const r = await api(`/api/reportes/ventas?${OCT20}&${q}${extra}`, B.admin);
        assert.strictEqual(r.status, 200);
        assert.ok(!folios(r).some(f => f.startsWith('RPA-')), `${q}${extra} trajo ventas de A`);
        assert.strictEqual(r.body.comparacion.venta_neta, 1000000, `${q}${extra} cambió la comparación`);
        assert.strictEqual(semanaDe(r.body.analisis, 1).venta_promedio, 77777, `${q}${extra} cambió el análisis`);
      }
    }
  });

  await t('SEGURIDAD', '17. solo admin, también para el CSV y las páginas: operador 403, sin sesión 401', async () => {
    for (const extra of ['', '&todas=1', '&pagina=2']) {
      const op = await api(`/api/reportes/ventas?${OCT20}${extra}`, A.staff);
      assert.strictEqual(op.status, 403, `operador${extra}: ${op.status}`);
      assert.ok(!op.body || !op.body.analisis, 'al operador le llegó el análisis');
      const anon = await api(`/api/reportes/ventas?${OCT20}${extra}`);
      assert.strictEqual(anon.status, 401, `sin sesión${extra}: ${anon.status}`);
    }
  });
} finally {
  srv.detener();
}

await limpiar().catch(() => {});
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
