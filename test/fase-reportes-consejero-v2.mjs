// ─── Reportes › Ventas: «Lo que te diría un consejero», VERSIÓN 2 ───────────
//
// La corrección que pidió el dueño el 25-nov-2026 (reporteConsejeroV2.js,
// bandera `reportes_consejero_v2`). Contra una COPIA local test_botones_* con
// la 161 (nunca producción). Lo que se protege:
//   A. Reglas, sin base:
//      · el periodo: el de arriba si tiene 14 días o más (13 no), recortado a
//        hoy; si no, los últimos 28 días sin hoy, y por qué;
//      · los nombres en MAYÚSCULAS se muestran normales; el signo de cambio;
//      · los platillos de un ticket: bebidas, extras y envío no cuentan; cada
//        3 tacos, uno, redondeando hacia arriba;
//      · el resumen por ticket de Productos: llegada de la mesa, desglose, sin
//        envío; sin pedirlo el reporte es idéntico; sus cuentas son las de
//        Productos, también las del periodo anterior;
//      · «Se acompaña con»: lift mayor que 1.3 (1.3 no), al menos 30 tickets
//        juntos (29 no), sin extras ni «Sin categoría»; «Otras» bajo el 1 %;
//      · «Sube el ticket»: por platillo y por canal; una mesa grande no basta;
//        los canales no se mezclan (Simpson); los mínimos de 30 y de 100;
//      · «Tu motor» solo si se movió distinto que el negocio o cambió;
//      · «Atrae por sí sola», «Pesa más», «Día u hora floja» (sin hoy, con la
//        llegada de la mesa) y «Canal» (con el periodo anterior ajustado);
//      · cada tarjeta: qué cambió, UNA acción, qué revisar en 14 días, sin
//        frases de causa y efecto; el orden y el tope de 5;
//      · los estados sin consejos siguen trayendo la tabla.
//   B. Con Postgres y el servidor de verdad:
//      · la versión 2 sale solo con su bandera; la 1 no cambia;
//      · el periodo de la petición (14+, corto, inválido = 400);
//      · la llegada de las mesas sale de restaurante_cuentas;
//      · los números son los de Reportes › Productos, que no se lleva el
//        resumen por ticket;
//      · cada negocio ve lo suyo; «Todas» exige la versión 2 en cada una;
//        solo administradores; la caché no confunde periodos.
//
// Los nombres y precios son inventados: el repo es público.
//
// Uso: correr-suite.ps1 -Suite fase-reportes-consejero-v2 -Plantilla <tpl con la 161>
import assert from 'node:assert/strict';
import { arrancarServidor } from './lib-servidor.mjs';

{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
}
const PUERTO = process.env.TEST_PORT_CONSEJERO_V2 || '4992';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const RP = await import('../src/services/reporteProductos.js');
const RC = await import('../src/services/reporteConsejero.js');
const V2 = await import('../src/services/reporteConsejeroV2.js');
const RV = await import('../src/services/reporteVentas.js');
const { instanteLocal } = await import('../src/services/cortesCaja.js');
const { procesarNegocio } = await import('../src/services/lineasEstructuradasProceso.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(cat, nombre, fn) {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 400)} · esperado=${JSON.stringify(e.expected)?.slice(0, 300)}` : '';
    const linea = `[${cat}] ${nombre}: ${String(e?.message || e).split('\n')[0]}${detalle}`;
    console.log(`FALLO ${linea}`); fallos.push(linea);
  }
}
async function terminar() {
  await pool.end();
  console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
  if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
  process.exit(0);
}

// ─── Pedidos inventados ─────────────────────────────────────────────────────
// Como en Obispado y Acuña, todo el menú es «platillo»: lo que distingue una
// bebida o un extra es el NOMBRE de su categoría. Solo COMPLEMENTOS es de
// tipo «extra» (la otra forma de reconocer extras).
const TZM = 'America/Matamoros';
const HOY = '2026-11-25'; // miércoles
const PER = V2.periodoDelConsejero(null, HOY); // 28 oct – 24 nov
const ANT = RV.periodoAnterior(PER.desde, PER.hasta); // 30 sep – 27 oct
const CONTRA = '30 sep – 27 oct';
const DIA_MS = 86400000;
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS) + 1;
const diaDe = (f) => new Date(`${f}T00:00:00Z`).getUTCDay();
const PR = {
  chil: { id: 1, nombre: 'Chilaquiles verdes', precio: 150, cat: 'CHILAQUILES', catId: 1 },
  combo: { id: 2, nombre: 'Combito sencillo', precio: 120, cat: 'Combitos', catId: 2 },
  taco: { id: 3, nombre: 'Taco de guisado', precio: 20, cat: 'TACOS', catId: 3 },
  cafe: { id: 4, nombre: 'Café de olla', precio: 40, cat: 'BEBIDAS', catId: 4 },
  esp: { id: 5, nombre: 'Molcajete', precio: 200, cat: 'ESPECIALES', catId: 5 },
  ench: { id: 6, nombre: 'Enchiladas', precio: 200, cat: 'COMIDAS', catId: 6 },
  parri: { id: 7, nombre: 'Parrillada', precio: 600, cat: 'PARRILLA', catId: 7 },
  pastel: { id: 8, nombre: 'Pastel', precio: 90, cat: 'POSTRES', catId: 8 },
  salsa: { id: 9, nombre: 'Salsa macha', precio: 15, cat: 'EXTRAS', catId: 9 },
  agua: { id: 10, nombre: 'Aguacate', precio: 25, cat: 'COMPLEMENTOS', catId: 10, tipo: 'extra' },
  pan: { id: 11, nombre: 'Pan de la casa', precio: 10, cat: 'NONNA MAYE', catId: 11 },
  // Fuera del menú: sin producto_id (van a «Sin categoría»), y el envío.
  suelto: { id: null, nombre: 'Platillo suelto', precio: 50, fuera: true },
  envio: { id: null, nombre: 'Envío', precio: 30, tipo: 'envio', fuera: true },
};
const CATALOGO = Object.values(PR).filter((p) => !p.fuera).map((p) => ({ id: p.id, nombre: p.nombre, tipo: p.tipo || 'platillo',
  disponible: true, categoria_id: p.catId, categoria: p.cat, categoria_activa: true }));
const MODALIDAD = { mesa: 'mesa', domicilio: 'a domicilio', recoger: 'recoger en tienda' };
const isoLocal = (fecha, h, mi = 0) => { const [y, m, d] = fecha.split('-').map(Number); return instanteLocal(y, m, d, h, mi, 0, TZM).toISOString(); };
const lineaDe = (k, n) => ({ producto_id: PR[k].id, nombre: PR[k].nombre, tipo: PR[k].tipo || 'platillo', cantidad: n, precio_unitario: PR[k].precio, modificadores: [] });
const totalDe = (items) => items.reduce((s, [k, n]) => s + PR[k].precio * n, 0);
function ventaDe(folio, { items, modalidad = 'recoger', creado, llegada = null, registro = 'vigente', estado = 'entregado' }) {
  const total = totalDe(items);
  return {
    venta: { folio, estado, creado_at: creado, registro, ...(llegada ? { llegada_at: llegada } : {}),
      datos: { canal: modalidad === 'mesa' ? 'restaurante_mesa' : 'pos', modalidad: MODALIDAD[modalidad], forma_pago: 'efectivo', subtotal: total, total, items: [{}] } },
    lineas: items.map(([k, n]) => lineaDe(k, n)),
  };
}
// grupos: [{ n, items, modalidad?, fecha?, hora?, minuto?, llegada?: { hora, minuto?, dias? }, registro?, estado? }].
// Sin fecha, los tickets se reparten en los días del periodo.
function ventasDe(grupos, { desde, dias, pre }) {
  const ventas = [], lineas = new Map();
  let i = 0;
  for (const g of grupos) {
    for (let k = 0; k < g.n; k++, i++) {
      const folio = `${pre}${i + 1}`;
      const fecha = g.fecha || sumarDias(desde, i % dias);
      const llegada = g.llegada ? isoLocal(sumarDias(fecha, g.llegada.dias || 0), g.llegada.hora, g.llegada.minuto || 0) : null;
      const v = ventaDe(folio, { ...g, creado: isoLocal(fecha, g.hora ?? 10, g.minuto ?? (k % 50)), llegada });
      ventas.push(v.venta); lineas.set(folio, v.lineas);
    }
  }
  return { ventas, lineas };
}
// n tickets cada día, desde `desde` durante `dias` días. n puede ser una función de la fecha.
const cadaDia = (desde, dias, n, g) => Array.from({ length: dias }, (_, d) => {
  const fecha = sumarDias(desde, d);
  return { ...g, n: typeof n === 'function' ? n(fecha) : n, fecha };
});
function reporteV2({ actual = [], anterior = null, periodo = PER, ant = ANT, negocio = { id: 'n1', nombre: 'Uno' } } = {}) {
  const fuente = { negocio, tz: TZM, catalogo: CATALOGO,
    actual: ventasDe(actual, { desde: periodo.desde, dias: periodo.dias, pre: 'A' }),
    anterior: anterior ? ventasDe(anterior, { desde: ant.desde, dias: diasEntre(ant.desde, ant.hasta), pre: 'B' }) : null };
  const r = RP.construirReporteProductos({ fuentes: [fuente], conTickets: true });
  return { ...r, periodo_anterior: { desde: ant.desde, hasta: ant.hasta, corte: null } };
}
const TODAS = []; // cada tarjeta que sale en la parte A, con su «hoy»
function consejos(esc, { periodo = PER, hoy = HOY } = {}) {
  const r = V2.consejosV2(reporteV2({ ...esc, periodo }), { periodo, hoy });
  for (const c of r.consejos) TODAS.push({ c, hoy });
  return r;
}
const deTipo = (r, tipo) => r.consejos.find((c) => c.tipo === tipo);
const tipos = (r) => r.consejos.map((c) => c.tipo);
const fila = (r, nombre) => r.tabla.find((f) => f.nombre === nombre);
const sinPrioridad = ({ prioridad, cambio, ...resto }) => resto;

