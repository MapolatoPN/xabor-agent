-- 146 · Saneamiento de Clientes, fase 2: consentimiento de promociones.
--
-- Pedido de Mario del 21-nov-2026 (prompt maestro, puntos 7 a 9):
--
--   · El estado de promociones tiene tres valores: aceptó, se dio de baja y
--     sin dato, con fecha y canal. Ya se guarda así en cliente_consentimientos
--     (080): la fila más reciente por cliente y canal es el estado, y si no
--     hay fila es «sin dato». Esta migración NO toca esas filas: las que hoy
--     dicen «aceptó» siguen diciéndolo.
--   · Un aviso por negocio en la tienda en línea: «Al pedir aceptas recibir
--     promociones de [negocio]; puedes darte de baja cuando quieras». El texto
--     lo edita el administrador y cada cambio es una versión nueva: nunca se
--     reescribe una anterior, así se sabe qué texto vio cada cliente.
--   · Al pedir, se guarda la aceptación: una fila en cliente_consentimientos
--     con la fuente 'tienda_pedido', el folio y la versión del aviso.
--
-- Aditiva: una tabla nueva y vacía; dos columnas NULL en
-- cliente_consentimientos (las filas existentes quedan en NULL) y un índice
-- único que solo abarca la fuente nueva, que hoy no tiene filas. El código
-- anterior no lee nada de esto.

-- ── Versiones del aviso ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aviso_promociones (
  id           bigserial PRIMARY KEY,
  negocio_id   uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  texto        text NOT NULL,
  -- Se muestra en la tienda en línea (y entonces al pedir se guarda la
  -- aceptación). Apagarlo es otra versión, con el mismo texto.
  en_tienda    boolean NOT NULL DEFAULT true,
  -- El mismo aviso en el formulario de pedido por WhatsApp. Sin uso hasta que
  -- Mario apruebe tocar ese flujo: nace apagado y nada lo lee todavía.
  en_whatsapp  boolean NOT NULL DEFAULT false,
  -- 'sistema' para el texto por omisión; si no, el usuario que lo guardó.
  creado_por   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aviso_promociones_texto CHECK (length(btrim(texto)) BETWEEN 1 AND 300)
);
-- La versión vigente es la más reciente; la de un pedido, la más reciente
-- anterior a él.
CREATE INDEX IF NOT EXISTS aviso_promociones_vigente
  ON aviso_promociones (negocio_id, created_at DESC, id DESC);

-- ── De dónde salió cada aceptación ────────────────────────────────────────
ALTER TABLE cliente_consentimientos
  -- El folio del pedido con el que aceptó (fuente 'tienda_pedido').
  ADD COLUMN IF NOT EXISTS referencia text,
  -- La versión del aviso que estaba a la vista al pedir.
  ADD COLUMN IF NOT EXISTS aviso_id bigint REFERENCES aviso_promociones(id) ON DELETE RESTRICT;

-- Una sola aceptación por pedido en la tienda por cliente y canal: dos
-- servidores reconciliando a la vez (durante un despliegue) no la duplican.
CREATE UNIQUE INDEX IF NOT EXISTS cliente_consentimientos_tienda_pedido_unica
  ON cliente_consentimientos (negocio_id, cliente_id, canal) WHERE fuente = 'tienda_pedido';
