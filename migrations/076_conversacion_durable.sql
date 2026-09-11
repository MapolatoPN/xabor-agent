-- ─── 076: el pedido conversacional deja de vivir solo en memoria ───────────
-- Idempotente y re-ejecutable.
--
-- EL DEFECTO
--
-- `src/agent/session.js` guarda las sesiones en un `Map` del proceso. Ahí vive
-- TODO lo que el cliente y el bot han acordado antes de registrar el pedido:
-- el carrito, la modalidad, la dirección, la forma de pago, qué dato se está
-- esperando y el preview confirmable.
--
-- Un reinicio lo borra. Y los reinicios no son raros: cada despliegue es uno.
-- El 2026-09-11, desplegando tres correcciones del asistente, se reiniciaron
-- los procesos con conversaciones en curso. Nadie se entera: el cliente
-- escribe "sí, confirmo" y el bot ya no sabe de qué.
--
-- Tampoco sobrevive a que Railway mueva el contenedor, ni serviría con dos
-- réplicas: cada una tendría su propio Map y el mismo cliente vería dos
-- carritos distintos según a cuál cayera.
--
-- LO QUE ESTA TABLA GUARDA, Y LO QUE NO
--
-- Guarda el estado CONVERSACIONAL: lo que se está armando. No guarda pedidos
-- registrados -- esos ya viven en `pedidos_activos` con su folio, su emisión
-- durable y su idempotencia, y ese mecanismo no se toca. Confundir las dos
-- cosas crearía una segunda ruta hacia la cocina, que es justo lo que la 063
-- existe para impedir.
--
-- POR QUÉ UNA SOLA FILA POR CONVERSACIÓN
--
-- El estado se reemplaza entero en cada turno: es una foto, no un diario. Un
-- historial de versiones invitaría a reconstruir el carrito sumando eventos, y
-- entonces habría dos verdades sobre el mismo pedido. La identidad es
-- (negocio, conversación) -- la misma clave de sesión que ya usa el canal, que
-- incluye el negocio para que el mismo número en dos sucursales no comparta
-- contexto.
--
-- `revision` no es un historial: es un contador para detectar que alguien más
-- escribió mientras nosotros pensábamos. Hoy la cola serializa los turnos de
-- una misma conversación dentro del proceso, así que no debería pasar; cuando
-- haya dos réplicas, sí. Se prefiere saberlo a suponerlo.

CREATE TABLE IF NOT EXISTS conversacion_estado (
  negocio_id     uuid        NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  session_id     text        NOT NULL,
  estado         jsonb       NOT NULL,
  revision       bigint      NOT NULL DEFAULT 1,
  creado_at      timestamptz NOT NULL DEFAULT NOW(),
  actualizado_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (negocio_id, session_id)
);

-- El barrido de conversaciones viejas necesita ordenar por fecha sin recorrer
-- la tabla entera. Una conversación abandonada no se borra sola: se limpia
-- cuando alguien decide cuánto tiempo es "vieja", que es una decisión del
-- negocio y no de esta migración.
CREATE INDEX IF NOT EXISTS idx_conversacion_estado_actualizado
  ON conversacion_estado (actualizado_at);

-- Aislamiento por negocio, como todo lo demás: el estado de otro tenant
-- simplemente no existe desde una consulta que filtre por negocio_id, y la
-- clave primaria lo obliga.
COMMENT ON TABLE conversacion_estado IS
  'Estado conversacional en curso (carrito, datos pendientes, preview) por negocio y conversación. NO sustituye a pedidos_activos: eso es el pedido ya registrado.';
