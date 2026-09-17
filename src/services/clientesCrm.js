// ─── CRM de clientes por negocio ───────────────────────────────────────────
//
// Lo que el dueño ve en Clientes. La fuente de verdad es `clientes_negocio`
// (080): una persona por (negocio, teléfono a 10 dígitos). `clientes` y
// `perfiles_clientes` siguen existiendo para WhatsApp, pero aquí NO definen
// quién es cliente ni cuánto ha comprado.
//
// LO QUE ESTE MÓDULO GARANTIZA:
//
//   · Cada consulta lleva `negocio_id`, y las métricas (pedidos, gastado,
//     ticket, primera y última compra) se calculan desde pedidos_activos
//     FILTRANDO el negocio. La misma persona en dos negocios son dos filas
//     con dos historias.
//
//   · El teléfono de un pedido se casa con el cliente normalizado a 10
//     dígitos (WhatsApp guarda 521…, POS/tienda 10): mismo criterio que la
//     080 y que normalizarTelefonoMX. Usa el índice de expresión de la 081.
//
//   · El segmento se deriva con LAS MISMAS reglas que memory.js aplica al
//     perfil de WhatsApp (VIP ≥10 pedidos o ≥$3000; frecuente ≥3; dormido
//     >45/30 días; en riesgo por score de abandono), pero sobre las cifras
//     del negocio. Sin compras: 'nuevo'.
//
//   · Rewards, direcciones y consentimientos se LEEN con las funciones que
//     ya usa la cuenta del cliente en la tienda: no hay un segundo motor.
import { pool } from './database.js';
import {
  obtenerClientePorId, rewardsDelCliente, listarDirecciones, direccionPublica, consentimientosVigentes,
} from './clientesNegocio.js';
import { cerrarTodasLasSesiones } from './clienteAuth.js';

const TEL10 = `right(regexp_replace(pa.datos->'cliente'->>'telefono', '\\D', '', 'g'), 10)`;
const NDIG = `length(regexp_replace(pa.datos->'cliente'->>'telefono', '\\D', '', 'g'))`;

// De qué canal viene el primer pedido → de dónde "es" el cliente. Es la
// misma tabla de la 081; se repite aquí para el reconciliador.
const ORIGEN_DE_CANAL = `CASE $CANAL WHEN 'whatsapp' THEN 'whatsapp' WHEN 'tienda_online' THEN 'checkout' WHEN 'voz' THEN 'voz' ELSE 'mostrador' END`;

// Todo lo que la lista, la ficha y el resumen necesitan, en un solo bloque
// CTE parametrizado por $1 = negocio. Las filas finales viven en `seg`.
const SQL_BASE = `
WITH pedidos AS (
  SELECT ${TEL10} AS tel10, (pa.datos->>'total')::numeric AS total, pa.created_at
    FROM pedidos_activos pa
   WHERE pa.negocio_id = $1 AND pa.estado <> 'cancelado'
     AND pa.datos->'cliente'->>'telefono' IS NOT NULL
), metricas AS (
  SELECT tel10, count(*)::int AS pedidos, COALESCE(sum(total), 0)::float AS total_gastado,
         COALESCE(avg(total), 0)::float AS ticket_promedio,
         min(created_at) AS primera_compra, max(created_at) AS ultima_compra
    FROM pedidos GROUP BY tel10
), consent AS (
  SELECT DISTINCT ON (cliente_id, canal) cliente_id, canal, otorgado, created_at, fuente
    FROM cliente_consentimientos WHERE negocio_id = $1
   ORDER BY cliente_id, canal, created_at DESC
), base AS (
  SELECT c.id, c.nombre, c.telefono, c.email, c.origen, c.created_at AS alta,
         COALESCE(m.pedidos, 0) AS pedidos,
         COALESCE(m.total_gastado, 0) AS total_gastado,
         COALESCE(m.ticket_promedio, 0) AS ticket_promedio,
         m.primera_compra, m.ultima_compra,
         EXISTS (SELECT 1 FROM cliente_sesiones s WHERE s.cliente_id = c.id) AS registrado,
         COALESCE((SELECT sum(ra.puntos_balance) FROM rewards_accounts ra WHERE ra.cliente_id = c.id AND ra.activo), 0)::int AS puntos,
         EXISTS (SELECT 1 FROM rewards_accounts ra WHERE ra.cliente_id = c.id) AS con_rewards,
         COALESCE(cw.otorgado, FALSE) AS consent_whatsapp,
         COALESCE(ce.otorgado, FALSE) AS consent_email,
         CASE WHEN m.ultima_compra IS NULL THEN NULL ELSE (CURRENT_DATE - m.ultima_compra::date) END AS dias_sin_comprar,
         CASE WHEN COALESCE(m.pedidos, 0) > 1
              THEN EXTRACT(EPOCH FROM (m.ultima_compra - m.primera_compra)) / 86400 / (m.pedidos - 1) END AS dias_entre_compras
    FROM clientes_negocio c
    LEFT JOIN metricas m ON m.tel10 = c.telefono
    LEFT JOIN consent cw ON cw.cliente_id = c.id AND cw.canal = 'whatsapp'
    LEFT JOIN consent ce ON ce.cliente_id = c.id AND ce.canal = 'email'
   WHERE c.negocio_id = $1
), puntuado AS (
  SELECT b.*,
         CASE WHEN b.dias_entre_compras > 0 THEN LEAST(100, round(b.dias_sin_comprar / (b.dias_entre_compras * 2) * 100))
              WHEN COALESCE(b.dias_sin_comprar, 0) > 30 THEN LEAST(100, b.dias_sin_comprar)
              ELSE 0 END AS score_abandono
    FROM base b
), seg AS (
  SELECT p.*,
         CASE WHEN p.pedidos >= 10 OR p.total_gastado >= 3000 THEN 'vip'
              WHEN p.pedidos >= 3 THEN CASE WHEN p.dias_sin_comprar > 45 THEN 'dormido'
                                            WHEN p.score_abandono >= 70 THEN 'en_riesgo'
                                            ELSE 'frecuente' END
              WHEN p.pedidos >= 1 THEN CASE WHEN p.dias_sin_comprar > 30 THEN 'dormido' ELSE 'frecuente' END
              ELSE 'nuevo' END AS segmento
    FROM puntuado p
)`;

