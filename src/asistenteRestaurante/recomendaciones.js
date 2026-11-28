// Asistente del restaurante, Mejora 2 (28-nov-2026, plan aprobado por el
// dueño): recomendaciones específicas, no genéricas.
//
// Lo que pidió el dueño:
//   · «Cada recomendación debe incluir al menos un dato concreto: qué
//     producto, qué horario, qué día, qué clientes o qué cantidad.»
//     Mal: «Asegura el inventario para que sus platillos no se agoten.»
//   · «Si no hay dato suficiente para una recomendación específica, la
//     tarjeta muestra el hallazgo sin recomendación.»
//   · Nada obvio: una categoría que se mueve igual que la venta total del
//     mismo periodo no se avisa (10 puntos de diferencia, el mismo margen de
//     los días y las franjas flojas).
//   · Canales: si es venta nueva o venta que cambió de canal, con cómo se
//     movieron los otros canales y el total en el mismo periodo.
//   · Orden: primero lo que pide decisión (control, caídas y clientes
//     perdidos), después las buenas noticias y al final lo informativo; dentro
//     de cada grupo, por pesos en juego (decisión 1 del plan).
//
// Funciones PURAS, salvo la lectura de la bandera. Todos los números salen de
// los datos que las reglas ya leyeron (reglas.js, datos.js): aquí no se lee
// nada nuevo de la base y no se calcula con la IA. La IA solo redacta
// (redaccion.js revisa que sus recomendaciones también traigan un dato).
//
// Bandera por sucursal: asistente_restaurante_reglas_v2 = 'true'. Apagada, la
// revisión de la mañana, el orden y la pantalla quedan exactamente como antes.
import { nombreVisible } from '../services/reporteConsejeroV2.js';
import { FRANJAS, DIAS_SEMANA } from '../services/reporteProductos.js';
import { TIPOS_CONTROL, TIPOS_INFORMATIVOS, dinero, tieneDatoConcreto } from './reglas.js';

export const BANDERA_REGLAS_V2 = 'asistente_restaurante_reglas_v2';

// ─── El orden: tres grupos ────────────────────────────────────────────────
export const TIPOS_DECISION = Object.freeze([...TIPOS_CONTROL,
  'producto_baja', 'categoria_baja', 'canal_baja', 'dia_flojo', 'franja_floja',
  'clientes_dejaron', 'nuevos_regresan_menos']);
export const TIPOS_BUENAS_NOTICIAS = Object.freeze(['producto_sube', 'categoria_sube', 'canal_sube', 'pedidos_grandes']);
/** 0 = pide decisión, 1 = buena noticia, 2 = informativo. */
export const grupoV2 = (tipo) => (TIPOS_DECISION.includes(tipo) ? 0 : TIPOS_INFORMATIVOS.includes(tipo) ? 2 : 1);
export const NOMBRES_GRUPO_V2 = Object.freeze(['pide_decision', 'buena_noticia', 'informativo']);

// Los márgenes de esta mejora (todavía no se configuran por sucursal).
export const UMBRALES_CONCRETOS = Object.freeze({
  explicaMinimo: 50,        // % del cambio que deben sumar los platillos que se nombran…
  explicaProductos: 3,      // …con 3 platillos como máximo
  picoDia: 35,              // % del cambio en un solo día de la semana (parejo sería 14 %)
  picoFranja: 40,           // % del cambio en una sola franja (parejo sería 20 %-25 %)
  picoMinimo: 500,          // pesos en 4 semanas para nombrar un día o una franja
  trasladoPct: 50,          // los otros canales se movieron al revés la mitad o más: cambio de canal
  nuevaPct: 25,             // un cuarto o menos: venta nueva (o que no se pasó a otro canal)
  casiIgualPct: 5,          // «el total casi no cambió»
});

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** ¿Tiene la sucursal las recomendaciones concretas encendidas? */
export async function reglasV2Encendidas(db, negocioId) {
  if (!esUuid(negocioId)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const { rows: [r] } = await db.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, BANDERA_REGLAS_V2]);
  return String(r?.valor ?? '').trim() === 'true';
}

