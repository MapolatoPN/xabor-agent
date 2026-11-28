// Asistente del restaurante, Fase 1: las REGLAS que buscan hallazgos.
//
// Pedido del dueño del 26-nov-2026 (plan aprobado). Aquí no hay inteligencia
// artificial: cada hallazgo sale de una cuenta fija y revisable. La IA (Fase 3)
// solo ordenará y explicará lo que estas reglas ya encontraron; nunca calcula.
//
// Funciones PURAS: reciben los datos ya leídos (src/asistente/datos.js) y
// devuelven hallazgos. Sin base, sin reloj (la fecha llega en el contexto).
//
// Reglas de calidad (5.4 del pedido):
//   · Productos y categorías: no se avisa con menos de 100 tickets en el
//     periodo; ningún grupo que se compare puede tener menos de 30.
//   · Los pedidos grandes (más de 4 veces el ticket típico de la sucursal)
//     no entran en las comparaciones de venta: se reportan aparte.
//   · Sin lenguaje de causa y efecto: se dice qué cambió, no por qué.
//   · Cada hallazgo trae UNA acción y el número que hay que revisar después.
//   · Ningún hallazgo lleva teléfonos, direcciones ni datos de pago: los
//     clientes van por nombre (o por su número interno).
//
// Cada hallazgo: { tipo, firma, impacto, titulo, detalle, sugerencia, revisar, frecuencia, pantalla }.
//   impacto   pesos en juego, para ordenar (0 = informativo: solo sale si sobra lugar).
//   firma     identifica «el mismo aviso» para no repetirlo (ver priorizar.js).
//   detalle   { numeros: [{ etiqueta, valor, formato }], tabla?: { columnas, filas }, nota? }.
//   revisar   { numero, valor, formato, el } — qué mirar y cuándo.
//   pantalla  Fase 4 (la pestaña Asistente de Reportes): { encabezado, serie? }.
//             encabezado: el título corto de la tarjeta; serie: las 9 semanas
//             de los de control, de la más vieja a la más nueva (la gráfica).
//   accion    Mejora 1 (28-nov-2026): lo que necesita el botón de la tarjeta
//             para abrir su pantalla ya filtrada (acciones.js). Solo números
//             internos y fechas, nunca texto: { producto, categoria, canal,
//             dia, franja, desde, hasta, clientes: [id], categorias: [clave] }.
//             No se le manda a la IA ni se pinta: lo usa el servidor.
import { nombreVisible, UMBRALES_V2, DIAS_PARA_REVISAR } from '../services/reporteConsejeroV2.js';
import { MINIMO_TICKETS } from '../services/reporteConsejero.js';
import { FRANJAS, DIAS_SEMANA } from '../services/reporteProductos.js';
import { evaluarHorarioLocal } from '../services/horarioSemanal.js';

export const UMBRALES_ASISTENTE = Object.freeze({
  ticketsProducto: MINIMO_TICKETS, // 100 (el mismo mínimo del consejero)
  subgrupo: UMBRALES_V2.subgrupo, // 30
  lift: UMBRALES_V2.lift, // 1.3
  cambioPct: 15,
  cambioMinimo: 1500, // pesos en 4 semanas
  caidaPct: 15, // un día o una franja: cae 15 % contra sí misma…
  puntosBajoGeneral: 10, // …y 10 puntos más que el negocio
  pedidoGrandeFactor: 4, // veces el ticket típico (la mediana de 90 días)
  pedidoGrandePiso: 1000, // pesos: nunca menos que esto
  controlDesviaciones: 2,
  controlFactor: 1.5,
  controlExcesoMinimo: 500,
  clienteVisitas: 4,
  clienteCadaMaximo: 14, // días entre visitas (la mediana)
  clienteAusenciaMinima: 21,
  clienteAusenciaFactor: 3,
  cohorteMinima: 30,
  cohorteCaidaPuntos: 10,
  frecuenteVisitas: 6,
  costumbrePct: 70,
  pocaVentaTicketsSucursal: 1000,
  pocaVentaPiezas: 6,
});

// El orden de desempate (mismo impacto) y la lista CERRADA de tipos.
export const TIPOS_HALLAZGO = Object.freeze([
  'descuentos_altos', 'cancelaciones_altas', 'cortesias_altas',
  'ventas_sin_forma_pago', 'ventas_fuera_horario', 'ventas_incompletas',
  'producto_baja', 'categoria_baja', 'canal_baja', 'dia_flojo', 'franja_floja',
  'clientes_dejaron', 'nuevos_regresan_menos',
  'producto_sube', 'categoria_sube', 'canal_sube',
  'pedidos_grandes', 'combinaciones', 'poca_venta', 'clientes_cambiaron',
]);
// Control y calidad de las ventas: van PRIMERO, antes que cualquier aviso de
// ventas que suben o bajan (decisión del dueño, 26-nov-2026). Entre ellos y
// entre los demás, por pesos en juego.
export const TIPOS_CONTROL = Object.freeze([
  'descuentos_altos', 'cancelaciones_altas', 'cortesias_altas',
  'ventas_sin_forma_pago', 'ventas_fuera_horario', 'ventas_incompletas',
]);
// Los que salen solo los lunes (con el resumen semanal).
export const TIPOS_SEMANALES = Object.freeze(['nuevos_regresan_menos', 'pedidos_grandes', 'combinaciones', 'poca_venta', 'clientes_cambiaron']);
// Informativos: sin pesos en juego claros. Solo ocupan lugar si sobra.
export const TIPOS_INFORMATIVOS = Object.freeze(['combinaciones', 'poca_venta', 'clientes_cambiaron']);

