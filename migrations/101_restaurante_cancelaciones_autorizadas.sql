-- ============================================================
-- XABOR — Migración 101: quitar o cambiar platillos con autorización.
--
-- Auditoría del 28-sep-2026 (Mapolato Obispado): las 55 cancelaciones de
-- platillos las hizo la misma sesión de administrador, con el motivo en
-- texto libre; en 27 el «motivo» era algo con forma de contraseña. Lo que
-- no había salido a cocina se borraba sin dejar rastro.
--
--   · usuarios.pin_autorizacion_hash: PIN personal (4-6 dígitos, scrypt) de
--     quien puede autorizar. Separado de pin_hash (entrada del mesero) y de
--     password_hash: autorizar no sirve para iniciar sesión.
--   · restaurante_cuenta_items: quién autorizó, el motivo por código y, en
--     un cambio, qué renglón reemplaza el nuevo.
--   · restaurante_item_eventos: bitácora de todo lo que se quita, incluido lo
--     que se borra antes de mandarse a cocina (esa fila ya no existe, por eso
--     el evento guarda su propia foto y no tiene FK al renglón).
--
-- Aditiva. Reejecutable. Sin backfill: lo cancelado antes queda como estaba
-- (sin autorizado_por ni código), y la bitácora arranca vacía.
-- ============================================================

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pin_autorizacion_hash TEXT NULL;

ALTER TABLE restaurante_cuenta_items ADD COLUMN IF NOT EXISTS autorizado_por UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE restaurante_cuenta_items ADD COLUMN IF NOT EXISTS motivo_codigo TEXT NULL;
ALTER TABLE restaurante_cuenta_items ADD COLUMN IF NOT EXISTS reemplaza_item_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuenta_items_motivo_codigo_check') THEN
    ALTER TABLE restaurante_cuenta_items ADD CONSTRAINT restaurante_cuenta_items_motivo_codigo_check
      CHECK (motivo_codigo IS NULL OR motivo_codigo IN ('cambio','error_captura','ya_no_lo_quiso','duplicado','cortesia','otro'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS restaurante_item_eventos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  cuenta_id       UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  item_id         UUID NULL,
  tipo            TEXT NOT NULL,
  producto        TEXT NOT NULL,
  modificadores   JSONB NOT NULL DEFAULT '[]',
  cantidad        INT NOT NULL,
  precio_unitario NUMERIC(10,2) NOT NULL DEFAULT 0,
  comanda_num     INT NULL,
  motivo_codigo   TEXT NULL,
  motivo          TEXT NULL,
  solicitado_por  UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  autorizado_por  UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_item_eventos_tipo_check') THEN
    ALTER TABLE restaurante_item_eventos ADD CONSTRAINT restaurante_item_eventos_tipo_check
      CHECK (tipo IN ('quitado_antes_de_enviar','cantidad_reducida','cancelado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_item_eventos_cantidad_check') THEN
    ALTER TABLE restaurante_item_eventos ADD CONSTRAINT restaurante_item_eventos_cantidad_check
      CHECK (cantidad > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_restaurante_item_eventos_dia ON restaurante_item_eventos (negocio_id, created_at);
CREATE INDEX IF NOT EXISTS idx_restaurante_item_eventos_cuenta ON restaurante_item_eventos (cuenta_id);
