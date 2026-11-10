-- Reversa de la 134 (Xecador, PIN + cara).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 134. El
-- código anterior no usa nada de esto: revertir el código basta para volver
-- a checar solo con el PIN, y esta reversa es opcional.
--
-- Se corre con psql:  psql "$CONN" -f migrations/134_xecador_cara_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Qué borra: las caras registradas (son datos biométricos: si la función se
-- retira, no se quedan guardadas), los triggers, el interruptor por negocio y
-- la fecha del consentimiento en el expediente. Esa fecha sigue escrita en la
-- bitácora (evento 'consentimiento_cara'), que no se borra.
--
-- Qué deja: en las checadas, cómo salió la cara (cara, cara_detalle,
-- cara_similitud) y las listas ampliadas de motivos, avisos y eventos. Las
-- checadas, los avisos y la bitácora son de solo inserción: lo que ya se
-- registró con esos valores no se puede cambiar, y una lista más larga no le
-- estorba al código anterior. Si la 134 se vuelve a aplicar, los reconoce.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_empleados IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS xecador_empleados_cara ON xecador_empleados;
DROP FUNCTION IF EXISTS xecador_empleados_cara_al_cambiar();

DROP TABLE IF EXISTS xecador_caras;
DROP FUNCTION IF EXISTS xecador_caras_con_consentimiento();

ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_consentimiento_cara_check,
  DROP COLUMN IF EXISTS consentimiento_cara_fecha;

ALTER TABLE xecador_config
  DROP CONSTRAINT IF EXISTS xecador_config_cara_al_checar_check,
  DROP COLUMN IF EXISTS cara_al_checar;

COMMIT;