// ─── Formatos ─────────────────────────────────────────────────────────────
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cambioPct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const pctTxt = (n) => `${Math.abs(Math.round((Number(n) || 0) * 10) / 10).toLocaleString('es-MX')} %`;
const pctSigno = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${pctTxt(n)}`;
const conSigno = (d) => `${d < 0 ? '−' : '+'}${dinero(Math.abs(d))}`;
const nombre = (s, respaldo) => nombreVisible(String(s || '').trim()) || respaldo;
const lista = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
const numeroDe = (etiqueta, valor, formato = 'dinero') => ({ etiqueta, valor: redondear(valor), formato });
const llaveDe = (firma) => { const s = String(firma || ''); const i = s.indexOf(':'); return i < 0 ? '' : s.slice(i + 1); };
const dentro = (f, r) => typeof f === 'string' && f >= r.desde && f <= r.hasta;
const valorN = (h, i) => { const v = Number(h?.detalle?.numeros?.[i]?.valor); return Number.isFinite(v) ? v : null; };
const verbo = (n) => (n < 0 ? 'bajó' : 'subió');
const unir = (a, b) => `${String(a || '').trim()} ${b}`.trim();
const NO_SON_NOMBRES = new Set(['Sin registrar', 'Usuario de otro negocio', 'Usuario sin nombre']);
// «los sábados», «los martes».
const losDias = (k) => { const d = DIAS_SEMANA[k]; return d ? `los ${d.endsWith('s') ? d : `${d}s`}` : ''; };
const DiasCap = (k) => { const d = losDias(k).slice(4); return d ? `${d[0].toUpperCase()}${d.slice(1)}` : ''; };
const etiquetaFranja = (k) => {
  if (k === 'otras') {
    const conHora = FRANJAS.filter((f) => f.desde !== null);
    return `fuera de ${Math.min(...conHora.map((f) => f.desde))} a ${Math.max(...conHora.map((f) => f.hasta))}`;
  }
  const f = FRANJAS.find((x) => x.clave === k);
  return f ? `de ${f.etiqueta}` : '';
};
// `datos`: las cifras chicas de la tarjeta (hasta 3), van en `pantalla`.
const conDatos = (h, { datos, ...extra }) => ({
  ...h, ...extra,
  pantalla: { ...(h.pantalla || {}), ...(datos && datos.length ? { datos: datos.slice(0, 3) } : {}) },
});

// ─── Las cuentas (de los mismos datos de las reglas) ──────────────────────
/** Venta total de los tickets con detalle de platillos, sin pedidos grandes (en pesos). */
function totalesDeProductos(ctx) {
  if (!ctx.productos) return null;
  const umbral = Math.round(ctx.umbralGrande * 100);
  const suma = (tks) => {
    let s = 0;
    for (const t of tks || []) if (t && t.desglose && !(t.neta > umbral)) s += Number(t.neta) || 0;
    return s / 100;
  };
  const P = suma(ctx.productos.actual), A = suma(ctx.productos.anterior);
  return { P, A, cambio: cambioPct(P, A) };
}

/** Venta por canal en los dos periodos, con los mismos filtros de las reglas. */
function totalesDeCanales(ctx) {
  const { P, A } = ctx.periodos;
  const sumas = (r) => {
    const m = new Map();
    let total = 0;
    for (const v of ctx.ventas) {
      if (v.clase !== 'venta' || !dentro(v.fecha, r) || v.neta > ctx.umbralGrande) continue;
      if (!v.canal || v.canal === 'prueba' || v.canal === 'sin_canal') continue;
      const x = m.get(v.canal) || { venta: 0, tickets: 0, etiqueta: v.canal_etiqueta || v.canal };
      x.venta += v.neta; x.tickets++; m.set(v.canal, x);
      total += v.neta;
    }
    return { m, total };
  };
  const p = sumas(P), a = sumas(A);
  return { P: p.m, A: a.m, totalP: p.total, totalA: a.total, cambio: cambioPct(p.total, a.total) };
}

/** La venta de unas líneas (`filtro`) por llave, en centavos. */
function ventaDeLineas(tks, umbral, filtro, llave) {
  const m = new Map();
  for (const t of tks || []) {
    if (!t || !t.desglose || t.neta > umbral) continue;
    for (const l of t.lineas || []) {
      if (!filtro(l)) continue;
      const k = llave(l, t);
      if (k === null || k === undefined) continue;
      m.set(k, (m.get(k) || 0) + (Number(l[3]) || 0));
    }
  }
  return m;
}

/**
 * Qué platillos suman la mayor parte del cambio de una categoría: los que se
 * movieron en el mismo sentido, de más a menos, hasta 3, hasta llegar a la
 * mitad del cambio. Si no llegan, el cambio está repartido (sin recomendación).
 */
export function platillosQueSuman(ctx, categoria, neto, U = UMBRALES_CONCRETOS) {
  const umbral = Math.round(ctx.umbralGrande * 100);
  const deCat = (l) => l[1] === categoria && l[0] !== null && l[0] !== undefined;
  const P = ventaDeLineas(ctx.productos.actual, umbral, deCat, (l) => l[0]);
  const A = ventaDeLineas(ctx.productos.anterior, umbral, deCat, (l) => l[0]);
  const nombres = ctx.productos.nombres?.productos || {};
  const filas = [...new Set([...P.keys(), ...A.keys()])].map((k) => {
    const ahora = (P.get(k) || 0) / 100, antes = (A.get(k) || 0) / 100;
    return { k, nombre: nombre(nombres[k], 'Un platillo'), ahora, antes, delta: redondear(ahora - antes) };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || String(a.k).localeCompare(String(b.k)));
  const mismo = neto ? filas.filter((f) => f.delta !== 0 && Math.sign(f.delta) === Math.sign(neto)) : [];
  let suma = 0;
  const elegidos = [];
  for (const f of mismo.slice(0, U.explicaProductos)) {
    elegidos.push(f);
    suma += f.delta;
    const parte = Math.round((suma / neto) * 100);
    if (parte >= U.explicaMinimo) return { platillos: elegidos, suma: redondear(suma), parte, filas };
  }
  return { platillos: [], suma: 0, parte: null, filas };
}

/**
 * El día de la semana y la franja donde se concentra el cambio de unas líneas
 * (las de un producto o una categoría). Solo se nombran si concentran una
 * parte clara del cambio; «Otras horas» no se nombra (no es un horario).
 */
export function picoDe(ctx, filtro, neto, U = UMBRALES_CONCRETOS) {
  if (!neto) return { dia: null, franja: null };
  const umbral = Math.round(ctx.umbralGrande * 100);
  const mover = (llave) => {
    const P = ventaDeLineas(ctx.productos.actual, umbral, filtro, llave);
    const A = ventaDeLineas(ctx.productos.anterior, umbral, filtro, llave);
    const m = new Map();
    for (const k of new Set([...P.keys(), ...A.keys()])) m.set(k, ((P.get(k) || 0) - (A.get(k) || 0)) / 100);
    return m;
  };
  const mejor = (m, minimoPct, excluir) => {
    let top = null;
    for (const [k, d] of m) {
      if (excluir && excluir(k)) continue;
      if (!d || Math.sign(d) !== Math.sign(neto)) continue;
      if (!top || Math.abs(d) > Math.abs(top.delta)) top = { k, delta: redondear(d) };
    }
    if (!top) return null;
    const parte = Math.round((top.delta / neto) * 100);
    return parte >= minimoPct && Math.abs(top.delta) >= U.picoMinimo ? { ...top, parte } : null;
  };
  const dia = mejor(mover((l, t) => (Number.isInteger(t.dia) && t.dia >= 0 && t.dia <= 6 ? t.dia : null)), U.picoDia);
  const franja = mejor(mover((l, t) => (t.franja ? String(t.franja) : null)), U.picoFranja, (k) => k === 'otras' || !etiquetaFranja(k));
  return { dia, franja };
}

const textoPico = (p) => lista([p.dia ? losDias(p.dia.k) : '', p.franja ? etiquetaFranja(p.franja.k) : ''].filter(Boolean));
const chipsPico = (p, baja) => [
  p.dia ? `${DiasCap(p.dia.k)}: ${pctTxt(p.dia.parte)} ${baja ? 'de la baja' : 'del aumento'}` : null,
  p.franja ? `${etiquetaFranja(p.franja.k).replace(/^de /, '').replace(/^./, (c) => c.toUpperCase())}: ${pctTxt(p.franja.parte)} ${baja ? 'de la baja' : 'del aumento'}` : null,
];
const notaPico = (p, baja) => {
  const partes = [];
  if (p.dia) partes.push(`el ${pctTxt(p.dia.parte)} ${baja ? 'de la baja' : 'del aumento'} fue ${losDias(p.dia.k)}`);
  if (p.franja) partes.push(`el ${pctTxt(p.franja.parte)}, ${etiquetaFranja(p.franja.k)}`);
  return partes.length ? `${partes.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : '';
};
const chipTotal = (cambio) => (cambio === null || cambio === undefined ? null
  : Math.abs(cambio) < 0.05 ? 'Total del negocio igual' : `Total del negocio ${pctSigno(cambio)}`);
