// ─── Registro de líneas estructuradas: lectura y escritura (Fase 2) ──────
//
// Llena pedido_lineas_pedidos / pedido_lineas / pedido_linea_modificadores a
// partir de las ventas (pedidos_activos) y de Temporada, con la lectura pura
// de lineasEstructuradas.js. Lo usan:
//   · el proceso en segundo plano de server.js, cada 5 minutos, solo para los
//     negocios con la bandera `lineas_estructuradas` encendida y solo los
//     pedidos de los últimos DIAS_VENTANA días;
//   · el relleno histórico (scripts/rellenar-lineas-estructuradas.mjs), con
//     modo de prueba;
//   · la pantalla «Rappi › Opciones sin clasificar», que rehace los pedidos
//     de Rappi afectados por un emparejamiento a mano.
//
// Garantías:
//   · La venta nunca se escribe: de pedidos_activos, temporada_pedidos y
//     restaurante_cuenta_items solo se LEE.
//   · Cada consulta va filtrada por negocio_id; el menú y los emparejamientos
//     que se usan son SOLO los de ese negocio.
//   · Idempotente: cada pedido guarda la firma de sus artículos (con la
//     versión de la lectura). Si no cambió, no se vuelve a tocar.
//   · Nunca en el camino del pedido: si esto falla, el pedido ya se tomó y
//     se imprimió; solo se atrasa el registro.
import { pool } from './database.js';
import {
  VERSION_REGISTRO, CANAL_MESA, CANAL_TEMPORADA,
  indexarCatalogo, estructurarVenta, estructurarTemporada, resumenDeLineas,
} from './lineasEstructuradas.js';

export const BANDERA = 'lineas_estructuradas';
export const DIAS_VENTANA = 14;
const LOTE = 200;
const DESDE_SIEMPRE = new Date('2000-01-01T00:00:00Z');
const HASTA_SIEMPRE = new Date('2100-01-01T00:00:00Z');
const PREFIJO_TEMPORADA = 'temporada-';

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !/^[0-9a-f-]{36}$/i.test(negocioId)) {
    throw new Error('lineasEstructuradas: negocioId inválido');
  }
  return negocioId;
}

export async function banderaEncendida(negocioId, db = pool) {
  const { rows } = await db.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [exigirNegocio(negocioId), BANDERA]);
  return String(rows[0]?.valor ?? '').trim() === 'true';
}

// El menú de ESE negocio, con sus grupos y opciones. `tipo` se lee por
// to_jsonb para que, sin la 151, la lectura no truene (todo es 'platillo').
export async function cargarCatalogo(db, negocioId) {
  const nid = exigirNegocio(negocioId);
  const { rows: productos } = await db.query(
    `SELECT p.id, p.nombre, to_jsonb(p)->>'tipo' AS tipo, p.opciones, to_jsonb(p)->>'codigo' AS codigo
       FROM menu_productos p WHERE p.negocio_id = $1`, [nid]);
  const { rows } = await db.query(
    `SELECT g.id, g.producto_id, g.nombre, o.id AS opcion_id, o.nombre AS opcion, o.precio_extra
       FROM menu_modificadores_grupos g
       LEFT JOIN menu_modificadores_opciones o ON o.grupo_id = g.id AND o.negocio_id = g.negocio_id
      WHERE g.negocio_id = $1
      ORDER BY g.id, o.orden, o.id`, [nid]);
  const grupos = new Map();
  for (const r of rows) {
    if (!grupos.has(r.id)) grupos.set(r.id, { id: r.id, producto_id: r.producto_id, nombre: r.nombre, opciones: [] });
    if (r.opcion_id !== null) grupos.get(r.id).opciones.push({ id: r.opcion_id, nombre: r.opcion, precio_extra: r.precio_extra });
  }
  return indexarCatalogo({ productos, grupos: [...grupos.values()] });
}