// ─── Fechas y formatos ────────────────────────────────────────────────────
const DIA_MS = 24 * 60 * 60 * 1000;
export const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const fechaCorta = (f) => { const [, m, d] = String(f).split('-').map(Number); return `${d} ${MESES[m - 1]}`; };
export const dinero = (n) => `$${Math.round(Number(n) || 0).toLocaleString('es-MX')}`;
const entero = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');
const pct = (n) => `${Math.abs(Math.round((Number(n) || 0) * 10) / 10).toLocaleString('es-MX')} %`;
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
// «3 semanas» si cae en semanas completas; si no, «25 días» (Fase 2: el plazo se configura).
export const plazoDias = (d) => (d % 7 === 0 ? `${d / 7} semana${d === 7 ? '' : 's'}` : `${d} días`);
const cambioPct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const DE_ENVIO = /(^|[^a-z0-9])envios?([^a-z0-9]|$)/;
const NO_COMBINA = /(^|[^a-z0-9])(bebidas?|extras?|envios?|salsas?|tortillas?)([^a-z0-9]|$)/;
const lista = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
const nombre = (s, respaldo) => nombreVisible(String(s || '').trim()) || respaldo;
const mediana = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const numeroDe = (etiqueta, valor, formato = 'dinero') => ({ etiqueta, valor: redondear(valor), formato });
// Un nombre recortado para el título corto de la tarjeta.
const corto = (s, max = 32) => { const t = String(s || '').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
const ventasN = (n) => (n === 1 ? '1 venta' : `${entero(n)} ventas`);
const revisarEl = (ctx, numero, valor, formato = 'dinero') => ({ numero, valor: valor === null ? null : redondear(valor), formato, el: sumarDias(ctx.hoy, DIAS_PARA_REVISAR) });
// Las llaves del reporte de Productos de UNA sucursal: «p:12» (producto del
// menú) y «c:3» (categoría). Un producto sin id del menú («n:…») no lleva botón.
const idProducto = (k) => { const m = /^p:(\d{1,12})$/.exec(String(k)); return m ? Number(m[1]) : null; };
const claveCategoria = (k) => (/^c:\d{1,12}$/.test(String(k)) ? String(k) : null);
export const MAXIMO_CLIENTES_ACCION = 500;

// ─── Los periodos ─────────────────────────────────────────────────────────
// `ayer` es el último día completo. P = sus 28 días; A = los 28 anteriores.
export function periodosDe(ayer) {
  return {
    P: { desde: sumarDias(ayer, -27), hasta: ayer },
    A: { desde: sumarDias(ayer, -55), hasta: sumarDias(ayer, -28) },
    semana: { desde: sumarDias(ayer, -6), hasta: ayer },
  };
}
const dentro = (f, r) => typeof f === 'string' && f >= r.desde && f <= r.hasta;

/**
 * El umbral de pedido grande de la sucursal: 4 veces la mediana de las ventas
 * de los últimos 90 días, y nunca menos de $1,000. Las ventas llegan en pesos.
 */
export function umbralPedidoGrande(ventas, ayer, U = UMBRALES_ASISTENTE) {
  const desde = sumarDias(ayer, -89);
  const netas = ventas.filter((v) => v.clase === 'venta' && dentro(v.fecha, { desde, hasta: ayer }) && v.neta > 0).map((v) => v.neta);
  return Math.max(U.pedidoGrandePiso, redondear(mediana(netas) * U.pedidoGrandeFactor));
}

// ─── Productos y categorías (del reporte de Productos, con su resumen por ticket) ──
// `tks`: [{ neta (centavos), desglose, lineas: [[producto, categoría, piezas, monto (centavos)]],
// fecha, dia, franja }]. Se cuentan los tickets con desglose y sin pedidos grandes.
function totalesPorLlave(tks, umbralCentavos, cual) {
  const m = new Map();
  for (const t of tks || []) {
    if (!t || !t.desglose || t.neta > umbralCentavos) continue;
    const vistas = new Set();
    for (const [prod, cat, piezas, monto] of t.lineas || []) {
      const k = cual === 'producto' ? prod : cat;
      if (k === null || k === undefined) continue;
      const a = m.get(k) || { venta: 0, tickets: 0, piezas: 0 };
      a.venta += Number(monto) || 0; a.piezas += Number(piezas) || 0;
      if (!vistas.has(k)) { a.tickets++; vistas.add(k); }
      m.set(k, a);
    }
  }
  return m;
}

function cambiosDeMenu(ctx, cual) {
  const U = ctx.umbrales;
  const prod = ctx.productos;
  if (!prod) return [];
  const umbral = Math.round(ctx.umbralGrande * 100);
  const act = totalesPorLlave(prod.actual, umbral, cual);
  const ant = totalesPorLlave(prod.anterior, umbral, cual);
  const nombres = cual === 'producto' ? (prod.nombres?.productos || {}) : (prod.nombres?.categorias || {});
  const salida = [];
  for (const k of new Set([...act.keys(), ...ant.keys()])) {
    const a = act.get(k) || { venta: 0, tickets: 0, piezas: 0 };
    const b = ant.get(k) || { venta: 0, tickets: 0, piezas: 0 };
    const nom = nombre(nombres[k], cual === 'producto' ? 'Un producto' : 'Una categoría');
    if (DE_ENVIO.test(sinAcentos(nom))) continue;
    if (Math.max(a.tickets, b.tickets) < U.ticketsProducto || Math.min(a.tickets, b.tickets) < U.subgrupo) continue;
    const va = a.venta / 100, vb = b.venta / 100;
    const c = cambioPct(va, vb);
    const delta = va - vb;
    if (c === null || Math.abs(c) < U.cambioPct || Math.abs(delta) < U.cambioMinimo) continue;
    const baja = delta < 0;
    const queEs = cual === 'producto' ? `«${nom}»` : `La categoría ${nom}`;
    salida.push({
      tipo: `${cual}_${baja ? 'baja' : 'sube'}`,
      firma: `${cual}_${baja ? 'baja' : 'sube'}:${k}`,
      impacto: redondear(Math.abs(delta)),
      titulo: `${queEs} vendió ${pct(c)} ${baja ? 'menos' : 'más'} que las 4 semanas anteriores (${baja ? '−' : '+'}${dinero(Math.abs(delta))}).`,
      detalle: {
        numeros: [
          numeroDe('Venta de las últimas 4 semanas', va), numeroDe('Venta de las 4 anteriores', vb),
          numeroDe('Tickets con él, ahora', a.tickets, 'entero'), numeroDe('Tickets con él, antes', b.tickets, 'entero'),
          numeroDe('Piezas, ahora', a.piezas, 'entero'), numeroDe('Piezas, antes', b.piezas, 'entero'),
        ],
        nota: `Del ${fechaCorta(ctx.periodos.P.desde)} al ${fechaCorta(ctx.periodos.P.hasta)} contra el ${fechaCorta(ctx.periodos.A.desde)} al ${fechaCorta(ctx.periodos.A.hasta)}, sin pedidos grandes.`,
      },
      sugerencia: baja
        ? `Revisa que ${cual === 'producto' ? 'esté disponible y se ofrezca' : 'sus platillos estén disponibles y se ofrezcan'} igual que antes.`
        : `Asegura el inventario para que ${cual === 'producto' ? 'no se agote' : 'sus platillos no se agoten'}.`,
      revisar: revisarEl(ctx, `Venta semanal de ${cual === 'producto' ? `«${nom}»` : nom}`, va / 4),
      frecuencia: 'diaria',
      pantalla: { encabezado: `${cual === 'producto' ? `«${corto(nom)}»` : `La categoría ${corto(nom, 24)}`} vende ${baja ? 'menos' : 'más'}` },
      accion: cual === 'producto'
        ? (idProducto(k) ? { producto: idProducto(k) } : null)
        : (claveCategoria(k) ? { categoria: claveCategoria(k), desde: ctx.periodos.P.desde, hasta: ctx.periodos.P.hasta } : null),
    });
  }
  return salida;
}

// ─── Días de la semana y franjas (todas las ventas, sin pedidos grandes) ──
function porGrupo(tks, umbralCentavos, llave) {
  const g = new Map();
  let venta = 0, tickets = 0;
  const fechas = new Set();
  for (const t of tks || []) {
    if (!t || !t.fecha || t.neta > umbralCentavos) continue;
    const k = llave(t);
    if (k === null || k === undefined) continue;
    const x = g.get(k) || { venta: 0, tickets: 0, fechas: new Set() };
    x.venta += t.neta; x.tickets++; x.fechas.add(t.fecha); g.set(k, x);
    venta += t.neta; tickets++; fechas.add(t.fecha);
  }
  return { g, venta, tickets, dias: fechas.size };
}

function flojos(ctx, cual) {
  const U = ctx.umbrales;
  const prod = ctx.productos;
  if (!prod) return [];
  const umbral = Math.round(ctx.umbralGrande * 100);
  const llave = cual === 'dia' ? (t) => t.dia : (t) => t.franja;
  const P = porGrupo(prod.actual, umbral, llave);
  const A = porGrupo(prod.anterior, umbral, llave);
  if (!P.dias || !A.dias) return [];
  const general = cambioPct(P.venta / P.dias, A.venta / A.dias);
  const salida = [];
  for (const [k, p] of P.g) {
    const a = A.g.get(k);
    if (!a || p.tickets < U.subgrupo || a.tickets < U.subgrupo) continue;
    const dp = p.fechas.size, da = a.fechas.size;
    if (!dp || !da) continue;
    const promP = p.venta / dp / 100, promA = a.venta / da / 100;
    const c = cambioPct(promP, promA);
    if (c === null || c > -U.caidaPct || (general !== null && c > general - U.puntosBajoGeneral)) continue;
    const perdida = (promA - promP) * dp;
    if (perdida < U.cambioMinimo) continue;
    const etiqueta = cual === 'dia'
      ? `Los ${DIAS_SEMANA[k] ? DIAS_SEMANA[k].toLowerCase() : 'días'}`
      : `La franja de ${(FRANJAS.find((f) => f.clave === k)?.etiqueta || k)}`;
    const unidad = cual === 'dia' ? 'por día' : 'por día abierto';
    salida.push({
      tipo: cual === 'dia' ? 'dia_flojo' : 'franja_floja',
      firma: `${cual === 'dia' ? 'dia_flojo' : 'franja_floja'}:${k}`,
      impacto: redondear(perdida),
      titulo: `${etiqueta} ${cual === 'dia' ? 'vendieron' : 'vendió'} ${pct(c)} menos ${unidad} que las 4 semanas anteriores; el negocio en general ${general === null ? 'no tiene comparación' : `${general < 0 ? 'bajó' : 'subió'} ${pct(general)}`}.`,
      detalle: {
        numeros: [
          numeroDe(`Venta promedio ${unidad}, ahora`, promP), numeroDe(`Venta promedio ${unidad}, antes`, promA),
          numeroDe('Tickets, ahora', p.tickets, 'entero'), numeroDe('Tickets, antes', a.tickets, 'entero'),
          numeroDe('Diferencia en las 4 semanas', perdida),
        ],
        nota: 'Se compara contra su propio promedio de las 4 semanas anteriores, sin pedidos grandes. En las mesas cuenta la hora de llegada.',
      },
      sugerencia: cual === 'dia'
        ? 'Prueba una promoción o un platillo del día solo ese día de la semana.'
        : 'Revisa el personal y la oferta de esa franja; prueba una promoción solo en ese horario.',
      revisar: revisarEl(ctx, `Venta promedio ${unidad} de ${etiqueta.toLowerCase()}`, promP),
      frecuencia: 'diaria',
      pantalla: { encabezado: `${etiqueta} ${cual === 'dia' ? 'venden' : 'vende'} menos` },
      accion: cual === 'dia' ? (Number.isInteger(Number(k)) ? { dia: Number(k) } : null) : { franja: String(k) },
    });
  }
  return salida;
}

// ─── Canales (de las ventas de la sucursal) ───────────────────────────────
function canales(ctx) {
  const U = ctx.umbrales;
  const { P, A } = ctx.periodos;
  const sumas = (r) => {
    const m = new Map();
    for (const v of ctx.ventas) {
      if (v.clase !== 'venta' || !dentro(v.fecha, r) || v.neta > ctx.umbralGrande) continue;
      if (!v.canal || v.canal === 'prueba' || v.canal === 'sin_canal') continue;
      const x = m.get(v.canal) || { venta: 0, tickets: 0, etiqueta: v.canal_etiqueta || v.canal };
      x.venta += v.neta; x.tickets++; m.set(v.canal, x);
    }
    return m;
  };
  const mp = sumas(P), ma = sumas(A);
  const salida = [];
  for (const k of new Set([...mp.keys(), ...ma.keys()])) {
    const a = mp.get(k) || { venta: 0, tickets: 0, etiqueta: ma.get(k).etiqueta };
    const b = ma.get(k) || { venta: 0, tickets: 0, etiqueta: a.etiqueta };
    if (a.tickets < U.subgrupo || b.tickets < U.subgrupo) continue;
    const c = cambioPct(a.venta, b.venta);
    const delta = a.venta - b.venta;
    if (c === null || Math.abs(c) < U.cambioPct || Math.abs(delta) < U.cambioMinimo) continue;
    const baja = delta < 0;
    salida.push({
      tipo: baja ? 'canal_baja' : 'canal_sube',
      firma: `${baja ? 'canal_baja' : 'canal_sube'}:${k}`,
      impacto: redondear(Math.abs(delta)),
      titulo: `${a.etiqueta} vendió ${pct(c)} ${baja ? 'menos' : 'más'} que las 4 semanas anteriores (${baja ? '−' : '+'}${dinero(Math.abs(delta))}).`,
      detalle: {
        numeros: [
          numeroDe('Venta de las últimas 4 semanas', a.venta), numeroDe('Venta de las 4 anteriores', b.venta),
          numeroDe('Tickets, ahora', a.tickets, 'entero'), numeroDe('Tickets, antes', b.tickets, 'entero'),
        ],
        nota: 'Sin pedidos grandes ni ventas de prueba.',
      },
      sugerencia: baja ? `Revisa que ${a.etiqueta} funcione y se anuncie igual que antes.` : `Asegura que ${a.etiqueta} se atienda a tiempo con el volumen nuevo.`,
      revisar: revisarEl(ctx, `Venta semanal de ${a.etiqueta}`, a.venta / 4),
      frecuencia: 'diaria',
      pantalla: { encabezado: `${corto(a.etiqueta)} vende ${baja ? 'menos' : 'más'} que antes` },
      accion: { canal: String(k), desde: P.desde, hasta: P.hasta },
    });
  }
  return salida;
}

// ─── Combinaciones (lift) ─────────────────────────────────────────────────
function combinaciones(ctx) {
  const U = ctx.umbrales;
  const prod = ctx.productos;
  if (!prod) return [];
  const umbral = Math.round(ctx.umbralGrande * 100);
  const nombres = prod.nombres?.categorias || {};
  const cats = new Map();
  const pares = new Map();
  let N = 0;
  for (const t of prod.actual || []) {
    if (!t || !t.desglose || t.neta > umbral) continue;
    const enTicket = [...new Set((t.lineas || []).map((l) => l[1]).filter((c) => c !== null && c !== undefined && c !== 'sin'))]
      .filter((c) => !NO_COMBINA.test(sinAcentos(nombres[c])));
    if (!enTicket.length) continue;
    N++;
    for (const c of enTicket) cats.set(c, (cats.get(c) || 0) + 1);
    enTicket.sort();
    for (let i = 0; i < enTicket.length; i++) for (let j = i + 1; j < enTicket.length; j++) {
      const k = `${enTicket[i]}\u0000${enTicket[j]}`;
      pares.set(k, (pares.get(k) || 0) + 1);
    }
  }
  const lista2 = [];
  for (const [k, juntos] of pares) {
    const [a, b] = k.split('\u0000');
    const na = cats.get(a), nb = cats.get(b);
    if (juntos < U.subgrupo || Math.max(na, nb) < U.ticketsProducto) continue;
    const lift = (juntos / N) / ((na / N) * (nb / N));
    if (lift < U.lift) continue;
    lista2.push({ a, b, juntos, lift: Math.round(lift * 100) / 100, pct: Math.round((juntos / N) * 1000) / 10 });
  }
  if (!lista2.length) return [];
  lista2.sort((x, y) => y.lift * y.juntos - x.lift * x.juntos || y.juntos - x.juntos);
  const top = lista2.slice(0, 3);
  const nom = (c) => nombre(nombres[c], 'Sin nombre');
  const [p] = top;
  return [{
    tipo: 'combinaciones',
    firma: `combinaciones:${p.a}|${p.b}`,
    impacto: 0,
    titulo: `${nom(p.a)} y ${nom(p.b)} se piden juntos ${p.lift.toLocaleString('es-MX')} veces más de lo esperado.`,
    detalle: {
      numeros: [numeroDe('Tickets con las dos', p.juntos, 'entero'), numeroDe('De todos los tickets', p.pct, 'pct')],
      tabla: { columnas: ['Combinación', 'Tickets juntos', 'Veces más de lo esperado'], formatos: ['texto', 'entero', 'decimal'], filas: top.map((x) => [`${nom(x.a)} + ${nom(x.b)}`, x.juntos, x.lift]) },
      nota: '«Veces más de lo esperado» (lift) compara cuántos tickets las traen juntas contra lo que pasaría si se pidieran al azar. Es una coincidencia, no una causa.',
    },
    sugerencia: `Prueba ofrecerlas juntas (un combo o una sugerencia al tomar la orden).`,
    revisar: revisarEl(ctx, `Porcentaje de tickets con ${nom(p.a)} y ${nom(p.b)}`, p.pct, 'pct'),
    frecuencia: 'semanal',
    pantalla: { encabezado: `${corto(nom(p.a), 20)} y ${corto(nom(p.b), 20)} van juntos` },
    accion: [p.a, p.b].every(claveCategoria) ? { categorias: [p.a, p.b] } : null,
  }];
}

// ─── Productos con muy poca venta (90 días) ───────────────────────────────
function pocaVenta(ctx) {
  const U = ctx.umbrales;
  const m = ctx.menu90;
  if (!m || (m.tickets || 0) < U.pocaVentaTicketsSucursal) return [];
  const pocos = (m.sinMovimiento || []).filter((x) => (Number(x.unidades) || 0) < U.pocaVentaPiezas);
  if (!pocos.length) return [];
  const top = pocos.slice(0, 8);
  return [{
    tipo: 'poca_venta',
    firma: 'poca_venta',
    impacto: 0,
    titulo: `${pocos.length === 1 ? '1 producto del menú vendió' : `${pocos.length} productos del menú vendieron`} menos de ${U.pocaVentaPiezas} piezas en 90 días.`,
    detalle: {
      numeros: [numeroDe('Tickets de la sucursal en 90 días', m.tickets, 'entero'), numeroDe('Productos con poca venta', pocos.length, 'entero')],
      tabla: { columnas: ['Producto', 'Categoría', 'Piezas en 90 días'], formatos: ['texto', 'texto', 'entero'], filas: top.map((x) => [nombre(x.nombre, 'Sin nombre'), nombre(x.categoria, 'Sin categoría'), Number(x.unidades) || 0]) },
      nota: 'Solo productos activos del menú. Este aviso no usa el mínimo de 100 tickets: justo se trata de los que casi no se venden.',
    },
    sugerencia: 'Decide si se quedan en el menú, si se cambian o si se promueven.',
    revisar: revisarEl(ctx, 'Productos con menos de 6 piezas en 90 días', pocos.length, 'entero'),
    frecuencia: 'semanal',
    pantalla: { encabezado: pocos.length === 1 ? '1 producto casi no se vende' : `${entero(pocos.length)} productos casi no se venden` },
  }];
}

// ─── Clientes ─────────────────────────────────────────────────────────────
// Solo los clientes identificados (ligados a Clientes y que no son internos).
function porCliente(ctx) {
  const m = new Map();
  for (const v of ctx.ventas) {
    if (v.clase !== 'venta' || !v.cliente_id) continue;
    const c = m.get(v.cliente_id) || { id: v.cliente_id, nombre: v.cliente_nombre || '', ventas: [], primera: v.cliente_primera || null };
    if (!c.nombre && v.cliente_nombre) c.nombre = v.cliente_nombre;
    c.ventas.push(v); m.set(v.cliente_id, c);
  }
  for (const c of m.values()) c.ventas.sort((a, b) => (a.instante < b.instante ? -1 : a.instante > b.instante ? 1 : 0));
  return m;
}
const nombreCliente = (c) => nombre(c.nombre, `Cliente sin nombre (#${String(c.id).slice(0, 8)})`);

function clientesDejaron(ctx) {
  const U = ctx.umbrales;
  const desde = sumarDias(ctx.ayer, -119);
  const perdidos = [];
  for (const c of ctx.clientes.values()) {
    const vs = c.ventas.filter((v) => dentro(v.fecha, { desde, hasta: ctx.ayer }));
    const fechas = [...new Set(vs.map((v) => v.fecha))].sort();
    if (fechas.length < U.clienteVisitas) continue;
    const huecos = fechas.slice(1).map((f, i) => diasEntre(fechas[i], f));
    const cada = mediana(huecos);
    if (!(cada > 0) || cada > U.clienteCadaMaximo) continue;
    const sin = diasEntre(fechas[fechas.length - 1], ctx.ayer);
    if (sin < Math.max(U.clienteAusenciaMinima, Math.ceil(cada * U.clienteAusenciaFactor))) continue;
    const gasto = vs.filter((v) => v.neta <= ctx.umbralGrande).reduce((s, v) => s + v.neta, 0);
    const meses = Math.max(1, diasEntre(fechas[0], fechas[fechas.length - 1]) / 30);
    perdidos.push({ c, visitas: fechas.length, cada, ultima: fechas[fechas.length - 1], sin, alMes: redondear(gasto / meses) });
  }
  if (!perdidos.length) return [];
  perdidos.sort((a, b) => b.alMes - a.alMes || b.visitas - a.visitas);
  const total = perdidos.reduce((s, p) => s + p.alMes, 0);
  const top = perdidos.slice(0, 5);
  return [{
    tipo: 'clientes_dejaron',
    firma: 'clientes_dejaron',
    impacto: redondear(total),
    titulo: `${perdidos.length === 1 ? '1 cliente frecuente lleva' : `${perdidos.length} clientes frecuentes llevan`} ${plazoDias(U.clienteAusenciaMinima)} o más sin pedir (gastaban ${dinero(total)} al mes).`,
    detalle: {
      numeros: [numeroDe('Clientes', perdidos.length, 'entero'), numeroDe('Lo que gastaban al mes, juntos', total)],
      tabla: {
        columnas: ['Cliente', 'Visitas en 120 días', 'Pedía cada (días)', 'Última visita', 'Gasto al mes'],
        formatos: ['texto', 'entero', 'entero', 'texto', 'dinero'],
        filas: top.map((p) => [nombreCliente(p.c), p.visitas, Math.round(p.cada), fechaCorta(p.ultima), p.alMes]),
      },
      nota: 'Frecuente = 4 visitas o más en 120 días, con una visita cada 14 días o menos. Solo los clientes que dejan su teléfono (casi nunca los de mesa y mostrador).',
    },
    sugerencia: perdidos.length === 1
      ? 'Escríbele o mándale una promoción para que vuelva.'
      : 'Escríbeles o mándales una promoción para que vuelvan.',
    revisar: revisarEl(ctx, perdidos.length === 1
      ? 'Pedidos nuevos de este cliente'
      : `Cuántos de estos ${perdidos.length} clientes volvieron a pedir`, 0, 'entero'),
    frecuencia: 'diaria',
    pantalla: { encabezado: perdidos.length === 1 ? '1 cliente frecuente no ha vuelto' : `${entero(perdidos.length)} clientes frecuentes no han vuelto` },
    // TODOS (no solo los 5 de la tabla), por su número interno: «Preparar campaña».
    accion: { clientes: perdidos.slice(0, MAXIMO_CLIENTES_ACCION).map((p) => String(p.c.id)) },
  }];
}

function nuevosRegresan(ctx) {
  const U = ctx.umbrales;
  const cohorte = (desde, hasta) => {
    let n = 0, volvieron = 0;
    for (const c of ctx.clientes.values()) {
      if (!c.primera || c.primera < desde || c.primera > hasta) continue;
      n++;
      const limite = sumarDias(c.primera, 28);
      if (c.ventas.some((v) => v.fecha > c.primera && v.fecha <= limite)) volvieron++;
    }
    return { n, volvieron, tasa: n ? Math.round((volvieron / n) * 1000) / 10 : null };
  };
  const reciente = cohorte(sumarDias(ctx.ayer, -55), sumarDias(ctx.ayer, -28));
  const previa = cohorte(sumarDias(ctx.ayer, -83), sumarDias(ctx.ayer, -56));
  if (reciente.n < U.cohorteMinima || previa.n < U.cohorteMinima) return [];
  const caida = previa.tasa - reciente.tasa;
  if (caida < U.cohorteCaidaPuntos) return [];
  const promedio = (() => {
    const vs = ctx.ventas.filter((v) => v.clase === 'venta' && dentro(v.fecha, ctx.periodos.P) && v.neta <= ctx.umbralGrande);
    return vs.length ? vs.reduce((s, v) => s + v.neta, 0) / vs.length : 0;
  })();
  const faltaron = Math.round((caida / 100) * reciente.n);
  return [{
    tipo: 'nuevos_regresan_menos',
    firma: 'nuevos_regresan_menos',
    impacto: redondear(faltaron * promedio),
    titulo: `De los clientes nuevos, regresó el ${pct(reciente.tasa)} en su primer mes; el grupo anterior regresó el ${pct(previa.tasa)}.`,
    detalle: {
      numeros: [
        numeroDe('Clientes nuevos (grupo reciente)', reciente.n, 'entero'), numeroDe('Regresaron en 28 días', reciente.volvieron, 'entero'),
        numeroDe('Clientes nuevos (grupo anterior)', previa.n, 'entero'), numeroDe('Regresaron en 28 días', previa.volvieron, 'entero'),
      ],
      nota: 'Nuevo = su primer pedido con teléfono en esta sucursal. Grupo reciente: primer pedido hace 4 a 8 semanas; anterior: hace 8 a 12.',
    },
    sugerencia: 'Ofrece algo para la segunda visita (un cupón en el primer pedido o un mensaje a la semana).',
    revisar: revisarEl(ctx, 'Porcentaje de clientes nuevos que regresan en 28 días', reciente.tasa, 'pct'),
    frecuencia: 'semanal',
    pantalla: { encabezado: 'Regresan menos clientes nuevos' },
  }];
}

function clientesCambiaron(ctx) {
  const U = ctx.umbrales;
  const desde = sumarDias(ctx.ayer, -119);
  const cambios = [];
  const productosDe = (v) => new Set((v.items || []).map((i) => sinAcentos(i.nombre).trim()).filter(Boolean));
  for (const c of ctx.clientes.values()) {
    const vs = c.ventas.filter((v) => dentro(v.fecha, { desde, hasta: ctx.ayer }));
    if (vs.length < U.frecuenteVisitas) continue;
    const ultimas = vs.slice(-3), antes = vs.slice(0, -3);
    if (antes.length < 3) continue;
    const canalesAntes = new Map();
    for (const v of antes) canalesAntes.set(v.canal, (canalesAntes.get(v.canal) || 0) + 1);
    const [habitual, veces] = [...canalesAntes.entries()].sort((a, b) => b[1] - a[1])[0];
    const que = [];
    if (veces / antes.length * 100 >= U.costumbrePct && ultimas.every((v) => v.canal !== habitual)) {
      const etiqueta = (vs.find((v) => v.canal === habitual)?.canal_etiqueta) || habitual;
      que.push(`antes pedía por ${etiqueta} y sus últimos 3 pedidos fueron por ${ultimas[ultimas.length - 1].canal_etiqueta || ultimas[ultimas.length - 1].canal}`);
    }
    const conteo = new Map();
    const original = new Map();
    for (const v of antes) for (const p of productosDe(v)) conteo.set(p, (conteo.get(p) || 0) + 1);
    for (const v of antes) for (const i of v.items || []) original.set(sinAcentos(i.nombre).trim(), i.nombre);
    const favorito = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0];
    if (favorito && favorito[1] / antes.length * 100 >= U.costumbrePct && ultimas.every((v) => !productosDe(v).has(favorito[0]))) {
      que.push(`dejó de pedir «${nombre(original.get(favorito[0]), favorito[0])}» en sus últimos 3 pedidos`);
    }
    if (que.length) cambios.push({ c, visitas: vs.length, que: que.join('; ') });
  }
  if (!cambios.length) return [];
  cambios.sort((a, b) => b.visitas - a.visitas);
  return [{
    tipo: 'clientes_cambiaron',
    firma: 'clientes_cambiaron',
    impacto: 0,
    titulo: `${cambios.length === 1 ? '1 cliente frecuente cambió' : `${cambios.length} clientes frecuentes cambiaron`} su forma de pedir o su platillo de siempre.`,
    detalle: {
      numeros: [numeroDe('Clientes', cambios.length, 'entero')],
      tabla: { columnas: ['Cliente', 'Pedidos en 120 días', 'Qué cambió'], formatos: ['texto', 'entero', 'texto'], filas: cambios.slice(0, 5).map((x) => [nombreCliente(x.c), x.visitas, x.que]) },
      nota: 'Frecuente = 6 pedidos o más en 120 días. «De siempre» = en 7 de cada 10 de sus pedidos anteriores.',
    },
    sugerencia: 'Pregúntales en su próximo pedido cómo les fue la última vez.',
    revisar: revisarEl(ctx, 'Clientes frecuentes que cambiaron', cambios.length, 'entero'),
    frecuencia: 'semanal',
    pantalla: { encabezado: cambios.length === 1 ? '1 cliente frecuente cambió su costumbre' : `${entero(cambios.length)} clientes frecuentes cambiaron su costumbre` },
  }];
}