const numerosTotal = (t) => [numeroDe('Venta total, últimas 4 semanas', t.P), numeroDe('Venta total, 4 anteriores', t.A)];

// ─── Cada tipo ────────────────────────────────────────────────────────────
function producto(h, ctx, base) {
  if (!ctx.productos) return h;
  const k = llaveDe(h.firma);
  const nom = nombre(ctx.productos.nombres?.productos?.[k], 'Un producto');
  const va = valorN(h, 0), vb = valorN(h, 1);
  if (va === null || vb === null) return h;
  const neto = redondear(va - vb);
  const baja = neto < 0;
  const p = picoDe(ctx, (l) => l[0] === k, neto);
  const donde = textoPico(p);
  const sugerencia = baja
    ? `Revisa que «${nom}» esté disponible y se ofrezca ${donde ? `${donde}, donde más bajó` : 'igual que antes'} (${dinero(Math.abs(neto))} menos en 4 semanas).`
    : `Asegura existencias de «${nom}»${donde ? ` ${donde}, donde más subió` : ''}: vende ${dinero(neto)} más que en las 4 semanas anteriores.`;
  const nota = notaPico(p, baja);
  return conDatos(h, {
    sugerencia,
    concretos: [nom, p.dia ? DIAS_SEMANA[p.dia.k] : null, p.franja ? etiquetaFranja(p.franja.k) : null].filter(Boolean),
    detalle: {
      ...h.detalle,
      numeros: [...(h.detalle?.numeros || []), ...(base.productos ? numerosTotal(base.productos) : [])],
      nota: unir(h.detalle?.nota, nota),
    },
    datos: [chipTotal(base.productos?.cambio), ...chipsPico(p, baja)].filter(Boolean),
  });
}

