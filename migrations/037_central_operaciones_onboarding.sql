-- ============================================================
-- XABOR Multiempresa — Migración 037 (LOCAL, no aplicada en producción)
-- Central de Operaciones (Superadmin): pipeline de onboarding por negocio
-- e información de implementación (responsables, fecha objetivo, notas).
-- Aditiva únicamente. Reejecutable.
-- ============================================================

-- Pipeline de onboarding: un solo estado canónico por negocio, separado de
-- negocios.estado (pendiente/activo/suspendido, que describe si el negocio
-- puede OPERAR) -- onboarding_estado describe en qué punto del proceso de
-- IMPLEMENTACIÓN va. Ambos coexisten: un negocio puede estar estado=activo
-- y onboarding=configuracion_en_proceso (operando a medias durante la
-- implementación), o estado=pendiente y onboarding=listo_para_operar
-- (esperando el switch comercial final).
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS onboarding_estado TEXT NOT NULL DEFAULT 'alta_iniciada';
ALTER TABLE negocios DROP CONSTRAINT IF EXISTS chk_negocios_onboarding_estado;
ALTER TABLE negocios ADD CONSTRAINT chk_negocios_onboarding_estado CHECK (onboarding_estado IN (
  'prospecto', 'alta_iniciada', 'invitacion_enviada', 'cuenta_creada',
  'configuracion_en_proceso', 'integraciones', 'pruebas',
  'listo_para_operar', 'activo', 'pausado', 'cancelado'
));

-- Información de implementación: quién acompaña al negocio y qué sigue.
-- JSONB (no columnas sueltas) por el mismo criterio que negocios.checklist:
-- son datos operativos de acompañamiento, no dimensiones de consulta -- y
-- así el índice/listado no crece en columnas cada vez que el equipo pida
-- un campo más. Forma canónica del objeto:
--   { responsable_comercial, responsable_implementacion, fecha_objetivo,
--     siguiente_accion, bloqueantes: [texto], notas, mensualidad }
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS implementacion JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill de onboarding_estado para negocios ya existentes, derivado de lo
-- que ya sabemos (idempotente: solo toca filas que siguen en el default).
-- activo -> 'activo'; con admin con password -> 'configuracion_en_proceso';
-- con invitación vigente -> 'invitacion_enviada'; resto queda 'alta_iniciada'.
UPDATE negocios n SET onboarding_estado = 'activo'
WHERE n.onboarding_estado = 'alta_iniciada' AND n.estado = 'activo';

UPDATE negocios n SET onboarding_estado = 'configuracion_en_proceso'
WHERE n.onboarding_estado = 'alta_iniciada'
  AND EXISTS (
    SELECT 1 FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id
    WHERE un.negocio_id = n.id AND un.rol = 'admin' AND u.password_hash IS NOT NULL
  );

UPDATE negocios n SET onboarding_estado = 'invitacion_enviada'
WHERE n.onboarding_estado = 'alta_iniciada'
  AND EXISTS (
    SELECT 1 FROM invitaciones_usuario i
    WHERE i.negocio_id = n.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
  );

-- Sesiones de soporte (Superadmin entra al panel de un negocio sin conocer
-- la contraseña del cliente). Fila = una sesión temporal emitida; el token
-- de sesión en sí sigue siendo el HMAC stateless de session.js (con flag
-- soporte) -- esta tabla existe para AUDITORÍA y para el cierre manual
-- (revocación server-side de una credencial que de otro modo sería válida
-- hasta su expiración natural).
CREATE TABLE IF NOT EXISTS sesiones_soporte (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  superadmin_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- SHA-256 del token de sesión emitido -- nunca el token en claro (mismo
  -- criterio que invitaciones_usuario.token_hash, migración 012).
  token_hash     TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  cerrada_at     TIMESTAMPTZ NULL,
  motivo         TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sesiones_soporte_token_hash ON sesiones_soporte (token_hash);
CREATE INDEX IF NOT EXISTS idx_sesiones_soporte_negocio ON sesiones_soporte (negocio_id, created_at DESC);
-- Índice parcial para el chequeo caliente por request (¿esta sesión de
-- soporte sigue viva?): solo las no cerradas y no expiradas importan.
CREATE INDEX IF NOT EXISTS idx_sesiones_soporte_vigentes ON sesiones_soporte (token_hash) WHERE cerrada_at IS NULL;
