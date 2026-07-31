-- Rollback de la migración 015. Reejecutable.
-- No borra rewards_accounts.nombre por seguridad de datos por defecto --
-- se deja comentado; descomentar solo si se decide explícitamente
-- descartar la columna.
--
-- Borra primero las filas 'rewards' de negocio_modulos (únicas que usan
-- el vocabulario nuevo: pendiente_configuracion/no_contratado) ANTES de
-- restaurar el CHECK de estado a los 5 valores heredados -- si se hiciera
-- al revés, restaurar el CHECK fallaría mientras existan filas 'rewards'
-- con esos valores nuevos.

BEGIN;

DELETE FROM negocio_modulos WHERE modulo = 'rewards';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check
    CHECK (modulo IN ('pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_estado_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_estado_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_estado_check
    CHECK (estado IN ('no_configurado','pendiente','configurado','activo','suspendido'));
END $$;

COMMIT;

-- ALTER TABLE rewards_accounts DROP COLUMN IF EXISTS nombre;
