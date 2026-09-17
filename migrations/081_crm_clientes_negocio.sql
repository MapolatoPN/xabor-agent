-- ─── 081: el CRM lee clientes_negocio; cada teléfono que pidió es cliente ──
-- Idempotente y re-ejecutable. Aditiva: un índice y un backfill que SOLO
-- inserta filas nuevas en clientes_negocio (ON CONFLICT DO NOTHING). No
-- toca clientes, perfiles_clientes, pedidos ni Rewards.
--
-- QUÉ RESUELVE: el tab Clientes del panel leía `clientes` (PK global por
-- teléfono, first-seen-wins entre negocios) y `perfiles_clientes` (métricas
-- calculadas SIN filtrar negocio). A partir de aquí la fuente de verdad del
-- CRM es `clientes_negocio` (080): una fila por (negocio, teléfono a 10
-- dígitos). La relación negocio↔teléfono se deriva de evidencia que ya es
-- por negocio -- `pedidos_activos.negocio_id` -- nunca de `clientes.negocio_id`.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 081_crm_clientes_negocio.sql

-- ── Índice de expresión: (negocio, teléfono del pedido a 10 dígitos) ──────
-- WhatsApp guarda el teléfono como 521XXXXXXXXXX y POS/tienda como 10
-- dígitos: la única forma de casar pedidos con clientes es normalizar. Con
-- este índice las métricas por cliente y el historial de pedidos de la
-- ficha no recorren la tabla.
CREATE INDEX IF NOT EXISTS idx_pedidos_activos_negocio_tel10
  ON pedidos_activos (negocio_id, (right(regexp_replace(datos->'cliente'->>'telefono', '\D', '', 'g'), 10)))
  WHERE datos->'cliente'->>'telefono' IS NOT NULL;

-- ── Backfill: un cliente por (negocio, teléfono) con pedidos no cancelados ─
-- `origen` = canal del PRIMER pedido en ESE negocio (whatsapp | checkout |
-- voz | mostrador); nombre y teléfono original del pedido más reciente;
-- `created_at` = primera compra (desde cuándo es cliente); ultima_compra_at
-- = última compra. Teléfonos sintéticos (pos-…, rappi-…, '—', cortos) fuera.
-- Las filas que ya existen (registrados en la tienda, migrados de Rewards)
-- no se tocan: DO NOTHING conserva su origen y sus datos.
INSERT INTO clientes_negocio (negocio_id, telefono, telefono_original, nombre, origen, created_at, ultima_compra_at)
SELECT p.negocio_id,
       p.tel10,
       (array_agg(p.tel_raw ORDER BY p.created_at DESC))[1],
       (array_agg(p.nombre ORDER BY p.created_at DESC) FILTER (WHERE p.nombre IS NOT NULL))[1],
       CASE (array_agg(p.canal ORDER BY p.created_at ASC))[1]
         WHEN 'whatsapp' THEN 'whatsapp'
         WHEN 'tienda_online' THEN 'checkout'
         WHEN 'voz' THEN 'voz'
         ELSE 'mostrador'
       END,
       min(p.created_at),
       max(p.created_at)
  FROM (
    SELECT pa.negocio_id, pa.created_at,
           pa.datos->>'canal' AS canal,
           pa.datos->'cliente'->>'telefono' AS tel_raw,
           NULLIF(trim(pa.datos->'cliente'->>'nombre'), '') AS nombre,
           right(regexp_replace(pa.datos->'cliente'->>'telefono', '\D', '', 'g'), 10) AS tel10,
           length(regexp_replace(pa.datos->'cliente'->>'telefono', '\D', '', 'g')) AS ndig
      FROM pedidos_activos pa
     WHERE pa.negocio_id IS NOT NULL
       AND pa.estado <> 'cancelado'
       AND pa.datos->'cliente'->>'telefono' IS NOT NULL
       AND pa.datos->'cliente'->>'telefono' NOT LIKE 'pos-%'
       AND pa.datos->'cliente'->>'telefono' NOT LIKE 'rappi-%'
  ) p
 WHERE p.ndig BETWEEN 10 AND 13
 GROUP BY p.negocio_id, p.tel10
ON CONFLICT (negocio_id, telefono) DO NOTHING;
