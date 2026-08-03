-- Migración 028: Asistente Comercial de Cotizaciones por WhatsApp — Fase 1-5.
-- Renumerada de 027 a 028 para no colisionar con el hotfix
-- 027_cotizaciones_iva_tasa.sql (rama hotfix/cotizaciones-telefono-multiempresa-iva,
-- más cercana al deploy real) -- ver también migrations/028_sesiones_comerciales_down.sql
-- y migrations/028_check_sesiones_comerciales.sql.
-- Agrega:
--   1. cotizaciones.origen -- distingue una cotización creada manualmente
--      desde el panel ('panel') de una creada por el asistente de IA a
--      partir de una conversación de WhatsApp ('whatsapp_ia').
--   2. sesiones_comerciales -- estado conversacional DURABLE (sobrevive un
--      reinicio del proceso, a diferencia del Map en memoria de
--      session.js) de la máquina de estados descrita en
--      docs/asistente-comercial-detalle-tecnico.md §1. Aislada por
--      negocio_id+telefono, con a lo sumo una sesión ACTIVA por par
--      (índice único parcial).
--   3. sesiones_comerciales_eventos -- log de auditoría append-only,
--      scoped por negocio_id, de cada transición/campo capturado/borrador
--      creado -- requisito explícito del encargo ("todo debe quedar
--      auditado y aislado por negocio_id"). No se reutiliza la tabla
--      `eventos` existente porque esa tabla es pre-multiempresa y no
--      tiene negocio_id -- reutilizarla violaría el aislamiento que este
--      mismo encargo exige.
-- Reejecutable: IF NOT EXISTS / DO $$ guards en todo.

BEGIN;

-- ── Paso 1: origen de la cotización ────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cotizaciones' AND column_name = 'origen'
  ) THEN
    ALTER TABLE cotizaciones ADD COLUMN origen TEXT NOT NULL DEFAULT 'panel';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cotizaciones_origen_check') THEN
    ALTER TABLE cotizaciones DROP CONSTRAINT cotizaciones_origen_check;
  END IF;
  ALTER TABLE cotizaciones ADD CONSTRAINT cotizaciones_origen_check
    CHECK (origen IN ('panel', 'whatsapp_ia'));
END $$;

-- ── Paso 2: sesiones comerciales (estado conversacional durable) ──────────
CREATE TABLE IF NOT EXISTS sesiones_comerciales (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id          UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono            VARCHAR(20) NOT NULL CHECK (telefono <> ''),
  estado              TEXT NOT NULL DEFAULT 'descubriendo_necesidad' CHECK (estado IN (
                        'descubriendo_necesidad', 'construyendo_borrador',
                        'esperando_aprobacion', 'finalizada', 'abandonada'
                      )),
  campos_capturados   JSONB NOT NULL DEFAULT '{}',
  cotizacion_id       UUID REFERENCES cotizaciones(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sesiones_comerciales_negocio
  ON sesiones_comerciales (negocio_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_comerciales_negocio_telefono
  ON sesiones_comerciales (negocio_id, telefono);

-- A lo sumo una sesión ACTIVA (no finalizada/abandonada) por negocio+teléfono
-- -- evita dos flujos comerciales concurrentes y contradictorios para el
-- mismo cliente en el mismo negocio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sesion_comercial_activa_unica
  ON sesiones_comerciales (negocio_id, telefono)
  WHERE estado NOT IN ('finalizada', 'abandonada');

DROP TRIGGER IF EXISTS set_updated_at ON sesiones_comerciales;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sesiones_comerciales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Paso 3: auditoría append-only, scoped por negocio_id ──────────────────
CREATE TABLE IF NOT EXISTS sesiones_comerciales_eventos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sesion_id     UUID NOT NULL REFERENCES sesiones_comerciales(id) ON DELETE CASCADE,
  negocio_id    UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  tipo_evento   TEXT NOT NULL,
  detalle       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sesiones_comerciales_eventos_sesion
  ON sesiones_comerciales_eventos (sesion_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_comerciales_eventos_negocio
  ON sesiones_comerciales_eventos (negocio_id);

-- ── Paso 4: módulo activable por negocio (asistente_comercial_cotizaciones) ──
-- Mismo patrón que el paso 1/2 de la migración 026 (chat_documentos_pdf/
-- cotizaciones/generador_cotizaciones): opt-in, 'no_contratado' por defecto
-- para TODO negocio existente -- se activa explícitamente por negocio desde
-- Superadmin después del deploy, nunca automáticamente.
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
      'chat_imagenes','chat_documentos_pdf','cotizaciones','generador_cotizaciones','pagos','repartidores',
      'asistente_comercial_cotizaciones'
    ));
END $$;

INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, 'asistente_comercial_cotizaciones', 'no_contratado'
FROM negocios n
ON CONFLICT (negocio_id, modulo) DO NOTHING;

COMMIT;
