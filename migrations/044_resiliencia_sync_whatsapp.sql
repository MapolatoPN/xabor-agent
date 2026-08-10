-- 044 -- Cimientos de resiliencia: sincronizacion idempotente y WhatsApp durable.
--
-- Estrictamente ADITIVA. Crea tablas nuevas y no toca una sola fila de las
-- existentes: 0 UPDATE, 0 DELETE, 0 DROP, 0 backfill. Un negocio que hoy opera
-- sigue exactamente igual despues de aplicarla; nada la lee hasta que el
-- codigo nuevo se despliegue.
--
-- Resuelve tres agujeros concretos encontrados en la auditoria de SPOF:
--
--   1. La idempotencia del POS vive en un Map de proceso
--      (posEnvios.js `_idempotencia`). Con dos replicas, el mismo request
--      idempotente crea DOS pedidos. Aqui pasa a la base.
--
--   2. El webhook de WhatsApp responde 200 en su PRIMERA linea, antes de
--      persistir nada. Si el proceso muere despues, Meta ya recibio el ACK y
--      no reintenta: el mensaje se pierde en silencio. `whatsapp_inbox` es
--      donde se persiste ANTES de contestar.
--
--   3. No hay outbox: un mensaje saliente que muere entre la decision y la
--      llamada a Meta desaparece sin rastro.

BEGIN;

-- ─── 1. Bitacora de operaciones sincronizadas ───────────────────────────────
--
-- El Edge del restaurante opera sin nube y despues sincroniza. Cada operacion
-- local trae un operation_id generado en el dispositivo. Esta tabla es la que
-- convierte "el Edge reintento tres veces" en "una sola operacion logica".
--
-- La unicidad es (negocio_id, operation_id) y no operation_id a secas: un id
-- de otro tenant jamas debe poder colisionar ni consultar el resultado del
-- primero.
CREATE TABLE IF NOT EXISTS sync_operaciones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id    UUID REFERENCES sucursales(id) ON DELETE SET NULL,

  -- Identidad generada en el dispositivo, offline. NUNCA un folio: el folio
  -- es un contador global y dos dispositivos sin red lo repetirian.
  operation_id   TEXT NOT NULL,
  dispositivo_id TEXT NOT NULL,
  -- Secuencia local monotona POR DISPOSITIVO. Sirve para ordenar lo que un
  -- mismo dispositivo hizo, sin depender de su reloj.
  secuencia      BIGINT NOT NULL,

  tipo           TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Version del formato del payload: el journal local puede sobrevivir a una
  -- actualizacion de Xabor y hay que poder leer lo viejo.
  version        INTEGER NOT NULL DEFAULT 1,

  -- Reloj del dispositivo. Se guarda como dato, no como fuente de verdad de
  -- orden: dos tablets pueden estar desfasadas.
  creada_en_local TIMESTAMPTZ NOT NULL,
  recibida_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  resultado      TEXT NOT NULL DEFAULT 'aceptada'
                 CHECK (resultado IN ('aceptada', 'duplicada', 'conflicto', 'rechazada')),
  -- Que produjo la operacion del lado nube (folio asignado, id de cuenta...).
  -- Se devuelve tal cual cuando llega un duplicado, para que el reintento
  -- reciba la MISMA respuesta que el original.
  efecto         JSONB,
  motivo         TEXT,
  -- Un conflicto no se pisa en silencio: se marca y espera decision humana.
  revisado_en    TIMESTAMPTZ,
  revisado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- El corazon de la idempotencia. Sin este indice, dos entregas del mismo
-- lote crean dos operaciones.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_op_unica
  ON sync_operaciones (negocio_id, operation_id);

CREATE INDEX IF NOT EXISTS idx_sync_op_negocio    ON sync_operaciones (negocio_id, recibida_en DESC);
CREATE INDEX IF NOT EXISTS idx_sync_op_dispositivo ON sync_operaciones (negocio_id, dispositivo_id, secuencia);
-- Los conflictos pendientes de revision se consultan seguido y son pocos:
-- indice parcial.
CREATE INDEX IF NOT EXISTS idx_sync_op_conflictos
  ON sync_operaciones (negocio_id, recibida_en DESC)
  WHERE resultado = 'conflicto' AND revisado_en IS NULL;

