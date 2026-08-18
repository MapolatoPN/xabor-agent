-- ─── 058: qué pedidos fueron COMPRAS REALES ─────────────────────────────────
-- Idempotente y re-ejecutable.
--
-- POR QUÉ NO SE EXTIENDE `pedidos`
--
-- `pedidos` es el archivo histórico, y su propio código lo llama "espejo
-- best-effort": la fuente de verdad es `pedidos_activos`. Además NO tiene
-- UNIQUE sobre (negocio_id, folio) -- su `ON CONFLICT DO NOTHING` ni siquiera
-- lleva target --, así que puede haber varias filas del mismo folio y no hay
-- forma de escribir una marca idempotente sin carreras. Colgar de ahí una
-- señal que decide quién recibe una promoción sería construir sobre arena.
--
-- QUÉ RESUELVE ESTA TABLA
--
-- "Primera compra" tiene que sobrevivir al archivado, a la purga del tablero y
-- al reinicio. Hoy `clienteYaComproDeVerdad` mira `pedidos` menos lo que
-- `pedidos_activos` desmiente -- y en cuanto el pedido cancelado por falta de
-- pago se purga del tablero, su fila histórica vuelve a parecer una compra.
--
-- TRES COSAS DISTINTAS, y esta tabla registra solo la tercera:
--
--   1. pedido creado          -> `pedidos` / `pedidos_activos`
--   2. dinero recibido        -> `pagos`
--   3. COMPRA REAL RECONOCIDA -> aquí
--
-- Dinero no es compra. Un pago tardío sobre un pedido vencido se asienta (es
-- real) pero Xabor no lo cocina: no es una compra. Lo mismo un cobro de una
-- versión vieja, o el segundo cobro de un doble cobro.
--
-- POR QUÉ LA CLAVE NO ES (negocio_id, folio)
--
-- EL FOLIO SE RECICLA. `obtenerMaxFolioNum()` calcula el siguiente folio a
-- partir del máximo de `pedidos_activos` ÚNICAMENTE -- no de `pedidos`. En
-- cuanto el tablero se purga y el proceso reinicia, el contador retrocede y
-- `XAB-0042` vuelve a emitirse para un pedido distinto, de otro cliente.
--
-- Con la clave puesta solo en (negocio_id, folio), el `ON CONFLICT DO NOTHING`
-- de la segunda compra chocaba contra la fila del cliente ANTERIOR: la compra
-- nueva no se registraba y ese cliente conservaba su promoción de primera
-- compra. El error caía del lado caro -- regalar dinero, sin vuelta atrás.
--
-- Así que la identidad incluye `pedido_creado_at`: el mismo pedido siempre trae
-- el mismo instante (idempotencia intacta, el doble cobro sigue sin contar dos
-- veces), y dos pedidos que comparten folio en épocas distintas ya no se pisan.

