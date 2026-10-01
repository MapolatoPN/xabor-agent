-- 112 — Bitácora de correcciones de caja.
--
-- Hasta hoy un fondo inicial o un gasto/retiro capturado por error no tenía
-- arreglo desde el panel: el fondo se insertaba con ON CONFLICT DO NOTHING
-- (la "corrección" respondía ok y no cambiaba nada) y los movimientos no
-- tenían ruta para editarse ni anularse.
--
-- Corregir se permite SOLO mientras el día está abierto. Cada corrección
-- deja aquí el antes, el después, el motivo y quién la hizo. Un movimiento
-- anulado se borra de movimientos_caja; su copia íntegra queda en `antes`.
--
-- Aditiva e idempotente: una tabla nueva, vacía. No toca ni una fila de
-- caja_fondos, movimientos_caja, cortes_caja ni pedidos.
CREATE TABLE IF NOT EXISTS caja_correcciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  fecha_operativa DATE NOT NULL,
  objeto          TEXT NOT NULL CHECK (objeto IN ('fondo', 'movimiento')),
  accion          TEXT NOT NULL CHECK (accion IN ('corregir', 'anular')),
  -- Sin FK a propósito: el movimiento anulado deja de existir y su
  -- corrección tiene que sobrevivirle.
  movimiento_id   UUID NULL,
  antes           JSONB NOT NULL,
  despues         JSONB NULL,
  motivo          TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  usuario_id      UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_caja_correcciones_negocio_fecha
  ON caja_correcciones (negocio_id, fecha_operativa, created_at);
COMMENT ON TABLE caja_correcciones IS 'Correcciones de fondo inicial y movimientos de caja hechas con el día abierto: antes, después, motivo y usuario.';
