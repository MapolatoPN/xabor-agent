-- ─── 090 down: revertir canal en tienda_promocion_usos ──────────────────────
ALTER TABLE tienda_promocion_usos DROP COLUMN IF EXISTS canal;
