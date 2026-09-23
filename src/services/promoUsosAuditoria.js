// Auditoria multicanal de promociones (POS y WhatsApp/Mesero).
//
// Estas filas NO reclaman cupo global ni cupo por cliente: registran, de
// manera idempotente, la promocion que el motor ya otorgo y que quedo guardada
// en el snapshot durable del pedido. La tienda en linea conserva su ciclo
// independiente reserva -> consumo en tiendaPromociones.js.
import pkg from 'pg';

const { Pool } = pkg;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANALES_AUDITADOS = new Set(['pos', 'whatsapp']);
const ESTADOS_CONFIRMADOS = new Set(['nuevo', 'en_preparacion', 'listo', 'entregado']);

function enteroAcotado(nombre, defecto, minimo, maximo) {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) ? Math.max(minimo, Math.min(maximo, Math.trunc(n))) : defecto;
}

let _pool = null;
function poolAuditoria() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: enteroAcotado('XABOR_PROMO_AUDIT_MAX', 2, 1, 5),
      connectionTimeoutMillis: enteroAcotado('XABOR_PROMO_AUDIT_CONNECTION_TIMEOUT_MS', 1_000, 50, 10_000),
      statement_timeout: enteroAcotado('XABOR_PROMO_AUDIT_STATEMENT_TIMEOUT_MS', 1_500, 50, 15_000),
      lock_timeout: enteroAcotado('XABOR_PROMO_AUDIT_LOCK_TIMEOUT_MS', 1_000, 50, 10_000),
      query_timeout: enteroAcotado('XABOR_PROMO_AUDIT_QUERY_TIMEOUT_MS', 2_000, 50, 20_000),
      allowExitOnIdle: true,
    });
  }
  return _pool;
}

function uuid(valor) {
  const s = typeof valor === 'string' ? valor.trim() : '';
  return UUID_RE.test(s) ? s.toLowerCase() : null;
}

function dinero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function telefonoDeAuditoria(pedido = {}) {
  const candidato = pedido?.telefono_conversacion ?? pedido?.cliente?.telefono;
  const digitos = String(candidato ?? '').replace(/\D/g, '');
  return digitos.length >= 10 ? digitos : null;
}

export function debeRegistrarse(pedido = {}, canal = pedido?.canal) {
  return CANALES_AUDITADOS.has(canal)
    && ESTADOS_CONFIRMADOS.has(pedido?.estado)
    && Array.isArray(pedido?.descuentos?.promociones)
    && pedido.descuentos.promociones.length > 0;
}