// ─── A. Reglas, sin base ────────────────────────────────────────────────────
await t('REGLA', '1. el periodo: el de arriba con 14 días o más; si no, los últimos 28 sin hoy', async () => {
  assert.deepEqual(PER, { desde: '2026-10-28', hasta: '2026-11-24', dias: 28, etiqueta: '28 oct – 24 nov', origen: '28_dias', motivo: 'sin_periodo', incluye_hoy: false });
  assert.deepEqual([ANT.desde, ANT.hasta], ['2026-09-30', '2026-10-27']);
  assert.deepEqual(V2.periodoDelConsejero({ desde: '2026-11-12', hasta: '2026-11-25' }, HOY),
    { desde: '2026-11-12', hasta: '2026-11-25', dias: 14, etiqueta: '12 nov – 25 nov', origen: 'periodo', motivo: null, incluye_hoy: true });
  const trece = V2.periodoDelConsejero({ desde: '2026-11-13', hasta: '2026-11-25' }, HOY);
  assert.deepEqual([trece.origen, trece.motivo, trece.desde, trece.hasta, trece.dias, trece.incluye_hoy], ['28_dias', 'corto', '2026-10-28', '2026-11-24', 28, false]);
  const futuro = V2.periodoDelConsejero({ desde: '2026-11-01', hasta: '2026-12-31' }, HOY);
  assert.deepEqual([futuro.origen, futuro.desde, futuro.hasta, futuro.dias, futuro.incluye_hoy], ['periodo', '2026-11-01', '2026-11-25', 25, true], 'no se recortó a hoy');
  const oct = V2.periodoDelConsejero({ desde: '2026-10-01', hasta: '2026-10-31' }, HOY);
  assert.deepEqual([oct.origen, oct.dias, oct.incluye_hoy, oct.etiqueta], ['periodo', 31, false, '1 oct – 31 oct']);
  for (const malo of [{ desde: '2026-12-01', hasta: '2026-12-20' }, { desde: '2026-11-20', hasta: '2026-11-01' }, { desde: 'ayer', hasta: HOY }, {}, null]) {
    assert.equal(V2.periodoDelConsejero(malo, HOY).motivo, 'sin_periodo', JSON.stringify(malo));
  }
  // Lo que manda el panel con «Este mes» y «Esta semana».
  const periodoDe = (p, hoy) => V2.periodoDelConsejero(RV.rangoDeReporte({ periodo: p }, hoy), hoy);
  assert.equal(periodoDe('mes', HOY).origen, 'periodo');
  assert.equal(periodoDe('semana', HOY).motivo, 'corto');
  assert.equal(periodoDe('mes', '2026-11-13').motivo, 'corto', 'del 1 al 13 son 13 días');
  assert.equal(periodoDe('mes', '2026-11-14').origen, 'periodo', 'del 1 al 14 son 14 días');
  assert.equal(V2.MINIMO_DIAS_PERIODO, 14);
  assert.throws(() => V2.periodoDelConsejero(null, 'hoy'), /inválida/);
});

await t('REGLA', '2. los nombres en MAYÚSCULAS se muestran normales; el signo de cada cambio', async () => {
  for (const [nombre, visible] of [['CHILAQUILES', 'Chilaquiles'], ['NONNA MAYE', 'Nonna Maye'], ['HUEVOS AL GUSTO', 'Huevos al Gusto'],
    ['DE LA CASA', 'De la Casa'], ['ENVÍO', 'Envío'], ['  OMELETTES ', 'Omelettes'], ['Combitos', 'Combitos'], ['Infantil', 'Infantil'],
    ['Tacos de Canasta', 'Tacos de Canasta'], ['2X1', '2x1'], ['123', '123'], ['', ''], [null, '']]) {
    assert.equal(V2.nombreVisible(nombre), visible, String(nombre));
  }
  for (const [n, texto] of [[12, '+12 %'], [-3.5, '−3.5 %'], [0, '0 %'], [0.04, '0 %'], [-0.04, '0 %'], [1234.56, '+1,234.6 %'], [null, 'sin dato'], [undefined, 'sin dato']]) {
    assert.equal(V2.conSigno(n), texto, String(n));
  }
});

await t('REGLA', '3. platillos de un ticket: sin bebidas, extras ni envío; cada 3 tacos, uno', async () => {
  const N = {
    categorias: { 'c:1': 'CHILAQUILES', 'c:3': 'TACOS', 'c:4': 'BEBIDAS', 'c:9': 'EXTRAS', 'c:12': 'ENVÍO', 'c:13': 'Bebidas calientes', 'c:14': 'Tacos de canasta', sin: null },
    productos: { 'p:1': 'Chilaquiles verdes', 'p:20': 'Tortillas de harina', 'p:21': 'Salsa verde', 'p:22': 'Extra queso', 'p:23': 'Chilaquiles con salsa' },
  };
  const pl = (lineas) => V2.platillosDelTicket(lineas, N);
  assert.equal(pl([['p:1', 'c:1', 2, 30000]]), 2);
  for (const [tacos, platillos] of [[1, 1], [2, 1], [3, 1], [4, 2], [6, 2], [7, 3], [99, 33]]) assert.equal(pl([['p:3', 'c:3', tacos, 0]]), platillos, `${tacos} tacos`);
  assert.equal(pl([['p:3', 'c:3', 2, 0], ['p:30', 'c:14', 2, 0]]), 2, 'los tacos de dos categorías se suman antes de dividir');
  assert.equal(pl([['p:4', 'c:4', 3, 0], ['p:9', 'c:9', 2, 0], ['p:12', 'c:12', 1, 0], ['p:13', 'c:13', 1, 0]]), 0, 'bebidas, extras o envío contaron');
  assert.equal(pl([['p:20', 'c:1', 2, 0], ['p:21', 'c:1', 1, 0], ['p:22', 'c:1', 1, 0], ['p:23', 'c:1', 1, 0]]), 1, 'solo «Chilaquiles con salsa» es platillo');
  assert.equal(pl([['p:1', 'c:1', 2, 0], ['p:3', 'c:3', 4, 0], ['p:4', 'c:4', 2, 0]]), 4);
  assert.equal(pl([['n:x', 'sin', 1, 0]]), 1, 'lo que no está ligado al menú sí es platillo');
  assert.equal(pl([['p:1', 'c:1', 0, 0], ['p:1', 'c:1', -1, 0]]), 0);
  assert.equal(pl([]), 0);
  assert.equal(V2.TACOS_POR_PLATILLO, 3);
});

