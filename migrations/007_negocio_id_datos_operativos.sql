-- ============================================================
-- XABOR Multiempresa Fase 4 — Migración 007
-- Agrega negocio_id (UUID, nullable, FK a negocios) a las tablas de datos
-- operativos que todavía no lo tenían. Es un cambio PURAMENTE ADITIVO:
-- ninguna columna se vuelve NOT NULL, ninguna consulta existente cambia de
-- comportamiento, ningún código de la aplicación lee o escribe esta
-- columna todavía (ver server.js — las rutas de pedidos/clientes/mensajes/
-- rewards/repartidores/memoria siguen sin filtrar por negocio_id a
-- propósito, documentado en el reporte de Fase 4).
--
-- Por qué no se filtra todavía: pedidos, clientes, mensajes,
-- pedidos_programados, transcripciones_voz, repartidores y rewards_* se
-- escriben también desde canales en vivo (WhatsApp, Rappi, voz) que no
-- pasan por esta migración. Si se filtraran las consultas del panel por
-- negocio_id sin antes actualizar esos canales para poblar la columna en
-- cada escritura nueva, los pedidos/clientes/registros creados DESPUÉS de
-- esta migración desaparecerían silenciosamente de las vistas del panel.
-- Esa es precisamente la clase de decisión que no se debe improvisar —
-- queda documentada como pendiente, no resuelta a medias.
--
-- Backfill: todas las filas existentes se asignan al negocio Nonna Maye
-- (slug 'nonna-maye'), porque es el único negocio con datos reales hasta
-- ahora. Esto no es un valor inventado: es el negocio real al que esos
-- datos históricos siempre pertenecieron. Si 'nonna-maye' no existe todavía
-- (base sin migrar 003/004), la migración no falla — deja la columna
-- creada mas sin backfill y lo advierte en la salida de check.
--
-- Reejecutable. No se ejecuta contra Railway/producción en esta fase.
-- ============================================================

DO $$
DECLARE
  v_negocio_id UUID;
  v_tabla TEXT;
  v_tablas TEXT[] := ARRAY[
    'clientes', 'pedidos', 'pedidos_activos', 'mensajes',
    'pedidos_programados', 'transcripciones_voz', 'caja_fondos',
    'repartidores', 'campanas', 'rewards_config', 'rewards_accounts',
    'rewards_movements', 'eventos', 'perfiles_clientes', 'oportunidades'
  ];
BEGIN
  SELECT id INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';

  FOREACH v_tabla IN ARRAY v_tablas LOOP
    -- Saltar tablas que no existan todavía en esta base (p. ej. las de
    -- memory engine si la migración 001 no se ha aplicado) — no es un
    -- error, es un estado de migración parcial válido.
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = v_tabla) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE RESTRICT',
        v_tabla
      );
      IF v_negocio_id IS NOT NULL THEN
        EXECUTE format(
          'UPDATE %I SET negocio_id = $1 WHERE negocio_id IS NULL',
          v_tabla
        ) USING v_negocio_id;
      END IF;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (negocio_id)',
        'idx_' || v_tabla || '_negocio_id', v_tabla);
    END IF;
  END LOOP;

  IF v_negocio_id IS NULL THEN
    RAISE NOTICE 'Migración 007: no existe negocio con slug ''nonna-maye'' todavía — columnas creadas SIN backfill. Aplica 003/004 primero.';
  END IF;
END $$;
