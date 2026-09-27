-- Reversión manual de la 099. El código anterior no lee ninguno de estos
-- objetos, así que retirarlos solo pierde la traza de turnos, la correlación
-- de respuestas del outbox y la marca de aceptación de Meta; ningún pedido ni
-- conversación cambia.
--
-- Los estados nuevos se llevan primero a uno que el CHECK anterior admite:
-- `enviando` e `incierto` son respuestas que NO deben reenviarse, y el código
-- anterior no reenvía nada en `fallido`.
UPDATE agente_outbox SET estado = 'fallido' WHERE estado IN ('enviando', 'incierto');
-- El paso a persona sin confirmar se pierde con estas columnas: revisar antes
-- de revertir con
--   SELECT id, negocio_id, carga->>'telefono', humano_motivo FROM agente_outbox
--    WHERE humano_motivo IS NOT NULL AND humano_confirmado_at IS NULL;
DROP INDEX IF EXISTS idx_agente_outbox_humano_por_confirmar;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS humano_confirmado_at;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS humano_reclamado_at;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS humano_solicitado_at;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS humano_motivo;
ALTER TABLE agente_outbox DROP CONSTRAINT IF EXISTS agente_outbox_estado_check;
ALTER TABLE agente_outbox ADD CONSTRAINT agente_outbox_estado_check
  CHECK (estado IN ('pendiente','entregado','fallido','descartado'));
DROP INDEX IF EXISTS idx_agente_outbox_dialogo;
DROP INDEX IF EXISTS idx_agente_outbox_enviando;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS reclamado_por;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS reclamado_at;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS wamid_salida;
DROP INDEX IF EXISTS idx_agente_outbox_respuestas_pendientes;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS turno_clave;
ALTER TABLE agente_outbox DROP COLUMN IF EXISTS conversacion_id;
DROP TABLE IF EXISTS agente_turnos;
