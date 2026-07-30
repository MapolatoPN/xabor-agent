-- ============================================================
-- XABOR Multiempresa Fase 4 — Rollback Migración 007
-- Elimina la columna negocio_id agregada por 007 en las tablas de datos
-- operativos. Seguro: la columna nunca fue NOT NULL ni fue usada para
-- filtrar ninguna consulta de la aplicación (ver 007), así que eliminarla
-- no puede romper ningún filtro activo. Reejecutable.
-- ============================================================

DO $$
DECLARE
  v_tabla TEXT;
  v_tablas TEXT[] := ARRAY[
    'clientes', 'pedidos', 'pedidos_activos', 'mensajes',
    'pedidos_programados', 'transcripciones_voz', 'caja_fondos',
    'repartidores', 'campanas', 'rewards_config', 'rewards_accounts',
    'rewards_movements', 'eventos', 'perfiles_clientes', 'oportunidades'
  ];
BEGIN
  FOREACH v_tabla IN ARRAY v_tablas LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = v_tabla) THEN
      EXECUTE format('DROP INDEX IF EXISTS %I', 'idx_' || v_tabla || '_negocio_id');
      EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS negocio_id', v_tabla);
    END IF;
  END LOOP;
END $$;