// Una sola sentencia cubre insercion y observabilidad. Los IDs inexistentes se
// devuelven en `omitidos`; los conflictos idempotentes son promociones validas
// ya registradas y por eso no se reportan como omision.
export async function registrarUsosDeVenta({
  negocioId, folio, promociones = [], telefono = null, montoVenta = 0, canal,
} = {}) {
  if (!CANALES_AUDITADOS.has(canal) || !Array.isArray(promociones) || !promociones.length) {
    return { registrados: 0, omitidos: [] };
  }
  const nid = uuid(negocioId);
  if (!nid) throw new Error('negocioId invalido para auditoria de promociones');
  const pedidoFolio = String(folio || '').trim();
  if (!pedidoFolio) throw new Error('folio requerido para auditoria de promociones');

  const unicas = new Map();
  const omitidosInvalidos = [];
  for (const promo of promociones) {
    const original = promo?.promocionId ?? promo?.id;
    const promocionId = uuid(original);
    if (!promocionId) {
      omitidosInvalidos.push(String(original ?? ''));
      continue;
    }
    if (!unicas.has(promocionId)) {
      unicas.set(promocionId, {
        promocionId,
        campaniaId: uuid(promo?.campaniaId ?? promo?.campania_id),
        monto: dinero(promo?.monto ?? promo?.descuento),
      });
    }
  }

  const entrada = [...unicas.values()];
  if (!entrada.length) return { registrados: 0, omitidos: omitidosInvalidos };

  const { rows: [resultado] } = await poolAuditoria().query({
    text: `
      WITH entrada AS (
        SELECT *
          FROM unnest($2::uuid[], $3::uuid[], $4::numeric[])
               AS e(promocion_id, campania_id, monto_descuento)
      ), validas AS (
        SELECT e.promocion_id, c.id AS campania_id, e.monto_descuento
          FROM entrada e
          JOIN public.tienda_promociones p
            ON p.negocio_id = $1 AND p.id = e.promocion_id
          LEFT JOIN public.tienda_campanas c
            ON c.negocio_id = $1 AND c.id = e.campania_id
      ), insertadas AS (
        INSERT INTO public.tienda_promocion_usos
          (negocio_id, promocion_id, campania_id, pedido_folio,
           cliente_telefono, monto_descuento, monto_venta, estado,
           consumida_at, canal)
        SELECT $1, v.promocion_id, v.campania_id, $5, $6,
               v.monto_descuento, $7, 'consumida', NOW(), $8
          FROM validas v
        ON CONFLICT (negocio_id, promocion_id, pedido_folio) DO NOTHING
        RETURNING promocion_id
      )
      SELECT (SELECT COUNT(*)::int FROM insertadas) AS registrados,
             COALESCE((
               SELECT array_agg(e.promocion_id::text ORDER BY e.promocion_id::text)
                 FROM entrada e
                 LEFT JOIN validas v USING (promocion_id)
                WHERE v.promocion_id IS NULL
             ), ARRAY[]::text[]) AS omitidos`,
    values: [
      nid,
      entrada.map(p => p.promocionId),
      entrada.map(p => p.campaniaId),
      entrada.map(p => p.monto),
      pedidoFolio,
      telefono || null,
      dinero(montoVenta),
      canal,
    ],
  });

  const omitidos = [...new Set([...omitidosInvalidos, ...(resultado?.omitidos || [])])];
  if (omitidos.length) {
    console.warn(`[Promos] ${pedidoFolio}: promociones omitidas por ID invalido/inexistente: ${omitidos.join(', ')}`);
  }
  return { registrados: Number(resultado?.registrados) || 0, omitidos };
}

let reconciliacionEnCurso = false;