export async function hayTabla(db, nombre) {
  const { rows: [r] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.${nombre}`]);
  return r.hay;
}

export async function cargarEmparejamientos(db, negocioId) {
  const mapa = new Map();
  if (!(await hayTabla(db, 'rappi_emparejamientos'))) return mapa;
  const { rows } = await db.query(
    `SELECT producto_rappi, opcion_rappi, producto_id, grupo_id, opcion_id
       FROM rappi_emparejamientos WHERE negocio_id = $1`, [exigirNegocio(negocioId)]);
  for (const r of rows) mapa.set(`${r.producto_rappi}|${r.opcion_rappi}`, r);
  return mapa;
}

// Ventas cuyo registro falta o quedó viejo, en orden y por páginas (el
// cursor evita repetir en el modo de prueba, que no escribe).
// conRegistro = false: la base todavía no tiene la 151 (el ensayo de solo
// lectura en producción antes de migrar); todo cuenta como pendiente.
// `lote`: filas por página (las pruebas usan páginas chicas para recorrer el
// cursor; nunca más de LOTE).
const tamanoLote = (lote) => (Number.isInteger(lote) && lote > 0 && lote <= LOTE ? lote : LOTE);

async function ventasPendientes(db, negocioId, { desde, hasta, cursor, folios, todas, conRegistro = true, lote = LOTE }) {
  const firma = `'${VERSION_REGISTRO}:' || md5(COALESCE(pa.datos->'items', '[]'::jsonb)::text)`;
  const union = conRegistro
    ? 'LEFT JOIN pedido_lineas_pedidos h ON h.negocio_id = pa.negocio_id AND h.folio = pa.folio'
    : '';
  const pendiente = conRegistro ? `($7::boolean OR h.folio IS NULL OR h.firma <> ${firma})` : '($7::boolean OR TRUE)';
  // El cursor viaja como TEXTO: created_at es `timestamp` sin zona, y pasarlo
  // por un Date de JavaScript lo corre tantas horas como la zona del proceso
  // (con TZ=America/Matamoros, la página siguiente se saltaría seis horas).
  const { rows } = await db.query(
    `SELECT pa.folio, pa.created_at::text AS cursor_ts, COALESCE(pa.datos->>'canal', '?') AS canal,
            pa.datos->'items' AS items, pa.datos->>'cuenta_id' AS cuenta_id, ${firma} AS firma
       FROM pedidos_activos pa
       ${union}
      WHERE pa.negocio_id = $1
        AND pa.created_at >= $2 AND pa.created_at < $3
        AND ($4::text IS NULL OR (pa.created_at, pa.folio) > ($4::text::timestamp, $5::text))
        AND ($6::text[] IS NULL OR pa.folio = ANY($6::text[]))
        AND ${pendiente}
      ORDER BY pa.created_at, pa.folio
      LIMIT ${tamanoLote(lote)}`,
    [negocioId, desde, hasta, cursor?.cursor_ts ?? null, cursor?.folio ?? '', folios ?? null, todas === true]);
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Los artículos de las cuentas de mesa de este lote (sin los cancelados, igual
// que el cierre). producto_id y modificadores_det por to_jsonb: sin la 151 no
// existen y la lectura sigue.
async function articulosDeCuentas(db, negocioId, cuentaIds) {
  const ids = [...new Set(cuentaIds.filter((id) => UUID.test(String(id || ''))))];
  const porCuenta = new Map();
  if (!ids.length) return porCuenta;
  const { rows } = await db.query(
    `SELECT i.cuenta_id::text AS cuenta_id, i.producto, i.cantidad, i.precio_unitario, i.modificadores, i.notas,
            NULLIF(to_jsonb(i)->>'producto_id', '')::int AS producto_id, to_jsonb(i)->'modificadores_det' AS modificadores_det
       FROM restaurante_cuenta_items i
      WHERE i.negocio_id = $1 AND i.cuenta_id = ANY($2::uuid[]) AND i.estado <> 'cancelado'
      ORDER BY i.cuenta_id, i.created_at, i.id`, [negocioId, ids]);
  for (const r of rows) {
    if (!porCuenta.has(r.cuenta_id)) porCuenta.set(r.cuenta_id, []);
    porCuenta.get(r.cuenta_id).push(r);
  }
  return porCuenta;
}

async function temporadaPendiente(db, negocioId, { desde, hasta, cursor, todas, conRegistro = true, lote = LOTE }) {
  const firma = `'${VERSION_REGISTRO}:' || md5(concat_ws('|', p.platillos, p.notas, c.producto, c.precio))`;
  const union = conRegistro
    ? `LEFT JOIN pedido_lineas_pedidos h ON h.negocio_id = p.negocio_id AND h.folio = '${PREFIJO_TEMPORADA}' || p.id`
    : '';
  const pendiente = conRegistro ? `($6::boolean OR h.folio IS NULL OR h.firma <> ${firma})` : '($6::boolean OR TRUE)';
  const { rows } = await db.query(
    `SELECT p.id, p.creado_en::text AS cursor_ts, p.platillos, p.notas, c.producto, c.precio, ${firma} AS firma
       FROM temporada_pedidos p
       JOIN temporada_campanas c ON c.id = p.campana_id AND c.negocio_id = p.negocio_id
       ${union}
      WHERE p.negocio_id = $1 AND p.creado_en >= $2 AND p.creado_en < $3
        AND ($4::text IS NULL OR (p.creado_en, p.id) > ($4::text::timestamptz, $5::bigint))
        AND ${pendiente}
      ORDER BY p.creado_en, p.id
      LIMIT ${tamanoLote(lote)}`,
    [negocioId, desde, hasta, cursor?.cursor_ts ?? null, cursor?.id ?? 0, todas === true]);
  return rows;
}

// Escribe un lote de pedidos: borra su registro anterior (cascada a líneas y
// opciones) y lo vuelve a crear, todo en una transacción y con el candado del
// negocio (el proceso y la pantalla de Rappi pueden coincidir).
export async function guardarLote(negocioId, registros, { db = pool } = {}) {
  if (!registros.length) return 0;
  const nid = exigirNegocio(negocioId);
  // Un Pool (el del servidor o el del relleno) presta un cliente para la
  // transacción; un Client ya es una sola conexión.
  const esPool = typeof db.totalCount === 'number';
  const client = esPool ? await db.connect() : db;
  const propio = esPool;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lineas-estructuradas:' || $1, 0))", [nid]);
    const cabeceras = registros.map((r) => ({ folio: r.folio, origen: r.origen, canal: r.canal, firma: r.firma, ...resumenDeLineas(r.lineas) }));
    const lineas = [];
    const mods = [];
    for (const r of registros) {
      for (const l of r.lineas) {
        lineas.push({ folio: r.folio, linea: l.linea, canal: r.canal, producto_id: l.producto_id, nombre: l.nombre, tipo: l.tipo,
          cantidad: l.cantidad, precio_unitario: l.precio_unitario, nota: l.nota, estado: l.estado });
        for (const m of l.modificadores) mods.push({ folio: r.folio, linea: l.linea, ...m });
      }
    }
    await client.query('DELETE FROM pedido_lineas_pedidos WHERE negocio_id = $1 AND folio = ANY($2::text[])',
      [nid, cabeceras.map((c) => c.folio)]);
    await client.query(
      `INSERT INTO pedido_lineas_pedidos (negocio_id, folio, origen, canal, firma, lineas, completas, parciales, sin_estructurar)
       SELECT $1, x.folio, x.origen, x.canal, x.firma, x.lineas, x.completas, x.parciales, x.sin_estructurar
         FROM jsonb_to_recordset($2::jsonb) AS x(folio text, origen text, canal text, firma text,
              lineas int, completas int, parciales int, sin_estructurar int)`,
      [nid, JSON.stringify(cabeceras)]);
    if (lineas.length) {
      await client.query(
        `INSERT INTO pedido_lineas (negocio_id, folio, linea, canal, producto_id, nombre, tipo, cantidad, precio_unitario, nota, estado)
         SELECT $1, x.folio, x.linea, x.canal, x.producto_id, x.nombre, x.tipo, x.cantidad, x.precio_unitario, x.nota, x.estado
           FROM jsonb_to_recordset($2::jsonb) AS x(folio text, linea int, canal text, producto_id int, nombre text, tipo text,
                cantidad numeric, precio_unitario numeric, nota text, estado text)`,
        [nid, JSON.stringify(lineas)]);
    }
    if (mods.length) {
      await client.query(
        `INSERT INTO pedido_linea_modificadores (linea_id, negocio_id, orden, grupo_id, grupo, opcion_id, opcion, cantidad,
                                                 precio_extra, precio_estimado, clasificado)
         SELECT l.id, $1, x.orden, x.grupo_id, x.grupo, x.opcion_id, x.opcion, x.cantidad, x.precio_extra, x.precio_estimado, x.clasificado
           FROM jsonb_to_recordset($2::jsonb) AS x(folio text, linea int, orden int, grupo_id int, grupo text, opcion_id int,
                opcion text, cantidad numeric, precio_extra numeric, precio_estimado boolean, clasificado boolean)
           JOIN pedido_lineas l ON l.negocio_id = $1 AND l.folio = x.folio AND l.linea = x.linea`,
        [nid, JSON.stringify(mods)]);
    }
    await client.query('COMMIT');
    return registros.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (propio) client.release();
  }
}

// El tipo de cada línea es el que su producto tiene HOY en el menú: marcar
// «ENVIO 60» como envío en el editor debe sacar del reporte de productos
// también las ventas de antes, aunque sus artículos (y su firma) no cambien.
// Solo líneas ligadas a un producto que existe en el menú de ESE negocio.
export async function sincronizarTipos(negocioId, { db = pool } = {}) {
  const nid = exigirNegocio(negocioId);
  const esPool = typeof db.totalCount === 'number';
  const client = esPool ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lineas-estructuradas:' || $1, 0))", [nid]);
    const tipoActual = `CASE WHEN p.opciones->>'tipo_item' = 'envio' THEN 'envio' ELSE p.tipo END`;
    const { rowCount } = await client.query(
      `UPDATE pedido_lineas l SET tipo = ${tipoActual}
         FROM menu_productos p
        WHERE l.negocio_id = $1 AND p.negocio_id = $1 AND p.id = l.producto_id
          AND l.tipo IS DISTINCT FROM ${tipoActual}`, [nid]);
    await client.query('COMMIT');
    return rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (esPool) client.release();
  }
}

// Un lote que falla (una venta con un dato que la base no acepta: un precio
// fuera de rango, por ejemplo) se reintenta pedido por pedido: solo se salta
// el que falla y se anota. Así una venta rara no detiene el registro de todo
// el negocio.
async function guardarConRespaldo(nid, registros, db, reporte) {
  try {
    return await guardarLote(nid, registros, { db });
  } catch (e) {
    if (registros.length === 1) {
      reporte.fallidos.push({ folio: registros[0].folio, error: String(e.message).slice(0, 200) });
      console.error(`[Lineas] No se pudo guardar el registro de ${registros[0].folio}: ${e.message}`);
      return 0;
    }
    let escritos = 0;
    for (const r of registros) escritos += await guardarConRespaldo(nid, [r], db, reporte);
    return escritos;
  }
}

// ─── Reporte ─────────────────────────────────────────────────────────────
export function reporteVacio() {
  return { pedidos: 0, escritos: 0, fallidos: [], porCanal: {}, productosNoEncontrados: new Map(), opcionesSinClasificar: new Map() };
}

function anotar(reporte, canal, lineas) {
  const c = reporte.porCanal[canal] ||= { pedidos: 0, lineas: 0, completas: 0, parciales: 0, sin_estructurar: 0,
    modificadores: 0, sin_clasificar: 0 };
  c.pedidos++;
  reporte.pedidos++;
  for (const l of lineas) {
    c.lineas++;
    c[l.estado === 'completa' ? 'completas' : l.estado === 'parcial' ? 'parciales' : 'sin_estructurar']++;
    if (l.estado === 'sin_estructurar') {
      const k = `${canal} · ${l.nombre}`;
      reporte.productosNoEncontrados.set(k, (reporte.productosNoEncontrados.get(k) || 0) + 1);
    }
    for (const m of l.modificadores) {
      c.modificadores++;
      if (m.clasificado) continue;
      c.sin_clasificar++;
      const k = `${canal} · ${l.nombre} › ${m.opcion}`;
      reporte.opcionesSinClasificar.set(k, (reporte.opcionesSinClasificar.get(k) || 0) + 1);
    }
  }
}

/**
 * Estructura (y, con escribir, guarda) los pedidos de UN negocio.
 *   opciones: { desde, hasta, folios, escribir, todas, maxPedidos, db, reporte }
 *   · folios: solo esos (la pantalla de Rappi);
 *   · todas: también los que ya tienen registro al día (el modo de prueba
 *     del relleno los cuenta todos);
 *   · db: el cliente a usar (el relleno en prueba pasa uno READ ONLY).
 */
export async function procesarNegocio(negocioId, {
  desde = DESDE_SIEMPRE, hasta = HASTA_SIEMPRE, folios = null, escribir = true, todas = false,
  maxPedidos = Infinity, db = pool, reporte = reporteVacio(), incluirTemporada = folios === null, lote = LOTE,
} = {}) {
  const nid = exigirNegocio(negocioId);
  const porPagina = tamanoLote(lote);
  const conRegistro = await hayTabla(db, 'pedido_lineas_pedidos');
  if (escribir && !conRegistro) throw new Error('lineasEstructuradas: falta la migración 151 (pedido_lineas_pedidos)');
  const catalogo = await cargarCatalogo(db, nid);
  const emparejamientos = await cargarEmparejamientos(db, nid);
  let vistos = 0;

  let cursor = null;
  while (vistos < maxPedidos) {
    const filas = await ventasPendientes(db, nid, { desde, hasta, cursor, folios, todas, conRegistro, lote: porPagina });
    if (!filas.length) break;
    cursor = filas[filas.length - 1];
    const cuentas = await articulosDeCuentas(db, nid, filas.filter((f) => f.canal === CANAL_MESA).map((f) => f.cuenta_id));
    const registros = filas.map((f) => ({
      folio: f.folio, origen: 'venta', canal: f.canal, firma: f.firma,
      lineas: estructurarVenta({
        canal: f.canal, items: f.items, cuentaItems: f.cuenta_id ? (cuentas.get(f.cuenta_id) || null) : null,
        catalogo, emparejamientos,
      }),
    }));
    for (const r of registros) anotar(reporte, r.canal, r.lineas);
    if (escribir) reporte.escritos += await guardarConRespaldo(nid, registros, db, reporte);
    vistos += filas.length;
    if (filas.length < porPagina) break;
  }

  if (incluirTemporada && await hayTabla(db, 'temporada_pedidos')) {
    cursor = null;
    while (vistos < maxPedidos) {
      const filas = await temporadaPendiente(db, nid, { desde, hasta, cursor, todas, conRegistro, lote: porPagina });
      if (!filas.length) break;
      cursor = filas[filas.length - 1];
      const registros = filas.map((f) => ({
        folio: `${PREFIJO_TEMPORADA}${f.id}`, origen: 'temporada', canal: CANAL_TEMPORADA, firma: f.firma,
        lineas: estructurarTemporada({ pedido: f, campana: { producto: f.producto, precio: f.precio }, catalogo }),
      }));
      for (const r of registros) anotar(reporte, r.canal, r.lineas);
      if (escribir) reporte.escritos += await guardarConRespaldo(nid, registros, db, reporte);
      vistos += filas.length;
      if (filas.length < porPagina) break;
    }
  }
  return reporte;
}

// ─── El proceso de cada 5 minutos ────────────────────────────────────────
let enCurso = false;

export async function procesarNegociosConBandera({ db = pool, ahora = Date.now() } = {}) {
  if (enCurso) return { omitido: true };
  enCurso = true;
  const resultado = { negocios: 0, escritos: 0, fallos: 0 };
  try {
    if (!(await hayTabla(db, 'pedido_lineas_pedidos'))) return resultado;
    const { rows } = await db.query(
      `SELECT c.negocio_id::text AS negocio_id
         FROM configuracion c JOIN negocios n ON n.id = c.negocio_id
        WHERE c.clave = $1 AND btrim(c.valor) = 'true' AND n.activo IS NOT FALSE
        ORDER BY c.negocio_id`, [BANDERA]);
    const desde = new Date(ahora - DIAS_VENTANA * 24 * 60 * 60 * 1000);
    for (const { negocio_id: nid } of rows) {
      try {
        const r = await procesarNegocio(nid, { desde, escribir: true, maxPedidos: 2000, db });
        resultado.negocios++;
        resultado.escritos += r.escritos;
        resultado.tipos = (resultado.tipos || 0) + await sincronizarTipos(nid, { db });
      } catch (e) {
        resultado.fallos++;
        console.error(`[Lineas] No se pudo estructurar el negocio ${nid}: ${e.message}`);
      }
    }
    return resultado;
  } finally {
    enCurso = false;
  }
}
