// Reportes → Ventas: UNA sola definición de «venta» para la tarjeta, la tabla
// y el CSV.
//
// Antes la tarjeta y la tabla salían de dos consultas distintas
// (obtenerResumenVentas y obtenerVentas). La de la tarjeta excluía «por
// cobrar» con `forma_pago = 'por_cobrar' AND …`, y en SQL eso da NULL —no
// FALSE— cuando el pedido no trae forma de pago. `NOT NULL` sigue siendo NULL
// y el FILTER lo descarta: los pedidos de Rappi por integración (llegan con
// `pago: 'rappi_pay'` y sin `forma_pago`) salían de la tarjeta y seguían en la
// tabla. Esa era toda la diferencia entre la tarjeta y la tabla (nov-2026).
// Además el navegador cortaba los días con SU reloj, no con la zona del
// negocio.
//
// La definición (la misma que usa la Caja para el corte del día):
//   Una VENTA es un pedido del negocio creado dentro de los días pedidos —en
//   la zona horaria del negocio— que
//     · no está cancelado,
//     · no tiene el cobro pendiente (esPedidoPendienteDeCobro, igual que Caja), y
//     · no es una cuenta de mesa cerrada sin consumo.
//   Su importe es el `total` registrado del pedido: productos − descuentos
//   + envío cobrado. La propina va aparte y no es venta.
//   Venta neta = Σ total. Venta bruta − descuentos + envíos = venta neta,
//   al centavo.
//
// Lo que NO es venta se cuenta aparte en el desglose (cancelados, por cobrar,
// mesas sin consumo) para que se vea qué quedó fuera y por qué.
//
// Diferencia consciente con la Caja: un pago en línea que se confirma un día
// después de creado el pedido la Caja lo reconoce el día del PAGO (es dinero
// de ese día); aquí cuenta el día del PEDIDO, porque un reporte de ventas se
// lee por la fecha de la venta.
import { pool } from './database.js';
import { rangoUtcDeFecha, esFechaValida, esPedidoPendienteDeCobro } from './cortesCaja.js';
import { esZonaValida } from './zonaHoraria.js';

export const REPORTE_VENTAS_MAX_DIAS = 366;
export const VENTAS_POR_PAGINA = 50;

const DIA_MS = 24 * 60 * 60 * 1000;
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
// El reporte lee la semana de lunes a domingo.
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Horas del mapa de calor cuando el periodo no trae ventas que digan otra cosa.
const HORAS_OMISION = Object.freeze({ desde: 6, hasta: 15 });

// Todo se suma en centavos enteros: miles de sumas de flotantes se desvían.
const centavos = (n) => Math.round((Number(n) || 0) * 100);
const pesos = (c) => Math.round(c) / 100;

function numeroO(valor, otro = null) {
  if (valor === null || valor === undefined || valor === '') return otro;
  const n = Number(valor);
  return Number.isFinite(n) ? n : otro;
}

function sumarDias(fecha, dias) {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS) + 1;
}

const diaDeSemana = (fecha) => new Date(`${fecha}T00:00:00Z`).getUTCDay(); // 0 = domingo
const ultimoDiaDelMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12
const dosDigitos = (n) => String(n).padStart(2, '0');

// Fecha y hora LOCALES del negocio de un instante. Un formateador por zona:
// crear uno por pedido cuesta en un mes de 2,000 pedidos.
const formateadores = new Map();
function fechaYHoraLocal(instante, tz) {
  let fmt = formateadores.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    formateadores.set(tz, fmt);
  }
  const t = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(t.getTime())) return null;
  const p = Object.fromEntries(fmt.formatToParts(t).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24 };
}

/**
 * Días del reporte a partir de lo que pide el panel y del «hoy» operativo del
 * negocio (que decide el servidor con la zona del negocio, nunca el
 * navegador). Devuelve { desde, hasta } en AAAA-MM-DD o { error }.
 *   periodo=hoy | semana (desde el domingo, como antes) | mes (desde el día 1)
 *   o desde=AAAA-MM-DD[&hasta=AAAA-MM-DD] (sin hasta: hasta hoy).
 */
export function rangoDeReporte({ periodo, desde, hasta } = {}, hoy) {
  if (!esFechaValida(hoy)) return { error: 'No se pudo determinar el día de hoy del negocio' };
  if (periodo !== undefined && periodo !== null && periodo !== '') {
    switch (String(periodo)) {
      case 'hoy': return { desde: hoy, hasta: hoy };
      case 'semana': {
        const diaSemana = new Date(`${hoy}T00:00:00Z`).getUTCDay(); // 0 = domingo
        return { desde: sumarDias(hoy, -diaSemana), hasta: hoy };
      }
      case 'mes': return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy };
      default: return { error: 'Periodo no válido' };
    }
  }
  const d = typeof desde === 'string' ? desde.trim() : '';
  const h = typeof hasta === 'string' && hasta.trim() ? hasta.trim() : hoy;
  if (!esFechaValida(d) || !esFechaValida(h)) return { error: 'Fechas inválidas: usa AAAA-MM-DD' };
  if (d > h) return { error: 'La fecha inicial es posterior a la final' };
  if (diasEntre(d, h) > REPORTE_VENTAS_MAX_DIAS) {
    return { error: `El rango máximo es de ${REPORTE_VENTAS_MAX_DIAS} días` };
  }
  return { desde: d, hasta: h };
}

