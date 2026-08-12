-- ============================================================
-- XABOR Multiempresa — Migración 049
-- WhatsApp Business App Coexistence: el dueño conserva la app en su
-- teléfono (notificaciones + respuesta manual) mientras el bot de Xabor
-- opera el MISMO número por Cloud API (mecanismo oficial de Meta).
--
-- Dos piezas, ambas backward-compatible:
--
-- 1. integraciones_canal.connection_mode -- cómo quedó conectado el
--    número: 'cloud_api' (flujo estándar, TODO lo existente) o
--    'coexistence' (onboarding desde la Business App). Sin CHECK IN a
--    propósito -- mismo criterio que terminales.tipo/impresoras.transporte:
--    agregar un modo nuevo no debe requerir otra migración; la validación
--    de valores vive en la aplicación. DEFAULT 'cloud_api' deja todas las
--    integraciones existentes exactamente como están.
--
-- 2. clientes.human_takeover_until / last_business_app_message_at -- la
--    intervención humana POR CONVERSACIÓN: cuando el dueño responde desde
--    su Business App (webhook smb_message_echoes), el bot se silencia para
--    ESA conversación hasta que venza el plazo. Es deliberadamente un
--    mecanismo DISTINTO de clientes.bot_pausado: bot_pausado es la pausa
--    MANUAL sin vencimiento (la controla el panel y nadie más); el
--    takeover es automático y temporal. Mantenerlos separados garantiza
--    que el vencimiento del takeover jamás pueda des-pausar una
--    conversación que el dueño pausó a mano.
--
-- 3. mensajes.tipo admite 'texto_historico' -- los mensajes que Meta
--    entrega por el webhook `history` (sincronización opcional de 6 meses
--    de chats de la app) se importan MARCADOS como históricos: aparecen en
--    la conversación pero jamás alimentan al bot ni se confunden con
--    tráfico en vivo. Mismo patrón de ampliación del CHECK que la 029.
--
-- Reejecutable: IF NOT EXISTS / drop-and-recreate del CHECK.
-- ============================================================

BEGIN;

ALTER TABLE integraciones_canal
  ADD COLUMN IF NOT EXISTS connection_mode TEXT NOT NULL DEFAULT 'cloud_api';

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS human_takeover_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_business_app_message_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_tipo_check') THEN
    ALTER TABLE mensajes DROP CONSTRAINT mensajes_tipo_check;
  END IF;
  ALTER TABLE mensajes ADD CONSTRAINT mensajes_tipo_check
    CHECK (tipo IN ('texto','documento','imagen','texto_historico'));
END $$;

-- 4. integraciones_canal.estado admite 'desconectado' -- el webhook
--    account_update/PARTNER_REMOVED (el dueño desvinculó a Xabor desde su
--    Business App) marca este estado SIN borrar nada: la integración, las
--    credenciales y el historial quedan intactos para reconectar desde el
--    panel. Mismo patrón de ampliación del CHECK que la 025.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integraciones_canal_estado_check') THEN
    ALTER TABLE integraciones_canal DROP CONSTRAINT integraciones_canal_estado_check;
  END IF;
  ALTER TABLE integraciones_canal ADD CONSTRAINT integraciones_canal_estado_check
    CHECK (estado IN ('no_configurado','pendiente_configuracion','pendiente_activacion','activo','suspendido','error','eliminado','desconectado'));
END $$;

COMMIT;
