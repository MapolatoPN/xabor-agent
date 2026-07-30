-- ============================================================
-- Rollback de la migración 013 — revierte el reetiquetado de
-- tenant_id de vuelta a 'xabor-principal' en las 3 tablas rewards.
-- Reejecutable.
-- ============================================================

DO $$
DECLARE
  v_negocio_id TEXT;
BEGIN
  SELECT id::text INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';
  IF v_negocio_id IS NULL THEN
    RAISE NOTICE 'Rollback 013: no se encontró negocio nonna-maye, nada que revertir.';
    RETURN;
  END IF;

  UPDATE rewards_config    SET tenant_id = 'xabor-principal' WHERE tenant_id = v_negocio_id;
  UPDATE rewards_accounts  SET tenant_id = 'xabor-principal' WHERE tenant_id = v_negocio_id;
  UPDATE rewards_movements SET tenant_id = 'xabor-principal' WHERE tenant_id = v_negocio_id;
END $$;
