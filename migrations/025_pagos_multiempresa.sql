-- ============================================================
-- XABOR Multiempresa — Migración 025
-- Arquitectura de pagos multiempresa: múltiples proveedores por negocio
-- (uno principal), métodos de pago configurables por negocio, y una
-- tabla real de pagos/enlaces (hoy el estado vivía solo como JSONB
-- suelto en pedidos_activos.datos: forma_pago/clip_link_id/pago_confirmado,
-- sin idempotencia ni historial).
--
-- Reutiliza integraciones_canal/integraciones_canal_credenciales
-- (canal='pagos') ya introducidas por el Incidente P0 -- esta migración
-- solo AMPLIA esa tabla (principal, ambiente, capacidades, estado
-- 'eliminado'), nunca la reemplaza. Ninguna fila existente (Clip de
-- Nonna Maye o de cualquier otro negocio ya migrado) se toca de valor,
-- solo se les asigna un default seguro para las columnas nuevas.
--
-- Reejecutable (IF NOT EXISTS / DROP+ADD CONSTRAINT con guarda).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 025_pagos_multiempresa.sql
-- ============================================================

BEGIN;

-- ── Paso 1: columnas nuevas en integraciones_canal ────────────────────────
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS principal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS ambiente TEXT NOT NULL DEFAULT 'sandbox'
  CHECK (ambiente IN ('sandbox','produccion'));
-- Capacidades/último resultado de prueba -- metadatos NO sensibles
-- (nunca credenciales), reutiliza el patrón ya establecido de
-- `configuracion` JSONB en esta misma tabla (migración 008).
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS ultima_prueba_at TIMESTAMPTZ;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS ultima_prueba_ok BOOLEAN;

-- 'eliminado': estado terminal explícito (soft-delete) -- distinto de
-- 'suspendido' (reversible por el propio superadmin) y de 'error'
-- (técnico). Se preserva la fila por auditoría en vez de un DELETE físico,
-- mismo criterio que el resto del esquema multiempresa (ON DELETE RESTRICT).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integraciones_canal_estado_check') THEN
    ALTER TABLE integraciones_canal DROP CONSTRAINT integraciones_canal_estado_check;
  END IF;
  ALTER TABLE integraciones_canal ADD CONSTRAINT integraciones_canal_estado_check
    CHECK (estado IN ('no_configurado','pendiente_configuracion','pendiente_activacion','activo','suspendido','error','eliminado'));
END $$;

-- Un solo proveedor "principal" por negocio+canal -- así el enlace
-- automático nunca es ambiguo entre dos proveedores activos a la vez.
-- Índice parcial (solo cuando principal=TRUE): permitir varias filas con
-- principal=FALSE (secundarios/suspendidos) sin restricción.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integraciones_canal_principal_unico
  ON integraciones_canal (negocio_id, canal)
  WHERE principal = TRUE;

-- ── Paso 2: métodos de pago por negocio ───────────────────────────────────
CREATE TABLE IF NOT EXISTS metodos_pago (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id               UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  tipo                     TEXT NOT NULL CHECK (tipo IN ('efectivo','terminal','enlace_pago','transferencia','pago_en_sucursal','otro_autorizado')),
  habilitado               BOOLEAN NOT NULL DEFAULT FALSE,
  -- Solo relevante para enlace_pago -- qué integración de integraciones_canal
  -- (canal='pagos') respalda este método. NULL para efectivo/terminal/etc.
  integracion_id           UUID NULL REFERENCES integraciones_canal(id) ON DELETE SET NULL,
  -- Instrucciones NO secretas -- para transferencia: {titular, banco,
  -- cuenta_visible, clabe, referencia_requerida}; para otros tipos, texto
  -- libre visible al cliente/operador. JSONB para no forzar esquema fijo
  -- entre tipos tan distintos.
  instrucciones            JSONB NOT NULL DEFAULT '{}',
  orden                    INTEGER NOT NULL DEFAULT 0,
  disponible_para_bot      BOOLEAN NOT NULL DEFAULT TRUE,
  disponible_para_operador BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (negocio_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_metodos_pago_negocio ON metodos_pago (negocio_id);

DROP TRIGGER IF EXISTS set_updated_at ON metodos_pago;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON metodos_pago
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Paso 2b: backfill de metodos_pago para TODO negocio existente ─────────
-- Sin este backfill, un negocio existente seguiría dependiendo de la
-- lista libre reglas_atencion.pago_aceptado (editable sin ninguna
-- validación técnica) hasta que alguien migrara manualmente -- exactamente
-- la causa del incidente #8 (Alora ofrecía "enlace de pago" sin proveedor
-- configurado). efectivo/terminal se habilitan para todos (ya funcionan
-- hoy sin ningún proveedor); enlace_pago SOLO se habilita (y se marca
-- principal) para negocios que YA tengan una integración Clip real y
-- activa -- Alora, sin Clip, queda con enlace_pago deshabilitado desde
-- el momento en que esta migración corre, sin ningún paso manual extra.
INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden)
SELECT n.id, 'efectivo', TRUE, 0 FROM negocios n
ON CONFLICT (negocio_id, tipo) DO NOTHING;

INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden)
SELECT n.id, 'terminal', TRUE, 1 FROM negocios n
ON CONFLICT (negocio_id, tipo) DO NOTHING;

