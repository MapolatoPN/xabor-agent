// Reportes → «Lo que te diría un consejero» (Fase 1, plan aprobado por el
// dueño el 25-nov-2026).
//
// Arriba de Reportes › Ventas, unos pocos consejos en lenguaje de consejero,
// con números exactos: salen de las MISMAS cuentas que Reportes › Productos
// (construirReporteProductos y su «arrastre» por categoría). Reglas fijas,
// sin inteligencia artificial: aquí no se inventa ningún número.
//
// Decisiones del dueño:
//   · Mira los ÚLTIMOS 28 DÍAS SIN CONTAR HOY (cuatro semanas completas: cada
//     día de la semana pesa igual y un día a medias no mueve nada). No sigue
//     el periodo de arriba de Reportes.
//   · Tres tipos de consejo:
//       1. «Tu motor»: la categoría que más vende.
//       2. «Pesa más de lo que parece»: vende poco por sí sola, pero va en
//          muchos tickets y esos tickets dejan mucho más dinero (el ejemplo
//          del dueño: unos tacos que venden poco y acompañan a muchos tickets).
//       3. «Sube el ticket»: con ella el ticket promedio es claramente mayor.
//   · Con pocos tickets o poco desglose NO aconseja y lo dice: prefiere callar
//     a decir algo mal.
//
// «Con ella / sin ella» se cuenta SOLO entre tickets con desglose: «sin ella»
// es el resto de esos tickets, no todos. El dinero de un ticket es su venta
// neta (la de la pestaña Ventas).
//
// negocioId OBLIGATORIO en cada lectura; quién ve qué sucursales lo decide la
// ruta (reporteProductosRutas.js).
import { pool } from './database.js';
import { obtenerReporteProductos } from './reporteProductos.js';

export const BANDERA_CONSEJERO = 'reportes_consejero_v1';
export const DIAS_VENTANA = 28;
export const MINIMO_TICKETS = 100;
export const MINIMO_PCT_DESGLOSE = 90;
export const UMBRALES = Object.freeze({
  // «Pesa más de lo que parece»: menos del 10 % de la venta, en al menos el
  // 10 % de los tickets, esos tickets dejan al menos el doble de su parte de
  // la venta y como mucho el 25 % de ellos la lleva sola.
  pesaMas: Object.freeze({ maxPctVenta: 10, minPctTickets: 10, factorDinero: 2, maxPctSolo: 25, cuantos: 1 }),
  // «Sube el ticket»: con ella el ticket es al menos 15 % mayor, y va en al
  // menos el 5 % de los tickets.
  subeTicket: Object.freeze({ minAumentoPct: 15, minPctTickets: 5 }),
});
// La categoría de los productos que no quedaron ligados al menú.
const SIN_CATEGORIA = 'sin';
const TOP_ACOMPANANTES_TEXTO = 3;

