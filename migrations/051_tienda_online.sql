-- ─── 051: Módulo Tienda Online (SaaS multiempresa) ─────────────────────────
-- Idempotente y re-ejecutable. La tienda REUTILIZA lo que ya existe: catálogo
-- (menu_*), pedidos (pedidos_activos), impresión (impresion_*), pagos
-- (metodos_pago) y reglas operativas (configuracion.reglas_atencion). Lo que
-- se agrega aquí es solo lo que no existía: configuración de tienda por
-- negocio, publicación de productos por canal, motor de promociones con
-- campañas/influencers, y el mapa checkout→pedido→tracking.
--
-- QUÉ TOCA DE LO YA EXISTENTE (tres cosas, todas al final del archivo):
--   1. negocio_modulos: reemplaza su CHECK para admitir 'tienda_online'. Sin
--      esto, contratar el módulo falla con violación de restricción.
--   2. menu_productos: agrega el índice UNIQUE (negocio_id, id) que necesita
--      la FK compuesta de tienda_productos. Como `id` ya es PK, ese índice
--      siempre se satisface sobre datos existentes.
--   3. pedidos_activos: agrega un índice único parcial sobre el checkout_token
--      que la tienda estampa en `datos`. Es la autoridad que impide dos
--      pedidos para el mismo checkout, incluso tras un crash a media creación.
--   El rollback (051_tienda_online_down.sql) deshace las tres.
--
-- Regla de oro: todo lleva negocio_id y todo índice/constraint único es POR
-- NEGOCIO — dos restaurantes pueden tener el mismo código de cupón.

