-- ============================================================
-- XABOR — Migración 072: informes de reconciliación de sala.
--
-- Qué resuelve: hasta ahora, cuando el Edge subía lo operado durante un corte,
-- el resultado viajaba al panel como un evento de WebSocket y se perdía con la
-- primera recarga. Un informe que no sobrevive a un F5 no sirve para cuadrar
-- una caja: quien lo necesita lo mira al día siguiente, no en el segundo en
-- que ocurrió.
--
-- Aditiva y reejecutable. No toca ninguna tabla existente.
-- ============================================================

CREATE TABLE IF NOT EXISTS sala_reconciliaciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- Identidad del lote que mandó el Edge. Es lo que hace idempotente el
  -- guardado: si la respuesta se pierde y el Edge reenvía el MISMO lote, no
  -- se apunta dos veces el mismo informe.
  lote_id       TEXT NULL,
  terminal_id   UUID NULL,
  aplicadas     INT NOT NULL DEFAULT 0,
  conflictos    INT NOT NULL DEFAULT 0,
  -- El reporte completo, tal como lo devolvió `sincronizarLoteSala`: qué
  -- cuenta, qué mesa, con qué folio y qué conflicto. Se guarda entero a
  -- propósito -- reconstruirlo después sería imposible.
  reporte       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Qué quedó sin subir tras este intento. Cero significa que el corte cerró
  -- completo; cualquier otro número es trabajo pendiente de una persona.
  pendientes    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Cierre del informe: quién lo revisó y cuándo. Un conflicto sigue abierto
  -- hasta que alguien dice que lo miró.
  revisado_por  UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  revisado_at   TIMESTAMPTZ NULL,
  nota_revision TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_sala_reconc_negocio
  ON sala_reconciliaciones (negocio_id, created_at DESC);

-- Un lote se apunta UNA vez por negocio. El índice es la garantía real: dos
-- llegadas simultáneas del mismo lote no pueden crear dos informes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sala_reconc_lote
  ON sala_reconciliaciones (negocio_id, lote_id) WHERE lote_id IS NOT NULL;

-- Los que todavía tienen algo que decidir, que es lo que se pinta arriba en la
-- pantalla.
CREATE INDEX IF NOT EXISTS idx_sala_reconc_abiertos
  ON sala_reconciliaciones (negocio_id, created_at DESC)
  WHERE revisado_at IS NULL AND (conflictos > 0 OR pendientes > 0);
