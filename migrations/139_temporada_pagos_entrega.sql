-- 139 · Pedidos de temporada: pagos, entrega, captura en el panel y bitácora.
--
-- Pedido de Mario del 17-nov-2026: seis mejoras a /temporada, una por una.
-- Esta migración deja lista la base de las seis de una vez, para no desplegar
-- una migración por mejora durante la semana del evento:
--
--   · pagos: anticipo por campaña (ninguno, porcentaje o monto fijo), precio
--     congelado en cada pedido y una tabla de MOVIMIENTOS de pago (monto,
--     método, quién y cuándo). El estado de pago no se guarda: sale de los
--     movimientos (sin pago / anticipo / pagado). Un pago mal capturado se
--     ANULA con motivo, nunca se borra;
--   · entrega: agendado → en preparación → listo → entregado (o recogido);
--   · captura y edición en el panel: de dónde vino el pedido, quién lo creó,
--     cuándo cambió por última vez y una bitácora de solo inserción;
--   · los textos de WhatsApp de confirmación y recordatorio, por campaña;
--   · el motivo de una cancelación.
--
-- Aditiva. De las filas que ya existen solo cambia el precio congelado: cada
-- pedido toma el precio que hoy tiene su campaña, que es el que vio el
-- cliente. Los pedidos existentes quedan «Sin pago» (no tienen movimientos) y
-- «Agendado» (valor por omisión). El código anterior sigue funcionando con
-- esta base: no lee las columnas nuevas y sus INSERT toman los valores por
-- omisión (un precio congelado NULL se lee como el de la campaña).
--
-- Es la 139: la 134 la tiene apartada feat/xecador-cara y la 137
-- feat/numero-por-sucursal; la 135, la 136 y la 138 ya están en producción.

-- ── Campañas: anticipo y mensajes ─────────────────────────────────────────
ALTER TABLE temporada_campanas
  ADD COLUMN IF NOT EXISTS anticipo_tipo        text          NOT NULL DEFAULT 'ninguno',
  ADD COLUMN IF NOT EXISTS anticipo_valor       numeric(10,2) NULL,
  -- NULL = el texto por omisión de Xabor.
  ADD COLUMN IF NOT EXISTS mensaje_confirmacion text          NULL,
  ADD COLUMN IF NOT EXISTS mensaje_recordatorio text          NULL;

ALTER TABLE temporada_campanas
  DROP CONSTRAINT IF EXISTS temporada_campanas_anticipo,
  -- Sin precio no hay total contra el cual pedir un anticipo.
  ADD CONSTRAINT temporada_campanas_anticipo CHECK (
    (anticipo_tipo = 'ninguno' AND anticipo_valor IS NULL)
    OR (anticipo_tipo = 'porcentaje' AND precio IS NOT NULL AND anticipo_valor > 0 AND anticipo_valor <= 100)
    OR (anticipo_tipo = 'monto' AND precio IS NOT NULL AND anticipo_valor > 0 AND anticipo_valor <= 1000000)),
  DROP CONSTRAINT IF EXISTS temporada_campanas_mensajes,
  ADD CONSTRAINT temporada_campanas_mensajes CHECK (
    (mensaje_confirmacion IS NULL OR char_length(mensaje_confirmacion) BETWEEN 1 AND 1500)
    AND (mensaje_recordatorio IS NULL OR char_length(mensaje_recordatorio) BETWEEN 1 AND 1500));

-- ── Pedidos: precio congelado, entrega, origen y cancelación ──────────────
ALTER TABLE temporada_pedidos
  -- Precio por platillo con el que se agendó. NULL = el de la campaña (la
  -- campaña no tenía precio, o el pedido entró con el código anterior).
  ADD COLUMN IF NOT EXISTS precio_unitario     numeric(10,2) NULL,
  ADD COLUMN IF NOT EXISTS estado_entrega      text          NOT NULL DEFAULT 'agendado',
  ADD COLUMN IF NOT EXISTS entrega_cambiada_en timestamptz   NULL,
  -- 'formulario' = la página pública; 'panel' = capturado en /temporada.
  ADD COLUMN IF NOT EXISTS origen              text          NOT NULL DEFAULT 'formulario',
  ADD COLUMN IF NOT EXISTS creado_por          uuid          NULL,
  ADD COLUMN IF NOT EXISTS actualizado_en      timestamptz   NULL,
  ADD COLUMN IF NOT EXISTS motivo_cancelacion  text          NULL;

