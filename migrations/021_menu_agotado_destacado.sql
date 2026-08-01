-- ============================================================
-- XABOR Multiempresa — Migración 021
-- Fase 3 del panel comercial: distingue "agotado" (temporalmente sin
-- existencias, pero sigue siendo un producto real del catálogo) de
-- "disponible" (visible/activo en el catálogo). Antes solo existía
-- `disponible`, que se usaba para ambas cosas a la vez -- un producto
-- descontinuado y uno momentáneamente sin stock se veían igual.
--
-- `destacado`: permite marcar productos para resaltarlos en el panel
-- (vista previa / catálogo). No cambia el comportamiento del bot por sí
-- solo -- es informativo para el negocio.
--
-- `agotado=true` SÍ afecta al bot: formatearMenu (prompts.js) deja de
-- ofrecer un producto agotado aunque siga `disponible=true`, sin que el
-- negocio tenga que desactivarlo por completo y perder el resto de su
-- configuración (precio, categoría, modificadores).
--
-- Reejecutable (ADD COLUMN IF NOT EXISTS, defaults seguros -- todo el
-- catálogo existente queda con agotado=false/destacado=false, es decir,
-- se sigue ofreciendo exactamente igual que antes de esta migración).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 021_menu_agotado_destacado.sql
-- ============================================================

BEGIN;

ALTER TABLE menu_productos ADD COLUMN IF NOT EXISTS agotado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE menu_productos ADD COLUMN IF NOT EXISTS destacado BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
