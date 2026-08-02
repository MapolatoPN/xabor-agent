-- ============================================================
-- XABOR Multiempresa — Migración 026
-- Documentos PDF en el chat + módulo de cotizaciones, activables por
-- negocio. No está codificado para ningún negocio en particular: se
-- agrega como capacidades reutilizables al sistema de módulos que ya
-- existe (negocio_modulos), igual que Rewards/Facturación.
--
-- Módulos nuevos: chat_imagenes, chat_documentos_pdf, cotizaciones,
-- generador_cotizaciones, pagos, repartidores.
--
-- chat_imagenes, pagos y repartidores se seedean 'activo' para TODOS
-- los negocios existentes -- son capacidades que ya funcionan hoy sin
-- gate (imágenes no se implementa en esta migración; pagos vía Clip y
-- registro de repartidores por WhatsApp ya operan en producción). Se
-- registran ahora para poder exigir requireModulo() sobre ellas en una
-- fase futura sin romper a ningún tenant existente -- en ESTA fase no
-- se agrega ningún gate nuevo sobre esas dos rutas.
--
-- chat_documentos_pdf, cotizaciones y generador_cotizaciones se
-- seedean 'no_contratado' -- opt-in explícito por negocio, nunca
-- activo por defecto.
--
-- mensajes.tipo: 'texto' (default, preserva el comportamiento de toda
-- fila existente y de todas las suites ya escritas) o 'documento'.
--
-- Reejecutable (IF NOT EXISTS / DROP+ADD CONSTRAINT con guarda /
-- ON CONFLICT DO NOTHING).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 026_documentos_cotizaciones.sql
-- ============================================================

BEGIN;

-- ── Paso 1: ampliar el CHECK de negocio_modulos.modulo ────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check
    CHECK (modulo IN (
      'pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion','rewards',
      'chat_imagenes','chat_documentos_pdf','cotizaciones','generador_cotizaciones','pagos','repartidores'
    ));
END $$;

-- ── Paso 2: seed de los 6 módulos nuevos para todo negocio existente ──────
-- chat_imagenes/pagos/repartidores: 'activo' (ya operan hoy sin gate).
INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, m.modulo, 'activo'
FROM negocios n CROSS JOIN (VALUES ('chat_imagenes'), ('pagos'), ('repartidores')) AS m(modulo)
ON CONFLICT (negocio_id, modulo) DO NOTHING;

-- chat_documentos_pdf/cotizaciones/generador_cotizaciones: opt-in.
INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, m.modulo, 'no_contratado'
FROM negocios n CROSS JOIN (VALUES ('chat_documentos_pdf'), ('cotizaciones'), ('generador_cotizaciones')) AS m(modulo)
ON CONFLICT (negocio_id, modulo) DO NOTHING;

-- ── Paso 3: mensajes -- tipo + referencia a documentos ────────────────────
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'texto';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_tipo_check') THEN
    ALTER TABLE mensajes ADD CONSTRAINT mensajes_tipo_check CHECK (tipo IN ('texto','documento'));
  END IF;
END $$;

-- ── Paso 4: documentos (PDF entrantes/salientes en el chat) ───────────────
-- No hay tabla `conversaciones`: una conversación es (telefono, negocio_id)
-- sobre `mensajes`, igual que en el resto del esquema.
CREATE TABLE IF NOT EXISTS documentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  telefono      VARCHAR(20) NOT NULL,
  direccion     TEXT NOT NULL CHECK (direccion IN ('entrante','saliente')),
  origen        TEXT CHECK (origen IS NULL OR origen IN ('cliente','bot','humano')),
  estado        TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','descargando','listo','error')),
  error_detalle TEXT,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes    INTEGER,
  storage_key   TEXT,
  caption       TEXT,
  wamid         TEXT,
  cotizacion_id UUID,
  created_by    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documentos_negocio_telefono ON documentos (negocio_id, telefono);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documentos_wamid ON documentos (wamid) WHERE wamid IS NOT NULL;

ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS documento_id UUID REFERENCES documentos(id) ON DELETE SET NULL;

-- ── Paso 5: cotizaciones ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cotizaciones (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id         UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  telefono           VARCHAR(20) NOT NULL,
  folio              TEXT NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN (
                        'borrador','enviada','vista','aceptada','rechazada','vencida','modificada','cancelada'
                      )),
  evento_nombre      TEXT,
  fecha_evento       DATE,
  lugar              TEXT,
  cantidad_personas  INTEGER,
  vigencia_hasta     DATE,
  subtotal           NUMERIC(10,2) NOT NULL DEFAULT 0,
  impuestos          NUMERIC(10,2) NOT NULL DEFAULT 0,
  descuentos         NUMERIC(10,2) NOT NULL DEFAULT 0,
  total              NUMERIC(10,2) NOT NULL DEFAULT 0,
  anticipo_requerido NUMERIC(10,2),
  notas              TEXT,
  terminos           TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  pdf_storage_key    TEXT,
  created_by         UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at            TIMESTAMPTZ,
  accepted_at        TIMESTAMPTZ,
  rejected_at        TIMESTAMPTZ,
  expired_at         TIMESTAMPTZ,
  UNIQUE (negocio_id, folio)
);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_negocio_telefono ON cotizaciones (negocio_id, telefono);

DROP TRIGGER IF EXISTS set_updated_at ON cotizaciones;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON cotizaciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- documentos.cotizacion_id se agrega ahora que cotizaciones ya existe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_cotizacion_id_fkey') THEN
    ALTER TABLE documentos ADD CONSTRAINT documentos_cotizacion_id_fkey
      FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Paso 6: items de cotización ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cotizacion_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cotizacion_id   UUID NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('servicio','producto')),
  descripcion     TEXT NOT NULL,
  cantidad        NUMERIC(10,2) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(10,2) NOT NULL DEFAULT 0,
  descuento       NUMERIC(10,2) NOT NULL DEFAULT 0,
  orden           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cotizacion_items_cotizacion ON cotizacion_items (cotizacion_id);

-- ── Paso 7: historial de versiones (snapshot inmutable) ───────────────────
CREATE TABLE IF NOT EXISTS cotizaciones_historial (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cotizacion_id   UUID NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  snapshot_json   JSONB NOT NULL,
  pdf_storage_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cotizacion_id, version)
);

COMMIT;
