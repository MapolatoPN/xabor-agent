// Reportes → Productos (Fase 3, nov-2026).
//
// Qué se vendió, de qué categoría, con qué opciones, junto con qué y a qué
// hora. Con la MISMA definición de venta que Reportes → Ventas
// (clasificarPedido / importesDePedido de reporteVentas.js): fuera los
// cancelados, los «por cobrar» y las mesas sin consumo.
//
// De dónde salen los productos: del registro de líneas de la Fase 2
// (pedido_lineas + pedido_linea_modificadores), ligado a cada venta. Solo se
// usa el registro VIGENTE: el que se hizo con los artículos que tiene hoy la
// venta (la misma firma que calcula lineasEstructuradasProceso.js). Una venta
// sin registro, o con uno viejo, no se adivina: su venta va a «Sin desglose»,
// contada y a la vista, y el cuadre sigue cerrando.
//
// El cuadre (va siempre arriba en el panel):
//   Productos + Otros + Envíos (cobrados y capturados como producto)
//   + Sin desglose − Descuentos = Venta neta
// al centavo, con la misma venta neta que la pestaña Ventas para el mismo
// periodo cuando no hay filtros.
//
// Decisiones del dueño (24-nov-2026, plan aprobado con los valores por
// omisión):
//   · La venta de un producto es ANTES de descuentos: los descuentos van en su
//     propio renglón del cuadre.
//   · Lo que la venta cobró de más o de menos que la suma de sus líneas (los
//     toppings de Rappi, que el pedido trae en el subtotal pero no en el precio
//     de cada producto) se reparte entre los productos de esa MISMA venta, en
//     proporción a lo que vale cada uno. Cada renglón dice cuánto recibió.
//   · Franjas: 7–9, 9–11, 11–13, 13–15 y «Otras horas».
//   · «Sin movimiento»: menos de 3 piezas en el periodo (se cambia en pantalla).
//   · Temporada no entra: no es una venta de pedidos_activos.
//
// Revisión del dueño (25-nov-2026, con Obispado 1–25 nov):
//   · Un producto de la categoría «ENVIO» es envío aunque el menú no lo marque
//     (esEnvioDelMenu): sale de las tablas y su dinero va al renglón Envíos.
//   · «Sin movimiento» trae sus conteos: activos con y sin venta, y los
//     vendidos que hoy ya no están activos.
//   · «Por hora» trae los 5 de cada franja por venta (primero) y por piezas.
//   · Si el rango incluye hoy, el periodo anterior se compara hasta la misma
//     hora (corteDelPeriodoAnterior).
//
// «Por ticket» (25-nov-2026, pregunta del dueño: «¿cuántos tacos por
// ticket?»): cada producto y cada categoría dicen cuántas piezas lleva en
// promedio un ticket que los pide, y cada categoría trae además lo típico (la
// mediana) y el reparto por tramos (repartoPorTicket). Solo cuenta piezas: el
// cuadre no cambia. Una mesa es UN ticket aunque coman varias personas.
//
// Todo se suma en centavos enteros. negocioId OBLIGATORIO en cada lectura.
import { pool } from './database.js';
import { rangoUtcDeFecha, esFechaValida, fechaOperativaDe, instanteLocal } from './cortesCaja.js';
import { esZonaValida } from './zonaHoraria.js';
import {
  clasificarPedido, importesDePedido, canalDeVenta, periodoAnterior, porcentajes, fechaYHoraLocal,
} from './reporteVentas.js';
import { VERSION_REGISTRO, normalizarTexto, tipoDeProducto, tipoPropuestoInicial } from './lineasEstructuradas.js';

export const BANDERA_REPORTES_PRODUCTOS = 'reportes_productos_v1';
export const MINIMO_SIN_MOVIMIENTO = 3;
export const TOP_COMBINACIONES = 10;
export const TOP_PARES = 20;
export const TOP_POR_FRANJA = 5;

// Los tipos que son producto vendido. «envio» y «otro» quedan fuera de las
// tablas (regla de la fase) pero dentro del cuadre, cada uno en su renglón.
const TIPOS_DE_PRODUCTO = new Set(['platillo', 'bebida', 'extra']);

// Envío, para ESTE reporte (revisión del 25-nov-2026): un producto del menú
// ya marcado como envío, o de la categoría «ENVIO» — la misma regla aprobada
// el 23-nov-2026 para marcar el menú (scripts/marcar-tipo-producto.mjs). En
// Obispado y Acuña el menú sigue sin marcar («ENVIO 60» y «ENVIO 70» son
// «platillo»), y por eso salían en Productos y en «Sin movimiento». La marca
// del menú NO se toca aquí: cambiarla mueve también al bot y al menú de Rappi.
// Un renglón que no quedó ligado al menú es envío si su nombre empieza así.
export function esEnvioDelMenu(p) {
  if (!p) return false;
  return tipoDeProducto(p) === 'envio'
    || tipoPropuestoInicial({ nombre: p.nombre, categoria: p.categoria, opciones: p.opciones }) === 'envio';
}
export const esNombreDeEnvio = (nombre) => /^envios?\b/.test(normalizarTexto(nombre));

export const FRANJAS = Object.freeze([
  Object.freeze({ clave: '7-9', desde: 7, hasta: 9, etiqueta: '7 a 9' }),
  Object.freeze({ clave: '9-11', desde: 9, hasta: 11, etiqueta: '9 a 11' }),
  Object.freeze({ clave: '11-13', desde: 11, hasta: 13, etiqueta: '11 a 13' }),
  Object.freeze({ clave: '13-15', desde: 13, hasta: 15, etiqueta: '13 a 15' }),
  Object.freeze({ clave: 'otras', desde: null, hasta: null, etiqueta: 'Otras horas' }),
]);
const CLAVES_FRANJA = new Set(FRANJAS.map((f) => f.clave));

/** La franja de una hora local (0–23). */
export function franjaDeHora(hora) {
  const f = FRANJAS.find((x) => x.desde !== null && hora >= x.desde && hora < x.hasta);
  return f ? f.clave : 'otras';
}

