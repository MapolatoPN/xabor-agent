/**
 * cortesCaja.js — Cortes de caja como CIERRES HISTÓRICOS.
 *
 * Antes "Corte" era un resumen vivo: se recalculaba en cada carga. Eso hacía
 * que el corte de ayer pudiera cambiar hoy, y no dejaba constancia de cuánto
 * se contó ni de cuánto faltó. Un arqueo que se recalcula no es un arqueo.
 *
 * DOS INVARIANTES QUE GOBIERNAN TODO ESTE ARCHIVO
 *
 * 1. UN CORTE CERRADO NUNCA SE RECALCULA. Al cerrar se congela todo en
 *    columnas + snapshot_json. El ticket se arma SIEMPRE desde ahí; ninguna
 *    función de lectura de un corte cerrado vuelve a consultar pedidos.
 *
 * 2. VENTAS DEL PERIODO ≠ DINERO FÍSICO EN CAJA. Una venta con tarjeta o por
 *    enlace suma a las ventas del día y NO suma un peso al efectivo. El
 *    efectivo esperado es:
 *
 *      fondo inicial
 *      + ventas en efectivo
 *      + entradas
 *      - retiros
 *      - gastos
 *      - devoluciones en efectivo
 *      - propinas con tarjeta pagadas desde la caja (solo si el negocio
 *        lo tiene configurado: `caja_propinas_tarjeta_efectivo`)
 *
 *    Plataformas de delivery (Rappi, Uber Eats, DiDi Food) son su propia
 *    naturaleza: las liquida la plataforma, no Clip ni la terminal.
 *
 * DÍA OPERATIVO: es el día en la zona horaria DEL NEGOCIO, no un día UTC.
 * Un pedido de las 23:40 hora local pertenece a ese día aunque en UTC ya sea
 * el siguiente; si no, todos los cortes nocturnos saldrían partidos.
 *
 * RECONOCIMIENTO DE LA VENTA (regla de pagos tardíos):
 *   - Cobro inmediato (efectivo, terminal, transferencia…): la venta se
 *     reconoce el día en que se creó el pedido.
 *   - Enlace de pago: la venta se reconoce el día de la CONFIRMACIÓN
 *     financiera (`pagos.paid_at`), no el de la creación del pedido.
 *   Por eso un pedido creado ayer y pagado hoy aparece en el corte de HOY,
 *   en su propia sección "cobrado de días anteriores", con su folio y su
 *   fecha original. El corte de ayer, si ya está cerrado, no se toca jamás.
 */
import { pool } from './database.js';
import { TZ_DEFAULT, esZonaValida } from './zonaHoraria.js';
import { normalizarVentaFinanciera, construirReporteFinanciero } from './ventaFinanciera.js';
import { catalogoFormasCobro } from './formasCobro.js';

// El literal vive en zonaHoraria.js, que es donde está también el catálogo
// que ve el negocio al elegirla. Repetirlo aquí era invitar a que dos
// lugares del sistema opinaran distinto sobre la misma zona.
const TZ_POR_DEFECTO = TZ_DEFAULT;

// Clasificación por naturaleza del dinero, no por nombre comercial. Solo
// 'efectivo' incrementa el dinero físico de la caja.
//
// Se reconoce por CONTENIDO y no por lista exacta porque `datos.forma_pago`
// es texto libre acumulado por años: en producción conviven la clave técnica
// ('enlace_pago', 'terminal') y la etiqueta que escribió la interfaz
// ('enlace de pago', 'terminal (tarjeta presente)'). Con una lista exacta,
// 35 pedidos reales caían en "Otros" -- el total y el efectivo esperado
// salían bien, pero el desglose que el dueño mira mentía. Lo detectó el
// preview contra producción, previo al despliegue.
const SIN_ACENTOS = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

// `catalogo` (opcional): las formas de cobro que el negocio configuró
// (formas_cobro, migración 097), clave → forma. Una forma de la lista suma en
// la tarjeta que el negocio le puso; lo que no está en la lista -- las fijas
// y los textos de antes -- sigue la regla de siempre. Plataformas no es una
// naturaleza del dinero sino quién lo liquida: aquí cae en 'otros', igual que
// 'rappi' antes de la lista, y la separa plataformaDePedido().
export function clasificarFormaPago(forma, catalogo = null) {
  const tarjeta = catalogo ? catalogo.get(String(forma || '').trim().toLowerCase())?.tarjeta_caja : null;
  if (tarjeta === 'tarjeta' || tarjeta === 'enlace' || tarjeta === 'otros') return tarjeta;
  if (tarjeta === 'plataformas') return 'otros';
  const f = SIN_ACENTOS(String(forma || '').trim().toLowerCase());
  if (!f) return 'otros';
  // 'por_cobrar' y 'pendiente' NO son formas de pago: son ausencia de cobro,
  // y el cálculo los aparta antes de llegar aquí.
  if (f.includes('efectivo')) return 'efectivo';
  if (f.includes('terminal') || f.includes('tarjeta')) return 'tarjeta';
  if (f.includes('enlace') || f.includes('clip') || f.includes('mercado') ||
      f.includes('pago_online') || f.includes('pago en linea')) return 'enlace';
  return 'otros';
}

const textoNormal = (t) => SIN_ACENTOS(String(t || '').trim().toLowerCase());

// ─── Plataformas de delivery ────────────────────────────────────────────────
//
// Rappi, Uber Eats y DiDi Food liquidan sus pedidos días después, en su
// propio estado de cuenta: no son Clip ni la terminal del mostrador. Mientras
// la Caja los sumaba a "Clip / enlace", la conciliación con Clip no cuadraba
// (25-sep-2026 en Obispado: 6 pedidos "RAPPI ####" capturados como "enlace de
// pago", $1,306 de los $5,121 de esa tarjeta).
//
// Se reconoce por datos EXPLÍCITOS, nunca por adivinanza:
//   - la forma de pago "Rappi" que el cajero elige en el POS (Recoger,
//     Domicilio, Cobrar y ✏️ Pago);
//   - el canal/origen de una integración (Nonna Maye trae canal 'rappi').
// El nombre del cliente NO cuenta (decisión de Mario, 25-sep-2026): un
// "RAPPI 9420" capturado como "enlace de pago" se queda en Clip / enlace
// hasta que alguien le corrige la forma de pago con ✏️ Pago.
//
// Desde la 097 una plataforma nueva se da de alta en la lista del negocio
// (formas_cobro, tarjeta 'plataformas'); esta lista queda para los canales de
// integración y para los textos anteriores a la lista.
export const PLATAFORMAS = Object.freeze([
  Object.freeze({ clave: 'rappi', nombre: 'Rappi', canales: Object.freeze(['rappi']) }),
  Object.freeze({ clave: 'uber_eats', nombre: 'Uber Eats', canales: Object.freeze(['uber_eats', 'ubereats', 'uber eats']) }),
  Object.freeze({ clave: 'didi_food', nombre: 'DiDi Food', canales: Object.freeze(['didi_food', 'didifood', 'didi food']) }),
]);

