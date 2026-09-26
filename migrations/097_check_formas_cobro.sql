-- Verificación manual de la 097 (solo lectura).
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'formas_cobro'
 ORDER BY ordinal_position;

SELECT conname FROM pg_constraint
 WHERE conrelid = 'formas_cobro'::regclass
 ORDER BY conname;

-- Cada negocio con sus cuatro formas sembradas.
SELECT n.nombre, string_agg(f.clave || CASE WHEN f.activo THEN '' ELSE ' (inactiva)' END, ', ' ORDER BY f.orden) AS formas
  FROM negocios n
  LEFT JOIN formas_cobro f ON f.negocio_id = n.id
 GROUP BY n.nombre
 ORDER BY n.nombre;
