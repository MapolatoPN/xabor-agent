-- 046 -- La auditoria de plataforma admite dos actores.
--
-- `auditoria_plataforma.superadmin_id` es NOT NULL desde la 011, cuando el
-- unico que podia actuar sobre una integracion era Xabor. Con el autoservicio
-- de WhatsApp eso dejo de ser cierto: ahora el administrador del propio
-- negocio inicia y completa su onboarding, y no tiene superadmin_id.
--
-- El resultado en produccion fue un 500 en el callback DESPUES de que Meta ya
-- habia devuelto la WABA, el numero y el token, y de que subscribe_apps ya
-- habia funcionado. La integracion critica estaba hecha; lo que reventó fue
-- escribir la bitacora.
--
-- Por que NO se reutiliza `usuario_id`: esa columna ya existe y significa
-- "el usuario AFECTADO por la accion" (a quien se invito, a quien se
-- desactivo). Meterle el actor encima haria que las filas historicas y las
-- nuevas signifiquen cosas distintas con el mismo nombre, y la auditoria
-- dejaria de ser auditable.
--
-- ADITIVA: una columna nueva nullable, un NOT NULL que se relaja y un CHECK
-- que las filas existentes ya cumplen (todas tienen superadmin_id y no tienen
-- actor_usuario_id). 0 UPDATE, 0 DELETE, 0 DROP, 0 backfill.

ALTER TABLE auditoria_plataforma
  ADD COLUMN IF NOT EXISTS actor_usuario_id UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE auditoria_plataforma
  ALTER COLUMN superadmin_id DROP NOT NULL;

-- Exactamente un actor. Un evento sin actor no se puede auditar, y uno con
-- dos no se sabe a quien atribuir.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auditoria_plataforma_un_actor') THEN
    ALTER TABLE auditoria_plataforma
      ADD CONSTRAINT auditoria_plataforma_un_actor
      CHECK ((superadmin_id IS NOT NULL) <> (actor_usuario_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_auditoria_actor_usuario
  ON auditoria_plataforma (actor_usuario_id) WHERE actor_usuario_id IS NOT NULL;
