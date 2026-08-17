-- ─── 056: deadline interno de Xabor, separado de la expiración del proveedor ─
-- Idempotente y re-ejecutable.
--
-- POR QUÉ DOS CAMPOS Y NO UNO
--
-- `expires_at` ya existía y la reconciliación lo usa para dejar de consultar un
-- checkout: `expires_at IS NULL OR expires_at > NOW()`. Ese significado solo es
-- legítimo si el PROVEEDOR garantiza que ese checkout ya no puede recibir
-- dinero. Es información suya, no nuestra.
--
-- El deadline de Xabor es otra cosa completamente distinta: "dejamos de esperar
-- este pago". Es una decisión de producto, no un hecho del proveedor. Si se
-- guardara en `expires_at`, vencer un pedido lo sacaría de la reconciliación
-- -- y ahí es exactamente donde más falta hace, porque el enlace del proveedor
-- puede seguir cobrando. Perderíamos dinero real por una decisión interna.
--
-- Por eso:
--
--   xabor_espera_hasta : hasta cuándo Xabor espera el pago. NUNCA excluye de
--                        la reconciliación.
--   expires_at         : expiración declarada por el proveedor, cuando la
--                        conocemos y es confiable. Esa sí puede excluir.
--
-- Estado de los proveedores hoy (verificado en documentación oficial):
--   · Clip: la consulta de un checkout devuelve `expired_at` y el estado
--     CHECKOUT_EXPIRED. La API pública NO ofrece cancelación, así que vencer en
--     Xabor jamás significa "cancelado en Clip".
--   · Mercado Pago: Create Preference lista `expires`, `expiration_date_from` y
--     `expiration_date_to`, pero la referencia no documenta su semántica ni
--     afirma que una preferencia expirada deje de poder pagarse. Xabor no las
--     envía y no atribuye esa garantía: en dinero, lo no documentado no se
--     supone.

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS xabor_espera_hasta timestamptz;

-- Índice parcial para el job de expiración: solo mira intentos vivos con
-- deadline puesto, que es un conjunto pequeño.
CREATE INDEX IF NOT EXISTS idx_pagos_espera_vencida
  ON pagos (xabor_espera_hasta)
  WHERE xabor_espera_hasta IS NOT NULL
    AND estado IN ('creando','pendiente','requiere_revision');