-- ─── 2. Buzon de entrada de WhatsApp ────────────────────────────────────────
--
-- Recibir un evento y procesarlo son cosas distintas. Hoy se hacen en la
-- misma pasada y se ACKea antes de ambas. Aqui el webhook solo persiste, y un
-- worker procesa despues -- si el worker muere, el evento sigue en la tabla.
CREATE TABLE IF NOT EXISTS whatsapp_inbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable a proposito: si el phone_number_id no esta mapeado a ningun
  -- negocio, el evento se guarda igual como 'huerfano' en vez de tirarse.
  -- Perder el mensaje de un cliente porque falta una fila de configuracion
  -- seria peor que guardarlo sin dueno.
  negocio_id     UUID REFERENCES negocios(id) ON DELETE CASCADE,

  -- Clave de deduplicacion. Para mensajes es el wamid de Meta; para statuses,
  -- una clave derivada (wamid + estado), porque el mismo mensaje pasa por
  -- sent, delivered y read y los tres son eventos distintos.
  evento_id      TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  phone_number_id TEXT,
  payload        JSONB NOT NULL,

  estado         TEXT NOT NULL DEFAULT 'pendiente'
                 CHECK (estado IN ('pendiente', 'procesando', 'procesado', 'fallido', 'descartado', 'huerfano')),
  intentos       INTEGER NOT NULL DEFAULT 0,
  ultimo_error   TEXT,

  -- Lease del worker que lo tomo. Con FOR UPDATE SKIP LOCKED + este campo,
  -- dos instancias nunca procesan el mismo evento, y si una muere el lease
  -- vence y otra lo recoge.
  worker_id      TEXT,
  lease_hasta    TIMESTAMPTZ,

  recibido_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  procesado_en   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Meta puede reentregar el mismo webhook. Un solo evento logico.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_inbox_evento ON whatsapp_inbox (evento_id);
-- La consulta del worker: lo pendiente, mas viejo primero.
CREATE INDEX IF NOT EXISTS idx_wa_inbox_cola
  ON whatsapp_inbox (recibido_en)
  WHERE estado IN ('pendiente', 'procesando');
CREATE INDEX IF NOT EXISTS idx_wa_inbox_negocio ON whatsapp_inbox (negocio_id, recibido_en DESC);

-- ─── 3. Buzon de salida de WhatsApp ─────────────────────────────────────────
--
-- Un mensaje saliente se escribe aqui ANTES de llamar a Meta. Si el proceso
-- muere entre la base y el HTTP, al reiniciar sigue estando.
--
-- Ojo con la semantica: 'enviado_a_meta' significa que Meta acepto y devolvio
-- un wamid. No significa que el cliente lo vio. Y 'enviando' con un intento
-- ya hecho es AMBIGUO: la peticion pudo llegar. Por eso hay un estado propio
-- para eso en vez de reintentar a ciegas -- misma leccion que el 'incierto'
-- de la impresion.
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,

  -- Idempotencia del lado nuestro: si la misma causa (un mensaje entrante,
  -- una accion) genera dos veces el mismo saliente, es uno solo.
  clave_idem     TEXT NOT NULL,
  destino        TEXT NOT NULL,
  tipo           TEXT NOT NULL DEFAULT 'texto',
  contenido      JSONB NOT NULL,

  estado         TEXT NOT NULL DEFAULT 'encolado'
                 CHECK (estado IN ('encolado', 'enviando', 'enviado_a_meta', 'incierto',
                                   'fallo_reintentable', 'fallo_definitivo', 'cancelado')),
  intentos       INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  wamid          TEXT,
  ultimo_error   TEXT,
  codigo_error   TEXT,

  worker_id      TEXT,
  lease_hasta    TIMESTAMPTZ,

  enviado_en     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_outbox_idem ON whatsapp_outbox (negocio_id, clave_idem);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_cola
  ON whatsapp_outbox (proximo_intento_en)
  WHERE estado IN ('encolado', 'fallo_reintentable');
CREATE INDEX IF NOT EXISTS idx_wa_outbox_negocio ON whatsapp_outbox (negocio_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_outbox;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 4. Generacion del almacen local del Edge ───────────────────────────────
--
-- Si alguien borra la carpeta de datos del Edge, vuelve sin memoria. Ya
-- existe `edge_instalaciones` para impresion; aqui se anota ademas hasta
-- donde habia sincronizado cada dispositivo, para que un Edge amnesico entre
-- en recuperacion en vez de resincronizar a ciegas y duplicar el turno.
CREATE TABLE IF NOT EXISTS sync_dispositivos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  dispositivo_id TEXT NOT NULL,
  generacion     TEXT NOT NULL,
  ultima_secuencia BIGINT NOT NULL DEFAULT 0,
  ultima_sync_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amnesias       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_dispositivo_unico
  ON sync_dispositivos (negocio_id, dispositivo_id);

COMMIT;
