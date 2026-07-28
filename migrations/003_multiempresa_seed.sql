-- ============================================================
-- XABOR Multiempresa — Seed idempotente Migración 003
-- Crea (si no existen) los datos base:
--   negocio:  Nonna Maye (slug: nonna-maye)
--   sucursal: Piedras Negras
--   terminal: Caja principal (codigo: caja-principal)
-- Seguro de ejecutar múltiples veces (no duplica filas).
-- ============================================================

INSERT INTO negocios (nombre, slug)
VALUES ('Nonna Maye', 'nonna-maye')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sucursales (negocio_id, nombre)
SELECT n.id, 'Piedras Negras'
FROM negocios n
WHERE n.slug = 'nonna-maye'
ON CONFLICT (negocio_id, nombre) DO NOTHING;

INSERT INTO terminales (sucursal_id, nombre, codigo)
SELECT s.id, 'Caja principal', 'caja-principal'
FROM sucursales s
JOIN negocios n ON n.id = s.negocio_id
WHERE n.slug = 'nonna-maye' AND s.nombre = 'Piedras Negras'
ON CONFLICT (sucursal_id, codigo) DO NOTHING;
