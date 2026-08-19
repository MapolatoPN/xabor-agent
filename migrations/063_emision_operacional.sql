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
  saldada_at        timestamptz,
  -- P0-11D/E: rastro durable de la resolución manual de un legacy ambiguo
  -- (resolverEmisionLegacyAmbigua, la ÚNICA salida de 'requiere_revision').
  -- Los tres son NULL para cualquier fila que nunca fue ambigua.
  --
  --   resuelto_nota     -- por qué el operador decidió lo que decidió.
  --                        OBLIGATORIA (la exige la función, nunca NULL en
  --                        una fila resuelta).
  --   resuelto_decision -- P0-11E: QUÉ decidió. Sin esta columna, después
  --                        de que una 'requiere_reimpresion' se recupere y
  --                        termine 'saldada', la DB ya no podría distinguir
  --                        durablemente "el humano confirmó que ya había
  --                        salido" de "el humano ordenó reimprimir y el
  --                        recovery terminó después" -- ambas acaban con
  --                        estado='saldada' y origen='legacy_revisado_manual'.
  --   resuelto_at       -- cuándo se tomó la decisión (updated_at se sigue
  --                        moviendo con el recovery; este no).
  resuelto_nota     text,
  resuelto_decision text,
  resuelto_at       timestamptz
);
ALTER TABLE pedido_emisiones ADD COLUMN IF NOT EXISTS resuelto_nota text;
ALTER TABLE pedido_emisiones ADD COLUMN IF NOT EXISTS resuelto_decision text;
ALTER TABLE pedido_emisiones ADD COLUMN IF NOT EXISTS resuelto_at timestamptz;
ALTER TABLE pedido_emisiones DROP CONSTRAINT IF EXISTS chk_pedido_emision_resuelto_decision;
ALTER TABLE pedido_emisiones ADD CONSTRAINT chk_pedido_emision_resuelto_decision
  CHECK (resuelto_decision IS NULL
         OR resuelto_decision IN ('confirmado_emitido', 'requiere_reimpresion'));

