-- 068 — Promociones condicionadas por MODIFICADORES.
--
-- Una promoción por productos específicos puede exigir, además del producto,
-- que ciertos GRUPOS de modificadores cumplan condiciones (p. ej. "Salsa debe
-- ser Roja o Verde", "Proteína debe incluir Pollo", "2 guarniciones"). Se
-- guarda como jsonb — mismo criterio que productos/categorias/canales/dias.
--
-- Forma de cada condición (validada en guardarPromocion, fail-closed):
--   { "producto_id": 123, "grupo_id": 45, "operador": "una_de"|"incluye"|"cantidad",
--     "option_ids": [1,2], "min": 2, "max": 2 }
-- Todas las condiciones de una promoción son AND. Los option_ids/grupo_id son
-- IDs REALES de menu_modificadores_* del MISMO negocio.
--
-- Idempotente y NO destructivo: solo agrega una columna nullable. Una promoción
-- sin condiciones (columna NULL) se comporta EXACTAMENTE igual que hoy.
ALTER TABLE tienda_promociones
  ADD COLUMN IF NOT EXISTS condiciones_modificadores jsonb;
