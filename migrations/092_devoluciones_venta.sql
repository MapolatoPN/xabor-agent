-- 092 — Ledger append-only de devoluciones por venta.
--
-- pedidos_activos.datos.devolucion fue históricamente un solo objeto y cada
-- nueva devolución lo sobrescribía. Este ledger conserva cada aplicación sin
-- reescribir la venta original. El JSON existente sigue siendo una vista de
-- compatibilidad; no se reconstruyen motivos que ya no estén guardados.

CREATE TABLE IF NOT EXISTS venta_devoluciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  folio         TEXT NOT NULL,
  monto         NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  motivo        TEXT NULL,
  usuario_id    UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  fuente        TEXT NOT NULL DEFAULT 'panel'
                CHECK (fuente IN ('panel', 'legacy_json', 'sistema')),
  legacy_key    TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_venta_devoluciones_negocio_folio
  ON venta_devoluciones (negocio_id, folio, created_at);

-- El backfill es sólo de la evidencia que todavía existe en el JSON. La
-- clave evita duplicarla si el predeploy se ejecuta más de una vez.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venta_devoluciones_legacy
  ON venta_devoluciones (negocio_id, folio, fuente, legacy_key)
  WHERE legacy_key IS NOT NULL;

INSERT INTO venta_devoluciones
  (negocio_id, folio, monto, motivo, usuario_id, fuente, legacy_key, created_at)
SELECT
  p.negocio_id,
  p.folio,
  (p.datos->'devolucion'->>'monto')::numeric,
  NULLIF(p.datos->'devolucion'->>'motivo', ''),
  CASE WHEN p.datos->'devolucion'->>'usuario_id'
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN (p.datos->'devolucion'->>'usuario_id')::uuid END,
  'legacy_json',
  'devolucion-json',
  COALESCE(
    CASE WHEN p.datos->'devolucion'->>'timestamp' ~
              '^\d{4}-\d{2}-\d{2}T'
         THEN (p.datos->'devolucion'->>'timestamp')::timestamptz END,
    p.updated_at,
    p.created_at,
    NOW()
  )
FROM pedidos_activos p
WHERE jsonb_typeof(p.datos->'devolucion') = 'object'
  AND (p.datos->'devolucion'->>'monto') ~ '^[0-9]+(\.[0-9]+)?$'
  AND (p.datos->'devolucion'->>'monto')::numeric > 0
ON CONFLICT DO NOTHING;
