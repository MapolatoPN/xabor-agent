-- ============================================================
-- XABOR Multiempresa — Migración 035
-- Perfil administrativo del repartidor: estado de ciclo de vida
-- (disponible/pausado/suspendido/baja) + metadata geográfica opcional
-- (ciudad/zona/vehiculo), para el módulo Superadmin "Red de Repartidores".
--
-- Decisión de diseño (confirmada con el usuario): `activo` sigue siendo
-- la ÚNICA fuente de verdad que lee el motor de elegibilidad
-- (notificarRepartidoresPorWA, esPedidoElegibleParaRedRepartidores) --
-- esta migración NO cambia esa lógica ni la toca. `estado` es una capa
-- administrativa nueva, encima de `activo`, que se sincroniza
-- atómicamente desde una única función (cambiarEstadoRepartidor en
-- database.js): disponible -> activo=true; pausado/suspendido/baja ->
-- activo=false. Nunca debe existir una ruta que escriba uno sin el otro.
--
-- "Ocupado" NO es un valor de esta columna -- se deriva en consulta
-- (repartidor con estado=disponible y un pedido activo ya asignado),
-- nunca se persiste.
--
-- ciudad/zona/vehiculo son NULLABLE y puramente informativos por ahora:
-- no se usan como criterio de elegibilidad en esta fase (el encargo
-- explícitamente pide no diseñar todavía lógica geográfica sobre
-- zona TEXT). Se capturan/editan desde el detalle del repartidor en
-- Superadmin (ver docs/red-repartidores-superadmin.md).
--
-- Reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'disponible'
    CHECK (estado IN ('disponible', 'pausado', 'suspendido', 'baja')),
  ADD COLUMN IF NOT EXISTS ciudad TEXT,
  ADD COLUMN IF NOT EXISTS zona TEXT,
  ADD COLUMN IF NOT EXISTS vehiculo TEXT;

COMMIT;
