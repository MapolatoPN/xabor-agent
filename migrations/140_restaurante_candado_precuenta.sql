-- 140 — Precuentas registradas y bitácora de la cuenta de mesa.
--
-- Pedido de Mario (17-nov-2026), para Obispado: la precuenta que se lleva a la
-- mesa tiene que poder ligarse con la cuenta que se cierra, y lo que se cambie
-- después de imprimirla tiene que quedar con nombre.
--
--   · restaurante_precuentas: una fila por precuenta impresa (completa o de
--     la cuenta dividida), con su número dentro de la cuenta, lo que decía
--     (subtotal, descuento, total, pagado) y la FIRMA del consumo en ese
--     momento. Si la firma de la cuenta cambia, esa precuenta ya no vale para
--     cerrar. Se registra SIEMPRE, salga por Edge o por el navegador.
--   · restaurante_cuenta_bitacora: lo que antes no dejaba rastro (mover de
--     mesa), lo que autoriza un supervisor con su clave y quién cobró cuando
--     el negocio pide identificarse al cobrar.
--
-- Las reglas (candado y cobro identificado) viven en
-- src/services/candadoPrecuenta.js y se encienden por negocio en
-- `configuracion` ('restaurante_candado_precuenta',
-- 'restaurante_cobro_identificado'); esta migración no enciende nada.
--
-- Aditiva e idempotente: dos tablas nuevas y vacías. No toca ninguna cuenta,
-- pago, platillo ni venta.
CREATE TABLE IF NOT EXISTS restaurante_precuentas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  cuenta_id      UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  numero         INT NOT NULL CHECK (numero BETWEEN 1 AND 10000),
  tipo           TEXT NOT NULL CHECK (tipo IN ('completa', 'division')),
  -- La identidad por intención que ya manda la pantalla: un reintento HTTP
  -- devuelve la MISMA precuenta en vez de registrar otra.
  solicitud_id   TEXT NOT NULL CHECK (char_length(solicitud_id) BETWEEN 8 AND 120),
  subtotal       NUMERIC(10,2) NOT NULL,
  descuento      NUMERIC(10,2) NOT NULL DEFAULT 0,
  total          NUMERIC(10,2) NOT NULL,
  pagado         NUMERIC(10,2) NOT NULL DEFAULT 0,
  firma          TEXT NOT NULL CHECK (char_length(firma) BETWEEN 16 AND 128),
  solicitada_por UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_restaurante_precuentas_numero UNIQUE (cuenta_id, numero),
  CONSTRAINT uq_restaurante_precuentas_solicitud UNIQUE (cuenta_id, solicitud_id)
);
CREATE INDEX IF NOT EXISTS idx_restaurante_precuentas_dia
  ON restaurante_precuentas (negocio_id, created_at);
COMMENT ON TABLE restaurante_precuentas IS
  'Precuentas impresas de las cuentas de mesa: número, importes y firma del consumo al imprimir (migración 140).';

CREATE TABLE IF NOT EXISTS restaurante_cuenta_bitacora (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  cuenta_id         UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  tipo              TEXT NOT NULL CHECK (tipo IN ('mesa_movida', 'autorizacion_supervisor', 'cobro_identificado')),
  detalle           JSONB NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(detalle) = 'object' AND octet_length(detalle::text) <= 4096),
  -- Quién lo hizo (la persona que se identificó, o la sesión si no hizo falta).
  solicitado_por    UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Quién lo autorizó con su clave de supervisor (NULL si no hizo falta).
  autorizado_por    UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  -- La sesión abierta en el dispositivo (la caja), aunque cobre otra persona.
  sesion_usuario_id UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_cuenta_bitacora_cuenta
  ON restaurante_cuenta_bitacora (cuenta_id, created_at);
CREATE INDEX IF NOT EXISTS idx_restaurante_cuenta_bitacora_dia
  ON restaurante_cuenta_bitacora (negocio_id, created_at);
COMMENT ON TABLE restaurante_cuenta_bitacora IS
  'Bitácora de la cuenta de mesa: mesa movida, autorizaciones de supervisor y quién cobró (migración 140).';
