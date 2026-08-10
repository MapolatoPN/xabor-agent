-- 047 -- La FK del actor de auditoria deja de ser ON DELETE SET NULL.
--
-- Defecto introducido por la 046. Su FK quedo asi:
--
--   actor_usuario_id UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL
--
-- y a la vez el CHECK exige exactamente un actor:
--
--   (superadmin_id IS NOT NULL) <> (actor_usuario_id IS NOT NULL)
--
-- Para una fila de actor negocio -- superadmin_id NULL, actor_usuario_id con
-- valor -- borrar ese usuario haria que la FK pusiera actor_usuario_id a NULL
-- y entonces AMBAS columnas quedarian nulas. El CHECK lo impediria y el
-- DELETE fallaria. Las dos reglas se contradicen.
--
-- El arreglo correcto no es relajar el CHECK: es que la auditoria RETENGA a
-- su actor. Una bitacora cuyo autor se puede borrar deja de ser una bitacora,
-- y es exactamente el criterio que ya aplica `superadmin_id`, que desde la
-- 011 es ON DELETE RESTRICT.
--
-- Se alinean las dos: RESTRICT en ambas. Intentar borrar un usuario que
-- consta como actor falla de forma explicita, en vez de perder la trazabilidad
-- en silencio.
--
-- Riesgo real hoy: bajo. Xabor NO borra usuarios fisicamente -- los desactiva
-- (`usuarios.activo = false`). No hay un solo DELETE FROM usuarios en el
-- codigo. Pero un esquema que se contradice consigo mismo es una trampa
-- esperando a la primera limpieza manual de datos.
--
-- ADITIVA en el sentido que importa: no toca una sola fila. Solo sustituye la
-- regla de integridad referencial. 0 UPDATE, 0 DELETE, 0 DROP de datos.

DO $$
DECLARE
  nombre_fk TEXT;
BEGIN
  -- El nombre lo genero Postgres en la 046; no se asume, se busca.
  SELECT c.conname INTO nombre_fk
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
   WHERE t.relname = 'auditoria_plataforma'
     AND c.contype = 'f'
     AND a.attname = 'actor_usuario_id'
   LIMIT 1;

  IF nombre_fk IS NULL THEN
    RAISE NOTICE 'no hay FK sobre actor_usuario_id: nada que corregir';
    RETURN;
  END IF;

  -- Si ya es NO ACTION/RESTRICT, no se toca.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = nombre_fk AND confdeltype IN ('a', 'r')
  ) THEN
    RAISE NOTICE 'la FK ya retiene al actor: nada que corregir';
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE auditoria_plataforma DROP CONSTRAINT %I', nombre_fk);
  ALTER TABLE auditoria_plataforma
    ADD CONSTRAINT auditoria_plataforma_actor_usuario_fk
    FOREIGN KEY (actor_usuario_id) REFERENCES usuarios(id) ON DELETE RESTRICT;
END $$;