await t('REGLA', '4. resumen por ticket: la llegada de la mesa, el desglose y sin envío; sin pedirlo, el reporte no cambia', async () => {
  const xs = [
    ventaDe('M1', { modalidad: 'mesa', items: [['chil', 1]], creado: isoLocal('2026-11-10', 9, 30), llegada: isoLocal('2026-11-10', 8, 0) }),
    ventaDe('M2', { modalidad: 'mesa', items: [['chil', 1]], creado: isoLocal('2026-11-11', 0, 20), llegada: isoLocal('2026-11-10', 23, 50) }),
    ventaDe('M3', { modalidad: 'mesa', items: [['chil', 1]], creado: isoLocal('2026-11-10', 12, 0) }),
    ventaDe('D1', { modalidad: 'domicilio', items: [['chil', 1]], creado: isoLocal('2026-11-10', 10, 0), llegada: isoLocal('2026-11-10', 7, 0) }),
    ventaDe('S1', { items: [['chil', 1]], creado: isoLocal('2026-11-10', 10, 0), registro: 'sin' }),
    ventaDe('E1', { modalidad: 'domicilio', items: [['chil', 1], ['envio', 1]], creado: isoLocal('2026-11-10', 10, 0) }),
    ventaDe('C1', { items: [['chil', 1]], creado: isoLocal('2026-11-10', 10, 0), estado: 'cancelado' }),
    ventaDe('V1', { items: [['chil', 1]], creado: isoLocal('2026-11-10', 10, 0), registro: 'viejo' }),
  ];
  const fuente = () => ({ negocio: { id: 'n1', nombre: 'Uno' }, tz: TZM, catalogo: CATALOGO, anterior: null,
    actual: { ventas: xs.map((x) => x.venta), lineas: new Map(xs.map((x) => [x.venta.folio, x.lineas])) } });
  const con = RP.construirReporteProductos({ fuentes: [fuente()], conTickets: true });
  const vendidos = xs.filter((x) => x.venta.estado !== 'cancelado');
  const r = (folio) => con.tickets.actual[vendidos.findIndex((x) => x.venta.folio === folio)];
  assert.equal(con.tickets.actual.length, 7, 'el cancelado entró o falta alguno');
  const base = { negocio: 'n1', neta: 15000, desglose: true, lineas: [['p:1', 'c:1', 1, 15000]] };
  assert.deepEqual(r('M1'), { ...base, modalidad: 'mesa', fecha_venta: '2026-11-10', fecha: '2026-11-10', dia: 2, franja: '7-9', con_llegada: true });
  assert.deepEqual(r('M2'), { ...base, modalidad: 'mesa', fecha_venta: '2026-11-11', fecha: '2026-11-10', dia: 2, franja: 'otras', con_llegada: true },
    'una mesa que llegó antes de medianoche es del día en que llegó');
  assert.deepEqual(r('M3'), { ...base, modalidad: 'mesa', fecha_venta: '2026-11-10', fecha: '2026-11-10', dia: 2, franja: '11-13', con_llegada: false });
  assert.deepEqual(r('D1'), { ...base, modalidad: 'domicilio', fecha_venta: '2026-11-10', fecha: '2026-11-10', dia: 2, franja: '9-11', con_llegada: false },
    'la «llegada» solo vale en las mesas');
  assert.deepEqual([r('S1').desglose, r('S1').lineas, r('V1').desglose, r('V1').lineas], [false, [], false, []]);
  assert.deepEqual([r('E1').neta, r('E1').lineas.map((l) => l[0])], [18000, ['p:1']], 'el envío entró como línea de producto');
  assert.deepEqual([con.tickets.categorias['c:1'], con.tickets.productos['p:1']], ['CHILAQUILES', 'Chilaquiles verdes']);
  assert.deepEqual(con.tickets.anterior, []);
  // Sin `conTickets` el reporte es idéntico, salvo el resumen.
  const sin = RP.construirReporteProductos({ fuentes: [fuente()] });
  assert.ok(!('tickets' in sin));
  const { tickets, ...resto } = con;
  assert.deepEqual(resto, sin, 'pedir el resumen cambió el reporte');
  // El mismo folio en dos sucursales son dos tickets, cada uno con su negocio.
  const deSucursal = (id) => ({ negocio: { id, nombre: id }, tz: TZM, catalogo: CATALOGO, anterior: null,
    actual: { ventas: [xs[0].venta], lineas: new Map([[xs[0].venta.folio, xs[0].lineas]]) } });
  const dos = RP.construirReporteProductos({ fuentes: [deSucursal('a'), deSucursal('b')], conTickets: true });
  assert.deepEqual(dos.tickets.actual.map((x) => [x.negocio, x.lineas.length]), [['a', 1], ['b', 1]]);
});

await t('REGLA', '5. las cuentas por ticket son las de Productos, también las del periodo anterior', async () => {
  const esc = {
    actual: [{ n: 60, items: [['chil', 1], ['cafe', 1]] }, { n: 30, items: [['chil', 1], ['taco', 3]] }, { n: 25, items: [['combo', 1]] },
      { n: 10, items: [['salsa', 2], ['chil', 1]] }, { n: 5, items: [['suelto', 1]] }, { n: 4, registro: 'sin', items: [['chil', 1]] }],
    anterior: [{ n: 50, items: [['chil', 1], ['cafe', 1]] }, { n: 20, items: [['pastel', 1]] }, { n: 30, items: [['combo', 1], ['cafe', 1]] }],
  };
  const rep = reporteV2(esc);
  const con = rep.tickets.actual.filter((x) => x.desglose);
  assert.equal(con.length, rep.con_desglose.tickets);
  for (const c of rep.categorias) {
    const suyos = con.filter((x) => x.lineas.some((l) => l[1] === c.clave));
    const venta = con.reduce((s, x) => s + x.lineas.filter((l) => l[1] === c.clave).reduce((a, l) => a + l[3], 0), 0);
    assert.deepEqual([suyos.length, venta, suyos.reduce((s, x) => s + x.neta, 0), suyos.filter((x) => x.lineas.every((l) => l[1] === c.clave)).length],
      [c.arrastre.tickets, Math.round(c.venta * 100), Math.round(c.arrastre.dinero_tickets * 100), c.arrastre.solo_tickets], c.nombre);
  }
  // Periodo anterior: cada producto suma lo mismo que su «venta anterior».
  const antPorProducto = new Map();
  for (const x of rep.tickets.anterior) for (const [k, , , m] of x.lineas) antPorProducto.set(k, (antPorProducto.get(k) || 0) + m);
  const previos = new Map([...rep.productos.map((p) => [p.clave, p.venta_anterior]), ...rep.sin_venta_ahora.map((p) => [p.clave, p.venta_anterior])]);
  assert.equal(antPorProducto.size, 4, 'chilaquiles, café, pastel y combito');
  for (const [k, m] of antPorProducto) assert.equal(m / 100, previos.get(k), `${k}: el resumen y Productos dicen cosas distintas`);
  assert.equal(rep.tickets.anterior.length, 100);
  // Y la columna «Cambio de su venta» de la tabla sale de ahí.
  const r = V2.consejosV2(rep, { periodo: PER, hoy: HOY });
  assert.deepEqual([fila(r, 'Chilaquiles').cambio_venta_pct, fila(r, 'Bebidas').cambio_venta_pct, fila(r, 'Combitos').cambio_venta_pct, fila(r, 'Tacos').cambio_venta_pct],
    [100, -25, -16.7, null], '(60+30+10)·150 contra 50·150; 60·40 contra 80·40; 25·120 contra 30·120; los tacos no se vendían');
});

await t('REGLA', '6. «Se acompaña con»: lift mayor que 1.3 y al menos 30 tickets juntos; sin extras ni «Sin categoría»', async () => {
  const L = ({ ambos, x, y, ninguno, extras = 0 }) => consejos({ actual: [
    { n: ambos, items: [['chil', 1], ['cafe', 1]] },
    { n: extras, items: [['chil', 1], ['salsa', 1], ['agua', 2], ['suelto', 1]] },
    { n: x - extras, items: [['chil', 1]] },
    { n: y, items: [['cafe', 1]] },
    { n: ninguno, items: [['ench', 1]] }] });
  const r = L({ ambos: 51, x: 49, y: 49, ninguno: 111 });
  assert.deepEqual(fila(r, 'Chilaquiles').junto, [{ clave: 'c:4', nombre: 'Bebidas', tickets: 51, lift: 1.33 }], '(51/100) / (100/260) = 1.33');
  assert.deepEqual(fila(r, 'Bebidas').junto, [{ clave: 'c:1', nombre: 'Chilaquiles', tickets: 51, lift: 1.33 }]);
  assert.deepEqual(fila(r, 'Comidas').junto, []);
  assert.deepEqual(fila(L({ ambos: 50, x: 50, y: 50, ninguno: 110 }), 'Chilaquiles').junto, [], 'un lift de exactamente 1.3 no es «más de lo normal»');
  assert.deepEqual(fila(L({ ambos: 29, x: 31, y: 31, ninguno: 169 }), 'Chilaquiles').junto, [], '29 tickets juntos no bastan (lift 2.09)');
  assert.deepEqual(fila(L({ ambos: 30, x: 30, y: 30, ninguno: 170 }), 'Chilaquiles').junto, [{ clave: 'c:4', nombre: 'Bebidas', tickets: 30, lift: 2.17 }]);
  // 40 tickets de chilaquiles traen salsa, aguacate y algo fuera del menú (lift 2.6): no cuentan.
  const ex = L({ ambos: 51, x: 49, y: 49, ninguno: 111, extras: 40 });
  assert.deepEqual(fila(ex, 'Chilaquiles').junto.map((j) => j.nombre), ['Bebidas'], 'un extra o «Sin categoría» salió como acompañante');
  assert.ok(fila(ex, 'Extras') && fila(ex, 'Complementos'), 'las categorías de extras siguen en la tabla');
  assert.ok(!ex.tabla.some((f) => f.clave === 'sin'), '«Sin categoría» no va en la tabla');
  assert.equal(V2.UMBRALES_V2.lift, 1.3);
  assert.equal(V2.UMBRALES_V2.subgrupo, 30);
});

