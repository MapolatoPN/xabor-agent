-- 150 · Campañas de WhatsApp programadas (Fase 0.1, 23-nov-2026).
--
-- Pedido de Mario: poder dejar una campaña lista para una fecha y hora. La
-- campaña nace con estado 'programada' y `programada_para` (un instante; el
-- panel lo captura en la hora del negocio). La cola de siempre la pasa a
-- 'enviando' cuando llega su hora, si ese negocio no está mandando otra.
--
-- Aditiva: una columna NULL (no reescribe la tabla) y un índice parcial que no
-- cubre ninguna fila existente (ninguna está 'programada'). campanas.estado no
-- tiene regla CHECK, así que el estado nuevo no cambia ninguna. El código
-- anterior no lee esta columna ni ese estado.
--
-- Es la 150: la 147 y la 148 ya las usa feat/xabor-basico-150-preparacion y la
-- 149 feat/clientes-saneamiento (ninguna en producción todavía).

ALTER TABLE campanas
  ADD COLUMN IF NOT EXISTS programada_para timestamptz;

-- Lo único que la cola busca cada 10 s: las programadas cuya hora llegó.
CREATE INDEX IF NOT EXISTS campanas_programadas_por_hora
  ON campanas (programada_para) WHERE tipo = 'plantilla' AND estado = 'programada';
