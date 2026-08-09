-- ============================================================
-- XABOR — Migración 043: impresión multi-destino (Xabor Edge)
--
-- Añade lo único que faltaba para que Xabor pueda sustituir a un POS de
-- restaurante en la parte de impresión: VARIAS impresoras por sucursal,
-- REGLAS de destino, y el trabajo de impresión como FILA PERSISTENTE en
-- vez de un mensaje que se emite y se olvida.
--
-- Lo que NO crea, a propósito (ver docs/impresion-actual-auditoria.md):
--
--   * NO crea "edge_devices". El dispositivo Edge ES una fila de
--     `terminales`, que desde la migración 003 ya tiene sucursal_id
--     (y por tanto negocio, vía sucursales) y desde la 010 tiene
--     token_hash + tipo + ultima_conexion, con índice único parcial
--     sobre el hash. Crear una segunda identidad significaría dos
--     caminos de autenticación y dos fuentes de verdad sobre quién
--     puede imprimir para un negocio -- exactamente la duplicación que
--     ya provocó incidentes de aislamiento en este proyecto.
--     `terminales.tipo` es TEXT abierto justamente para esto.
--
--   * NO toca ninguna tabla existente. Puramente aditiva: tres tablas
--     nuevas, sus índices y sus triggers de updated_at. Cero ALTER
--     sobre tablas en uso, cero backfill, cero borrado.
--
-- Reejecutable.
-- ============================================================

-- ── impresoras ───────────────────────────────────────────────────────
-- Una impresora física de la sucursal. host/puerto son DATOS DE
-- CONFIGURACIÓN: la nube nunca abre un socket contra ellos (ver
-- docs/xabor-edge-arquitectura.md, sección SSRF). Solo el Edge, que vive
-- dentro de la LAN, los usa.
--
-- terminal_id: el Edge que puede alcanzarla. NOT NULL a propósito -- una
-- impresora que ningún Edge puede alcanzar no es configuración válida,
-- es un job que nunca se entregaría. ON DELETE CASCADE: si se elimina la
-- terminal, sus impresoras dejan de existir (los trabajos históricos
-- sobreviven, ver más abajo).
--
-- negocio_id se guarda denormalizado JUNTO a sucursal_id, al contrario
-- del criterio de la 010 para terminales. La razón es concreta: cada
-- entrega de un trabajo filtra por negocio Y sucursal en el camino
-- caliente (broadcastPrintAgentNegocio), y hacer ese filtro con un JOIN
-- a sucursales en cada comanda es gasto innecesario. La FK compuesta de
-- más abajo impide que la denormalización se desincronice.
CREATE TABLE IF NOT EXISTS impresoras (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id   UUID NOT NULL REFERENCES negocios(id)   ON DELETE CASCADE,
  sucursal_id  UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  terminal_id  UUID NOT NULL REFERENCES terminales(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  -- 'mock' | 'tcp_raw' | 'windows_spooler'. Sin CHECK IN (...): mismo
  -- criterio que integraciones_canal.canal y terminales.tipo -- agregar
  -- un transporte nuevo no debe requerir otra migración. La validación
  -- de valores admitidos vive en la aplicación.
  transporte   TEXT NOT NULL DEFAULT 'mock',
  -- Nullable: 'mock' y 'windows_spooler' no usan host/puerto.
  -- SIN DEFAULT 9100: el puerto tiene que ser una decisión explícita del
  -- levantamiento en sitio, no una suposición heredada.
  host         TEXT,
  puerto       INTEGER CHECK (puerto IS NULL OR (puerto > 0 AND puerto <= 65535)),
  -- Ancho del papel en columnas de caracteres (42 ≈ 80 mm, 32 ≈ 58 mm).
  -- En columnas y no en milímetros porque es lo que el renderer necesita
  -- para envolver el texto, y evita convertir en cada impresión.
  ancho_columnas INTEGER NOT NULL DEFAULT 42 CHECK (ancho_columnas BETWEEN 20 AND 96),
  activa       BOOLEAN NOT NULL DEFAULT true,
  -- Espacio para lo específico de cada modelo (nombre en el spooler de
  -- Windows, si corta el papel, densidad...). JSONB para no volver a
  -- migrar por cada opción nueva.
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sucursal_id, nombre)
);