const ORIGENES = ['tienda', 'rewards', 'whatsapp', 'checkout', 'mostrador', 'voz'];
const SEGMENTOS = ['nuevo', 'frecuente', 'vip', 'en_riesgo', 'dormido'];
const ORDENES = {
  total: 'total_gastado DESC NULLS LAST, alta DESC',
  ultima: 'ultima_compra DESC NULLS LAST, alta DESC',
  alta: 'alta DESC',
  pedidos: 'pedidos DESC, alta DESC',
  nombre: 'lower(nombre) ASC NULLS LAST',
  puntos: 'puntos DESC, alta DESC',
};

function fila(r) {
  return {
    id: r.id, nombre: r.nombre, telefono: r.telefono, email: r.email, origen: r.origen,
    alta: r.alta, primeraCompra: r.primera_compra, ultimaCompra: r.ultima_compra,
    pedidos: r.pedidos, totalGastado: Number(r.total_gastado) || 0, ticketPromedio: Number(r.ticket_promedio) || 0,
    registrado: r.registrado === true, conRewards: r.con_rewards === true, puntos: r.puntos,
    consentWhatsapp: r.consent_whatsapp === true, consentEmail: r.consent_email === true,
    segmento: r.segmento, diasSinComprar: r.dias_sin_comprar,
  };
}

const siNo = (v) => v === 'si' || v === 'true' || v === '1' ? true : v === 'no' || v === 'false' || v === '0' ? false : null;
const fechaValida = (v) => v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null;

/**
 * Lista paginada con búsqueda y filtros. Todo se filtra en SQL (nunca en el
 * navegador) y siempre dentro del negocio de la sesión.
 */