await t('REGLA', '7. la tabla: bajo el 1 % de la venta va en «Otras»; el 1 % exacto se queda', async () => {
  const r = consejos({ actual: [{ n: 95, items: [['chil', 1]] }, { n: 5, items: [['chil', 1], ['pan', 1]] }, { n: 10, items: [['cafe', 1]] }] });
  assert.deepEqual(r.tabla.map((f) => f.nombre), ['Chilaquiles', 'Bebidas']);
  assert.deepEqual(r.otras, { clave: 'otras', nombre: 'Otras', categorias: ['Nonna Maye'], venta: 50, pct_venta: 0.3,
    tickets: 5, pct_tickets: 4.5, dinero_tickets: 800, pct_dinero_tickets: 5.2 });
  const justo = consejos({ actual: [{ n: 66, items: [['chil', 1]] }, { n: 10, items: [['pan', 1]] }] });
  assert.deepEqual([justo.tabla.map((f) => [f.nombre, f.pct_venta]), justo.otras], [[['Chilaquiles', 99], ['Nonna Maye', 1]], null]);
  const abajo = consejos({ actual: [{ n: 66, items: [['chil', 1]] }, { n: 9, items: [['pan', 1]] }] });
  assert.deepEqual([abajo.tabla.map((f) => f.nombre), abajo.otras?.categorias], [['Chilaquiles'], ['Nonna Maye']]);
});

// «Sube el ticket»: a domicilio, c tickets con bebida y s sin ella; M mesas, todas con bebida.
// (Con muchos tickets sin bebida, las mesas llevan más café: si Bebidas bajara
// del 10 % de la venta, «Pesa más» se quedaría con ella antes.)
const sube = (c, s, M, cafesMesa = 2) => consejos({ actual: [
  { n: c, modalidad: 'domicilio', items: [['chil', 1], ['cafe', 2]] },
  { n: s, modalidad: 'domicilio', items: [['chil', 1]] },
  { n: M, modalidad: 'mesa', items: [['chil', 2], ['cafe', cafesMesa]] }] });

await t('REGLA', '8. «Sube el ticket»: por platillo, en su canal, con su texto', async () => {
  const r = sube(40, 60, 60);
  assert.deepEqual(sinPrioridad(deTipo(r, 'sube_ticket')), {
    tipo: 'sube_ticket', categoria: { clave: 'c:4', nombre: 'Bebidas' }, canal: 'domicilio',
    titulo: 'Sube el ticket a domicilio: Bebidas',
    texto: 'A domicilio, los tickets que llevan Bebidas dejan $230 por platillo; los que no, $150: 53 % más. Va en el 40 % de tus tickets a domicilio (40 de 100).',
    accion: 'Ofrécelo al tomar cada orden a domicilio.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'el % de tickets a domicilio que lo llevan', valor: '40 %', meta: 'que suba' },
  });
  assert.equal(deTipo(r, 'sube_ticket').cambio.texto, `Sin ventas en ${CONTRA} para comparar.`);
  // Un café solo a domicilio (sin platillo) no entra ni al texto ni a la comparación.
  const dom = (n, extra = []) => [
    { n, modalidad: 'domicilio', items: [['chil', 1], ['cafe', 2]] },
    { n: 60, modalidad: 'domicilio', items: [['chil', 1]] },
    { n: 60, modalidad: 'mesa', items: [['chil', 2], ['cafe', 2]] }, ...extra];
  const conSolo = consejos({ actual: dom(40, [{ n: 7, modalidad: 'domicilio', items: [['cafe', 1]] }]), anterior: dom(30, [{ n: 5, modalidad: 'domicilio', items: [['cafe', 1]] }]) });
  const k = deTipo(conSolo, 'sube_ticket');
  assert.match(k.texto, /\(40 de 100\)\.$/);
  assert.deepEqual([k.cambio.tickets.anterior, k.cambio.tickets.actual, k.cambio.venta.anterior, k.cambio.venta.actual], [30, 40, 2400, 3200], 'la comparación contó otros tickets que el texto');
});

await t('REGLA', '9. «Sube el ticket»: una mesa grande no basta; el gasto por platillo también tiene que subir', async () => {
  // Con pastel la mesa deja $540 contra $150 (+260 %), pero $135 por platillo contra $150.
  const r = consejos({ actual: [{ n: 100, modalidad: 'mesa', items: [['chil', 3], ['pastel', 1]] }, { n: 40, modalidad: 'mesa', items: [['chil', 1]] }] });
  assert.ok(fila(r, 'Postres').tickets >= 100, 'la prueba no prueba nada: Postres no llega a 100 tickets');
  assert.ok(!deTipo(r, 'sube_ticket'), `salió por el tamaño de la mesa: ${deTipo(r, 'sube_ticket')?.titulo}`);
});

await t('REGLA', '10. «Sube el ticket»: los canales no se mezclan (juntos parecería +50 %; en cada canal es 0 %)', async () => {
  const esc = { actual: [
    { n: 70, modalidad: 'mesa', items: [['parri', 1], ['esp', 1]] }, { n: 35, modalidad: 'mesa', items: [['parri', 1], ['ench', 1]] },
    { n: 35, modalidad: 'domicilio', items: [['esp', 1]] }, { n: 70, modalidad: 'domicilio', items: [['ench', 1]] }] };
  const r = consejos(esc);
  assert.ok(!deTipo(r, 'sube_ticket'), `mezcló canales: ${deTipo(r, 'sube_ticket')?.titulo}`);
  // Mezclados, ESPECIALES pasaría las dos pruebas: así se sabe que la de arriba prueba algo.
  const rep = reporteV2(esc);
  const nombres = rep.tickets;
  const todos = rep.tickets.actual.map((x) => ({ neta: x.neta, pl: V2.platillosDelTicket(x.lineas, nombres), con: x.lineas.some((l) => l[1] === 'c:5') }));
  const prom = (xs, k) => xs.reduce((s, x) => s + x.neta, 0) / (k === 'pl' ? xs.reduce((s, x) => s + x.pl, 0) : xs.length);
  const [con, sin] = [todos.filter((x) => x.con), todos.filter((x) => !x.con)];
  assert.ok(prom(con) / prom(sin) >= 1.15 && prom(con, 'pl') / prom(sin, 'pl') >= 1.15, 'el caso ya no engañaría mezclado');
});

await t('REGLA', '11. «Sube el ticket»: 30 con y 30 sin en el canal, 100 en la categoría y el 5 % del canal', async () => {
  // Que ninguna otra tarjeta se haya quedado con Bebidas: así un «no sale» es por el mínimo.
  const canalDe = (r) => {
    const otra = r.consejos.find((c) => c.categoria?.clave === 'c:4' && c.tipo !== 'sube_ticket');
    assert.ok(!otra, `«${otra?.titulo}» se quedó con Bebidas: la prueba no prueba el mínimo`);
    return deTipo(r, 'sube_ticket')?.canal || null;
  };
  assert.equal(canalDe(sube(29, 60, 71)), null, '29 tickets con bebida a domicilio');
  assert.equal(canalDe(sube(30, 60, 70)), 'domicilio');
  assert.equal(canalDe(sube(40, 29, 60)), null, '29 tickets sin bebida a domicilio');
  assert.equal(canalDe(sube(40, 60, 59)), null, 'Bebidas con 99 tickets');
  assert.equal(canalDe(sube(30, 590, 70, 10)), null, 'en el 4.8 % de los tickets a domicilio');
  assert.equal(canalDe(sube(30, 570, 70, 10)), 'domicilio', 'en el 5 %');
});

await t('REGLA', '12. «Tu motor» solo si se movió distinto que el negocio, o si cambió', async () => {
  const actual = [{ n: 100, items: [['chil', 1]] }, { n: 50, items: [['ench', 1]] }];
  assert.ok(!deTipo(consejos({ actual, anterior: [{ n: 80, items: [['chil', 1]] }, { n: 40, items: [['ench', 1]] }] }), 'motor'), 'todo creció 25 %: el motor no dice nada');
  assert.ok(!deTipo(consejos({ actual }), 'motor'), 'sin periodo anterior no hay con qué comparar');
  const movio = deTipo(consejos({ actual, anterior: [{ n: 70, items: [['chil', 1]] }, { n: 50, items: [['ench', 1]] }] }), 'motor');
  assert.deepEqual(sinPrioridad(movio), {
    tipo: 'motor', categoria: { clave: 'c:1', nombre: 'Chilaquiles' }, titulo: 'Tu motor se movió: Chilaquiles',
    texto: 'Sigue siendo lo que más vendes: el 60 % de la venta, y va en el 66.7 % de tus tickets. Su venta cambió +42.9 %; la de todo el negocio, +22 %.',
    accion: 'Revisa cada semana que no falte ni se tarde en tus horas fuertes.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'su venta por semana', valor: '$3,750', meta: 'que no baje' },
  });
  assert.deepEqual([movio.cambio.venta.actual, movio.cambio.venta.anterior, movio.cambio.venta.pct, movio.prioridad], [15000, 10500, 42.9, 42.9]);
  const otro = consejos({ actual, anterior: [{ n: 40, items: [['chil', 1]] }, { n: 60, items: [['ench', 1]] }] });
  assert.deepEqual([otro.consejos[0].tipo, otro.consejos[0].titulo, otro.consejos[0].prioridad], ['motor', 'Ahora tu motor es Chilaquiles', 100]);
  assert.equal(otro.consejos[0].texto, `Ahora lo que más vendes es Chilaquiles: el 60 % de la venta, y va en el 66.7 % de tus tickets. En ${CONTRA} lo que más vendías era Comidas.`);
});