// La lista del negocio (`catalogo`) decide QUÉ es una forma de pago que
// conoce: una plataforma con su nombre, o nada. El orden de lectura es el de
// siempre (por cada plataforma, su canal y después su texto), así que con la
// lista inicial todo pedido cae exactamente donde caía antes de la tabla.
export function plataformaDePedido(datos = {}, catalogo = null) {
  const d = datos && typeof datos === 'object' ? datos : {};
  const canal = textoNormal(d.canal);
  const origen = textoNormal(d.origen);
  const forma = textoNormal(d.forma_pago);
  const configurada = forma && catalogo ? catalogo.get(forma) : null;
  const deLaLista = () => (configurada.tarjeta_caja === 'plataformas'
    ? { clave: String(configurada.clave), nombre: configurada.nombre }
    : null);
  const nombrada = (p) => {
    const fila = catalogo ? catalogo.get(p.clave) : null;
    return fila ? { clave: p.clave, nombre: fila.nombre } : p;
  };
  for (const p of PLATAFORMAS) {
    if (p.canales.includes(canal) || p.canales.includes(origen)) return nombrada(p);
    if (forma && p.canales.includes(forma)) return configurada ? deLaLista() : nombrada(p);
  }
  return configurada ? deLaLista() : null;
}

/**
 * Naturaleza del dinero de una venta. Solo pasa a Plataformas lo que NO entró
 * por el mostrador: si alguien cobró un pedido de Rappi en efectivo o con la
 * terminal, ese dinero SÍ está en el cajón o en el depósito de la terminal, y
 * es ahí donde se tiene que conciliar.
 */
export function claseDeVenta(formaPago, plataforma, catalogo = null) {
  const clase = clasificarFormaPago(formaPago, catalogo);
  return plataforma && (clase === 'enlace' || clase === 'otros') ? 'plataformas' : clase;
}

/**
 * Un cobro mixto se reparte entre sus naturalezas. Antes caía entero en
 * "Otros" y su parte en efectivo nunca llegaba al efectivo esperado: el
 * arqueo salía sobrante justo por ese monto. Solo se reparte cuando el pedido
 * guarda las partes y cuadran con el total; si no, sigue en "Otros".
 *   - Mesas: `pagos[]`, un renglón por método (sin propina ni cambio).
 *   - POS: `mixto_terminal`; el cambio sale del efectivo, así que la parte en
 *     efectivo es total − terminal.
 */
export function partesDelCobro(datos = {}, total = 0, catalogo = null) {
  const d = datos && typeof datos === 'object' ? datos : {};
  if (textoNormal(d.forma_pago) !== 'mixto') return null;
  const t = dinero(total);
  if (Array.isArray(d.pagos) && d.pagos.length) {
    const partes = {};
    for (const p of d.pagos) {
      const monto = dinero(p?.monto);
      if (monto <= 0) continue;
      const clase = clasificarFormaPago(p?.metodo, catalogo);
      partes[clase] = dinero((partes[clase] || 0) + monto);
    }
    const suma = dinero(Object.values(partes).reduce((s, x) => s + x, 0));
    if (!Object.keys(partes).length || Math.abs(suma - t) > 0.01) return null;
    return Object.entries(partes).map(([clase, monto]) => ({ clase, monto }));
  }
  const terminal = dinero(d.mixto_terminal);
  if (terminal > 0 && terminal <= t + 0.005) {
    return [{ clase: 'efectivo', monto: dinero(t - terminal) }, { clase: 'tarjeta', monto: terminal }]
      .filter(p => p.monto > 0);
  }
  return null;
}

/**
 * Propinas de una venta por naturaleza del medio con que se pagaron. La
 * propina va aparte del total (no es venta). Con `pagos[]` se toma de cada
 * renglón y nunca además del agregado `propinas`, para no contarla dos veces.
 */
export function propinasPorClase(datos = {}, catalogo = null) {
  const d = datos && typeof datos === 'object' ? datos : {};
  const r = { efectivo: 0, tarjeta: 0, enlace: 0, otros: 0 };
  if (Array.isArray(d.pagos) && d.pagos.length) {
    for (const p of d.pagos) {
      const propina = dinero(Math.max(0, Number(p?.propina) || 0));
      if (propina > 0) { const c = clasificarFormaPago(p?.metodo, catalogo); r[c] = dinero(r[c] + propina); }
    }
    return r;
  }
  const propina = dinero(Math.max(0, Number(d.propinas ?? d.propina) || 0));
  if (propina > 0) { const c = clasificarFormaPago(d.forma_pago, catalogo); r[c] = dinero(r[c] + propina); }
  return r;
}

const uuidValido = v => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const esVentaDeMesa = (datos, folio) =>
  textoNormal(datos?.canal) === 'restaurante_mesa' || /^RM-/i.test(String(folio || ''));

/**
 * Una venta asentada en $0 no es "sin pago": es una cortesía o una cuenta que
 * no llegó a consumir. En producción (sep-2026) las ventas de mesa en $0 eran
 * cuentas abiertas y cerradas sin un solo producto, con todo cancelado, o con
 * descuento del 100 %. `items` es el conteo de renglones de la cuenta
 * (restaurante_cuenta_items); null si no se pudo leer.
 */
export function estadoVentaSinCobro({ datos = {}, folio = null, total = 0, items = null } = {}) {
  if (dinero(total) !== 0) return null;
  const subtotal = dinero(datos?.subtotal);
  const descuento = dinero(datos?.descuento);
  if (descuento > 0 && subtotal > 0 && descuento >= subtotal - 0.005) {
    return { estado_cuenta: 'cortesia', monto_real: subtotal, detalle_cuenta: 'descuento del 100 %' };
  }
  if (!esVentaDeMesa(datos, folio)) return null;
  const vivos = Array.isArray(datos?.items) ? datos.items.length : 0;
  if (vivos > 0) return { estado_cuenta: 'cortesia', monto_real: subtotal, detalle_cuenta: 'sin cargo' };
  if (items && items.n > 0) {
    return { estado_cuenta: 'cancelada', monto_real: dinero(items.monto_cancelado), detalle_cuenta: 'productos cancelados' };
  }
  return { estado_cuenta: 'cancelada', monto_real: 0, detalle_cuenta: 'sin consumo' };
}

// ─── Arqueo por denominaciones ──────────────────────────────────────────────

export const DENOMINACIONES = Object.freeze([1000, 500, 200, 100, 50, 20]);

function errorCorte(code, mensaje) { const e = new Error(mensaje); e.code = code; return e; }

/**
 * Normaliza lo que el cajero contó. Si contó por denominaciones, la suma de
 * billetes + monedas TIENE que ser el efectivo contado que se va a firmar:
 * el servidor la recalcula y rechaza un desacuerdo en vez de guardar dos
 * cifras distintas del mismo cajón.
 */
export function normalizarArqueo(arqueo, contado) {
  if (contado === null || contado === undefined) return null;
  if (!arqueo || typeof arqueo !== 'object' || arqueo.modo !== 'denominaciones') {
    return { modo: 'total', total: dinero(contado) };
  }
  const entrada = arqueo.denominaciones && typeof arqueo.denominaciones === 'object' ? arqueo.denominaciones : {};
  for (const [clave, n] of Object.entries(entrada)) {
    if (!DENOMINACIONES.includes(Number(clave)) && Number(n) !== 0) {
      throw errorCorte('CONTEO_INVALIDO', `Denominación desconocida: $${clave}`);
    }
  }
  const denominaciones = {};
  let suma = 0;
  for (const d of DENOMINACIONES) {
    const bruto = entrada[d] ?? entrada[String(d)] ?? 0;
    const n = bruto === '' || bruto === null ? 0 : Number(bruto);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      throw errorCorte('CONTEO_INVALIDO', `Cantidad inválida de billetes de $${d}`);
    }
    if (n > 0) denominaciones[d] = n;
    suma += d * n;
  }
  const monedasBruto = arqueo.monedas === '' || arqueo.monedas === null || arqueo.monedas === undefined ? 0 : Number(arqueo.monedas);
  if (!Number.isFinite(monedasBruto) || monedasBruto < 0) {
    throw errorCorte('CONTEO_INVALIDO', 'El monto en monedas no es válido');
  }
  const monedas = dinero(monedasBruto);
  suma = dinero(suma + monedas);
  if (Math.abs(suma - dinero(contado)) > 0.005) {
    throw errorCorte('CONTEO_INVALIDO',
      `El conteo por denominaciones suma $${suma.toFixed(2)} y el efectivo contado dice $${dinero(contado).toFixed(2)}`);
  }
  return { modo: 'denominaciones', denominaciones, monedas, total: suma };
}

