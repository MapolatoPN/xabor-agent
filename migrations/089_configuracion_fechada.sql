-- ============================================================
-- XABOR — Migración 089: `configuracion` guarda CUÁNDO se cambió cada clave.
--
-- La tabla tenía tres columnas —clave, valor, negocio_id— y ni una fecha.
-- Es la tabla donde viven TODOS los interruptores del producto: el bot, el
-- reconciliador, el Mesero, el agente, el canario, el perfil de cotización.
--
-- El 23 de septiembre de 2026 eso costó una investigación a medias. Una
-- conversación real de Mapolato Obispado la atendió el bot anterior aunque
-- `mesero_agente_v1='true'` y `mesero_agente_porcentaje='100'` — y no se pudo
-- saber si esos valores ya estaban puestos durante la conversación o se
-- pusieron después, porque la tabla no lo guarda. La pregunta «¿desde cuándo
-- está así?» no tenía respuesta posible.
--
-- Un interruptor sin fecha no se puede auditar, y el día que alguien
-- pregunte por qué un negocio se comportó de cierto modo a cierta hora, la
-- respuesta va a depender de que alguien se acuerde.
--
-- ── Qué hace y qué NO ────────────────────────────────────────────────────
--
-- Añade `updated_at` con default `now()` y un trigger que la mantiene. Las
-- filas existentes quedan con la fecha de la migración: NO se inventa cuándo
-- se pusieron, porque no se sabe. Es el suelo del historial, no una mentira
-- sobre el pasado.
--
-- Reutiliza `set_updated_at()` (migración 003), que es la misma función que
-- ya mantiene `negocios`, `sesiones_comerciales` y compañía. Una función, no
-- una por tabla.
--
-- Aditiva. Reejecutable. No toca `clave`, `valor` ni `negocio_id`, así que
-- ninguna lectura existente cambia.
-- ============================================================

ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS set_updated_at ON configuracion;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON configuracion
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- «Qué se tocó últimamente en este negocio» es la consulta que se hace
-- mirando un incidente, y es la única que esta columna necesita servir.
CREATE INDEX IF NOT EXISTS idx_configuracion_updated
  ON configuracion (negocio_id, updated_at DESC);