// La deteccion devuelve el payload completo de cada promocion faltante y los
// datos del pedido en la MISMA fotografia SQL. Nunca vuelve a consultar la
// campania vigente: campaniaId/monto salen del snapshot historico.
export async function reconciliarUsosPromocionesFaltantes({ limite = 200, presupuestoMs = 30_000 } = {}) {
  if (reconciliacionEnCurso) {
    return { saltada: true, pedidos: 0, filasInsertadas: 0, omitidos: 0, errores: 0 };
  }
  reconciliacionEnCurso = true;
  const inicio = Date.now();
  const maxPedidos = Math.max(1, Math.min(1_000, Math.trunc(Number(limite) || 200)));
  const presupuesto = Math.max(100, Math.min(120_000, Math.trunc(Number(presupuestoMs) || 30_000)));
  try {
    const { rows } = await poolAuditoria().query({
      text: `
        WITH fuentes AS (
          SELECT pa.negocio_id, pa.folio, pa.datos, pa.created_at, 0 AS prioridad
            FROM public.pedidos_activos pa
           WHERE pa.created_at >= NOW() - INTERVAL '48 hours'
             AND pa.estado IN ('nuevo', 'en_preparacion', 'listo', 'entregado')
             AND pa.datos->>'canal' IN ('pos', 'whatsapp')
          UNION ALL
          SELECT pp.negocio_id, pp.folio, pp.datos, pp.created_at, 1 AS prioridad
            FROM public.pedidos_programados pp
           WHERE pp.activado = FALSE
             AND pp.created_at >= NOW() - INTERVAL '48 hours'
             AND pp.datos->>'estado' = 'nuevo'
             AND pp.datos->>'canal' IN ('pos', 'whatsapp')
        ), pedidos AS (
          SELECT DISTINCT ON (negocio_id, folio)
                 negocio_id, folio, datos, created_at
            FROM fuentes
           WHERE negocio_id IS NOT NULL
           ORDER BY negocio_id, folio, prioridad, created_at DESC
        ), promociones_json AS (
          SELECT p.negocio_id, p.folio, p.datos, p.created_at,
                 elem AS promo_json, elem->>'promocionId' AS promocion_texto
            FROM pedidos p
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(p.datos->'descuentos'->'promociones') = 'array'
                  THEN p.datos->'descuentos'->'promociones'
                ELSE '[]'::jsonb
              END
            ) AS elem
        ), promociones_seguras AS (
          SELECT j.*,
                 CASE
                   WHEN j.promocion_texto ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     THEN j.promocion_texto::uuid
                   ELSE NULL::uuid
                 END AS promocion_id
            FROM promociones_json j
        ), esperadas AS (
          SELECT DISTINCT ON (s.negocio_id, s.folio, s.promocion_id)
                 s.negocio_id, s.folio, s.datos, s.created_at,
                 s.promocion_id, s.promo_json
            FROM promociones_seguras s
            JOIN public.tienda_promociones p
              ON p.negocio_id = s.negocio_id AND p.id = s.promocion_id
           WHERE s.promocion_id IS NOT NULL
           ORDER BY s.negocio_id, s.folio, s.promocion_id
        ), faltantes AS (
          SELECT e.*
            FROM esperadas e
            LEFT JOIN public.tienda_promocion_usos u
              ON u.negocio_id = e.negocio_id
             AND u.promocion_id = e.promocion_id
             AND u.pedido_folio = e.folio
           WHERE u.id IS NULL
        ), ordenes AS (
          SELECT negocio_id, folio, MIN(created_at) AS created_at
            FROM faltantes
           GROUP BY negocio_id, folio
           ORDER BY created_at, negocio_id, folio
           LIMIT $1
        )
        SELECT f.negocio_id, f.folio, f.datos, f.promocion_id,
               f.promo_json, o.created_at
          FROM faltantes f
          JOIN ordenes o USING (negocio_id, folio)
         ORDER BY o.created_at, f.negocio_id, f.folio, f.promocion_id`,
      values: [maxPedidos],
    });

    const pedidos = new Map();
    for (const fila of rows) {
      const clave = `${fila.negocio_id}:${fila.folio}`;
      if (!pedidos.has(clave)) {
        pedidos.set(clave, {
          negocioId: fila.negocio_id,
          folio: fila.folio,
          datos: fila.datos || {},
          promociones: [],
        });
      }
      pedidos.get(clave).promociones.push(fila.promo_json);
    }

    let procesados = 0;
    let filasInsertadas = 0;
    let omitidos = 0;
    let errores = 0;
    for (const pedido of pedidos.values()) {
      if (Date.now() - inicio >= presupuesto) break;
      try {
        const r = await registrarUsosDeVenta({
          negocioId: pedido.negocioId,
          folio: pedido.folio,
          promociones: pedido.promociones,
          telefono: telefonoDeAuditoria(pedido.datos),
          montoVenta: pedido.datos?.total,
          canal: pedido.datos?.canal,
        });
        procesados++;
        filasInsertadas += r.registrados;
        omitidos += r.omitidos.length;
      } catch (e) {
        errores++;
        console.error(`[Promos] reconciliacion de ${pedido.folio} fallo:`, e.message);
      }
    }
    return { saltada: false, pedidos: procesados, filasInsertadas, omitidos, errores };
  } finally {
    reconciliacionEnCurso = false;
  }
}

// Solo para arneses locales: permite cerrar la conexion perezosa sin dejar el
// proceso vivo. No borra datos ni altera el comportamiento productivo.
export async function cerrarPoolAuditoria() {
  const actual = _pool;
  _pool = null;
  if (actual) await actual.end();
}