/**
 * Lo que un rol puede ver de un corte ABIERTO. El admin ve el esperado
 * siempre (decisión del dueño, 25-sep-2026); cualquier otro rol cuenta a
 * ciegas y lo ve hasta que el corte queda cerrado con su conteo. Hoy la ruta
 * de Caja es solo de admin; esto deja listo el día que otro rol entre.
 */
export function vistaCorteParaRol(corte, rol) {
  if (!corte || corte.cerrado || rol === 'admin') return corte;
  return { ...corte, efectivo_esperado: null, esperado_oculto: true };
}

// ─── Configuración de caja por negocio ─────────────────────────────────────

export const CLAVE_PROPINAS_TARJETA_EFECTIVO = 'caja_propinas_tarjeta_efectivo';

export async function configuracionCaja(negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2::text[])`,
      [negocioId, [CLAVE_PROPINAS_TARJETA_EFECTIVO]]);
    const valor = textoNormal(rows.find(r => r.clave === CLAVE_PROPINAS_TARJETA_EFECTIVO)?.valor);
    return { propinasTarjetaEnEfectivo: ['true', '1', 'si', 'yes'].includes(valor) };
  } catch {
    return { propinasTarjetaEnEfectivo: false };
  }
}

/**
 * Un pedido tecnicamente creado pero sin dinero confirmado no es venta.
 * La ausencia historica de `pago_confirmado` (null/undefined) NO basta para
 * excluirlo: miles de pedidos legacy nunca guardaron esa bandera.
 */
export function esPedidoPendienteDeCobro({ estado, forma_pago, pago_confirmado } = {}) {
  const e = SIN_ACENTOS(String(estado || '').trim().toLowerCase());
  const f = SIN_ACENTOS(String(forma_pago || '').trim().toLowerCase());
  if (e === 'pendiente_pago') return true;
  if (pago_confirmado === false) return true;
  return pago_confirmado !== true && (f === 'por_cobrar' || f === 'pendiente');
}

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─── Día operativo en la zona horaria del negocio ───────────────────────────

export async function zonaHorariaNegocio(negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'timezone' LIMIT 1`,
      [negocioId]);
    const tz = String(rows[0]?.valor || '').trim();
    if (!tz) return TZ_POR_DEFECTO;
    // Una zona inválida haría estallar toda la pantalla de corte: se valida
    // antes de devolverla y se cae a la de siempre si no sirve.
    if (!esZonaValida(tz)) return TZ_POR_DEFECTO;
    return tz;
  } catch {
    return TZ_POR_DEFECTO;
  }
}