export async function listarClientesCrm(negocioId, filtros = {}) {
  const params = [negocioId];
  const where = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  const q = String(filtros.q || '').trim().slice(0, 80);
  if (q) {
    const digitos = q.replace(/\D/g, '');
    const partes = [`nombre ILIKE ${p('%' + q + '%')}`, `email ILIKE ${p('%' + q.toLowerCase() + '%')}`];
    if (digitos.length >= 3) partes.push(`telefono LIKE ${p('%' + digitos.slice(-10) + '%')}`);
    where.push(`(${partes.join(' OR ')})`);
  }
  if (ORIGENES.includes(filtros.origen)) where.push(`origen = ${p(filtros.origen)}`);
  if (SEGMENTOS.includes(filtros.segmento)) where.push(`segmento = ${p(filtros.segmento)}`);
  const registrado = siNo(filtros.registrado); if (registrado !== null) where.push(`registrado = ${p(registrado)}`);
  const rewards = siNo(filtros.rewards); if (rewards !== null) where.push(`con_rewards = ${p(rewards)}`);
  const cw = siNo(filtros.consent_wa); if (cw !== null) where.push(`consent_whatsapp = ${p(cw)}`);
  const ce = siNo(filtros.consent_email); if (ce !== null) where.push(`consent_email = ${p(ce)}`);
  const desde = fechaValida(filtros.ultima_desde); if (desde) where.push(`ultima_compra >= ${p(desde)}::date`);
  const hasta = fechaValida(filtros.ultima_hasta); if (hasta) where.push(`ultima_compra < (${p(hasta)}::date + 1)`);
  const compro = siNo(filtros.compro); if (compro !== null) where.push(compro ? 'pedidos > 0' : 'pedidos = 0');

  const limit = Math.min(100, Math.max(1, parseInt(filtros.limit, 10) || 50));
  const page = Math.max(1, parseInt(filtros.page, 10) || 1);
  const orden = ORDENES[filtros.orden] || ORDENES.total;

  const { rows } = await pool.query(
    `${SQL_BASE}
     SELECT *, count(*) OVER() AS total_filas FROM seg
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orden}
      LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`, params);
  const total = rows.length ? parseInt(rows[0].total_filas, 10) : (page > 1 ? await contar(negocioId, where, params.slice(0, params.length - 2)) : 0);
  return { clientes: rows.map(fila), total, page, limit, paginas: Math.max(1, Math.ceil(total / limit)) };
}