function pedidosGrandes(ctx) {
  const grandes = ctx.ventas.filter((v) => v.clase === 'venta' && dentro(v.fecha, ctx.periodos.semana) && v.neta > ctx.umbralGrande)
    .sort((a, b) => b.neta - a.neta);
  if (!grandes.length) return [];
  const total = grandes.reduce((s, v) => s + v.neta, 0);
  return [{
    tipo: 'pedidos_grandes',
    firma: 'pedidos_grandes',
    impacto: redondear(total),
    titulo: `${grandes.length === 1 ? 'Hubo 1 pedido grande' : `Hubo ${grandes.length} pedidos grandes`} en la semana, por ${dinero(total)}.`,
    detalle: {
      numeros: [numeroDe('Pedidos grandes', grandes.length, 'entero'), numeroDe('Venta de esos pedidos', total), numeroDe('Grande desde', ctx.umbralGrande)],
      tabla: {
        columnas: ['Folio', 'Día', 'Canal', 'Cliente', 'Venta'],
        formatos: ['texto', 'texto', 'texto', 'texto', 'dinero'],
        filas: grandes.slice(0, 8).map((v) => [v.folio, fechaCorta(v.fecha), v.canal_etiqueta || v.canal, v.cliente_id ? nombre(v.cliente_nombre, 'Cliente sin nombre') : (nombre(v.nombre_en_venta, '—')), v.neta]),
      },
      nota: `Grande = más de ${ctx.umbrales.pedidoGrandeFactor} veces el ticket típico de la sucursal en 90 días. No entran en las comparaciones de venta.`,
    },
    sugerencia: 'Si fue de una empresa o un evento, ofrécele repetirlo.',
    revisar: revisarEl(ctx, 'Pedidos grandes en las próximas 2 semanas', grandes.length, 'entero'),
    frecuencia: 'semanal',
    pantalla: { encabezado: grandes.length === 1 ? '1 pedido grande en la semana' : `${entero(grandes.length)} pedidos grandes en la semana` },
    accion: { desde: ctx.periodos.semana.desde, hasta: ctx.periodos.semana.hasta },
  }];
}

