-- 141 · Pedidos de temporada: «se prepara en» (CEDIS).
--
-- Pedido de Mario del 20-nov-2026: Obispado será el CEDIS de Acuña para
-- Thanksgiving. Sus trabajadores ven en /temporada los pedidos de Acuña para
-- prepararlos; Acuña sigue viendo solo los suyos.
--
-- Una campaña puede decir en qué otra sucursal se prepara (preparada_en).
-- Quien trabaja en esa sucursal la ve en SOLO LECTURA (lista, notas y hojas de
-- cocina); cobrar, editar, cancelar o avanzar sigue siendo de quien administra
-- la sucursal dueña de la campaña. NULL = se prepara en la misma sucursal
-- (todas las campañas existentes).
--
-- Aditiva: una columna NULL sin valor por omisión (no reescribe la tabla) y
-- un índice parcial sobre ninguna fila. El código anterior no la lee.
--
-- Es la 141: la 140 ya está en producción (candado de precuenta) y ninguna
-- rama abierta usa la 141.

ALTER TABLE temporada_campanas
  ADD COLUMN IF NOT EXISTS preparada_en uuid NULL;

ALTER TABLE temporada_campanas
  DROP CONSTRAINT IF EXISTS temporada_campanas_preparada_en_fkey,
  ADD CONSTRAINT temporada_campanas_preparada_en_fkey
    FOREIGN KEY (preparada_en) REFERENCES negocios(id) ON DELETE RESTRICT;

-- Una campaña no «se prepara» en su propia sucursal: eso es NULL.
ALTER TABLE temporada_campanas
  DROP CONSTRAINT IF EXISTS temporada_campanas_preparada_en_otra,
  ADD CONSTRAINT temporada_campanas_preparada_en_otra
    CHECK (preparada_en IS NULL OR preparada_en <> negocio_id);

CREATE INDEX IF NOT EXISTS temporada_campanas_preparada_en
  ON temporada_campanas (preparada_en) WHERE preparada_en IS NOT NULL;