export const MODALIDADES = Object.freeze([
  Object.freeze({ clave: 'domicilio', etiqueta: 'A domicilio' }),
  Object.freeze({ clave: 'recoger', etiqueta: 'Recoger en tienda' }),
  Object.freeze({ clave: 'mesa', etiqueta: 'Mesa' }),
  Object.freeze({ clave: 'otra', etiqueta: 'Sin modalidad registrada' }),
]);
const CLAVES_MODALIDAD = new Set(MODALIDADES.map((m) => m.clave));

/**
 * La modalidad de una venta, con las palabras de la tarjeta de Ventas
 * (contarModalidad): una mesa es mesa aunque su texto diga otra cosa.
 */
export function modalidadDe(datos = {}) {
  const m = String(datos?.modalidad || '').toLowerCase();
  if (m === 'mesa' || datos?.canal === 'restaurante_mesa') return 'mesa';
  if (m.includes('domicilio')) return 'domicilio';
  if (m.includes('recoger') || m.includes('tienda')) return 'recoger';
  return 'otra';
}

export const DIAS_SEMANA = Object.freeze(['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']);
// La semana se lee de lunes a domingo, como en Ventas.
export const ORDEN_SEMANA = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

const centavos = (n) => Math.round((Number(n) || 0) * 100);
const pesos = (c) => Math.round(c) / 100;
const piezas = (n) => Math.round((Number(n) || 0) * 100) / 100;
const textoCorto = (v, n = 60) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * Filtros pedidos por el panel. Todos son opcionales; vacío = todos.
 *   canal (clave de canalDeVenta), modalidad, dia (0 = domingo … 6),
 *   franja, minimo (piezas para «Sin movimiento», 1–1000).
 * Devuelve { filtros, minimo } o { error }.
 */
export function filtrosDeReporte(q = {}) {
  const canal = textoCorto(q.canal);
  if (canal && !/^[\p{L}\p{N}_:. -]+$/u.test(canal)) return { error: 'Canal no válido' };
  const modalidad = textoCorto(q.modalidad, 20);
  if (modalidad && !CLAVES_MODALIDAD.has(modalidad)) return { error: 'Modalidad no válida' };
  const diaTxt = textoCorto(q.dia, 2);
  if (diaTxt && !/^[0-6]$/.test(diaTxt)) return { error: 'Día de la semana no válido' };
  const franja = textoCorto(q.franja, 10);
  if (franja && !CLAVES_FRANJA.has(franja)) return { error: 'Franja horaria no válida' };
  const minTxt = textoCorto(q.minimo, 5);
  if (minTxt && (!/^\d{1,4}$/.test(minTxt) || Number(minTxt) < 1 || Number(minTxt) > 1000)) {
    return { error: 'El mínimo de piezas va de 1 a 1000' };
  }
  return {
    filtros: { canal: canal || null, modalidad: modalidad || null, dia: diaTxt ? Number(diaTxt) : null, franja: franja || null },
    minimo: minTxt ? Number(minTxt) : MINIMO_SIN_MOVIMIENTO,
  };
}

const hayFiltros = (f = {}) => !!(f.canal || f.modalidad || (f.dia !== null && f.dia !== undefined) || f.franja);