await t('REGLA', '13. «Atrae por sí sola»: el 25 % de sus tickets solos, 30 solos y 100 tickets; nunca los extras', async () => {
  const solos = (n, con, mas = []) => consejos({ actual: [{ n, items: [['combo', 1]] }, { n: con, items: [['combo', 1], ['cafe', 1]] }, ...mas] });
  assert.deepEqual(sinPrioridad(deTipo(solos(63, 137), 'atrae_sola')), {
    tipo: 'atrae_sola', categoria: { clave: 'c:2', nombre: 'Combitos' }, titulo: 'Atrae por sí sola: Combitos',
    texto: 'En el 31.5 % de los tickets que la llevan (63 de 200) va sola: no se pidió nada más. Esos tickets promedian $120; el promedio de todos tus tickets es $147.',
    accion: 'Cuando la pidan sola, ofrece una bebida o un complemento.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'el % de sus tickets que van solos', valor: '31.5 %', meta: 'que baje' },
  });
  assert.ok(deTipo(solos(50, 150), 'atrae_sola'), 'el 25 % exacto');
  assert.ok(!deTipo(solos(49, 151), 'atrae_sola'), 'el 24.5 %');
  assert.ok(!deTipo(solos(29, 71), 'atrae_sola'), '29 solos');
  assert.ok(!deTipo(solos(40, 59, [{ n: 20, items: [['ench', 1]] }]), 'atrae_sola'), 'Combitos con 99 tickets');
  assert.ok(!deTipo(consejos({ actual: [{ n: 40, items: [['salsa', 1]] }, { n: 60, items: [['salsa', 1], ['chil', 1]] }] }), 'atrae_sola'), 'salió un extra');
  const conAntes = consejos({ actual: [{ n: 63, items: [['combo', 1]] }, { n: 137, items: [['combo', 1], ['cafe', 1]] }],
    anterior: [{ n: 100, items: [['combo', 1]] }, { n: 100, items: [['combo', 1], ['cafe', 1]] }] });
  assert.ok(deTipo(conAntes, 'atrae_sola').texto.endsWith(` En ${CONTRA} iba sola en el 50 %.`), deTipo(conAntes, 'atrae_sola').texto);
});

await t('REGLA', '14. «Pesa más de lo que parece», con su texto; nunca los extras', async () => {
  const r = consejos({ actual: [{ n: 120, items: [['chil', 1], ['taco', 3]] }, { n: 10, items: [['taco', 4]] }, { n: 370, items: [['chil', 1]] }] });
  assert.deepEqual(sinPrioridad(deTipo(r, 'pesa_mas')), {
    tipo: 'pesa_mas', categoria: { clave: 'c:3', nombre: 'Tacos' }, titulo: 'Pesa más de lo que parece: Tacos',
    texto: 'Es solo el 9.8 % de lo que vendes, pero va en 1 de cada 4 tickets, y esos tickets suman el 31.9 % del dinero. Solo 10 de 130 lo llevan sin nada más.',
    accion: 'Ofrécelo al tomar cada orden.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'el % de tickets que lo llevan', valor: '26 %', meta: 'que suba' },
  });
  const ex = consejos({ actual: [{ n: 120, items: [['chil', 1], ['salsa', 2]] }, { n: 10, items: [['salsa', 2]] }, { n: 370, items: [['chil', 1]] }] });
  assert.ok(!deTipo(ex, 'pesa_mas'), `salió un extra: ${deTipo(ex, 'pesa_mas')?.titulo}`);
});

const chil = { items: [['chil', 1]] };
await t('REGLA', '15. «Día flojo»: cae 10 % o más y 10 puntos más que el negocio', async () => {
  const r = consejos({ actual: cadaDia(PER.desde, 28, (f) => (diaDe(f) === 2 ? 14 : 20), chil), anterior: cadaDia(ANT.desde, 28, 20, chil) });
  const d = r.consejos[0];
  assert.deepEqual(sinPrioridad(d), {
    tipo: 'debil', dia: 2, titulo: 'Día flojo: los martes',
    texto: `Los martes vendes en promedio $2,100 por día; en ${CONTRA} eran $3,000 (−30 %). Tu venta por día en general cambió −4.3 %.`,
    accion: 'Prueba una promoción solo los martes durante 2 semanas.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'la venta promedio de los martes', valor: '$2,100', meta: 'que suba' },
  });
  assert.deepEqual([d.cambio.venta.etiqueta, d.cambio.tickets.etiqueta, d.cambio.tickets.actual, d.cambio.tickets.anterior, d.prioridad], ['venta por día', 'tickets por día', 14, 20, 30]);
  const todo = consejos({ actual: cadaDia(PER.desde, 28, 14, chil), anterior: cadaDia(ANT.desde, 28, 20, chil) });
  assert.ok(!deTipo(todo, 'debil'), 'si todo el negocio cayó 30 %, ningún día es «el flojo»');
});

await t('REGLA', '16. «Día flojo»: hoy no cuenta (va a medias)', async () => {
  const periodo = V2.periodoDelConsejero({ desde: '2026-10-29', hasta: HOY }, HOY);
  const ant = RV.periodoAnterior(periodo.desde, periodo.hasta);
  assert.deepEqual([periodo.origen, periodo.incluye_hoy, ant.desde, ant.hasta], ['periodo', true, '2026-10-01', '2026-10-28']);
  // Hoy (miércoles) lleva 2 tickets: si contara, los miércoles caerían 22.5 %.
  const r = consejos({ actual: [...cadaDia('2026-10-29', 27, 20, chil), { n: 2, fecha: HOY, ...chil }], anterior: cadaDia(ant.desde, 28, 20, chil), ant }, { periodo });
  assert.ok(!deTipo(r, 'debil'), `contó hoy: ${deTipo(r, 'debil')?.titulo}`);
});

await t('REGLA', '17. «Hora floja»: en las mesas cuenta la hora de llegada, no la del cobro', async () => {
  const mesa = { modalidad: 'mesa', hora: 9, minuto: 30, llegada: { hora: 8 }, items: [['chil', 1]] };
  const dom = { modalidad: 'domicilio', hora: 12, items: [['chil', 1]] };
  const r = consejos({ actual: [...cadaDia(PER.desde, 28, 5, mesa), ...cadaDia(PER.desde, 28, 15, dom)],
    anterior: [...cadaDia(ANT.desde, 28, 10, mesa), ...cadaDia(ANT.desde, 28, 10, dom)] });
  assert.deepEqual(sinPrioridad(deTipo(r, 'debil')), {
    tipo: 'debil', franja: '7-9', titulo: 'Hora floja: de 7 a 9',
    texto: `De 7 a 9 vendes en promedio $750 por día; en ${CONTRA} eran $1,500 (−50 %). Tu venta por día en general cambió 0 %.`,
    accion: 'Prueba una promoción solo de 7 a 9 durante 2 semanas.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'la venta promedio por día de 7 a 9', valor: '$750', meta: 'que suba' },
  });
});

await t('REGLA', '18. «Canal»: el título dice lo que más se movió; la acción sigue a los tickets', async () => {
  const rec = consejos({ actual: [{ n: 88, items: [['chil', 1], ['cafe', 1]] }, { n: 50, modalidad: 'domicilio', items: [['ench', 1]] }],
    anterior: [{ n: 100, items: [['chil', 1]] }, { n: 50, modalidad: 'domicilio', items: [['ench', 1]] }] });
  assert.deepEqual(sinPrioridad(deTipo(rec, 'canal')), {
    tipo: 'canal', canal: 'recoger', titulo: 'Para recoger: sube el ticket promedio',
    texto: 'Tu venta para recoger cambió +11.5 %: tickets −12 % y ticket promedio +26.7 %. Es el 63.8 % de tus tickets.',
    accion: 'Pon una promoción solo para recoger durante 2 semanas.',
    revisar: { el: '2026-12-09', etiqueta: '9 dic', numero: 'tus tickets para recoger por semana', valor: '22', meta: 'que suba' },
  });
  assert.equal(deTipo(rec, 'canal').prioridad, 26.7, 'la prioridad es el cambio más grande');
  const mesas = deTipo(consejos({ actual: [{ n: 60, modalidad: 'mesa', ...chil }, { n: 60, modalidad: 'domicilio', items: [['ench', 1]] }],
    anterior: [{ n: 30, modalidad: 'mesa', ...chil }, { n: 60, modalidad: 'domicilio', items: [['ench', 1]] }] }), 'canal');
  assert.deepEqual([mesas.titulo, mesas.accion, mesas.revisar.numero, mesas.revisar.valor, mesas.revisar.meta],
    ['Mesas: sube la venta', 'Cuida que las mesas se atiendan sin demora de 9 a 11, su horario más fuerte.', 'tus tickets de mesa por semana', '15', 'que no baje']);
  const baja = deTipo(consejos({ actual: [{ n: 100, ...chil }], anterior: [{ n: 100, items: [['chil', 1], ['cafe', 1]] }] }), 'canal');
  assert.deepEqual([baja.titulo, baja.accion, baja.revisar.numero, baja.revisar.valor, baja.revisar.meta],
    ['Para recoger: baja la venta', 'Ofrece un complemento o una bebida en cada orden para recoger.', 'el ticket promedio para recoger', '$150', 'que suba']);
  const dom = { modalidad: 'domicilio', items: [['ench', 1]] };
  assert.ok(!deTipo(consejos({ actual: [{ n: 29, ...chil }, { n: 80, ...dom }], anterior: [{ n: 40, ...chil }, { n: 80, ...dom }] }), 'canal'), 'un canal con 29 tickets');
  assert.ok(!deTipo(consejos({ actual: [{ n: 95, ...chil }, { n: 20, ...dom }], anterior: [{ n: 100, ...chil }, { n: 20, ...dom }] }), 'canal'), 'un cambio del 5 %');
});

