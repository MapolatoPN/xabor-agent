// Asistente del restaurante, Fase 1: LEE los datos de UNA sucursal para las
// reglas (reglas.js). Todo en una transacción de SOLO LECTURA con tiempo
// máximo: si una consulta intentara escribir, la base la rechaza.
//
// Lo que NUNCA sale de aquí: teléfonos, direcciones, correos ni datos de
// pago. El teléfono se usa DENTRO de la consulta solo para ligar la venta con
// su cliente (clientes_negocio) y se devuelve únicamente el id y el nombre.
// Los clientes internos (es_interno) y los teléfonos del propio negocio
// (negocio_telefonos_propios) no cuentan como clientes.
import { clasificarPedido, importesDePedido, canalDeVenta, fechaYHoraLocal } from '../services/reporteVentas.js';
import { estadoVentaSinCobro, rangoUtcDeFecha } from '../services/cortesCaja.js';
import { obtenerReporteProductos } from '../services/reporteProductos.js';
import { sumarDias, periodosDe } from './reglas.js';

export const DIAS_DE_HISTORIA = 120; // clientes; las demás reglas usan menos
const MINUTOS_LIMITE = '25s';

const pesos = (centavos) => Math.round(Number(centavos) || 0) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const texto = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// El teléfono del pedido a 10 dígitos, DENTRO de SQL. El mismo criterio que
// clientes_negocio.telefono (normalizarTelefonoMX: los últimos 10 dígitos).
const TEL10 = `right(regexp_replace(coalesce(pa.datos->'cliente'->>'telefono', ''), '\\D', '', 'g'), 10)`;
const CLIENTE_REAL = `
  LEFT JOIN clientes_negocio cn
         ON cn.negocio_id = pa.negocio_id AND cn.telefono = ${TEL10}
        AND cn.es_interno = false
        AND NOT EXISTS (SELECT 1 FROM negocio_telefonos_propios tp
                         WHERE tp.negocio_id = pa.negocio_id AND tp.telefono = cn.telefono)`;

// Una conexión que atiende las consultas de una en una, en el orden en que
// llegan (pg no admite dos a la vez sobre el mismo cliente).
function enOrden(db) {
  let cola = Promise.resolve();
  return {
    query(...args) {
      const p = cola.then(() => db.query(...args));
      cola = p.catch(() => {});
      return p;
    },
  };
}

async function leerPedidos(db, nid, desde, hasta, tz) {
  const inicio = rangoUtcDeFecha(desde, tz).inicio.toISOString();
  const fin = rangoUtcDeFecha(hasta, tz).fin.toISOString();
  const { rows } = await db.query(`
    SELECT pa.folio, pa.estado, (pa.created_at AT TIME ZONE 'UTC') AS creado_at,
           cn.id AS cliente_id, cn.nombre AS cliente_nombre_ficha,
           jsonb_build_object(
             'total', pa.datos->'total', 'subtotal', pa.datos->'subtotal',
             'costo_envio', pa.datos->'costo_envio', 'descuento', pa.datos->'descuento',
             'forma_pago', pa.datos->'forma_pago', 'pago_confirmado', pa.datos->'pago_confirmado',
             'canal', pa.datos->'canal', 'modalidad', pa.datos->'modalidad',
             'cliente_nombre', pa.datos->'cliente'->'nombre',
             'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('nombre', i->'nombre', 'cantidad', i->'cantidad', 'precio_unitario', i->'precio_unitario')), '[]'::jsonb)
                         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pa.datos->'items') = 'array' THEN pa.datos->'items' ELSE '[]'::jsonb END) i),
             'descuento_manual', pa.datos->'descuentos'->'manual',
             'tiene_descuentos', (pa.datos ? 'descuentos'),
             'cancelacion', jsonb_build_object('motivo', pa.datos->'cancelacion'->'motivo', 'por', pa.datos->'cancelacion'->'por',
                                               'autorizo', pa.datos->'cancelacion'->'autorizo',
                                               'autorizo_nombre', pa.datos->'cancelacion'->'autorizo_nombre')
           ) AS datos
      FROM pedidos_activos pa
      ${CLIENTE_REAL}
     WHERE pa.negocio_id = $1 AND pa.created_at >= $2 AND pa.created_at < $3
     ORDER BY pa.created_at, pa.folio`, [nid, inicio, fin]);
  return rows;
}