ALTER TABLE temporada_pedidos
  DROP CONSTRAINT IF EXISTS temporada_pedidos_precio,
  ADD CONSTRAINT temporada_pedidos_precio CHECK (precio_unitario IS NULL OR precio_unitario >= 0),
  DROP CONSTRAINT IF EXISTS temporada_pedidos_entrega,
  ADD CONSTRAINT temporada_pedidos_entrega CHECK (estado_entrega IN ('agendado', 'en_preparacion', 'listo', 'entregado')),
  DROP CONSTRAINT IF EXISTS temporada_pedidos_origen,
  ADD CONSTRAINT temporada_pedidos_origen CHECK (origen IN ('formulario', 'panel')),
  DROP CONSTRAINT IF EXISTS temporada_pedidos_creado_por_fkey,
  ADD CONSTRAINT temporada_pedidos_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  -- Un pedido confirmado (también uno restaurado) no arrastra motivo de cancelación.
  DROP CONSTRAINT IF EXISTS temporada_pedidos_motivo,
  ADD CONSTRAINT temporada_pedidos_motivo CHECK (
    motivo_cancelacion IS NULL OR (estado = 'cancelado' AND char_length(btrim(motivo_cancelacion)) BETWEEN 1 AND 300));

UPDATE temporada_pedidos p
   SET precio_unitario = c.precio
  FROM temporada_campanas c
 WHERE c.id = p.campana_id AND p.precio_unitario IS NULL AND c.precio IS NOT NULL;