await t('REGLA', '19. «Canal»: un periodo anterior más largo se ajusta a los mismos días', async () => {
  const hoy = '2026-12-01';
  const periodo = V2.periodoDelConsejero({ desde: '2026-11-01', hasta: '2026-11-30' }, hoy);
  const ant = RV.periodoAnterior(periodo.desde, periodo.hasta);
  assert.deepEqual([periodo.dias, ant.desde, ant.hasta], [30, '2026-10-01', '2026-10-31']);
  // 4 tickets al día en los dos: sin ajustar, 120 contra 124 parecerían −3.2 %.
  const r = consejos({ actual: cadaDia(periodo.desde, 30, 4, { items: [['chil', 1], ['cafe', 1]] }), anterior: cadaDia(ant.desde, 31, 4, chil), ant }, { periodo, hoy });
  const c = deTipo(r, 'canal');
  assert.deepEqual([c.cambio.tickets.actual, c.cambio.tickets.anterior, c.cambio.tickets.pct + 0, c.cambio.promedio.pct, c.revisar.el],
    [120, 120, 0, 26.7, '2026-12-15']);
  assert.ok(c.texto.endsWith(' El periodo anterior se ajustó a los mismos días.'), c.texto);
});

await t('REGLA', '20. el orden: primero lo que cambió 10 % o más; después el orden fijo; como mucho 5', async () => {
  const k = (tipo, prioridad) => ({ tipo, prioridad });
  const r = V2.ordenarTarjetas([k('canal', 5), k('motor', 0), k('debil', 30), k('pesa_mas', 12), k('atrae_sola', 9.9), k('sube_ticket', 10), k('canal', 0)]);
  assert.deepEqual(r.map((x) => `${x.tipo}:${x.prioridad}`), ['debil:30', 'pesa_mas:12', 'sube_ticket:10', 'motor:0', 'atrae_sola:9.9']);
  assert.deepEqual(V2.ordenarTarjetas([k('canal', 20), k('motor', 20)]).map((x) => x.tipo), ['motor', 'canal'], 'un empate se rompe con el orden fijo');
  // Lo que cambió va antes que una tarjeta de orden fijo más alto que no cambió,
  // llegue en el orden que llegue.
  const tres = [k('motor', 0), k('atrae_sola', 5), k('canal', 15)];
  for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(V2.ordenarTarjetas(perm.map((i) => tres[i])).map((x) => x.tipo), ['canal', 'motor', 'atrae_sola'], `orden de llegada ${perm}`);
  }
  assert.deepEqual(V2.ordenarTarjetas([k('canal', 10), k('motor', 0)]).map((x) => x.tipo), ['canal', 'motor'], 'canal con 10 % va antes que el motor sin cambio');
  assert.equal(V2.MAX_TARJETAS, 5);
  assert.deepEqual(V2.ordenarTarjetas(), []);
});

await t('REGLA', '21. sin ventas, con pocos tickets o con poco desglose: no aconseja, lo dice y deja la tabla', async () => {
  const vacio = consejos({ actual: [] });
  assert.deepEqual([vacio.version, vacio.estado, vacio.consejos, vacio.tabla, vacio.otras, vacio.notas],
    [2, 'sin_ventas', [], [], null, [...V2.NOTAS_V2]]);
  const pocos = consejos({ actual: [{ n: 99, ...chil }] });
  assert.deepEqual([pocos.estado, pocos.aviso, pocos.consejos.length, pocos.tabla.map((f) => f.nombre)],
    ['pocos_tickets', 'Con 99 tickets en estos días todavía no hay suficiente para aconsejarte: hacen falta al menos 100.', 0, ['Chilaquiles']]);
  const sinDet = consejos({ actual: [{ n: 100, ...chil }, { n: 12, registro: 'sin', ...chil }] });
  assert.deepEqual([sinDet.estado, sinDet.base], ['sin_desglose', { tickets: 112, con_desglose: 100, pct_desglose: 89.3, venta_neta: 15000 }]);
  // El periodo y contra qué se compara, en la salida.
  assert.deepEqual([vacio.periodo, vacio.anterior], [PER, { desde: ANT.desde, hasta: ANT.hasta, etiqueta: CONTRA, corte: null }]);
  const rep = reporteV2({ actual: [{ n: 100, ...chil }] });
  rep.periodo_anterior.corte = { fecha: ANT.hasta, hora: '14:05' };
  assert.equal(V2.consejosV2(rep, { periodo: PER, hoy: HOY }).anterior.etiqueta, `${CONTRA}, hasta las 14:05`);
  assert.equal(V2.NOTAS_V2.length, 3);
  assert.ok(V2.NOTAS_V2.some((n) => /3 tacos/.test(n)) && V2.NOTAS_V2.some((n) => /llegada/.test(n)) && V2.NOTAS_V2.some((n) => /costos/.test(n)));
});

await t('REGLA', '22. cada tarjeta: qué cambió, una acción, qué revisar en 14 días; sin causa y efecto ni MAYÚSCULAS', async () => {
  assert.deepEqual([...new Set(TODAS.map((x) => x.c.tipo))].sort(), ['atrae_sola', 'canal', 'debil', 'motor', 'pesa_mas', 'sube_ticket'], 'falta algún tipo de tarjeta en las pruebas');
  const CAUSA = /quien lo pide|quien no|gasta más|porque|provoca|hace que|gracias a|por culpa|atrae a/i;
  for (const { c, hoy } of TODAS) {
    const quien = `${c.tipo} «${c.titulo}»`;
    assert.equal(typeof c.accion, 'string', quien);
    assert.ok(c.accion.length > 10 && c.accion.endsWith('.') && !c.accion.includes('\n'), `${quien}: acción «${c.accion}»`);
    assert.deepEqual(Object.keys(c.revisar).sort(), ['el', 'etiqueta', 'meta', 'numero', 'valor'], quien);
    assert.equal(c.revisar.el, sumarDias(hoy, 14), quien);
    assert.ok(['que suba', 'que baje', 'que no baje'].includes(c.revisar.meta), `${quien}: meta «${c.revisar.meta}»`);
    assert.ok(c.revisar.numero && c.revisar.valor, quien);
    assert.ok(/^(Contra |Sin ventas en )/.test(c.cambio.texto), `${quien}: «${c.cambio.texto}»`);
    for (const k of ['venta', 'tickets', 'promedio']) assert.ok(c.cambio[k] && 'pct' in c.cambio[k], `${quien}: sin cambio de ${k}`);
    assert.equal(typeof c.prioridad, 'number', quien);
    const textos = `${c.titulo} ${c.texto} ${c.accion}`;
    assert.ok(!CAUSA.test(textos), `${quien}: frase de causa y efecto en «${textos}»`);
    assert.ok(!/\b[A-ZÁÉÍÓÚÑ]{4,}\b/.test(`${c.titulo} ${c.texto}`), `${quien}: nombre en MAYÚSCULAS`);
  }
});

// Con CASOS solo de reglas (1–22) no hace falta la base: así las mordidas tardan segundos.
if (SOLO.length && SOLO.every((p) => Number.parseInt(p, 10) < 23)) await terminar();

