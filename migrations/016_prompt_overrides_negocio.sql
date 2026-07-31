-- ============================================================
-- XABOR Multiempresa — Migración 016
-- Agrega negocio_id a prompt_overrides (tabla creada originalmente de
-- forma inline en el bootstrap de database.js, sin negocio_id -- todos
-- los overrides existentes le pertenecen implícitamente a Nonna Maye,
-- el único negocio con bot operando hasta hoy).
--
-- Fase A de aislamiento de WhatsApp: sin esto, un override de Nonna
-- Maye se filtraría al prompt de cualquier otro negocio (Alora
-- incluida) en cuanto tuviera bot activo.
--
-- Localización de negocio: igual que la migración 015, por slug
-- específico, nunca por conteo total de negocios en la base.
--
-- Aditiva y reejecutable. No borra ni modifica seccion/contenido/activo
-- de ninguna fila existente.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 016_prompt_overrides_negocio.sql
-- ============================================================

BEGIN;

-- ── Paso 1: columna nueva, nullable temporalmente (se vuelve NOT NULL
--    en el Paso 3, después del backfill) ──────────────────────────────
ALTER TABLE prompt_overrides ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE RESTRICT;

-- ── Paso 2: localizar Nonna Maye por slug y asignarle TODOS los
--    overrides que hoy no tienen negocio_id -- son suyos porque es el
--    único negocio con bot operando en este punto del proyecto ────────
DO $$
DECLARE
  v_nonna_id UUID;
BEGIN
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') = 0 THEN
    RAISE EXCEPTION 'Migración 016 abortada: no se encontró el negocio con slug ''nonna-maye''. Transacción revertida.';
  END IF;
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') > 1 THEN
    RAISE EXCEPTION 'Migración 016 abortada: slug ''nonna-maye'' es ambiguo (más de un negocio). Transacción revertida.';
  END IF;

  SELECT id INTO v_nonna_id FROM negocios WHERE slug = 'nonna-maye';
  UPDATE prompt_overrides SET negocio_id = v_nonna_id WHERE negocio_id IS NULL;
END $$;

-- ── Paso 3: a partir de aquí, negocio_id es obligatorio para cualquier
--    fila futura -- ningún override "huérfano" (sin negocio) puede
--    volver a crearse ───────────────────────────────────────────────
ALTER TABLE prompt_overrides ALTER COLUMN negocio_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_overrides_negocio ON prompt_overrides (negocio_id, activo);

COMMIT;
