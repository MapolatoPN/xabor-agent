-- ============================================================
-- XABOR Multiempresa — Migración 023
-- Captura real de prospectos desde la landing pública. Reemplaza el
-- flujo anterior (mailto:, que dependía de que el visitante tuviera
-- un cliente de correo configurado) por persistencia real en
-- PostgreSQL -- la base es la fuente de verdad, el correo a
-- hola@xabor.mx es solo una notificación secundaria (ver
-- src/services/email.js).
--
-- No tiene relación (FK) con `negocios`: un prospecto todavía no es
-- un negocio dado de alta en la plataforma -- es un lead capturado
-- antes de convertirse en cliente.
--
-- ip_hash: NUNCA se guarda la IP en claro. Se guarda un HMAC-SHA256
-- (servidor, con el mismo secreto ya usado para firmar sesiones) --
-- sirve para detectar abuso repetido sin poder recuperar la IP
-- original desde la base. user_agent_resumen se trunca a 160
-- caracteres únicamente para diagnóstico de abuso, nunca se expone
-- en el correo de notificación.
--
-- Reejecutable (CREATE TABLE IF NOT EXISTS).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 023_prospectos_comerciales.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS prospectos_comerciales (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                    TEXT NOT NULL CHECK (char_length(nombre) BETWEEN 2 AND 120),
  negocio                   TEXT NOT NULL CHECK (char_length(negocio) BETWEEN 2 AND 150),
  ciudad                    TEXT NOT NULL CHECK (char_length(ciudad) BETWEEN 2 AND 100),
  telefono                  TEXT NOT NULL CHECK (char_length(telefono) BETWEEN 7 AND 20),
  tipo_negocio              TEXT NOT NULL CHECK (char_length(tipo_negocio) BETWEEN 2 AND 100),
  volumen_mensajes          TEXT NULL CHECK (volumen_mensajes IS NULL OR char_length(volumen_mensajes) <= 40),
  comentario                TEXT NULL CHECK (comentario IS NULL OR char_length(comentario) <= 800),
  email                     TEXT NULL CHECK (email IS NULL OR char_length(email) <= 160),
  origen                    TEXT NOT NULL DEFAULT 'landing' CHECK (char_length(origen) <= 40),
  estado                    TEXT NOT NULL DEFAULT 'nuevo'
    CHECK (estado IN ('nuevo','contactado','demo_agendada','seguimiento','convertido','descartado')),
  responsable               TEXT NULL CHECK (responsable IS NULL OR char_length(responsable) <= 120),
  notas_internas            TEXT NULL CHECK (notas_internas IS NULL OR char_length(notas_internas) <= 4000),
  fecha_ultimo_seguimiento  DATE NULL,
  correo_notificacion_enviado BOOLEAN NOT NULL DEFAULT FALSE,
  ip_hash                   TEXT NULL,
  user_agent_resumen        TEXT NULL CHECK (user_agent_resumen IS NULL OR char_length(user_agent_resumen) <= 160),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospectos_comerciales_estado     ON prospectos_comerciales (estado);
CREATE INDEX IF NOT EXISTS idx_prospectos_comerciales_created_at ON prospectos_comerciales (created_at DESC);
-- Detección de doble envío reciente (mismo teléfono+negocio en una ventana corta).
CREATE INDEX IF NOT EXISTS idx_prospectos_comerciales_dedupe     ON prospectos_comerciales (telefono, negocio, created_at DESC);

COMMIT;