// ─── B. Con Postgres y el servidor ─────────────────────────────────────────
const TAG = 'CV2' + (Date.now() % 1e8).toString(36).toUpperCase();
const PRE = `${TAG} `;
const SLUGS = ['a', 'b', 'c', 'x'].map((l) => `${TAG.toLowerCase()}-rep-cv2-${l}`);
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-rep-cv2-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM restaurante_cuentas WHERE negocio_id = $1');
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM pedido_lineas_pedidos WHERE negocio_id = $1');
    await del('DELETE FROM menu_productos WHERE negocio_id = $1');
    await del('DELETE FROM menu_categorias WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}
await limpiar();

async function negocio(slug, nombre, { v2 = true } = {}) {
  const n = await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [nombre, slug]);
  for (const m of ['pos', 'caja']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
  for (const clave of ['reportes_productos_v1', 'reportes_consejero_v1', ...(v2 ? ['reportes_consejero_v2'] : [])]) {
    await q(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,'true')`, [n.id, clave]);
  }
  return n.id;
}
async function usuario(neg, nombre) {
  return (await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}-${Date.now()}@test.local`])).id;
}
const miembro = (u, neg, rol) => q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)', [u, neg, rol]);
const galleta = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
async function menu(neg, P) {
  const cats = {}, ids = {};
  for (const [k, p] of Object.entries(P)) {
    if (!cats[p.cat]) cats[p.cat] = (await uno('INSERT INTO menu_categorias (nombre, negocio_id, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id', [p.cat, neg, p.catId])).id;
    ids[k] = (await uno('INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible) VALUES ($1,$2,$3,$4,TRUE) RETURNING id', [neg, cats[p.cat], p.nombre, p.precio])).id;
  }
  return ids;
}
// created_at es timestamp SIN zona que guarda UTC; abierta_at es timestamptz.
const utcLocal = (fecha, h, mi = 0) => isoLocal(fecha, h, mi).slice(0, 19).replace('T', ' ');
async function pedido(neg, folio, { items, P, ids, modalidad = 'recoger', fecha, h = 10, mi = 0 }) {
  const total = items.reduce((s, [k, n]) => s + P[k].precio * n, 0);
  const datos = { id: folio, canal: modalidad === 'mesa' ? 'restaurante_mesa' : 'pos', modalidad: MODALIDAD[modalidad], forma_pago: 'efectivo',
    subtotal: total, total, items: items.map(([k, n]) => ({ producto_id: ids[k], nombre: P[k].nombre, cantidad: n, precio_unitario: P[k].precio })) };
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, 'entregado', JSON.stringify(datos), neg, utcLocal(fecha, h, mi)]);
}
async function cuenta(neg, mesero, folio, mesa, fecha, { llegada, cobro }) {
  await q(`INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, personas, mesero_usuario_id, abierta_por, estado, abierta_at, cerrada_at, venta_folio)
           VALUES ($1,$2,2,$3,$3,'cerrada',$4::timestamptz,$5::timestamptz,$6)`,
  [neg, mesa, mesero, isoLocal(fecha, ...llegada), isoLocal(fecha, ...cobro), folio]);
}

const HOY_R = new Intl.DateTimeFormat('en-CA', { timeZone: TZM }).format(new Date());
const VR = RC.ventanaDelConsejero(HOY_R);
const PDB = {
  chil: { nombre: `${PRE}Chilaquiles`, precio: 150, cat: `${PRE}CHILAQUILES`, catId: 1 },
  cafe: { nombre: `${PRE}Café`, precio: 40, cat: `${PRE}BEBIDAS`, catId: 2 },
  taco: { nombre: `${PRE}Taco`, precio: 25, cat: `${PRE}TACOS`, catId: 3 },
};

const A = await negocio(SLUGS[0], `${TAG} Sucursal A`);
const B = await negocio(SLUGS[1], `${TAG} Sucursal B`);
const C = await negocio(SLUGS[2], `${TAG} Sucursal C`, { v2: false });
const X = await negocio(SLUGS[3], `${TAG} Otro dueño`);
const DUENO = await usuario(A, `${TAG} Dueño`);
for (const n of [A, B, C]) await miembro(DUENO, n, 'admin');
const STAFF_A = await usuario(A, `${TAG} Cajera`); await miembro(STAFF_A, A, 'staff');
const AJENO = await usuario(X, `${TAG} Ajeno`); await miembro(AJENO, X, 'admin');
const S = { duenoA: galleta(DUENO, A, 'admin'), duenoC: galleta(DUENO, C, 'admin'), staffA: galleta(STAFF_A, A, 'staff'), ajeno: galleta(AJENO, X, 'admin') };

