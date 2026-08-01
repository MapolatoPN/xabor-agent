-- ============================================================
-- XABOR Multiempresa — Migración 018
-- Fase B de WhatsApp multiempresa: modelo de datos para credenciales
-- de integración por negocio (almacenamiento cifrado + estado técnico).
--
-- Extiende integraciones_canal (aditivo, no rompe nada existente) en
-- vez de crear una tabla de enrutamiento paralela -- el enrutamiento de
-- entrada (obtenerIntegracionCanal, usado por el webhook de WhatsApp,
-- Rappi y voz) sigue funcionando exactamente igual sobre `identificador`
-- y `activo`.
--
-- Los SECRETOS (token cifrado, IV, auth tag) van en una tabla NUEVA y
-- separada (integraciones_canal_credenciales, 1:1 por integracion_id) a
-- propósito: así ninguna consulta de enrutamiento/listado (que solo
-- necesita leer integraciones_canal) puede exponer material cifrado por
-- accidente, ni siquiera con un SELECT * mal escrito -- hay que unir
-- explícitamente a la tabla de credenciales para llegar a ellas, y solo
-- integracionesService.js lo hace.
--
-- NOTA sobre `identificador`/phone_number_id: para canal='whatsapp',
-- `identificador` (columna ya existente desde la migración 008) ES el
-- phone_number_id -- no se duplica en una columna nueva. Su unicidad ya
-- está garantizada por el UNIQUE(canal, identificador) existente
-- (equivale exactamente a "phone_number_id único cuando no sea NULL").
--
-- Transaccional, idempotente, cero modificación destructiva. Si
-- integraciones_canal ya tiene filas (Rappi, voz, WhatsApp de Nonna
-- Maye), se preservan sin ningún cambio de valor -- solo se agregan
-- columnas nuevas, todas nullable o con default seguro.
--
-- No migra ninguna credencial real de Nonna Maye. Su fallback verificado
-- hacia variables de Railway sigue intacto (ver obtenerCredencialesWhatsappNegocio).
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 018_integraciones_canal_credenciales.sql
-- ============================================================

BEGIN;

-- ── Paso 1: columnas nuevas en integraciones_canal (routing + estado
--    técnico + metadatos no sensibles) ─────────────────────────────────
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS proveedor TEXT
  CHECK (proveedor IS NULL OR proveedor ~ '^[a-z][a-z0-9_]*$');

ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'no_configurado'
  CHECK (estado IN ('no_configurado','pendiente_configuracion','activo','suspendido','error'));

ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS waba_id TEXT;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS business_id TEXT;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS display_phone_number TEXT; -- visible, nunca secreto
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS conectado_at TIMESTAMPTZ;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS actualizado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS ultimo_error_codigo TEXT; -- identificador controlado, nunca el detalle crudo del proveedor
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS ultimo_error_at TIMESTAMPTZ;

-- Backfill seguro: todas las filas existentes (Rappi, voz, WhatsApp de
-- Nonna Maye) quedan con estado derivado de su columna `activo` actual
-- -- nunca se inventa un estado más específico que 'activo'/'no_configurado'
-- para datos que no pasaron por este modelo nuevo.
UPDATE integraciones_canal SET estado = 'activo' WHERE activo = TRUE AND estado = 'no_configurado';

-- Único índice nuevo de enrutamiento por (negocio_id, canal, proveedor)
-- -- distinto del UNIQUE(canal, identificador) ya existente. NULL en
-- proveedor no colisiona entre sí (comportamiento estándar de Postgres),
-- así que las filas heredadas (Rappi/voz, sin proveedor todavía) no se
-- ven afectadas por esta restricción nueva.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integraciones_canal_negocio_canal_proveedor
  ON integraciones_canal (negocio_id, canal, proveedor)
  WHERE proveedor IS NOT NULL;

-- ── Paso 2: tabla nueva, exclusiva para material cifrado ──────────────
CREATE TABLE IF NOT EXISTS integraciones_canal_credenciales (
  integracion_id        UUID PRIMARY KEY REFERENCES integraciones_canal(id) ON DELETE CASCADE,
  access_token_cifrado  TEXT NOT NULL,
  token_iv              TEXT NOT NULL,
  token_auth_tag        TEXT NOT NULL,
  token_formato_version SMALLINT NOT NULL DEFAULT 1, -- versionado explícito para rotación futura de algoritmo/clave
  token_expira_at       TIMESTAMPTZ,
  creado_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