function partesEnZona(instante, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instante).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function desfaseMs(instante, tz) {
  const p = partesEnZona(instante, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - instante.getTime();
}

/** Instante UTC que corresponde a una hora local de esa zona. */
function instanteLocal(y, mo, d, h, mi, s, tz) {
  const objetivo = Date.UTC(y, mo - 1, d, h, mi, s);
  // Dos pasadas: la primera estima el desfase, la segunda lo corrige en los
  // bordes de horario de verano.
  let ts = objetivo;
  for (let i = 0; i < 2; i++) ts = objetivo - desfaseMs(new Date(ts), tz);
  return new Date(ts);
}

/** 'YYYY-MM-DD' del día operativo al que pertenece un instante. */
export function fechaOperativaDe(instante, tz) {
  const p = partesEnZona(instante, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function fechaOperativaHoy(tz) {
  return fechaOperativaDe(new Date(), tz);
}

/** Rango [inicio, fin) en UTC del día operativo indicado. */
export function rangoUtcDeFecha(fecha, tz) {
  const [y, mo, d] = String(fecha).split('-').map(Number);
  const inicio = instanteLocal(y, mo, d, 0, 0, 0, tz);
  const siguiente = new Date(Date.UTC(y, mo - 1, d) + 24 * 60 * 60 * 1000);
  const p = { y: siguiente.getUTCFullYear(), mo: siguiente.getUTCMonth() + 1, d: siguiente.getUTCDate() };
  const fin = instanteLocal(p.y, p.mo, p.d, 0, 0, 0, tz);
  return { inicio, fin };
}

export function esFechaValida(fecha) {
  return typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha) &&
    !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`));
}

// ─── Movimientos de caja ────────────────────────────────────────────────────

export const TIPOS_MOVIMIENTO = Object.freeze(['entrada', 'retiro', 'gasto']);

export async function registrarMovimiento(negocioId, { tipo, monto, motivo, usuarioId = null, fecha = null }) {
  if (!TIPOS_MOVIMIENTO.includes(tipo)) {
    const e = new Error(`Tipo de movimiento inválido: ${tipo}`); e.code = 'TIPO_INVALIDO'; throw e;
  }
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) {
    const e = new Error('El monto debe ser mayor que cero'); e.code = 'MONTO_INVALIDO'; throw e;
  }
  if (typeof motivo !== 'string' || !motivo.trim()) {
    const e = new Error('El motivo es obligatorio'); e.code = 'MOTIVO_REQUERIDO'; throw e;
  }
  const tz = await zonaHorariaNegocio(negocioId);
  const fechaOperativa = fecha && esFechaValida(fecha) ? fecha : fechaOperativaHoy(tz);

  // Un movimiento no puede entrar a un día ya cerrado: eso reescribiría un
  // arqueo firmado. Se rechaza con un motivo claro en vez de aceptarlo y
  // dejarlo colgando fuera de todo corte.
  const { rows: cerrado } = await pool.query(
    `SELECT folio FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`,
    [negocioId, fechaOperativa]);
  if (cerrado[0]) {
    const e = new Error(`El corte del ${fechaOperativa} ya está cerrado (${cerrado[0].folio}): no admite movimientos nuevos`);
    e.code = 'CORTE_CERRADO'; throw e;
  }

  const { rows: [mov] } = await pool.query(
    `INSERT INTO movimientos_caja (negocio_id, fecha_operativa, tipo, monto, motivo, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [negocioId, fechaOperativa, tipo, dinero(m), motivo.trim().slice(0, 200), usuarioId]);
  return mov;
}

export async function listarMovimientos(negocioId, fecha) {
  const { rows } = await pool.query(
    `SELECT m.id, m.tipo, m.monto, m.motivo, m.created_at, m.corte_id, u.nombre AS usuario
       FROM movimientos_caja m LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.negocio_id = $1 AND m.fecha_operativa = $2
      ORDER BY m.created_at`,
    [negocioId, fecha]);
  return rows;
}

// ─── Cálculo del corte vivo ─────────────────────────────────────────────────

/**
 * Arma el corte del día indicado a partir de las fuentes vivas. Es lo que se
 * muestra mientras el día está abierto y lo que se congela al cerrar.
 * NUNCA se usa para leer un corte ya cerrado.
 */
export async function calcularCorteVivo(negocioId, fecha = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  const nid = negocioId.trim();
  const tz = await zonaHorariaNegocio(nid);
  const fechaOperativa = fecha && esFechaValida(fecha) ? fecha : fechaOperativaHoy(tz);
  const { inicio, fin } = rangoUtcDeFecha(fechaOperativa, tz);

  // Rewards clasico no quedo dentro del JSON del pedido: su unica evidencia
  // es el movimiento. Ajustes administrativos tambien viven fuera del pedido.
  // Son complementos del reporte; si una instalacion antigua aun no tiene una
  // tabla, el corte principal sigue funcionando y la brecha queda registrada.
  // Lo mismo las cuentas de mesa: sin sus tablas, el corte no se cae.
  const consultaOpcional = async (etiqueta, promesa) => {
    try { return await promesa; }
    catch (e) {
      console.error(`[Corte] No se pudo leer ${etiqueta}:`, e.message);
      return { rows: [], opcionalError: etiqueta };
    }
  };

  const [pedidosRes, cancelRes, tardiosRes, movs, fondoRes, configCaja, cuentasRes, catalogo] = await Promise.all([
    // Ventas del día: pedidos creados dentro del rango, sin cancelados.
    // `promociones` y `tienda_promociones` viajan como jsonb crudo -- el
    // motor de promociones escribe la lista en dos rutas distintas según el
    // canal (top-level en POS/WhatsApp, anidada en datos.tienda en la
    // tienda en línea); se resuelve cuál usar más abajo, por pedido.
    pool.query(
      `SELECT folio, estado, created_at,
              datos,
              datos->>'forma_pago'                                     AS forma_pago,
              CASE WHEN lower(datos->>'pago_confirmado') IN ('true','false')
                   THEN (datos->>'pago_confirmado')::boolean ELSE NULL END AS pago_confirmado,
              COALESCE((datos->>'total')::decimal, 0)                  AS total,
              COALESCE((datos->>'descuento')::decimal, 0)              AS descuento,
              datos->'promociones'                                     AS promociones,
              datos->'tienda'->'promociones'                           AS tienda_promociones,
              COALESCE((datos->'devolucion'->>'monto')::decimal, 0)    AS devolucion_monto,
              datos->'cliente'->>'nombre'                              AS cliente
         FROM pedidos_activos
        WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3 AND estado <> 'cancelado'
        ORDER BY created_at`,
      [nid, inicio.toISOString(), fin.toISOString()]),
    pool.query(
      `SELECT COUNT(*)::int AS n
         FROM pedidos_activos
        WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3 AND estado = 'cancelado'`,
      [nid, inicio.toISOString(), fin.toISOString()]),
    // Pagos por enlace CONFIRMADOS hoy de pedidos creados ANTES de hoy: se
    // reconocen aquí, porque su día original ya pasó (y puede estar cerrado).
    pool.query(
      `SELECT p.pedido_folio AS folio, p.monto, p.paid_at, p.proveedor,
              pa.created_at AS pedido_creado_at, pa.datos
         FROM pagos p
         LEFT JOIN pedidos_activos pa ON pa.folio = p.pedido_folio AND pa.negocio_id = p.negocio_id
        WHERE p.negocio_id = $1 AND p.estado = 'pagado'
          AND p.paid_at >= $2 AND p.paid_at < $3
          AND (pa.created_at IS NULL OR pa.created_at < $2)
        ORDER BY p.paid_at`,
      [nid, inicio.toISOString(), fin.toISOString()]),
    listarMovimientos(nid, fechaOperativa),
    pool.query(`SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2`, [nid, fechaOperativa]),
    configuracionCaja(nid),
    // Cuentas de mesa ABIERTAS (y canceladas) de este día: todavía no son
    // venta -- entran a pedidos_activos hasta que se cierran --, pero una
    // cuenta abierta es dinero por cobrar y el corte no la puede esconder.
    consultaOpcional('cuentas de mesa del día', pool.query(
      `SELECT c.id::text AS cuenta_id, c.mesa_numero, c.estado, c.abierta_at, c.descuento_monto,
              COALESCE((SELECT SUM(i.cantidad * i.precio_unitario) FROM restaurante_cuenta_items i
                         WHERE i.cuenta_id = c.id AND i.estado <> 'cancelado'), 0) AS subtotal,
              COALESCE((SELECT SUM(i.cantidad * i.precio_unitario) FROM restaurante_cuenta_items i
                         WHERE i.cuenta_id = c.id AND i.estado = 'cancelado'), 0) AS cancelado,
              (SELECT COUNT(*)::int FROM restaurante_cuenta_items i WHERE i.cuenta_id = c.id) AS n_items,
              COALESCE((SELECT SUM(p.monto) FROM restaurante_cuenta_pagos p
                         WHERE p.cuenta_id = c.id AND p.revertido_at IS NULL), 0) AS pagado,
              COALESCE((SELECT SUM(p.monto) FROM restaurante_cuenta_pagos p
                         WHERE p.cuenta_id = c.id AND p.revertido_at IS NULL AND p.metodo = 'efectivo'), 0) AS pagado_efectivo
         FROM restaurante_cuentas c
        WHERE c.negocio_id = $1 AND c.estado IN ('abierta', 'cancelada')
          AND c.abierta_at >= $2 AND c.abierta_at < $3
        ORDER BY c.abierta_at`,
      [nid, inicio.toISOString(), fin.toISOString()])),
    // Formas de cobro configuradas por el negocio (097): cada una suma en la
    // tarjeta que el negocio le puso. Sin tabla o sin renglones es la lista
    // inicial, que clasifica exactamente igual que antes de la tabla.
    catalogoFormasCobro(nid),
  ]);

  const porForma = { efectivo: 0, tarjeta: 0, enlace: 0, plataformas: 0, otros: 0 };
  const porPlataforma = new Map();
  const propinasPorNaturaleza = { efectivo: 0, tarjeta: 0, enlace: 0, otros: 0 };
  const detallePorForma = {};
  const pedidos = [];
  const pendientes = [];
  const ventasFinancieras = [];
  let pendienteNum = 0, pendienteTotal = 0, devolucionesTotal = 0, pedidosCobrados = 0;

  const filasReconocidas = pedidosRes.rows.filter(v => !esPedidoPendienteDeCobro(v));
  const foliosReconocidos = [...new Set([
    ...filasReconocidas.map(v => v.folio),
    ...tardiosRes.rows.map(v => v.folio),
  ].filter(Boolean))];
  // Ventas de mesa asentadas en $0: hay que ver la cuenta para saber si fue
  // cortesía, si se canceló todo o si nunca se consumió nada.
  const cuentasEnCero = [...new Set(filasReconocidas
    .filter(v => dinero(v.total) === 0 && esVentaDeMesa(v.datos, v.folio))
    .map(v => v.datos?.cuenta_id).filter(uuidValido))];

  const [rewardsRes, ajustesRes] = foliosReconocidos.length ? await Promise.all([
    consultaOpcional('Rewards para desglose financiero', pool.query(
      `SELECT m.id, m.folio_venta, m.puntos, m.metadata, m.usuario
         FROM rewards_movements m
        WHERE m.tenant_id = $1::text AND m.tipo = 'canje'
          AND m.folio_venta = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1 FROM rewards_movements r
             WHERE r.tenant_id = m.tenant_id AND r.tipo = 'reverso'
               AND r.metadata->>'movimiento_original_id' = m.id::text
          )`, [nid, foliosReconocidos])),
    consultaOpcional('ajustes posteriores para desglose financiero', pool.query(
      `SELECT a.folio, a.tipo, a.modo, a.porcentaje, a.monto_ajuste,
              a.motivo, a.usuario_id, a.created_at, u.nombre AS usuario
         FROM ajustes_cierre a
         LEFT JOIN usuarios u ON u.id = a.usuario_id
        WHERE a.negocio_id = $1 AND a.estado = 'aplicado'
          AND a.folio = ANY($2::text[])
        ORDER BY a.created_at`, [nid, foliosReconocidos])),
  ]) : [{ rows: [] }, { rows: [] }];
  const itemsEnCeroRes = cuentasEnCero.length
    ? await consultaOpcional('productos de cuentas de mesa en $0', pool.query(
      `SELECT cuenta_id::text AS cuenta_id, COUNT(*)::int AS n,
              COALESCE(SUM(cantidad * precio_unitario) FILTER (WHERE estado = 'cancelado'), 0) AS monto_cancelado
         FROM restaurante_cuenta_items
        WHERE negocio_id = $1 AND cuenta_id = ANY($2::uuid[])
        GROUP BY cuenta_id`, [nid, cuentasEnCero]))
    : { rows: [] };
  const itemsPorCuenta = new Map(itemsEnCeroRes.rows.map(r => [r.cuenta_id, r]));

  const rewardsPorFolio = new Map(rewardsRes.rows.map(r => {
    let meta = r.metadata || {};
    if (typeof r.metadata === 'string') {
      try { meta = JSON.parse(r.metadata) || {}; }
      catch { meta = {}; }
    }
    return [r.folio_venta, {
      puntos: Math.abs(Number(r.puntos) || 0),
      monto: dinero(meta.monto_descuento ?? meta.monto ?? 0),
      usuario: r.usuario || null,
    }];
  }));

  for (const v of pedidosRes.rows) {
    const total = dinero(v.total);
    // Un pedido con pago explicitamente pendiente todavia no tiene forma de
    // pago real: no entra a ninguna categoria ni al efectivo esperado.
    const abierto = esPedidoPendienteDeCobro(v);
    if (abierto) {
      pendienteNum++; pendienteTotal += total;
      // Se lista (Pedidos del día → Por cobrar) pero no suma a nada.
      pendientes.push({
        folio: v.folio, hora: v.created_at, cliente: v.cliente || null,
        forma_pago: v.forma_pago || null, clase: 'por_cobrar', total, estado: v.estado,
      });
      continue;
    }
    devolucionesTotal += dinero(v.devolucion_monto);
    const plataforma = plataformaDePedido(v.datos, catalogo);
    const sinCobro = estadoVentaSinCobro({
      datos: v.datos || {}, folio: v.folio, total,
      items: itemsPorCuenta.get(String(v.datos?.cuenta_id || '')) || null,
    });
    const partes = sinCobro ? null : partesDelCobro(v.datos, total, catalogo);
    const clase = sinCobro ? 'sin_cobro' : (partes ? 'mixto' : claseDeVenta(v.forma_pago, plataforma, catalogo));
    if (partes) {
      for (const p of partes) porForma[p.clase] = dinero(porForma[p.clase] + p.monto);
    } else if (!sinCobro) {
      porForma[clase] += total;
    }
    if (clase === 'plataformas') {
      const acum = porPlataforma.get(plataforma.clave) || { clave: plataforma.clave, nombre: plataforma.nombre, num: 0, total: 0 };
      acum.num++; acum.total = dinero(acum.total + total);
      porPlataforma.set(plataforma.clave, acum);
    }
    const propinas = propinasPorClase(v.datos, catalogo);
    for (const c of Object.keys(propinasPorNaturaleza)) {
      propinasPorNaturaleza[c] = dinero(propinasPorNaturaleza[c] + propinas[c]);
    }
    const clave = clase === 'plataformas'
      ? `${plataforma.nombre} · ${v.forma_pago || 'sin forma de pago'}`
      : (v.forma_pago || 'no especificado');
    if (!detallePorForma[clave]) detallePorForma[clave] = { count: 0, total: 0, clase };
    detallePorForma[clave].count++;
    detallePorForma[clave].total = dinero(detallePorForma[clave].total + total);
    pedidosCobrados++;
    pedidos.push({
      folio: v.folio, hora: v.created_at, cliente: v.cliente || null,
      forma_pago: v.forma_pago || 'no especificado', clase, total,
      ...(plataforma ? { plataforma: plataforma.clave, plataforma_nombre: plataforma.nombre } : {}),
      ...(partes ? { partes } : {}),
      ...(sinCobro || {}),
    });
    ventasFinancieras.push(normalizarVentaFinanciera(v.datos || {}, {
      folio: v.folio, fecha: v.created_at, totalNeto: total,
      rewardsCanje: rewardsPorFolio.get(v.folio) || null,
    }));
  }

  // Cobros tardíos: dinero electrónico (enlace), nunca efectivo.
  const tardios = tardiosRes.rows.map(p => ({
    folio: p.folio, monto: dinero(p.monto), proveedor: p.proveedor,
    confirmado_at: p.paid_at,
    pedido_creado_at: p.pedido_creado_at,
    fecha_original: p.pedido_creado_at ? fechaOperativaDe(new Date(p.pedido_creado_at), tz) : null,
  }));
  const totalTardios = dinero(tardios.reduce((s, p) => s + p.monto, 0));
  porForma.enlace = dinero(porForma.enlace + totalTardios);
  for (const p of tardiosRes.rows) {
    ventasFinancieras.push(normalizarVentaFinanciera(p.datos || {}, {
      folio: p.folio, fecha: p.paid_at, totalNeto: dinero(p.monto),
      rewardsCanje: rewardsPorFolio.get(p.folio) || null,
    }));
  }

  const entradas = dinero(movs.filter(m => m.tipo === 'entrada').reduce((s, m) => s + Number(m.monto), 0));
  const retiros = dinero(movs.filter(m => m.tipo === 'retiro').reduce((s, m) => s + Number(m.monto), 0));
  const gastos = dinero(movs.filter(m => m.tipo === 'gasto').reduce((s, m) => s + Number(m.monto), 0));

  // Devoluciones EN EFECTIVO: solo las de pedidos que se habían cobrado en
  // efectivo salen del cajón. Una devolución de un pago con tarjeta se
  // reembolsa por el mismo medio y no toca el dinero físico.
  let devolucionesEfectivo = 0;
  for (const v of pedidosRes.rows) {
    if (esPedidoPendienteDeCobro(v)) continue;
    const monto = dinero(v.devolucion_monto);
    if (monto > 0 && clasificarFormaPago(v.forma_pago, catalogo) === 'efectivo') devolucionesEfectivo += monto;
  }
  devolucionesEfectivo = dinero(devolucionesEfectivo);

  const fondoInicial = dinero(fondoRes.rows[0]?.fondo || 0);
  const ventasEfectivo = dinero(porForma.efectivo);
  // Ventas del día = la suma de TODAS las naturalezas, plataformas incluidas.
  const ventasTotales = dinero(
    porForma.efectivo + porForma.tarjeta + porForma.enlace + porForma.plataformas + porForma.otros);

  // Propinas cobradas con tarjeta: si el negocio se las paga al mesero en
  // efectivo desde la caja, ese dinero SALE del cajón y el esperado baja.
  const propinasTarjeta = dinero(propinasPorNaturaleza.tarjeta);
  const propinasPagadasEfectivo = configCaja.propinasTarjetaEnEfectivo ? propinasTarjeta : 0;

  // Cuentas de mesa del día que no son venta todavía (abiertas) o nunca lo
  // serán (canceladas). Solo las abiertas suman a "Por cobrar", y por su
  // SALDO: lo ya abonado se descuenta.
  const cuentasMesa = cuentasRes.rows.map(c => {
    const subtotal = dinero(c.subtotal);
    const descuento = dinero(c.descuento_monto);
    const totalCuenta = dinero(subtotal - descuento);
    const pagado = dinero(c.pagado);
    const abierta = c.estado === 'abierta';
    return {
      cuenta_id: c.cuenta_id, mesa: c.mesa_numero, hora: c.abierta_at,
      cliente: `Mesa ${c.mesa_numero}`,
      estado_cuenta: abierta ? 'abierta' : 'cancelada',
      clase: abierta ? 'por_cobrar' : 'sin_cobro',
      subtotal, descuento, total: totalCuenta,
      cancelado: dinero(c.cancelado), n_items: Number(c.n_items) || 0,
      pagado, pagado_efectivo: dinero(c.pagado_efectivo),
      saldo: abierta ? dinero(Math.max(0, totalCuenta - pagado)) : 0,
      monto_real: abierta ? totalCuenta : dinero(subtotal + dinero(c.cancelado)),
    };
  });
  const abiertas = cuentasMesa.filter(c => c.estado_cuenta === 'abierta');
  const cuentasAbiertas = {
    num: abiertas.length,
    total: dinero(abiertas.reduce((s, c) => s + c.total, 0)),
    pagado: dinero(abiertas.reduce((s, c) => s + c.pagado, 0)),
    saldo: dinero(abiertas.reduce((s, c) => s + c.saldo, 0)),
    // Abonos en efectivo de cuentas que siguen abiertas: el dinero YA está en
    // el cajón, pero la venta se reconoce al cerrar la cuenta. Se informa para
    // que un sobrante del arqueo tenga explicación; no entra al esperado.
    abonos_efectivo: dinero(abiertas.reduce((s, c) => s + c.pagado_efectivo, 0)),
  };
  const reporteFinanciero = construirReporteFinanciero(ventasFinancieras, ajustesRes.rows);
  for (const resultado of [rewardsRes, ajustesRes]) {
    if (resultado.opcionalError) {
      reporteFinanciero.calidad.parcial++;
      reporteFinanciero.calidad.avisos.push(
        `No se pudo leer ${resultado.opcionalError}; el desglose puede estar incompleto.`);
    }
  }
  // El pedido conserva el UUID del autorizador, no necesariamente su nombre.
  // Resolvemos el nombre dentro del mismo negocio sólo para enriquecer la
  // consulta; si el usuario fue eliminado, el UUID queda visible y no se
  // inventa una identidad.
  const idsAutorizadores = [...new Set(reporteFinanciero.aplicaciones
    .map(a => a.usuario_id).filter(uuidValido))];
  if (idsAutorizadores.length) {
    const usuariosRes = await consultaOpcional('nombres de autorizadores', pool.query(
      `SELECT id, nombre FROM usuarios WHERE negocio_id = $1 AND id = ANY($2::uuid[])`,
      [nid, idsAutorizadores]));
    const nombres = new Map(usuariosRes.rows.map(u => [String(u.id), u.nombre]));
    for (const aplicacion of reporteFinanciero.aplicaciones) {
      if (!aplicacion.usuario && aplicacion.usuario_id) {
        aplicacion.usuario = nombres.get(String(aplicacion.usuario_id)) || null;
      }
    }
  }
  reporteFinanciero.resumen.venta_neta_corte = ventasTotales;
  reporteFinanciero.resumen.diferencia_con_corte = dinero(
    reporteFinanciero.resumen.venta_neta - ventasTotales);
  const efectivoEsperado = dinero(
    fondoInicial + ventasEfectivo + entradas - retiros - gastos - devolucionesEfectivo - propinasPagadasEfectivo);

  return {
    negocio_id: nid,
    fecha_operativa: fechaOperativa,
    timezone: tz,
    rango_utc: { inicio: inicio.toISOString(), fin: fin.toISOString() },
    fondo_inicial: fondoInicial,
    // Distingue "nadie registró el fondo" de "se registró en $0".
    fondo_registrado: fondoRes.rows.length > 0,
    ventas_totales: ventasTotales,
    ventas_efectivo: ventasEfectivo,
    ventas_tarjeta: dinero(porForma.tarjeta),
    ventas_enlace: dinero(porForma.enlace),
    ventas_plataformas: dinero(porForma.plataformas),
    ventas_otros: dinero(porForma.otros),
    plataformas: [...porPlataforma.values()].sort((a, b) => b.total - a.total),
    entradas, retiros, gastos,
    devoluciones_efectivo: devolucionesEfectivo,
    propinas_tarjeta: propinasTarjeta,
    propinas_tarjeta_en_efectivo: configCaja.propinasTarjetaEnEfectivo,
    propinas_pagadas_efectivo: propinasPagadasEfectivo,
    efectivo_esperado: efectivoEsperado,
    pedidos_count: pedidosCobrados,
    cancelaciones_count: cancelRes.rows[0]?.n || 0,
    devoluciones_total: dinero(devolucionesTotal),
    // Informativos: YA están incluidos dentro de ventas_totales/total de cada
    // pedido. Sumarlos aquí no cambia efectivo_esperado ni el arqueo -- solo
    // responde "cuánto del ingreso del día se fue en descuentos y Rewards".
    descuento_manual: dinero(reporteFinanciero.resumen.descuentos_manuales),
    descuento_promocional: dinero(reporteFinanciero.resumen.promociones_automaticas),
    rewards_canjeados: dinero(reporteFinanciero.resumen.rewards),
    pendiente: { num: pendienteNum, total: dinero(pendienteTotal) },
    cuentas_abiertas: cuentasAbiertas,
    // Todo lo que falta por cobrar: pedidos sin cobro + saldo de las cuentas
    // de mesa abiertas. Informativo: no suma a ventas ni al efectivo.
    por_cobrar: {
      num: pendienteNum + cuentasAbiertas.num,
      total: dinero(pendienteTotal + cuentasAbiertas.saldo),
    },
    detalle_formas: detallePorForma,
    pedidos,
    pendientes,
    cuentas_mesa: cuentasMesa,
    movimientos: movs.map(m => ({
      tipo: m.tipo, monto: dinero(m.monto), motivo: m.motivo,
      usuario: m.usuario || null, created_at: m.created_at,
    })),
    cobros_dias_anteriores: tardios,
    reporte_financiero: reporteFinanciero,
  };
}

// ─── Cierre ─────────────────────────────────────────────────────────────────

function calcularDiferencia(esperado, contado) {
  if (contado === null || contado === undefined) return 0;
  return dinero(Number(contado) - Number(esperado));
}

/**
 * Cierra el corte del día. IDEMPOTENTE: si ya existe uno para ese negocio y
 * fecha, devuelve el existente con `yaExistia: true` y NO recalcula nada. La
 * garantía real es el índice único (negocio_id, fecha_operativa) -- dos
 * peticiones simultáneas no pueden crear dos cortes ni aunque la aplicación
 * se equivoque.
 *
 * Además de las columnas (fondo, esperado, contado, diferencia, usuario y
 * hora de cierre), el snapshot guarda CÓMO se contó: por denominaciones o
 * solo el total, y si quien contó veía el esperado (`a_ciegas`).
 */
export async function cerrarCorte(negocioId, {
  fecha = null, efectivoContado = null, nota = null, usuarioId = null, arqueo = null, rol = null,
} = {}) {
  const vivo = await calcularCorteVivo(negocioId, fecha);
  const fechaOperativa = vivo.fecha_operativa;

  const existente = await obtenerCorteCerrado(negocioId, fechaOperativa);
  if (existente) return { corte: existente, yaExistia: true };

  const contado = efectivoContado === null || efectivoContado === undefined || efectivoContado === ''
    ? null : dinero(efectivoContado);
  if (contado !== null && (!Number.isFinite(contado) || contado < 0)) {
    const e = new Error('El efectivo contado no puede ser negativo'); e.code = 'CONTADO_INVALIDO'; throw e;
  }
  const conteo = normalizarArqueo(arqueo, contado);
  const snapshot = {
    ...vivo,
    arqueo: conteo ? {
      ...conteo,
      a_ciegas: rol ? rol !== 'admin' : null,
      rol: rol || null,
    } : null,
  };
  const diferencia = calcularDiferencia(vivo.efectivo_esperado, contado);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cerrojo por NEGOCIO mientras dure la transacción.
    //
    // El folio se numera contando los cortes del negocio, y eso no es seguro
    // bajo concurrencia: dos cierres de DÍAS DISTINTOS que corren a la vez
    // cuentan lo mismo, arman el mismo folio y el segundo revienta contra el
    // índice único de folio -- ese día se quedaba SIN corte y el cajero veía
    // un error crudo de base de datos. El UNIQUE de (negocio, fecha) no lo
    // cubre justamente porque las fechas son distintas.
    //
    // Lo detectó el gate previo al despliegue: 3 días cerrados a la vez
    // dejaban solo 2 cortes. Con el cerrojo, los cierres del mismo negocio
    // se serializan y cada uno ve el conteo ya actualizado; los cierres de
    // negocios distintos no se estorban. Se libera solo al terminar la
    // transacción, haya COMMIT o ROLLBACK.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('cortes_caja'), hashtext($1))`, [negocioId]);

    // Con el cerrojo tomado, otro cierre pudo haber ganado la carrera de
    // ESTE mismo día mientras esperábamos: se vuelve a mirar antes de armar
    // uno nuevo.
    const { rows: yaCerrado } = await client.query(
      `SELECT id FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`,
      [negocioId, fechaOperativa]);
    if (yaCerrado[0]) {
      await client.query('ROLLBACK');
      // Con el MISMO cliente: pedir otro del pool aquí lo agotaría.
      return { corte: await obtenerCorteCerrado(negocioId, fechaOperativa, client), yaExistia: true };
    }

    const { rows: [corte] } = await client.query(
      `INSERT INTO cortes_caja (
         negocio_id, fecha_operativa, estado, folio, usuario_id, cerrado_at,
         fondo_inicial, ventas_totales, ventas_efectivo, ventas_tarjeta, ventas_enlace, ventas_otros,
         entradas, retiros, gastos, devoluciones_efectivo,
         efectivo_esperado, efectivo_contado, diferencia, nota,
         pedidos_count, cancelaciones_count, devoluciones_total,
         descuento_manual, descuento_promocional, rewards_canjeados, snapshot_json)
       VALUES ($1,$2,'cerrado',
         'COR-' || LPAD(((SELECT COUNT(*) FROM cortes_caja c WHERE c.negocio_id = $1) + 1)::text, 6, '0'),
         $3, NOW(),
         $4,$5,$6,$7,$8,$9,
         $10,$11,$12,$13,
         $14,$15,$16,$17,
         $18,$19,$20,
         $21,$22,$23,$24::jsonb)
       ON CONFLICT (negocio_id, fecha_operativa) DO NOTHING
       RETURNING *`,
      [negocioId, fechaOperativa, usuarioId,
       vivo.fondo_inicial, vivo.ventas_totales, vivo.ventas_efectivo, vivo.ventas_tarjeta, vivo.ventas_enlace, vivo.ventas_otros,
       vivo.entradas, vivo.retiros, vivo.gastos, vivo.devoluciones_efectivo,
       vivo.efectivo_esperado, contado, diferencia, nota ? String(nota).slice(0, 500) : null,
       vivo.pedidos_count, vivo.cancelaciones_count, vivo.devoluciones_total,
       vivo.descuento_manual, vivo.descuento_promocional, vivo.rewards_canjeados,
       JSON.stringify(snapshot)]);

    if (!corte) {
      // Otra petición ganó la carrera: no es un error, es exactamente lo que
      // el índice único debe hacer. Se devuelve el corte que sí quedó.
      await client.query('ROLLBACK');
      const ganador = await obtenerCorteCerrado(negocioId, fechaOperativa, client);
      return { corte: ganador, yaExistia: true };
    }

    // Sellar los movimientos del día: quedan atados a este corte y ya no
    // pueden contarse en otro.
    await client.query(
      `UPDATE movimientos_caja SET corte_id = $1
        WHERE negocio_id = $2 AND fecha_operativa = $3 AND corte_id IS NULL`,
      [corte.id, negocioId, fechaOperativa]);

    await client.query('COMMIT');
    return { corte, yaExistia: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Lee el corte de un día. `ejecutor` permite reusar el cliente de una
 * transacción en curso: pedir OTRO cliente del pool mientras se tiene uno
 * tomado agota el pool y cuelga el proceso bajo concurrencia -- pasó en el
 * gate previo al despliegue, con 20 cierres simultáneos.
 */
export async function obtenerCorteCerrado(negocioId, fecha, ejecutor = pool) {
  const { rows } = await ejecutor.query(
    `SELECT c.*, u.nombre AS usuario_nombre
       FROM cortes_caja c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.negocio_id = $1 AND c.fecha_operativa = $2`,
    [negocioId, fecha]);
  return rows[0] || null;
}

export async function listarCortes(negocioId, { limite = 60 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.fecha_operativa, c.folio, c.estado, c.cerrado_at,
            c.ventas_totales, c.ventas_efectivo, c.ventas_tarjeta, c.ventas_enlace, c.ventas_otros,
            c.efectivo_esperado, c.efectivo_contado, c.diferencia, c.pedidos_count,
            c.descuento_manual, c.descuento_promocional, c.rewards_canjeados,
            -- Sin columna propia: vive en el snapshot. Un corte cerrado antes
            -- de existir Plataformas simplemente trae 0 (y sus Rappi siguen
            -- en enlace, como se firmaron).
            COALESCE((c.snapshot_json->>'ventas_plataformas')::numeric, 0) AS ventas_plataformas,
            COALESCE((c.snapshot_json->>'propinas_pagadas_efectivo')::numeric, 0) AS propinas_pagadas_efectivo,
            u.nombre AS usuario_nombre
       FROM cortes_caja c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.negocio_id = $1
      ORDER BY c.fecha_operativa DESC
      LIMIT $2`,
    [negocioId, Math.min(Math.max(Number(limite) || 60, 1), 400)]);
  return rows;
}

// ─── Ticket térmico ─────────────────────────────────────────────────────────

const ANCHO = 32;
const linea = (car = '-') => car.repeat(ANCHO);
const centrar = (t) => {
  const s = String(t).slice(0, ANCHO);
  const pad = Math.max(0, Math.floor((ANCHO - s.length) / 2));
  return ' '.repeat(pad) + s;
};
const pesos = (n) => `$${(Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fila = (etiqueta, valor) => {
  const v = pesos(valor);
  const e = String(etiqueta).slice(0, ANCHO - v.length - 1);
  return e + ' '.repeat(Math.max(1, ANCHO - e.length - v.length)) + v;
};

/**
 * Arma el ticket DESDE EL SNAPSHOT del corte cerrado. No consulta ventas ni
 * pedidos: si lo hiciera, reimprimir un corte de hace un mes podría dar un
 * papel distinto al original, que es justo lo que este módulo evita.
 */
export function ticketCorte(corte, { negocioNombre = 'XABOR' } = {}) {
  const s = corte.snapshot_json && typeof corte.snapshot_json === 'object' ? corte.snapshot_json : {};
  const tz = s.timezone || TZ_POR_DEFECTO;
  const cerrado = corte.cerrado_at ? new Date(corte.cerrado_at) : new Date();
  const hora = new Intl.DateTimeFormat('es-MX', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(cerrado);
  const fechaCorta = String(corte.fecha_operativa).slice(0, 10).split('-').reverse().join('/');
  const dif = Number(corte.diferencia) || 0;
  const etiquetaDif = dif > 0 ? 'SOBRANTE' : dif < 0 ? 'FALTANTE' : 'CUADRADO';

  const L = [];
  L.push(centrar(String(negocioNombre).toUpperCase()));
  L.push(centrar('CORTE DE CAJA'));
  L.push(centrar(corte.folio));
  L.push('');
  L.push(`Fecha operativa: ${fechaCorta}`);
  L.push(`Cierre: ${hora}`);
  L.push(`Usuario: ${corte.usuario_nombre || 'Sistema'}`);
  L.push('');
  L.push(linea());
  L.push('VENTAS');
  L.push(linea());
  L.push(`Pedidos: ${corte.pedidos_count}`);
  L.push('');
  L.push(fila('Efectivo', corte.ventas_efectivo));
  L.push(fila('Tarjeta', corte.ventas_tarjeta));
  L.push(fila('Clip / enlace', corte.ventas_enlace));
  // Solo en cortes cerrados con Plataformas: reimprimir uno viejo da
  // exactamente el papel que salió ese día.
  if ('ventas_plataformas' in s) L.push(fila('Plataformas', s.ventas_plataformas));
  L.push(fila('Otros', corte.ventas_otros));
  L.push(linea());
  L.push(fila('TOTAL', corte.ventas_totales));
  const descManual = Number(corte.descuento_manual) || 0;
  const descPromo = Number(corte.descuento_promocional) || 0;
  const rewards = Number(corte.rewards_canjeados) || 0;
  const financiero = s.reporte_financiero;
  const rf = financiero?.resumen;
  if (rf) {
    L.push('');
    L.push(linea());
    L.push('DESGLOSE FINANCIERO');
    L.push(linea());
    if (rf.venta_bruta_antes_descuentos == null) {
      L.push('Venta bruta: NO DETERMINABLE');
    } else {
      L.push(fila('Venta bruta antes descuentos', rf.venta_bruta_antes_descuentos));
      L.push(fila('  Productos', rf.venta_bruta_productos));
    }
    L.push(fila('Promociones automaticas', rf.promociones_automaticas));
    L.push(fila('Descuentos manuales', rf.descuentos_manuales));
    L.push(fila('Promos + descuentos', rf.promociones_y_descuentos));
    L.push(fila('Rewards (separado)', rf.rewards));
    L.push(fila('Venta neta', rf.venta_neta));
    L.push(fila('Propinas', rf.propinas));
    L.push(fila('Envio cobrado', rf.envio_cobrado));
    L.push(fila('Devoluciones', rf.devoluciones));
    if (Array.isArray(financiero.descuentos_por_concepto) && financiero.descuentos_por_concepto.length) {
      L.push('');
      L.push('Conceptos:');
      for (const c of financiero.descuentos_por_concepto.slice(0, 8)) {
        L.push(fila(`  ${c.concepto} (${c.ventas})`, c.importe));
      }
    }
  } else if (descManual > 0 || descPromo > 0 || rewards > 0) {
    // Ya están incluidos en TOTAL de arriba -- esto es el desglose de
    // cuánto de ese total se regaló, no un descuento adicional.
    L.push('');
    L.push(linea());
    L.push('DESCUENTOS Y REWARDS (incluidos en TOTAL)');
    L.push(linea());
    if (descManual > 0) L.push(fila('Descuento manual', descManual));
    if (descPromo > 0) L.push(fila('Promociones', descPromo));
    if (rewards > 0) L.push(fila('Rewards canjeados', rewards));
    L.push(fila('Total regalado', descManual + descPromo + rewards));
  }
  L.push('');
  L.push(linea());
  L.push('CAJA');
  L.push(linea());
  L.push(fila('Fondo inicial', corte.fondo_inicial));
  L.push(fila('Ventas efectivo', corte.ventas_efectivo));
  L.push(fila('Entradas', corte.entradas));
  L.push(fila('Retiros', corte.retiros));
  L.push(fila('Gastos', corte.gastos));
  L.push(fila('Devoluciones', corte.devoluciones_efectivo));
  if (Number(s.propinas_pagadas_efectivo) > 0) L.push(fila('Propinas pagadas', s.propinas_pagadas_efectivo));
  L.push(linea());
  L.push(fila('ESPERADO', corte.efectivo_esperado));
  L.push(fila('CONTADO', corte.efectivo_contado === null ? 0 : corte.efectivo_contado));
  L.push(fila('DIFERENCIA', dif));
  if (dif !== 0) L.push(centrar(etiquetaDif));
  if (s.arqueo?.modo === 'denominaciones') {
    L.push('');
    L.push('Conteo:');
    for (const d of DENOMINACIONES) {
      const n = Number(s.arqueo.denominaciones?.[d]) || 0;
      if (n > 0) L.push(fila(`  ${n} x $${d}`, n * d));
    }
    if (Number(s.arqueo.monedas) > 0) L.push(fila('  Monedas', s.arqueo.monedas));
  }
  L.push('');
  L.push(`Cancelaciones: ${corte.cancelaciones_count}`);
  if (Array.isArray(s.cobros_dias_anteriores) && s.cobros_dias_anteriores.length) {
    // Trazabilidad de la regla de pagos tardíos: se ve en el papel de qué
    // día venía cada peso que se reconoció hoy.
    L.push('');
    L.push('Cobrado de dias anteriores:');
    for (const c of s.cobros_dias_anteriores.slice(0, 12)) {
      L.push(fila(`  ${c.folio} (${c.fecha_original || '?'})`, c.monto));
    }
  }
  if (corte.nota) { L.push(''); L.push(`Nota: ${String(corte.nota).slice(0, 120)}`); }
  L.push('');
  L.push(centrar('CORTE CERRADO'));
  L.push(centrar(`${fechaCorta} ${hora}`));
  return L.join('\n');
}
