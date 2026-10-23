-- Sin estas columnas, el código de la fase 2 no puede leer la configuración.
ALTER TABLE facturacion_configuracion DROP CONSTRAINT IF EXISTS chk_facturacion_plazo;
ALTER TABLE facturacion_configuracion
  DROP COLUMN IF EXISTS plazo_tipo,
  DROP COLUMN IF EXISTS plazo_dias,
  DROP COLUMN IF EXISTS global_desde;
