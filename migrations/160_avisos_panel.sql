-- 160 · Avisos del panel (la campanita).
--
-- Pedido de Mario del 24-nov-2026: los avisos al dueño (el bot falló, una
-- conversación pasó a una persona, un cliente lleva rato esperando...) ya no
-- van por WhatsApp. Se quedan DENTRO del panel, en una lista que el
-- administrador ve al entrar y que se actualiza en vivo si el panel está
-- abierto.
--
-- Una fila por aviso, siempre de UN negocio. `datos` lleva solo lo que el
-- panel necesita para armar el texto (minutos, motivo, producto); nunca el
-- texto de los mensajes del cliente. `visto_en` lo pone el administrador con
-- «Visto» o «Ir al chat».
--
-- Aditiva: una tabla nueva y vacía. El código anterior no la lee, y el nuevo
-- solo la usa en el negocio que tenga encendida la bandera avisos_panel_v1
-- (tabla configuracion). La reversa es 160_avisos_panel_down.sql.

CREATE TABLE IF NOT EXISTS avisos_panel (
  id          bigserial PRIMARY KEY,
  -- Los avisos son del negocio: si el negocio se borra, se van con él.
  negocio_id  uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  tipo        text NOT NULL,
  -- El cliente de la conversación, cuando el aviso es de una ("Ir al chat").
  telefono    text,
  datos       jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  visto_en    timestamptz,
  visto_por   uuid REFERENCES usuarios(id) ON DELETE SET NULL
);

-- La lista es CERRADA: un tipo nuevo pide su propia migración (y su texto en
-- panel/avisos-panel.js).
DO $$ BEGIN
  ALTER TABLE avisos_panel ADD CONSTRAINT avisos_panel_tipo
    CHECK (tipo IN ('cliente_esperando', 'revision_humana', 'bot_retomo',
                    'fallas_bot', 'negativa_falsa', 'pago_sin_proveedor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Quién lo vio, solo si se vio.
DO $$ BEGIN
  ALTER TABLE avisos_panel ADD CONSTRAINT avisos_panel_visto
    CHECK (visto_por IS NULL OR visto_en IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE avisos_panel ADD CONSTRAINT avisos_panel_datos_objeto
    CHECK (jsonb_typeof(datos) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La lista del panel: los últimos días de UN negocio, lo más nuevo primero.
CREATE INDEX IF NOT EXISTS avisos_panel_negocio
  ON avisos_panel (negocio_id, creado_en DESC, id DESC);

-- Los que faltan por ver (el número rojo) y el "no repetir el mismo aviso del
-- mismo cliente mientras siga sin verse".
CREATE INDEX IF NOT EXISTS avisos_panel_sin_ver
  ON avisos_panel (negocio_id, tipo, telefono) WHERE visto_en IS NULL;
