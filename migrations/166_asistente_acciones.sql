-- 166: asistente del restaurante, Mejora 1 (28-nov-2026, plan aprobado por el
-- dueño): el botón de cada tarjeta de Reportes › Asistente.
--
-- El botón solo ABRE una pantalla que ya existe (Campañas, Menú, Historial…)
-- con sus datos puestos; ahí la persona decide y confirma. Esta tabla anota
-- que se usó: quién pulsó qué botón de qué aviso (paso 'abrio') y, si de ahí
-- salió una campaña de WhatsApp, cuál (paso 'creo_campana').
--
-- Aditiva: una tabla nueva y vacía. No toca ventas, cortes, facturas,
-- campañas ni avisos que ya existen. Reversa manual en 166_*_down.sql.

CREATE TABLE IF NOT EXISTS asistente_restaurante_acciones (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  hallazgo_id   bigint NOT NULL,
  usuario_id    uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  accion        text NOT NULL,
  paso          text NOT NULL,
  campana_id    integer,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (negocio_id, hallazgo_id) REFERENCES asistente_restaurante_hallazgos (negocio_id, id) ON DELETE CASCADE
);
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_acciones ADD CONSTRAINT asistente_restaurante_acciones_accion
    CHECK (accion ~ '^[a-z_]{3,40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_acciones ADD CONSTRAINT asistente_restaurante_acciones_paso
    CHECK (paso IN ('abrio', 'creo_campana'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Solo la campaña lleva número de campaña, y siempre lo lleva.
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_acciones ADD CONSTRAINT asistente_restaurante_acciones_campana
    CHECK ((paso = 'creo_campana') = (campana_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS asistente_restaurante_acciones_hallazgo
  ON asistente_restaurante_acciones (negocio_id, hallazgo_id, creado_en DESC);
