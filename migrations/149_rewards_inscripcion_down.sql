-- Reversa MANUAL de la 149 (nadie la ejecuta en automático: solo con psql y a
-- propósito). Antes de correrla, regresa al binario anterior: el nuevo lee
-- estas columnas y sin ellas Rewards falla cerrado (no acumula ni canjea).
--
-- OJO: borrar las columnas de inscripción olvida QUIÉN se inscribió y la
-- bitácora pierde el antes y el después de los ajustes. Si hubo ajustes
-- aplicados con scripts/rewards-saneamiento.mjs, revísalos (y revierte los
-- que haga falta con ese mismo script) ANTES de esta reversa. Los movimientos
-- de puntos (rewards_movements) no se tocan.

DROP TABLE IF EXISTS rewards_bitacora;
ALTER TABLE rewards_config DROP COLUMN IF EXISTS vigencia_desde;
ALTER TABLE rewards_accounts DROP CONSTRAINT IF EXISTS rewards_accounts_inscripcion_completa;
ALTER TABLE rewards_accounts DROP CONSTRAINT IF EXISTS rewards_accounts_inscripcion_origen;
ALTER TABLE rewards_accounts
  DROP COLUMN IF EXISTS inscrito_por,
  DROP COLUMN IF EXISTS inscripcion_origen,
  DROP COLUMN IF EXISTS inscrito_at;