-- ── Movimientos de pago ───────────────────────────────────────────────────
-- Lo pagado de un pedido es la suma de sus movimientos no anulados. Anular no
-- borra: deja quién, cuándo y por qué.
CREATE TABLE IF NOT EXISTS temporada_pagos (
  id                bigint        GENERATED ALWAYS AS IDENTITY,
  pedido_id         bigint        NOT NULL,
  negocio_id        uuid          NOT NULL,
  monto             numeric(10,2) NOT NULL,
  metodo            text          NOT NULL,
  referencia        text          NULL,
  registrado_por    uuid          NOT NULL,
  registrado_en     timestamptz   NOT NULL DEFAULT now(),
  anulado_en        timestamptz   NULL,
  anulado_por       uuid          NULL,
  motivo_anulacion  text          NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'temporada_pagos_pkey') THEN
    ALTER TABLE temporada_pagos ADD CONSTRAINT temporada_pagos_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE temporada_pagos
  DROP CONSTRAINT IF EXISTS temporada_pagos_pedido_fkey,
  ADD CONSTRAINT temporada_pagos_pedido_fkey FOREIGN KEY (pedido_id) REFERENCES temporada_pedidos(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_pagos_negocio_fkey,
  ADD CONSTRAINT temporada_pagos_negocio_fkey FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_pagos_registrado_por_fkey,
  ADD CONSTRAINT temporada_pagos_registrado_por_fkey FOREIGN KEY (registrado_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_pagos_anulado_por_fkey,
  ADD CONSTRAINT temporada_pagos_anulado_por_fkey FOREIGN KEY (anulado_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_pagos_monto,
  ADD CONSTRAINT temporada_pagos_monto CHECK (monto > 0 AND monto <= 1000000),
  DROP CONSTRAINT IF EXISTS temporada_pagos_metodo,
  ADD CONSTRAINT temporada_pagos_metodo CHECK (metodo IN ('efectivo', 'transferencia', 'tarjeta')),
  DROP CONSTRAINT IF EXISTS temporada_pagos_referencia,
  ADD CONSTRAINT temporada_pagos_referencia CHECK (referencia IS NULL OR char_length(referencia) BETWEEN 1 AND 120),
  -- Anulado = las tres a la vez: cuándo, quién y por qué.
  DROP CONSTRAINT IF EXISTS temporada_pagos_anulacion,
  ADD CONSTRAINT temporada_pagos_anulacion CHECK (
    (anulado_en IS NULL AND anulado_por IS NULL AND motivo_anulacion IS NULL)
    OR (anulado_en IS NOT NULL AND anulado_por IS NOT NULL
        AND char_length(btrim(coalesce(motivo_anulacion, ''))) BETWEEN 1 AND 300));

CREATE INDEX IF NOT EXISTS temporada_pagos_pedido ON temporada_pagos (pedido_id);
CREATE INDEX IF NOT EXISTS temporada_pagos_negocio ON temporada_pagos (negocio_id);

-- Un movimiento no se borra ni cambia su monto, método o pedido: solo se
-- anula, una vez.
CREATE OR REPLACE FUNCTION temporada_pagos_solo_anular() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.anulado_en IS NULL AND NEW.anulado_en IS NOT NULL
     AND NEW.id = OLD.id AND NEW.pedido_id = OLD.pedido_id AND NEW.negocio_id = OLD.negocio_id
     AND NEW.monto = OLD.monto AND NEW.metodo = OLD.metodo
     AND NEW.referencia IS NOT DISTINCT FROM OLD.referencia
     AND NEW.registrado_por = OLD.registrado_por AND NEW.registrado_en = OLD.registrado_en THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'temporada_pagos: un pago no se borra ni se corrige; se anula con motivo y se registra otro (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS temporada_pagos_sin_cambios ON temporada_pagos;
CREATE TRIGGER temporada_pagos_sin_cambios
  BEFORE UPDATE OR DELETE ON temporada_pagos
  FOR EACH ROW EXECUTE FUNCTION temporada_pagos_solo_anular();
DROP TRIGGER IF EXISTS temporada_pagos_sin_truncate ON temporada_pagos;
CREATE TRIGGER temporada_pagos_sin_truncate
  BEFORE TRUNCATE ON temporada_pagos
  FOR EACH STATEMENT EXECUTE FUNCTION temporada_pagos_solo_anular();

-- ── Bitácora: quién hizo qué y cuándo ─────────────────────────────────────
-- Solo inserción. usuario_id NULL = la página pública (el cliente).
CREATE TABLE IF NOT EXISTS temporada_bitacora (
  id          bigint      GENERATED ALWAYS AS IDENTITY,
  negocio_id  uuid        NOT NULL,
  campana_id  bigint      NOT NULL,
  pedido_id   bigint      NULL,
  usuario_id  uuid        NULL,
  accion      text        NOT NULL,
  detalle     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  creado_en   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'temporada_bitacora_pkey') THEN
    ALTER TABLE temporada_bitacora ADD CONSTRAINT temporada_bitacora_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE temporada_bitacora
  DROP CONSTRAINT IF EXISTS temporada_bitacora_negocio_fkey,
  ADD CONSTRAINT temporada_bitacora_negocio_fkey FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_bitacora_campana_fkey,
  ADD CONSTRAINT temporada_bitacora_campana_fkey FOREIGN KEY (campana_id) REFERENCES temporada_campanas(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_bitacora_pedido_fkey,
  ADD CONSTRAINT temporada_bitacora_pedido_fkey FOREIGN KEY (pedido_id) REFERENCES temporada_pedidos(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_bitacora_usuario_fkey,
  ADD CONSTRAINT temporada_bitacora_usuario_fkey FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS temporada_bitacora_accion,
  ADD CONSTRAINT temporada_bitacora_accion CHECK (accion ~ '^[a-z_]{3,40}$'),
  DROP CONSTRAINT IF EXISTS temporada_bitacora_detalle,
  ADD CONSTRAINT temporada_bitacora_detalle CHECK (jsonb_typeof(detalle) = 'object' AND pg_column_size(detalle) <= 8192);

CREATE INDEX IF NOT EXISTS temporada_bitacora_pedido ON temporada_bitacora (pedido_id, creado_en);
CREATE INDEX IF NOT EXISTS temporada_bitacora_campana ON temporada_bitacora (campana_id, creado_en);

CREATE OR REPLACE FUNCTION temporada_bitacora_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'temporada_bitacora es de solo inserción (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS temporada_bitacora_sin_cambios ON temporada_bitacora;
CREATE TRIGGER temporada_bitacora_sin_cambios
  BEFORE UPDATE OR DELETE ON temporada_bitacora
  FOR EACH ROW EXECUTE FUNCTION temporada_bitacora_inmutable();
DROP TRIGGER IF EXISTS temporada_bitacora_sin_truncate ON temporada_bitacora;
CREATE TRIGGER temporada_bitacora_sin_truncate
  BEFORE TRUNCATE ON temporada_bitacora
  FOR EACH STATEMENT EXECUTE FUNCTION temporada_bitacora_inmutable();
