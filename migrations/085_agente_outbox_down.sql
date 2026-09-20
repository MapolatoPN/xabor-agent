-- Reverso de la 085. La tabla es nueva y nadie más la referencia.
DROP INDEX IF EXISTS idx_agente_outbox_negocio;
DROP INDEX IF EXISTS idx_agente_outbox_pendiente;
DROP TABLE IF EXISTS agente_outbox;
