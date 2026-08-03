-- Migración 027 (rama hotfix/cotizaciones-telefono-multiempresa-iva):
-- persiste la TASA de IVA usada en cada cotización, no solo el importe
-- resultante. Hoy `cotizaciones.impuestos` guarda un monto en pesos,
-- pero la tasa (impuestosPct) es un parámetro de request que nunca se
-- guarda -- imposible saber después "¿a qué % se cobró esto?", y el
-- panel nunca ofrecía siquiera un campo para capturarla (por eso Alora
-- veía $0.00 de impuestos con su tasa real del 8%).
--
-- NOTA DE NUMERACIÓN: esta rama parte del commit ya desplegado en
-- producción (hasta la migración 026). El número 027 colisiona por
-- nombre con dos ramas NO fusionadas todavía: 027_sesiones_comerciales
-- (Asistente Comercial, ya pusheada a origin) y 027_aislamiento_crm_
-- multiempresa (Fase 0 CRM, solo local). Este hotfix es el que se
-- desplegará primero (corrige un bug ya encontrado en producción) --
-- ver el plan de reconciliación final en el reporte de esta sesión:
-- al integrar las otras dos ramas, sus migraciones se renumeran a
-- 028/029/030 en ese orden.
--
-- Reejecutable: ADD COLUMN IF NOT EXISTS + backfill idempotente (solo
-- toca filas con impuestos_tasa aún en su default 0).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cotizaciones' AND column_name = 'impuestos_tasa'
  ) THEN
    ALTER TABLE cotizaciones ADD COLUMN impuestos_tasa NUMERIC(5,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cotizaciones_impuestos_tasa_check') THEN
    ALTER TABLE cotizaciones DROP CONSTRAINT cotizaciones_impuestos_tasa_check;
  END IF;
  ALTER TABLE cotizaciones ADD CONSTRAINT cotizaciones_impuestos_tasa_check
    CHECK (impuestos_tasa >= 0 AND impuestos_tasa <= 100);
END $$;

-- Backfill: deriva la tasa YA IMPLÍCITA en subtotal/impuestos guardados
-- -- nunca inventa una tasa nueva, nunca cambia ningún total ya
-- mostrado. La inmensa mayoría de filas existentes quedará en 0% (el
-- panel nunca envió otro valor hasta hoy), exactamente el mismo importe
-- que ya tenían.
UPDATE cotizaciones
SET impuestos_tasa = ROUND((impuestos / NULLIF(subtotal, 0)) * 100, 2)
WHERE subtotal > 0 AND impuestos > 0 AND impuestos_tasa = 0;

COMMIT;
