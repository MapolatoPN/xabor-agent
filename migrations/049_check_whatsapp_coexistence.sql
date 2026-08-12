-- Verificación de solo lectura de la 049: existencia y tipos correctos.
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_name = 'integraciones_canal' AND column_name = 'connection_mode') AS tiene_connection_mode,
  (SELECT column_default FROM information_schema.columns
    WHERE table_name = 'integraciones_canal' AND column_name = 'connection_mode') AS default_connection_mode,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_name = 'clientes' AND column_name IN ('human_takeover_until', 'last_business_app_message_at')) AS columnas_takeover,
  (SELECT pg_get_constraintdef(oid) LIKE '%texto_historico%' FROM pg_constraint
    WHERE conname = 'mensajes_tipo_check') AS check_admite_historico,
  (SELECT pg_get_constraintdef(oid) LIKE '%desconectado%' FROM pg_constraint
    WHERE conname = 'integraciones_canal_estado_check') AS check_admite_desconectado;