function categoria(h, ctx, base) {
  if (!ctx.productos) return h;
  const U = ctx.umbrales;
  const k = llaveDe(h.firma);
  const nomCat = nombre(ctx.productos.nombres?.categorias?.[k], 'Una categoría');
  const va = valorN(h, 0), vb = valorN(h, 1);
  if (va === null || vb === null) return h;
  const neto = redondear(va - vb);
  const baja = neto < 0;
  const c = cambioPct(va, vb);
  const g = base.productos?.cambio ?? null;
  // Lo obvio: se mueve casi igual que todo el negocio.
  if (g !== null && c !== null && (baja ? c > g - U.puntosBajoGeneral : c < g + U.puntosBajoGeneral)) return null;
  const ex = platillosQueSuman(ctx, k, neto);
  const p = picoDe(ctx, (l) => l[1] === k, neto);
  const donde = textoPico(p);
  const nombres = ex.platillos.map((f) => `«${f.nombre}»`);
  let sugerencia = '';
  let notaReparto = '';
  if (nombres.length) {
    const cuanto = ex.parte > 100
      ? `suman ${conSigno(ex.suma)}, más que toda la categoría (${conSigno(neto)})`
      : `suman el ${ex.parte} % ${baja ? 'de la baja' : 'del aumento'}`;
    sugerencia = baja
      ? `Revisa que ${lista(nombres)} ${nombres.length === 1 ? 'esté disponible y se ofrezca' : 'estén disponibles y se ofrezcan'}${donde ? ` ${donde}` : ''}: ${cuanto}.`
      : `Asegura existencias de ${lista(nombres)}${donde ? ` ${donde}` : ''}: ${cuanto}.`;
  } else {
    notaReparto = 'El cambio está repartido entre muchos platillos: ninguno suma la mitad, así que no hay una recomendación concreta.';
  }
  const titulo = g === null ? h.titulo : `${h.titulo} El total del negocio ${verbo(g)} ${pctTxt(g)}.`;
  return conDatos(h, {
    titulo,
    sugerencia,
    concretos: [nomCat, ...ex.platillos.map((f) => f.nombre), p.dia ? DIAS_SEMANA[p.dia.k] : null, p.franja ? etiquetaFranja(p.franja.k) : null].filter(Boolean),
    detalle: {
      ...h.detalle,
      numeros: [...(h.detalle?.numeros || []), ...(base.productos ? numerosTotal(base.productos) : [])],
      tabla: ex.filas.length ? {
        columnas: ['Platillo', 'Últimas 4 semanas', '4 anteriores', 'Cambio'],
        formatos: ['texto', 'dinero', 'dinero', 'cambio'],
        filas: ex.filas.slice(0, 5).map((f) => [f.nombre, redondear(f.ahora), redondear(f.antes), f.delta]),
      } : h.detalle?.tabla,
      nota: unir(unir(h.detalle?.nota, notaPico(p, baja)), notaReparto),
    },
    datos: [chipTotal(g), ...chipsPico(p, baja)].filter(Boolean),
  });
}