// Solo se usa cuando una página vacía (más allá de la última) deja sin
// `count(*) OVER()`: el total sigue siendo el de los filtros.
async function contar(negocioId, where, params) {
  const { rows: [r] } = await pool.query(
    `${SQL_BASE} SELECT count(*)::int AS n FROM seg ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params);
  return r.n;
}

/** Tarjetas superiores del tab. */
export async function resumenClientesCrm(negocioId) {
  const { rows: [r] } = await pool.query(
    `${SQL_BASE}
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE registrado)::int AS registrados,
            count(*) FILTER (WHERE con_rewards)::int AS con_rewards,
            count(*) FILTER (WHERE consent_whatsapp)::int AS consent_whatsapp,
            count(*) FILTER (WHERE consent_email)::int AS consent_email,
            count(*) FILTER (WHERE ultima_compra >= NOW() - INTERVAL '30 days')::int AS compraron_30d,
            count(*) FILTER (WHERE alta >= NOW() - INTERVAL '30 days')::int AS nuevos_30d,
            count(*) FILTER (WHERE pedidos = 0)::int AS sin_compras,
            COALESCE(sum(puntos), 0)::int AS puntos_vivos
       FROM seg`, [negocioId]);
  return r;
}

/**
 * Ficha completa. `id` se busca SIEMPRE junto con el negocio: un id ajeno o
 * inventado devuelve null (404), nunca datos de otro negocio.
 */
export async function fichaClienteCrm(negocioId, clienteId) {
  const c = await obtenerClientePorId(negocioId, clienteId);
  if (!c) return null;
  const [{ rows: [m] }, rewards, direcciones, consentimientos, pedidos, { rows: [ses] }] = await Promise.all([
    pool.query(`${SQL_BASE} SELECT * FROM seg WHERE id = $2`, [negocioId, clienteId]),
    rewardsDelCliente(negocioId, c),
    listarDirecciones(negocioId, clienteId),
    consentimientosVigentes(negocioId, clienteId),
    pedidosDelClienteCrm(negocioId, c.telefono),
    pool.query(
      `SELECT count(*) FILTER (WHERE revocada_at IS NULL AND expires_at > NOW())::int AS activas,
              max(ultimo_uso_at) AS ultimo_uso, min(created_at) AS primera
         FROM cliente_sesiones WHERE negocio_id = $1 AND cliente_id = $2`, [negocioId, clienteId]),
  ]);
  return {
    cliente: { ...fila(m || { id: c.id, nombre: c.nombre, telefono: c.telefono, email: c.email, origen: c.origen, alta: c.created_at, pedidos: 0, total_gastado: 0, ticket_promedio: 0, puntos: 0, segmento: 'nuevo' }), telefonoOriginal: c.telefono_original || null },
    rewards,
    direcciones: direcciones.map(direccionPublica),
    consentimientos,
    pedidos,
    sesiones: { activas: ses?.activas || 0, ultimoUso: ses?.ultimo_uso || null, registradoDesde: ses?.primera || null },
  };
}

// Todos los pedidos del negocio con el teléfono del cliente, de cualquier
// canal (WhatsApp, mostrador, tienda). No es la lista que ve el propio
// cliente en la tienda (esa se limita a lo suyo por sesión); esta es la del
// dueño, dentro de su negocio.
export async function pedidosDelClienteCrm(negocioId, telefono, limite = 50) {
  const { rows } = await pool.query(
    `SELECT pa.folio, pa.estado, pa.created_at, pa.datos->>'canal' AS canal, pa.datos->>'modalidad' AS modalidad,
            (pa.datos->>'total')::float AS total, pa.datos->>'forma_pago' AS forma_pago,
            jsonb_array_length(COALESCE(pa.datos->'items', '[]'::jsonb)) AS articulos, tp.tracking_token
       FROM pedidos_activos pa
       LEFT JOIN tienda_pedidos tp ON tp.negocio_id = pa.negocio_id AND tp.pedido_folio = pa.folio
      WHERE pa.negocio_id = $1 AND ${TEL10} = $2
      ORDER BY pa.created_at DESC LIMIT $3`, [negocioId, telefono, limite]);
  return rows.map(r => ({
    folio: r.folio, estado: r.estado, fecha: r.created_at, canal: r.canal || null,
    modalidad: String(r.modalidad || '').includes('domicilio') ? 'domicilio' : (String(r.modalidad || '').includes('mesa') ? 'mesa' : 'recoger'),
    total: Number(r.total) || 0, formaPago: r.forma_pago || null, articulos: r.articulos || 0,
    seguimiento: r.tracking_token ? `/seguimiento/${r.tracking_token}` : null,
  }));
}

export async function cerrarSesionesClienteCrm(negocioId, clienteId) {
  const c = await obtenerClientePorId(negocioId, clienteId);
  if (!c) return null;
  await cerrarTodasLasSesiones(negocioId, clienteId);
  return true;
}

/**
 * Reconciliador en segundo plano: cada teléfono real que pidió en un negocio
 * es cliente de ese negocio. Mira solo los pedidos recientes (ventana
 * generosa y solapada) y solo INSERTA lo que falte -- es la misma consulta
 * que el backfill de la 081, idempotente por la UNIQUE (negocio, teléfono).
 * Nunca corre en el camino síncrono de un pedido.
 */
export async function reconciliarClientesDesdePedidos(ventana = '6 hours') {
  const { rowCount } = await pool.query(
    `INSERT INTO clientes_negocio (negocio_id, telefono, telefono_original, nombre, origen, created_at, ultima_compra_at)
     SELECT p.negocio_id, p.tel10,
            (array_agg(p.tel_raw ORDER BY p.created_at DESC))[1],
            (array_agg(p.nombre ORDER BY p.created_at DESC) FILTER (WHERE p.nombre IS NOT NULL))[1],
            ${ORIGEN_DE_CANAL.replace('$CANAL', '(array_agg(p.canal ORDER BY p.created_at ASC))[1]')},
            min(p.created_at), max(p.created_at)
       FROM (
         SELECT pa.negocio_id, pa.created_at, pa.datos->>'canal' AS canal,
                pa.datos->'cliente'->>'telefono' AS tel_raw,
                NULLIF(trim(pa.datos->'cliente'->>'nombre'), '') AS nombre,
                ${TEL10} AS tel10, ${NDIG} AS ndig
           FROM pedidos_activos pa
          WHERE pa.negocio_id IS NOT NULL AND pa.estado <> 'cancelado'
            AND pa.created_at > NOW() - $1::interval
            AND pa.datos->'cliente'->>'telefono' IS NOT NULL
            AND pa.datos->'cliente'->>'telefono' NOT LIKE 'pos-%'
            AND pa.datos->'cliente'->>'telefono' NOT LIKE 'rappi-%'
       ) p
      WHERE p.ndig BETWEEN 10 AND 13
      GROUP BY p.negocio_id, p.tel10
     ON CONFLICT (negocio_id, telefono) DO NOTHING`, [ventana]);
  if (rowCount) console.log(`[CRM] ${rowCount} cliente(s) nuevo(s) desde pedidos recientes`);
  return rowCount;
}
