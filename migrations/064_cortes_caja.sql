-- 064 — Cortes de caja como cierres históricos reales.
--
-- Hasta hoy "Corte" era un resumen VIVO: se recalculaba en cada carga desde
-- pedidos_activos. Eso significa que el corte de ayer podía cambiar hoy si
-- alguien editaba un pedido viejo, y que no existía constancia de qué se
-- contó ni de cuánto faltó. Un arqueo que se recalcula no es un arqueo.
--
-- INVARIANTE CENTRAL: un corte cerrado NUNCA se recalcula. Todo lo que el
-- ticket necesita queda congelado en columnas + snapshot_json al momento del
-- cierre. Las tablas de origen pueden cambiar después; el corte no.
--
-- Idempotente: todo es CREATE ... IF NOT EXISTS. Correrla dos veces no
-- duplica nada ni pierde datos.

-- ── cortes_caja ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cortes_caja (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, igual que el resto del esquema multiempresa: un negocio con
  -- historia financiera no se borra físicamente.
  negocio_id            UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- Preparado para el futuro (turnos/varias cajas) sin usarse en V1: hoy es
  -- UN corte diario global por negocio. Cuando existan turnos, se agrega
  -- turno_id y se amplía el UNIQUE -- sin reescribir un solo corte histórico.
  sucursal_id           UUID NULL REFERENCES sucursales(id) ON DELETE RESTRICT,

  -- Día OPERATIVO del negocio (en su propia zona horaria), no un día UTC.
  fecha_operativa       DATE NOT NULL,
  estado                TEXT NOT NULL DEFAULT 'cerrado' CHECK (estado IN ('cerrado')),
  folio                 TEXT NOT NULL,
  usuario_id            UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  abierto_at            TIMESTAMPTZ NULL,
  cerrado_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  fondo_inicial         NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- VENTAS DEL PERIODO (lo que se vendió, sin importar si es dinero físico)
  ventas_totales        NUMERIC(12,2) NOT NULL DEFAULT 0,
  ventas_efectivo       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ventas_tarjeta        NUMERIC(12,2) NOT NULL DEFAULT 0,
  ventas_enlace         NUMERIC(12,2) NOT NULL DEFAULT 0,
  ventas_otros          NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- MOVIMIENTOS DE DINERO FÍSICO
  entradas              NUMERIC(12,2) NOT NULL DEFAULT 0,
  retiros               NUMERIC(12,2) NOT NULL DEFAULT 0,
  gastos                NUMERIC(12,2) NOT NULL DEFAULT 0,
  devoluciones_efectivo NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- ARQUEO. efectivo_contado es NULL-able a propósito: distingue "cerré sin
  -- contar" de "conté y había cero".
  efectivo_esperado     NUMERIC(12,2) NOT NULL DEFAULT 0,
  efectivo_contado      NUMERIC(12,2) NULL,
  diferencia            NUMERIC(12,2) NOT NULL DEFAULT 0,
  nota                  TEXT NULL,

  pedidos_count         INTEGER NOT NULL DEFAULT 0,
  cancelaciones_count   INTEGER NOT NULL DEFAULT 0,
  devoluciones_total    NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Todo el detalle congelado: desglose por forma de pago, lista de pedidos,
  -- movimientos, cobros de días anteriores, zona horaria y rango UTC usado.
  -- El ticket se arma SIEMPRE desde aquí, nunca volviendo a consultar ventas.
  snapshot_json         JSONB NOT NULL DEFAULT '{}',

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La garantía de "un corte por día" vive en la base, no en la aplicación:
-- es lo que hace que un doble click no pueda crear dos cortes aunque las dos
-- peticiones lleguen a la vez. UNIQUE simple (no parcial) para que
-- ON CONFLICT pueda inferirlo sin ambigüedad.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cortes_caja_negocio_fecha
  ON cortes_caja (negocio_id, fecha_operativa);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cortes_caja_negocio_folio
  ON cortes_caja (negocio_id, folio);
CREATE INDEX IF NOT EXISTS idx_cortes_caja_negocio_fecha
  ON cortes_caja (negocio_id, fecha_operativa DESC);

-- ── movimientos_caja ────────────────────────────────────────────────────────
-- Deliberadamente mínimo: entrada, retiro y gasto. NO es contabilidad
-- general; es lo que hace falta para que el efectivo esperado cuadre.
CREATE TABLE IF NOT EXISTS movimientos_caja (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  fecha_operativa DATE NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('entrada','retiro','gasto')),
  monto           NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  motivo          TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  usuario_id      UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Se sella al cerrar: un movimiento que ya entró a un corte cerrado queda
  -- marcado, y por eso no puede volver a contarse ni editarse.
  corte_id        UUID NULL REFERENCES cortes_caja(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_negocio_fecha
  ON movimientos_caja (negocio_id, fecha_operativa, created_at);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_corte
  ON movimientos_caja (corte_id) WHERE corte_id IS NOT NULL;