/**
 * Página de transacciones pedida: entero ≥ 1 (sin valor = 1). `todas` (para
 * el CSV) trae todos los renglones. Devuelve { pagina, todas } o { error }.
 */
export function paginaDeReporte({ pagina, todas } = {}) {
  const todasSi = todas === true || todas === '1' || todas === 'true';
  if (pagina === undefined || pagina === null || pagina === '') return { pagina: 1, todas: todasSi };
  const t = String(pagina).trim();
  if (!/^\d{1,6}$/.test(t) || Number(t) < 1) return { error: 'Página no válida' };
  return { pagina: Number(t), todas: todasSi };
}

/**
 * El periodo con el que se compara, del mismo largo y justo antes:
 *   · un mes completo → el mes anterior completo («septiembre»);
 *   · del día 1 a un día del mes → los mismos días del mes anterior
 *     («1 al 12 de octubre»), recortado si ese mes es más corto;
 *   · cualquier otro rango → los N días inmediatamente anteriores.
 */
export function periodoAnterior(desde, hasta) {
  if (!esFechaValida(desde) || !esFechaValida(hasta) || desde > hasta) return null;
  const [y1, m1, d1] = desde.split('-').map(Number);
  const [y2, m2, d2] = hasta.split('-').map(Number);
  const otroAnio = (y) => (y !== y2 ? ` de ${y}` : '');
  if (d1 === 1 && y1 === y2 && m1 === m2) {
    const py = m1 === 1 ? y1 - 1 : y1;
    const pm = m1 === 1 ? 12 : m1 - 1;
    const ultimo = ultimoDiaDelMes(py, pm);
    const pDesde = `${py}-${dosDigitos(pm)}-01`;
    if (d2 === ultimoDiaDelMes(y2, m2)) {
      return { desde: pDesde, hasta: `${py}-${dosDigitos(pm)}-${dosDigitos(ultimo)}`, etiqueta: `${MESES[pm - 1]}${otroAnio(py)}` };
    }
    const fin = Math.min(d2, ultimo);
    return {
      desde: pDesde, hasta: `${py}-${dosDigitos(pm)}-${dosDigitos(fin)}`,
      etiqueta: fin === 1 ? `1 de ${MESES[pm - 1]}${otroAnio(py)}` : `1 al ${fin} de ${MESES[pm - 1]}${otroAnio(py)}`,
    };
  }
  const n = diasEntre(desde, hasta);
  const pHasta = sumarDias(desde, -1);
  const pDesde = sumarDias(desde, -n);
  const corta = (f) => { const [y, m, d] = f.split('-'); return `${d}/${m}${Number(y) !== y2 ? '/' + y : ''}`; };
  return { desde: pDesde, hasta: pHasta, etiqueta: n === 1 ? corta(pHasta) : `${corta(pDesde)} al ${corta(pHasta)}` };
}

