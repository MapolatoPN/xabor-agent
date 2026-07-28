-- ============================================================
-- XABOR Multiempresa Fase 5 — Migración 008
-- Infraestructura de mapeo canal → negocio (integraciones_canal).
-- Puramente aditiva: crea UNA tabla nueva, no toca ninguna existente.
-- Ningún archivo de canal (whatsapp-meta.js, rappi.js, voice.js,
-- print-agent.js) consume esta tabla todavía — eso queda para una fase
-- posterior explícitamente autorizada. Este commit solo prepara el
-- esquema para que, cuando se conecte cada canal, la resolución de
-- negocio_id sea un lookup contra esta tabla en vez de comparar contra
-- una variable de entorno global.
--
-- Reejecutable.
-- ============================================================

CREATE TABLE IF NOT EXISTS integraciones_canal (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: un negocio con integraciones configuradas no se borra
  -- físicamente, mismo criterio que el resto del esquema multiempresa.
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- sucursal_id es opcional a propósito: hoy ningún canal opera a nivel
  -- de sucursal (la tabla sucursales existe desde la migración 003 pero
  -- no la usa ningún archivo de la aplicación — confirmado por búsqueda
  -- en todo src/). Se deja la columna lista para cuando un negocio con
  -- varias sucursales necesite integraciones distintas por sucursal.
  sucursal_id    UUID NULL REFERENCES sucursales(id) ON DELETE RESTRICT,
  -- Sin ENUM ni CHECK IN (...) — una lista fija obligaría a migrar cada
  -- vez que se agregue un canal nuevo. La validación solo exige texto en
  -- minúsculas, sin espacios, no vacío (mismo criterio flexible que ya
  -- usa 'canal' en la tabla pedidos, que tampoco es ENUM).
  canal          TEXT NOT NULL CHECK (canal ~ '^[a-z][a-z0-9_]*$'),
  -- Identificador crudo tal como lo manda el proveedor del canal:
  -- store.internal_id (Rappi), phone_number_id (WhatsApp/Meta), o el
  -- número "To" marcado (Twilio voz). Nunca un secreto — ver 'configuracion'.
  identificador  TEXT NOT NULL CHECK (length(trim(identificador)) > 0),
  nombre         TEXT NULL,
  -- Metadatos NO sensibles del canal (p. ej. nombre visible, horario,
  -- cooking_time). Tokens/secrets/client_secret NUNCA van aquí — esos
  -- siguen viviendo donde ya viven hoy (env vars / tabla configuracion
  -- con sus propias protecciones), esta tabla solo resuelve "a qué
  -- negocio pertenece este identificador", no autentica contra el proveedor.
  configuracion  JSONB NOT NULL DEFAULT '{}',
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- El mismo identificador (p. ej. un store_id de Rappi) no puede
  -- pertenecer a dos negocios a la vez — es la garantía central de que
  -- un pedido nunca se le asigne al negocio equivocado.
  UNIQUE (canal, identificador)
);

CREATE INDEX IF NOT EXISTS idx_integraciones_canal_negocio
  ON integraciones_canal (negocio_id);

-- Índice parcial: solo indexa filas donde sucursal_id no es NULL, ya que
-- hoy la mayoría de las integraciones no lo usarán.
CREATE INDEX IF NOT EXISTS idx_integraciones_canal_sucursal
  ON integraciones_canal (sucursal_id)
  WHERE sucursal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integraciones_canal_negocio_canal
  ON integraciones_canal (negocio_id, canal);

-- Trigger updated_at — reutiliza set_updated_at() creada en 003, mismo
-- patrón ya usado en usuario_negocios (005).
DROP TRIGGER IF EXISTS set_updated_at ON integraciones_canal;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON integraciones_canal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
