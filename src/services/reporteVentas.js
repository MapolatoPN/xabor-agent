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

const DIA_MS = 24 * 60 * 60 * 1000;

// Todo se suma en centavos enteros: 2,168 sumas de flotantes se desvían.
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

function contarModalidad(cont, datos) {
  const m = String(datos?.modalidad || '').toLowerCase();
  if (m.includes('domicilio')) cont.domicilios++;
  if (m.includes('recoger') || m.includes('tienda')) cont.recoger++;
  if (m === 'mesa' || datos?.canal === 'restaurante_mesa') cont.restaurante++;
}

/**
 * Arma el reporte con pedidos ya leídos de UN negocio. Función pura: la usa
 * obtenerReporteVentas y la prueban las suites sin base.
 * filas: [{ folio, estado, datos, creado_at }]
 */
export function construirReporteVentas(filas = []) {
  const ventas = [];
  const t = { bruta: 0, descuento: 0, envio: 0, neta: 0, propinas: 0, plataforma: 0 };
  const fuera = {
    cancelado: { num: 0, total: 0 },
    por_cobrar: { num: 0, total: 0 },
    sin_consumo: { num: 0, total: 0 },
  };
  const modalidades = { domicilios: 0, recoger: 0, restaurante: 0 };
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
    ventas.push({
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
    });
  }
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
    ventas,
  };
}

/**
 * Reporte de ventas de UN negocio entre dos días operativos (inclusive), en
 * la zona del negocio. negocioId OBLIGATORIO: sin él falla cerrado, nunca
 * consulta global.
 */
export async function obtenerReporteVentas({ negocioId, desde, hasta, tz } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  if (!esZonaValida(tz)) { const e = new Error('zona horaria inválida'); e.code = 'ZONA_INVALIDA'; throw e; }
  if (!esFechaValida(desde) || !esFechaValida(hasta) || desde > hasta) {
    const e = new Error('rango inválido'); e.code = 'RANGO_INVALIDO'; throw e;
  }
  const nid = negocioId.trim();
  const inicio = rangoUtcDeFecha(desde, tz).inicio;
  const fin = rangoUtcDeFecha(hasta, tz).fin;
  // Cadenas ISO, nunca Date: contra una columna sin zona node-pg mandaría la
  // hora local de la máquina. Fin EXCLUSIVO: antes «hasta 23:59:59» dejaba
  // fuera el último segundo del día. Solo viajan los campos que se usan.
  const { rows } = await pool.query(`
    SELECT folio, estado,
           (created_at AT TIME ZONE 'UTC') AS creado_at,
           jsonb_build_object(
             'total', datos->'total', 'subtotal', datos->'subtotal',
             'costo_envio', datos->'costo_envio', 'descuento', datos->'descuento',
             'forma_pago', datos->'forma_pago', 'pago_confirmado', datos->'pago_confirmado',
             'canal', datos->'canal', 'modalidad', datos->'modalidad',
             'cliente', jsonb_build_object('nombre', datos->'cliente'->'nombre', 'telefono', datos->'cliente'->'telefono'),
             'items', datos->'items', 'propinas', datos->'propinas', 'propina', datos->'propina',
             'pagos', datos->'pagos'
           ) AS datos
      FROM pedidos_activos
     WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3
     ORDER BY created_at DESC
  `, [nid, inicio.toISOString(), fin.toISOString()]);
  return {
    timezone: tz,
    rango: { desde, hasta, inicio_utc: inicio.toISOString(), fin_utc: fin.toISOString() },
    ...construirReporteVentas(rows),
  };
}