// ─── Control ──────────────────────────────────────────────────────────────
// La semana que terminó ayer contra las 8 anteriores (sumas de 7 días).
function semanas(ctx) {
  return Array.from({ length: 9 }, (_, i) => ({ desde: sumarDias(ctx.ayer, -6 - 7 * i), hasta: sumarDias(ctx.ayer, -7 * i) }));
}
function fueraDeLoNormal(serie, U) {
  const [actual, ...previas] = serie;
  const conDatos = previas.length;
  const media = conDatos ? previas.reduce((s, x) => s + x, 0) / conDatos : 0;
  const desv = conDatos ? Math.sqrt(previas.reduce((s, x) => s + (x - media) ** 2, 0) / conDatos) : 0;
  const ok = actual > media + U.controlDesviaciones * desv && actual >= U.controlFactor * media && actual - media >= U.controlExcesoMinimo;
  return { actual, media, desv, ok, exceso: actual - media };
}
function agrupar(filas, clave, monto) {
  const m = new Map();
  for (const f of filas) {
    const k = clave(f) || 'Sin registrar';
    m.set(k, (m.get(k) || 0) + monto(f));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, redondear(v)]);
}

function control(ctx) {
  const U = ctx.umbrales;
  const S = semanas(ctx);
  const ventasDe = (r) => ctx.ventas.filter((v) => dentro(v.fecha, r));
  const ticketsSemana = ventasDe(S[0]).filter((v) => v.clase === 'venta').length;
  if (ticketsSemana < U.subgrupo) return [];
  const eventosDe = (r) => (ctx.eventosMesa || []).filter((e) => dentro(e.fecha, r));
  const tipos = [
    {
      tipo: 'descuentos_altos', que: 'descuentos', art: 'Los',
      filas: (r) => ventasDe(r).filter((v) => v.clase === 'venta' && !v.cortesia && v.descuento > 0).map((v) => ({ monto: v.descuento, quien: v.descuento_autorizo, motivo: v.descuento_motivo })),
      sugerencia: 'Revisa con quien los autorizó que cada descuento haya sido correcto.',
    },
    {
      tipo: 'cancelaciones_altas', que: 'cancelaciones', art: 'Las',
      filas: (r) => [
        ...ventasDe(r).filter((v) => v.clase === 'cancelado').map((v) => ({ monto: v.neta, quien: v.cancelacion_autorizo, motivo: v.cancelacion_motivo || 'Pedido cancelado' })),
        ...eventosDe(r).filter((e) => e.tipo === 'cancelado' && e.motivo_codigo !== 'cortesia').map((e) => ({ monto: e.importe, quien: e.autorizo, motivo: e.motivo || 'Platillo cancelado en mesa' })),
      ],
      sugerencia: 'Revisa con quien las autorizó que cada cancelación tenga su motivo.',
    },
    {
      tipo: 'cortesias_altas', que: 'cortesías', art: 'Las',
      filas: (r) => [
        ...ventasDe(r).filter((v) => v.clase === 'venta' && v.cortesia).map((v) => ({ monto: v.cortesia_monto, quien: v.descuento_autorizo, motivo: 'Cuenta sin cobro' })),
        ...eventosDe(r).filter((e) => e.tipo === 'cancelado' && e.motivo_codigo === 'cortesia').map((e) => ({ monto: e.importe, quien: e.autorizo, motivo: 'Cortesía en mesa' })),
      ],
      sugerencia: 'Revisa con quien las autorizó a quién se dieron y por qué.',
    },
  ];
  const salida = [];
  for (const t of tipos) {
    const serie = S.map((r) => t.filas(r).reduce((s, f) => s + (Number(f.monto) || 0), 0));
    const r = fueraDeLoNormal(serie, U);
    if (!r.ok) continue;
    const filas = t.filas(S[0]);
    salida.push({
      tipo: t.tipo,
      firma: t.tipo,
      impacto: redondear(r.exceso),
      titulo: `${t.art} ${t.que} de la semana suman ${dinero(r.actual)}; lo normal es ${dinero(r.media)}.`,
      detalle: {
        numeros: [numeroDe('Esta semana', r.actual), numeroDe('Promedio de las 8 anteriores', r.media), numeroDe('Arriba de lo normal', r.exceso), numeroDe('Cuántas', filas.length, 'entero')],
        tabla: { columnas: ['Autorizó', 'Monto'], formatos: ['texto', 'dinero'], filas: agrupar(filas, (f) => f.quien, (f) => Number(f.monto) || 0) },
        nota: `Semana del ${fechaCorta(S[0].desde)} al ${fechaCorta(S[0].hasta)}. Principales motivos: ${agrupar(filas, (f) => f.motivo, (f) => Number(f.monto) || 0).slice(0, 3).map(([k]) => k).join(', ') || 'sin motivo registrado'}.`,
      },
      sugerencia: t.sugerencia,
      revisar: revisarEl(ctx, `${t.art} ${t.que} de la próxima semana (lo normal: ${dinero(r.media)})`, r.actual),
      frecuencia: 'diaria',
      // La gráfica de la tarjeta: de la semana más vieja a esta.
      pantalla: { encabezado: `${t.que[0].toUpperCase()}${t.que.slice(1)} arriba de lo normal`, serie: [...serie].reverse().map(redondear) },
      accion: { desde: S[0].desde, hasta: S[0].hasta },
    });
  }
  return salida;
}