// A: en los 28 días, 70 para recoger y 41 mesas (40 con su cuenta: llegan a
// las 8:00 y pagan a las 9:30); en los 28 anteriores, 80 y 40. Hoy, 3 más.
const idsA = await menu(A, PDB);
const fechasA = [];
const dA = (d) => { const f = sumarDias(HOY_R, -d); fechasA.push(f); return f; };
for (let i = 0; i < 70; i++) await pedido(A, `${TAG}-R${i}`, { items: [['chil', 1], ['cafe', 1]], P: PDB, ids: idsA, fecha: dA(1 + (i % 28)), mi: i % 50 });
for (let i = 0; i < 40; i++) {
  const fecha = dA(1 + (i % 28));
  await pedido(A, `${TAG}-M${i}`, { items: [['chil', 2]], P: PDB, ids: idsA, modalidad: 'mesa', fecha, h: 9, mi: 30 });
  await cuenta(A, DUENO, `${TAG}-M${i}`, 1 + (i % 20), fecha, { llegada: [8, 0], cobro: [9, 30] });
}
await pedido(A, `${TAG}-MSC`, { items: [['chil', 1]], P: PDB, ids: idsA, modalidad: 'mesa', fecha: dA(3), h: 9, mi: 30 });
for (let i = 0; i < 80; i++) await pedido(A, `${TAG}-RA${i}`, { items: [['chil', 1], ['cafe', 1]], P: PDB, ids: idsA, fecha: sumarDias(HOY_R, -(29 + (i % 28))), mi: i % 50 });
for (let i = 0; i < 40; i++) {
  const fecha = sumarDias(HOY_R, -(29 + (i % 28)));
  await pedido(A, `${TAG}-MA${i}`, { items: [['chil', 2]], P: PDB, ids: idsA, modalidad: 'mesa', fecha, h: 9, mi: 30 });
  await cuenta(A, DUENO, `${TAG}-MA${i}`, 1 + (i % 20), fecha, { llegada: [8, 0], cobro: [9, 30] });
}
for (let i = 0; i < 3; i++) await pedido(A, `${TAG}-HOY${i}`, { items: [['taco', 10]], P: PDB, ids: idsA, fecha: dA(0), h: 0, mi: 5 + i });
const idsB = await menu(B, PDB);
for (let i = 0; i < 5; i++) await pedido(B, `${TAG}-B${i}`, { items: [['chil', 1]], P: PDB, ids: idsB, fecha: sumarDias(HOY_R, -2), mi: i });
const idsC = await menu(C, PDB);
for (let i = 0; i < 5; i++) await pedido(C, `${TAG}-C${i}`, { items: [['chil', 1]], P: PDB, ids: idsC, fecha: sumarDias(HOY_R, -2), mi: i });
const PX = { torta: { nombre: `${TAG} Torta secreta`, precio: 77, cat: `${TAG} TORTAS`, catId: 9 } };
const idsX = await menu(X, PX);
for (let i = 0; i < 3; i++) await pedido(X, `${TAG}-X${i}`, { items: [['torta', 1]], P: PX, ids: idsX, fecha: sumarDias(HOY_R, -2), mi: i });
for (const neg of [A, B, C, X]) await procesarNegocio(neg);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, cookie) {
  const r = await fetch(srv.base + path, { headers: cookie ? { Cookie: cookie } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const ids = (xs) => [...xs].map((s) => s.id ?? s).sort();

try {
  await t('HTTP', '23. con su bandera sale la versión 2: los últimos 28 días sin hoy, si no se manda periodo', async () => {
    const r = await api('/api/reportes/consejero', S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 2);
    assert.deepEqual(r.body.periodo, { ...VR, origen: '28_dias', motivo: 'sin_periodo', incluye_hoy: false });
    const ant = RV.periodoAnterior(VR.desde, VR.hasta);
    assert.deepEqual([r.body.anterior.desde, r.body.anterior.hasta], [ant.desde, ant.hasta]);
    assert.deepEqual([r.body.hoy, r.body.sucursal, r.body.elegidas], [HOY_R, 'actual', [A]]);
    assert.deepEqual(r.body.base, { tickets: 111, con_desglose: 111, pct_desglose: 100, venta_neta: 70 * 190 + 40 * 300 + 150 }, 'hoy o el periodo anterior se colaron');
    assert.deepEqual(r.body.notas, [...V2.NOTAS_V2]);
    assert.deepEqual(r.body.tabla.map((f) => f.nombre), [V2.nombreVisible(`${PRE}CHILAQUILES`), V2.nombreVisible(`${PRE}BEBIDAS`)]);
    assert.ok(!('tickets' in r.body) && !('ventana' in r.body), 'se fue al navegador el resumen por ticket o la ventana de la versión 1');
    assert.equal(r.body.estado, 'ok');
    for (const c of r.body.consejos) assert.equal(c.revisar.el, sumarDias(HOY_R, 14), c.titulo);
  });

  await t('HTTP', '24. el periodo de la petición: 14 días o más se usa; menos, 28 días y lo dice; mal escrito, 400', async () => {
    const desde = sumarDias(HOY_R, -20);
    const r = await api(`/api/reportes/consejero?desde=${desde}&hasta=${HOY_R}`, S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.periodo.origen, r.body.periodo.desde, r.body.periodo.hasta, r.body.periodo.dias, r.body.periodo.incluye_hoy],
      ['periodo', desde, HOY_R, 21, true]);
    assert.equal(r.body.base.tickets, fechasA.filter((f) => f >= desde).length, 'no son los tickets de esos días (con los de hoy)');
    const corto = await api(`/api/reportes/consejero?desde=${sumarDias(HOY_R, -5)}`, S.duenoA);
    assert.deepEqual([corto.status, corto.body.periodo.origen, corto.body.periodo.motivo, corto.body.periodo.desde, corto.body.base.tickets],
      [200, '28_dias', 'corto', VR.desde, 111]);
    for (const malo of ['desde=2026-13-01', 'desde=ayer', 'periodo=siempre', `desde=${HOY_R}&hasta=${sumarDias(HOY_R, -3)}`]) {
      const x = await api(`/api/reportes/consejero?${malo}`, S.duenoA);
      assert.deepEqual([x.status, typeof x.body?.error], [400, 'string'], malo);
    }
  });

  await t('HTTP', '25. la llegada de las mesas sale de restaurante_cuentas; sin cuenta, la hora del cobro', async () => {
    const rep = await RP.obtenerReporteProductos({ negocios: [{ id: A, nombre: 'A', tz: TZM }], desde: VR.desde, hasta: VR.hasta, db: pool, conTickets: true });
    const mesas = rep.tickets.actual.filter((x) => x.modalidad === 'mesa');
    assert.equal(mesas.length, 41);
    assert.deepEqual([mesas.filter((x) => x.con_llegada && x.franja === '7-9').length, mesas.filter((x) => !x.con_llegada && x.franja === '9-11').length], [40, 1]);
    assert.ok(rep.tickets.actual.filter((x) => x.modalidad === 'recoger').every((x) => !x.con_llegada && x.franja === '9-11'));
    assert.equal(rep.tickets.anterior.filter((x) => x.con_llegada && x.franja === '7-9').length, 40, 'el periodo anterior no trae la llegada');
    // Sin pedir el resumen no se lee la llegada, y el reporte es el mismo.
    const sin = await RP.obtenerReporteProductos({ negocios: [{ id: A, nombre: 'A', tz: TZM }], desde: VR.desde, hasta: VR.hasta, db: pool });
    const { tickets, ...resto } = rep;
    assert.deepEqual(resto, sin);
  });

  await t('HTTP', '26. los números son los de Reportes › Productos, que no se lleva el resumen por ticket', async () => {
    const r = await api('/api/reportes/consejero', S.duenoA);
    const p = await api(`/api/reportes/productos?desde=${VR.desde}&hasta=${VR.hasta}`, S.duenoA);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.ok(!('tickets' in p.body), 'Productos mandó el resumen por ticket al navegador');
    assert.deepEqual([p.body.cuadre.tickets, p.body.cuadre.venta_neta], [r.body.base.tickets, r.body.base.venta_neta]);
    for (const f of r.body.tabla) {
      const c = p.body.categorias.find((x) => x.clave === f.clave);
      assert.ok(c, `${f.nombre} no está en Productos`);
      assert.deepEqual([f.venta, f.pct_venta, f.tickets, f.dinero_tickets, f.solo_tickets], [c.venta, c.pct_venta, c.arrastre.tickets, c.arrastre.dinero_tickets, c.arrastre.solo_tickets], f.nombre);
    }
  });

  await t('HTTP', '27. la versión 1 no cambia: sin su bandera, ni versión, ni periodo; el estado dice cuál', async () => {
    const estA = await api('/api/reportes/productos/estado', S.duenoA);
    assert.deepEqual([estA.status, estA.body.consejero, estA.body.consejero_v2], [200, true, true]);
    const estC = await api('/api/reportes/productos/estado', S.duenoC);
    assert.deepEqual([estC.body.consejero, estC.body.consejero_v2], [true, false]);
    const c = await api(`/api/reportes/consejero?desde=${sumarDias(HOY_R, -20)}`, S.duenoC);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(!('version' in c.body) && !('periodo' in c.body), 'el negocio sin la versión 2 la recibió');
    assert.deepEqual(c.body.ventana, VR, 'la versión 1 debe ignorar el periodo de la petición');
    // Con la versión 1, «Todas» sigue como antes: las que tienen el consejero.
    const todasC = await api('/api/reportes/consejero?sucursal=todas', S.duenoC);
    assert.deepEqual(ids(todasC.body.sucursales), ids([A, B, C]));
  });

  await t('SEGURIDAD', '28. cada negocio ve lo suyo; el query no puede pedir otro', async () => {
    const x = await api('/api/reportes/consejero', S.ajeno);
    assert.equal(x.status, 200);
    assert.deepEqual([x.body.version, x.body.estado, x.body.base.tickets, x.body.tabla.map((f) => f.nombre)], [2, 'pocos_tickets', 3, [V2.nombreVisible(`${TAG} TORTAS`)]]);
    assert.deepEqual(ids(x.body.sucursales), [X]);
    for (const extra of [`negocioId=${A}`, `negocio_id=${A}`]) {
      const y = await api(`/api/reportes/consejero?${extra}&desde=${VR.desde}&hasta=${VR.hasta}`, S.ajeno);
      assert.deepEqual([y.status, y.body.base?.tickets], [200, 3], `${extra} cruzó de negocio`);
    }
    assert.equal((await api(`/api/reportes/consejero?sucursal=${A}`, S.ajeno)).status, 403, 'una sucursal ajena por id');
    const a = await api('/api/reportes/consejero', S.duenoA);
    assert.ok(!JSON.stringify(a.body).toLowerCase().includes('torta'), 'A vio datos de X');
  });

  await t('SEGURIDAD', '29. «Todas» con la versión 2: solo las sucursales que también la tienen', async () => {
    const r = await api('/api/reportes/consejero?sucursal=todas', S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ids(r.body.sucursales), ids([A, B]), 'C (solo versión 1) se mezcló');
    assert.deepEqual([r.body.version, r.body.sucursal, ids(r.body.elegidas), r.body.base.tickets], [2, 'todas', ids([A, B]), 116]);
    assert.equal((await api(`/api/reportes/consejero?sucursal=${C}`, S.duenoA)).status, 403, 'C se pidió sola desde la versión 2');
    const b = await api(`/api/reportes/consejero?sucursal=${B}`, S.duenoA);
    assert.deepEqual([b.status, b.body.version, b.body.base.tickets], [200, 2, 5]);
  });

  await t('SEGURIDAD', '30. solo administradores: el operador 403 y sin sesión 401', async () => {
    assert.equal((await api('/api/reportes/consejero', S.staffA)).status, 403);
    assert.equal((await api('/api/reportes/consejero')).status, 401);
  });

  await t('HTTP', '31. la caché: la llave lleva los negocios, los días y de dónde salieron', async () => {
    const cache = RC.crearCacheConsejero();
    const negs = [{ id: A, nombre: 'A', tz: TZM }];
    const uno1 = await V2.obtenerConsejosV2({ negocios: negs, hoy: HOY_R, cache });
    assert.equal(await V2.obtenerConsejosV2({ negocios: negs, hoy: HOY_R, cache }), uno1, 'no usó la caché');
    // Los mismos 28 días por el respaldo de un periodo corto: la pantalla debe decirlo.
    const corto = await V2.obtenerConsejosV2({ negocios: negs, hoy: HOY_R, cache, pedido: { desde: sumarDias(HOY_R, -3), hasta: HOY_R } });
    assert.deepEqual([corto.periodo.motivo, corto.periodo.desde, uno1.periodo.motivo], ['corto', VR.desde, 'sin_periodo'], 'la caché sirvió el aviso equivocado');
    // Y los mismos 28 días pedidos como periodo: «Periodo», no «Últimos 28 días».
    const pedidos = await V2.obtenerConsejosV2({ negocios: negs, hoy: HOY_R, cache, pedido: { desde: VR.desde, hasta: VR.hasta } });
    assert.equal(pedidos.periodo.origen, 'periodo');
    const otro = await V2.obtenerConsejosV2({ negocios: [{ id: B, nombre: 'B', tz: TZM }], hoy: HOY_R, cache });
    assert.deepEqual([otro.base.tickets, uno1.base.tickets], [5, 111]);
    await assert.rejects(() => V2.obtenerConsejosV2({ negocios: [], hoy: HOY_R, cache }), /negocioId/);
    await assert.rejects(() => V2.obtenerConsejosV2({ negocios: [{ id: '' }], hoy: HOY_R, cache }), /negocioId/);
  });
} finally {
  srv.detener();
}

await limpiar().catch(() => {});
await terminar();
