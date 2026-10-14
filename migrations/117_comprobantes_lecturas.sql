-- Evidencia visual y comparación: no modifica pedidos ni el ledger de pagos.
CREATE TABLE IF NOT EXISTS comprobantes_lecturas (
  negocio_id uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  documento_id uuid NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  telefono text NOT NULL,
  estado text NOT NULL CHECK (estado IN ('procesando','listo')),
  lease_hasta timestamptz NOT NULL,
  analisis jsonb,
  comparacion jsonb,
  folio text,
  acuse_clave text,
  revision_confirmada_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(negocio_id,documento_id)
);
