-- Reversa MANUAL de la 143 (nadie la corre en automático). Antes de correrla,
-- vuelve al binario anterior: el nuevo lee estas columnas y tablas.
--
-- Lo que se pierde: la lista de teléfonos del negocio, las marcas de interno,
-- la bitácora de esos cambios, el tope y la pausa de las campañas y el
-- cursor de bajas. Las bajas ya anotadas viven en cliente_consentimientos
-- (080) y NO se tocan.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 143_clientes_saneamiento_down.sql

BEGIN;
DROP TABLE IF EXISTS campanas_wa_cursor;
DROP INDEX IF EXISTS campana_envios_baja_pendiente;
ALTER TABLE campana_envios
  DROP COLUMN IF EXISTS baja_at,
  DROP COLUMN IF EXISTS cliente_id;
ALTER TABLE campanas
  DROP CONSTRAINT IF EXISTS campanas_umbral_rechazo_check,
  DROP CONSTRAINT IF EXISTS campanas_tope_24h_check,
  DROP COLUMN IF EXISTS reanudada_at,
  DROP COLUMN IF EXISTS pausada_motivo,
  DROP COLUMN IF EXISTS pausada_at,
  DROP COLUMN IF EXISTS umbral_rechazo_pct,
  DROP COLUMN IF EXISTS tope_24h;
DROP TABLE IF EXISTS clientes_bitacora;
ALTER TABLE clientes_negocio
  DROP COLUMN IF EXISTS interno_por,
  DROP COLUMN IF EXISTS interno_at,
  DROP COLUMN IF EXISTS interno_motivo,
  DROP COLUMN IF EXISTS es_interno;
DROP TABLE IF EXISTS negocio_telefonos_propios;
COMMIT;