// La primera compra de cada cliente en ESTA sucursal (toda la historia).
async function leerPrimeras(db, nid, hastaUtc) {
  const { rows } = await db.query(`
    SELECT cn.id, MIN(pa.created_at AT TIME ZONE 'UTC') AS primera
      FROM pedidos_activos pa
      JOIN clientes_negocio cn ON cn.negocio_id = pa.negocio_id AND cn.telefono = ${TEL10} AND cn.es_interno = false
     WHERE pa.negocio_id = $1 AND pa.created_at < $2 AND pa.estado <> 'cancelado'
     GROUP BY cn.id`, [nid, hastaUtc]);
  return new Map(rows.map((r) => [r.id, r.primera]));
}

// Platillos cancelados en mesas (con su motivo y quién autorizó).
async function leerEventosMesa(db, nid, inicio, fin) {
  const existe = await db.query(`SELECT to_regclass('public.restaurante_item_eventos') IS NOT NULL AS hay`);
  if (!existe.rows[0]?.hay) return [];
  const { rows } = await db.query(`
    SELECT e.tipo, e.motivo_codigo, e.motivo, (e.cantidad * e.precio_unitario)::float AS importe,
           (e.created_at AT TIME ZONE 'UTC') AS creado_at, ua.nombre AS autorizo
      FROM restaurante_item_eventos e
      LEFT JOIN usuarios ua ON ua.id = e.autorizado_por
     WHERE e.negocio_id = $1 AND e.created_at >= $2 AND e.created_at < $3`, [nid, inicio, fin]);
  return rows;
}

// Nombres de los usuarios del negocio, para «quién autorizó».
async function leerUsuarios(db, nid) {
  const { rows } = await db.query(`
    SELECT u.id, u.nombre FROM usuarios u
     WHERE u.negocio_id = $1
        OR EXISTS (SELECT 1 FROM usuario_negocios un WHERE un.usuario_id = u.id AND un.negocio_id = $1)`, [nid]).catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [r.id, texto(r.nombre) || 'Usuario sin nombre']));
}