/** ¿Venta nueva o venta que cambió de canal? Con los mismos filtros de las reglas. */
export function claseDeCanal(base, canal, U = UMBRALES_CONCRETOS) {
  const a = base.P.get(canal)?.venta || 0, b = base.A.get(canal)?.venta || 0;
  const D = a - b;
  const T = base.totalP - base.totalA;
  const O = T - D;
  const s = D ? (-O / D) * 100 : 0;
  const clase = s >= U.trasladoPct ? 'traslado' : s > U.nuevaPct ? 'mixta' : 'nueva';
  // El otro canal que más se movió al revés.
  let otro = null;
  for (const k of new Set([...base.P.keys(), ...base.A.keys()])) {
    if (k === canal) continue;
    const d = (base.P.get(k)?.venta || 0) - (base.A.get(k)?.venta || 0);
    if (!d || Math.sign(d) === Math.sign(D)) continue;
    if (!otro || Math.abs(d) > Math.abs(otro.delta)) {
      otro = { k, delta: redondear(d), etiqueta: base.P.get(k)?.etiqueta || base.A.get(k)?.etiqueta || k, cambio: cambioPct(base.P.get(k)?.venta || 0, base.A.get(k)?.venta || 0) };
    }
  }
  return { clase, D: redondear(D), T: redondear(T), O: redondear(O), parte: Math.round(s), otro };
}

