-- 132 · Xecador: checar solo con el PIN (sin el número de empleado).
--
-- Aprobado por el dueño el 7-nov-2026. Necesita la 131. Aditiva: ninguna
-- fila existente cambia de valor (la columna nueva nace vacía).
--
-- xecador_empleados gana pin_indice: con él el servidor encuentra al empleado
-- solo con su PIN. Lo calcula el servidor con una llave propia (HMAC); no es
-- el PIN. El hash de siempre (pin_hash) se queda como está: con él se sigue
-- verificando número + PIN, así que volver al código anterior no deja a nadie
-- sin checar.
--
-- El índice es ÚNICO por negocio y cuenta también a los empleados dados de
-- baja: dos empleados del mismo negocio nunca comparten PIN, y el PIN de
-- alguien que se fue no se le da a otro.
--
-- Los PIN que ya existían no traen índice: el servidor se lo pone la primera
-- vez que el empleado checa con su PIN. No hay que repartir PIN nuevos.

ALTER TABLE xecador_empleados ADD COLUMN IF NOT EXISTS pin_indice text NULL;

-- Formato: «<huella de la llave, 8 hex>.<HMAC-SHA-256 en base64url>». Un
-- índice sin PIN no tiene sentido.
ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_pin_indice_check,
  ADD CONSTRAINT xecador_empleados_pin_indice_check CHECK (
    pin_indice IS NULL OR (pin_hash IS NOT NULL AND pin_indice ~ '^[0-9a-f]{8}\.[A-Za-z0-9_-]{43}$'));

DROP INDEX IF EXISTS xecador_empleados_pin_indice_unico;
CREATE UNIQUE INDEX xecador_empleados_pin_indice_unico
  ON xecador_empleados (negocio_id, pin_indice) WHERE pin_indice IS NOT NULL;
