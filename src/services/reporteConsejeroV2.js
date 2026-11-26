// Reportes → «Lo que te diría un consejero», VERSIÓN 2.
//
// Corrección pedida por el dueño el 25-nov-2026 («los cálculos cuadran, pero
// varias conclusiones son engañosas»), con el plan aprobado y sus valores
// recomendados. Sale solo en los negocios con la bandera
// `reportes_consejero_v2`; los demás siguen con la versión 1
// (reporteConsejero.js), que no cambia.
//
// Lo que cambia contra la versión 1:
//   1. «Sube el ticket» compara el gasto POR PLATILLO PRINCIPAL, cada canal
//      (mesa, domicilio, recoger) por separado y sin mezclarlos, y solo sale si
//      la diferencia del ticket se mantiene después de ese ajuste. No se usa el
//      gasto por persona: casi todas las mesas dicen 2 (la pantalla lo trae
//      marcado) y los demás canales no lo guardan.
//      Platillo principal = cada pieza que no sea de una categoría de Bebidas,
//      Extras o Envío (por el NOMBRE: en Obispado y Acuña todo el menú es
//      «platillo») ni un extra suelto (extra, tortillas, salsas). En cada
//      ticket, cada 3 tacos cuentan como un platillo, redondeando hacia arriba.
//   2. «Se acompaña con» usa el lift: cuántas veces más aparece otra categoría
//      en los tickets de esta que en todos los tickets. Solo lo que pasa de 1.3
//      y se repite en al menos 30 tickets; si nada pasa, la celda va vacía.
//   3. Mínimos: ninguna tarjeta de una categoría con menos de 100 tickets, ni
//      una comparación con un grupo de menos de 30. En la tabla, las
//      categorías con menos del 1 % de la venta van juntas en «Otras».
//   4. Cada tarjeta dice qué cambió contra el periodo anterior (venta,
//      tickets, ticket promedio). Primero las que cambiaron más del 10 %.
//      «Tu motor» solo sale si cambió: decir que lo que más vendes es lo que
//      más vendes no aconseja nada.
//   5. Tarjetas nuevas: «Atrae por sí sola», «Día u hora floja» y «Canal». No
//      hay costos por platillo: se habla de venta, nunca de margen.
//   6. Cada tarjeta termina en UNA acción y el número que hay que revisar en 2
//      semanas. Sin frases de causa y efecto («quien lo pide gasta más»): son
//      correlaciones, y se dicen como tales.
//   7. Periodo: el de arriba de Reportes si tiene 14 días o más; si no, los
//      últimos 28 días sin hoy, y la pantalla lo dice junto al título.
//   8. Los nombres de categoría en MAYÚSCULAS se muestran como los demás
//      («CHILAQUILES» → «Chilaquiles»). Solo aquí: el menú no se toca, porque
//      su nombre lo usan también el bot, la tienda y Rappi.
//
// Las cuentas salen del MISMO reporte de Productos (obtenerReporteProductos,
// con su resumen por ticket), así que la tabla y Productos nunca dicen cosas
// distintas. Reglas fijas, sin inteligencia artificial. Solo lectura.
// negocioId OBLIGATORIO en cada lectura; qué sucursales se ven lo decide la
// ruta (reporteProductosRutas.js).
import { pool } from './database.js';
import { obtenerReporteProductos, FRANJAS, DIAS_SEMANA } from './reporteProductos.js';
import {
  ventanaDelConsejero, etiquetaDeVentana, frecuenciaDeTickets, crearCacheConsejero, esDeExtras,
  MINIMO_TICKETS, MINIMO_PCT_DESGLOSE,
} from './reporteConsejero.js';

export const BANDERA_CONSEJERO_V2 = 'reportes_consejero_v2';
export const MINIMO_DIAS_PERIODO = 14;
export const MAX_TARJETAS = 5;
export const DIAS_PARA_REVISAR = 14;
export const TACOS_POR_PLATILLO = 3;
export const UMBRALES_V2 = Object.freeze({
  ticketsCategoria: 100,
  subgrupo: 30,
  pctTabla: 1,
  lift: 1.3,
  cambio: 10,
  // Igual que la versión 1, con los mínimos de arriba.
  pesaMas: Object.freeze({ maxPctVenta: 10, minPctTickets: 10, factorDinero: 2, maxPctSolo: 25 }),
  // El aumento se pide DOS veces: en el ticket y en el gasto por platillo.
  subeTicket: Object.freeze({ minAumentoPct: 15, minPctTicketsCanal: 5 }),
  atraeSola: Object.freeze({ minPctSolo: 25 }),
  // Cae al menos 10 % contra sí mismo y al menos 10 puntos más que el negocio.
  debil: Object.freeze({ minCaidaPct: 10, puntosBajoGeneral: 10 }),
  canal: Object.freeze({ minCambioPct: 10 }),
});
const SIN_CATEGORIA = 'sin';
const TOP_JUNTO = 3;
// Los canales que se comparan (la modalidad de Productos); «sin modalidad» no.
const CANALES = Object.freeze([
  Object.freeze({ clave: 'mesa', titulo: 'Mesas', En: 'En mesas', en: 'en mesas', de: 'de mesa', cuida: 'las mesas se atiendan sin demora' }),
  Object.freeze({ clave: 'domicilio', titulo: 'A domicilio', En: 'A domicilio', en: 'a domicilio', de: 'a domicilio', cuida: 'los pedidos a domicilio salgan sin demora' }),
  Object.freeze({ clave: 'recoger', titulo: 'Para recoger', En: 'Para recoger', en: 'para recoger', de: 'para recoger', cuida: 'los pedidos para recoger estén a tiempo' }),
]);
export const NOTAS_V2 = Object.freeze([
  'No hay costos por platillo: aquí se habla de venta, no de ganancia.',
  'No se calcula el gasto por persona: casi todas las mesas dicen 2 personas (la pantalla lo trae marcado) y los demás canales no lo guardan. '
    + 'Por eso «Sube el ticket» compara el gasto por platillo, cada canal por separado. Cada 3 tacos cuentan como un platillo.',
  'En las mesas, el día y la hora son los de llegada. Una mesa cuenta como un ticket, y «el dinero» es la venta neta, como en Ventas.',
]);