function canal(h, ctx, base) {
  const ch = base.canales;
  const k = llaveDe(h.firma);
  const yo = ch.P.get(k) || ch.A.get(k);
  if (!yo) return h;
  const et = yo.etiqueta;
  const r = claseDeCanal(ch, k);
  const baja = r.D < 0;
  const g = ch.cambio;
  const U = UMBRALES_CONCRETOS;
  const otroTxt = r.otro ? `${r.otro.etiqueta} ${baja ? 'subió' : 'bajó'} ${r.otro.cambio === null ? dinero(Math.abs(r.otro.delta)) : pctTxt(r.otro.cambio)}` : `los otros canales se movieron al revés`;
  const totalTxt = g === null ? '' : (Math.abs(g) < U.casiIgualPct ? `el total casi no cambió (${pctSigno(g)})` : `el total ${verbo(g)} ${pctTxt(g)}`);
  let frase; let chip; let sugerencia;
  const otroDinero = r.otro ? `${r.otro.etiqueta} (${conSigno(r.otro.delta)} en 4 semanas)` : 'otro canal';
  if (r.clase === 'traslado') {
    frase = `Parece venta que cambió de canal: ${otroTxt}${totalTxt ? ` y ${totalTxt}` : ''}.`;
    chip = 'Parece cambio de canal';
    sugerencia = baja
      ? `Revisa si los clientes de ${et} ahora piden por ${otroDinero}.`
      : `Compara lo que te deja cada canal: ${et} subió ${dinero(r.D)} y ${r.otro ? `${r.otro.etiqueta} bajó ${dinero(Math.abs(r.otro.delta))}` : 'los otros bajaron'} en 4 semanas.`;
  } else if (r.clase === 'mixta') {
    frase = baja
      ? `En parte se pasó a otro canal: ${otroTxt}${totalTxt ? ` y ${totalTxt}` : ''}.`
      : `En parte es venta nueva: ${totalTxt || 'el total cambió'} y ${otroTxt}.`;
    chip = baja ? 'En parte a otro canal' : 'En parte venta nueva';
    sugerencia = baja
      ? `Revisa que ${et} funcione y se anuncie igual que antes; ${r.otro ? `${r.otro.etiqueta} subió ${dinero(Math.abs(r.otro.delta))}` : 'otros canales subieron'} en el mismo periodo.`
      : `Asegura que ${et} se atienda a tiempo (${conSigno(r.D)} en 4 semanas); ${r.otro ? `${r.otro.etiqueta} bajó ${dinero(Math.abs(r.otro.delta))}` : 'otros canales bajaron'} en el mismo periodo.`;
  } else {
    frase = baja
      ? `No se pasó a otro canal: ${totalTxt || 'el total también bajó'}.`
      : `Es venta nueva: ${totalTxt || 'el total también subió'}.`;
    chip = baja ? 'No se pasó a otro canal' : 'Venta nueva';
    sugerencia = baja
      ? `Revisa que ${et} funcione y se anuncie igual que antes: vendió ${dinero(Math.abs(r.D))} menos y el total no lo compensó.`
      : `Asegura que ${et} se atienda a tiempo con el volumen nuevo: ${conSigno(r.D)} en 4 semanas.`;
  }
  const filas = [...new Set([...ch.P.keys(), ...ch.A.keys()])].map((c) => {
    const p = ch.P.get(c)?.venta || 0, a = ch.A.get(c)?.venta || 0;
    return [ch.P.get(c)?.etiqueta || ch.A.get(c)?.etiqueta || c, redondear(p), redondear(a), cambioPct(p, a)];
  }).sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]))).slice(0, 7);
  filas.push(['Total', redondear(ch.totalP), redondear(ch.totalA), g]);
  return conDatos(h, {
    titulo: `${h.titulo} ${frase}`,
    sugerencia,
    concretos: [et, r.otro ? r.otro.etiqueta : null].filter(Boolean),
    detalle: {
      ...h.detalle,
      numeros: [...(h.detalle?.numeros || []), numeroDe('Venta total, últimas 4 semanas', ch.totalP), numeroDe('Venta total, 4 anteriores', ch.totalA)],
      tabla: { columnas: ['Canal', 'Últimas 4 semanas', '4 anteriores', 'Cambio'], formatos: ['texto', 'dinero', 'dinero', 'pct'], filas },
      nota: unir(h.detalle?.nota, 'Venta nueva: el total del negocio se movió casi igual que el canal. Cambio de canal: los otros canales se movieron al revés la mitad o más.'),
    },
    datos: [chipTotal(g), chip, r.otro && r.clase !== 'nueva' && r.otro.cambio !== null ? `${r.otro.etiqueta} ${pctSigno(r.otro.cambio)}` : null].filter(Boolean),
  });
}

