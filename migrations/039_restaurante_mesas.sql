-- ============================================================
-- XABOR Multiempresa — Migración 039 (LOCAL, no aplicada en producción)
-- Módulo de restaurante: mesas, meseros, comandas y pagos divididos.
-- Aditiva únicamente. Reejecutable. Sin backfill.
--
-- Decisión de arquitectura (C1): tablas NUEVAS relacionadas, NO extender
-- pedidos_activos. pedidos_activos es un almacén JSONB por folio pensado
-- para pedidos de una sola escritura + cambios de estado -- una cuenta de
-- mesa viva (items que entran en varias comandas, cancelaciones auditadas,
-- pagos parciales concurrentes desde varios dispositivos) necesita filas
-- relacionales con constraints reales. Nada del flujo de comandas actual
-- (pedidos, impresión, WhatsApp, Rappi) se toca.
-- ============================================================

CREATE TABLE IF NOT EXISTS restaurante_cuentas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  mesa_numero     INT NOT NULL CHECK (mesa_numero BETWEEN 1 AND 500),
  personas        INT NOT NULL DEFAULT 1 CHECK (personas BETWEEN 1 AND 100),
  mesero_usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  estado          TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada','cancelada')),
  abierta_por     UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  abierta_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cerrada_por     UUID NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  cerrada_at      TIMESTAMPTZ NULL,
  -- Contador de comandas emitidas de esta cuenta (1 = inicial, 2+ =
  -- adicionales). Se incrementa al ENVIAR comanda, no al agregar items.
  comandas_emitidas INT NOT NULL DEFAULT 0,
  notas           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APERTURA ATÓMICA (C3): una mesa de un negocio solo puede tener UNA cuenta
-- abierta a la vez. El índice único parcial convierte la carrera "dos
-- dispositivos abren Mesa 1 al mismo tiempo" en un conflicto de unicidad en
-- la base -- exactamente uno gana, el otro recibe error 23505 y el servicio
-- lo traduce a MESA_OCUPADA. Mismo patrón de verdad-en-DB que el fix de
-- asignación de repartidores (db3d105).
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurante_mesa_abierta
  ON restaurante_cuentas (negocio_id, mesa_numero) WHERE estado = 'abierta';
CREATE INDEX IF NOT EXISTS idx_restaurante_cuentas_negocio ON restaurante_cuentas (negocio_id, estado, abierta_at DESC);

CREATE TABLE IF NOT EXISTS restaurante_cuenta_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id       UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  producto        TEXT NOT NULL,
  cantidad        INT NOT NULL CHECK (cantidad BETWEEN 1 AND 200),
  precio_unitario NUMERIC(10,2) NOT NULL CHECK (precio_unitario >= 0),
  modificadores   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notas           TEXT NULL,
  estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','cancelado')),
  -- comanda_num: en qué comanda salió este item a cocina (NULL mientras
  -- está 'pendiente'). La reimpresión de comandas anteriores se evita
  -- imprimiendo SOLO items de la comanda recién emitida.
  comanda_num     INT NULL,
  agregado_por    UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  cancelado_por   UUID NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  motivo_cancelacion TEXT NULL,
  cancelado_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_items_cuenta ON restaurante_cuenta_items (cuenta_id, estado);

CREATE TABLE IF NOT EXISTS restaurante_cuenta_pagos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id       UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- Métodos alineados a metodos_pago (migración 025): el servicio valida
  -- contra los habilitados del negocio. Nunca se llama a un proveedor real
  -- desde aquí -- 'enlace_pago' registra el cobro por enlace ya realizado
  -- por el flujo de pagos existente, no genera cargos.
  metodo          TEXT NOT NULL CHECK (metodo IN ('efectivo','terminal','transferencia','enlace_pago')),
  monto           NUMERIC(10,2) NOT NULL CHECK (monto > 0),
  propina         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (propina >= 0),
  -- División: descripción libre de qué cubre este pago ("2 refrescos y la
  -- pasta", "mitad de la cuenta", "persona 3"). La división es para COBRAR:
  -- una sola cuenta con consumo total, pagos parciales y saldo -- nunca
  -- pedidos ni productos duplicados ni reimpresión de cocina.
  cubre           TEXT NULL,
  referencia      TEXT NULL,
  registrado_por  UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_pagos_cuenta ON restaurante_cuenta_pagos (cuenta_id);

-- Módulo 'restaurante' en el vocabulario de negocio_modulos -- mismo patrón
-- aditivo de las migraciones 015/026/028: se re-crea el CHECK con el valor
-- nuevo incluido, nunca se quita ninguno existente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check
    CHECK (modulo IN (
      'pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion','rewards',
      'chat_imagenes','chat_documentos_pdf','cotizaciones','generador_cotizaciones','pagos','repartidores',
      'asistente_comercial_cotizaciones','restaurante'
    ));
END $$;
