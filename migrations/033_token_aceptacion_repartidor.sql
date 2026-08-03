-- ============================================================
-- XABOR Multiempresa — Migración 033
-- Enlace de aceptación de un solo uso para la plantilla
-- xabor_nuevo_servicio_reparto (ver docs/piloto-notificaciones-repartidor.md).
--
-- Requisito explícito del usuario: el mensaje inicial de oferta NUNCA debe
-- llevar datos sensibles del cliente (nombre, teléfono, dirección) -- solo
-- el nombre del negocio y el pago estimado. Los datos completos se envían
-- en un SEGUNDO mensaje (plantilla xabor_detalle_servicio_reparto), y solo
-- después de que el token de aceptación se consume con éxito.
--
-- El token debe: identificar el pedido y al repartidor destinatario,
-- expirar automáticamente, y no poder reutilizarse (ni por el mismo
-- repartidor dos veces ni por quien reciba el mensaje reenviado). Se
-- agrega directamente a notificaciones_repartidor (relación 1:1 con el
-- intento de envío de la plantilla 1) en vez de una tabla nueva, porque
-- cada token nace exactamente de un intento de notificación y nunca
-- existe uno sin el otro.
--
-- Reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

ALTER TABLE notificaciones_repartidor
  ADD COLUMN IF NOT EXISTS token_aceptacion TEXT,
  ADD COLUMN IF NOT EXISTS token_expira_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_usado_at TIMESTAMPTZ;

-- Único parcial: solo las filas que sí generaron un token (la plantilla de
-- detalle, si se llegara a registrar aparte, no lo tiene).
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_repartidor_token_aceptacion
  ON notificaciones_repartidor (token_aceptacion)
  WHERE token_aceptacion IS NOT NULL;

COMMIT;