function dia(h) {
  const k = Number(llaveDe(h.firma));
  if (!losDias(k)) return h;
  return conDatos(h, {
    sugerencia: `Prueba una promoción o un platillo del día solo ${losDias(k)}: vendieron ${dinero(h.impacto)} menos en 4 semanas.`,
    concretos: [DIAS_SEMANA[k]],
  });
}

function franja(h) {
  const k = llaveDe(h.firma);
  const e = etiquetaFranja(k);
  if (!e) return h;
  return conDatos(h, {
    sugerencia: `Revisa el personal y la oferta ${e} y prueba una promoción solo en ese horario: vendió ${dinero(h.impacto)} menos en 4 semanas.`,
    concretos: [e],
  });
}

function clientesDejaron(h) {
  const n = valorN(h, 0), total = valorN(h, 1);
  if (!n || total === null) return h;
  return conDatos(h, {
    sugerencia: n === 1
      ? `Escríbele a este cliente (gastaba ${dinero(total)} al mes) o mándale una promoción para que vuelva.`
      : `Escríbeles a estos ${n} clientes (gastaban ${dinero(total)} al mes, juntos) o mándales una promoción para que vuelvan.`,
    concretos: [],
  });
}

function nuevosRegresan(h) {
  const n = valorN(h, 0), v = valorN(h, 1);
  if (n === null || v === null) return h;
  return conDatos(h, {
    sugerencia: `Ofrece algo para la segunda visita: de ${n} clientes nuevos, regresaron ${v} en su primer mes.`,
    concretos: [],
  });
}

const CONTROL = Object.freeze({
  descuentos_altos: { con: 'que cada descuento haya sido correcto', sin: (n) => `que ${n === 1 ? 'el descuento' : `cada uno de los ${n} descuentos`} de la semana haya sido correcto` },
  cancelaciones_altas: { con: 'que cada cancelación tenga su motivo', sin: (n) => `que ${n === 1 ? 'la cancelación' : `cada una de las ${n} cancelaciones`} de la semana tenga su motivo` },
  cortesias_altas: { con: 'a quién se dieron las cortesías y por qué', sin: (n) => `a quién se ${n === 1 ? 'dio la cortesía' : `dieron las ${n} cortesías`} de la semana y por qué` },
});
function control(h) {
  const def = CONTROL[h.tipo];
  const actual = valorN(h, 0), n = valorN(h, 3);
  if (!def || actual === null) return h;
  const top = (h.detalle?.tabla?.filas || []).find((f) => Array.isArray(f) && typeof f[0] === 'string' && !NO_SON_NOMBRES.has(f[0]) && Number(f[1]) > 0);
  // Si una sola persona autorizó todo, se dice así (no «$6,720 de los $6,720»).
  const todo = top && Math.round(Number(top[1])) >= Math.round(actual);
  const sugerencia = top
    ? `Revisa con ${top[0]}, que autorizó ${todo ? `todo (${dinero(actual)})` : `${dinero(top[1])} de los ${dinero(actual)}`}, ${def.con}.`
    : `Revisa ${def.sin(n || 0)} (${dinero(actual)}).`;
  return conDatos(h, { sugerencia, concretos: top ? [top[0]] : [] });
}

function calidad(h) {
  const n = valorN(h, 0), m = valorN(h, 1);
  if (!n || m === null) return h;
  const esas = n === 1 ? 'esa venta' : `esas ${n} ventas`;
  const sugerencia = {
    ventas_sin_forma_pago: `Captura la forma de pago de ${esas} (${dinero(m)}) para que el corte cuadre.`,
    ventas_fuera_horario: `Revisa quién registró ${esas} (${dinero(m)}) y si ${n === 1 ? 'era una venta real' : 'eran ventas reales'}.`,
    ventas_incompletas: `Revisa ${esas} (${dinero(m)}) y ${n === 1 ? 'complétala' : 'complétalas'}.`,
  }[h.tipo];
  return sugerencia ? conDatos(h, { sugerencia, concretos: [] }) : h;
}