// ─── Fechas ────────────────────────────────────────────────────────────────
const DIA_MS = 24 * 60 * 60 * 1000;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const esFecha = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`));
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS) + 1;
const fechaCorta = (f) => { const [, m, d] = f.split('-').map(Number); return `${d} ${MESES[m - 1]}`; };

/**
 * Los días que mira el consejero. `pedido` = { desde, hasta } del periodo de
 * arriba (o nada). Con 14 días o más, ese mismo periodo; si no, los últimos 28
 * días sin hoy. { desde, hasta, dias, etiqueta, origen: 'periodo' | '28_dias',
 * motivo: null | 'corto' | 'sin_periodo', incluye_hoy }.
 */
export function periodoDelConsejero(pedido, hoy) {
  if (!esFecha(hoy)) { const e = new Error('fecha de hoy inválida'); e.code = 'RANGO_INVALIDO'; throw e; }
  const desde = pedido?.desde, hasta0 = pedido?.hasta;
  if (esFecha(desde) && esFecha(hasta0) && desde <= hasta0 && desde <= hoy) {
    const hasta = hasta0 > hoy ? hoy : hasta0;
    const dias = diasEntre(desde, hasta);
    if (dias >= MINIMO_DIAS_PERIODO) {
      return { desde, hasta, dias, etiqueta: etiquetaDeVentana(desde, hasta), origen: 'periodo', motivo: null, incluye_hoy: hasta === hoy };
    }
    return { ...ventanaDelConsejero(hoy), origen: '28_dias', motivo: 'corto', incluye_hoy: false };
  }
  return { ...ventanaDelConsejero(hoy), origen: '28_dias', motivo: 'sin_periodo', incluye_hoy: false };
}

// ─── Cómo se dicen los números ────────────────────────────────────────────
const pct = (n) => `${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
const entero = (n) => Math.round(Number(n || 0)).toLocaleString('es-MX');
const dinero = (n) => `$${Math.round(Number(n || 0)).toLocaleString('es-MX')}`;
const lista = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
const pct1 = (parte, total) => (total > 0 ? Math.round((parte / total) * 1000) / 10 : 0);
const cambioPct = (actual, anterior) => (anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null);
const aumento = (a, b) => (a > 0 && b > 0 ? Math.round((a / b - 1) * 100) : null);
/** «+12 %», «−3.5 %», «0 %» (con el signo menos de verdad). */
export function conSigno(n) {
  if (n === null || n === undefined) return 'sin dato';
  const x = Math.round(Number(n) * 10) / 10;
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${pct(Math.abs(x))}`;
}
const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const plural = (dia) => (/s$/.test(dia) ? dia : `${dia}s`);

/**
 * «CHILAQUILES» → «Chilaquiles», «NONNA MAYE» → «Nonna Maye», «HUEVOS AL
 * GUSTO» → «Huevos al Gusto». Lo que ya trae minúsculas se queda igual.
 */
const MENORES = new Set(['a', 'al', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'los', 'o', 'para', 'por', 'sin', 'y']);
export function nombreVisible(nombre) {
  const s = String(nombre ?? '').trim();
  if (!s || s !== s.toLocaleUpperCase('es-MX') || s === s.toLocaleLowerCase('es-MX')) return s;
  return s.toLocaleLowerCase('es-MX').split(/(\s+)/).map((p, i) => (
    /^\s+$/.test(p) || (i > 0 && MENORES.has(p)) ? p : p.charAt(0).toLocaleUpperCase('es-MX') + p.slice(1)
  )).join('');
}

// ─── Platillos principales de un ticket ────────────────────────────────────
const NO_PRINCIPAL = /(^|[^a-z0-9])(bebidas?|extras?|envios?)([^a-z0-9]|$)/;
const EXTRA_SUELTO = /^(extras?|tortillas?|salsas?)([^a-z0-9]|$)/;
const DE_TACOS = /(^|[^a-z0-9])tacos?([^a-z0-9]|$)/;

/**
 * Cuántos platillos principales lleva un ticket. `lineas`: [[producto, categoría,
 * piezas, monto]] del resumen por ticket; `nombres`: { categorias, productos }.
 */
export function platillosDelTicket(lineas = [], nombres = {}) {
  let platillos = 0, tacos = 0;
  for (const [prod, cat, piezas] of lineas) {
    const n = Number(piezas) || 0;
    if (n <= 0) continue;
    const nomCat = sinAcentos(nombres.categorias?.[cat] || '');
    if (NO_PRINCIPAL.test(nomCat)) continue;
    if (EXTRA_SUELTO.test(sinAcentos(nombres.productos?.[prod] || ''))) continue;
    if (DE_TACOS.test(nomCat)) tacos += n; else platillos += n;
  }
  return platillos + Math.ceil(tacos / TACOS_POR_PLATILLO - 1e-9);
}

// ─── Lo que se cuenta de cada periodo ──────────────────────────────────────
// `tks`: el resumen por ticket de Productos. Las categorías solo se cuentan en
// tickets con desglose (como el «arrastre»); venta, canal, día y hora, en todos.
function estadisticas(tks = [], nombres = {}) {
  const filas = [];
  const cats = new Map();
  let netaDesglose = 0;
  for (const t of tks) {
    if (!t.desglose) continue;
    netaDesglose += t.neta;
    const porCat = new Map();
    for (const [, ck, , monto] of t.lineas) porCat.set(ck, (porCat.get(ck) || 0) + monto);
    const fila = { t, cats: porCat, platillos: platillosDelTicket(t.lineas, nombres) };
    filas.push(fila);
    for (const [ck, monto] of porCat) {
      const c = cats.get(ck) || { tickets: 0, venta: 0, dinero: 0, solo: 0, soloDinero: 0, con: new Map() };
      c.tickets++; c.venta += monto; c.dinero += t.neta;
      if (porCat.size === 1) { c.solo++; c.soloDinero += t.neta; }
      for (const otra of porCat.keys()) if (otra !== ck) c.con.set(otra, (c.con.get(otra) || 0) + 1);
      cats.set(ck, c);
    }
  }
  return { tickets: tks, filas, N: filas.length, netaDesglose, cats };
}

// Venta (pesos), tickets y ticket promedio de una categoría.
const valoresCat = (c) => (c && c.tickets
  ? { venta: c.venta / 100, tickets: c.tickets, promedio: c.dinero / c.tickets / 100 }
  : { venta: 0, tickets: 0, promedio: 0 });

/** Lo que cambió: { venta, tickets, promedio } con { actual, anterior, pct }. */
function cambioDe(a, b, contra, etiquetas = {}) {
  const uno = (x, y) => ({ actual: Math.round(x * 100) / 100, anterior: Math.round((y || 0) * 100) / 100, pct: cambioPct(x, y || 0) });
  const c = {
    contra,
    venta: { etiqueta: etiquetas.venta || 'venta', ...uno(a.venta, b?.venta) },
    tickets: { etiqueta: etiquetas.tickets || 'tickets', ...uno(a.tickets, b?.tickets) },
    promedio: { etiqueta: etiquetas.promedio || 'ticket promedio', ...uno(a.promedio, b?.promedio) },
  };
  const conDato = [c.venta, c.tickets, c.promedio].filter((x) => x.pct !== null);
  c.texto = conDato.length
    ? `Contra ${contra}: ${[
      `${c.venta.etiqueta} ${conSigno(c.venta.pct)} (${dinero(c.venta.anterior)} → ${dinero(c.venta.actual)})`,
      `${c.tickets.etiqueta} ${conSigno(c.tickets.pct)} (${entero(c.tickets.anterior)} → ${entero(c.tickets.actual)})`,
      `${c.promedio.etiqueta} ${conSigno(c.promedio.pct)} (${dinero(c.promedio.anterior)} → ${dinero(c.promedio.actual)})`,
    ].join(' · ')}.`
    : `Sin ventas en ${contra} para comparar.`;
  return c;
}
const prioridadDe = (c) => Math.max(0, ...[c.venta.pct, c.tickets.pct, c.promedio.pct].filter((x) => x !== null).map(Math.abs));

/**
 * Las categorías que se piden junto con `ck` más de lo normal (lift). Las de
 * extras (salsas, tortillas, «extra huevo») no cuentan: van con cualquier
 * platillo, y saldrían en casi todas las filas, que es justo lo que se corrigió.
 */
function acompanantes(ck, E, nombres, excluir = new Set()) {
  const c = E.cats.get(ck);
  if (!c || !c.tickets || !E.N) return [];
  return [...c.con.entries()]
    .filter(([otra]) => otra !== SIN_CATEGORIA && !excluir.has(otra) && E.cats.get(otra))
    .map(([otra, n]) => {
      const lift = (n / c.tickets) / (E.cats.get(otra).tickets / E.N);
      return { clave: otra, nombre: nombreVisible(nombres.categorias?.[otra]), tickets: n, lift: Math.round(lift * 100) / 100 };
    })
    .filter((x) => x.tickets >= UMBRALES_V2.subgrupo && x.lift > UMBRALES_V2.lift)
    .sort((a, b) => b.lift - a.lift || b.tickets - a.tickets || a.nombre.localeCompare(b.nombre, 'es'))
    .slice(0, TOP_JUNTO);
}
const conLift = (xs) => lista(xs.map((x) => `${x.nombre} (×${x.lift.toLocaleString('es-MX', { maximumFractionDigits: 1 })})`));

// Venta, tickets y días abiertos por día de la semana y por franja, en TODOS
// los tickets (con desglose o sin él). Solo días completos: `fuera` es la
// fecha que se deja fuera (hoy, o el día cortado del periodo anterior).
function porDiaYHora(tks, fuera) {
  const fechas = new Set();
  const dias = new Map(), franjas = new Map();
  let venta = 0, tickets = 0;
  for (const t of tks) {
    if (!t.fecha || (fuera && t.fecha_venta === fuera)) continue;
    fechas.add(t.fecha); venta += t.neta; tickets++;
    const d = dias.get(t.dia) || { venta: 0, tickets: 0, fechas: new Set() };
    d.venta += t.neta; d.tickets++; d.fechas.add(t.fecha); dias.set(t.dia, d);
    const f = franjas.get(t.franja) || { venta: 0, tickets: 0 };
    f.venta += t.neta; f.tickets++; franjas.set(t.franja, f);
  }
  return { abiertos: fechas.size, venta, tickets, dias, franjas };
}

function porCanal(tks, clave) {
  let venta = 0, tickets = 0;
  for (const t of tks) if (t.modalidad === clave) { venta += t.neta; tickets++; }
  return { venta: venta / 100, tickets };
}

// ─── Las tarjetas ──────────────────────────────────────────────────────────
// Cada una: { tipo, categoria?, titulo, texto, cambio, accion, revisar, prioridad }.
// `meta`: hacia dónde debería moverse ese número si la acción funciona.
function revisarEl(hoy, numero, valor, meta) {
  const el = sumarDias(hoy, DIAS_PARA_REVISAR);
  return { el, etiqueta: fechaCorta(el), numero, valor, meta };
}

/**
 * Los consejos de un reporte de Productos leído con `conTickets` y con el
 * periodo anterior (función pura). `periodo` sale de periodoDelConsejero.
 * Devuelve { version: 2, periodo, anterior, estado, aviso, consejos, tabla,
 * otras, base, notas }. Fuera de 'ok' no hay consejos, pero la tabla sí.
 */
export function consejosV2(reporte, { periodo, hoy, minimoTickets = MINIMO_TICKETS, minimoDesglose = MINIMO_PCT_DESGLOSE } = {}) {
  const U = UMBRALES_V2;
  const nombres = reporte?.tickets || { categorias: {}, productos: {} };
  const A = estadisticas(reporte?.tickets?.actual, nombres);
  const B = estadisticas(reporte?.tickets?.anterior, nombres);
  const pa = reporte?.periodo_anterior || null;
  const corte = pa?.corte || null;
  const contra = pa ? `${etiquetaDeVentana(pa.desde, pa.hasta)}${corte ? `, hasta las ${corte.hora}` : ''}` : 'el periodo anterior';
  const anterior = pa ? { desde: pa.desde, hasta: pa.hasta, etiqueta: contra, corte } : null;
  const base0 = reporte?.con_desglose || { tickets: 0, venta_neta: 0, pct_tickets: 0 };
  const ticketsTotal = Number(reporte?.cuadre?.tickets) || 0;
  const productosPorClave = new Map((reporte?.productos || []).map((p) => [p.clave, p]));
  const filasCat = (reporte?.categorias || []).filter((c) => c.clave !== SIN_CATEGORIA && c.arrastre && c.arrastre.tickets > 0);
  const deExtras = new Set(filasCat.filter((c) => esDeExtras(c, productosPorClave)).map((c) => c.clave));

  // La tabla: las categorías con al menos el 1 % de la venta; las demás, en «Otras».
  const filaDeTabla = (c) => {
    const ar = c.arrastre;
    return {
      clave: c.clave, nombre: nombreVisible(c.nombre), venta: c.venta, pct_venta: c.pct_venta,
      cambio_venta_pct: B.N ? cambioPct(c.venta, (B.cats.get(c.clave)?.venta || 0) / 100) : null,
      tickets: ar.tickets, pct_tickets: ar.pct_tickets,
      dinero_tickets: ar.dinero_tickets, pct_dinero_tickets: ar.pct_dinero_tickets,
      solo_tickets: ar.solo_tickets, pct_solo: ar.pct_solo,
      junto: acompanantes(c.clave, A, nombres, deExtras),
    };
  };
  const tabla = filasCat.filter((c) => c.pct_venta >= U.pctTabla).map(filaDeTabla);
  const chicas = filasCat.filter((c) => c.pct_venta < U.pctTabla);
  let otras = null;
  if (chicas.length) {
    const claves = new Set(chicas.map((c) => c.clave));
    let tk = 0, din = 0;
    for (const f of A.filas) if ([...f.cats.keys()].some((k) => claves.has(k))) { tk++; din += f.t.neta; }
    otras = {
      clave: 'otras', nombre: 'Otras', categorias: chicas.map((c) => nombreVisible(c.nombre)),
      venta: Math.round(chicas.reduce((s, c) => s + c.venta, 0) * 100) / 100,
      pct_venta: Math.round(chicas.reduce((s, c) => s + c.pct_venta, 0) * 10) / 10,
      tickets: tk, pct_tickets: pct1(tk, A.N), dinero_tickets: din / 100, pct_dinero_tickets: pct1(din, A.netaDesglose),
    };
  }

  const salida = (estado, aviso, consejos = []) => ({
    version: 2, periodo, anterior, estado, aviso, consejos, tabla, otras,
    base: { tickets: ticketsTotal, con_desglose: base0.tickets, pct_desglose: base0.pct_tickets, venta_neta: base0.venta_neta },
    notas: [...NOTAS_V2],
  });
  if (!ticketsTotal) return salida('sin_ventas', 'En estos días no hay ventas para darte un consejo.');
  if (base0.tickets < minimoTickets) {
    return salida('pocos_tickets', `Con ${entero(base0.tickets)} tickets en estos días todavía no hay suficiente para aconsejarte: hacen falta al menos ${entero(minimoTickets)}.`);
  }
  if (base0.pct_tickets < minimoDesglose) {
    return salida('sin_desglose', `Solo el ${pct(base0.pct_tickets)} de los tickets trae el detalle de lo que se vendió. Con tan poco detalle prefiero no aconsejarte: los números podrían engañar.`);
  }

  const semanas = Math.max(1, (periodo?.dias || 28) / 7);
  const tarjetas = [];
  const usadas = new Set();
  const nombreDe = (ck) => nombreVisible(nombres.categorias?.[ck] || filasCat.find((c) => c.clave === ck)?.nombre || '');
  const grande = (c) => (A.cats.get(c.clave)?.tickets || 0) >= U.ticketsCategoria;
  const noExtras = (c) => !esDeExtras(c, productosPorClave);

  // Si el periodo anterior tiene otro número de días (un mes de 30 contra uno
  // de 31), su venta y sus tickets se ajustan a los mismos días. El ticket
  // promedio no cambia con eso.
  const diasAnt = pa ? diasEntre(pa.desde, pa.hasta) : 0;
  const factor = periodo?.dias && diasAnt && diasAnt !== periodo.dias ? periodo.dias / diasAnt : 1;
  const ajustado = (v) => ({ venta: v.venta * factor, tickets: v.tickets * factor, promedio: v.promedio });
  // El negocio entero: separa lo que cambió en una categoría de lo que cambió todo.
  const totalDe = (tks) => ({ venta: tks.reduce((s, t) => s + t.neta, 0) / 100, tickets: tks.length });
  const gA = totalDe(A.tickets), gB = totalDe(B.tickets);
  const general = { venta: cambioPct(gA.venta, gB.venta * factor), tickets: cambioPct(gA.tickets, gB.tickets * factor) };
  const aparte = (x, g) => (x === null || g === null ? 0 : Math.abs(x - g));

  // Tu motor: solo si cambió de categoría, o si se movió al menos 10 puntos
  // distinto que el negocio entero (si todo crece igual, el motor no dice nada).
  const motor = filasCat.find((c) => c.venta > 0);
  if (motor && B.N) {
    let antTop = null, antVenta = -1;
    for (const [ck, c] of B.cats) if (ck !== SIN_CATEGORIA && c.venta > antVenta) { antTop = ck; antVenta = c.venta; }
    const cm = cambioDe(valoresCat(A.cats.get(motor.clave)), ajustado(valoresCat(B.cats.get(motor.clave))), contra);
    const otro = antTop && antTop !== motor.clave;
    if (otro || aparte(cm.venta.pct, general.venta) >= U.cambio || aparte(cm.tickets.pct, general.tickets) >= U.cambio) {
      const nombre = nombreVisible(motor.nombre);
      tarjetas.push({
        tipo: 'motor', categoria: { clave: motor.clave, nombre },
        titulo: otro ? `Ahora tu motor es ${nombre}` : `Tu motor se movió: ${nombre}`,
        texto: otro
          ? `Ahora lo que más vendes es ${nombre}: el ${pct(motor.pct_venta)} de la venta, y va en ${frecuenciaDeTickets(motor.arrastre.pct_tickets)}. En ${contra} lo que más vendías era ${nombreDe(antTop)}.`
          : `Sigue siendo lo que más vendes: el ${pct(motor.pct_venta)} de la venta, y va en ${frecuenciaDeTickets(motor.arrastre.pct_tickets)}. `
            + `Su venta cambió ${conSigno(cm.venta.pct)}; la de todo el negocio, ${conSigno(general.venta)}.`,
        cambio: cm,
        accion: 'Revisa cada semana que no falte ni se tarde en tus horas fuertes.',
        revisar: revisarEl(hoy, 'su venta por semana', dinero(motor.venta / semanas), 'que no baje'),
        prioridad: otro ? 100 : prioridadDe(cm),
      });
      usadas.add(motor.clave);
    }
  }

  // Pesa más de lo que parece.
  {
    const P = U.pesaMas;
    const c = filasCat
      .filter((x) => !usadas.has(x.clave) && grande(x) && noExtras(x) && A.N - x.arrastre.tickets >= U.subgrupo)
      .filter((x) => x.pct_venta < P.maxPctVenta && x.arrastre.pct_tickets >= P.minPctTickets
        && x.arrastre.pct_dinero_tickets >= P.factorDinero * x.pct_venta && x.arrastre.pct_solo <= P.maxPctSolo)
      .sort((a, b) => (b.arrastre.pct_dinero_tickets - b.pct_venta) - (a.arrastre.pct_dinero_tickets - a.pct_venta) || a.nombre.localeCompare(b.nombre, 'es'))[0];
    if (c) {
      const ar = c.arrastre, nombre = nombreVisible(c.nombre), junto = acompanantes(c.clave, A, nombres, deExtras);
      const cm = cambioDe(valoresCat(A.cats.get(c.clave)), ajustado(valoresCat(B.cats.get(c.clave))), contra);
      tarjetas.push({
        tipo: 'pesa_mas', categoria: { clave: c.clave, nombre },
        titulo: `Pesa más de lo que parece: ${nombre}`,
        texto: `Es solo el ${pct(c.pct_venta)} de lo que vendes, pero va en ${frecuenciaDeTickets(ar.pct_tickets)}, y esos tickets suman el ${pct(ar.pct_dinero_tickets)} del dinero. `
          + `Solo ${entero(ar.solo_tickets)} de ${entero(ar.tickets)} lo llevan sin nada más.`
          + (junto.length ? ` Se pide junto con ${conLift(junto)} más de lo normal.` : ''),
        cambio: cm,
        accion: junto.length ? `Ofrécelo junto con ${junto[0].nombre} al tomar la orden.` : 'Ofrécelo al tomar cada orden.',
        revisar: revisarEl(hoy, 'el % de tickets que lo llevan', pct(ar.pct_tickets), 'que suba'),
        prioridad: prioridadDe(cm),
      });
      usadas.add(c.clave);
    }
  }

  // Atrae por sí sola: muchos de sus tickets no llevan nada más.
  {
    const c = filasCat
      .filter((x) => !usadas.has(x.clave) && grande(x) && noExtras(x)
        && x.arrastre.solo_tickets >= U.subgrupo && x.arrastre.pct_solo >= U.atraeSola.minPctSolo)
      .sort((a, b) => b.arrastre.pct_solo - a.arrastre.pct_solo || a.nombre.localeCompare(b.nombre, 'es'))[0];
    if (c) {
      const ar = c.arrastre, nombre = nombreVisible(c.nombre);
      const a = A.cats.get(c.clave), b = B.cats.get(c.clave);
      const cm = cambioDe(valoresCat(a), ajustado(valoresCat(b)), contra);
      const antes = b && b.tickets >= U.subgrupo ? ` En ${contra} iba sola en el ${pct(pct1(b.solo, b.tickets))}.` : '';
      tarjetas.push({
        tipo: 'atrae_sola', categoria: { clave: c.clave, nombre },
        titulo: `Atrae por sí sola: ${nombre}`,
        texto: `En el ${pct(ar.pct_solo)} de los tickets que la llevan (${entero(ar.solo_tickets)} de ${entero(ar.tickets)}) va sola: no se pidió nada más. `
          + `Esos tickets promedian ${dinero(a.soloDinero / a.solo / 100)}; el promedio de todos tus tickets es ${dinero(A.netaDesglose / A.N / 100)}.${antes}`,
        cambio: cm,
        accion: 'Cuando la pidan sola, ofrece una bebida o un complemento.',
        revisar: revisarEl(hoy, 'el % de sus tickets que van solos', pct(ar.pct_solo), 'que baje'),
        prioridad: prioridadDe(cm),
      });
      usadas.add(c.clave);
    }
  }

  // Sube el ticket: por platillo y en cada canal por separado.
  {
    const S = U.subeTicket;
    let mejor = null;
    for (const canal of CANALES) {
      const T = A.filas.filter((f) => f.t.modalidad === canal.clave && f.platillos > 0);
      if (T.length < 2 * U.subgrupo) continue;
      for (const c of filasCat) {
        if (usadas.has(c.clave) || !grande(c)) continue;
        const con = [], sin = [];
        for (const f of T) (f.cats.has(c.clave) ? con : sin).push(f);
        if (con.length < U.subgrupo || sin.length < U.subgrupo) continue;
        const pctCanal = pct1(con.length, T.length);
        if (pctCanal < S.minPctTicketsCanal) continue;
        const suma = (xs, k) => xs.reduce((s, f) => s + (k === 'neta' ? f.t.neta : f.platillos), 0);
        const tkCon = suma(con, 'neta') / con.length, tkSin = suma(sin, 'neta') / sin.length;
        const plCon = suma(con, 'neta') / suma(con, 'plat'), plSin = suma(sin, 'neta') / suma(sin, 'plat');
        const aTk = aumento(tkCon, tkSin), aPl = aumento(plCon, plSin);
        if (aTk === null || aPl === null || aTk < S.minAumentoPct || aPl < S.minAumentoPct) continue;
        if (!mejor || aPl > mejor.aPl || (aPl === mejor.aPl && c.nombre.localeCompare(mejor.c.nombre, 'es') < 0)) {
          mejor = { canal, c, con: con.length, total: T.length, pctCanal, plCon, plSin, aPl };
        }
      }
    }
    if (mejor) {
      const { canal, c } = mejor, nombre = nombreVisible(c.nombre);
      // Los mismos tickets que cuenta el texto: los del canal con algún platillo.
      const enCanal = (E) => {
        let venta = 0, tickets = 0, neta = 0;
        for (const f of E.filas) {
          if (f.t.modalidad !== canal.clave || !(f.platillos > 0) || !f.cats.has(c.clave)) continue;
          venta += f.cats.get(c.clave); tickets++; neta += f.t.neta;
        }
        return { venta: venta / 100, tickets, promedio: tickets ? neta / tickets / 100 : 0 };
      };
      const cm = cambioDe(enCanal(A), ajustado(enCanal(B)), contra);
      tarjetas.push({
        tipo: 'sube_ticket', categoria: { clave: c.clave, nombre }, canal: canal.clave,
        titulo: `Sube el ticket ${canal.en}: ${nombre}`,
        texto: `${canal.En}, los tickets que llevan ${nombre} dejan ${dinero(mejor.plCon / 100)} por platillo; los que no, ${dinero(mejor.plSin / 100)}: ${entero(mejor.aPl)} % más. `
          + `Va en ${frecuenciaDeTickets(mejor.pctCanal)} ${canal.de} (${entero(mejor.con)} de ${entero(mejor.total)}).`,
        cambio: cm,
        accion: `Ofrécelo al tomar cada orden ${canal.de}.`,
        revisar: revisarEl(hoy, `el % de tickets ${canal.de} que lo llevan`, pct(mejor.pctCanal), 'que suba'),
        prioridad: prioridadDe(cm),
      });
      usadas.add(c.clave);
    }
  }

  // Día u hora floja: cae contra su propio promedio y más que el negocio.
  {
    const D = U.debil;
    const a = porDiaYHora(A.tickets, hoy), b = porDiaYHora(B.tickets, corte ? corte.fecha : null);
    if (a.abiertos && b.abiertos) {
      const generalDia = cambioPct(a.venta / a.abiertos, b.venta / b.abiertos);
      const candidatos = [];
      for (const [dia, x] of a.dias) {
        const y = b.dias.get(dia);
        if (!y || x.tickets < U.subgrupo || y.tickets < U.subgrupo || x.fechas.size < 2 || y.fechas.size < 2) continue;
        candidatos.push({ clase: 'dia', dia, x: { venta: x.venta / x.fechas.size, tickets: x.tickets / x.fechas.size }, y: { venta: y.venta / y.fechas.size, tickets: y.tickets / y.fechas.size } });
      }
      for (const fr of FRANJAS) {
        if (fr.clave === 'otras') continue;
        const x = a.franjas.get(fr.clave), y = b.franjas.get(fr.clave);
        if (!x || !y || x.tickets < U.subgrupo || y.tickets < U.subgrupo) continue;
        candidatos.push({ clase: 'franja', franja: fr, x: { venta: x.venta / a.abiertos, tickets: x.tickets / a.abiertos }, y: { venta: y.venta / b.abiertos, tickets: y.tickets / b.abiertos } });
      }
      const peor = candidatos
        .map((k) => ({ ...k, cambio: cambioPct(k.x.venta, k.y.venta) }))
        .filter((k) => generalDia !== null && k.cambio !== null && k.cambio <= -D.minCaidaPct && k.cambio <= generalDia - D.puntosBajoGeneral)
        .sort((p, q) => (p.cambio - generalDia) - (q.cambio - generalDia))[0];
      if (peor) {
        const v = (k) => ({ venta: k.venta / 100, tickets: Math.round(k.tickets * 10) / 10, promedio: k.tickets ? k.venta / k.tickets / 100 : 0 });
        const cm = cambioDe(v(peor.x), v(peor.y), contra, { venta: 'venta por día', tickets: 'tickets por día' });
        const cual = peor.clase === 'dia' ? `los ${plural(DIAS_SEMANA[peor.dia])}` : `de ${peor.franja.etiqueta}`;
        const Cual = peor.clase === 'dia' ? `Los ${plural(DIAS_SEMANA[peor.dia])}` : `De ${peor.franja.etiqueta}`;
        tarjetas.push({
          tipo: 'debil', ...(peor.clase === 'dia' ? { dia: peor.dia } : { franja: peor.franja.clave }),
          titulo: peor.clase === 'dia' ? `Día flojo: ${cual}` : `Hora floja: ${cual}`,
          texto: `${Cual} vendes en promedio ${dinero(peor.x.venta / 100)} por día; en ${contra} eran ${dinero(peor.y.venta / 100)} (${conSigno(peor.cambio)}). `
            + `Tu venta por día en general cambió ${conSigno(generalDia)}.`,
          cambio: cm,
          accion: `Prueba una promoción solo ${cual} durante 2 semanas.`,
          revisar: revisarEl(hoy, peor.clase === 'dia' ? `la venta promedio de ${cual}` : `la venta promedio por día ${cual}`, dinero(peor.x.venta / 100), 'que suba'),
          prioridad: prioridadDe(cm),
        });
      }
    }
  }

  // Canal: lo que más cambió entre mesa, domicilio y recoger. El título dice
  // lo que más se movió; la acción sigue a los tickets (la gente que llega).
  {
    let mejor = null;
    for (const canal of CANALES) {
      const x = porCanal(A.tickets, canal.clave), y = porCanal(B.tickets, canal.clave);
      if (x.tickets < U.subgrupo || y.tickets < U.subgrupo) continue;
      const cm = cambioDe(
        { venta: x.venta, tickets: x.tickets, promedio: x.venta / x.tickets },
        ajustado({ venta: y.venta, tickets: y.tickets, promedio: y.venta / y.tickets }), contra);
      const p = prioridadDe(cm);
      if (p >= U.canal.minCambioPct && (!mejor || p > mejor.p)) mejor = { canal, x, cm, p };
    }
    if (mejor) {
      const { canal, x, cm } = mejor;
      const C = U.canal.minCambioPct;
      const principal = [['venta', cm.venta], ['tickets', cm.tickets], ['promedio', cm.promedio]]
        .filter(([, v]) => v.pct !== null).sort((p, q) => Math.abs(q[1].pct) - Math.abs(p[1].pct))[0];
      const [cual, v] = principal;
      const sube = v.pct > 0;
      const titulo = {
        venta: sube ? 'sube la venta' : 'baja la venta',
        tickets: sube ? 'suben los tickets' : 'bajan los tickets',
        promedio: sube ? 'sube el ticket promedio' : 'baja el ticket promedio',
      }[cual];
      const tk = cm.tickets.pct ?? 0, prom = cm.promedio.pct ?? 0;
      let accion, revisar;
      const porSemana = entero(x.tickets / semanas);
      if (tk <= -C || (tk < C && (cm.venta.pct ?? 0) <= -C && prom > -C)) {
        accion = `Pon una promoción solo ${canal.en} durante 2 semanas.`;
        revisar = revisarEl(hoy, `tus tickets ${canal.de} por semana`, porSemana, 'que suba');
      } else if (tk >= C || ((cm.venta.pct ?? 0) >= C && prom < C)) {
        let franjaFuerte = null;
        const porFranja = new Map();
        for (const t of A.tickets) if (t.modalidad === canal.clave && t.franja !== 'otras') porFranja.set(t.franja, (porFranja.get(t.franja) || 0) + 1);
        const top = [...porFranja.entries()].sort((p, q) => q[1] - p[1])[0];
        franjaFuerte = top ? FRANJAS.find((f) => f.clave === top[0]) : null;
        accion = `Cuida que ${canal.cuida}${franjaFuerte ? ` de ${franjaFuerte.etiqueta}, su horario más fuerte` : ''}.`;
        revisar = revisarEl(hoy, `tus tickets ${canal.de} por semana`, porSemana, 'que no baje');
      } else {
        // Los mismos tickets, pero cada uno deja más o menos.
        accion = prom < 0
          ? `Ofrece un complemento o una bebida en cada orden ${canal.de}.`
          : `Sigue ofreciendo complementos en cada orden ${canal.de}.`;
        revisar = revisarEl(hoy, `el ticket promedio ${canal.de}`, dinero(cm.promedio.actual), prom < 0 ? 'que suba' : 'que no baje');
      }
      tarjetas.push({
        tipo: 'canal', canal: canal.clave,
        titulo: `${canal.titulo}: ${titulo}`,
        texto: `Tu venta ${canal.en} cambió ${conSigno(cm.venta.pct)}: tickets ${conSigno(cm.tickets.pct)} y ticket promedio ${conSigno(cm.promedio.pct)}. `
          + `Es el ${pct(pct1(x.tickets, A.tickets.length))} de tus tickets.${factor !== 1 ? ' El periodo anterior se ajustó a los mismos días.' : ''}`,
        cambio: cm, accion, revisar,
        prioridad: mejor.p,
      });
    }
  }

  const consejos = ordenarTarjetas(tarjetas);
  return salida('ok', consejos.length ? '' : 'En estos días no encontré nada que valga la pena señalarte.', consejos);
}

/**
 * Primero las tarjetas que cambiaron más del 10 % (de más a menos); después,
 * las demás en el orden fijo de los tipos. Como mucho MAX_TARJETAS.
 */
const ORDEN_TIPOS = Object.freeze(['motor', 'pesa_mas', 'atrae_sola', 'sube_ticket', 'debil', 'canal']);
export function ordenarTarjetas(tarjetas = []) {
  const orden = (k) => { const i = ORDEN_TIPOS.indexOf(k.tipo); return i < 0 ? ORDEN_TIPOS.length : i; };
  return tarjetas
    .map((k, i) => ({ k, i }))
    .sort((p, q) => {
      const rp = p.k.prioridad >= UMBRALES_V2.cambio, rq = q.k.prioridad >= UMBRALES_V2.cambio;
      if (rp !== rq) return rp ? -1 : 1;
      if (rp) return q.k.prioridad - p.k.prioridad || orden(p.k) - orden(q.k) || p.i - q.i;
      return orden(p.k) - orden(q.k) || p.i - q.i;
    })
    .map((x) => x.k)
    .slice(0, MAX_TARJETAS);
}

// ─── Lectura ───────────────────────────────────────────────────────────────
function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  return negocioId.trim();
}

/** ¿Está encendida la versión 2 del consejero en este negocio? */
export async function banderaConsejeroV2(negocioId, db = pool) {
  const { rows } = await db.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [exigirNegocio(negocioId), BANDERA_CONSEJERO_V2]);
  return String(rows[0]?.valor ?? '').trim() === 'true';
}

// Su propia caché: la llave lleva los negocios y los días, nunca se cruza con
// la de la versión 1.
export const cacheConsejeroV2 = crearCacheConsejero();

/**
 * Los consejos (versión 2) de UNA o varias sucursales. negocios: [{ id,
 * nombre, tz }]; hoy: el día operativo del negocio de la sesión; pedido: el
 * periodo de arriba de Reportes ({ desde, hasta }) o null.
 */
export async function obtenerConsejosV2({ negocios = [], hoy, pedido = null, db = pool, cache = cacheConsejeroV2, ahora = new Date() } = {}) {
  if (!Array.isArray(negocios) || !negocios.length) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  for (const n of negocios) exigirNegocio(n?.id);
  const periodo = periodoDelConsejero(pedido, hoy);
  // Los mismos días pueden llegar por dos caminos (el periodo de arriba o los
  // 28 días de respaldo) y la pantalla dice cuál: van en la llave, con hoy
  // (la fecha de «revisa el…»).
  const llave = cache ? `${cache.llave(negocios, periodo)}|${periodo.origen}|${periodo.motivo || ''}|${hoy}` : null;
  const guardado = cache ? cache.leer(llave) : null;
  if (guardado) return guardado;
  const reporte = await obtenerReporteProductos({
    negocios, desde: periodo.desde, hasta: periodo.hasta, db, ahora, conAnterior: true, conTickets: true,
  });
  const valor = consejosV2(reporte, { periodo, hoy });
  if (cache) cache.guardar(llave, valor);
  return valor;
}