// Minuto local de un instante, con su fecha civil.
function fechaYMinuto(instante, tz) {
  const t = new Date(instante);
  if (Number.isNaN(t.getTime())) return null;
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(t).map((p) => [p.type, p.value]));
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, minuto: Number(partes.hour) * 60 + Number(partes.minute) };
}
export function fueraDeHorario(instante, reglas, tz) {
  const base = Date.parse(instante);
  // Sin hora válida no se puede decir que fue fuera de horario.
  if (!Number.isFinite(base)) return false;
  const abierto = (ms) => {
    const fm = fechaYMinuto(new Date(base + ms).toISOString(), tz);
    if (!fm) return true;
    const r = evaluarHorarioLocal(reglas, fm.fecha, fm.minuto);
    return r.horarioInvalido ? true : r.abierto;
  };
  // Una hora de margen después del cierre (cuentas que se cobran tarde) y
  // media hora antes de abrir.
  return !abierto(0) && !abierto(-60 * 60000) && !abierto(30 * 60000);
}
const tieneHorario = (reglas) => !!(reglas && reglas.horarios && Object.values(reglas.horarios).some((h) => h && h.abierto === true && h.apertura && h.cierre));

function calidad(ctx) {
  const semana = ctx.periodos.semana;
  const ventas = ctx.ventas.filter((v) => v.clase === 'venta' && dentro(v.fecha, semana) && v.canal !== 'prueba');
  const salida = [];
  const armar = (tipo, filas, titulo, sugerencia, numeroRevisar, nota, encabezado) => {
    if (!filas.length) return;
    const total = filas.reduce((s, v) => s + v.neta, 0);
    salida.push({
      tipo, firma: tipo, impacto: redondear(total), titulo,
      detalle: {
        numeros: [numeroDe('Ventas', filas.length, 'entero'), numeroDe('Monto', total)],
        tabla: { columnas: ['Folio', 'Día', 'Hora', 'Canal', 'Venta'], formatos: ['texto', 'texto', 'texto', 'texto', 'dinero'], filas: filas.slice(0, 8).map((v) => [v.folio, fechaCorta(v.fecha), v.hora || '', v.canal_etiqueta || v.canal, v.neta]) },
        nota,
      },
      sugerencia,
      revisar: revisarEl(ctx, numeroRevisar, filas.length, 'entero'),
      frecuencia: 'diaria',
      pantalla: { encabezado },
      accion: { desde: semana.desde, hasta: semana.hasta },
    });
  };
  const sinPago = ventas.filter((v) => v.canal !== 'rappi' && !v.cortesia && v.neta > 0 && !String(v.forma_pago || '').trim());
  armar('ventas_sin_forma_pago', sinPago,
    `${sinPago.length === 1 ? '1 venta' : `${sinPago.length} ventas`} de la semana no ${sinPago.length === 1 ? 'tiene' : 'tienen'} forma de pago (${dinero(sinPago.reduce((s, v) => s + v.neta, 0))}).`,
    'Captura la forma de pago de esas ventas para que el corte cuadre.', 'Ventas sin forma de pago en la próxima semana',
    'No cuenta Rappi: esas las cobra la plataforma.', `${ventasN(sinPago.length)} sin forma de pago`);
  if (tieneHorario(ctx.reglasAtencion)) {
    const fuera = ventas.filter((v) => v.instante && fueraDeHorario(v.instante, ctx.reglasAtencion, ctx.tz));
    armar('ventas_fuera_horario', fuera,
      `${fuera.length === 1 ? '1 venta' : `${fuera.length} ventas`} de la semana se ${fuera.length === 1 ? 'registró' : 'registraron'} fuera del horario (${dinero(fuera.reduce((s, v) => s + v.neta, 0))}).`,
      'Revisa quién las registró y si eran ventas reales.', 'Ventas fuera del horario en la próxima semana',
      'Fuera del horario = más de una hora después del cierre o más de media hora antes de abrir, según el horario de la sucursal.',
      `${ventasN(fuera.length)} fuera del horario`);
  }
  const incompletas = ventas.filter((v) => !v.n_items || v.canal === 'sin_canal');
  armar('ventas_incompletas', incompletas,
    `${incompletas.length === 1 ? '1 venta' : `${incompletas.length} ventas`} de la semana ${incompletas.length === 1 ? 'quedó' : 'quedaron'} sin artículos o sin canal (${dinero(incompletas.reduce((s, v) => s + v.neta, 0))}).`,
    'Revisa esas ventas y complétalas.', 'Ventas incompletas en la próxima semana',
    'Incompleta = sin ningún artículo registrado, o sin canal de venta.',
    `${ventasN(incompletas.length)} ${incompletas.length === 1 ? 'incompleta' : 'incompletas'}`);
  return salida;
}

