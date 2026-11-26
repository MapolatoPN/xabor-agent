// ─── Reportes › Ventas: «Lo que te diría un consejero» (Fase 1) ─────────────
//
// Contra una COPIA local test_botones_* con la 161 (nunca producción). Lo que
// se protege:
//   A. Reglas sin base:
//      · la ventana: los últimos 28 días SIN hoy, con su etiqueta;
//      · el «arrastre» de cada categoría (dinero de sus tickets, solos, con
//        ella y sin ella), solo entre tickets con desglose; el cuadre no se
//        mueve; el mismo folio en dos sucursales son DOS tickets;
//      · cada consejo aparece solo cuando se cumple su regla, en el borde
//        exacto de cada umbral; los extras y «Sin categoría» no aconsejan;
//      · con pocos tickets o poco desglose no aconseja y lo dice;
//      · los textos exactos;
//      · la caché corta no cruza negocios ni días.
//   B. Con Postgres y el servidor de verdad:
//      · la ruta da los mismos números que Reportes › Productos para esos días;
//      · hoy y el día 29 no entran;
//      · sin cualquiera de las dos banderas, 403; el estado dice si se ve;
//      · cada negocio ve lo suyo; «Todas» son las sucursales del mismo dueño
//        con las dos banderas; una ajena por id da 403;
//      · solo administradores.
//
// Los nombres y precios son inventados: el repo es público.
//
// Uso: correr-suite.ps1 -Suite fase-reportes-consejero -Plantilla <tpl con la 161>
import assert from 'node:assert/strict';
import { arrancarServidor } from './lib-servidor.mjs';