const DIA_MS = 24 * 60 * 60 * 1000;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const esFecha = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`));
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);

/** Los últimos `dias` días SIN contar hoy: { desde, hasta, dias, etiqueta }. */
export function ventanaDelConsejero(hoy, dias = DIAS_VENTANA) {
  if (!esFecha(hoy)) { const e = new Error('fecha de hoy inválida'); e.code = 'RANGO_INVALIDO'; throw e; }
  const desde = sumarDias(hoy, -dias);
  const hasta = sumarDias(hoy, -1);
  return { desde, hasta, dias, etiqueta: etiquetaDeVentana(desde, hasta) };
}

/** «28 oct – 24 nov»; con el año si cambia: «8 dic 2026 – 4 ene 2027». */
export function etiquetaDeVentana(desde, hasta) {
  const partes = (f) => { const [y, m, d] = f.split('-').map(Number); return { y, m, d }; };
  const a = partes(desde), b = partes(hasta);
  const corto = (x, conAnio) => `${x.d} ${MESES[x.m - 1]}${conAnio ? ` ${x.y}` : ''}`;
  const conAnio = a.y !== b.y;
  return `${corto(a, conAnio)} – ${corto(b, conAnio)}`;
}

// ─── Cómo se dicen los números ────────────────────────────────────────────
const pct = (n) => `${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
const entero = (n) => Math.round(Number(n || 0)).toLocaleString('es-MX');
const dinero = (n) => `$${Math.round(Number(n || 0)).toLocaleString('es-MX')}`;
const lista = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

/** «1 de cada 5 tickets», «la mitad de tus tickets» o «el 62 % de tus tickets». */
export function frecuenciaDeTickets(pctTickets) {
  const x = Number(pctTickets) || 0;
  if (x >= 45 && x <= 55) return 'la mitad de tus tickets';
  if (x >= 5 && x <= 35) return `1 de cada ${Math.round(100 / x)} tickets`;
  return `el ${pct(x)} de tus tickets`;
}

/** Aumento del ticket con la categoría frente a sin ella, en % entero; null si no se puede. */
export function aumentoDelTicket(con, sin) {
  const a = Number(con), b = Number(sin);
  if (!(a > 0) || !(b > 0)) return null;
  return Math.round((a / b - 1) * 100);
}

// Una categoría de puros extras (salsas, tortillas, «extra huevo») acompaña a
// todo: no es un platillo que alguien piense quitar, y «pesa más» saldría
// siempre. Se reconoce por el NOMBRE («Extras», «Extra», «Extras y
// complementos») o porque la mayoría de sus piezas son de tipo «extra». El
// nombre hace falta: hay menús con todo dado de alta como «platillo», y ahí
// el tipo no distingue nada.
const NOMBRE_DE_EXTRAS = /(^|[^a-z0-9])extras?([^a-z0-9]|$)/;
const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// También la usa la versión 2 (reporteConsejeroV2.js).
export function esDeExtras(categoria, productosPorClave) {
  if (NOMBRE_DE_EXTRAS.test(sinAcentos(categoria.nombre))) return true;
  let extras = 0, total = 0;
  for (const clave of categoria.productos || []) {
    const p = productosPorClave.get(clave);
    if (!p) continue;
    total += Number(p.unidades) || 0;
    if (p.tipo === 'extra') extras += Number(p.unidades) || 0;
  }
  return total > 0 && extras / total > 0.5;
}

function filaDeTabla(c) {
  const a = c.arrastre;
  return {
    clave: c.clave, nombre: c.nombre,
    venta: c.venta, pct_venta: c.pct_venta,
    tickets: a.tickets, pct_tickets: a.pct_tickets,
    dinero_tickets: a.dinero_tickets, pct_dinero_tickets: a.pct_dinero_tickets,
    solo_tickets: a.solo_tickets, pct_solo: a.pct_solo,
    ticket_con: a.ticket_con, ticket_sin: a.ticket_sin,
    aumento_pct: aumentoDelTicket(a.ticket_con, a.ticket_sin),
    con_categorias: a.con_categorias.slice(0, TOP_ACOMPANANTES_TEXTO).map((x) => ({ nombre: x.nombre, tickets: x.tickets, pct_tickets: x.pct_tickets })),
    con_productos: a.con_productos.slice(0, TOP_ACOMPANANTES_TEXTO).map((x) => ({ nombre: x.nombre, tickets: x.tickets, pct_tickets: x.pct_tickets })),
  };
}

// ─── Los tres consejos ─────────────────────────────────────────────────────
function consejoMotor(f, base) {
  return {
    tipo: 'motor', categoria: { clave: f.clave, nombre: f.nombre },
    titulo: `Tu motor: ${f.nombre}`,
    texto: `Es el ${pct(f.pct_venta)} de lo que vendes y va en ${frecuenciaDeTickets(f.pct_tickets)} `
      + `(${entero(f.tickets)} de ${entero(base.tickets)}). Esos tickets dejan el ${pct(f.pct_dinero_tickets)} del dinero. `
      + 'Cuida que nunca falte ni se tarde.',
  };
}

function consejoPesaMas(f) {
  const solo = f.pct_solo < 10 ? 'Casi nadie viene solo por esto' : 'Pocos vienen solo por esto';
  const gasto = f.ticket_con > 0 && f.ticket_sin > 0 && f.ticket_con > f.ticket_sin
    ? `Quien lo pide gasta ${dinero(f.ticket_con)} por ticket; quien no, ${dinero(f.ticket_sin)}. ` : '';
  const junto = f.con_productos.length
    ? `Antes de quitarlo o cambiarlo, mira con qué se acompaña: ${lista(f.con_productos.map((x) => x.nombre))}.`
    : 'Antes de quitarlo o cambiarlo, piensa en lo que se vende junto con él.';
  return {
    tipo: 'pesa_mas', categoria: { clave: f.clave, nombre: f.nombre },
    titulo: `Pesa más de lo que parece: ${f.nombre}`,
    texto: `Es solo el ${pct(f.pct_venta)} de lo que vendes, pero va en ${frecuenciaDeTickets(f.pct_tickets)}, `
      + `y esos tickets dejan el ${pct(f.pct_dinero_tickets)} del dinero. ${solo}: ${entero(f.solo_tickets)} de ${entero(f.tickets)}. `
      + `${gasto}${junto}`,
  };
}

function consejoSubeTicket(f) {
  return {
    tipo: 'sube_ticket', categoria: { clave: f.clave, nombre: f.nombre },
    titulo: `Sube el ticket: ${f.nombre}`,
    texto: `Quien lo pide gasta ${dinero(f.ticket_con)} por ticket; quien no, ${dinero(f.ticket_sin)}: ${entero(f.aumento_pct)} % más. `
      + `Va en ${frecuenciaDeTickets(f.pct_tickets)}. Vale la pena ofrecerlo al tomar la orden.`,
  };
}

/**
 * Los consejos de un reporte de Productos ya armado (función pura).
 * Devuelve { ventana, estado, aviso, consejos, tabla, base }.
 *   estado: 'ok' | 'sin_ventas' | 'pocos_tickets' | 'sin_desglose'.
 * Fuera de 'ok' no hay consejos, pero la tabla sí (son hechos, no consejos).
 */
export function consejosDeReporte(reporte, { ventana = null, minimoTickets = MINIMO_TICKETS, minimoDesglose = MINIMO_PCT_DESGLOSE } = {}) {
  const base = reporte?.con_desglose || { tickets: 0, venta_neta: 0, pct_tickets: 0 };
  const tickets = Number(reporte?.cuadre?.tickets) || 0;
  const productosPorClave = new Map((reporte?.productos || []).map((p) => [p.clave, p]));
  const cats = (reporte?.categorias || []).filter((c) => c.clave !== SIN_CATEGORIA && c.arrastre && c.arrastre.tickets > 0);
  const tabla = cats.map(filaDeTabla);
  const salida = (estado, aviso, consejos = []) => ({
    ventana, estado, aviso, consejos, tabla,
    base: { tickets, con_desglose: base.tickets, pct_desglose: base.pct_tickets, venta_neta: base.venta_neta },
  });

  if (!tickets) return salida('sin_ventas', 'En estos días no hay ventas para darte un consejo.');
  if (base.tickets < minimoTickets) {
    return salida('pocos_tickets', `Con ${entero(base.tickets)} tickets en estos días todavía no hay suficiente para aconsejarte: hacen falta al menos ${entero(minimoTickets)}.`);
  }
  if (base.pct_tickets < minimoDesglose) {
    return salida('sin_desglose', `Solo el ${pct(base.pct_tickets)} de los tickets trae el detalle de lo que se vendió. Con tan poco detalle prefiero no aconsejarte: los números podrían engañar.`);
  }

  const consejos = [];
  const usadas = new Set();
  const motor = tabla.find((f) => f.venta > 0);
  if (motor) { consejos.push(consejoMotor(motor, base)); usadas.add(motor.clave); }

  const U = UMBRALES.pesaMas;
  const pesan = tabla
    .filter((f) => !usadas.has(f.clave))
    .filter((f) => !esDeExtras(cats.find((c) => c.clave === f.clave), productosPorClave))
    .filter((f) => f.pct_venta < U.maxPctVenta && f.pct_tickets >= U.minPctTickets
      && f.pct_dinero_tickets >= U.factorDinero * f.pct_venta && f.pct_solo <= U.maxPctSolo)
    .sort((a, b) => (b.pct_dinero_tickets - b.pct_venta) - (a.pct_dinero_tickets - a.pct_venta) || a.nombre.localeCompare(b.nombre, 'es'))
    .slice(0, U.cuantos);
  for (const f of pesan) { consejos.push(consejoPesaMas(f)); usadas.add(f.clave); }

  const S = UMBRALES.subeTicket;
  const sube = tabla
    .filter((f) => !usadas.has(f.clave) && f.pct_tickets >= S.minPctTickets && f.aumento_pct !== null && f.aumento_pct >= S.minAumentoPct)
    .sort((a, b) => b.aumento_pct - a.aumento_pct || a.nombre.localeCompare(b.nombre, 'es'))[0];
  if (sube) consejos.push(consejoSubeTicket(sube));

  return salida('ok', consejos.length ? '' : 'En estos días no encontré nada que valga la pena señalarte.', consejos);
}

// ─── Lectura ───────────────────────────────────────────────────────────────
function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  return negocioId.trim();
}