// ─── Todas ────────────────────────────────────────────────────────────────
/**
 * Los hallazgos de una sucursal. `ctx`:
 *   { negocio, tz, hoy (fecha de la corrida), ayer (último día completo),
 *     ventas: [venta normalizada (datos.js)], eventosMesa: [...],
 *     productos: { actual, anterior, nombres } | null, menu90: { tickets, sinMovimiento } | null,
 *     reglasAtencion, umbrales? }
 * Los semanales solo salen si la corrida es en lunes.
 *
 * Mejora 2 (28-nov-2026): `concretar` (recomendaciones.js, con su bandera
 * encendida) recibe los hallazgos y el contexto ya armado, y devuelve los
 * hallazgos con la recomendación concreta. Sin él, todo sale como antes.
 */
export function buscarHallazgos(ctxEntrada, { concretar } = {}) {
  const umbrales = { ...UMBRALES_ASISTENTE, ...(ctxEntrada.umbrales || {}) };
  const ventas = Array.isArray(ctxEntrada.ventas) ? ctxEntrada.ventas : [];
  const ctx = {
    ...ctxEntrada, umbrales, ventas,
    periodos: periodosDe(ctxEntrada.ayer),
    umbralGrande: umbralPedidoGrande(ventas, ctxEntrada.ayer, umbrales),
  };
  ctx.clientes = porCliente(ctx);
  const esLunes = new Date(`${ctx.hoy}T12:00:00Z`).getUTCDay() === 1;
  let todos = [
    ...control(ctx), ...calidad(ctx),
    ...cambiosDeMenu(ctx, 'producto'), ...cambiosDeMenu(ctx, 'categoria'),
    ...canales(ctx), ...flojos(ctx, 'dia'), ...flojos(ctx, 'franja'),
    ...clientesDejaron(ctx),
    ...(esLunes ? [...nuevosRegresan(ctx), ...pedidosGrandes(ctx), ...combinaciones(ctx), ...pocaVenta(ctx), ...clientesCambiaron(ctx)] : []),
  ];
  if (typeof concretar === 'function') todos = concretar(todos, ctx);
  return { hallazgos: todos.filter((h) => TIPOS_HALLAZGO.includes(h.tipo)).map(conAccionValida), umbralGrande: ctx.umbralGrande, esLunes };
}

