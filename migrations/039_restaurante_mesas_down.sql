-- Rollback de la migración 039 — elimina las tablas aditivas del módulo de
-- restaurante y regresa el CHECK de negocio_modulos al vocabulario previo
-- (mismo patrón que 026/028_down). Las filas negocio_modulos con
-- modulo='restaurante' deben eliminarse antes de restaurar el CHECK.
BEGIN;

DROP TABLE IF EXISTS restaurante_cuenta_pagos;
DROP TABLE IF EXISTS restaurante_cuenta_items;
DROP TABLE IF EXISTS restaurante_cuentas;

DELETE FROM negocio_modulos WHERE modulo = 'restaurante';

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

COMMIT;
