-- ============================================================
-- XABOR Multiempresa — Migración 013 (Incidente P0 aislamiento)
-- Backfill de datos, SIN cambio de esquema: rewards_config,
-- rewards_accounts y rewards_movements usan un concepto de tenant_id
-- TEXT propio, previo y desconectado del sistema negocios/negocio_id
-- (deuda documentada en database.js, sección Rewards). Todas las
-- funciones de rewardsService.js ya aceptan un parámetro tenantId
-- (default 'xabor-principal' hardcodeado) — el fix de aislamiento
-- consiste en que el código de servidor empiece a pasar
-- req.negocioId como tenantId en cada llamada. Esta migración solo
-- reetiqueta los datos existentes para que ese cambio de código no
-- deje huérfanos los puntos/movimientos ya acumulados por Nonna Maye.
--
-- Requiere que 003_multiempresa.sql (tabla negocios) ya esté
-- aplicada. Reejecutable.
-- ============================================================

-- ── Paso 1: abortar ANTES de tocar nada si no hay exactamente
--    un negocio con slug='nonna-maye' ─────────────────────────
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM negocios WHERE slug = 'nonna-maye';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Migración 013 abortada: se esperaba exactamente 1 negocio con slug=''nonna-maye'', se encontraron %. No se modificó ningún dato.',
      v_count;
  END IF;
END $$;

-- ── Paso 2: guardas de duplicados — verificar que reetiquetar
--    'xabor-principal' -> negocio_id de nonna-maye no choque con
--    las restricciones UNIQUE existentes. Hoy no debería haber
--    ninguna fila ya escrita con ese tenant_id (nada en el código
--    lo produce todavía), pero se verifica en vez de asumir ────────
DO $$
DECLARE
  v_negocio_id TEXT;
  v_dup_config INTEGER;
  v_dup_accounts INTEGER;
  v_dup_movements INTEGER;
BEGIN
  SELECT id::text INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';

  -- Solo es un conflicto real si TODAVÍA existe una fila 'xabor-principal'
  -- Y ya existe una fila con el tenant_id destino -- eso sí chocaría contra
  -- UNIQUE(tenant_id) al hacer el UPDATE del Paso 3. Si 'xabor-principal'
  -- ya no existe (la migración ya corrió antes), la fila con tenant_id
  -- destino es simplemente el resultado de la corrida anterior -- no es un
  -- duplicado, es el estado ya migrado, y el Paso 3 no tiene nada que
  -- hacer (reejecutable de verdad, no solo en el caso feliz de "nunca se
  -- corrió").
  SELECT count(*) INTO v_dup_config
  FROM rewards_config
  WHERE tenant_id = v_negocio_id
    AND EXISTS (SELECT 1 FROM rewards_config WHERE tenant_id = 'xabor-principal');
  IF v_dup_config > 0 THEN
    RAISE EXCEPTION
      'Migración 013 abortada: ya existe % fila(s) en rewards_config con tenant_id=% Y todavía queda una fila ''xabor-principal'' -- reetiquetar chocaría contra UNIQUE(tenant_id). No se modificó nada.',
      v_dup_config, v_negocio_id;
  END IF;

  SELECT count(*) INTO v_dup_accounts
  FROM rewards_accounts ra
  WHERE ra.tenant_id = v_negocio_id
    AND EXISTS (
      SELECT 1 FROM rewards_accounts o
      WHERE o.tenant_id = 'xabor-principal' AND o.telefono = ra.telefono
    );
  IF v_dup_accounts > 0 THEN
    RAISE EXCEPTION
      'Migración 013 abortada: % cuenta(s) de rewards_accounts chocarían por (telefono, tenant_id) al reetiquetar. No se modificó nada.',
      v_dup_accounts;
  END IF;
END $$;

-- ── Paso 3: backfill — reetiquetar 'xabor-principal' al
--    negocio_id real de Nonna Maye (resuelto por slug, nunca
--    hardcodeado). Reejecutable: solo toca filas que todavía
--    tengan el tenant_id legado ─────────────────────────────────
DO $$
DECLARE
  v_negocio_id TEXT;
BEGIN
  SELECT id::text INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';

  UPDATE rewards_config    SET tenant_id = v_negocio_id WHERE tenant_id = 'xabor-principal';
  UPDATE rewards_accounts  SET tenant_id = v_negocio_id WHERE tenant_id = 'xabor-principal';
  UPDATE rewards_movements SET tenant_id = v_negocio_id WHERE tenant_id = 'xabor-principal';
END $$;
