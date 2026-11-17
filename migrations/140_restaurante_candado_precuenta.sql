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
--   · restaurante_autorizaciones_remotas: la clave de supervisor dada a
--     distancia, desde el celular de un administrador (al final del archivo).
--
-- Las reglas (candado y cobro identificado) viven en
-- src/services/candadoPrecuenta.js y se encienden por negocio en
-- `configuracion` ('restaurante_candado_precuenta',
-- 'restaurante_cobro_identificado'); esta migración no enciende nada.
--
-- Aditiva e idempotente: tres tablas nuevas y vacías. No toca ninguna cuenta,
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

-- Autorización a distancia: cuando hace falta la clave de un supervisor y no
-- hay ninguno en la sucursal, la caja pide la autorización y un administrador
-- la da desde su celular, con su sesión Y su clave. La solicitud queda ligada
-- a la acción EXACTA (`huella`: acción, cuenta y lo que el servidor calculó
-- que se iba a cambiar), vence sola y se usa una sola vez, por la misma sesión
-- que la pidió. Lo que el supervisor vio (`detalle`) es lo que se aplica; si
-- la cuenta cambió entre medias, la huella ya no coincide y no sirve.
CREATE TABLE IF NOT EXISTS restaurante_autorizaciones_remotas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  cuenta_id      UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  accion         TEXT NOT NULL CHECK (accion IN ('quitar_platillo', 'reducir_cantidad', 'cancelar_platillo', 'descuento', 'cerrar_vencida')),
  detalle        JSONB NOT NULL DEFAULT '{}'::jsonb
                 CHECK (jsonb_typeof(detalle) = 'object' AND octet_length(detalle::text) <= 4096),
  huella         TEXT NOT NULL CHECK (char_length(huella) BETWEEN 16 AND 128),
  estado         TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'autorizada', 'rechazada', 'usada')),
  solicitada_por UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Quien autorizó o rechazó (NULL mientras está pendiente).
  resuelta_por   UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  resuelta_at    TIMESTAMPTZ NULL,
  usada_at       TIMESTAMPTZ NULL,
  -- Pendiente: hasta cuándo se puede contestar. Autorizada: hasta cuándo se
  -- puede usar. Lo vencido no se borra: deja de servir.
  expira_at      TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT restaurante_autorizaciones_remotas_resuelta_check
    CHECK (estado = 'pendiente' OR resuelta_at IS NOT NULL),
  CONSTRAINT restaurante_autorizaciones_remotas_usada_check
    CHECK ((estado = 'usada') = (usada_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_restaurante_autorizaciones_remotas_pendientes
  ON restaurante_autorizaciones_remotas (negocio_id, estado, expira_at);
CREATE INDEX IF NOT EXISTS idx_restaurante_autorizaciones_remotas_cuenta
  ON restaurante_autorizaciones_remotas (cuenta_id, created_at);
COMMENT ON TABLE restaurante_autorizaciones_remotas IS
  'Autorizaciones de supervisor pedidas desde la caja y dadas a distancia: ligadas a una acción, de un solo uso y con vencimiento (migración 140).';