async function leerReglasAtencion(db, nid) {
  const { rows } = await db.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'reglas_atencion'`, [nid]);
  try { return JSON.parse(rows[0]?.valor || 'null'); } catch { return null; }
}

/** Una fila de pedido → la venta que leen las reglas (en pesos, sin datos personales). */
export function normalizarVenta(fila, { tz, primeras, usuarios }) {
  const datos = fila.datos || {};
  const clase = clasificarPedido({ folio: fila.folio, estado: fila.estado, datos });
  const imp = importesDePedido(datos);
  const canal = canalDeVenta(datos);
  const local = fechaYHoraLocal(fila.creado_at, tz);
  const instante = fila.creado_at instanceof Date ? fila.creado_at.toISOString() : new Date(fila.creado_at).toISOString();
  const items = Array.isArray(datos.items) ? datos.items : [];
  const sinCobro = estadoVentaSinCobro({ datos, folio: fila.folio, total: num(datos.total), items: null });
  const manual = datos.descuento_manual && typeof datos.descuento_manual === 'object' ? datos.descuento_manual : null;
  // Descuento del personal: el manual (desde que existe datos.descuentos); en
  // pedidos anteriores, el que se deduce de los importes.
  const descuento = datos.tiene_descuentos ? num(manual?.monto) : pesos(imp.descuento);
  const nombreUsuario = (id) => (esUuid(id) ? usuarios.get(id) || 'Usuario de otro negocio' : null);
  const c = datos.cancelacion || {};
  const primera = fila.cliente_id ? primeras.get(fila.cliente_id) : null;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instante));
  return {
    folio: fila.folio, clase, instante,
    fecha: local ? local.fecha : null, hora: hm,
    neta: pesos(imp.neta),
    canal: canal.clave, canal_etiqueta: canal.etiqueta,
    forma_pago: texto(datos.forma_pago, 40),
    n_items: items.length,
    items: items.map((i) => ({ nombre: texto(i?.nombre, 80) || '' })),
    cortesia: !!(sinCobro && sinCobro.estado_cuenta === 'cortesia'),
    cortesia_monto: sinCobro && sinCobro.estado_cuenta === 'cortesia' ? num(sinCobro.monto_real) : 0,
    descuento: Math.max(0, descuento),
    descuento_motivo: texto(manual?.motivo, 80),
    descuento_autorizo: nombreUsuario(manual?.autorizadoPor),
    cancelacion_motivo: texto(c.motivo, 80),
    cancelacion_autorizo: texto(c.autorizo_nombre) || nombreUsuario(c.autorizo) || nombreUsuario(c.por),
    cliente_id: fila.cliente_id || null,
    cliente_nombre: fila.cliente_id ? (texto(fila.cliente_nombre_ficha) || texto(datos.cliente_nombre)) : null,
    cliente_primera: primera ? fechaYHoraLocal(primera, tz)?.fecha || null : null,
    nombre_en_venta: fila.cliente_id ? null : texto(datos.cliente_nombre),
  };
}

/**
 * Todo lo que necesitan las reglas de UNA sucursal. `db` debe ser un cliente
 * propio (pool.connect()): aquí se abre y se cierra la transacción de solo
 * lectura. `negocio`: { id, nombre, tz }. `hoy`: fecha local de la corrida.
 */
export async function leerDatosSucursal(db, { negocio, hoy, ahora = new Date() }) {
  if (!negocio || !esUuid(negocio.id)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const nid = negocio.id;
  const tz = negocio.tz;
  const ayer = sumarDias(hoy, -1);
  const desde = sumarDias(ayer, -(DIAS_DE_HISTORIA - 1));
  const { P } = periodosDe(ayer);
  await db.query('BEGIN READ ONLY');
  try {
    await db.query(`SET LOCAL statement_timeout = '${MINUTOS_LIMITE}'`);
    const finUtc = rangoUtcDeFecha(ayer, tz).fin.toISOString();
    const inicioUtc = rangoUtcDeFecha(desde, tz).inicio.toISOString();
    const usuarios = await leerUsuarios(db, nid);
    const primeras = await leerPrimeras(db, nid, finUtc);
    const filas = await leerPedidos(db, nid, desde, ayer, tz);
    const eventos = await leerEventosMesa(db, nid, rangoUtcDeFecha(sumarDias(ayer, -62), tz).inicio.toISOString(), finUtc);
    const reglasAtencion = await leerReglasAtencion(db, nid);
    const suc = [{ id: nid, nombre: negocio.nombre || '', tz }];
    // El reporte de productos lanza varias consultas a la vez; sobre UNA
    // conexión (la de esta transacción) van en fila.
    const enFila = enOrden(db);
    const prod = await obtenerReporteProductos({ negocios: suc, desde: P.desde, hasta: P.hasta, db: enFila, ahora, conAnterior: true, conTickets: true });
    const menu = await obtenerReporteProductos({ negocios: suc, desde: sumarDias(ayer, -89), hasta: ayer, db: enFila, ahora, conAnterior: false, minimo: 6 });
    await db.query('COMMIT');
    const ventas = filas.map((f) => normalizarVenta(f, { tz, primeras, usuarios }));
    const eventosMesa = eventos.map((e) => ({
      tipo: e.tipo, motivo_codigo: e.motivo_codigo || null, motivo: texto(e.motivo, 80),
      importe: num(e.importe), autorizo: texto(e.autorizo) || null,
      fecha: fechaYHoraLocal(e.creado_at, tz)?.fecha || null,
    }));
    return {
      negocio: { id: nid, nombre: negocio.nombre || '' }, tz, hoy, ayer, ventas, eventosMesa, reglasAtencion,
      productos: prod.tickets ? {
        actual: prod.tickets.actual, anterior: prod.tickets.anterior,
        nombres: { categorias: prod.tickets.categorias, productos: prod.tickets.productos },
        periodoAnterior: prod.periodo_anterior ? { desde: prod.periodo_anterior.desde, hasta: prod.periodo_anterior.hasta } : null,
      } : null,
      menu90: { tickets: menu.cuadre?.tickets || 0, sinMovimiento: menu.sin_movimiento?.productos || [] },
    };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
