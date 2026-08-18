-- ─── 059: el folio XAB-#### deja de reciclarse ──────────────────────────────
-- Idempotente y re-ejecutable.
--
-- EL DEFECTO
--
-- El folio lo generaba un contador EN MEMORIA de Node, sembrado al arrancar con
-- `obtenerMaxFolioNum()`, que mira `pedidos_activos` Y NADA MÁS. En cuanto un
-- pedido se entrega y su fila se purga del tablero, ese número desaparece de la
-- única fuente que el contador consulta: al reiniciar, el contador retrocede y
-- XAB-0145 vuelve a emitirse para otro pedido, de otro cliente.
--
-- Medido en la base local en el momento de escribir esta migración:
--
--   MAX(pedidos_activos) = 9578      <- lo único que miraba el contador
--   MAX(pedidos)         = 10321     <- el máximo histórico real
--
-- Es decir: 743 folios ya entregados a clientes se habrían reemitido en el
-- siguiente reinicio. Y en `pedidos` hay 337 folios que YA aparecen repetidos
-- (1259 filas), o sea que esto no es una hipótesis: ya pasó.
--
-- POR QUÉ IMPORTA MÁS ALLÁ DE LOS PEDIDOS
--
-- Medio sistema trata el folio como identidad durable y ninguna de esas piezas
-- puede defenderse sola:
--
--   · `claveEventoPedido` = <tipo>:<negocioId>:<folio> — el dedupe del panel,
--     con registro en localStorage a 72 h. Un folio reciclado dentro de esa
--     ventana llega "ya visto" y sin tarjeta: el pedido NUEVO se clasifica como
--     duplicado despachado y no se ve;
--   · `impresion_trabajos.origen_id` — la idempotencia de Edge;
--   · `pagos.pedido_folio`, `tienda_pedidos.pedido_folio`,
--     `tienda_promocion_usos.pedido_folio`, `notificaciones_repartidor.pedido_folio`,
--     `rewards_movements.folio_venta`, `oportunidades.folio_pedido`,
--     `restaurante_cuentas.venta_folio`, `pedidos_programados.folio`,
--     `compras_reales.folio`.
--
-- Parchear cada consumidor sería multiplicar el trabajo y seguir dejando el
-- número visible ambiguo. Se arregla EN LA FUENTE.
--
-- LA SOLUCIÓN
--
-- Una SEQUENCE de PostgreSQL. Cumple lo que el contador en memoria no podía:
--
--   DURABLE .......... vive en la base, no en el proceso;
--   MONÓTONA ......... nextval() nunca retrocede;
--   ATÓMICA .......... sin locks de Node ni carreras entre requests;
--   MULTIINSTANCIA ... dos réplicas de Railway comparten la misma secuencia;
--   RESISTENTE A RESTART y A PURGA ... no depende de que ninguna fila exista.
--
-- Que `nextval()` NO sea transaccional es deseable aquí: un rollback quema el
-- número en vez de devolverlo. Saltarse un folio es inocuo; repetirlo no.
--
-- EL CUTOVER
--
-- La secuencia arranca por encima del máximo histórico de TODAS las tablas que
-- puedan conservar un folio de un pedido ya purgado, no solo del tablero. Si
-- mañana aparece otra tabla con folios, esta migración es re-ejecutable y vuelve
-- a subir el arranque: `setval` solo avanza, nunca retrocede.

CREATE SEQUENCE IF NOT EXISTS folio_pedido_seq AS bigint START WITH 1 NO CYCLE;

-- Arranque por encima del máximo histórico conocido. Se recalcula en cada
-- ejecución y solo sube: si la secuencia ya está más adelante que el histórico
-- --lo normal una vez en marcha-- no se toca.
DO $$
DECLARE
  maximo bigint := 0;
  actual bigint;
  candidato bigint;
BEGIN
  -- Cada fuente se lee dentro de su propio bloque: una tabla que no exista en
  -- este entorno no puede abortar el cálculo y dejar la secuencia baja.
  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM pedidos WHERE folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(pedido_folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM pagos WHERE pedido_folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM compras_reales WHERE folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(pedido_folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM tienda_pedidos WHERE pedido_folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(pedido_folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM tienda_promocion_usos WHERE pedido_folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(pedido_folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM notificaciones_repartidor WHERE pedido_folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(folio_venta FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM rewards_movements WHERE folio_venta ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(folio_pedido FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM oportunidades WHERE folio_pedido ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM pedidos_programados WHERE folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(venta_folio FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM restaurante_cuentas WHERE venta_folio ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- `origen_id` es TEXT y guarda ids de varios orígenes, no solo folios: el
  -- filtro por patrón es imprescindible o el CAST revienta con los demás.
  BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(origen_id FROM '^XAB-([0-9]+)$') AS bigint)), 0)
      INTO candidato FROM impresion_trabajos WHERE origen_id ~ '^XAB-[0-9]+$';
    maximo := GREATEST(maximo, candidato);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  SELECT last_value INTO actual FROM folio_pedido_seq;

  -- Solo avanza. Re-ejecutar la migración con la secuencia ya por delante no
  -- puede devolverla al pasado y volver a entregar folios vivos.
  IF maximo >= actual THEN
    PERFORM setval('folio_pedido_seq', maximo + 1, false);
    RAISE NOTICE '[059] folio_pedido_seq colocada en %, por encima del maximo historico %', maximo + 1, maximo;
  ELSE
    RAISE NOTICE '[059] folio_pedido_seq ya esta en % (maximo historico %): no se toca', actual, maximo;
  END IF;
END $$;
