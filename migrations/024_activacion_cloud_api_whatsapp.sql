-- ============================================================
-- XABOR Multiempresa — Migración 024
-- Activación real de WhatsApp Cloud API tras Embedded Signup.
--
-- Diagnóstico que motiva esta migración: guardarCredencialesCifradas
-- marcaba la integración como 'activo' solo por tener phone_number_id +
-- access_token guardados -- nunca se llamaba a
-- POST /{PHONE_NUMBER_ID}/register (registro del número para Cloud API,
-- requiere PIN de verificación en dos pasos) ni a
-- POST /{WABA_ID}/subscribed_apps (suscripción de la app a la WABA,
-- requisito para recibir webhooks). Resultado real observado: el número
-- de Alora quedó en Meta con estado "Pendiente", podía enviar mensajes
-- pero sin doble palomita, y Railway nunca recibió webhooks.
--
-- Esta migración es puramente aditiva -- no cambia el valor de `estado`
-- de ninguna fila existente (Alora y Nonna Maye conservan exactamente el
-- valor que ya tenían). El código nuevo (Fase de activación real) usa
-- estas columnas para decidir, a partir de ahora, cuándo una integración
-- realmente puede considerarse operable.
--
-- Reejecutable. Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 024_activacion_cloud_api_whatsapp.sql
-- ============================================================

BEGIN;

-- ── Paso 1: columnas de estado granular de activación en integraciones_canal ──
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS numero_registrado_cloud_api BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS app_suscrita_waba BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS ultimo_intento_activacion_at TIMESTAMPTZ;

-- ── Paso 2: ampliar el CHECK de estado con 'pendiente_activacion' --
-- guardarCredencialesCifradas usa este estado (nunca 'activo' de
-- inmediato) mientras no se confirme el registro Cloud API + la
-- suscripción de la app a la WABA. Se elimina y recrea el CHECK
-- existente (Postgres no soporta ALTER de un CHECK in place). ─────────
ALTER TABLE integraciones_canal DROP CONSTRAINT IF EXISTS integraciones_canal_estado_check;
ALTER TABLE integraciones_canal ADD CONSTRAINT integraciones_canal_estado_check
  CHECK (estado IN ('no_configurado','pendiente_configuracion','pendiente_activacion','activo','suspendido','error'));

-- ── Paso 3: almacenamiento cifrado del PIN de verificación en dos pasos
-- (mismo algoritmo/columnas que access_token_cifrado, ver
-- cifradoIntegraciones.js). Se genera una sola vez por integración y se
-- reutiliza en reintentos -- Meta exige el MISMO pin en llamadas
-- subsecuentes a /register una vez que el número ya tiene 2FA activado. ──
ALTER TABLE integraciones_canal_credenciales ADD COLUMN IF NOT EXISTS pin_verificacion_cifrado TEXT;
ALTER TABLE integraciones_canal_credenciales ADD COLUMN IF NOT EXISTS pin_iv TEXT;
ALTER TABLE integraciones_canal_credenciales ADD COLUMN IF NOT EXISTS pin_auth_tag TEXT;
ALTER TABLE integraciones_canal_credenciales ADD COLUMN IF NOT EXISTS pin_formato_version SMALLINT NOT NULL DEFAULT 1;

COMMIT;