function pedidosGrandes(h) {
  const n = valorN(h, 0), total = valorN(h, 1);
  if (!n || total === null) return h;
  return conDatos(h, {
    sugerencia: n === 1
      ? `Si el pedido grande (${dinero(total)}) fue de una empresa o un evento, ofrece repetirlo.`
      : `Si los ${n} pedidos grandes (${dinero(total)}) fueron de empresas o eventos, ofrece repetirlos.`,
    concretos: [],
  });
}

function combinaciones(h, ctx) {
  const [a, b] = llaveDe(h.firma).split('|');
  const nombres = ctx.productos?.nombres?.categorias || {};
  const na = nombre(nombres[a], ''), nb = nombre(nombres[b], '');
  if (!na || !nb) return h;
  return conDatos(h, {
    sugerencia: `Prueba ofrecer ${na} y ${nb} juntas (un combo o una sugerencia al tomar la orden).`,
    concretos: [na, nb],
  });
}

function pocaVenta(h) {
  const n = valorN(h, 1);
  const filas = (h.detalle?.tabla?.filas || []).filter((f) => Array.isArray(f) && typeof f[0] === 'string' && f[0].trim());
  if (!n || !filas.length) return h;
  const [x, y] = filas.map((f) => `«${f[0]}»`);
  const quienes = n === 1 || !y ? x : n === 2 ? `${x} y ${y}` : `${x}, ${y} y ${n - 2} más`;
  const uno = n === 1 || !y;
  return conDatos(h, {
    sugerencia: `Decide si ${quienes} ${uno ? 'se queda en el menú, se cambia o se promueve' : 'se quedan en el menú, se cambian o se promueven'}.`,
    concretos: filas.slice(0, 2).map((f) => f[0]),
  });
}

function clientesCambiaron(h) {
  const n = valorN(h, 0);
  if (!n) return h;
  return conDatos(h, {
    sugerencia: n === 1
      ? 'Pregúntale a este cliente en su próximo pedido cómo le fue la última vez.'
      : `Pregúntales a estos ${n} clientes en su próximo pedido cómo les fue la última vez.`,
    concretos: [],
  });
}

const POR_TIPO = Object.freeze({
  producto_baja: producto, producto_sube: producto,
  categoria_baja: categoria, categoria_sube: categoria,
  canal_baja: canal, canal_sube: canal,
  dia_flojo: dia, franja_floja: franja,
  clientes_dejaron: clientesDejaron, nuevos_regresan_menos: nuevosRegresan,
  descuentos_altos: control, cancelaciones_altas: control, cortesias_altas: control,
  ventas_sin_forma_pago: calidad, ventas_fuera_horario: calidad, ventas_incompletas: calidad,
  pedidos_grandes: pedidosGrandes, combinaciones, poca_venta: pocaVenta, clientes_cambiaron: clientesCambiaron,
});

/**
 * Los hallazgos de las reglas → con su recomendación concreta (para
 * reglas.buscarHallazgos, opción `concretar`). Una categoría que se mueve
 * igual que el negocio se quita. Cada hallazgo lleva `concretos`: los
 * nombres que su recomendación puede usar como dato (los revisa
 * reglas.tieneDatoConcreto, también en los textos de la IA).
 */
export function concretarHallazgos(hallazgos, ctx) {
  const base = { productos: totalesDeProductos(ctx), canales: totalesDeCanales(ctx) };
  const salida = [];
  for (const h of hallazgos || []) {
    const f = POR_TIPO[h?.tipo];
    const x = f ? f(h, ctx, base) : h;
    if (!x) continue;
    // Sin datos para una recomendación concreta, el aviso sale sin ella
    // (nunca con la genérica de antes).
    if (!tieneDatoConcreto(x.sugerencia, x)) salida.push({ ...x, sugerencia: '' });
    else salida.push(x);
  }
  return salida;
}
