-- 125 · Cobro en dólares en el mostrador (Fase 1, aprobada por Mario el 2-nov-2026).
--
-- Una tabla que es a la vez la configuración y su bitácora: cada vez que el
-- administrador enciende o apaga los dólares, o cambia el tipo de cambio, se
-- agrega un renglón. Lo vigente es el último renglón del negocio; nunca se
-- edita ni se borra uno viejo.
--
--   activo        si el negocio acepta dólares en el mostrador desde ese
--                 momento. Sin renglones, el negocio NO acepta dólares.
--   tipo_cambio   pesos por dólar que el negocio da (1 USD = $tipo_cambio).
--                 La regla fina (de $10 a $30, dos decimales) vive en
--                 src/services/dolares.js; aquí solo el tope duro.
--
-- Cada cobro guarda en el pedido el tipo de cambio con el que se cobró
-- (datos.pago_dolares), así que cambiarlo después no mueve lo ya vendido. La
-- bitácora sirve para saber cuál estaba vigente a cierta hora (✏️ Pago) y
-- quién lo cambió.
--
-- Además se reserva la clave 'dolares' en formas_cobro (097): dólares es una
-- forma FIJA (convierte, da cambio en pesos y se arquea aparte) y ninguna
-- forma configurable puede llamarse igual.
--
-- Aditiva: una tabla nueva, vacía, y un CHECK más estricto sobre una lista
-- que hoy no tiene esa clave. No toca ni un pedido ni un corte.

CREATE TABLE IF NOT EXISTS dolares_tipo_cambio (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  activo        boolean NOT NULL,
  tipo_cambio   numeric(6,2) NULL CONSTRAINT dolares_tipo_cambio_valor_check
                  CHECK (tipo_cambio IS NULL OR (tipo_cambio > 0 AND tipo_cambio < 1000)),
  usuario_id    uuid NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dolares_activo_con_tipo_cambio CHECK (NOT activo OR tipo_cambio IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dolares_tipo_cambio_negocio
  ON dolares_tipo_cambio (negocio_id, created_at DESC, id DESC);

COMMENT ON TABLE dolares_tipo_cambio IS 'Configuración de dólares del mostrador por negocio, renglón por cambio: el último es el vigente.';

ALTER TABLE formas_cobro
  DROP CONSTRAINT IF EXISTS formas_cobro_clave_check,
  ADD CONSTRAINT formas_cobro_clave_check CHECK (
    clave ~ '^[a-z0-9_]{2,40}$'
    AND position('efectivo' IN clave) = 0
    AND clave NOT IN ('mixto', 'terminal', 'tarjeta', 'enlace_pago', 'por_cobrar', 'pendiente', 'sin_pago', 'dolares'));
