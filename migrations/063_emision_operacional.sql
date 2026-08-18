-- ─── 063: deuda durable de emisión OPERACIONAL (P0-11) ──────────────────────
-- Idempotente y re-ejecutable.
--
-- EL DEFECTO
--
-- `registrarPedido()` hace INSERT en `pedidos_activos` (durable) y devuelve el
-- pedido. El caller dispara `emitirPedido(pedido).catch(log)` -- fire and
-- forget. Si Node muere entre el INSERT y el fin de `emitirPedido` (o antes de
-- que arranque siquiera), el pedido EXISTE durablemente pero no existe ninguna
-- obligación durable que diga "todavía falta emitir esto a cocina". Un
-- `console.error` no es una cola: nadie vuelve a intentarlo.
--
-- Para pagos en línea sí existe esa infraestructura (`emision_pendiente` como
-- bandera en `pedidos_activos.datos`, `conEmisionExclusiva`,
-- `pedidosConEmisionPendiente`). Para efectivo/terminal/por cobrar/Rappi/
-- presencial -- la mayoría de los pedidos -- no existía equivalente.
--
-- POR QUÉ TABLA PROPIA Y NO REUTILIZAR `emision_pendiente`
--
-- Esa bandera representa PAGO RECIBIDO autorizando una transición concreta
-- (pendiente_pago -> nuevo). La deuda nueva representa EMISIÓN OPERACIONAL:
-- nace con CUALQUIER pedido que debe llegar a cocina, pagado en línea o no.
-- Son conceptos distintos -- mezclarlos en la misma bandera habría hecho que
-- limpiar una limpiara la otra por accidente. Además esta necesita estado
-- observable (intentos, último error, cuándo se saldó) que una bandera
-- booleana no puede llevar cómodamente.
--
-- IDENTIDAD: igual razón que `compras_reales` (058) -- EL FOLIO SE RECICLA.
-- (negocio_id, folio, pedido_creado_at) es la única identidad estable de un
-- pedido concreto, no del número que le tocó.
--
-- POR QUÉ UN TRIGGER Y NO SOLO CÓDIGO NUEVO
--
-- Lección de P0-15: durante el cutover, el binario VIEJO puede seguir vivo, y
-- vive registrando pedidos con su propio `registrarPedido()` -- no sabe que
-- esta tabla existe. Si la deuda naciera solo desde una llamada nueva en
-- Node, un pedido creado por OLD durante el overlap quedaría SIN deuda,
-- exactamente el defecto que esto corrige. Un trigger AFTER INSERT/UPDATE
-- sobre `pedidos_activos` protege a los dos binarios por igual, porque los
-- dos pasan por el MISMO INSERT (`guardarPedidoActivo`).
--
-- OJO CON EL TIPO DE `pedido_creado_at`: tiene que ser `timestamp` A SECAS,
-- NUNCA `timestamptz`. `pedidos_activos.created_at` es `timestamp without
-- time zone` (columna heredada). El trigger de abajo copia `NEW.created_at`
-- SIN transformarlo -- si esta columna fuera `timestamptz`, Postgres haria
-- un cast implicito `timestamp -> timestamptz` DENTRO del trigger usando el
-- timezone de la SESION, que en este entorno no coincide con como el driver
-- de Node interpreta esa misma columna al leerla desde JS
-- (`obtenerCreadoAtPedidoActivo`). Medido: el mismo instante se guardaba
-- desplazado 5 horas, y la identidad (negocio, folio, pedido_creado_at) que
-- arma `conEmisionOperacionalExclusiva` dejaba de coincidir con la fila del
-- trigger -- toda deuda parecia "sin_deuda" y ningun pedido se emitia
-- nunca. Con el mismo tipo exacto en ambos lados no hay cast, no hay
-- ambiguedad de timezone, y el valor viaja identico.
CREATE TABLE IF NOT EXISTS pedido_emisiones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  folio             text NOT NULL,
  pedido_creado_at  timestamp NOT NULL,
  estado            text NOT NULL DEFAULT 'pendiente',
  intentos          int NOT NULL DEFAULT 0,
  ultimo_error      text,
  origen            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  saldada_at        timestamptz
);