// La marca de pago se lee como la lee la Caja: booleano o texto 'true'/'false';
// cualquier otra cosa (incluida su ausencia en pedidos viejos) es «sin marca».
function marcaDePago(valor) {
  if (valor === true || valor === false) return valor;
  const t = String(valor ?? '').trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

const itemsDe = (datos) => (Array.isArray(datos?.items) ? datos.items : []);

/**
 * ¿Qué es este pedido para el reporte? 'venta' | 'cancelado' | 'por_cobrar'
 * | 'sin_consumo'. El orden importa: un cancelado nunca es «por cobrar».
 */
export function clasificarPedido({ folio, estado, datos } = {}) {
  const d = datos && typeof datos === 'object' ? datos : {};
  if (String(estado || '').trim().toLowerCase() === 'cancelado') return 'cancelado';
  // Cuenta de mesa cerrada sin un solo producto ni importe: se abrió por
  // error o se canceló todo. La cortesía (productos al 100 % de descuento)
  // conserva sus productos y sí es venta, en $0.
  if (/^RM-/i.test(String(folio || '')) && centavos(d.total) === 0 && itemsDe(d).length === 0) {
    return 'sin_consumo';
  }
  if (esPedidoPendienteDeCobro({ estado, forma_pago: d.forma_pago, pago_confirmado: marcaDePago(d.pago_confirmado) })) {
    return 'por_cobrar';
  }
  return 'venta';
}

/**
 * Importes de un pedido, en centavos. Siempre cuadra:
 *   bruta − descuento + envio = neta
 * `neta` es el total registrado (lo que la tabla y el CSV llaman Total).
 * `bruta` es el subtotal de productos que guardó el pedido; si no lo guardó,
 * la suma de sus renglones. El descuento es lo que va de bruta + envío al
 * total, así que nunca se cuenta dos veces ni se inventa.
 * `descuento_plataforma`: descuento que la plataforma (Rappi) informa pero
 * que NO está restado del total que registró; se muestra aparte, no suma.
 */
export function importesDePedido(datos = {}) {
  const d = datos && typeof datos === 'object' ? datos : {};
  const neta = centavos(d.total);
  const envio = Math.max(0, centavos(d.costo_envio));
  let bruta = null;
  const subtotal = numeroO(d.subtotal);
  if (subtotal !== null && subtotal >= 0) bruta = centavos(subtotal);
  else {
    const items = itemsDe(d);
    if (items.length && items.every(i => numeroO(i?.precio_unitario) !== null)) {
      bruta = items.reduce((s, i) =>
        s + centavos(numeroO(i.precio_unitario) * Math.max(1, numeroO(i?.cantidad, 1))), 0);
    }
  }
  // Sin subtotal ni precios, o con un total mayor que productos + envío (un
  // cargo que no se desglosó): la bruta se iguala a lo cobrado sin envío y no
  // hay descuento que mostrar. Así el desglose nunca da descuentos negativos.
  if (bruta === null || bruta + envio < neta) bruta = Math.max(0, neta - envio);
  const descuento = bruta + envio - neta;
  const informado = Math.max(0, centavos(d.descuento));
  const descuentoPlataforma = String(d.canal || '') === 'rappi' ? Math.max(0, informado - descuento) : 0;
  return { bruta, descuento, envio, neta, descuento_plataforma: descuentoPlataforma };
}

/** Propina del pedido (centavos). No es venta: va aparte del total. */
function propinaDe(datos = {}) {
  const pagos = Array.isArray(datos?.pagos) ? datos.pagos : [];
  if (pagos.length) return pagos.reduce((s, p) => s + Math.max(0, centavos(p?.propina)), 0);
  return Math.max(0, centavos(numeroO(datos?.propinas, numeroO(datos?.propina, 0))));
}

function formaPagoVisible(datos) {
  const f = String(datos?.forma_pago ?? '').trim();
  if (f) return f;
  // Rappi por integración llega con pago 'rappi_pay' y sin forma de pago.
  if (String(datos?.canal || '') === 'rappi') return 'rappi';
  return 'no especificado';
}

// La MISMA regla cuenta la tarjeta «Domicilios» y decide qué pedidos entran a
// «Colonias con más envíos»: las dos cifras no pueden diferir.
const esDomicilioDelReporte = (datos) => String(datos?.modalidad || '').toLowerCase().includes('domicilio');

function contarModalidad(cont, datos) {
  const m = String(datos?.modalidad || '').toLowerCase();
  if (esDomicilioDelReporte(datos)) cont.domicilios++;
  if (m.includes('recoger') || m.includes('tienda')) cont.recoger++;
  if (m === 'mesa' || datos?.canal === 'restaurante_mesa') cont.restaurante++;
}

/**
 * Porcentajes con un decimal que suman EXACTAMENTE 100 (método del mayor
 * residuo): redondear cada uno por su cuenta da 99.9 % o 100.1 % y en un
 * reporte de dueño eso se lee como un error. valores: enteros ≥ 0.
 */
export function porcentajes(valores = []) {
  const v = valores.map(x => Math.max(0, Math.round(Number(x) || 0)));
  const total = v.reduce((s, x) => s + x, 0);
  if (total <= 0) return v.map(() => 0);
  const exactos = v.map(x => (x * 1000) / total); // en décimas de punto
  const pisos = exactos.map(Math.floor);
  let faltan = 1000 - pisos.reduce((s, x) => s + x, 0);
  const orden = exactos.map((x, i) => [x - pisos[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; faltan > 0; k++, faltan--) pisos[orden[k][1]]++;
  return pisos.map(p => p / 10);
}

// ─── Por canal ──────────────────────────────────────────────────────────────
// De dónde vino cada venta, con las palabras que ya usa el panel
// (canalCortoPedido): «pos» (envíos capturados en el POS) y «presencial»
// (mostrador) son los dos el Mostrador.
const CANALES = Object.freeze({
  whatsapp: ['whatsapp', 'WhatsApp'],
  pos: ['mostrador', 'Mostrador'],
  presencial: ['mostrador', 'Mostrador'],
  restaurante_mesa: ['restaurante', 'Restaurante (mesas)'],
  tienda_online: ['tienda_online', 'Tienda en línea'],
  rappi: ['rappi', 'Rappi'],
  voz: ['llamada', 'Llamada'],
  test: ['prueba', 'Prueba'],
  prueba_admin: ['prueba', 'Prueba'],
});

/** { clave, etiqueta } del canal de una venta. Un canal desconocido se muestra tal cual. */
export function canalDeVenta(datos = {}) {
  const crudo = String(datos?.canal ?? '').trim().toLowerCase().slice(0, 40);
  const conocido = Object.prototype.hasOwnProperty.call(CANALES, crudo) ? CANALES[crudo] : null;
  if (conocido) return { clave: conocido[0], etiqueta: conocido[1] };
  if (!crudo) {
    // Cuentas de mesa viejas sin canal: la modalidad dice que son del restaurante.
    if (String(datos?.modalidad || '').toLowerCase() === 'mesa') return { clave: 'restaurante', etiqueta: 'Restaurante (mesas)' };
    return { clave: 'sin_canal', etiqueta: 'Sin canal registrado' };
  }
  return { clave: `otro:${crudo}`, etiqueta: crudo };
}

function desglosePorCanal(acumulado) {
  const filas = [...acumulado.values()]
    .sort((a, b) => b.venta - a.venta || b.pedidos - a.pedidos || a.etiqueta.localeCompare(b.etiqueta, 'es'));
  const pctPedidos = porcentajes(filas.map(f => f.pedidos));
  const pctVenta = porcentajes(filas.map(f => f.venta));
  return filas.map((f, i) => ({
    canal: f.clave, etiqueta: f.etiqueta, pedidos: f.pedidos, venta: pesos(f.venta),
    pct_pedidos: pctPedidos[i], pct_venta: pctVenta[i],
    ticket_promedio: f.pedidos ? pesos(f.venta / f.pedidos) : 0,
  }));
}

// ─── Por colonia ────────────────────────────────────────────────────────────
// La colonia es texto libre: «Centro», «centro» y «Col. Centro» son la misma.
// Se agrupan por una clave sin mayúsculas, acentos, signos ni el prefijo
// «Col.»/«Colonia»/«Fracc.»/«Fraccionamiento», y se muestra la forma más
// escrita.
//
// De dónde sale, en este orden:
//   1. el campo `colonia` del pedido (POS, tienda en línea, Rappi);
//   2. si no hay campo, la dirección escrita cuando NOMBRA la colonia
//      («… Col. Centro», «… colonia Las Fuentes»);
//   3. si tampoco, un tramo de la dirección separado por comas que es
//      EXACTAMENTE una colonia ya vista en el periodo por 1 o 2 (el formulario
//      de WhatsApp guarda «calle, colonia, zona» en un solo texto).
// Lo demás queda en «Sin colonia identificada», contado y a la vista: nunca se
// adivina una colonia por parecido, porque una calle y una colonia pueden
// llamarse igual y repartir mal un pedido distorsiona el reporte sin avisar.
const PREFIJO_COLONIA = /^(?:col(?:onia)?|fracc?(?:ionamiento)?)(?:\.\s*|\s+)/i;
const COLONIA_NOMBRADA = /(?:^|[\s,.;(])(?:col(?:onia)?|fracc?(?:ionamiento)?)(?:\.\s*|\s+)([^,;\n()#]+)/i;
// Lo que sigue a la colonia en una dirección dictada y ya no es colonia.
const FIN_DE_COLONIA = /\s+(?:entre|frente|cerca|junto|a\s+un\s+lado|atr[aá]s|esquina|esq\.?|cp|c\.p\.?|c[oó]digo\s+postal|ref(?:erencias?)?\.?|n[uú]m(?:ero)?\.?|no\.)(?=\s|$).*$/i;
const NO_ES_COLONIA = /^(?:n ?a|s ?n|sin colonia|ninguna|no|no aplica|no se|x+|col|colonia|fracc?|fraccionamiento)$/;
const PALABRAS_MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);

const sinAcentos = (t) => t.normalize('NFD').replace(/\p{M}+/gu, '');

/** { clave, nombre } de un texto de colonia, o null si no dice una colonia. */
export function limpiarColonia(texto) {
  if (typeof texto !== 'string') return null;
  let t = texto.normalize('NFC').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2 && PREFIJO_COLONIA.test(t); i++) t = t.replace(PREFIJO_COLONIA, '').trim();
  t = t.replace(/[\s,;:.-]*(?:c\.?\s*p\.?\s*)?\d{5}\s*$/i, ''); // código postal al final
  t = t.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').slice(0, 120).trim();
  const clave = sinAcentos(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!clave || !/[a-z]/.test(clave) || NO_ES_COLONIA.test(clave)) return null;
  return { clave, nombre: t };
}

/** La colonia que NOMBRA una dirección escrita («… Col. Centro, …»), o null. */
export function coloniaNombradaEn(direccion) {
  if (typeof direccion !== 'string') return null;
  const m = direccion.match(COLONIA_NOMBRADA);
  return m ? limpiarColonia(m[1].replace(FIN_DE_COLONIA, '')) : null;
}

function coloniaEnTramos(direccion, conocidas) {
  if (typeof direccion !== 'string' || !conocidas.size) return null;
  const tramos = direccion.split(/[,;\n]/).map(limpiarColonia).filter(Boolean);
  // El primer tramo suele ser la calle: se revisa al final.
  for (const t of [...tramos.slice(1), ...tramos.slice(0, 1)]) if (conocidas.has(t.clave)) return t;
  return null;
}

// «CENTRO» o «las fuentes» se muestran «Centro» y «Las Fuentes»; lo que el
// negocio escribió con mayúsculas y minúsculas se respeta.
function nombreVisible(nombre) {
  if (nombre !== nombre.toLowerCase() && nombre !== nombre.toUpperCase()) return nombre;
  return nombre.toLocaleLowerCase('es-MX').split(' ')
    .map((p, i) => (i > 0 && PALABRAS_MENORES.has(p) ? p : p.charAt(0).toLocaleUpperCase('es-MX') + p.slice(1)))
    .join(' ');
}

/**
 * Colonias de las ventas a domicilio. domicilios: [{ datos, neta (centavos), canal }].
 * Devuelve el desglose y, por cada venta, su colonia (o null) en el mismo orden.
 */
function desglosePorColonia(domicilios) {
  const halladas = domicilios.map(({ datos }) => {
    const c = datos?.cliente || {};
    const campo = limpiarColonia(typeof c.colonia === 'string' ? c.colonia : '');
    if (campo) return { ...campo, fuente: 'campo' };
    const nombrada = coloniaNombradaEn(c.direccion) || coloniaNombradaEn(c.calle);
    return nombrada ? { ...nombrada, fuente: 'texto' } : null;
  });
  const conocidas = new Set(halladas.filter(Boolean).map(h => h.clave));
  domicilios.forEach(({ datos }, i) => {
    if (halladas[i]) return;
    const c = datos?.cliente || {};
    const tramo = coloniaEnTramos(c.direccion, conocidas) || coloniaEnTramos(c.calle, conocidas);
    if (tramo) halladas[i] = { ...tramo, fuente: 'texto' };
  });
  const grupos = new Map();
  const sin = { pedidos: 0, venta: 0, canales: new Map() };
  let delTexto = 0;
  domicilios.forEach(({ neta, canal }, i) => {
    const h = halladas[i];
    if (!h) {
      sin.pedidos++; sin.venta += neta;
      sin.canales.set(canal.etiqueta, (sin.canales.get(canal.etiqueta) || 0) + 1);
      return;
    }
    if (h.fuente === 'texto') delTexto++;
    const g = grupos.get(h.clave) || { pedidos: 0, venta: 0, formas: new Map() };
    g.pedidos++; g.venta += neta;
    g.formas.set(h.nombre, (g.formas.get(h.nombre) || 0) + 1);
    grupos.set(h.clave, g);
  });
  const nombreDe = (g) => [...g.formas.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const colonias = [...grupos.values()]
    .map(g => ({ colonia: nombreVisible(nombreDe(g)), pedidos: g.pedidos, venta: g.venta }))
    .sort((a, b) => b.pedidos - a.pedidos || b.venta - a.venta || a.colonia.localeCompare(b.colonia, 'es'));
  const pct = porcentajes([...colonias.map(c => c.pedidos), sin.pedidos]);
  return {
    resumen: {
      domicilios: domicilios.length,
      identificados: domicilios.length - sin.pedidos,
      del_texto: delTexto,
      colonias: colonias.map((c, i) => ({ ...c, venta: pesos(c.venta), pct_pedidos: pct[i] })),
      sin_colonia: {
        pedidos: sin.pedidos, venta: pesos(sin.venta), pct_pedidos: pct[colonias.length],
        canales: [...sin.canales.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
          .map(([etiqueta, pedidos]) => ({ etiqueta, pedidos })),
      },
    },
    // La colonia de cada venta, con el mismo nombre que su renglón del desglose.
    nombres: halladas.map(h => (h ? nombreVisible(nombreDe(grupos.get(h.clave))) : null)),
  };
}

const promedio2 = (total, n) => (n ? Math.round((total / n) * 100) / 100 : null);

/**
 * Ventas por día, promedio por día de la semana y mapa de calor día × hora.
 * puntos: [{ instante, neta (centavos) }] — SOLO ventas (ya clasificadas).
 * Todo en la zona del negocio.
 *
 * Los promedios son promedios de verdad: la venta de los lunes ÷ cuántos
 * lunes hubo en el periodo (con o sin venta), porque un mes puede tener 5
 * jueves y 4 lunes. Y solo cuentan días CERRADOS: hoy va a medias y lo que
 * aún no llega no es un día sin venta. Las barras por día sí muestran hoy.
 */
export function analizarVentas(puntos = [], { desde, hasta, tz, hoy } = {}) {
  if (!esFechaValida(desde) || !esFechaValida(hasta) || desde > hasta || !esZonaValida(tz) || !esFechaValida(hoy)) {
    return null;
  }
  const n = diasEntre(desde, hasta);
  const dias = [];
  const porFecha = new Map();
  for (let i = 0; i < n; i++) {
    const fecha = sumarDias(desde, i);
    const d = {
      fecha, dia_semana: diaDeSemana(fecha), venta: 0, tickets: 0,
      estado: fecha < hoy ? 'cerrado' : (fecha === hoy ? 'en_curso' : 'futuro'),
    };
    dias.push(d);
    porFecha.set(fecha, d);
  }
  const celdas = new Map(); // `${dia_semana}-${hora}` → { venta, tickets }
  const porHora = new Map(); // hora → { venta, tickets } (días cerrados)
  let ticketsCerrados = 0;
  for (const p of puntos) {
    const local = fechaYHoraLocal(p.instante, tz);
    const d = local && porFecha.get(local.fecha);
    if (!d) continue;
    d.venta += p.neta; d.tickets++;
    if (d.estado !== 'cerrado') continue;
    const k = `${d.dia_semana}-${local.hora}`;
    const c = celdas.get(k) || { venta: 0, tickets: 0 };
    c.venta += p.neta; c.tickets++;
    celdas.set(k, c);
    const h = porHora.get(local.hora) || { venta: 0, tickets: 0 };
    h.venta += p.neta; h.tickets++;
    porHora.set(local.hora, h);
    ticketsCerrados++;
  }
  const cerrados = dias.filter(d => d.estado === 'cerrado');
  const semana = ORDEN_SEMANA.map(dow => {
    const suyos = cerrados.filter(d => d.dia_semana === dow);
    const venta = suyos.reduce((s, d) => s + d.venta, 0);
    const tickets = suyos.reduce((s, d) => s + d.tickets, 0);
    return {
      dia_semana: dow, nombre: DIAS_SEMANA[dow], dias: suyos.length,
      venta_total: pesos(venta), tickets_total: tickets,
      venta_promedio: suyos.length ? pesos(venta / suyos.length) : null,
      tickets_promedio: promedio2(tickets, suyos.length),
      ticket_promedio: tickets ? pesos(venta / tickets) : null,
      _promedio: suyos.length ? venta / suyos.length : null,
    };
  });
  // El más bajo y el más alto, solo si hay al menos dos días que comparar y
  // no son iguales; en empate gana el primero de la semana.
  const conDias = semana.filter(s => s._promedio !== null);
  let masBajo = null, masAlto = null;
  if (conDias.length >= 2) {
    const bajo = conDias.reduce((a, b) => (b._promedio < a._promedio ? b : a));
    const alto = conDias.reduce((a, b) => (b._promedio > a._promedio ? b : a));
    if (alto._promedio > bajo._promedio) { masBajo = bajo.dia_semana; masAlto = alto.dia_semana; }
  }
  // Columnas del mapa: de la primera a la última hora que junta al menos el
  // 1 % de los tickets. Un pedido suelto de madrugada no
  // estira el mapa a 20 columnas vacías; lo que queda fuera se informa en
  // `fuera`, no se esconde. Sin ventas: 6 a 15 h.
  const umbral = Math.max(1, ticketsCerrados * 0.01);
  const significativas = [...porHora.entries()].filter(([, v]) => v.tickets >= umbral).map(([h]) => h);
  const [h0, h1] = significativas.length
    ? [Math.min(...significativas), Math.max(...significativas)]
    : [HORAS_OMISION.desde, HORAS_OMISION.hasta];
  const horas = [];
  for (let h = h0; h <= h1; h++) horas.push(h);
  const fuera = { tickets: 0, venta: 0, horas: [] };
  for (const [h, v] of [...porHora.entries()].sort((a, b) => a[0] - b[0])) {
    if (h >= h0 && h <= h1) continue;
    fuera.tickets += v.tickets; fuera.venta += v.venta; fuera.horas.push(h);
  }
  let maximo = 0;
  const filas = semana.map(s => ({
    dia_semana: s.dia_semana, nombre: s.nombre, dias: s.dias,
    celdas: horas.map(hora => {
      const c = celdas.get(`${s.dia_semana}-${hora}`) || { venta: 0, tickets: 0 };
      const venta = s.dias ? pesos(c.venta / s.dias) : null;
      if (venta !== null && venta > maximo) maximo = venta;
      return { hora, venta_promedio: venta, tickets_promedio: promedio2(c.tickets, s.dias) };
    }),
  }));
  return {
    dias_cerrados: cerrados.length,
    por_dia: dias.map(d => ({ ...d, venta: pesos(d.venta) })),
    por_dia_semana: semana.map(({ _promedio, ...s }) => s),
    mas_bajo: masBajo,
    mas_alto: masAlto,
    mapa_calor: { horas, filas, maximo, fuera: { ...fuera, venta: pesos(fuera.venta) } },
  };
}

/** Los más vendidos por cantidad (como los contaba el panel), de TODAS las ventas. */
function masVendidos(ventas, limite = 8) {
  const conteo = new Map();
  for (const v of ventas) {
    for (const i of v.items) {
      const nombre = String(i.nombre || '') || '?';
      conteo.set(nombre, (conteo.get(nombre) || 0) + i.cantidad);
    }
  }
  return [...conteo.entries()].sort((a, b) => b[1] - a[1]).slice(0, limite)
    .map(([nombre, cantidad]) => ({ nombre, cantidad }));
}

/**
 * Arma el reporte con pedidos ya leídos de UN negocio. Función pura: la usa
 * obtenerReporteVentas y la prueban las suites sin base.
 * filas: [{ folio, estado, datos, creado_at }]
 * opciones { desde, hasta, tz, hoy }: con ellas se agrega `analisis`.
 */
export function construirReporteVentas(filas = [], opciones = null) {
  const ventas = [];
  const t = { bruta: 0, descuento: 0, envio: 0, neta: 0, propinas: 0, plataforma: 0 };
  const fuera = {
    cancelado: { num: 0, total: 0 },
    por_cobrar: { num: 0, total: 0 },
    sin_consumo: { num: 0, total: 0 },
  };
  const modalidades = { domicilios: 0, recoger: 0, restaurante: 0 };
  const puntos = [];
  const porCanal = new Map();
  const domicilios = []; // { datos, neta, canal, venta } de cada venta a domicilio
  for (const fila of filas) {
    const datos = fila?.datos && typeof fila.datos === 'object' ? fila.datos : {};
    const tipo = clasificarPedido({ folio: fila?.folio, estado: fila?.estado, datos });
    if (tipo !== 'venta') {
      fuera[tipo].num++;
      fuera[tipo].total += centavos(datos.total);
      continue;
    }
    const imp = importesDePedido(datos);
    t.bruta += imp.bruta; t.descuento += imp.descuento; t.envio += imp.envio; t.neta += imp.neta;
    t.plataforma += imp.descuento_plataforma;
    t.propinas += propinaDe(datos);
    contarModalidad(modalidades, datos);
    puntos.push({ instante: fila.creado_at, neta: imp.neta });
    const canal = canalDeVenta(datos);
    const acumCanal = porCanal.get(canal.clave) || { clave: canal.clave, etiqueta: canal.etiqueta, pedidos: 0, venta: 0 };
    acumCanal.pedidos++; acumCanal.venta += imp.neta;
    porCanal.set(canal.clave, acumCanal);
    const venta = {
      folio: fila.folio,
      created_at: fila.creado_at instanceof Date ? fila.creado_at.toISOString() : fila.creado_at,
      nombre_cliente: datos?.cliente?.nombre ?? null,
      telefono: datos?.cliente?.telefono ?? null,
      canal: datos.canal ?? null,
      modalidad: datos.modalidad ?? null,
      forma_pago: formaPagoVisible(datos),
      items: itemsDe(datos).map(i => ({ nombre: i?.nombre ?? '', cantidad: Math.max(1, numeroO(i?.cantidad, 1)) })),
      venta_bruta: pesos(imp.bruta),
      descuento: pesos(imp.descuento),
      envio: pesos(imp.envio),
      total: pesos(imp.neta),
      colonia: null,
    };
    ventas.push(venta);
    if (esDomicilioDelReporte(datos)) domicilios.push({ datos, neta: imp.neta, canal, venta });
  }
  // Por colonia: solo ventas a domicilio, las mismas que cuenta la tarjeta.
  const colonias = desglosePorColonia(domicilios);
  domicilios.forEach((d, i) => { d.venta.colonia = colonias.nombres[i]; });
  const num = ventas.length;
  return {
    resumen: {
      total_ventas: pesos(t.neta),
      num_pedidos: num,
      promedio: num ? pesos(t.neta / num) : 0,
      total_envios: pesos(t.envio),
      ...modalidades,
    },
    desglose: {
      venta_bruta: pesos(t.bruta),
      descuentos: pesos(t.descuento),
      envios_cobrados: pesos(t.envio),
      venta_neta: pesos(t.neta),
      cancelados: { num: fuera.cancelado.num, total: pesos(fuera.cancelado.total) },
      por_cobrar: { num: fuera.por_cobrar.num, total: pesos(fuera.por_cobrar.total) },
      mesas_sin_consumo: { num: fuera.sin_consumo.num },
      // Informativos: no suman ni restan a la venta neta.
      propinas: pesos(t.propinas),
      descuentos_plataforma_no_restados: pesos(t.plataforma),
    },
    ...(opciones ? { analisis: analizarVentas(puntos, opciones) } : {}),
    // Pedidos y venta por canal; envíos por colonia. Mismas ventas que la
    // tarjeta: Σ venta por canal = venta neta y Σ pedidos por colonia (con
    // «sin colonia») = Domicilios.
    por_canal: desglosePorCanal(porCanal),
    por_colonia: colonias.resumen,
    mas_vendidos: masVendidos(ventas),
    ventas,
  };
}

/** Los renglones de una página (o todos, para el CSV). */
export function paginarVentas(ventas = [], { pagina = 1, todas = false, porPagina = VENTAS_POR_PAGINA } = {}) {
  const total = ventas.length;
  if (todas) return { ventas, paginacion: { pagina: 1, por_pagina: total, total, paginas: 1 } };
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  const p = Math.min(Math.max(1, Math.trunc(Number(pagina)) || 1), paginas);
  return {
    ventas: ventas.slice((p - 1) * porPagina, p * porPagina),
    paginacion: { pagina: p, por_pagina: porPagina, total, paginas },
  };
}

/**
 * La respuesta completa de la ruta, con los pedidos ya leídos de UN negocio:
 * los del periodo (`filas`) y los del periodo anterior (`filasAnteriores`).
 * Función pura: obtenerReporteVentas la usa con lo que lee de la base y la
 * suite del panel la usa con datos de prueba, así no pueden divergir.
 */
export function armarReporteVentas({ filas = [], filasAnteriores = [], desde, hasta, tz, hoy, pagina = 1, todas = false } = {}) {
  const { inicio } = rangoUtcDeFecha(desde, tz);
  const { fin } = rangoUtcDeFecha(hasta, tz);
  const reporte = construirReporteVentas(filas, { desde, hasta, tz, hoy });
  // Contra qué se compara: el periodo anterior del mismo largo, con la misma
  // definición de venta.
  const ant = periodoAnterior(desde, hasta);
  const previo = construirReporteVentas(filasAnteriores);
  const actualC = centavos(reporte.resumen.total_ventas);
  const previoC = centavos(previo.resumen.total_ventas);
  const { ventas, paginacion } = paginarVentas(reporte.ventas, { pagina, todas });
  return {
    timezone: tz,
    rango: { desde, hasta, inicio_utc: inicio.toISOString(), fin_utc: fin.toISOString(), hoy },
    ...reporte,
    comparacion: {
      desde: ant.desde, hasta: ant.hasta, etiqueta: ant.etiqueta,
      venta_neta: pesos(previoC), tickets: previo.resumen.num_pedidos,
      cambio_pct: previoC > 0 ? Math.round(((actualC - previoC) / previoC) * 1000) / 10 : null,
      incluye_hoy: desde <= hoy && hoy <= hasta,
    },
    ventas,
    paginacion,
  };
}

/**
 * Pedidos de UN negocio entre dos días operativos (inclusive) de su zona.
 * Cadenas ISO, nunca Date: contra una columna sin zona node-pg mandaría la
 * hora local de la máquina. Fin EXCLUSIVO: antes «hasta 23:59:59» dejaba
 * fuera el último segundo del día. Solo viajan los campos que se usan.
 * El folio desempata pedidos del mismo instante: las páginas se piden por
 * separado y un orden que cambia entre una y otra repetiría o perdería
 * renglones.
 */
async function leerPedidos(nid, desde, hasta, tz) {
  const inicio = rangoUtcDeFecha(desde, tz).inicio;
  const fin = rangoUtcDeFecha(hasta, tz).fin;
  const { rows } = await pool.query(`
    SELECT folio, estado,
           (created_at AT TIME ZONE 'UTC') AS creado_at,
           jsonb_build_object(
             'total', datos->'total', 'subtotal', datos->'subtotal',
             'costo_envio', datos->'costo_envio', 'descuento', datos->'descuento',
             'forma_pago', datos->'forma_pago', 'pago_confirmado', datos->'pago_confirmado',
             'canal', datos->'canal', 'modalidad', datos->'modalidad',
             'cliente', jsonb_build_object('nombre', datos->'cliente'->'nombre', 'telefono', datos->'cliente'->'telefono',
                                           'colonia', datos->'cliente'->'colonia', 'direccion', datos->'cliente'->'direccion',
                                           'calle', datos->'cliente'->'calle'),
             'items', datos->'items', 'propinas', datos->'propinas', 'propina', datos->'propina',
             'pagos', datos->'pagos'
           ) AS datos
      FROM pedidos_activos
     WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3
     ORDER BY created_at DESC, folio DESC
  `, [nid, inicio.toISOString(), fin.toISOString()]);
  return rows;
}

/**
 * Reporte de ventas de UN negocio entre dos días operativos (inclusive), en
 * la zona del negocio. negocioId OBLIGATORIO: sin él falla cerrado, nunca
 * consulta global. `hoy` (día operativo del negocio) separa los días
 * cerrados del que va en curso. Las transacciones salen por página; el
 * resumen, el desglose, el análisis y los más vendidos son del periodo entero.
 */
export async function obtenerReporteVentas({ negocioId, desde, hasta, tz, hoy, pagina = 1, todas = false } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  if (!esZonaValida(tz)) { const e = new Error('zona horaria inválida'); e.code = 'ZONA_INVALIDA'; throw e; }
  if (!esFechaValida(desde) || !esFechaValida(hasta) || desde > hasta || !esFechaValida(hoy)) {
    const e = new Error('rango inválido'); e.code = 'RANGO_INVALIDO'; throw e;
  }
  const nid = negocioId.trim();
  // El periodo anterior se lee del MISMO negocio.
  const ant = periodoAnterior(desde, hasta);
  const [filas, filasAnteriores] = await Promise.all([
    leerPedidos(nid, desde, hasta, tz),
    leerPedidos(nid, ant.desde, ant.hasta, tz),
  ]);
  return armarReporteVentas({ filas, filasAnteriores, desde, hasta, tz, hoy, pagina, todas });
}