{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
}
const PUERTO = process.env.TEST_PORT_CONSEJERO || '4991';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const RP = await import('../src/services/reporteProductos.js');
const RC = await import('../src/services/reporteConsejero.js');
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
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 300)} · esperado=${JSON.stringify(e.expected)?.slice(0, 200)}` : '';
    const linea = `[${cat}] ${nombre}: ${String(e?.message || e).split('\n')[0]}${detalle}`;
    console.log(`FALLO ${linea}`); fallos.push(linea);
  }
}

// ─── Pedidos inventados ─────────────────────────────────────────────────────
// 120 tickets: DESAYUNOS es el motor; TACOS vende poco por sí solo pero va en
// 1 de cada 5 tickets; POSTRES va en pocos tickets pero los sube mucho; los
// EXTRAS son de tipo «extra».
const TZM = 'America/Matamoros';
const PRODS = (pre = '') => ({
  chil: { id: 1, nombre: `${pre}Chilaquiles`, precio: 150, tipo: 'platillo', cat: `${pre}DESAYUNOS`, catId: 1 },
  taco: { id: 2, nombre: `${pre}Taco de barbacoa`, precio: 25, tipo: 'platillo', cat: `${pre}TACOS`, catId: 2 },
  cafe: { id: 3, nombre: `${pre}Café`, precio: 40, tipo: 'bebida', cat: `${pre}BEBIDAS`, catId: 3 },
  pastel: { id: 4, nombre: `${pre}Pastel`, precio: 90, tipo: 'platillo', cat: `${pre}POSTRES`, catId: 4 },
  salsa: { id: 5, nombre: `${pre}Salsa extra`, precio: 10, tipo: 'extra', cat: `${pre}EXTRAS`, catId: 5 },
});
const GRUPOS = [
  { n: 66, items: [['chil', 1], ['cafe', 1]] },
  { n: 20, items: [['chil', 1], ['taco', 3], ['cafe', 1]] },
  { n: 4, items: [['taco', 4]] },
  { n: 10, items: [['cafe', 1]] },
  { n: 10, items: [['chil', 2], ['pastel', 1], ['cafe', 2]] },
  { n: 10, items: [['chil', 1], ['salsa', 2]] },
];
const folioDe = (i) => `T${String(i + 1).padStart(3, '0')}`;
function listaTickets(grupos = GRUPOS, P = PRODS()) {
  const xs = [];
  for (const g of grupos) {
    for (let k = 0; k < g.n; k++) {
      const total = g.items.reduce((s, [p, n]) => s + P[p].precio * n, 0);
      xs.push({ folio: folioDe(xs.length), items: g.items, total });
    }
  }
  return xs;
}
const catalogoDe = (P) => Object.values(P).map((p) => ({ id: p.id, nombre: p.nombre, tipo: p.tipo, disponible: true,
  categoria_id: p.catId, categoria: p.cat, categoria_activa: true }));
const lineaDe = (producto_id, nombre, tipo, cantidad, precio_unitario) => ({ producto_id, nombre, tipo, cantidad, precio_unitario, modificadores: [] });
function fuentePura({ grupos = GRUPOS, P = PRODS(), registro = () => 'vigente', negocio = { id: 'n', nombre: 'N' }, extra = [] } = {}) {
  const tks = listaTickets(grupos, P);
  const ventas = tks.map((x, i) => ({ folio: x.folio, estado: 'entregado', creado_at: '2026-11-10T16:00:00Z', registro: registro(i),
    datos: { total: x.total, subtotal: x.total, canal: 'pos', items: [{}] } }));
  const lineas = new Map(tks.map((x) => [x.folio, x.items.map(([p, n]) => lineaDe(P[p].id, P[p].nombre, P[p].tipo, n, P[p].precio))]));
  for (const e of extra) { ventas.push(e.venta); if (e.lineas) lineas.set(e.venta.folio, e.lineas); }
  return { negocio, tz: TZM, catalogo: catalogoDe(P), actual: { ventas, lineas }, anterior: null };
}
const reporteDe = (opts) => RP.construirReporteProductos({ fuentes: [fuentePura(opts)] });
const catDe = (r, nombre) => r.categorias.find((c) => c.nombre === nombre);
const consejosEsperados = (pre = '') => [
  { tipo: 'motor', titulo: `Tu motor: ${pre}DESAYUNOS`,
    texto: 'Es el 69.5 % de lo que vendes y va en el 88.3 % de tus tickets (106 de 120). Esos tickets dejan el 96.8 % del dinero. Cuida que nunca falte ni se tarde.' },
  { tipo: 'pesa_mas', titulo: `Pesa más de lo que parece: ${pre}TACOS`,
    texto: 'Es solo el 7.6 % de lo que vendes, pero va en 1 de cada 5 tickets, y esos tickets dejan el 22.8 % del dinero. '
      + 'Pocos vienen solo por esto: 4 de 24. Quien lo pide gasta $238 por ticket; quien no, $201. '
      + `Antes de quitarlo o cambiarlo, mira con qué se acompaña: ${pre}Café y ${pre}Chilaquiles.` },
  { tipo: 'sube_ticket', titulo: `Sube el ticket: ${pre}POSTRES`,
    texto: 'Quien lo pide gasta $470 por ticket; quien no, $185: 154 % más. Va en 1 de cada 12 tickets. Vale la pena ofrecerlo al tomar la orden.' },
];
const sinCategoria = (cs) => cs.map(({ tipo, titulo, texto }) => ({ tipo, titulo, texto }));

// Un reporte hecho a mano para probar cada umbral en su borde.
function catSint({ clave, nombre = clave, venta = 100, pct_venta, pct_tickets, pct_dinero, pct_solo = 10, con = 200, sin = 150, tickets = 50, tipo = 'platillo' }) {
  return {
    clave, nombre, venta, pct_venta, tickets, productos: [`p:${clave}`],
    arrastre: { tickets, pct_tickets, dinero_tickets: con * tickets, pct_dinero_tickets: pct_dinero, solo_tickets: Math.round(tickets * pct_solo / 100),
      solo_dinero: 0, pct_solo, ticket_con: con, ticket_sin: sin,
      con_categorias: [{ clave: 'otra', nombre: 'OTRA', tickets: 5, pct_tickets: 10 }], con_productos: [{ clave: 'p:x', nombre: 'Café', tickets: 5, pct_tickets: 10 }] },
    _tipo: tipo,
  };
}
function reporteSint(cats, { tickets = 500, desglose = 500, pctDesglose = 100 } = {}) {
  return {
    cuadre: { tickets },
    con_desglose: { tickets: desglose, venta_neta: 100000, pct_tickets: pctDesglose },
    productos: cats.map((c) => ({ clave: `p:${c.clave}`, tipo: c._tipo, unidades: 10 })),
    categorias: cats,
  };
}
const MOTOR = () => catSint({ clave: 'motor', pct_venta: 60, pct_tickets: 80, pct_dinero: 90, con: 200, sin: 200 });
const tiposDe = (r) => r.consejos.map((c) => `${c.tipo}:${c.categoria.clave}`);

// ─── A. Reglas, sin base ────────────────────────────────────────────────────
await t('REGLA', '1. la ventana son los últimos 28 días SIN hoy, con su etiqueta', async () => {
  assert.deepEqual(RC.ventanaDelConsejero('2026-11-25'), { desde: '2026-10-28', hasta: '2026-11-24', dias: 28, etiqueta: '28 oct – 24 nov' });
  assert.deepEqual(RC.ventanaDelConsejero('2027-01-05'), { desde: '2026-12-08', hasta: '2027-01-04', dias: 28, etiqueta: '8 dic 2026 – 4 ene 2027' });
  // El cambio de horario (1-nov en Matamoros) no corre los días: son fechas.
  assert.deepEqual(RC.ventanaDelConsejero('2026-11-02').desde, '2026-10-05');
  assert.equal(RC.DIAS_VENTANA, 28);
  for (const malo of ['', '2026-13-01', 'hoy', null]) assert.throws(() => RC.ventanaDelConsejero(malo), /inválida/);
});

await t('REGLA', '2. el arrastre: dinero de sus tickets, solos, con ella y sin ella; el cuadre no se mueve', async () => {
  const r = reporteDe();
  assert.equal(r.cuadre.cuadra, true, 'el arrastre movió el cuadre');
  assert.deepEqual([r.cuadre.tickets, r.cuadre.venta_neta], [120, 25040]);
  assert.deepEqual(r.con_desglose, { tickets: 120, venta_neta: 25040, pct_tickets: 100 });
  const tac = catDe(r, 'TACOS');
  assert.deepEqual([tac.venta, tac.pct_venta, tac.tickets], [1900, 7.6, 24]);
  const a = tac.arrastre;
  assert.deepEqual([a.tickets, a.pct_tickets, a.dinero_tickets, a.pct_dinero_tickets], [24, 20, 5700, 22.8], '20 × $265 + 4 × $100');
  assert.deepEqual([a.solo_tickets, a.solo_dinero, a.pct_solo], [4, 400, 16.7]);
  assert.deepEqual([a.ticket_con, a.ticket_sin], [237.5, 201.46], '«sin» = el resto: (25,040 − 5,700) / 96');
  assert.deepEqual(a.con_productos.map((x) => [x.nombre, x.tickets]), [['Café', 20], ['Chilaquiles', 20]]);
  assert.deepEqual(a.con_categorias.map((x) => [x.nombre, x.tickets, x.pct_tickets]), [['BEBIDAS', 20, 83.3], ['DESAYUNOS', 20, 83.3]]);
  const des = catDe(r, 'DESAYUNOS').arrastre;
  assert.deepEqual([des.tickets, des.pct_tickets, des.dinero_tickets, des.pct_dinero_tickets, des.solo_tickets], [106, 88.3, 24240, 96.8, 0]);
  const pos = catDe(r, 'POSTRES').arrastre;
  assert.deepEqual([pos.tickets, pos.dinero_tickets, pos.ticket_con, pos.ticket_sin], [10, 4700, 470, 184.91]);
  // Un ticket con DOS productos de la misma categoría cuenta su dinero UNA vez.
  const P = PRODS();
  const dosTacos = RP.construirReporteProductos({ fuentes: [{ negocio: { id: 'n', nombre: 'N' }, tz: TZM, anterior: null,
    catalogo: [...catalogoDe(P), { id: 6, nombre: 'Taco de pastor', tipo: 'platillo', disponible: true, categoria_id: 2, categoria: 'TACOS', categoria_activa: true }],
    actual: { ventas: [{ folio: 'D1', estado: 'entregado', creado_at: '2026-11-10T16:00:00Z', registro: 'vigente', datos: { total: 90, subtotal: 90, canal: 'pos', items: [{}] } }],
      lineas: new Map([['D1', [lineaDe(2, P.taco.nombre, 'platillo', 2, 25), lineaDe(6, 'Taco de pastor', 'platillo', 1, 40)]]]) } }] });
  const dt = catDe(dosTacos, 'TACOS').arrastre;
  assert.deepEqual([dt.tickets, dt.dinero_tickets, dt.solo_tickets, dt.solo_dinero, dt.con_categorias.length, dt.con_productos.length], [1, 90, 1, 90, 0, 0],
    'dos productos de la misma categoría contaron su ticket dos veces o se acompañaron entre sí');
  for (const c of r.categorias) {
    assert.equal(c.arrastre.tickets, c.tickets, `${c.nombre}: arrastre ≠ tickets`);
    assert.ok(c.arrastre.dinero_tickets >= c.venta, `${c.nombre}: sus tickets dejan menos que su propia venta`);
  }
});

await t('REGLA', '3. con y sin solo cuentan tickets con desglose; el cuadre sí los lleva', async () => {
  const sinRegistro = { venta: { folio: 'GRANDE', estado: 'entregado', creado_at: '2026-11-10T16:00:00Z', registro: 'sin',
    datos: { total: 10000, subtotal: 10000, canal: 'pos', items: [{}] } } };
  const r = reporteDe({ extra: [sinRegistro] });
  assert.deepEqual([r.cuadre.tickets, r.cuadre.venta_neta, r.cuadre.cuadra], [121, 35040, true]);
  assert.deepEqual(r.con_desglose, { tickets: 120, venta_neta: 25040, pct_tickets: 99.2 });
  assert.deepEqual([catDe(r, 'TACOS').arrastre.ticket_sin, catDe(r, 'TACOS').arrastre.pct_dinero_tickets], [201.46, 22.8], 'el ticket sin desglose entró al «sin»');
  // Un registro viejo tampoco cuenta.
  const viejos = reporteDe({ registro: (i) => (i < 12 ? 'viejo' : 'vigente') });
  assert.deepEqual([viejos.con_desglose.tickets, viejos.con_desglose.pct_tickets], [108, 90]);
});

await t('REGLA', '4. el mismo folio en dos sucursales son DOS tickets; una no ve los de otra', async () => {
  const P = PRODS();
  const deSucursal = (id, cantidad) => ({ negocio: { id, nombre: id }, tz: TZM, catalogo: catalogoDe(P), anterior: null,
    actual: { ventas: [{ folio: 'XAB-1', estado: 'entregado', creado_at: '2026-11-10T16:00:00Z', registro: 'vigente', datos: { total: cantidad * 25, subtotal: cantidad * 25, canal: 'pos', items: [{}] } }],
      lineas: new Map([['XAB-1', [lineaDe(2, P.taco.nombre, 'platillo', cantidad, 25)]]]) } });
  const juntas = RP.construirReporteProductos({ fuentes: [deSucursal('a', 2), deSucursal('b', 3)] });
  const a = catDe(juntas, 'TACOS').arrastre;
  assert.deepEqual([a.tickets, a.dinero_tickets, a.solo_tickets, juntas.con_desglose.tickets], [2, 125, 2, 2], 'los folios iguales se juntaron');
  const soloA = catDe(RP.construirReporteProductos({ fuentes: [deSucursal('a', 2)] }), 'TACOS').arrastre;
  assert.deepEqual([soloA.tickets, soloA.dinero_tickets], [1, 50], 'A vio el ticket de B');
});

await t('REGLA', '5. los tres consejos con su texto exacto', async () => {
  const k = RC.consejosDeReporte(reporteDe(), { ventana: RC.ventanaDelConsejero('2026-11-25') });
  assert.equal(k.estado, 'ok');
  assert.equal(k.aviso, '');
  assert.deepEqual(sinCategoria(k.consejos), consejosEsperados());
  assert.deepEqual(k.ventana.etiqueta, '28 oct – 24 nov');
  assert.deepEqual(k.base, { tickets: 120, con_desglose: 120, pct_desglose: 100, venta_neta: 25040 });
  assert.deepEqual(k.tabla.map((f) => f.nombre), ['DESAYUNOS', 'BEBIDAS', 'TACOS', 'POSTRES', 'EXTRAS'], 'la tabla trae todas, por venta');
  const tac = k.tabla.find((f) => f.nombre === 'TACOS');
  assert.deepEqual([tac.pct_venta, tac.tickets, tac.pct_tickets, tac.dinero_tickets, tac.pct_dinero_tickets, tac.solo_tickets, tac.pct_solo, tac.ticket_con, tac.ticket_sin, tac.aumento_pct],
    [7.6, 24, 20, 5700, 22.8, 4, 16.7, 237.5, 201.46, 18]);
  assert.deepEqual(tac.con_categorias.map((x) => x.nombre), ['BEBIDAS', 'DESAYUNOS']);
});

await t('REGLA', '6. «Pesa más»: cada umbral en su borde, los extras no, y solo el más claro', async () => {
  const base = { pct_venta: 9.9, pct_tickets: 10, pct_dinero: 19.8, pct_solo: 25 };
  const caso = (cambios) => tiposDe(RC.consejosDeReporte(reporteSint([MOTOR(), catSint({ clave: 'x', ...base, ...cambios, con: 150, sin: 150 })])));
  assert.deepEqual(caso({}), ['motor:motor', 'pesa_mas:x'], 'en el borde exacto debe salir');
  assert.deepEqual(caso({ pct_venta: 10, pct_dinero: 20 }), ['motor:motor'], 'con 10 % de la venta ya no es «poca»');
  assert.deepEqual(caso({ pct_tickets: 9.9 }), ['motor:motor'], 'en menos del 10 % de los tickets');
  assert.deepEqual(caso({ pct_dinero: 19.7 }), ['motor:motor'], 'menos del doble');
  assert.deepEqual(caso({ pct_solo: 25.1 }), ['motor:motor'], 'más del 25 % lo lleva solo');
  assert.deepEqual(caso({ tipo: 'extra' }), ['motor:motor'], 'una categoría de extras');
  // Hay menús con TODO dado de alta como «platillo»: los extras se reconocen por el nombre.
  assert.deepEqual(caso({ nombre: 'EXTRAS' }), ['motor:motor'], 'una categoría que se llama EXTRAS, con productos «platillo»');
  assert.deepEqual(caso({ nombre: 'Extras y complementos' }), ['motor:motor']);
  assert.deepEqual(caso({ nombre: 'Platillos extraordinarios' }), ['motor:motor', 'pesa_mas:x'], '«extraordinarios» no es «extras»');
  const conExtras = RC.consejosDeReporte(reporteSint([MOTOR(),
    catSint({ clave: 'e', nombre: 'EXTRAS', pct_venta: 1, pct_tickets: 15, pct_dinero: 30, pct_solo: 5, con: 150, sin: 150 }),
    catSint({ clave: 't', nombre: 'TACOS', pct_venta: 6, pct_tickets: 20, pct_dinero: 25, pct_solo: 12, con: 150, sin: 150 })]));
  assert.deepEqual(tiposDe(conExtras), ['motor:motor', 'pesa_mas:t'], 'EXTRAS (todo «platillo») le ganó a TACOS');
  // Dos candidatas: sale la que más dinero arrastra por encima de su venta.
  const dos = RC.consejosDeReporte(reporteSint([MOTOR(),
    catSint({ clave: 'chica', pct_venta: 5, pct_tickets: 20, pct_dinero: 15, con: 150, sin: 150 }),
    catSint({ clave: 'grande', pct_venta: 5, pct_tickets: 20, pct_dinero: 30, con: 150, sin: 150 })]));
  assert.deepEqual(tiposDe(dos), ['motor:motor', 'pesa_mas:grande']);
  assert.equal(RC.UMBRALES.pesaMas.cuantos, 1);
});

await t('REGLA', '7. «Sube el ticket»: 15 % y 5 % en su borde; nunca repite una categoría', async () => {
  const caso = (con, pctTickets) => tiposDe(RC.consejosDeReporte(reporteSint([MOTOR(),
    catSint({ clave: 'y', pct_venta: 30, pct_tickets: pctTickets, pct_dinero: 40, con, sin: 100 })])));
  assert.deepEqual(caso(115, 5), ['motor:motor', 'sube_ticket:y'], '15 % y 5 % exactos deben salir');
  assert.deepEqual(caso(114, 5), ['motor:motor'], '14 % no es «claramente mayor»');
  assert.deepEqual(caso(200, 4.9), ['motor:motor'], 'en menos del 5 % de los tickets');
  assert.equal(RC.aumentoDelTicket(115, 100), 15);
  assert.equal(RC.aumentoDelTicket(100, null), null);
  // La que ya salió como «pesa más» no sale otra vez; la siguiente sí.
  const r = RC.consejosDeReporte(reporteSint([MOTOR(),
    catSint({ clave: 'p', pct_venta: 5, pct_tickets: 20, pct_dinero: 30, con: 300, sin: 100 }),
    catSint({ clave: 's', pct_venta: 30, pct_tickets: 10, pct_dinero: 40, con: 130, sin: 100 })]));
  assert.deepEqual(tiposDe(r), ['motor:motor', 'pesa_mas:p', 'sube_ticket:s']);
});

await t('REGLA', '8. el motor es la que más vende; «Sin categoría» nunca aconseja ni sale en la tabla', async () => {
  const r = RC.consejosDeReporte(reporteSint([catSint({ clave: 'sin', nombre: 'Sin categoría (no ligado al menú)', venta: 999, pct_venta: 70, pct_tickets: 90, pct_dinero: 95 }),
    catSint({ clave: 'c:1', nombre: 'SEGUNDA', pct_venta: 20, pct_tickets: 40, pct_dinero: 60, con: 200, sin: 200 })]));
  assert.deepEqual(tiposDe(r), ['motor:c:1']);
  assert.deepEqual(r.tabla.map((f) => f.clave), ['c:1']);
});

await t('REGLA', '9. con pocos tickets o poco desglose no aconseja y lo dice; la tabla sigue', async () => {
  const cats = () => [MOTOR(), catSint({ clave: 'x', pct_venta: 5, pct_tickets: 20, pct_dinero: 30, con: 150, sin: 150 })];
  const pocos = RC.consejosDeReporte(reporteSint(cats(), { desglose: 99 }));
  assert.deepEqual([pocos.estado, pocos.consejos.length, pocos.tabla.length], ['pocos_tickets', 0, 2]);
  assert.equal(pocos.aviso, 'Con 99 tickets en estos días todavía no hay suficiente para aconsejarte: hacen falta al menos 100.');
  assert.equal(RC.consejosDeReporte(reporteSint(cats(), { desglose: 100 })).estado, 'ok', 'con 100 exactos sí');
  const poco = RC.consejosDeReporte(reporteSint(cats(), { pctDesglose: 89.9 }));
  assert.deepEqual([poco.estado, poco.consejos.length], ['sin_desglose', 0]);
  assert.equal(poco.aviso, 'Solo el 89.9 % de los tickets trae el detalle de lo que se vendió. Con tan poco detalle prefiero no aconsejarte: los números podrían engañar.');
  assert.equal(RC.consejosDeReporte(reporteSint(cats(), { pctDesglose: 90 })).estado, 'ok', 'con 90 % exacto sí');
  const nada = RC.consejosDeReporte(reporteSint([], { tickets: 0, desglose: 0, pctDesglose: 0 }));
  assert.deepEqual([nada.estado, nada.aviso], ['sin_ventas', 'En estos días no hay ventas para darte un consejo.']);
  // De punta a punta: 13 de 120 tickets con registro viejo = 89.2 %.
  const viejos = RC.consejosDeReporte(reporteDe({ registro: (i) => (i < 13 ? 'viejo' : 'vigente') }));
  assert.deepEqual([viejos.estado, viejos.base.pct_desglose], ['sin_desglose', 89.2]);
});

await t('REGLA', '10. el texto cambia con los números: «casi nadie», sin «quien lo pide» y frecuencias', async () => {
  const pm = (cambios) => RC.consejosDeReporte(reporteSint([MOTOR(), catSint({ clave: 'x', pct_venta: 5, pct_tickets: 20, pct_dinero: 30, ...cambios })]))
    .consejos.find((c) => c.tipo === 'pesa_mas').texto;
  assert.match(pm({ pct_solo: 9.9 }), /Casi nadie viene solo por esto: 5 de 50\./);
  assert.match(pm({ pct_solo: 10 }), /Pocos vienen solo por esto/);
  assert.doesNotMatch(pm({ con: 140, sin: 150 }), /Quien lo pide/, 'dijo que gasta más quien gasta menos');
  assert.match(pm({ con: 151, sin: 150 }), /Quien lo pide gasta \$151 por ticket; quien no, \$150\./);
  assert.equal(RC.frecuenciaDeTickets(20), '1 de cada 5 tickets');
  assert.equal(RC.frecuenciaDeTickets(8.3), '1 de cada 12 tickets');
  assert.equal(RC.frecuenciaDeTickets(50), 'la mitad de tus tickets');
  assert.equal(RC.frecuenciaDeTickets(40), 'el 40 % de tus tickets');
  assert.equal(RC.frecuenciaDeTickets(88.3), 'el 88.3 % de tus tickets');
  assert.equal(RC.frecuenciaDeTickets(3), 'el 3 % de tus tickets');
});

await t('REGLA', '11. la caché corta no cruza negocios ni días, y caduca', async () => {
  let ahora = 0;
  const c = RC.crearCacheConsejero({ ttlMs: 1000, maximo: 2, reloj: () => ahora });
  const v1 = RC.ventanaDelConsejero('2026-11-25'), v2 = RC.ventanaDelConsejero('2026-11-26');
  const kAB = c.llave([{ id: 'b' }, { id: 'a' }], v1);
  assert.equal(kAB, c.llave([{ id: 'a' }, { id: 'b' }], v1), 'el orden de las sucursales no importa');
  assert.notEqual(kAB, c.llave([{ id: 'a' }], v1));
  assert.notEqual(kAB, c.llave([{ id: 'a' }, { id: 'b' }], v2));
  c.guardar(kAB, 'x');
  assert.equal(c.leer(kAB), 'x');
  assert.equal(c.leer(c.llave([{ id: 'a' }], v1)), null, 'A recibió la cuenta de A+B');
  ahora = 1001;
  assert.equal(c.leer(kAB), null, 'no caducó');
  c.guardar('1', 1); c.guardar('2', 2); c.guardar('3', 3);
  assert.deepEqual([c.leer('1'), c.leer('2'), c.leer('3')], [null, 2, 3], 'el tope no sacó al más viejo');
  assert.throws(() => c.llave([{ id: '' }], v1), /negocioId/);
});

// ─── B. Con Postgres y el servidor ─────────────────────────────────────────
const TAG = 'RC1' + (Date.now() % 1e8).toString(36).toUpperCase();
const PRE = `${TAG} `;
const SLUGS = ['a', 'b', 'c', 'd', 'e', 'x'].map((l) => `${TAG.toLowerCase()}-rep-cons-${l}`);
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-rep-cons-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
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

async function negocio(slug, nombre, { productos = true, consejero = true } = {}) {
  const n = await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [nombre, slug]);
  for (const m of ['pos', 'caja']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
  if (productos) await q(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reportes_productos_v1','true')`, [n.id]);
  if (consejero) await q(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reportes_consejero_v1','true')`, [n.id]);
  return n.id;
}
async function usuario(neg, nombre) {
  return (await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}-${Date.now()}@test.local`])).id;
}
const miembro = (u, neg, rol) => q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)', [u, neg, rol]);
const galleta = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
// El menú de PRODS en un negocio: devuelve los ids reales por clave.
async function menu(neg, P) {
  const cats = {}, ids = {};
  for (const [k, p] of Object.entries(P)) {
    if (!cats[p.cat]) cats[p.cat] = (await uno('INSERT INTO menu_categorias (nombre, negocio_id, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id', [p.cat, neg, p.catId])).id;
    ids[k] = (await uno('INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible) VALUES ($1,$2,$3,$4,TRUE) RETURNING id', [neg, cats[p.cat], p.nombre, p.precio])).id;
    await q('UPDATE menu_productos SET tipo = $2 WHERE id = $1', [ids[k], p.tipo]);
  }
  return ids;
}
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
// created_at es timestamp SIN zona que guarda UTC.
function utcLocal(fecha, h, mi = 0) {
  const [y, m, d] = fecha.split('-').map(Number);
  return instanteLocal(y, m, d, h, mi, 0, TZM).toISOString().slice(0, 19).replace('T', ' ');
}
async function pedido(neg, folio, estado, datos, utc) {
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, estado, JSON.stringify({ id: folio, ...datos }), neg, utc]);
}
const itemsDe = (items, P, ids) => items.map(([k, n]) => ({ producto_id: ids[k], nombre: P[k].nombre, cantidad: n, precio_unitario: P[k].precio }));
const datosDe = (items, P, ids) => {
  const total = items.reduce((s, [k, n]) => s + P[k].precio * n, 0);
  return { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: total, total, items: itemsDe(items, P, ids) };
};

const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: TZM }).format(new Date());
const V = RC.ventanaDelConsejero(HOY);
const P = PRODS(PRE);

const A = await negocio(SLUGS[0], `${TAG} Sucursal A`);
const B = await negocio(SLUGS[1], `${TAG} Sucursal B`);
const C = await negocio(SLUGS[2], `${TAG} Sucursal C`);
const D = await negocio(SLUGS[3], `${TAG} Sucursal D`, { consejero: false });
const E = await negocio(SLUGS[4], `${TAG} Sucursal E`, { productos: false });
const X = await negocio(SLUGS[5], `${TAG} Otro dueño`);
// El dueño administra A, B, D y E; en C es operador. X es de otra persona.
const DUENO = await usuario(A, `${TAG} Dueño`);
for (const n of [A, B, D, E]) await miembro(DUENO, n, 'admin');
await miembro(DUENO, C, 'staff');
const STAFF_A = await usuario(A, `${TAG} Cajera`); await miembro(STAFF_A, A, 'staff');
const AJENO = await usuario(X, `${TAG} Ajeno`); await miembro(AJENO, X, 'admin');
const S = {
  duenoA: galleta(DUENO, A, 'admin'), duenoD: galleta(DUENO, D, 'admin'), duenoE: galleta(DUENO, E, 'admin'),
  staffA: galleta(STAFF_A, A, 'staff'), ajeno: galleta(AJENO, X, 'admin'),
};

// A: los 120 tickets de la parte A, repartidos en los 24 días anteriores a hoy.
const idsA = await menu(A, P);
const tks = listaTickets(GRUPOS, P);
for (let i = 0; i < tks.length; i++) {
  await pedido(A, `${TAG}-${tks[i].folio}`, 'entregado', datosDe(tks[i].items, P, idsA), utcLocal(sumarDias(HOY, -(1 + (i % 24))), 10, i % 50));
}
// Fuera de la ventana: hoy, el día 29 y un cancelado. Llevan tacos: si entraran, TACOS cambiaría.
await pedido(A, `${TAG}-HOY`, 'entregado', datosDe([['taco', 10]], P, idsA), utcLocal(HOY, 0, 5));
await pedido(A, `${TAG}-D29`, 'entregado', datosDe([['taco', 10]], P, idsA), utcLocal(sumarDias(HOY, -29), 12));
await pedido(A, `${TAG}-CANC`, 'cancelado', datosDe([['taco', 10]], P, idsA), utcLocal(sumarDias(HOY, -3), 12));
// B: dos tickets con tacos (mismo menú por nombre, otros ids).
const idsB = await menu(B, P);
await pedido(B, `${TAG}-B1`, 'entregado', datosDe([['taco', 2]], P, idsB), utcLocal(sumarDias(HOY, -2), 11));
await pedido(B, `${TAG}-B2`, 'entregado', datosDe([['chil', 1], ['taco', 1]], P, idsB), utcLocal(sumarDias(HOY, -5), 11));
// D tiene ventas (para ver que no se cuelan) y X tiene su propio menú.
const idsD = await menu(D, PRODS(`${TAG} D `));
await pedido(D, `${TAG}-D1`, 'entregado', datosDe([['chil', 5]], PRODS(`${TAG} D `), idsD), utcLocal(sumarDias(HOY, -2), 11));
const PX = { torta: { id: 9, nombre: `${TAG} Torta secreta`, precio: 77, tipo: 'platillo', cat: `${TAG} TORTAS`, catId: 9 } };
const idsX = await menu(X, PX);
for (let i = 0; i < 3; i++) await pedido(X, `${TAG}-X${i}`, 'entregado', datosDe([['torta', 1]], PX, idsX), utcLocal(sumarDias(HOY, -2), 11, i));
for (const neg of [A, B, D, X]) await procesarNegocio(neg);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, cookie) {
  const r = await fetch(srv.base + path, { headers: cookie ? { Cookie: cookie } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const filaDe = (body, nombre) => body.tabla.find((f) => f.nombre === nombre);

try {
  await t('HTTP', '12. la ruta da los consejos de los últimos 28 días sin hoy, con los textos de la parte A', async () => {
    const r = await api('/api/reportes/consejero', S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.ventana, V);
    assert.equal(r.body.hoy, HOY);
    assert.deepEqual([r.body.sucursal, r.body.elegidas], ['actual', [A]]);
    assert.equal(r.body.estado, 'ok');
    assert.deepEqual(sinCategoria(r.body.consejos), consejosEsperados(PRE), 'la base y la parte A dicen cosas distintas');
    assert.deepEqual(r.body.base, { tickets: 120, con_desglose: 120, pct_desglose: 100, venta_neta: 25040 }, 'hoy, el día 29 o el cancelado se colaron');
    assert.equal(filaDe(r.body, `${PRE}TACOS`).tickets, 24);
  });

  await t('HTTP', '13. los números son los de Reportes › Productos para esos mismos días', async () => {
    const r = await api('/api/reportes/consejero', S.duenoA);
    const p = await api(`/api/reportes/productos?desde=${V.desde}&hasta=${V.hasta}`, S.duenoA);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.cuadre.venta_neta, r.body.base.venta_neta);
    assert.equal(p.body.cuadre.tickets, r.body.base.tickets);
    assert.equal(r.body.tabla.length, p.body.categorias.length);
    for (const f of r.body.tabla) {
      const c = p.body.categorias.find((x) => x.clave === f.clave);
      assert.ok(c, `${f.nombre} no está en Productos`);
      assert.deepEqual([f.venta, f.pct_venta, f.tickets], [c.venta, c.pct_venta, c.tickets], f.nombre);
      const a = c.arrastre;
      assert.deepEqual([f.dinero_tickets, f.pct_dinero_tickets, f.solo_tickets, f.ticket_con, f.ticket_sin],
        [a.dinero_tickets, a.pct_dinero_tickets, a.solo_tickets, a.ticket_con, a.ticket_sin], f.nombre);
    }
    // Sin leer el periodo anterior, lo de este periodo no cambia.
    const negs = [{ id: A, nombre: 'A', tz: TZM }];
    const con = await RP.obtenerReporteProductos({ negocios: negs, desde: V.desde, hasta: V.hasta, db: pool });
    const sin = await RP.obtenerReporteProductos({ negocios: negs, desde: V.desde, hasta: V.hasta, db: pool, conAnterior: false });
    assert.deepEqual(sin.categorias, con.categorias);
    assert.deepEqual(sin.cuadre, con.cuadre);
  });

  await t('SEGURIDAD', '14. sin cualquiera de las dos banderas: 403; el estado dice si se ve', async () => {
    const estA = await api('/api/reportes/productos/estado', S.duenoA);
    assert.deepEqual([estA.status, estA.body.activo, estA.body.consejero], [200, true, true]);
    const estD = await api('/api/reportes/productos/estado', S.duenoD);
    assert.deepEqual([estD.body.activo, estD.body.consejero], [true, false], 'D no tiene el consejero');
    const estE = await api('/api/reportes/productos/estado', S.duenoE);
    assert.deepEqual([estE.body.activo, 'consejero' in estE.body], [false, false], 'E no tiene Productos');
    for (const s of [S.duenoD, S.duenoE]) {
      const x = await api('/api/reportes/consejero', s);
      assert.deepEqual([x.status, x.body.code], [403, 'REPORTE_APAGADO']);
    }
  });

  await t('SEGURIDAD', '15. cada negocio ve lo suyo; el query no puede pedir otro negocio', async () => {
    const x = await api('/api/reportes/consejero', S.ajeno);
    assert.equal(x.status, 200);
    assert.deepEqual([x.body.estado, x.body.base.tickets], ['pocos_tickets', 3]);
    assert.deepEqual(x.body.tabla.map((f) => f.nombre), [`${TAG} TORTAS`]);
    assert.deepEqual(x.body.sucursales.map((s) => s.id), [X]);
    for (const extra of [`negocioId=${A}`, `negocio_id=${A}`]) {
      const y = await api(`/api/reportes/consejero?${extra}`, S.ajeno);
      assert.deepEqual(y.body.tabla.map((f) => f.nombre), [`${TAG} TORTAS`], `${extra} cruzó de negocio`);
    }
    assert.equal((await api(`/api/reportes/consejero?sucursal=${A}`, S.ajeno)).status, 403, 'una sucursal ajena por id');
    const a = await api('/api/reportes/consejero', S.duenoA);
    assert.ok(!JSON.stringify(a.body).includes('Torta secreta'), 'A vio datos de X');
    assert.ok(!JSON.stringify(a.body).includes(`${TAG} D `), 'A vio datos de D');
  });

  await t('SEGURIDAD', '16. «Todas» son las sucursales del mismo dueño con las DOS banderas', async () => {
    const r = await api('/api/reportes/consejero?sucursal=todas', S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sucursales.map((s) => s.id), [A, B], 'ni C (operador), ni D (sin consejero), ni E (sin Productos)');
    assert.deepEqual([r.body.sucursal, r.body.elegidas], ['todas', [A, B]]);
    assert.deepEqual([r.body.base.tickets, filaDe(r.body, `${PRE}TACOS`).tickets], [122, 26], 'A (24 con tacos) + B (2)');
    const b = await api(`/api/reportes/consejero?sucursal=${B}`, S.duenoA);
    assert.deepEqual([b.status, b.body.estado, b.body.base.tickets], [200, 'pocos_tickets', 2]);
    for (const ajena of [C, D, E, X, '00000000-0000-0000-0000-000000000000', 'cualquiera']) {
      assert.equal((await api(`/api/reportes/consejero?sucursal=${ajena}`, S.duenoA)).status, 403, `sucursal=${ajena}`);
    }
    // La caché de «Todas» no se le sirve a «solo A».
    const a = await api('/api/reportes/consejero', S.duenoA);
    assert.deepEqual([a.body.base.tickets, filaDe(a.body, `${PRE}TACOS`).tickets], [120, 24]);
  });

  await t('SEGURIDAD', '17. solo administradores: el operador 403 y sin sesión 401', async () => {
    assert.equal((await api('/api/reportes/consejero', S.staffA)).status, 403);
    assert.equal((await api('/api/reportes/consejero')).status, 401);
  });

  await t('HTTP', '18. obtenerConsejos usa la caché y la llave lleva los negocios', async () => {
    const cache = RC.crearCacheConsejero();
    const negs = [{ id: A, nombre: 'A', tz: TZM }];
    const uno1 = await RC.obtenerConsejos({ negocios: negs, hoy: HOY, cache });
    const uno2 = await RC.obtenerConsejos({ negocios: negs, hoy: HOY, cache });
    assert.equal(uno1, uno2, 'no usó la caché');
    const otro = await RC.obtenerConsejos({ negocios: [{ id: B, nombre: 'B', tz: TZM }], hoy: HOY, cache });
    assert.deepEqual([otro.base.tickets, uno1.base.tickets], [2, 120]);
    await assert.rejects(() => RC.obtenerConsejos({ negocios: [], hoy: HOY, cache }), /negocioId/);
  });
} finally {
  srv.detener();
}

await limpiar().catch(() => {});
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