-- ── Configuración de la tienda por negocio ────────────────────────────────
-- NO duplica reglas operativas (horarios, costo de envío, pedido mínimo,
-- zonas, tiempos): esas se leen de configuracion.reglas_atencion, que es la
-- fuente única que ya usan el POS y el bot. Aquí vive solo lo propio de la
-- tienda: estado de publicación, identidad visual y qué ofrece al público.
CREATE TABLE IF NOT EXISTS tienda_config (
  negocio_id            uuid PRIMARY KEY REFERENCES negocios(id) ON DELETE RESTRICT,
  estado                text NOT NULL DEFAULT 'borrador',
  slug_publico          text,
  titular               text,
  descripcion           text,
  color_primario        text,
  logo_url              text,
  portada_url           text,
  modalidades           jsonb NOT NULL DEFAULT '["recoger"]'::jsonb,
  acepta_programados    boolean NOT NULL DEFAULT false,
  anticipacion_minutos  integer NOT NULL DEFAULT 30,
  mensaje_bienvenida    text,
  publicada_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE tienda_config ADD CONSTRAINT chk_tienda_estado
    CHECK (estado IN ('borrador', 'publicada', 'pausada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE tienda_config ADD CONSTRAINT chk_tienda_anticipacion
    CHECK (anticipacion_minutos >= 0 AND anticipacion_minutos <= 1440);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Slug público opcional: si es NULL la tienda se resuelve por negocios.slug.
-- Único a nivel plataforma porque es una URL pública.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tienda_slug_publico
  ON tienda_config (lower(slug_publico)) WHERE slug_publico IS NOT NULL;

-- ── Publicación del catálogo por canal ────────────────────────────────────
-- El producto NO se copia: esta tabla solo decide si sale en la tienda y
-- permite overrides opcionales por canal. Sin fila = no publicado (cerrado
-- por defecto: publicar es una decisión explícita del negocio).
CREATE TABLE IF NOT EXISTS tienda_productos (
  negocio_id            uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  producto_id           integer NOT NULL REFERENCES menu_productos(id) ON DELETE CASCADE,
  publicado             boolean NOT NULL DEFAULT true,
  destacado             boolean NOT NULL DEFAULT false,
  badge                 text,
  descripcion_comercial text,
  imagen_url            text,
  precio_tienda         numeric(10,2),
  orden                 integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (negocio_id, producto_id)
);
CREATE INDEX IF NOT EXISTS idx_tienda_productos_publicados
  ON tienda_productos (negocio_id) WHERE publicado;

DO $$ BEGIN
  ALTER TABLE tienda_productos ADD CONSTRAINT chk_tienda_precio_positivo
    CHECK (precio_tienda IS NULL OR precio_tienda >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Campañas / influencers ────────────────────────────────────────────────
-- La atribución pertenece al negocio: la misma influencer puede trabajar con
-- varios restaurantes con condiciones distintas y nunca se mezclan sus ventas.
CREATE TABLE IF NOT EXISTS tienda_campanas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  nombre        text NOT NULL,
  influencer    text,
  contacto      text,
  notas         text,
  activa        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campanas_negocio_nombre
  ON tienda_campanas (negocio_id, lower(nombre));

-- ── Motor de promociones ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tienda_promociones (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id          uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  campania_id         uuid REFERENCES tienda_campanas(id) ON DELETE SET NULL,
  nombre              text NOT NULL,
  tipo                text NOT NULL,
  codigo              text,
  automatica          boolean NOT NULL DEFAULT false,
  valor               numeric(10,2) NOT NULL DEFAULT 0,
  minimo_compra       numeric(10,2) NOT NULL DEFAULT 0,
  max_descuento       numeric(10,2),
  vigencia_desde      timestamptz,
  vigencia_hasta      timestamptz,
  dias_semana         jsonb,
  hora_inicio         time,
  hora_fin            time,
  limite_usos         integer,
  limite_por_cliente  integer,
  usos                integer NOT NULL DEFAULT 0,
  solo_primera_compra boolean NOT NULL DEFAULT false,
  canales             jsonb NOT NULL DEFAULT '["tienda_online"]'::jsonb,
  modalidades         jsonb,
  productos           jsonb,
  categorias          jsonb,
  acumulable          boolean NOT NULL DEFAULT true,
  prioridad           integer NOT NULL DEFAULT 100,
  activa              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_tipo
    CHECK (tipo IN ('envio_gratis', 'porcentaje', 'monto_fijo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_valor
    CHECK (valor >= 0 AND (tipo <> 'porcentaje' OR valor <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Una promoción o es automática o tiene código: sin código y sin automática
-- no habría forma de aplicarla.
DO $$ BEGIN
  ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_aplicable
    CHECK (automatica OR codigo IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Unicidad POR NEGOCIO: "CARNITAS20" puede existir en dos restaurantes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_negocio_codigo
  ON tienda_promociones (negocio_id, lower(codigo)) WHERE codigo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promo_negocio_activas
  ON tienda_promociones (negocio_id) WHERE activa;
CREATE INDEX IF NOT EXISTS idx_promo_campania ON tienda_promociones (campania_id);

-- ── Usos de promoción (atribución y límites) ──────────────────────────────
-- Una fila por pedido y promoción. El UNIQUE hace idempotente el registro:
-- un reintento del checkout no vuelve a contar el uso ni la venta.
CREATE TABLE IF NOT EXISTS tienda_promocion_usos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  promocion_id      uuid NOT NULL REFERENCES tienda_promociones(id) ON DELETE CASCADE,
  campania_id       uuid REFERENCES tienda_campanas(id) ON DELETE SET NULL,
  pedido_folio      text NOT NULL,
  cliente_telefono  text,
  monto_descuento   numeric(10,2) NOT NULL DEFAULT 0,
  monto_venta       numeric(10,2) NOT NULL DEFAULT 0,
  cliente_nuevo     boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_uso_unico
  ON tienda_promocion_usos (negocio_id, promocion_id, pedido_folio);
CREATE INDEX IF NOT EXISTS idx_promo_uso_negocio_promo
  ON tienda_promocion_usos (negocio_id, promocion_id);
CREATE INDEX IF NOT EXISTS idx_promo_uso_campania
  ON tienda_promocion_usos (negocio_id, campania_id) WHERE campania_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promo_uso_cliente
  ON tienda_promocion_usos (negocio_id, promocion_id, cliente_telefono);

-- ── Checkout → pedido → tracking ──────────────────────────────────────────
-- checkout_token: idempotencia real (mismo token = mismo pedido, aunque el
--   navegador reintente, refresque o el usuario haga doble click).
-- tracking_token: identificador público OPACO para seguir el pedido sin
--   exponer folios ni permitir enumeración.
CREATE TABLE IF NOT EXISTS tienda_pedidos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  checkout_token  text NOT NULL,
  tracking_token  text NOT NULL,
  pedido_folio    text,
  estado          text NOT NULL DEFAULT 'creando',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tienda_pedidos_checkout
  ON tienda_pedidos (negocio_id, checkout_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tienda_pedidos_tracking
  ON tienda_pedidos (tracking_token);
CREATE INDEX IF NOT EXISTS idx_tienda_pedidos_folio
  ON tienda_pedidos (negocio_id, pedido_folio);

-- ── El módulo tiene que existir para el sistema de módulos ────────────────
-- negocio_modulos tiene un CHECK con la lista de módulos válidos. Sin este
-- paso, activar 'tienda_online' para un negocio falla con violación de
-- restricción -- es decir, la regla de "dar de alta una tienda es puro dato"
-- se rompería en la primera alta real. El CHECK se reemplaza conservando
-- todos los módulos anteriores.
ALTER TABLE negocio_modulos DROP CONSTRAINT IF EXISTS negocio_modulos_modulo_check;
ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check CHECK (modulo = ANY (ARRAY[
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi',
  'facturacion', 'rewards', 'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones',
  'generador_cotizaciones', 'pagos', 'repartidores', 'asistente_comercial_cotizaciones',
  'restaurante', 'tienda_online'
]));

-- ── Aislamiento multiempresa impuesto por el ESQUEMA ──────────────────────
-- Las FKs de arriba apuntan solo al id del padre: nada impide, a nivel de
-- base, que una promoción del negocio A quede ligada a la campaña del negocio
-- B. Hoy los servicios lo validan, pero un servicio futuro que se equivoque
-- no tendría red. Se convierten en FKs COMPUESTAS (negocio_id, id): con eso,
-- una asociación cruzada es imposible aunque el código falle.
--
-- Requisito previo: cada padre necesita un UNIQUE (negocio_id, id). En tablas
-- donde `id` ya es PK, ese índice siempre se satisface — no puede fallar sobre
-- datos existentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campana_negocio_id
  ON tienda_campanas (negocio_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promocion_negocio_id
  ON tienda_promociones (negocio_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_producto_negocio_id
  ON menu_productos (negocio_id, id);

DO $$
BEGIN
  -- tienda_productos.producto_id → menu_productos, del MISMO negocio.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'tienda_productos_producto_id_fkey') THEN
    ALTER TABLE tienda_productos DROP CONSTRAINT tienda_productos_producto_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tienda_productos_negocio_producto_fkey') THEN
    ALTER TABLE tienda_productos
      ADD CONSTRAINT tienda_productos_negocio_producto_fkey
      FOREIGN KEY (negocio_id, producto_id) REFERENCES menu_productos (negocio_id, id)
      ON DELETE CASCADE;
  END IF;

  -- tienda_promociones.campania_id → tienda_campanas, del MISMO negocio.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'tienda_promociones_campania_id_fkey') THEN
    ALTER TABLE tienda_promociones DROP CONSTRAINT tienda_promociones_campania_id_fkey;
  END IF;
  -- Si ya existe pero con la semántica vieja (SET NULL sin lista de columnas),
  -- se reemplaza: dejarla así haría fallar el DELETE de una campaña.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'tienda_promociones_negocio_campania_fkey'
                AND pg_get_constraintdef(oid) NOT LIKE '%SET NULL (campania_id)%') THEN
    ALTER TABLE tienda_promociones DROP CONSTRAINT tienda_promociones_negocio_campania_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tienda_promociones_negocio_campania_fkey') THEN
    ALTER TABLE tienda_promociones
      ADD CONSTRAINT tienda_promociones_negocio_campania_fkey
      FOREIGN KEY (negocio_id, campania_id) REFERENCES tienda_campanas (negocio_id, id)
      -- SET NULL solo sobre campania_id: negocio_id es NOT NULL y un SET NULL
      -- sin lista de columnas intentaría nulearlo también, y el DELETE del
      -- padre reventaría. Requiere PostgreSQL 15+.
      ON DELETE SET NULL (campania_id);
  END IF;

  -- tienda_promocion_usos: promoción y campaña, ambas del MISMO negocio.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'tienda_promocion_usos_promocion_id_fkey') THEN
    ALTER TABLE tienda_promocion_usos DROP CONSTRAINT tienda_promocion_usos_promocion_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tienda_promocion_usos_negocio_promocion_fkey') THEN
    ALTER TABLE tienda_promocion_usos
      ADD CONSTRAINT tienda_promocion_usos_negocio_promocion_fkey
      FOREIGN KEY (negocio_id, promocion_id) REFERENCES tienda_promociones (negocio_id, id)
      ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'tienda_promocion_usos_campania_id_fkey') THEN
    ALTER TABLE tienda_promocion_usos DROP CONSTRAINT tienda_promocion_usos_campania_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'tienda_promocion_usos_negocio_campania_fkey'
                AND pg_get_constraintdef(oid) NOT LIKE '%SET NULL (campania_id)%') THEN
    ALTER TABLE tienda_promocion_usos DROP CONSTRAINT tienda_promocion_usos_negocio_campania_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tienda_promocion_usos_negocio_campania_fkey') THEN
    ALTER TABLE tienda_promocion_usos
      ADD CONSTRAINT tienda_promocion_usos_negocio_campania_fkey
      FOREIGN KEY (negocio_id, campania_id) REFERENCES tienda_campanas (negocio_id, id)
      -- SET NULL solo sobre campania_id: negocio_id es NOT NULL y un SET NULL
      -- sin lista de columnas intentaría nulearlo también, y el DELETE del
      -- padre reventaría. Requiere PostgreSQL 15+.
      ON DELETE SET NULL (campania_id);
  END IF;
END $$;


-- ── Autoridad contra pedidos duplicados por crash ─────────────────────────
-- El checkout estampa su token dentro del propio pedido (datos->'tienda'->>
-- 'checkout_token') ANTES de crearlo. Este índice hace que la BASE, no la
-- aplicación, garantice que un checkout produce como máximo un pedido: si el
-- proceso muere entre crear el pedido y vincularlo, el reintento no puede
-- crear otro — choca contra el índice y el flujo lo recupera.
--
-- Parcial: solo afecta a los pedidos que traen token (los de la tienda). Los
-- pedidos de mostrador, WhatsApp y Rappi no llevan ninguno y quedan fuera.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_activo_checkout_token
  ON pedidos_activos (negocio_id, (datos->'tienda'->>'checkout_token'))
  WHERE datos->'tienda'->>'checkout_token' IS NOT NULL;


-- ── Ledger de derivaciones del checkout ───────────────────────────────────
-- Terminar un pedido no es un solo acto: hay que vincularlo, guardarlo en el
-- historial, emitirlo (comanda + tablero + oferta a repartidores) y atribuir
-- las promociones. Si el proceso muere a media lista, el reintento tiene que
-- retomar SOLO lo que falta.
--
-- No basta con volver a llamar a emitirPedido: la comanda por Edge es
-- idempotente y la oferta a repartidores está deduplicada por (folio,
-- repartidor), pero la impresión legacy (negocios que aún no migran a Edge)
-- imprimiría papel otra vez, y el panel volvería a anunciar el pedido como
-- nuevo. Por eso cada derivación deja marca persistente aquí.
ALTER TABLE tienda_pedidos
  ADD COLUMN IF NOT EXISTS derivaciones jsonb NOT NULL DEFAULT '{}'::jsonb;