-- P0-11D (auditoría independiente): agrega 'requiere_revision' -- ver el
-- backfill más abajo. NO es lo mismo que 'pendiente': 'pendiente' es
-- EJECUTABLE (el reconciliador la procesa sola); 'requiere_revision' está
-- deliberadamente FUERA del alcance del reconciliador (que solo lee
-- `estado = 'pendiente'`, ver `pedidosConEmisionOperacionalPendiente` en
-- database.js) hasta que un humano la resuelva explícitamente con
-- `resolverEmisionLegacyAmbigua`.
ALTER TABLE pedido_emisiones DROP CONSTRAINT IF EXISTS chk_pedido_emision_estado;
ALTER TABLE pedido_emisiones ADD CONSTRAINT chk_pedido_emision_estado
  CHECK (estado IN ('pendiente', 'saldada', 'cancelada', 'requiere_revision'));

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
--   3. `NEW.estado` fuera de la allow-list -- ver abajo. `ON CONFLICT DO
--      NOTHING` hace inofensivo reintentar el INSERT en cada transicion
--      dentro de la allow-list (nuevo -> en_preparacion -> listo), asi que
--      no hace falta ninguna otra guarda de "ya se aseguro antes".
--
-- P0-11A (auditoria independiente, corregido tras el checkpoint): la
-- version anterior de este trigger creaba deuda en CUALQUIER UPDATE cuyo
-- OLD.estado fuera 'pendiente_pago', sin mirar a donde iba NEW.estado. Eso
-- incluia `pendiente_pago -> cancelado` (expiracion de pago) -- reproducido
-- en rojo con `cancelarPedidoActivo` real: la fila quedaba 'cancelado' en
-- `pedidos_activos` pero con una deuda 'pendiente' en `pedido_emisiones`,
-- lista para que el reconciliador la cocinara sola.
--
-- LA CORRECCION: allow-list EXPLICITA de los unicos estados que autorizan
-- la primera emision -- `nuevo`, `en_preparacion`, `listo` -- nunca una
-- blacklist de los que la prohiben. Auditado contra los tres origenes
-- reales de esta deuda:
--   · `registrarPedido()` fija `estadoInicial = 'nuevo'` salvo anticipo/pago
--     en linea (que arrancan en 'pendiente_pago', ya excluido aparte).
--   · El scheduler de programados (`activarPedidosProgramados`, server.js)
--     hace `pedido.estado = pedido.estado || 'nuevo'`.
--   · La transicion autorizada por pago (`confirmarPedidoPendientePago`)
--     mueve `pendiente_pago -> 'nuevo'` explicitamente.
-- Los tres SIEMPRE aterrizan en 'nuevo'. `en_preparacion`/`listo` se
-- incluyen a proposito para no bloquear una primera emision legitima que
-- llegue tarde (recovery) cuando el personal ya avanzo el pedido en el
-- panel mientras la comanda seguia sin salir -- `actualizarEstadoPedido`
-- no depende de que la emision ya haya terminado. `entregado` y `cancelado`
-- quedan fuera a proposito: emitir una comanda para un pedido ya
-- entregado o cancelado no tiene sentido en ningun caso.
CREATE OR REPLACE FUNCTION xabor_asegurar_emision_operacional()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.estado NOT IN ('nuevo', 'en_preparacion', 'listo') THEN
    RETURN NEW;
  END IF;

  IF NEW.datos->>'programado_para' IS NOT NULL AND NEW.datos->>'programado_id' IS NULL THEN
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
-- comandas viejas -- exactamente lo que NO se quiere.
--
-- P0-11C (primera corrección, auditoría independiente): la versión
-- original marcaba TODO pedido preexistente 'saldada'/`legacy_asumida_
-- emitida`, sin distinción. Reproducido en rojo con un binario OLD
-- (0f9e82b) real: OLD acepta el pedido P (INSERT durable,
-- `estado='nuevo'`), y milisegundos después -- SIN que el `emitirPedido`
-- fire-and-forget de OLD haya tenido tiempo de terminar -- esta migración
-- corre EN CALIENTE (Railway aplica predeploy mientras el binario viejo
-- sigue vivo, ver P0-15/059). El backfill original marcaba a P 'saldada'
-- igual que un pedido de hace tres años -- EMISIÓN SILENCIOSAMENTE
-- PERDIDA si OLD moría ahí. El primer intento de corrección usó el
-- PROGRESO DE ESTADO como prueba: `en_preparacion`/`listo`/terminal
-- ⇒ "alguien ya actuó, la comanda ya salió, `saldada` es seguro".
--
-- P0-11D (segunda auditoría independiente, corrige la premisa de la
-- primera corrección): esa premisa es FALSA. El propio P0-11A (arriba)
-- explica por qué la allow-list operacional incluye `en_preparacion` y
-- `listo`, no solo `nuevo`: el personal puede avanzar el estado de un
-- pedido en el panel MIENTRAS su emisión todavía necesita recovery --
-- `actualizarEstadoPedido` no depende de que `emitirPedido` haya
-- terminado. Y el orden real de `emitirPedido` (orderManager.js) es
-- Edge -> BROADCAST AL PANEL (`nuevo_pedido`) -> impresión legacy (solo si
-- Edge no se hizo cargo) -- el panel se entera ANTES de que el papel
-- exista. Reproducido en rojo con el binario OLD real, instrumentado
-- SOLO en la prueba (`XABOR_TEST_PAUSAR_ANTES_DE_PRINT_LEGACY`, doble
-- candado NODE_ENV+env explícita, ver test/fixtures/p011-old-harness.patch):
-- se observa el `nuevo_pedido` REAL por WebSocket, se congela el flujo de
-- OLD ahí mismo (antes de que la impresión legacy arranque), se avanza P
-- a `en_preparacion` por la ruta productiva real
-- (`PATCH /pedidos/:id/estado`), se aplica esta migración, y CON LA
-- PRIMERA CORRECCIÓN el backfill marcaba a P 'saldada' -- exactamente la
-- misma emisión perdida que P0-11C, solo que ahora escondida detrás de un
-- avance de estado que NO prueba nada sobre la impresión.
--
-- LA CORRECCIÓN (P0-11D): ningún estado NO TERMINAL demuestra por sí
-- mismo que la emisión core terminó -- ni `nuevo`, ni `en_preparacion`,
-- ni `listo`. Solo los estados TERMINALES (`entregado`, `cancelado`)
-- excluyen al pedido del recovery, y no porque prueben que ya se imprimió,
-- sino porque YA NO DEBEN COCINARSE AHORA sin importar si hubo papel
-- antes -- reemitir la comanda de un pedido cancelado o ya entregado no
-- tiene sentido en ningún caso (rama A, sin cambios de fondo respecto a
-- la primera corrección para estos dos estados).
--
-- Para los tres estados NO terminales (`nuevo`, `en_preparacion`,
-- `listo`) tampoco se repite el error de la primera corrección de P0-11C
-- (asumir 'pendiente' EJECUTABLE para todos): eso reimprimiría en
-- automático historiales genuinamente viejos que sí se cocinaron hace
-- meses, con el mismo riesgo de sobre-impresión que este backfill existe
-- para evitar. La única frontera fail-closed demostrable es: legacy no
-- terminal SIN evidencia inequívoca de emisión ⇒ NUNCA se asume nada,
-- NUNCA se auto-ejecuta -- queda 'requiere_revision' (rama B), un estado
-- que el reconciliador de NEW ignora por diseño (solo procesa
-- `estado = 'pendiente'`) hasta que un humano lo resuelva explícitamente
-- con `resolverEmisionLegacyAmbigua` (database.js) -- ver
-- scripts/predeploy-063-emision-operacional.mjs, que aborta el deploy
-- mientras existan filas 'requiere_revision' sin resolver.
INSERT INTO pedido_emisiones (negocio_id, folio, pedido_creado_at, estado, origen, saldada_at)
SELECT negocio_id, folio, date_trunc('milliseconds', created_at), 'saldada', 'legacy_asumida_emitida', NOW()
  FROM pedidos_activos
 WHERE negocio_id IS NOT NULL
   AND estado IN ('entregado', 'cancelado')
   AND NOT (datos->>'programado_para' IS NOT NULL AND datos->>'programado_id' IS NULL)
ON CONFLICT (negocio_id, folio, pedido_creado_at) DO NOTHING;

INSERT INTO pedido_emisiones (negocio_id, folio, pedido_creado_at, estado, origen)
SELECT negocio_id, folio, date_trunc('milliseconds', created_at), 'requiere_revision', 'legacy_ambiguo_no_verificado'
  FROM pedidos_activos
 WHERE negocio_id IS NOT NULL
   AND estado IN ('nuevo', 'en_preparacion', 'listo')
   AND NOT (datos->>'programado_para' IS NOT NULL AND datos->>'programado_id' IS NULL)
ON CONFLICT (negocio_id, folio, pedido_creado_at) DO NOTHING;