INSERT INTO metodos_pago (negocio_id, tipo, habilitado, integracion_id, orden)
SELECT n.id, 'enlace_pago', TRUE, ic.id, 2
FROM negocios n
JOIN integraciones_canal ic ON ic.negocio_id = n.id AND ic.canal = 'pagos' AND ic.proveedor = 'clip' AND ic.estado = 'activo'
ON CONFLICT (negocio_id, tipo) DO NOTHING;

INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden)
SELECT n.id, 'enlace_pago', FALSE, 2 FROM negocios n
WHERE NOT EXISTS (SELECT 1 FROM metodos_pago mp WHERE mp.negocio_id = n.id AND mp.tipo = 'enlace_pago')
ON CONFLICT (negocio_id, tipo) DO NOTHING;

INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden)
SELECT n.id, 'transferencia', FALSE, 3 FROM negocios n
ON CONFLICT (negocio_id, tipo) DO NOTHING;

-- Marcar como principal cualquier Clip ya activo que quedó vinculado
-- arriba, para que enlace_pago se resuelva de inmediato como disponible
-- (obtenerMetodosPagoDisponibles exige ic.principal = TRUE).
UPDATE integraciones_canal ic SET principal = TRUE
FROM metodos_pago mp
WHERE mp.integracion_id = ic.id AND mp.tipo = 'enlace_pago' AND mp.habilitado = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM integraciones_canal ic2 WHERE ic2.negocio_id = ic.negocio_id AND ic2.canal = 'pagos' AND ic2.principal = TRUE
  );

-- ── Paso 3: pagos/enlaces (fuente de verdad real, reemplaza el JSONB
--    suelto en pedidos_activos.datos para todo pago NUEVO -- los campos
--    legacy forma_pago/clip_link_id/pago_confirmado en pedidos_activos
--    NO se tocan ni se migran retroactivamente, siguen funcionando para
--    pedidos ya en curso) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id         UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  pedido_folio       VARCHAR(20) NULL,
  cliente_telefono   VARCHAR(20) NULL,
  proveedor          TEXT NOT NULL,
  integracion_id     UUID NULL REFERENCES integraciones_canal(id) ON DELETE SET NULL,
  -- Clave de correlación interna -- lo que Xabor manda al proveedor como
  -- referencia (external_reference en Clip). Única por negocio: dos
  -- negocios pueden reusar el mismo folio de pedido sin colisionar aquí.
  referencia_interna TEXT NOT NULL,
  referencia_externa TEXT NULL,
  tipo               TEXT NOT NULL DEFAULT 'enlace_pago' CHECK (tipo IN ('enlace_pago','transferencia')),
  moneda             TEXT NOT NULL DEFAULT 'MXN' CHECK (moneda ~ '^[A-Z]{3}$'),
  monto              NUMERIC(10,2) NOT NULL CHECK (monto > 0),
  estado             TEXT NOT NULL DEFAULT 'creando' CHECK (estado IN (
                        'creando','pendiente','pagado','fallido','vencido','cancelado',
                        'invalidado','reembolsado','requiere_revision'
                      )),
  -- Snapshot del pedido en el momento de crear el pago -- clave de
  -- idempotencia/invalidación (Fase 10/11): si el pedido cambia de monto
  -- o modalidad, este hash ya no coincide y el pago pendiente se invalida
  -- en vez de reutilizarse. pedidos_activos no tiene una columna de
  -- versión real; se deriva un hash de (total, modalidad, costo_envio)
  -- en vez de agregar una columna nueva a esa tabla (protegida, ver
  -- CLAUDE.md) -- evita tocar el flujo crítico de pedidos para esto.
  version_pedido_hash TEXT NULL,
  idempotency_key    TEXT NULL,
  -- URL de checkout del proveedor (Clip, etc.) -- no es un secreto (es
  -- exactamente lo que se comparte con el cliente para que pague), así
  -- que se guarda en claro para poder reenviarla cuando el pago se
  -- reutiliza por idempotencia (Fase 10) sin tener que volver a llamar al
  -- proveedor. Nunca confundir con las credenciales de la integración
  -- (esas sí van cifradas en integraciones_canal_credenciales) -- esta
  -- columna nunca debe imprimirse junto con esas.
  url                TEXT NULL,
  created_by         UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NULL,
  paid_at            TIMESTAMPTZ NULL,
  cancelled_at       TIMESTAMPTZ NULL,
  invalidated_at     TIMESTAMPTZ NULL,
  motivo_invalidacion TEXT NULL,
  metadata_sanitizada JSONB NOT NULL DEFAULT '{}',
  UNIQUE (negocio_id, referencia_interna)
);
CREATE INDEX IF NOT EXISTS idx_pagos_negocio ON pagos (negocio_id);
CREATE INDEX IF NOT EXISTS idx_pagos_negocio_pedido ON pagos (negocio_id, pedido_folio);
-- Idempotency key única por negocio SOLO cuando está presente (no toda
-- llamada la usa) -- mismo patrón de índice único parcial ya usado en
-- esta base (wamid, message_id_externo).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_idempotency ON pagos (negocio_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Un solo pago "vigente" (creando/pendiente) por pedido+tipo -- refuerza
-- la idempotencia a nivel de constraint, no solo a nivel de lógica de
-- aplicación (defensa en profundidad ante una condición de carrera).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_vigente_unico
  ON pagos (negocio_id, pedido_folio, tipo)
  WHERE estado IN ('creando','pendiente','requiere_revision');

COMMIT;