-- Coherencia negocio↔sucursal: impide que una impresora diga pertenecer
-- al negocio A mientras cuelga de una sucursal del negocio B. Requiere
-- una UNIQUE en sucursales(id, negocio_id), que se crea aquí porque
-- (id) ya es PK y añadir la pareja es gratis e idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sucursales_id_negocio ON sucursales (id, negocio_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_impresoras_sucursal_negocio'
  ) THEN
    ALTER TABLE impresoras
      ADD CONSTRAINT fk_impresoras_sucursal_negocio
      FOREIGN KEY (sucursal_id, negocio_id)
      REFERENCES sucursales (id, negocio_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_impresoras_negocio  ON impresoras (negocio_id);
CREATE INDEX IF NOT EXISTS idx_impresoras_sucursal ON impresoras (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_impresoras_terminal ON impresoras (terminal_id);

DROP TRIGGER IF EXISTS set_updated_at ON impresoras;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON impresoras
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── impresion_rutas ──────────────────────────────────────────────────
-- "Qué se imprime dónde". Una regla conecta un ÁMBITO con una impresora.
--
--   ambito='categoria'  clave = nombre de la categoría del menú
--   ambito='producto'   clave = nombre del producto
--   ambito='documento'  clave = 'cuenta' | 'comanda' | 'cancelacion'
--
-- La clave es TEXTO, no un FK a menu_categorias/menu_productos, por dos
-- razones: (1) el snapshot del trabajo ya guarda el nombre y no debe
-- depender del catálogo vivo; (2) permite configurar el routing antes de
-- que el menú definitivo esté cargado, que es justo lo que hace falta
-- para el levantamiento en sitio. Se normaliza en la aplicación
-- (minúsculas, sin acentos) para que "Bebidas" y "bebidas" sean la misma
-- regla; la columna guarda la forma normalizada.
--
-- modo: 'agregar' suma destinos al resultado de la categoría;
--       'exclusivo' hace que las reglas de ese producto SUSTITUYAN a las
--       de su categoría. Semántica completa en
--       docs/xabor-edge-arquitectura.md.
CREATE TABLE IF NOT EXISTS impresion_rutas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id   UUID NOT NULL REFERENCES negocios(id)   ON DELETE CASCADE,
  sucursal_id  UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  impresora_id UUID NOT NULL REFERENCES impresoras(id) ON DELETE CASCADE,
  ambito       TEXT NOT NULL CHECK (ambito IN ('categoria', 'producto', 'documento')),
  clave        TEXT NOT NULL CHECK (clave <> ''),
  modo         TEXT NOT NULL DEFAULT 'agregar' CHECK (modo IN ('agregar', 'exclusivo')),
  activa       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- La misma regla no puede existir dos veces: evita que un doble clic en
  -- la UI de configuración duplique un destino y el item salga dos veces
  -- por la misma impresora.
  UNIQUE (sucursal_id, ambito, clave, impresora_id)
);

CREATE INDEX IF NOT EXISTS idx_rutas_negocio  ON impresion_rutas (negocio_id);
CREATE INDEX IF NOT EXISTS idx_rutas_busqueda ON impresion_rutas (sucursal_id, ambito, clave) WHERE activa;

DROP TRIGGER IF EXISTS set_updated_at ON impresion_rutas;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON impresion_rutas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── impresion_trabajos ───────────────────────────────────────────────
-- El trabajo de impresión como registro duradero: es lo que permite
-- reintentar, confirmar, reimprimir y saber qué pasó.
--
-- impresora_id ON DELETE SET NULL y terminal_id ON DELETE SET NULL: si
-- mañana se retira una impresora, su historial NO se borra. Un trabajo
-- es evidencia de lo que ocurrió; perderlo al reconfigurar el hardware
-- sería perder la auditoría. Los campos desnormalizados (impresora_nombre)
-- conservan legible el destino aunque la fila original desaparezca.
--
-- payload: el SNAPSHOT completo de lo que hay que imprimir, congelado en
-- el momento del envío. Nunca se reconstruye consultando el menú actual:
-- si mañana sube el precio del bistec, la comanda de anoche debe seguir
-- diciendo lo que decía anoche.
CREATE TABLE IF NOT EXISTS impresion_trabajos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id       UUID NOT NULL REFERENCES negocios(id)   ON DELETE CASCADE,
  sucursal_id      UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  terminal_id      UUID     REFERENCES terminales(id) ON DELETE SET NULL,
  impresora_id     UUID     REFERENCES impresoras(id) ON DELETE SET NULL,
  impresora_nombre TEXT NOT NULL,

  -- 'comanda' | 'cuenta' | 'cancelacion' | 'prueba'. Sin CHECK IN por el
  -- mismo criterio abierto del resto del proyecto.
  documento        TEXT NOT NULL,
  -- De dónde nació: 'restaurante_comanda', 'restaurante_cuenta',
  -- 'prueba_manual', 'reimpresion'... y el id de ese origen.
  origen_tipo      TEXT NOT NULL,
  origen_id        TEXT NOT NULL,

  -- LA defensa contra duplicados. Determinista, calculada en la
  -- aplicación a partir de datos ya estables (nunca Date.now() ni
  -- random): si el mismo request se reintenta, la clave es idéntica y el
  -- INSERT choca. UNIQUE global porque la clave ya incluye el negocio.
  --
  -- El código que inserta DEBE comprobar de verdad si hubo conflicto
  -- (RETURNING vacío => ya existía) y no dar éxito incondicional: ese
  -- error exacto ya costó un incidente de folios en este proyecto.
  idempotency_key  TEXT NOT NULL UNIQUE,

  payload          JSONB NOT NULL,

  -- pendiente   → creado, aún no entregado a ningún Edge
  -- entregado   → enviado por WS a un Edge conectado (sin confirmar)
  -- impreso     → el Edge confirmó que los bytes salieron
  -- incierto    → el Edge envió los bytes pero se cayó la conexión antes
  --               de poder confirmar: puede haber salido papel o no.
  --               NO se reintenta solo; requiere decisión humana.
  -- fallido     → error definido (conexión rechazada, timeout...) y aún
  --               con reintentos disponibles
  -- agotado     → se acabaron los reintentos; no se pierde, se revisa
  -- cancelado   → lo canceló una persona
  estado           TEXT NOT NULL DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente','entregado','enviado','incierto','fallido','agotado','cancelado')),
  intentos         INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_error     TEXT,

  -- Reimprimir es una intención NUEVA: crea otro trabajo con su propia
  -- clave de idempotencia y apunta aquí al original. Nunca se "resetea"
  -- el trabajo viejo: eso borraría la evidencia de lo que pasó.
  trabajo_original_id UUID REFERENCES impresion_trabajos(id) ON DELETE SET NULL,
  reimpreso_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo           TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entregado_at     TIMESTAMPTZ,
  acked_at         TIMESTAMPTZ
);

