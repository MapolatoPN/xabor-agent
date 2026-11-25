-- Mesas incluidas en Básico150; solo altas públicas verificadas.
BEGIN;
INSERT INTO negocio_modulos(negocio_id,modulo,estado)
SELECT DISTINCT s.negocio_id,'restaurante','activo'
FROM solicitudes_registro_basico s
JOIN negocio_plan_comercial pc ON pc.negocio_id=s.negocio_id
WHERE s.used_at IS NOT NULL AND pc.plan='basico' AND pc.mensualidad=150
ON CONFLICT(negocio_id,modulo) DO UPDATE SET estado='activo'
WHERE negocio_modulos.estado IN ('no_configurado','no_contratado');
COMMIT;