DO $$ BEGIN
  ALTER TABLE pedido_emisiones ADD CONSTRAINT chk_pedido_emision_estado
    CHECK (estado IN ('pendiente', 'saldada', 'cancelada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UNA deuda por pedido concreto. El tercer campo es lo que impide que un
-- folio reciclado confunda dos pedidos distintos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_emision_pedido
  ON pedido_emisiones (negocio_id, folio, pedido_creado_at);

-- La consulta caliente del reconciliador: deudas pendientes, las más viejas
-- primero.
CREATE INDEX IF NOT EXISTS idx_pedido_emision_pendiente
  ON pedido_emisiones (updated_at) WHERE estado = 'pendiente';

-- ─── EL TRIGGER: asegura la deuda, nunca la ejecuta ─────────────────────────
--
-- Tres exclusiones deliberadas (auditadas, no adivinadas):
--
--   1. `pendiente_pago` -- el pedido no puede entrar a cocina todavía. La
--      deuda nace en la transición autorizada (pendiente_pago -> nuevo), que
--      SÍ es un UPDATE que este mismo trigger cubre (ver más abajo).
--
--   2. INSERT temporal de un PROGRAMADO antes de convertirse en reserva --
--      `registrarPedido()` para un programado inserta en `pedidos_activos`
--      con `datos.programado_para` ya presente, y el canal lo convierte a
--      reserva en la MISMA petición (062). Ese INSERT nunca debe generar
--      emisión operacional -- el pedido no ha llegado a su hora. La señal
--      auditada: `programado_para` presente Y `programado_id` AUSENTE. La
--      conversión (062, `xabor_activo_a_programado`) recién EMBEBE
--      `programado_id` en `datos` cuando la reserva ya quedó asegurada, así
--      que en el INSERT original todavía no puede existir.
--
--      Cuando el SCHEDULER reinserta el pedido al llegar su hora
--      (`activarPedidosProgramados`, server.js), `datos` viene de
--      `pedidos_programados.datos`, que YA incluye `programado_id` (se
--      embebió durante la conversión) -- ese INSERT SÍ debe generar deuda,
--      y la condición de arriba lo deja pasar porque `programado_id` ya no
--      está ausente.
--
--   3. UPDATE que no viene de `pendiente_pago` -- la deuda ya se aseguró en
--      el INSERT original (o en la transición anterior); no hay que
--      reintentarlo en cada cambio de estado de cocina (nuevo ->
--      en_preparacion -> listo...). `ON CONFLICT DO NOTHING` lo haría
--      inofensivo de todas formas, pero evita trabajo innecesario en el
--      camino más caliente de la aplicación.
CREATE OR REPLACE FUNCTION xabor_asegurar_emision_operacional()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.estado = 'pendiente_pago' THEN
    RETURN NEW;
  END IF;

  IF NEW.datos->>'programado_para' IS NOT NULL AND NEW.datos->>'programado_id' IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.estado IS DISTINCT FROM 'pendiente_pago') THEN
    RETURN NEW;
  END IF;

  -- Fail closed silencioso, mismo criterio que el resto del sistema: sin
  -- negocio no hay deuda que reclamar ni proceso al que avisar. No debería
  -- ocurrir hoy (guardarPedidoActivo exige negocioId), pero si ocurriera no
  -- hay identidad válida que registrar.
  IF NEW.negocio_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- date_trunc a milisegundos: Postgres guarda NOW()/created_at con
  -- precision de MICROsegundos, pero un Date de JS solo tiene milisegundos.
  -- `obtenerCreadoAtPedidoActivo` (database.js) siempre trunca al leer para
  -- convertir a Date -- si aqui se guardara la precision completa, la
  -- identidad NUNCA volveria a coincidir cuando `conEmisionOperacionalExclusiva`
  -- compare contra el valor que JS reconstruye. Medido: '...:20.630172'
  -- (columna) vs '...:20.63' (parametro JS) -- ninguna deuda se encontraba
  -- jamas, todo pedido quedaba en 'sin_deuda' silenciosamente.
  INSERT INTO pedido_emisiones (negocio_id, folio, pedido_creado_at, estado, origen)
  VALUES (NEW.negocio_id, NEW.folio, date_trunc('milliseconds', NEW.created_at), 'pendiente', 'trigger')
  ON CONFLICT (negocio_id, folio, pedido_creado_at) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asegurar_emision_operacional ON pedidos_activos;
CREATE TRIGGER trg_asegurar_emision_operacional
  AFTER INSERT OR UPDATE ON pedidos_activos
  FOR EACH ROW EXECUTE FUNCTION xabor_asegurar_emision_operacional();

-- ─── BACKFILL: política conservadora, igual asimetría que 058 ──────────────
--
-- Los pedidos activos que ya existían ANTES de esta migración son legacy
-- ambiguo: pudieron haberse impreso o no, nadie puede saberlo desde aquí.
-- Marcarlos 'pendiente' dispararía al reconciliador a reemitir/reimprimir
-- comandas viejas -- exactamente lo que NO se quiere. Se asumen EMITIDAS
-- (`legacy_asumida_emitida`), nunca 'pendiente'. Si alguna de verdad no salió,
-- es un caso operativo a resolver a mano, no algo que este backfill deba
-- adivinar y reintentar solo.
INSERT INTO pedido_emisiones (negocio_id, folio, pedido_creado_at, estado, origen, saldada_at)
SELECT negocio_id, folio, date_trunc('milliseconds', created_at), 'saldada', 'legacy_asumida_emitida', NOW()
  FROM pedidos_activos
 WHERE negocio_id IS NOT NULL
   AND estado IS DISTINCT FROM 'pendiente_pago'
   AND NOT (datos->>'programado_para' IS NOT NULL AND datos->>'programado_id' IS NULL)
ON CONFLICT (negocio_id, folio, pedido_creado_at) DO NOTHING;
