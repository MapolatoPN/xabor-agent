-- 165 · Asistente del restaurante, Fase 3: la IA redacta y el resumen por WhatsApp.
--
-- Pedido del dueño del 26-nov-2026 (plan de la Fase 3 aprobado el 27-nov).
-- La IA solo elige y redacta lo que las reglas ya encontraron; Xabor revisa
-- cifras y lenguaje antes de guardar. El resumen diario y el semanal salen por
-- WhatsApp con una plantilla aprobada por Meta.
--
-- Aditiva:
--   · corridas.ia        — qué pasó con la IA en esa corrida (NULL = no se usó).
--   · resumenes          — cada resumen preparado, enviado o fallido. Un diario
--                          y un semanal por sucursal y día (índice único): un
--                          reinicio o dos procesos a la vez nunca mandan dos.
--   · gasto_ia           — cada llamada a la IA con lo que costó, para el tope
--                          mensual de cada sucursal.
--   · avisos_panel_tipo  — la lista cerrada de la campanita suma dos tipos:
--                          'asistente_resumen_fallo' y 'asistente_tope_ia'.
--
-- Nunca guardan teléfonos completos: del número que recibe el resumen solo
-- quedan los últimos 4 dígitos. El código anterior no lee nada de esto; el
-- nuevo solo lo usa en la sucursal que encienda «Redactar con IA» o el
-- resumen en su tarjeta. La reversa es 165_asistente_ia_resumen_down.sql.

ALTER TABLE asistente_restaurante_corridas ADD COLUMN IF NOT EXISTS ia text;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_corridas ADD CONSTRAINT asistente_restaurante_corridas_ia
    CHECK (ia IS NULL OR ia IN ('ok', 'parcial', 'invalida', 'error', 'tope', 'sin_clave', 'sin_avisos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS asistente_restaurante_resumenes (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- 'prueba' = el botón «Enviar prueba» de la tarjeta (sin cifras).
  tipo          text NOT NULL,
  -- El día local del resumen (el semanal: el lunes en que sale).
  fecha         date NOT NULL,
  estado        text NOT NULL DEFAULT 'preparando',
  con_ia        boolean NOT NULL DEFAULT false,
  -- Las variables de la plantilla, en orden ({{1}}, {{2}}, …).
  variables     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Solo los últimos 4 dígitos del número que lo recibió.
  destino       text,
  wamid         text,
  error_codigo  integer,
  error         text,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  enviado_en    timestamptz,
  UNIQUE (negocio_id, id)
);
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_resumenes ADD CONSTRAINT asistente_restaurante_resumenes_tipo
    CHECK (tipo IN ('diario', 'semanal', 'prueba'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_resumenes ADD CONSTRAINT asistente_restaurante_resumenes_estado
    CHECK (estado IN ('preparando', 'enviando', 'enviado', 'fallo', 'incierto', 'omitido'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_resumenes ADD CONSTRAINT asistente_restaurante_resumenes_variables
    CHECK (jsonb_typeof(variables) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_resumenes ADD CONSTRAINT asistente_restaurante_resumenes_destino
    CHECK (destino IS NULL OR destino ~ '^[0-9]{4}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Un diario y un semanal por sucursal y día (las pruebas no cuentan).
CREATE UNIQUE INDEX IF NOT EXISTS asistente_restaurante_resumenes_uno_al_dia
  ON asistente_restaurante_resumenes (negocio_id, tipo, fecha) WHERE tipo IN ('diario', 'semanal');
CREATE INDEX IF NOT EXISTS asistente_restaurante_resumenes_recientes
  ON asistente_restaurante_resumenes (negocio_id, creado_en DESC);

CREATE TABLE IF NOT EXISTS asistente_restaurante_gasto_ia (
  id              bigserial PRIMARY KEY,
  negocio_id      uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  proposito       text NOT NULL,
  modelo          text NOT NULL,
  tokens_entrada  integer NOT NULL DEFAULT 0,
  tokens_salida   integer NOT NULL DEFAULT 0,
  tokens_cache    integer NOT NULL DEFAULT 0,
  costo_usd       numeric(10, 5) NOT NULL DEFAULT 0,
  resultado       text NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_gasto_ia ADD CONSTRAINT asistente_restaurante_gasto_ia_proposito
    CHECK (proposito IN ('avisos', 'resumen_diario', 'resumen_semanal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_gasto_ia ADD CONSTRAINT asistente_restaurante_gasto_ia_resultado
    CHECK (resultado IN ('ok', 'invalida', 'error', 'rechazo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_gasto_ia ADD CONSTRAINT asistente_restaurante_gasto_ia_costo
    CHECK (costo_usd >= 0 AND tokens_entrada >= 0 AND tokens_salida >= 0 AND tokens_cache >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- «¿Cuánto lleva gastado esta sucursal este mes?»
CREATE INDEX IF NOT EXISTS asistente_restaurante_gasto_ia_mes
  ON asistente_restaurante_gasto_ia (negocio_id, creado_en);

-- La campanita (160): la lista sigue CERRADA; solo suma los dos tipos del
-- asistente. Los avisos guardados siguen valiendo (son de los 6 de siempre).
ALTER TABLE avisos_panel DROP CONSTRAINT IF EXISTS avisos_panel_tipo;
ALTER TABLE avisos_panel ADD CONSTRAINT avisos_panel_tipo
  CHECK (tipo IN ('cliente_esperando', 'revision_humana', 'bot_retomo',
                  'fallas_bot', 'negativa_falsa', 'pago_sin_proveedor',
                  'asistente_resumen_fallo', 'asistente_tope_ia'));
