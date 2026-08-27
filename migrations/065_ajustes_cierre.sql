-- 065 — Ajustes de cierre semanal + registro local de facturación.
--
-- DOS PRINCIPIOS GOBIERNAN ESTA MIGRACIÓN:
--
-- 1. LA VENTA ORIGINAL ES INMUTABLE. Un descuento, bonificación, cortesía,
--    devolución o ajuste administrativo NUNCA reescribe pedidos_activos ni
--    un corte cerrado: es un REGISTRO SEPARADO (ajustes_cierre) que conserva
--    monto original, monto del ajuste y neto. El reporte siempre puede
--    mostrar las tres cifras.
--
-- 2. UNA VENTA FACTURADA ESTÁ BLOQUEADA. La auditoría previa a esta
--    migración encontró que Xabor NO tenía ninguna fuente por ticket del
--    hecho "este pedido ya tiene CFDI": la emisión (Facturapi, vía panel o
--    WhatsApp) devolvía el UUID al cliente y lo descartaba, y la tabla
--    `invoices` solo contiene CFDIs DESCARGADOS del SAT sin enlace a
--    pedidos. `facturas_pedido` registra la emisión EN EL MOMENTO en que
--    ocurre — el único punto veraz — y se vuelve la fuente del bloqueo.
--
--    BRECHA DOCUMENTADA: las facturas emitidas ANTES de este cambio no
--    tienen registro y NO se reconstruyen adivinando (cruzar `invoices` por
--    monto/fecha sería inventar el enlace). Esas ventas aparecerán como no
--    facturadas; el operador es responsable de no ajustarlas.
--
-- Idempotente: todo es CREATE ... IF NOT EXISTS. Correrla dos veces no
-- duplica nada ni pierde datos.

-- ── facturas_pedido ─────────────────────────────────────────────────────────
-- Un renglón por emisión de CFDI sobre un pedido. No es el CFDI (ese vive en
-- Facturapi/SAT): es el ENLACE pedido→factura que faltaba. Sin UNIQUE por
-- folio a propósito: una refacturación legítima agrega otro renglón y el
-- bloqueo de ajustes pregunta por EXISTS, no por unicidad.
CREATE TABLE IF NOT EXISTS facturas_pedido (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  folio       TEXT NOT NULL,
  proveedor   TEXT NOT NULL DEFAULT 'facturapi',
  factura_id  TEXT NULL,             -- id de la factura en el proveedor
  uuid        TEXT NULL,             -- folio fiscal (UUID del timbrado)
  total       NUMERIC(12,2) NULL,    -- total del pedido al emitir
  fuente      TEXT NOT NULL CHECK (fuente IN ('panel', 'whatsapp')),
  emitida_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_facturas_pedido_negocio_folio
  ON facturas_pedido (negocio_id, folio);

-- ── ajustes_cierre ──────────────────────────────────────────────────────────
-- Cada renglón es UN ajuste sobre UNA venta. Una multi-selección (p. ej.
-- "$5 de descuento a estos 12 tickets") comparte lote_id: son 12 renglones,
-- uno por ticket, aplicados y reversibles como unidad o individualmente.
--
-- Reversión, jamás borrado: revertir marca estado='revertido' con actor,
-- motivo y fecha. El renglón queda como constancia histórica.
CREATE TABLE IF NOT EXISTS ajustes_cierre (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id       UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  lote_id          UUID NOT NULL,
  -- Lunes del periodo semanal revisado (día operativo del negocio).
  semana_inicio    DATE NOT NULL,
  folio            TEXT NOT NULL,
  tipo             TEXT NOT NULL CHECK (tipo IN
                     ('descuento', 'bonificacion', 'cortesia', 'devolucion', 'ajuste')),
  modo             TEXT NOT NULL CHECK (modo IN ('fijo', 'porcentual')),
  -- Solo informativo en modo porcentual (el monto ya viene calculado).
  porcentaje       NUMERIC(5,2) NULL CHECK (porcentaje IS NULL OR (porcentaje > 0 AND porcentaje <= 100)),
  monto_original   NUMERIC(12,2) NOT NULL CHECK (monto_original >= 0),
  monto_ajuste     NUMERIC(12,2) NOT NULL CHECK (monto_ajuste > 0),
  monto_neto       NUMERIC(12,2) NOT NULL CHECK (monto_neto >= 0),
  motivo           TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  usuario_id       UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  estado           TEXT NOT NULL DEFAULT 'aplicado' CHECK (estado IN ('aplicado', 'revertido')),
  revertido_at     TIMESTAMPTZ NULL,
  revertido_por    UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_reversion TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- La aritmética queda garantizada por la base, no por la aplicación.
  CONSTRAINT chk_ajuste_aritmetica CHECK (monto_neto = monto_original - monto_ajuste)
);
CREATE INDEX IF NOT EXISTS idx_ajustes_cierre_negocio_semana
  ON ajustes_cierre (negocio_id, semana_inicio, created_at);
CREATE INDEX IF NOT EXISTS idx_ajustes_cierre_negocio_folio
  ON ajustes_cierre (negocio_id, folio);
CREATE INDEX IF NOT EXISTS idx_ajustes_cierre_lote
  ON ajustes_cierre (lote_id);