/**
 * Mejora 1: un botón con datos que no pasan la revisión (una franja «otras»,
 * un canal con otra forma) no tumba el aviso: el aviso se queda sin botón.
 */
export function conAccionValida(h) {
  return h && h.accion != null && faltasDeAccion(h.accion).length ? { ...h, accion: null } : h;
}

// ─── Garantías que revisa cada corrida (y las pruebas) ────────────────────
// Sin causa y efecto: se dice qué cambió, nunca por qué.
export const FRASES_CAUSALES = /\b(porque|debido a|a causa|causa(do|ron|ó)?|provoc\w*|gracias a|por culpa|hizo que|se debe a|gener(ó|aron)|ocasion\w*|culpa de)\b/i;
// Teléfonos, correos y tarjetas: 7 o más dígitos seguidos, o una @.
export const PARECE_DATO_PERSONAL = /(\d[\s-]?){7,}|@/;

function textosDe(h) {
  const t = [h.titulo, h.sugerencia, h.revisar?.numero, h.detalle?.nota, h.pantalla?.encabezado];
  // Mejora 2: las cifras chicas de la tarjeta también se revisan.
  if (Array.isArray(h.pantalla?.datos)) t.push(...h.pantalla.datos);
  for (const n of h.detalle?.numeros || []) t.push(n.etiqueta);
  for (const c of h.detalle?.tabla?.columnas || []) t.push(c);
  for (const f of h.detalle?.tabla?.filas || []) for (const x of f) if (typeof x === 'string') t.push(x);
  return t.filter((x) => typeof x === 'string');
}
// Los folios (XAB-1234, POS-…) sí se permiten: no son de la persona.
const sinFolios = (s) => String(s).replace(/\b[A-Z]{2,5}-[0-9A-Z-]{1,24}\b/g, '');

