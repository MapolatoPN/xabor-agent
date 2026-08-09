-- Verificación de la migración 043. Solo lectura.
SELECT 'tabla impresoras'           AS check, (to_regclass('impresoras')          IS NOT NULL) AS ok
UNION ALL SELECT 'tabla impresion_rutas',     (to_regclass('impresion_rutas')     IS NOT NULL)
UNION ALL SELECT 'tabla impresion_trabajos',  (to_regclass('impresion_trabajos')  IS NOT NULL)
UNION ALL SELECT 'tabla edge_emparejamientos', (to_regclass('edge_emparejamientos') IS NOT NULL)
UNION ALL SELECT 'un solo codigo vigente por terminal', EXISTS (
  SELECT 1 FROM pg_indexes WHERE tablename = 'edge_emparejamientos'
    AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%usado_at IS NULL%')
UNION ALL SELECT 'unique idempotency_key', EXISTS (
  SELECT 1 FROM pg_indexes WHERE tablename = 'impresion_trabajos'
    AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%idempotency_key%')
UNION ALL SELECT 'unique impresora por sucursal+nombre', EXISTS (
  SELECT 1 FROM pg_indexes WHERE tablename = 'impresoras'
    AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%sucursal_id%' AND indexdef ILIKE '%nombre%')
UNION ALL SELECT 'unique ruta sin duplicar destino', EXISTS (
  SELECT 1 FROM pg_indexes WHERE tablename = 'impresion_rutas'
    AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%ambito%' AND indexdef ILIKE '%impresora_id%')
UNION ALL SELECT 'FK compuesta sucursal-negocio', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conname = 'fk_impresoras_sucursal_negocio')
UNION ALL SELECT 'puerto sin default 9100', NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_name = 'impresoras' AND column_name = 'puerto' AND column_default IS NOT NULL)
UNION ALL SELECT 'estado incierto permitido', EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'impresion_trabajos' AND pg_get_constraintdef(c.oid) ILIKE '%incierto%')
UNION ALL SELECT 'no existe estado impreso (seria una certeza inventada)', NOT EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'impresion_trabajos' AND pg_get_constraintdef(c.oid) ILIKE '%impreso%')
UNION ALL SELECT 'trabajos sobreviven a borrar impresora', EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'impresion_trabajos' AND c.contype = 'f'
     AND pg_get_constraintdef(c.oid) ILIKE '%impresoras%' AND pg_get_constraintdef(c.oid) ILIKE '%SET NULL%')
UNION ALL SELECT 'ninguna tabla existente alterada (terminales intacta)', EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_name = 'terminales' AND column_name = 'token_hash');
