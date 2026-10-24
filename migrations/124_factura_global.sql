-- Facturación, fase 3: la factura global la hace Xabor, a mano (decisión de
-- Mario, 23-oct): se eligen los tickets del periodo y se timbra una global por
-- forma de pago con exactamente esos recibos (POST /receipts/global-invoice).
--
-- facturacion_globales: cada global, desde que se prepara hasta que se timbra.
-- `solicitud` la manda el panel al abrir la pantalla: un doble clic o un
-- reintento con la misma solicitud no prepara otra global.
-- Estados: preparada → timbrando → timbrada · por_conciliar (no llegó la
-- respuesta) · error (Facturapi la rechazó; sus tickets quedan libres).
CREATE TABLE IF NOT EXISTS facturacion_globales (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  solicitud     text NOT NULL CHECK (length(solicitud) BETWEEN 8 AND 64),
  periodicidad  text NOT NULL DEFAULT 'month'
                CHECK (periodicidad IN ('day','week','fortnight','month','two_months')),
  desde         date NOT NULL,
  hasta         date NOT NULL,
  mes           text NOT NULL CHECK (mes ~ '^[0-9]{2}$'),
  anio          integer NOT NULL CHECK (anio BETWEEN 2020 AND 2100),
  forma_pago    text NOT NULL CHECK (forma_pago ~ '^[0-9]{2}$' AND forma_pago <> '99'),
  estado        text NOT NULL DEFAULT 'preparada'
                CHECK (estado IN ('preparada','timbrando','timbrada','por_conciliar','error')),
  tickets       integer NOT NULL CHECK (tickets > 0),
  total         numeric(12,2) NOT NULL CHECK (total > 0),
  factura_id    text,
  uuid          text,
  serie         text,
  folio_numero  integer,
  error_codigo  text,
  error_detalle text,
  usuario_id    text,
  rol           text,
  timbrando_at  timestamptz,
  timbrada_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta >= desde),
  UNIQUE (negocio_id, solicitud, forma_pago)
);
CREATE INDEX IF NOT EXISTS idx_facturacion_globales_negocio
  ON facturacion_globales (negocio_id, created_at DESC);

-- Los tickets de cada global. Un ticket está en una sola global viva: si
-- Facturapi rechaza la global, sus tickets se liberan (vivo = false) y pueden
-- entrar en otra.
CREATE TABLE IF NOT EXISTS facturacion_global_recibos (
  global_id   uuid NOT NULL REFERENCES facturacion_globales(id) ON DELETE CASCADE,
  negocio_id  uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  folio       text NOT NULL,
  recibo_id   text NOT NULL,
  total       numeric(12,2) NOT NULL CHECK (total > 0),
  vivo        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (global_id, folio)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_facturacion_global_recibo_vivo
  ON facturacion_global_recibos (negocio_id, upper(folio)) WHERE vivo;

-- Forma de pago SAT con la que se creó cada recibo: la global se arma por
-- forma de pago. Los recibos anteriores la tienen vacía y se leen con la regla
-- con la que se crearon.
ALTER TABLE facturacion_recibos ADD COLUMN IF NOT EXISTS forma_pago text;

-- Decisiones del negocio sobre la forma de pago de sus recibos (las toma con
-- su contador). Por omisión, lo de siempre: tarjeta 28, y Rappi y los pagos
-- mixtos «por definir» (99), que no pueden entrar en una global.
-- global_incluir_rappi: los pedidos de Rappi los factura la sucursal (Mario,
-- 23-oct), así que entran marcados.
ALTER TABLE facturacion_configuracion
  ADD COLUMN IF NOT EXISTS global_incluir_rappi boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS forma_tarjeta text NOT NULL DEFAULT '28',
  ADD COLUMN IF NOT EXISTS forma_mixto text NOT NULL DEFAULT 'por_definir',
  ADD COLUMN IF NOT EXISTS forma_rappi text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_facturacion_formas_pago') THEN
    ALTER TABLE facturacion_configuracion ADD CONSTRAINT chk_facturacion_formas_pago CHECK (
      forma_tarjeta IN ('28','04')
      AND forma_mixto IN ('por_definir','mayor')
      AND (forma_rappi IS NULL OR forma_rappi IN ('03','31')));
  END IF;
END $$;
