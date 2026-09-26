-- 097 · Formas de cobro configurables del mostrador (POS y Mesas).
--
-- Es la lista PROPIA del mostrador. El bot sigue leyendo metodos_pago (025)
-- y la tienda en línea su configuracion.tienda_metodos_pago: ninguno de los
-- dos lee esta tabla, así que nada de lo que se dé de alta aquí se le ofrece
-- a un cliente por WhatsApp (decisión de Mario, 25-sep-2026).
--
-- Solo guarda las formas CONFIGURABLES. Las fijas -- efectivo, terminal,
-- mixto y enlace de pago -- viven en código porque cada una hace algo más
-- que poner una etiqueta (cambio y arqueo, reparto del mixto, conciliación
-- con Clip) y ninguna de sus reglas cabe en un renglón.
--
--   clave         lo que se guarda en datos.forma_pago; nunca cambia. No
--                 puede contener 'efectivo' ni repetir una fija: varias partes
--                 del sistema reconocen el efectivo por el texto.
--   tarjeta_caja  dónde suma en la Caja. Nunca 'efectivo': el arqueo solo
--                 cuenta la forma fija Efectivo.
--   clave_sat     c_FormaPago para la autofactura (opcional).
--
-- Una forma no se borra: se desactiva, y sus ventas conservan su nombre y
-- su tarjeta de Caja.
--
-- Esta migración NO toca el CHECK de restaurante_cuenta_pagos.metodo: Mesas
-- sigue validando contra metodos_pago hasta la Fase 3, y el CHECK se afloja
-- junto con esa validación, no antes.

CREATE TABLE IF NOT EXISTS formas_cobro (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  clave         text NOT NULL CONSTRAINT formas_cobro_clave_check CHECK (
                  clave ~ '^[a-z0-9_]{2,40}$'
                  AND position('efectivo' IN clave) = 0
                  AND clave NOT IN ('mixto', 'terminal', 'tarjeta', 'enlace_pago', 'por_cobrar', 'pendiente', 'sin_pago')),
  nombre        text NOT NULL CONSTRAINT formas_cobro_nombre_check CHECK (
                  char_length(btrim(nombre)) BETWEEN 1 AND 24
                  AND position('efectivo' IN lower(nombre)) = 0),
  tarjeta_caja  text NOT NULL CONSTRAINT formas_cobro_tarjeta_check CHECK (
                  tarjeta_caja IN ('tarjeta', 'enlace', 'plataformas', 'otros')),
  clave_sat     text NULL CONSTRAINT formas_cobro_sat_check CHECK (clave_sat IN ('03', '04', '28')),
  en_pos        boolean NOT NULL DEFAULT true,
  en_mesas      boolean NOT NULL DEFAULT false,
  activo        boolean NOT NULL DEFAULT true,
  orden         integer NOT NULL DEFAULT 0,
  creado_por    uuid NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_formas_cobro_clave UNIQUE (negocio_id, clave)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_formas_cobro_nombre
  ON formas_cobro (negocio_id, lower(btrim(nombre)));
CREATE INDEX IF NOT EXISTS idx_formas_cobro_negocio
  ON formas_cobro (negocio_id, activo, orden);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_formas_cobro') THEN
    CREATE TRIGGER set_updated_at_formas_cobro
      BEFORE UPDATE ON formas_cobro
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Siembra: lo que el mostrador ya ofrece hoy fuera de las fijas, para que
-- el primer día con la tabla la Caja dé exactamente los mismos números.
--   Rappi          ya es botón del POS (2ed2faf) y la Caja lo separa en
--                  Plataformas.
--   Transferencia  ya está en Recoger/Domicilio y en Mesas; la Caja la suma
--                  en Otros. En Mesas solo si hoy el negocio la tiene
--                  habilitada en metodos_pago (así se cobra hoy una mesa).
--   Uber Eats y DiDi Food, inactivas: activarlas es un clic.
-- Solo siembra negocios SIN ningún renglón: el predeploy corre en cada
-- despliegue y un negocio que ya tiene su lista nunca se toca. La misma
-- lista vive en FORMAS_COBRO_INICIALES (src/services/formasCobro.js), que es
-- la que usa un negocio creado entre dos despliegues, todavía sin renglones.
INSERT INTO formas_cobro (negocio_id, clave, nombre, tarjeta_caja, clave_sat, en_pos, en_mesas, activo, orden)
SELECT n.id, v.clave, v.nombre, v.tarjeta_caja, v.clave_sat, v.en_pos,
       CASE WHEN v.clave = 'transferencia'
            THEN EXISTS (SELECT 1 FROM metodos_pago mp
                          WHERE mp.negocio_id = n.id AND mp.tipo = 'transferencia' AND mp.habilitado)
            ELSE v.en_mesas END,
       v.activo, v.orden
  FROM negocios n
 CROSS JOIN (VALUES
   ('rappi',         'Rappi',         'plataformas', NULL::text, true, false, true,  10),
   ('transferencia', 'Transferencia', 'otros',       '03',       true, false, true,  20),
   ('uber_eats',     'Uber Eats',     'plataformas', NULL::text, true, false, false, 30),
   ('didi_food',     'DiDi Food',     'plataformas', NULL::text, true, false, false, 40)
 ) AS v(clave, nombre, tarjeta_caja, clave_sat, en_pos, en_mesas, activo, orden)
 WHERE NOT EXISTS (SELECT 1 FROM formas_cobro f WHERE f.negocio_id = n.id)
ON CONFLICT DO NOTHING;
