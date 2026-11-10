-- 135 · Pedidos de temporada (Thanksgiving y fechas parecidas).
--
-- Un formulario público, fuera del flujo de comandas, para AGENDAR platillos
-- de un solo día por ventana de entrega (p. ej. «entre 9 y 10 a. m.»). Cada
-- ventana tiene dos cupos que el servidor hace cumplir:
--   · cupo_platillos: cuántos platillos saca la cocina en esa ventana (recoger
--     y domicilio juntos);
--   · cupo_domicilio: cuántos pedidos a domicilio caben en esa ventana.
--
-- Módulo nuevo y aislado: no toca pedidos_activos, ni comandas, ni impresión.
-- Aditiva: solo crea dos tablas nuevas; ninguna fila existente cambia.

CREATE TABLE IF NOT EXISTS temporada_campanas (
  id                    bigserial    PRIMARY KEY,
  negocio_id            uuid         NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- Va en la URL pública (/api/temporada/<clave>): única en la plataforma.
  clave                 text         NOT NULL,
  titulo                text         NOT NULL,
  descripcion           text         NOT NULL DEFAULT '',
  producto              text         NOT NULL DEFAULT 'Platillo',
  -- Solo para mostrar; el formulario no cobra.
  precio                numeric(10,2) NULL,
  -- Prefijo del folio que ve el cliente (TG-001).
  prefijo               text         NOT NULL DEFAULT 'TG',
  fecha                 date         NOT NULL,
  hora_inicio           time         NOT NULL,
  hora_fin              time         NOT NULL,
  minutos_ventana       integer      NOT NULL DEFAULT 60,
  cupo_platillos        integer      NOT NULL,
  cupo_domicilio        integer      NOT NULL,
  max_platillos_pedido  integer      NOT NULL,
  acepta_recoger        boolean      NOT NULL DEFAULT true,
  acepta_domicilio      boolean      NOT NULL DEFAULT true,
  -- Después de este instante ya no se reciben pedidos (NULL = hasta que
  -- empiece cada ventana).
  cierra_en             timestamptz  NULL,
  -- Nace apagada: la enciende el administrador desde /temporada.
  activa                boolean      NOT NULL DEFAULT false,
  creado_en             timestamptz  NOT NULL DEFAULT now(),
  actualizado_en        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT temporada_campanas_clave_unica UNIQUE (clave),
  CONSTRAINT temporada_campanas_clave_formato CHECK (clave ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(clave) BETWEEN 3 AND 60),
  CONSTRAINT temporada_campanas_textos CHECK (length(titulo) BETWEEN 1 AND 120 AND length(producto) BETWEEN 1 AND 80
                                              AND length(descripcion) <= 2000),
  CONSTRAINT temporada_campanas_prefijo CHECK (prefijo ~ '^[A-Z]{1,5}$'),
  CONSTRAINT temporada_campanas_precio CHECK (precio IS NULL OR precio >= 0),
  CONSTRAINT temporada_campanas_horario CHECK (hora_fin > hora_inicio AND minutos_ventana BETWEEN 15 AND 240),
  CONSTRAINT temporada_campanas_cupos CHECK (cupo_platillos BETWEEN 1 AND 10000 AND cupo_domicilio BETWEEN 0 AND 1000
                                             AND max_platillos_pedido BETWEEN 1 AND cupo_platillos),
  CONSTRAINT temporada_campanas_modalidades CHECK ((acepta_recoger OR acepta_domicilio)
                                                   AND (NOT acepta_domicilio OR cupo_domicilio >= 1))
);

CREATE INDEX IF NOT EXISTS temporada_campanas_negocio ON temporada_campanas (negocio_id);

CREATE TABLE IF NOT EXISTS temporada_pedidos (
  id              bigserial    PRIMARY KEY,
  campana_id      bigint       NOT NULL REFERENCES temporada_campanas(id) ON DELETE RESTRICT,
  negocio_id      uuid         NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- Consecutivo por campaña; nunca se reutiliza (un cancelado conserva el suyo).
  numero          integer      NOT NULL,
  nombre          text         NOT NULL,
  -- Solo dígitos: 10 (México o EE. UU.) o con lada de país.
  telefono        text         NOT NULL,
  platillos       integer      NOT NULL,
  modalidad       text         NOT NULL,
  direccion       text         NULL,
  referencias     text         NULL,
  notas           text         NULL,
  ventana_inicio  time         NOT NULL,
  ventana_fin     time         NOT NULL,
  estado          text         NOT NULL DEFAULT 'confirmado',
  -- La genera la página al abrirse: reenviar el mismo formulario (doble clic,
  -- red que se cae) devuelve el mismo pedido en vez de apartar otro cupo.
  clave_envio     text         NOT NULL,
  creado_en       timestamptz  NOT NULL DEFAULT now(),
  cancelado_en    timestamptz  NULL,
  cancelado_por   text         NULL,
  CONSTRAINT temporada_pedidos_numero_unico UNIQUE (campana_id, numero),
  CONSTRAINT temporada_pedidos_envio_unico UNIQUE (campana_id, clave_envio),
  CONSTRAINT temporada_pedidos_numero CHECK (numero > 0),
  CONSTRAINT temporada_pedidos_textos CHECK (length(nombre) BETWEEN 2 AND 80
                                             AND (direccion IS NULL OR length(direccion) <= 300)
                                             AND (referencias IS NULL OR length(referencias) <= 300)
                                             AND (notas IS NULL OR length(notas) <= 500)
                                             AND length(clave_envio) BETWEEN 8 AND 80),
  CONSTRAINT temporada_pedidos_telefono CHECK (telefono ~ '^[0-9]{10,13}$'),
  CONSTRAINT temporada_pedidos_platillos CHECK (platillos >= 1),
  CONSTRAINT temporada_pedidos_modalidad CHECK (modalidad IN ('recoger', 'domicilio')),
  CONSTRAINT temporada_pedidos_direccion CHECK (modalidad = 'recoger' OR length(coalesce(direccion, '')) >= 5),
  CONSTRAINT temporada_pedidos_ventana CHECK (ventana_fin > ventana_inicio),
  CONSTRAINT temporada_pedidos_estado CHECK (estado IN ('confirmado', 'cancelado')
                                             AND ((estado = 'cancelado') = (cancelado_en IS NOT NULL)))
);

-- Lo que consulta cada alta para medir el cupo de su ventana.
CREATE INDEX IF NOT EXISTS temporada_pedidos_cupo
  ON temporada_pedidos (campana_id, ventana_inicio) WHERE estado = 'confirmado';
CREATE INDEX IF NOT EXISTS temporada_pedidos_negocio ON temporada_pedidos (negocio_id);