// Lo que puede llevar `accion` (Mejora 1): una lista CERRADA de llaves, cada
// una con su forma. Así ningún dato de la persona (teléfono, nombre) se cuela.
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMA_ACCION = Object.freeze({
  producto: (v) => Number.isSafeInteger(v) && v > 0,
  categoria: (v) => typeof v === 'string' && /^c:\d{1,12}$/.test(v),
  canal: (v) => typeof v === 'string' && /^[a-z][a-z0-9_:]{0,39}$/.test(v),
  dia: (v) => Number.isInteger(v) && v >= 0 && v <= 6,
  franja: (v) => typeof v === 'string' && /^\d{1,2}-\d{1,2}$/.test(v),
  desde: (v) => typeof v === 'string' && FECHA.test(v),
  hasta: (v) => typeof v === 'string' && FECHA.test(v),
  clientes: (v) => Array.isArray(v) && v.length > 0 && v.length <= MAXIMO_CLIENTES_ACCION && v.every((x) => typeof x === 'string' && UUID.test(x)),
  categorias: (v) => Array.isArray(v) && v.length > 0 && v.length <= 5 && v.every((x) => typeof x === 'string' && /^c:\d{1,12}$/.test(x)),
});
/** Las faltas de `accion` (vacía = bien). Sin acción también está bien. */
export function faltasDeAccion(accion) {
  if (accion === null || accion === undefined) return [];
  if (typeof accion !== 'object' || Array.isArray(accion)) return ['acción inválida'];
  const faltas = [];
  for (const [k, v] of Object.entries(accion)) {
    if (!FORMA_ACCION[k]) faltas.push(`acción con una llave desconocida: ${k.slice(0, 20)}`);
    else if (!FORMA_ACCION[k](v)) faltas.push(`acción con «${k}» inválido`);
  }
  return faltas;
}

/**
 * Mejora 2: ¿nombra la recomendación algo concreto de SU aviso? Una cifra, o
 * uno de sus `concretos` (el producto, el día, el canal, quién autorizó…).
 * «Asegura el inventario para que sus platillos no se agoten» no pasa.
 */
export function tieneDatoConcreto(texto, h) {
  const s = String(texto || '');
  if (/\d/.test(sinFolios(s))) return true;
  const llano = sinAcentos(s);
  return (Array.isArray(h?.concretos) ? h.concretos : [])
    .map((c) => sinAcentos(c).trim())
    .some((c) => c.length >= 3 && llano.includes(c));
}

/**
 * ¿Cumple el hallazgo las reglas de forma? Devuelve la lista de faltas (vacía = bien).
 * `v2` (Mejora 2): la recomendación puede faltar (no hubo datos para una
 * concreta), pero si está, tiene que nombrar algo concreto de su aviso.
 */
export function faltasDeHallazgo(h, { v2 = false } = {}) {
  const faltas = [];
  if (!h || !TIPOS_HALLAZGO.includes(h.tipo)) faltas.push('tipo desconocido');
  if (!h?.firma) faltas.push('sin firma');
  if (!(Number(h?.impacto) >= 0)) faltas.push('impacto inválido');
  if (!String(h?.titulo || '').trim()) faltas.push('sin título');
  const sugerencia = String(h?.sugerencia || '').trim();
  if (!v2 && !sugerencia) faltas.push('sin acción');
  if (v2 && sugerencia && !tieneDatoConcreto(sugerencia, h)) faltas.push('recomendación sin dato concreto');
  if (!String(h?.revisar?.numero || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(h?.revisar?.el || ''))) faltas.push('sin número a revisar');
  faltas.push(...faltasDeAccion(h?.accion));
  for (const t of textosDe(h || {})) {
    if (FRASES_CAUSALES.test(t)) faltas.push(`lenguaje causal: «${t.slice(0, 60)}»`);
    if (PARECE_DATO_PERSONAL.test(sinFolios(t))) faltas.push(`parece dato personal: «${t.slice(0, 60)}»`);
  }
  return faltas;
}