// ─── Comparación cuando el rango incluye hoy ───────────────────────────────
// Revisión del 25-nov-2026: con «1 al 25 de noviembre» a las 9 de la mañana,
// hoy llevaba unos pesos y el 25 de octubre su día completo, y el cambio salía
// negativo cuando los días cerrados iban arriba. Desde entonces, si el rango
// incluye el día de hoy del negocio, el periodo anterior se lee solo hasta la
// MISMA hora del reloj de su día equivalente. Lo de este periodo no se corta:
// sigue siendo la misma venta de la pestaña Ventas.
const DIA_MS = 24 * 60 * 60 * 1000;
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS) + 1;
const relojes = new Map();
function relojEnZona(instante, tz) {
  let fmt = relojes.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    relojes.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(instante).map((x) => [x.type, x.value]));
  return { h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/**
 * Hasta dónde se lee el periodo anterior. null = completo (el rango no
 * incluye hoy). Si lo incluye: { fecha, hora: 'H:MM', fin } — el día del
 * periodo anterior que corresponde a hoy, la hora del reloj del negocio y el
 * instante UTC donde se corta (con horario de verano o sin él).
 */
export function corteDelPeriodoAnterior({ desde, hasta, anterior, ahora = new Date(), tz } = {}) {
  if (!anterior || !esZonaValida(tz) || !esFechaValida(desde) || !esFechaValida(hasta)) return null;
  const t = ahora instanceof Date ? ahora : new Date(ahora);
  if (Number.isNaN(t.getTime())) return null;
  const hoy = fechaOperativaDe(t, tz);
  if (hoy < desde || hoy > hasta) return null;
  const fecha = sumarDias(anterior.desde, diasEntre(desde, hoy) - 1);
  // Un mes más corto que este (31 contra 30): ese día no tiene par; se compara completo.
  if (fecha > anterior.hasta) return null;
  const r = relojEnZona(t, tz);
  const [y, mo, d] = fecha.split('-').map(Number);
  return { fecha, hora: `${r.h}:${String(r.mi).padStart(2, '0')}`, fin: instanteLocal(y, mo, d, r.h, r.mi, r.s, tz) };
}

/** Lo que dice la pantalla: «1 al 25 de octubre, hasta las 9:17». */
export function etiquetaDeComparacion(anterior, corte) {
  if (!anterior) return '';
  if (!corte) return anterior.etiqueta;
  if (corte.fecha === anterior.hasta) return `${anterior.etiqueta}, hasta las ${corte.hora}`;
  const [, m, d] = corte.fecha.split('-');
  return `${anterior.etiqueta}, hasta el ${Number(d)}/${m} a las ${corte.hora}`;
}

/**
 * Reparte `residuo` centavos entre `importes` (centavos > 0) en proporción,
 * con el método del mayor residuo: la suma de lo repartido es EXACTAMENTE
 * `residuo`. Si el residuo es negativo y mayor que lo que valen las líneas,
 * cada línea baja a cero y lo que sobra vuelve en `sinRepartir`.
 */
export function repartirProporcional(importes = [], residuo = 0) {
  const base = importes.reduce((s, x) => s + Math.max(0, x), 0);
  const partes = importes.map(() => 0);
  if (!residuo || base <= 0) return { partes, sinRepartir: residuo };
  const aplicado = residuo < -base ? -base : residuo;
  const signo = aplicado < 0 ? -1 : 1;
  const r = Math.abs(aplicado);
  const exactos = importes.map((x) => (Math.max(0, x) * r) / base);
  const pisos = exactos.map(Math.floor);
  let faltan = r - pisos.reduce((s, x) => s + x, 0);
  const orden = exactos.map((x, i) => [x - pisos[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; faltan > 0 && k < orden.length; k++, faltan--) pisos[orden[k][1]]++;
  return { partes: pisos.map((p) => p * signo), sinRepartir: residuo - aplicado };
}

// ─── Identidad de productos, categorías y opciones ─────────────────────────
// Con UNA sucursal, un producto es su id del menú (o su nombre, si la línea no
// quedó ligada al menú). Con varias, los ids no se parecen entre sucursales:
// se juntan por el nombre (sin mayúsculas ni acentos).
function crearLlaves(multi) {
  return {
    producto(linea, prod) {
      const nombre = prod ? prod.nombre : linea.nombre;
      if (multi) return `n:${normalizarTexto(nombre)}`;
      if (prod) return `p:${prod.id}`;
      const id = Number(linea.producto_id);
      return Number.isInteger(id) && id > 0 ? `p:${id}` : `n:${normalizarTexto(nombre)}`;
    },
    categoria(prod) {
      if (!prod || !prod.categoria) return 'sin';
      return multi ? `n:${normalizarTexto(prod.categoria)}` : `c:${prod.categoria_id}`;
    },
    grupo(llaveProducto, mod) {
      const id = Number(mod.grupo_id);
      return multi || !(Number.isInteger(id) && id > 0)
        ? `${llaveProducto}|n:${normalizarTexto(mod.grupo)}` : `${llaveProducto}|g:${id}`;
    },
    opcion(mod) {
      const id = Number(mod.opcion_id);
      return multi || !(Number.isInteger(id) && id > 0) ? `n:${normalizarTexto(mod.opcion)}` : `o:${id}`;
    },
  };
}

function indexarCatalogo(catalogo = []) {
  const porId = new Map();
  for (const p of catalogo) {
    const id = Number(p?.id);
    if (!Number.isInteger(id)) continue;
    porId.set(id, {
      id, nombre: String(p.nombre ?? '').trim() || `Producto ${id}`,
      tipo: tipoDeProducto(p),
      es_envio: esEnvioDelMenu(p),
      disponible: p.disponible !== false,
      categoria_id: p.categoria_id ?? null,
      categoria: p.categoria ? String(p.categoria).trim() : null,
      categoria_activa: p.categoria_activa !== false,
      categoria_orden: Number(p.categoria_orden) || 0,
    });
  }
  return porId;
}

// «Guarniciones: Frijoles, Papa a la mexicana · Salsa: Verde»: las opciones de
// un mismo grupo van juntas (antes se repetía el grupo en cada una, y una
// combinación ocupaba cuatro renglones en la tarjeta).
export function textoDeCombinacion(textos = []) {
  const grupos = [];
  for (const x of textos) {
    const g = grupos.find((y) => y.grupo === x.grupo);
    if (g) g.opciones.push(x.opcion); else grupos.push({ grupo: x.grupo, opciones: [x.opcion] });
  }
  return grupos.map((g) => `${g.grupo}: ${g.opciones.join(', ')}`).join(' · ');
}

// Tramos del reparto «por ticket». Un ticket cae en el PRIMER tramo cuyo tope
// alcanza sus piezas, así que una cantidad con decimales (1.5) cae en el que la
// contiene (2) y ninguna se pierde.
export const TRAMOS_POR_TICKET = Object.freeze([
  Object.freeze({ clave: '1', etiqueta: '1', hasta: 1 }),
  Object.freeze({ clave: '2', etiqueta: '2', hasta: 2 }),
  Object.freeze({ clave: '3', etiqueta: '3', hasta: 3 }),
  Object.freeze({ clave: '4', etiqueta: '4', hasta: 4 }),
  Object.freeze({ clave: '5', etiqueta: '5', hasta: 5 }),
  Object.freeze({ clave: '6-9', etiqueta: '6 a 9', hasta: 9 }),
  Object.freeze({ clave: '10+', etiqueta: '10 o más', hasta: Infinity }),
]);

/** Piezas por ticket con un decimal; null sin tickets. */
export function promedioPorTicket(unidades, tickets) {
  const n = Number(tickets) || 0;
  return n > 0 ? Math.round(((Number(unidades) || 0) / n) * 10) / 10 : null;
}

/**
 * Lo que lleva cada ticket, resumido: `valores` son las piezas de UN producto o
 * categoría en cada ticket que lo pidió. Lo típico es la mediana (la mitad de
 * los tickets lleva eso o menos); el promedio lo suben los pedidos grandes.
 * Un ticket sin piezas (cantidad 0 o negativa) no cuenta.
 */
export function repartoPorTicket(valores = []) {
  const xs = valores.map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  const n = xs.length;
  const tramos = TRAMOS_POR_TICKET.map((t) => ({ clave: t.clave, etiqueta: t.etiqueta, tickets: 0, piezas: 0 }));
  for (const x of xs) {
    const tramo = tramos[TRAMOS_POR_TICKET.findIndex((t) => x <= t.hasta)];
    tramo.tickets++; tramo.piezas += x;
  }
  const pct = porcentajes(tramos.map((t) => t.tickets));
  const total = xs.reduce((s, x) => s + x, 0);
  const m = n >> 1;
  return {
    tickets: n,
    piezas: piezas(total),
    promedio: promedioPorTicket(total, n),
    tipico: n ? piezas(n % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) : null,
    maximo: n ? piezas(xs[n - 1]) : null,
    reparto: tramos.map((t, i) => ({ ...t, piezas: piezas(t.piezas), pct_tickets: pct[i] })),
  };
}

const nuevoTotal = () => ({
  tickets: 0, bruta: 0, descuento: 0, envio_cargo: 0, neta: 0,
  productos: 0, otros: 0, envio_lineas: 0,
  sin_registro: { ventas: 0, monto: 0 },
  sin_repartir: { ventas: 0, monto: 0 },
  repartido: 0,
  lineas_sin_menu: { lineas: 0, monto: 0 },
});

/**
 * Recorre las ventas de todas las fuentes y acumula. `completo` = también
 * opciones, combinaciones, pares y franjas (el periodo anterior solo necesita
 * productos y totales).
 */
function acumular(fuentes, que, filtros, llaves, { completo = true } = {}) {
  const t = nuevoTotal();
  const productos = new Map();
  const categorias = new Map();
  const grupos = new Map();
  const combinaciones = new Map(); // llave de producto → Map firma → { texto, veces }
  const conOpciones = new Map(); // llave de producto → { veces, sin_opciones }
  const pares = new Map();
  const franjas = new Map(FRANJAS.map((f) => [f.clave, { tickets: 0, venta: 0, productos: new Map() }]));
  const canalesVistos = new Map();
  const porSucursal = new Map();
  const fuera = { cancelado: 0, por_cobrar: 0, sin_consumo: 0 };

  for (const fuente of fuentes) {
    const datosFuente = fuente[que];
    if (!datosFuente) continue;
    const catalogo = fuente._catalogo;
    const lineasPorFolio = datosFuente.lineas instanceof Map ? datosFuente.lineas : new Map();
    const suc = porSucursal.get(fuente.negocio.id) || {
      negocio: fuente.negocio, tickets: 0, neta: 0, productos: 0, otros: 0, envios: 0, sin_desglose: 0, descuentos: 0,
    };
    porSucursal.set(fuente.negocio.id, suc);
    for (const fila of datosFuente.ventas || []) {
      const datos = fila?.datos && typeof fila.datos === 'object' ? fila.datos : {};
      const clase = clasificarPedido({ folio: fila?.folio, estado: fila?.estado, datos });
      if (clase !== 'venta') { fuera[clase]++; continue; }
      const canal = canalDeVenta(datos);
      if (!canalesVistos.has(canal.clave)) canalesVistos.set(canal.clave, canal.etiqueta);
      const local = fechaYHoraLocal(fila.creado_at, fuente.tz);
      const dia = local ? new Date(`${local.fecha}T00:00:00Z`).getUTCDay() : null;
      const franja = local ? franjaDeHora(local.hora) : 'otras';
      if (filtros.canal && canal.clave !== filtros.canal) continue;
      if (filtros.modalidad && modalidadDe(datos) !== filtros.modalidad) continue;
      if (filtros.dia !== null && filtros.dia !== undefined && dia !== filtros.dia) continue;
      if (filtros.franja && franja !== filtros.franja) continue;

      const imp = importesDePedido(datos);
      t.tickets++; t.bruta += imp.bruta; t.descuento += imp.descuento; t.envio_cargo += imp.envio; t.neta += imp.neta;
      suc.tickets++; suc.neta += imp.neta; suc.descuentos += imp.descuento; suc.envios += imp.envio;
      const fr = franjas.get(franja);
      fr.tickets++;

      const lineas = fila.registro === 'vigente' ? (lineasPorFolio.get(fila.folio) || []) : null;
      if (!lineas) {
        t.sin_registro.ventas++; t.sin_registro.monto += imp.bruta;
        suc.sin_desglose += imp.bruta;
        continue;
      }
      const importes = lineas.map((l) => Math.round((Number(l.cantidad) || 0) * (Number(l.precio_unitario) || 0) * 100));
      const delMenu = lineas.map((l) => (l.producto_id !== null && l.producto_id !== undefined ? catalogo.get(Number(l.producto_id)) || null : null));
      const deEnvio = lineas.map((l, i) => l.tipo === 'envio' || (delMenu[i] ? delMenu[i].es_envio : esNombreDeEnvio(l.nombre)));
      const deProducto = lineas.map((l, i) => !deEnvio[i] && TIPOS_DE_PRODUCTO.has(l.tipo));
      const suma = importes.reduce((s, x) => s + x, 0);
      const base = importes.map((x, i) => (deProducto[i] && x > 0 ? x : 0));
      const { partes, sinRepartir } = repartirProporcional(base, imp.bruta - suma);
      if (sinRepartir) { t.sin_repartir.ventas++; t.sin_repartir.monto += sinRepartir; suc.sin_desglose += sinRepartir; }
      const enEsteTicket = new Set();
      lineas.forEach((l, i) => {
        const monto = importes[i] + partes[i];
        if (deEnvio[i]) { t.envio_lineas += monto; suc.envios += monto; return; }
        if (!deProducto[i]) { t.otros += monto; suc.otros += monto; return; }
        t.productos += monto; t.repartido += partes[i]; suc.productos += monto;
        const prod = delMenu[i];
        if (!prod) { t.lineas_sin_menu.lineas++; t.lineas_sin_menu.monto += monto; }
        const llave = llaves.producto(l, prod);
        const cantidad = Number(l.cantidad) || 0;
        let p = productos.get(llave);
        if (!p) {
          p = {
            clave: llave, nombres: new Map(), categoria: prod?.categoria || null, categoria_clave: llaves.categoria(prod),
            tipo: prod ? prod.tipo : l.tipo, ligado: !!prod, menu: prod || null, unidades: 0, venta: 0, repartido: 0,
            folios: new Set(), sucursales: new Set(),
          };
          productos.set(llave, p);
        }
        const nombre = prod ? prod.nombre : String(l.nombre || 'Sin nombre');
        p.nombres.set(nombre, (p.nombres.get(nombre) || 0) + 1);
        if (prod && !p.ligado) { p.ligado = true; p.categoria = prod.categoria; }
        if (prod) p.menu = prod;
        p.unidades += cantidad; p.venta += monto; p.repartido += partes[i];
        p.folios.add(`${fuente.negocio.id}|${fila.folio}`); p.sucursales.add(fuente.negocio.nombre);
        enEsteTicket.add(llave);

        const ck = p.categoria_clave;
        const c = categorias.get(ck) || { clave: ck, nombre: prod?.categoria || null, orden: prod?.categoria_orden ?? 9999, unidades: 0, venta: 0, folios: new Set(), productos: new Set(), porTicket: new Map() };
        if (!c.nombre && prod?.categoria) c.nombre = prod.categoria;
        const ticket = `${fuente.negocio.id}|${fila.folio}`;
        c.unidades += cantidad; c.venta += monto; c.folios.add(ticket); c.productos.add(llave);
        c.porTicket.set(ticket, (c.porTicket.get(ticket) || 0) + cantidad);
        categorias.set(ck, c);

        if (!completo) return;
        const fp = fr.productos.get(llave) || { unidades: 0, venta: 0 };
        fp.unidades += cantidad; fp.venta += monto;
        fr.productos.set(llave, fp);
        fr.venta += monto;

        const mods = Array.isArray(l.modificadores) ? [...l.modificadores].sort((a, b) => (a.orden || 0) - (b.orden || 0)) : [];
        const co = conOpciones.get(llave) || { veces: 0, sin_opciones: 0 };
        co.veces += cantidad;
        if (!mods.length) { co.sin_opciones += cantidad; conOpciones.set(llave, co); return; }
        conOpciones.set(llave, co);
        const textos = [];
        for (const m of mods) {
          const gk = llaves.grupo(llave, m);
          const g = grupos.get(gk) || { clave: gk, producto: llave, nombres: new Map(), veces: 0, extras: 0, opciones: new Map() };
          const gnombre = String(m.grupo || 'Opciones');
          g.nombres.set(gnombre, (g.nombres.get(gnombre) || 0) + 1);
          const veces = cantidad * (Number(m.cantidad) || 1);
          const extras = Math.round(veces * (Number(m.precio_extra) || 0) * 100);
          g.veces += veces; g.extras += extras;
          const ok = llaves.opcion(m);
          const o = g.opciones.get(ok) || { clave: ok, nombres: new Map(), veces: 0, extras: 0, estimado: false, sin_clasificar: 0 };
          const onombre = String(m.opcion || '?');
          o.nombres.set(onombre, (o.nombres.get(onombre) || 0) + 1);
          o.veces += veces; o.extras += extras;
          if (m.precio_estimado) o.estimado = true;
          if (m.clasificado === false) o.sin_clasificar += veces;
          g.opciones.set(ok, o);
          grupos.set(gk, g);
          const n = Number(m.cantidad) || 1;
          textos.push({ llave: `${normalizarTexto(gnombre)}:${normalizarTexto(onombre)}:${n}`, grupo: gnombre, opcion: `${onombre}${n !== 1 ? ` ×${n}` : ''}` });
        }
        const firma = textos.map((x) => x.llave).join('|');
        const porFirma = combinaciones.get(llave) || new Map();
        const cmb = porFirma.get(firma) || { texto: textoDeCombinacion(textos), veces: 0 };
        cmb.veces += cantidad;
        porFirma.set(firma, cmb);
        combinaciones.set(llave, porFirma);
      });
      if (completo && enEsteTicket.size > 1) {
        const lista = [...enEsteTicket].sort();
        for (let a = 0; a < lista.length; a++) {
          for (let b = a + 1; b < lista.length; b++) {
            const k = `${lista[a]}\u0000${lista[b]}`;
            pares.set(k, (pares.get(k) || 0) + 1);
          }
        }
      }
    }
  }
  return { t, productos, categorias, grupos, combinaciones, conOpciones, pares, franjas, canalesVistos, porSucursal, fuera };
}

const masUsado = (mapa, otro = '') => {
  let mejor = otro, n = -1;
  for (const [k, v] of mapa) if (v > n) { mejor = k; n = v; }
  return mejor;
};
const cambioPct = (actual, anterior) => (anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null);

/**
 * El reporte completo con ventas ya leídas. Función pura: la usa
 * obtenerReporteProductos y la prueban las suites sin base.
 *   fuentes: [{ negocio: { id, nombre }, tz,
 *               actual:   { ventas: [{ folio, estado, creado_at, datos, registro }],
 *                           lineas: Map folio → [{ producto_id, nombre, tipo, cantidad, precio_unitario, modificadores }] },
 *               anterior: { ventas, lineas } | null,
 *               catalogo: [{ id, nombre, tipo, opciones, disponible, categoria_id, categoria, categoria_activa, categoria_orden }] }]
 *   registro: 'vigente' | 'viejo' | 'sin'.
 */
export function construirReporteProductos({ fuentes = [], filtros = {}, minimo = MINIMO_SIN_MOVIMIENTO } = {}) {
  const multi = fuentes.length > 1;
  const llaves = crearLlaves(multi);
  const f = { canal: filtros.canal || null, modalidad: filtros.modalidad || null, dia: filtros.dia ?? null, franja: filtros.franja || null };
  for (const fuente of fuentes) fuente._catalogo = indexarCatalogo(fuente.catalogo);
  const act = acumular(fuentes, 'actual', f, llaves, { completo: true });
  const ant = acumular(fuentes, 'anterior', f, llaves, { completo: false });
  const { t } = act;

  const nombreProducto = (llave) => {
    const p = act.productos.get(llave);
    return p ? masUsado(p.nombres, 'Sin nombre') : (ant.productos.get(llave) ? masUsado(ant.productos.get(llave).nombres) : 'Sin nombre');
  };

  // 3.1 Productos.
  const listaProd = [...act.productos.values()]
    .sort((a, b) => b.venta - a.venta || b.unidades - a.unidades || masUsado(a.nombres).localeCompare(masUsado(b.nombres), 'es'));
  const pctVenta = porcentajes(listaProd.map((p) => Math.max(0, p.venta)));
  const productos = listaProd.map((p, i) => {
    const previo = ant.productos.get(p.clave);
    return {
      clave: p.clave, nombre: masUsado(p.nombres, 'Sin nombre'),
      categoria: p.categoria || 'Sin categoría', tipo: p.tipo, ligado_al_menu: p.ligado,
      unidades: piezas(p.unidades), venta: pesos(p.venta), pct_venta: pctVenta[i],
      precio_promedio: p.unidades > 0 ? pesos(p.venta / p.unidades) : null,
      tickets: p.folios.size, por_ticket: promedioPorTicket(p.unidades, p.folios.size), repartido: pesos(p.repartido),
      unidades_anterior: previo ? piezas(previo.unidades) : 0,
      venta_anterior: previo ? pesos(previo.venta) : 0,
      cambio_pct: cambioPct(p.venta, previo ? previo.venta : 0),
      ...(multi ? { sucursales: [...p.sucursales].sort((a, b) => a.localeCompare(b, 'es')) } : {}),
    };
  });
  // Lo que se vendió el periodo anterior y en este no: cambio −100 %.
  const sinVentaAhora = [...ant.productos.values()].filter((p) => !act.productos.has(p.clave))
    .sort((a, b) => b.venta - a.venta)
    .map((p) => ({ clave: p.clave, nombre: masUsado(p.nombres, 'Sin nombre'), unidades_anterior: piezas(p.unidades), venta_anterior: pesos(p.venta) }));

  // 3.2 Categorías.
  const listaCat = [...act.categorias.values()].sort((a, b) => b.venta - a.venta || a.orden - b.orden);
  const pctCat = porcentajes(listaCat.map((c) => Math.max(0, c.venta)));
  const categorias = listaCat.map((c, i) => {
    // La columna y el reparto salen de la MISMA cuenta, para que nunca digan
    // cosas distintas.
    const reparto = repartoPorTicket([...c.porTicket.values()]);
    return {
      clave: c.clave, nombre: c.nombre || 'Sin categoría (no ligado al menú)',
      unidades: piezas(c.unidades), venta: pesos(c.venta), pct_venta: pctCat[i], tickets: c.folios.size,
      por_ticket: reparto.promedio, reparto_por_ticket: reparto,
      productos: [...c.productos],
    };
  });

  // 3.3 Opciones (modificadores) por grupo.
  const modificadores = [...act.grupos.values()]
    .sort((a, b) => b.veces - a.veces || nombreProducto(a.producto).localeCompare(nombreProducto(b.producto), 'es'))
    .map((g) => {
      const opciones = [...g.opciones.values()].sort((a, b) => b.veces - a.veces || masUsado(a.nombres).localeCompare(masUsado(b.nombres), 'es'));
      const pct = porcentajes(opciones.map((o) => Math.round(o.veces * 100)));
      return {
        clave: g.clave, producto: g.producto, producto_nombre: nombreProducto(g.producto),
        grupo: masUsado(g.nombres, 'Opciones'), veces: piezas(g.veces), extras: pesos(g.extras),
        opciones: opciones.map((o, i) => ({
          clave: o.clave, opcion: masUsado(o.nombres, '?'), veces: piezas(o.veces), pct_grupo: pct[i],
          extras: pesos(o.extras), precio_estimado: o.estimado, sin_clasificar: piezas(o.sin_clasificar),
        })),
      };
    });

  // 3.4 Combinaciones por platillo configurable, y pares en el mismo ticket.
  const combinaciones = [...act.combinaciones.entries()]
    .map(([llave, porFirma]) => {
      const co = act.conOpciones.get(llave) || { veces: 0, sin_opciones: 0 };
      const top = [...porFirma.values()].sort((a, b) => b.veces - a.veces || a.texto.localeCompare(b.texto, 'es'));
      return {
        producto: llave, producto_nombre: nombreProducto(llave),
        veces: piezas(co.veces), sin_opciones: piezas(co.sin_opciones), distintas: top.length,
        combinaciones: top.slice(0, TOP_COMBINACIONES).map((c) => ({
          opciones: c.texto, veces: piezas(c.veces),
          pct: co.veces > 0 ? Math.round((c.veces / co.veces) * 1000) / 10 : 0,
        })),
      };
    })
    .sort((a, b) => b.veces - a.veces || a.producto_nombre.localeCompare(b.producto_nombre, 'es'));
  const pares = [...act.pares.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_PARES)
    .map(([k, tickets]) => {
      const [a, b] = k.split('\u0000');
      return {
        productos: [{ clave: a, nombre: nombreProducto(a) }, { clave: b, nombre: nombreProducto(b) }],
        tickets, pct_tickets: t.tickets ? Math.round((tickets / t.tickets) * 1000) / 10 : 0,
      };
    });

  // 3.5 Sin movimiento: productos ACTIVOS del menú (disponibles, de una
  // categoría activa, que son producto y no envío) con menos de `minimo`
  // piezas en el periodo. Con varias sucursales, activo en cualquiera.
  const activos = new Map();
  for (const fuente of fuentes) {
    for (const prod of fuente._catalogo.values()) {
      if (!prod.disponible || !prod.categoria_activa || !TIPOS_DE_PRODUCTO.has(prod.tipo) || prod.es_envio) continue;
      const llave = llaves.producto({ nombre: prod.nombre, producto_id: prod.id }, prod);
      const a = activos.get(llave) || { clave: llave, nombre: prod.nombre, categoria: prod.categoria || 'Sin categoría', sucursales: new Set() };
      a.sucursales.add(fuente.negocio.nombre);
      activos.set(llave, a);
    }
  }
  const sinMovimiento = [...activos.values()]
    .map((a) => {
      const p = act.productos.get(a.clave);
      return {
        clave: a.clave, nombre: a.nombre, categoria: a.categoria,
        unidades: p ? piezas(p.unidades) : 0, venta: p ? pesos(p.venta) : 0, tickets: p ? p.folios.size : 0,
        ...(multi ? { sucursales: [...a.sucursales].sort((x, y) => x.localeCompare(y, 'es')) } : {}),
      };
    })
    .filter((x) => x.unidades < minimo)
    .sort((a, b) => a.unidades - b.unidades || a.nombre.localeCompare(b.nombre, 'es'));
  // Para que los conteos cuadren en pantalla (revisión del 25-nov-2026):
  //   activos = activos que vendieron algo + activos sin ninguna venta
  //   productos vendidos = activos que vendieron algo + vendidos que hoy ya no están activos
  let activosConVenta = 0;
  for (const a of activos.values()) if (act.productos.has(a.clave)) activosConVenta++;
  const motivoInactivo = (p) => {
    if (!p.ligado || !p.menu) return 'sin_menu';
    if (!p.menu.disponible) return 'no_disponible';
    if (!p.menu.categoria_activa) return 'categoria_oculta';
    return 'no_es_producto';
  };
  const vendidosNoActivos = listaProd.filter((p) => !activos.has(p.clave))
    .map((p) => ({ clave: p.clave, nombre: masUsado(p.nombres, 'Sin nombre'), unidades: piezas(p.unidades), venta: pesos(p.venta), motivo: motivoInactivo(p) }));

  // 3.6 Los más vendidos de cada franja: por venta (lo que se ve primero) y
  // por piezas (el selector de la pantalla). Revisión del 25-nov-2026: por
  // piezas, un taco de $25 quedaba arriba de unos chilaquiles de $200.
  const porFranja = FRANJAS.map((fr) => {
    const x = act.franjas.get(fr.clave);
    const lista = [...x.productos.entries()].map(([llave, v]) => ({ llave, nombre: nombreProducto(llave), u: v.unidades, v: v.venta }));
    const top = (orden) => lista.slice().sort(orden).slice(0, TOP_POR_FRANJA)
      .map((p) => ({ clave: p.llave, nombre: p.nombre, unidades: piezas(p.u), venta: pesos(p.v) }));
    const porVenta = top((a, b) => b.v - a.v || b.u - a.u || a.nombre.localeCompare(b.nombre, 'es'));
    return {
      franja: fr.clave, etiqueta: fr.etiqueta, tickets: x.tickets, venta: pesos(x.venta),
      productos: porVenta,
      productos_por_piezas: top((a, b) => b.u - a.u || b.v - a.v || a.nombre.localeCompare(b.nombre, 'es')),
    };
  });

  const sinDesglose = t.sin_registro.monto + t.sin_repartir.monto;
  const envios = t.envio_cargo + t.envio_lineas;
  const cuadre = {
    productos: pesos(t.productos),
    otros: pesos(t.otros),
    envios: pesos(envios),
    envios_cobrados: pesos(t.envio_cargo),
    envios_en_productos: pesos(t.envio_lineas),
    sin_desglose: pesos(sinDesglose),
    sin_registro: { ventas: t.sin_registro.ventas, monto: pesos(t.sin_registro.monto) },
    sin_repartir: { ventas: t.sin_repartir.ventas, monto: pesos(t.sin_repartir.monto) },
    descuentos: pesos(t.descuento),
    venta_neta: pesos(t.neta),
    tickets: t.tickets,
    cuadra: t.productos + t.otros + envios + sinDesglose - t.descuento === t.neta,
    repartido: pesos(t.repartido),
    lineas_sin_menu: { lineas: t.lineas_sin_menu.lineas, monto: pesos(t.lineas_sin_menu.monto) },
    con_filtros: hayFiltros(f),
  };

  return {
    cuadre,
    comparacion: {
      productos: pesos(ant.t.productos), venta_neta: pesos(ant.t.neta), tickets: ant.t.tickets,
      cambio_pct: cambioPct(t.productos, ant.t.productos),
    },
    fuera_del_reporte: act.fuera,
    productos,
    sin_venta_ahora: sinVentaAhora,
    categorias,
    modificadores,
    combinaciones,
    pares,
    sin_movimiento: {
      minimo, productos: sinMovimiento, activos: activos.size,
      activos_con_venta: activosConVenta, activos_sin_venta: activos.size - activosConVenta,
      vendidos_no_activos: vendidosNoActivos,
    },
    por_franja: porFranja,
    por_sucursal: [...act.porSucursal.values()].map((s) => ({
      negocio: s.negocio, tickets: s.tickets, venta_neta: pesos(s.neta), productos: pesos(s.productos),
      otros: pesos(s.otros), envios: pesos(s.envios), sin_desglose: pesos(s.sin_desglose), descuentos: pesos(s.descuentos),
      cuadra: s.productos + s.otros + s.envios + s.sin_desglose - s.descuentos === s.neta,
    })),
    filtros_disponibles: {
      canales: [...act.canalesVistos.entries()].map(([clave, etiqueta]) => ({ clave, etiqueta }))
        .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es')),
      modalidades: MODALIDADES.map((m) => ({ ...m })),
      dias: ORDEN_SEMANA.map((d) => ({ clave: d, etiqueta: DIAS_SEMANA[d] })),
      franjas: FRANJAS.map((x) => ({ clave: x.clave, etiqueta: x.etiqueta })),
    },
    filtros: f,
  };
}

// ─── Lectura ────────────────────────────────────────────────────────────────

// La MISMA firma que calcula lineasEstructuradasProceso.js (ventasPendientes):
// un registro es vigente si se hizo con los artículos que la venta tiene hoy.
const FIRMA_VIGENTE = `'${VERSION_REGISTRO}:' || md5(COALESCE(pa.datos->'items', '[]'::jsonb)::text)`;

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  return negocioId.trim();
}

async function hayTabla(db, nombre) {
  const { rows: [r] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.${nombre}`]);
  return r.hay;
}

/** ¿Está encendido el reporte de Productos en este negocio? */
export async function banderaReportesProductos(negocioId, db = pool) {
  const { rows } = await db.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [exigirNegocio(negocioId), BANDERA_REPORTES_PRODUCTOS]);
  return String(rows[0]?.valor ?? '').trim() === 'true';
}

// Ventas de UN negocio entre dos días operativos (inclusive) de su zona, con
// lo que la definición de venta necesita y si su registro de líneas es vigente.
// Cadenas ISO, nunca Date: created_at es `timestamp` sin zona. `finUtc`
// corta antes del fin del último día (la comparación a la misma hora).
async function leerVentas(db, nid, desde, hasta, tz, conRegistro, finUtc = null) {
  const inicio = rangoUtcDeFecha(desde, tz).inicio;
  const fin = finUtc || rangoUtcDeFecha(hasta, tz).fin;
  const { rows } = await db.query(`
    SELECT pa.folio, pa.estado, (pa.created_at AT TIME ZONE 'UTC') AS creado_at,
           jsonb_build_object(
             'total', pa.datos->'total', 'subtotal', pa.datos->'subtotal',
             'costo_envio', pa.datos->'costo_envio', 'descuento', pa.datos->'descuento',
             'forma_pago', pa.datos->'forma_pago', 'pago_confirmado', pa.datos->'pago_confirmado',
             'canal', pa.datos->'canal', 'modalidad', pa.datos->'modalidad', 'items', pa.datos->'items'
           ) AS datos,
           ${conRegistro
    ? `CASE WHEN h.folio IS NULL THEN 'sin' WHEN h.firma = ${FIRMA_VIGENTE} THEN 'vigente' ELSE 'viejo' END`
    : `'sin'`} AS registro
      FROM pedidos_activos pa
      ${conRegistro ? `LEFT JOIN pedido_lineas_pedidos h ON h.negocio_id = pa.negocio_id AND h.folio = pa.folio AND h.origen = 'venta'` : ''}
     WHERE pa.negocio_id = $1 AND pa.created_at >= $2 AND pa.created_at < $3
     ORDER BY pa.created_at, pa.folio
  `, [nid, inicio.toISOString(), fin.toISOString()]);
  return rows;
}

// Las líneas (y, si se piden, sus opciones) de las ventas del periodo con
// registro vigente, del MISMO negocio.
async function leerLineas(db, nid, desde, hasta, tz, { conOpciones, finUtc = null }) {
  const inicio = rangoUtcDeFecha(desde, tz).inicio.toISOString();
  const fin = (finUtc || rangoUtcDeFecha(hasta, tz).fin).toISOString();
  const desdeVentas = (conMods) => `
      FROM pedidos_activos pa
      JOIN pedido_lineas_pedidos h ON h.negocio_id = pa.negocio_id AND h.folio = pa.folio
                                  AND h.origen = 'venta' AND h.firma = ${FIRMA_VIGENTE}
      JOIN pedido_lineas l ON l.negocio_id = h.negocio_id AND l.folio = h.folio
      ${conMods ? 'JOIN pedido_linea_modificadores m ON m.linea_id = l.id AND m.negocio_id = l.negocio_id' : ''}
     WHERE pa.negocio_id = $1 AND pa.created_at >= $2 AND pa.created_at < $3`;
  const { rows: lineas } = await db.query(`
    SELECT l.id, l.folio, l.linea, l.producto_id, l.nombre, l.tipo,
           l.cantidad::float8 AS cantidad, l.precio_unitario::float8 AS precio_unitario
    ${desdeVentas(false)}
     ORDER BY l.folio, l.linea`, [nid, inicio, fin]);
  const porId = new Map();
  const porFolio = new Map();
  for (const l of lineas) {
    const linea = { ...l, modificadores: [] };
    porId.set(String(l.id), linea);
    if (!porFolio.has(l.folio)) porFolio.set(l.folio, []);
    porFolio.get(l.folio).push(linea);
  }
  if (conOpciones && lineas.length) {
    const { rows: mods } = await db.query(`
      SELECT m.linea_id, m.orden, m.grupo_id, m.grupo, m.opcion_id, m.opcion,
             m.cantidad::float8 AS cantidad, m.precio_extra::float8 AS precio_extra, m.precio_estimado, m.clasificado
      ${desdeVentas(true)}
       ORDER BY m.linea_id, m.orden`, [nid, inicio, fin]);
    for (const m of mods) porId.get(String(m.linea_id))?.modificadores.push(m);
  }
  return porFolio;
}

/** El menú de ESE negocio con su categoría. `tipo` por to_jsonb: sin la 161 todo es «platillo». */
async function leerCatalogo(db, nid) {
  const { rows } = await db.query(`
    SELECT p.id, p.nombre, to_jsonb(p)->>'tipo' AS tipo, p.opciones, p.disponible, p.categoria_id,
           c.nombre AS categoria, c.activa AS categoria_activa, c.orden AS categoria_orden
      FROM menu_productos p
      LEFT JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
     WHERE p.negocio_id = $1`, [nid]);
  return rows;
}

async function leerFuente(db, negocio, { desde, hasta, anterior, corte, tz, conRegistro }) {
  const nid = exigirNegocio(negocio?.id);
  const finAnt = corte ? corte.fin : null;
  const [ventas, lineas, ventasAnt, lineasAnt, catalogo] = await Promise.all([
    leerVentas(db, nid, desde, hasta, tz, conRegistro),
    conRegistro ? leerLineas(db, nid, desde, hasta, tz, { conOpciones: true }) : new Map(),
    leerVentas(db, nid, anterior.desde, anterior.hasta, tz, conRegistro, finAnt),
    conRegistro ? leerLineas(db, nid, anterior.desde, anterior.hasta, tz, { conOpciones: false, finUtc: finAnt }) : new Map(),
    leerCatalogo(db, nid),
  ]);
  return {
    negocio: { id: nid, nombre: negocio.nombre || '' }, tz, catalogo,
    actual: { ventas, lineas }, anterior: { ventas: ventasAnt, lineas: lineasAnt },
  };
}

/**
 * Reporte de Productos de UNA o varias sucursales entre dos días operativos
 * (inclusive). negocios: [{ id, nombre, tz }] — cada uno se lee con su propio
 * negocio_id y su zona; quién puede ver cuáles lo decide la ruta. `ahora` solo
 * lo cambian las pruebas: decide si el rango incluye hoy (corteDelPeriodoAnterior).
 */
export async function obtenerReporteProductos({ negocios = [], desde, hasta, filtros = {}, minimo = MINIMO_SIN_MOVIMIENTO, db = pool, ahora = new Date() } = {}) {
  if (!Array.isArray(negocios) || !negocios.length) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  for (const n of negocios) {
    exigirNegocio(n?.id);
    if (!esZonaValida(n.tz)) { const e = new Error('zona horaria inválida'); e.code = 'ZONA_INVALIDA'; throw e; }
  }
  if (!esFechaValida(desde) || !esFechaValida(hasta) || desde > hasta) {
    const e = new Error('rango inválido'); e.code = 'RANGO_INVALIDO'; throw e;
  }
  const anterior = periodoAnterior(desde, hasta);
  // Cada sucursal se corta con SU reloj; la etiqueta, con el de la primera.
  const cortes = negocios.map((n) => corteDelPeriodoAnterior({ desde, hasta, anterior, ahora, tz: n.tz }));
  const conRegistro = await hayTabla(db, 'pedido_lineas_pedidos');
  const fuentes = await Promise.all(negocios.map((n, i) => leerFuente(db, n, { desde, hasta, anterior, corte: cortes[i], tz: n.tz, conRegistro })));
  const reporte = construirReporteProductos({ fuentes, filtros, minimo });
  const corte = cortes[0];
  return {
    rango: { desde, hasta },
    periodo_anterior: {
      ...anterior,
      corte: corte ? { fecha: corte.fecha, hora: corte.hora } : null,
      etiqueta_comparacion: etiquetaDeComparacion(anterior, corte),
    },
    registro_disponible: conRegistro,
    ...reporte,
  };
}