/** ¿Está encendido el consejero en este negocio? */
export async function banderaConsejero(negocioId, db = pool) {
  const { rows } = await db.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [exigirNegocio(negocioId), BANDERA_CONSEJERO]);
  return String(rows[0]?.valor ?? '').trim() === 'true';
}

/**
 * Caché corta en memoria: abrir Reportes varias veces no repite la cuenta. La
 * llave lleva los negocios y los días, así que un negocio nunca recibe la
 * cuenta de otro.
 */
export function crearCacheConsejero({ ttlMs = 10 * 60 * 1000, maximo = 50, reloj = () => Date.now() } = {}) {
  const m = new Map();
  return {
    llave: (negocios, ventana) => `${negocios.map((n) => exigirNegocio(n.id)).sort().join(',')}|${ventana.desde}|${ventana.hasta}`,
    leer(llave) {
      const x = m.get(llave);
      if (!x) return null;
      if (reloj() - x.en > ttlMs) { m.delete(llave); return null; }
      return x.valor;
    },
    guardar(llave, valor) {
      if (m.size >= maximo) m.delete(m.keys().next().value);
      m.set(llave, { en: reloj(), valor });
    },
    vaciar: () => m.clear(),
  };
}
export const cacheConsejero = crearCacheConsejero();

/**
 * Los consejos de UNA o varias sucursales para los últimos 28 días sin hoy.
 * negocios: [{ id, nombre, tz }]; hoy: el día operativo del negocio de la sesión.
 */
export async function obtenerConsejos({ negocios = [], hoy, db = pool, cache = cacheConsejero } = {}) {
  if (!Array.isArray(negocios) || !negocios.length) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  for (const n of negocios) exigirNegocio(n?.id);
  const ventana = ventanaDelConsejero(hoy);
  const llave = cache ? cache.llave(negocios, ventana) : null;
  const guardado = cache ? cache.leer(llave) : null;
  if (guardado) return guardado;
  const reporte = await obtenerReporteProductos({ negocios, desde: ventana.desde, hasta: ventana.hasta, db, conAnterior: false });
  const valor = consejosDeReporte(reporte, { ventana });
  if (cache) cache.guardar(llave, valor);
  return valor;
}
