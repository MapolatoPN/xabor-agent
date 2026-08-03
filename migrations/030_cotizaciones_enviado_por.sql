-- ============================================================
-- XABOR Multiempresa — Migración 030
-- PDF borrador al WhatsApp del administrador -- auditoría de aprobación.
--
-- cotizaciones.enviado_por registra QUIÉN aprobó/envió la cotización al
-- cliente (distinto de created_by, que registra quién CREÓ el borrador
-- -- con el Asistente Comercial, created_by es NULL porque la IA nunca
-- tiene un usuarios.id; enviado_por SIEMPRE es un humano autenticado,
-- nunca la IA, porque solo POST /api/cotizaciones/:id/enviar lo setea).
--
-- No se agrega columna nueva para "telefono del administrador por
-- negocio" -- se reutiliza configuracion (clave/valor por negocio_id,
-- ya existente) con la clave 'admin_whatsapp_telefono', mismo patrón
-- que int_wa_phone_id/logo_base64. Cero migración necesaria para eso.
--
-- Reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

ALTER TABLE cotizaciones ADD COLUMN IF NOT EXISTS enviado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL;

COMMIT;
