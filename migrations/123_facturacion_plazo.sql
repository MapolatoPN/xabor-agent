-- Facturación, fase 2: plazo para facturar una venta y mes desde el que Xabor
-- hace la factura global.
--
-- plazo_tipo 'fin_de_mes' (por omisión): una venta se puede facturar hasta el
-- último día de su mes, en la zona del negocio. 'dias': hasta plazo_dias
-- después de la venta. Vencido el plazo, la venta queda para la global.
--
-- global_desde: las ventas anteriores las declara el contador en su propia
-- global (decisión de Mario, 23-oct: Xabor desde noviembre de 2026).
ALTER TABLE facturacion_configuracion
  ADD COLUMN IF NOT EXISTS plazo_tipo text NOT NULL DEFAULT 'fin_de_mes',
  ADD COLUMN IF NOT EXISTS plazo_dias integer,
  ADD COLUMN IF NOT EXISTS global_desde date NOT NULL DEFAULT DATE '2026-11-01';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_facturacion_plazo') THEN
    ALTER TABLE facturacion_configuracion ADD CONSTRAINT chk_facturacion_plazo CHECK (
      plazo_tipo IN ('fin_de_mes','dias')
      AND (plazo_tipo <> 'dias' OR (plazo_dias BETWEEN 1 AND 365)));
  END IF;
END $$;