CREATE TABLE IF NOT EXISTS compras_reales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  folio             text NOT NULL,
  -- Instante de creación del pedido: lo que hace única a la identidad cuando
  -- el folio se recicla. Ver la nota de arriba.
  pedido_creado_at  timestamptz NOT NULL,
  cliente_telefono  text,
  origen            text NOT NULL,
  confirmada_at     timestamptz NOT NULL DEFAULT NOW(),
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE compras_reales ADD CONSTRAINT chk_compra_origen
    CHECK (origen IN (
      'pago_online',          -- dinero verificado + versión vigente + derivación autorizada
      'operacion',            -- efectivo / terminal / pago al recibir: entró a cocina
      'transferencia',        -- confirmada a mano y derivada por el camino común
      'legacy_desconocido'    -- histórico anterior a esta tabla, ver backfill
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UNA marca por pedido. Sin esto, dos caminos de settlement (o un doble cobro)
-- dejarían dos filas y cualquier conteo de compras mentiría. El tercer campo es
-- lo que impide que un folio reciclado haga pasar dos pedidos por uno solo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_compra_real_pedido
  ON compras_reales (negocio_id, folio, pedido_creado_at);

-- La consulta caliente: ¿este cliente de ESTE negocio ya compró alguna vez?
-- Tenant-scoped siempre: el mismo teléfono en otro negocio es otro cliente.
CREATE INDEX IF NOT EXISTS idx_compra_real_cliente
  ON compras_reales (negocio_id, cliente_telefono)
  WHERE cliente_telefono IS NOT NULL;

-- ─── BACKFILL: política conservadora y explícita ─────────────────────────────
--
-- El riesgo asimétrico manda. Marcar de menos = regalar una promoción de
-- primera compra a un cliente antiguo, dinero perdido y sin vuelta atrás.
-- Marcar de más = un cliente pierde un descuento al que quizá tenía derecho,
-- reversible a mano por el negocio.
--
-- Así que todo el histórico de `pedidos` entra como compra, con origen
-- `legacy_desconocido` -- la ambigüedad queda ETIQUETADA, no escondida --
-- EXCEPTO lo que podemos demostrar que no fue compra:
--
--   · el pedido sigue en el tablero esperando pago (`pendiente_pago`);
--   · el pedido se canceló por no pagarse (`expirado_por_pago`).
--
-- PERO SOLO CUANDO LA CORRESPONDENCIA ES INEQUÍVOCA.
--
-- (negocio_id, folio) NO identifica una instancia de pedido: el folio se
-- recicla. Medido en la base local: `pedidos` tiene 337 folios repetidos
-- (1259 filas), y `pedidos.created_at` frente a `pedidos_activos.created_at`
-- del mismo folio no coincide NUNCA -- 0 de 6 pares, con un delta medio de
-- ~234 305 s (unas 65 horas), porque son INSERT separados, cada uno con su
-- propio DEFAULT NOW(). No hay ninguna otra columna común. Es decir: NO EXISTE
-- forma de demostrar qué fila histórica corresponde al activo de hoy cuando el
-- folio se reemitió, y no se va a inventar una.
--
-- Sin esta salvedad, el escenario real era: el cliente VIEJO compró con
-- XAB-0042 hace meses; se purgó el tablero, el contador retrocedió, y el
-- cliente NUEVO recibió también XAB-0042 y no pagó. El `NOT EXISTS` veía ese
-- pendiente ajeno y borraba retrospectivamente la compra del VIEJO, que volvía
-- a parecer primerizo. Error del lado caro.
--
-- REGLA, entonces. El único dato comparable entre las dos tablas es el
-- teléfono, y se usa SOLO PARA DESCARTAR correspondencia, nunca para
-- afirmarla: si el activo no-compra es de otro cliente, es seguro que NO es
-- este pedido histórico, y por tanto no puede desmentirlo. Se excluye una fila
-- histórica únicamente cuando se cumplen las tres:
--
--   (a) el folio tiene UNA sola fila histórica -- si tiene varias, el número ya
--       se reemitió y nada es atribuible;
--   (b) existe un activo con ese folio demostrablemente no-compra;
--   (c) ese activo es del MISMO teléfono. Si difiere, son clientes distintos:
--       el pendiente de uno no borra la compra del otro.
--
-- Todo lo demás es AMBIGUO LEGACY -> cuenta como `legacy_desconocido`.
--
-- QUÉ APORTA CADA CONDICIÓN, para que ninguna quede de adorno:
--
--   (a) protege al cliente que compró VARIAS veces con el mismo número y hoy
--       tiene un pendiente: con varias historias nada es atribuible, así que no
--       se le borra ninguna compra;
--   (c) protege al cliente que compró una vez y cuyo folio se reemitió para
--       OTRA persona que no pagó.
--
-- LÍMITE CONOCIDO Y ACEPTADO: queda fuera el caso en que el mismo cliente tiene
-- UNA sola compra histórica con ese folio y hoy un pendiente suyo con el mismo
-- número. Ahí (a) y (c) se cumplen y la compra se excluye. Cae del lado caro,
-- pero cerrarlo exigiría una correspondencia que los datos no soportan --
-- `pedidos` y `pedidos_activos` no comparten más clave que el folio, y sus
-- `created_at` difieren en horas para la misma instancia. Se declara en vez de
-- fabricarla.
--
-- A partir de esta migración ya no hace falta correlacionar nada: la marca se
-- escribe en el momento en que la compra ocurre.
--
-- El DISTINCT ON incluye `created_at`: si un folio se reemitió, cada emisión
-- fue un pedido distinto y cada una entra por separado.
INSERT INTO compras_reales (negocio_id, folio, pedido_creado_at, cliente_telefono, origen, confirmada_at)
SELECT DISTINCT ON (p.negocio_id, p.folio, p.created_at)
       p.negocio_id, p.folio, p.created_at, p.telefono, 'legacy_desconocido', p.created_at
  FROM pedidos p
 WHERE p.folio IS NOT NULL
   AND p.created_at IS NOT NULL
   -- Se excluye solo lo demostrable. La condicion de unicidad es lo que
   -- impide que un pedido reciclado y sin pagar borre la compra de otro
   -- cliente que si compro con ese mismo numero.
   AND NOT (
     -- (a) el folio no se reemitio dentro del propio historico
     (SELECT COUNT(*) FROM pedidos p2
       WHERE p2.negocio_id = p.negocio_id AND p2.folio = p.folio) = 1
     -- (b) hay un activo con ese folio demostrablemente no-compra
     -- (c) y es del MISMO cliente: si el telefono difiere, ese pendiente es de
     --     otra persona y no puede desmentir esta compra.
     AND EXISTS (
       SELECT 1 FROM pedidos_activos a
        WHERE a.negocio_id = p.negocio_id AND a.folio = p.folio
          AND (a.estado = 'pendiente_pago'
               OR (a.estado = 'cancelado'
                   AND (a.datos->>'expirado_por_pago')::boolean IS TRUE))
          AND p.telefono IS NOT NULL
          AND a.datos->'cliente'->>'telefono' = p.telefono
     )
   )
 ORDER BY p.negocio_id, p.folio, p.created_at ASC
ON CONFLICT (negocio_id, folio, pedido_creado_at) DO NOTHING;
