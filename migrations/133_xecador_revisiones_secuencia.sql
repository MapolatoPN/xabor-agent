-- 133 · Xecador: «Revisada» para las alertas de secuencia de las checadas.
--
-- Pedido de Mario del 10-nov-2026. Necesita la 131 (revisiones). Aditiva: una
-- tabla nueva; ninguna fila existente cambia.
--
-- «Para revisar» ahora también muestra turnos que no cuadran (sin salida,
-- descanso sin cerrar, repetidas en menos de 2 min, de más de 12 h, salió y
-- volvió a entrar…). Se calculan sobre la línea efectiva y no se guardan: una
-- corrección las quita solas. Cuando lo que pasó es real (sí trabajó 13 h),
-- el administrador la marca «Revisada» con una nota, y eso es lo que se
-- guarda aquí: quién, cuándo, qué alerta y sobre qué checada.
--
--   ancla  la checada con la que se identifica la alerta: 'c:<id>' (de la
--          tablet) o 'a:<id>' (agregada por una corrección).
--
-- Solo inserción, como xecador_revisiones: una revisión no se cambia ni se
-- borra. Una alerta se marca una vez.
--
-- La tabla nace solo con columnas y llave primaria; las reglas van después
-- (DROP + ADD con su nombre de siempre) para que una 133 a medias converja.

CREATE TABLE IF NOT EXISTS xecador_revisiones_secuencia (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id    uuid        NOT NULL,
  empleado_id   uuid        NOT NULL,
  motivo        text        NOT NULL,
  ancla         text        NOT NULL,
  revisada_por  uuid        NOT NULL,
  nota          text        NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_revisiones_secuencia_pkey') THEN
    ALTER TABLE xecador_revisiones_secuencia ADD CONSTRAINT xecador_revisiones_secuencia_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE xecador_revisiones_secuencia
  DROP CONSTRAINT IF EXISTS xecador_revisiones_secuencia_unica,
  ADD CONSTRAINT xecador_revisiones_secuencia_unica UNIQUE (negocio_id, motivo, ancla),
  DROP CONSTRAINT IF EXISTS xecador_revisiones_secuencia_empleado_fkey,
  ADD CONSTRAINT xecador_revisiones_secuencia_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_revisiones_secuencia_revisada_por_fkey,
  ADD CONSTRAINT xecador_revisiones_secuencia_revisada_por_fkey FOREIGN KEY (revisada_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_revisiones_secuencia_motivo_check,
  ADD CONSTRAINT xecador_revisiones_secuencia_motivo_check CHECK (motivo = ANY (ARRAY[
    'sin_salida', 'descanso_sin_cerrar', 'repetida', 'turno_largo', 'reentrada', 'sin_entrada', 'fin_sin_inicio']::text[])),
  DROP CONSTRAINT IF EXISTS xecador_revisiones_secuencia_ancla_check,
  ADD CONSTRAINT xecador_revisiones_secuencia_ancla_check CHECK (ancla ~ '^[ca]:[1-9][0-9]{0,17}$'),
  DROP CONSTRAINT IF EXISTS xecador_revisiones_secuencia_nota_check,
  ADD CONSTRAINT xecador_revisiones_secuencia_nota_check CHECK (nota IS NULL OR char_length(nota) <= 300);

CREATE OR REPLACE FUNCTION xecador_revisiones_secuencia_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'xecador_revisiones_secuencia es de solo inserción: una revisión no se cambia ni se borra (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_revisiones_secuencia_sin_cambios ON xecador_revisiones_secuencia;
CREATE TRIGGER xecador_revisiones_secuencia_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_revisiones_secuencia
  FOR EACH ROW EXECUTE FUNCTION xecador_revisiones_secuencia_inmutable();
DROP TRIGGER IF EXISTS xecador_revisiones_secuencia_sin_truncate ON xecador_revisiones_secuencia;
CREATE TRIGGER xecador_revisiones_secuencia_sin_truncate
  BEFORE TRUNCATE ON xecador_revisiones_secuencia
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_revisiones_secuencia_inmutable();
