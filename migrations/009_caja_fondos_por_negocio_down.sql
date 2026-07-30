-- ============================================================
-- XABOR Multiempresa — Rollback Migración 009
-- Revierte ÚNICAMENTE lo que 009 cambió: NOT NULL en negocio_id y el
-- reemplazo de UNIQUE(fecha) por UNIQUE(negocio_id, fecha). NO toca la
-- columna negocio_id, su FK ni su índice — esos pertenecen a la
-- migración 007, no a esta. No es destructivo: nunca borra filas, nunca
-- combina fondos, nunca elige arbitrariamente entre negocios.
--
-- PREFLIGHT OBLIGATORIO (antes de cualquier ALTER): si dos o más
-- negocios tienen cada uno un fondo para la MISMA fecha, restaurar
-- UNIQUE(fecha) global es físicamente imposible sin borrar, combinar o
-- elegir arbitrariamente una de las filas en conflicto — esta migración
-- se niega a hacer eso. En ese caso el rollback se aborta POR COMPLETO,
-- con un error claro que lista las fechas en conflicto, sin tocar
-- ningún dato ni esquema. Requiere una estrategia manual de datos
-- (decidir qué fondo por fecha debe prevalecer, o mantener el esquema
-- multiempresa) antes de poder reintentarse.
--
-- Todo el rollback corre dentro de una sola transacción explícita: si
-- cualquier paso falla (incluida la salida del preflight), TODO se
-- revierte — nunca queda una migración parcialmente revertida.
-- Reejecutable si no hay fechas duplicadas.
-- ============================================================

BEGIN;

-- ── PREFLIGHT: fechas duplicadas entre negocios ──────────────────────
-- Si negocio_id ya no existe en caja_fondos, el rollback de 007 (o de
-- una ejecución previa de este mismo down) ya se aplicó: no hay nada
-- que verificar ni que revertir.
DO $$
DECLARE
  v_col_exists BOOLEAN;
  v_dup_fechas TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'caja_fondos' AND column_name = 'negocio_id'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RETURN;
  END IF;

  -- Consulta exacta requerida: fechas que aparecen más de una vez en
  -- caja_fondos, sin importar a qué negocio pertenezca cada fila.
  SELECT string_agg(fecha::text, ', ' ORDER BY fecha) INTO v_dup_fechas
  FROM (
    SELECT fecha
    FROM caja_fondos
    GROUP BY fecha
    HAVING COUNT(*) > 1
  ) t;

  IF v_dup_fechas IS NOT NULL THEN
    RAISE EXCEPTION
      'Rollback 009 abortado: existen fondos de más de un negocio para la(s) misma(s) fecha(s) [%]. Restaurar UNIQUE(fecha) global requeriría borrar, combinar o elegir arbitrariamente entre negocios — este rollback nunca lo hace. Resuelve manualmente qué fondo debe prevalecer por fecha (o conserva el esquema multiempresa) antes de reintentar. No se modificó ningún dato ni esquema.',
      v_dup_fechas;
  END IF;
END $$;

-- ── Paso 1: restaurar UNIQUE(fecha), eliminar UNIQUE(negocio_id, fecha)
--    — solo se llega aquí si el preflight anterior no abortó. Se
--    identifica la restricción actual por composición de columnas vía
--    pg_constraint/pg_attribute, no por nombre asumido ─────────────────
DO $$
DECLARE
  v_col_exists   BOOLEAN;
  v_fecha_attnum SMALLINT;
  v_uq_conname   TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'caja_fondos' AND column_name = 'negocio_id'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RETURN;
  END IF;

  SELECT attnum INTO v_fecha_attnum
  FROM pg_attribute WHERE attrelid = 'caja_fondos'::regclass AND attname = 'fecha';

  SELECT conname INTO v_uq_conname
  FROM pg_constraint
  WHERE conrelid = 'caja_fondos'::regclass AND contype = 'u'
    AND conkey @> ARRAY[v_fecha_attnum] AND cardinality(conkey) > 1;

  IF v_uq_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE caja_fondos DROP CONSTRAINT %I', v_uq_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'caja_fondos'::regclass AND contype = 'u' AND conkey = ARRAY[v_fecha_attnum]
  ) THEN
    ALTER TABLE caja_fondos ADD CONSTRAINT caja_fondos_fecha_key UNIQUE (fecha);
  END IF;
END $$;

-- ── Paso 2: negocio_id vuelve a ser nullable. La columna, su FK y su
--    índice NO se eliminan — pertenecen a la migración 007, no a esta ─
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'caja_fondos' AND column_name = 'negocio_id'
  ) THEN
    ALTER TABLE caja_fondos ALTER COLUMN negocio_id DROP NOT NULL;
  END IF;
END $$;

COMMIT;
