-- ─── 052: impresión legacy idempotente por printJobId ─────────────────────
-- Idempotente y re-ejecutable.
--
-- POR QUÉ EXISTE
-- El camino de impresión "legacy" (print-agent viejo conectado en la raíz "/")
-- es el único efecto de emitirPedido que NO deduplica nada: Edge tiene clave de
-- idempotencia por (negocio, pedido, impresora), la oferta a repartidores tiene
-- (folio, repartidor), pero legacy era un broadcast a ciegas. Cualquier
-- reintento que volviera a pasar por ahí sacaba papel otra vez.
--
-- Los agentes legacy que están instalados en los negocios no se pueden
-- actualizar desde aquí -- son binarios viejos en máquinas ajenas. Así que la
-- memoria de "este trabajo ya se emitió" tiene que vivir del lado del servidor,
-- en Postgres: sobrevive a reinicios del proceso, a redeploys y a varias
-- instancias del servidor a la vez. Un archivo en disco o un Map en memoria no
-- cumplirían ninguna de las tres.
--
-- QUÉ TOCA DE LO YA EXISTENTE: nada. Crea una tabla nueva y nada más.

CREATE TABLE IF NOT EXISTS impresion_legacy_emitida (
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- Determinista: '<folio>:comanda'. Nunca lleva terminal, sucursal ni fecha
  -- -- el mismo pedido tiene que producir el mismo id en cualquier proceso,
  -- que es justo lo que permite reconocerlo tras un reinicio.
  print_job_id  text NOT NULL,
  destinatarios integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (negocio_id, print_job_id)
);

-- Para la purga por antigüedad (fuera de esta migración) y para poder auditar
-- qué se emitió en una ventana de tiempo sin escanear la tabla entera.
CREATE INDEX IF NOT EXISTS idx_impresion_legacy_emitida_fecha
  ON impresion_legacy_emitida (negocio_id, created_at DESC);
