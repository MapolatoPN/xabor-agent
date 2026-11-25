-- 161 · Fase 2: datos estructurados de producto y modificadores (23-nov-2026).
--
-- Pedido de Mario (Fase 2 del plan de 6 fases, plan aprobado el 23-nov):
--   2.1 cada línea vendida con sus modificadores como registros (grupo,
--       opción, cantidad, precio extra, referencia al menú);
--   2.2 las opciones de Rappi emparejadas con el menú de Xabor, y lo que no
--       empareje, «Sin clasificar» para corregirlo a mano;
--   2.3 la nota libre de cada línea aparte;
--   2.4 el tipo de producto (platillo, bebida, extra, envío, otro).
--
-- Diseño: un REGISTRO APARTE, derivado de las ventas. La venta
-- (pedidos_activos.datos) no se toca nunca: lo llena un proceso en segundo
-- plano (src/services/lineasEstructuradasProceso.js) y el mismo código hace
-- el relleno histórico (scripts/rellenar-lineas-estructuradas.mjs). La
-- comanda, el ticket y el Xabor Edge no leen nada de esto.
--
-- Aditiva:
--   · menu_productos.tipo nace 'platillo' en todos (DEFAULT constante: no
--     reescribe la tabla). Marcar envío/extra/bebida lo hace un script aparte
--     con modo de prueba (scripts/marcar-tipo-producto.mjs) o el editor.
--   · restaurante_cuenta_items gana producto_id y modificadores_det, NULL en
--     todo lo existente. Las columnas de siempre siguen igual (Mesas, la
--     precuenta, la división y el papel de cancelación las leen).
--   · cuatro tablas nuevas y vacías.
--
-- Es la 161. Nació como 151, pero en producción Xabor Básico ocupa del 150
-- al 156 y la campanita de avisos la 160 (25-nov-2026).

ALTER TABLE menu_productos
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'platillo';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_productos_tipo') THEN
    ALTER TABLE menu_productos ADD CONSTRAINT menu_productos_tipo
      CHECK (tipo IN ('platillo', 'bebida', 'extra', 'envio', 'otro'));
  END IF;
END $$;

ALTER TABLE restaurante_cuenta_items
  ADD COLUMN IF NOT EXISTS producto_id integer,
  ADD COLUMN IF NOT EXISTS modificadores_det jsonb;

-- Un renglón por pedido procesado. `firma` es la huella de sus artículos:
-- si cambian, el proceso lo rehace. Borrarlo borra sus líneas (cascada).
CREATE TABLE IF NOT EXISTS pedido_lineas_pedidos (
  negocio_id       uuid         NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  folio            text         NOT NULL,
  origen           text         NOT NULL,
  canal            text         NOT NULL,
  firma            text         NOT NULL,
  lineas           integer      NOT NULL,
  completas        integer      NOT NULL,
  parciales        integer      NOT NULL,
  sin_estructurar  integer      NOT NULL,
  procesado_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, folio),
  CONSTRAINT pedido_lineas_pedidos_origen CHECK (origen IN ('venta', 'temporada')),
  CONSTRAINT pedido_lineas_pedidos_cuentas CHECK (lineas >= 0 AND completas >= 0 AND parciales >= 0
                                                  AND sin_estructurar >= 0
                                                  AND completas + parciales + sin_estructurar = lineas)
);

CREATE TABLE IF NOT EXISTS pedido_lineas (
  id               bigserial    PRIMARY KEY,
  negocio_id       uuid         NOT NULL,
  folio            text         NOT NULL,
  linea            integer      NOT NULL,
  canal            text         NOT NULL,
  producto_id      integer      NULL,
  nombre           text         NOT NULL,
  tipo             text         NOT NULL,
  cantidad         numeric(10,2) NOT NULL,
  precio_unitario  numeric(10,2) NOT NULL,
  nota             text         NULL,
  estado           text         NOT NULL,
  CONSTRAINT pedido_lineas_pedido_fkey FOREIGN KEY (negocio_id, folio)
    REFERENCES pedido_lineas_pedidos (negocio_id, folio) ON DELETE CASCADE,
  CONSTRAINT pedido_lineas_unica UNIQUE (negocio_id, folio, linea),
  CONSTRAINT pedido_lineas_tipo CHECK (tipo IN ('platillo', 'bebida', 'extra', 'envio', 'otro')),
  CONSTRAINT pedido_lineas_estado CHECK (estado IN ('completa', 'parcial', 'sin_estructurar'))
);
CREATE INDEX IF NOT EXISTS pedido_lineas_producto ON pedido_lineas (negocio_id, producto_id);

CREATE TABLE IF NOT EXISTS pedido_linea_modificadores (
  id               bigserial    PRIMARY KEY,
  linea_id         bigint       NOT NULL REFERENCES pedido_lineas(id) ON DELETE CASCADE,
  negocio_id       uuid         NOT NULL,
  orden            integer      NOT NULL,
  grupo_id         integer      NULL,
  grupo            text         NOT NULL,
  opcion_id        integer      NULL,
  opcion           text         NOT NULL,
  cantidad         numeric(10,2) NOT NULL DEFAULT 1,
  precio_extra     numeric(10,2) NOT NULL DEFAULT 0,
  -- true: el precio salió del menú de hoy porque la venta no lo guardó.
  precio_estimado  boolean      NOT NULL DEFAULT false,
  clasificado      boolean      NOT NULL,
  CONSTRAINT pedido_linea_modificadores_cantidad CHECK (cantidad > 0),
  CONSTRAINT pedido_linea_modificadores_clasificado CHECK (NOT clasificado OR opcion_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pedido_linea_modificadores_linea ON pedido_linea_modificadores (linea_id);
CREATE INDEX IF NOT EXISTS pedido_linea_modificadores_sin_clasificar
  ON pedido_linea_modificadores (negocio_id) WHERE NOT clasificado;

-- Correcciones a mano de Rappi (pantalla «Rappi › Opciones sin clasificar»).
-- opcion_rappi = '' empareja el PRODUCTO; con opción, empareja la opción
-- dentro de ese producto. Las llaves van normalizadas (minúsculas, sin
-- acentos ni espacios dobles).
CREATE TABLE IF NOT EXISTS rappi_emparejamientos (
  id               bigserial    PRIMARY KEY,
  negocio_id       uuid         NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  producto_rappi   text         NOT NULL,
  opcion_rappi     text         NOT NULL DEFAULT '',
  producto_id      integer      NOT NULL REFERENCES menu_productos(id) ON DELETE CASCADE,
  grupo_id         integer      NULL REFERENCES menu_modificadores_grupos(id) ON DELETE CASCADE,
  opcion_id        integer      NULL REFERENCES menu_modificadores_opciones(id) ON DELETE CASCADE,
  creado_por       text         NULL,
  creado_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT rappi_emparejamientos_unico UNIQUE (negocio_id, producto_rappi, opcion_rappi),
  CONSTRAINT rappi_emparejamientos_forma CHECK (
    length(producto_rappi) BETWEEN 1 AND 200 AND length(opcion_rappi) <= 200
    AND ((opcion_rappi = '' AND grupo_id IS NULL AND opcion_id IS NULL)
      OR (opcion_rappi <> '' AND grupo_id IS NOT NULL AND opcion_id IS NOT NULL)))
);