-- Cola de trabajo del Edge: lo pendiente de una sucursal, en orden.
CREATE INDEX IF NOT EXISTS idx_trabajos_cola
  ON impresion_trabajos (sucursal_id, created_at)
  WHERE estado IN ('pendiente', 'entregado', 'fallido');

CREATE INDEX IF NOT EXISTS idx_trabajos_negocio   ON impresion_trabajos (negocio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trabajos_impresora ON impresion_trabajos (impresora_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trabajos_origen    ON impresion_trabajos (negocio_id, origen_tipo, origen_id);

DROP TRIGGER IF EXISTS set_updated_at ON impresion_trabajos;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON impresion_trabajos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── edge_emparejamientos ─────────────────────────────────────────────
-- Códigos de emparejamiento de un solo uso.
--
-- El problema que resuelve: hay que meter una credencial en la PC del
-- restaurante sin dictarle a nadie por teléfono un token de 64 caracteres
-- y sin mandarlo por WhatsApp. El administrador genera un código corto en
-- el panel, alguien lo teclea en el Edge, y el Edge recibe su credencial
-- permanente por una sola vez.
--
-- Solo se guarda el HASH del código, igual que password_reset_tokens
-- (migración 042): quien lea la base no puede emparejar un Edge propio.
--
-- expira_at corto (minutos) y usado_at de un solo uso: un código filtrado
-- de ayer no sirve. La credencial que entrega es la de `terminales`, con
-- su propio token revocable -- nunca PANEL_SECRET ni ninguna clave global.
CREATE TABLE IF NOT EXISTS edge_emparejamientos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id   UUID NOT NULL REFERENCES negocios(id)   ON DELETE CASCADE,
  terminal_id  UUID NOT NULL REFERENCES terminales(id) ON DELETE CASCADE,
  codigo_hash  TEXT NOT NULL UNIQUE,
  expira_at    TIMESTAMPTZ NOT NULL,
  usado_at     TIMESTAMPTZ,
  creado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emparejamientos_terminal ON edge_emparejamientos (terminal_id);
-- Un código vigente por terminal a la vez: generar uno nuevo invalida el
-- anterior por vencimiento, y este índice evita que se acumulen dos
-- válidos simultáneos por un doble clic en el panel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emparejamiento_vigente
  ON edge_emparejamientos (terminal_id)
  WHERE usado_at IS NULL;


-- ── edge_instalaciones ───────────────────────────────────────────────
-- Detecta un "Edge amnésico": el mismo terminal, pero con la cola local
-- borrada o regenerada.
--
-- El problema: la nube guarda trabajos como 'entregado' (mandados al Edge,
-- sin confirmar). Si alguien borra la carpeta de datos del Edge, ese Edge
-- vuelve sin memoria y la nube le reenviaría todo lo no confirmado -- pero
-- algunos de esos trabajos PUDIERON haber salido en papel. Reimprimirlos
-- automáticamente sacaría comandas repetidas en cocina.
--
-- El Edge genera un `instalacion_id` la primera vez y lo guarda en su
-- propia cola. Si al autenticarse presenta uno distinto del último visto,
-- la nube sabe que perdió la memoria: los trabajos ya entregados y sin
-- confirmar pasan a 'incierto' en vez de volver a enviarse, y quedan para
-- que una persona decida.
--
-- Una fila por terminal. No guarda secretos: el id de instalación es un
-- identificador opaco, no una credencial.
CREATE TABLE IF NOT EXISTS edge_instalaciones (
  terminal_id     UUID PRIMARY KEY REFERENCES terminales(id) ON DELETE CASCADE,
  instalacion_id  TEXT NOT NULL,
  primera_vista   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_vista    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reinicios       INTEGER NOT NULL DEFAULT 0
);
