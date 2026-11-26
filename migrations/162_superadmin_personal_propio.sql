-- El permiso permanece apagado en todas las cuentas existentes. Concederlo
-- requiere una operación administrativa explícita y auditada. No otorga
-- membresías ni permite administrar Empleados desde soporte.
ALTER TABLE administradores_plataforma
  ADD COLUMN IF NOT EXISTS personal_en_negocios_propios BOOLEAN NOT NULL DEFAULT false;
