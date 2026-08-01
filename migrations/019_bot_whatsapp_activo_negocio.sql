-- ============================================================
-- XABOR Multiempresa — Migración 019
-- Interruptor de bot por negocio, a nivel de plataforma:
-- negocios.bot_whatsapp_activo. Independiente del estado técnico de
-- la integración de WhatsApp (Fase B/C) -- una integración puede estar
-- "activo" (credenciales válidas, puede enviar/recibir) sin que el bot
-- de IA responda a clientes, si bot_whatsapp_activo = FALSE.
--
-- Motivación: ninguna parte del pipeline de mensajes
-- (whatsapp-meta.js/brain.js) revisaba el estado comercial del módulo
-- ni ningún otro interruptor por negocio antes de invocar a Claude --
-- conectar credenciales reales para un negocio nuevo activaría el bot
-- de inmediato para el primer cliente que escribiera. Este interruptor
-- cierra ese hueco. Regla exacta que aplica el código (no esta
-- migración): el bot responde solo si bot_whatsapp_activo = TRUE Y
-- bot_pausado_cliente = FALSE (clientes.bot_pausado, ya existente).
--
-- Default FALSE: toda integración nueva (Alora, Mapolato Acuña, y
-- cualquier negocio futuro) queda con el bot apagado hasta que el
-- negocio lo active explícitamente. Con el bot apagado, los mensajes
-- entrantes se siguen guardando y mostrando en el chat de Xabor
-- (guardarMensaje/broadcast no dependen de este interruptor) -- solo
-- se omite el paso de invocar a brain.js.
--
-- Backfill: Nonna Maye es el único negocio con el bot realmente en
-- producción hoy -- se preserva su comportamiento actual (TRUE),
-- localizada por slug (nunca por conteo total de negocios). Alora y
-- Mapolato Acuña quedan explícitamente en FALSE (ya es el default,
-- pero se deja explícito por claridad y para que una futura migración
-- que cambie el default no los afecte por accidente).
--
-- Reejecutable (columna con IF NOT EXISTS, backfill idempotente).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 019_bot_whatsapp_activo_negocio.sql
-- ============================================================

BEGIN;

ALTER TABLE negocios ADD COLUMN IF NOT EXISTS bot_whatsapp_activo BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') = 0 THEN
    RAISE EXCEPTION 'Migración 019 abortada: no se encontró el negocio con slug ''nonna-maye''. Transacción revertida.';
  END IF;
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') > 1 THEN
    RAISE EXCEPTION 'Migración 019 abortada: slug ''nonna-maye'' es ambiguo (más de un negocio). Transacción revertida.';
  END IF;
END $$;

UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE slug = 'nonna-maye';
UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE slug IN ('alora-floreria-y-eventos', 'mapolato-acuna');

COMMIT;
