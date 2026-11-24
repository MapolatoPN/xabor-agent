-- 149 · Saneamiento de Clientes, fase 3: Rewards solo para inscritos.
--
-- Pedido de Mario del 21-nov-2026 (prompt maestro, puntos 10 a 17) y sus
-- respuestas del 23-nov:
--
--   · Solo acumula un cliente INSCRITO e identificado. Comprar ya no inscribe:
--     la inscripción es un acto explícito, con nombre y teléfono, en caja, en
--     «Mi cuenta» de la tienda o por la liga que manda WhatsApp. Aquí se
--     guarda cuándo, por dónde y quién la hizo.
--   · Las cuentas que ya existen nacieron al comprar (inscripción automática)
--     y quedan como «sin inscribir»: conservan su saldo intacto mientras Mario
--     decide qué hacer con ellas. Esta migración NO las toca: las columnas
--     nuevas valen NULL para todas.
--   · Vencimiento de puntos por meses sin compra, apagado de entrada
--     (rewards_config.vigencia_dias sigue en NULL). `vigencia_desde` es el día
--     en que se encendió: el plazo nunca cuenta desde antes, para que
--     encenderlo no venza a todos de golpe.
--   · Una bitácora de los ajustes de saneamiento (inscripciones, anulación del
--     registro genérico del mostrador, normalización y fusión de teléfonos),
--     con el antes y el después para poder revertir.
--
-- Aditiva: tres columnas NULL en rewards_accounts, una en rewards_config y una
-- tabla nueva y vacía. El código anterior no lee nada de esto.

-- ── Inscripción explícita ─────────────────────────────────────────────────
ALTER TABLE rewards_accounts
  ADD COLUMN IF NOT EXISTS inscrito_at timestamptz,
  -- 'caja' (alta en el punto de venta), 'tienda' (Mi cuenta), 'whatsapp'
  -- (la liga del bot lleva a Mi cuenta: queda como 'tienda'; se reserva por
  -- si un día se inscribe en la conversación) y 'admin' (scripts y pruebas).
  ADD COLUMN IF NOT EXISTS inscripcion_origen text,
  ADD COLUMN IF NOT EXISTS inscrito_por text;

DO $$ BEGIN
  ALTER TABLE rewards_accounts ADD CONSTRAINT rewards_accounts_inscripcion_origen
    CHECK (inscripcion_origen IS NULL OR inscripcion_origen IN ('caja', 'tienda', 'whatsapp', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Inscrita = tiene fecha Y origen; ninguna de las dos sola.
DO $$ BEGIN
  ALTER TABLE rewards_accounts ADD CONSTRAINT rewards_accounts_inscripcion_completa
    CHECK ((inscrito_at IS NULL) = (inscripcion_origen IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Vencimiento ───────────────────────────────────────────────────────────
ALTER TABLE rewards_config
  ADD COLUMN IF NOT EXISTS vigencia_desde timestamptz;

-- ── Bitácora de saneamiento ───────────────────────────────────────────────
-- Sin llave foránea a rewards_accounts a propósito: la bitácora sobrevive a
-- la cuenta (y no le impide a nadie borrar un cliente de prueba).
CREATE TABLE IF NOT EXISTS rewards_bitacora (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  account_id    integer,
  accion        text NOT NULL,
  -- Los cambios de una misma corrida de script comparten lote: así se
  -- revierten juntos.
  lote          uuid,
  antes         jsonb,
  despues       jsonb,
  motivo        text,
  usuario       text,
  revertido_at  timestamptz,
  revertido_por text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rewards_bitacora_accion
    CHECK (accion IN ('inscripcion', 'anulacion', 'normalizacion', 'fusion'))
);
CREATE INDEX IF NOT EXISTS rewards_bitacora_tenant ON rewards_bitacora (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rewards_bitacora_lote ON rewards_bitacora (lote) WHERE lote IS NOT NULL;
