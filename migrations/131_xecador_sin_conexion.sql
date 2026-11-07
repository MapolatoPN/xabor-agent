-- 131 · Xecador, Parte B3: checadas sin conexión y «para revisar».
--
-- Aprobado por el dueño el 6-nov-2026 (con sus ajustes del 6 y del 7-nov).
-- Necesita la 130. Todo es aditivo: ninguna fila existente cambia de valor
-- (las columnas nuevas nacen con su valor por omisión, sin tocar las filas).
--
--   1. xecador_checadas gana:
--      - origen: 'en_linea' o 'sin_conexion' (guardada en la tablet y enviada
--        después);
--      - revision: los motivos por los que hay que revisarla — reloj de la
--        tablet desfasado más de 2 minutos, sin referencia de la hora del
--        servidor, PIN no válido (verificado al sincronizar), otra sucursal,
--        empleado de baja, IP distinta de la habitual de la sucursal. Marcar
--        no bloquea: la checada se registra igual;
--      - ip: desde dónde llegó (al checar o al sincronizar);
--      - para las sin conexión: cuándo llegó, la hora del servidor de
--        referencia y el tiempo transcurrido desde ella (reloj monotónico de
--        la tablet), con los que el servidor calcula la hora oficial.
--
--   2. xecador_revisiones — «Revisada»: quién, cuándo y una nota. Solo
--      inserción; una checada se marca revisada una vez.
--
-- Las tablas nacen solo con columnas y llave primaria; las reglas van después
-- (DROP + ADD con su nombre de siempre) para que una 131 a medias converja.

-- ── 1. Checadas: origen, revisión, IP y datos de la sin conexión ───────────
ALTER TABLE xecador_checadas
  ADD COLUMN IF NOT EXISTS origen           text        NOT NULL DEFAULT 'en_linea',
  ADD COLUMN IF NOT EXISTS revision         text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ip               inet        NULL,
  ADD COLUMN IF NOT EXISTS sincronizada_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS ref_servidor     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS transcurrido_ms  bigint      NULL;

ALTER TABLE xecador_checadas
  DROP CONSTRAINT IF EXISTS xecador_checadas_origen_check,
  ADD CONSTRAINT xecador_checadas_origen_check CHECK (origen IN ('en_linea', 'sin_conexion')),
  DROP CONSTRAINT IF EXISTS xecador_checadas_revision_check,
  ADD CONSTRAINT xecador_checadas_revision_check CHECK (revision <@ ARRAY[
    'reloj_desfasado', 'sin_referencia', 'pin_no_valido', 'otra_sucursal', 'empleado_de_baja', 'ip_distinta']::text[]),
  -- Los datos de la sincronización solo existen en una checada sin conexión.
  DROP CONSTRAINT IF EXISTS xecador_checadas_datos_sin_conexion,
  ADD CONSTRAINT xecador_checadas_datos_sin_conexion CHECK (
    origen = 'sin_conexion' OR (sincronizada_at IS NULL AND ref_servidor IS NULL AND transcurrido_ms IS NULL)),
  DROP CONSTRAINT IF EXISTS xecador_checadas_transcurrido_check,
  ADD CONSTRAINT xecador_checadas_transcurrido_check CHECK (transcurrido_ms IS NULL OR transcurrido_ms >= 0);

-- Lo que hay que revisar, y la IP habitual de cada sucursal.
CREATE INDEX IF NOT EXISTS idx_xecador_checadas_revision
  ON xecador_checadas (negocio_id, hora_oficial DESC) WHERE cardinality(revision) > 0;
CREATE INDEX IF NOT EXISTS idx_xecador_checadas_ip
  ON xecador_checadas (negocio_id, sucursal_id, hora_oficial DESC) WHERE ip IS NOT NULL;

-- ── 2. Revisiones (solo inserción) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_revisiones (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id    uuid        NOT NULL,
  checada_id    bigint      NOT NULL,
  revisada_por  uuid        NOT NULL,
  nota          text        NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_revisiones_pkey') THEN
    ALTER TABLE xecador_revisiones ADD CONSTRAINT xecador_revisiones_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_revisiones_checada_unica') THEN
    ALTER TABLE xecador_revisiones ADD CONSTRAINT xecador_revisiones_checada_unica UNIQUE (negocio_id, checada_id);
  END IF;
END $$;

ALTER TABLE xecador_revisiones
  DROP CONSTRAINT IF EXISTS xecador_revisiones_checada_fkey,
  ADD CONSTRAINT xecador_revisiones_checada_fkey
    FOREIGN KEY (negocio_id, checada_id) REFERENCES xecador_checadas (negocio_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_revisiones_revisada_por_fkey,
  ADD CONSTRAINT xecador_revisiones_revisada_por_fkey FOREIGN KEY (revisada_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_revisiones_nota_check,
  ADD CONSTRAINT xecador_revisiones_nota_check CHECK (nota IS NULL OR char_length(nota) <= 300);

CREATE OR REPLACE FUNCTION xecador_revisiones_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'xecador_revisiones es de solo inserción: una revisión no se cambia ni se borra (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_revisiones_sin_cambios ON xecador_revisiones;
CREATE TRIGGER xecador_revisiones_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_revisiones
  FOR EACH ROW EXECUTE FUNCTION xecador_revisiones_inmutable();
DROP TRIGGER IF EXISTS xecador_revisiones_sin_truncate ON xecador_revisiones;
CREATE TRIGGER xecador_revisiones_sin_truncate
  BEFORE TRUNCATE ON xecador_revisiones
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_revisiones_inmutable();
