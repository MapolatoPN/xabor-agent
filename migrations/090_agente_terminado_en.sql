-- 090 · LA FECHA EN QUE CERRÓ UN CICLO DEL AGENTE
--
-- `cicloDelAgente.js` reabre una conversación terminada cuando ha pasado
-- bastante tiempo. Para eso necesita saber CUÁNDO cerró. Desde este despliegue
-- el ejecutor lo anota en `estado.terminadoEn` al poner el hecho terminal, y
-- esa fecha no se vuelve a tocar.
--
-- Las filas escritas antes no la traen, y el respaldo que usa el código para
-- ellas —la fecha del último guardado— no sirve: el estado se reescribe en
-- CADA turno, así que la conversación se rejuvenece sola cada vez que el
-- cliente habla. Se vio en producción: un pedido confirmado el 21 seguía
-- gobernando la conversación el 23, y la única salida era que el cliente
-- dijera una frase de una lista concreta. «Quiero unos hotcakes» no está en
-- esa lista.
--
-- La fecha real sí existe, en el libro de operaciones: ahí está el
-- `confirmar_pedido` o el `cancelar_pedido` que cerró el ciclo. `updated_at`
-- se fija al cerrar la operación, después de aplicar el efecto; `created_at`
-- solo marca cuándo se reservó. Esto copia la hora conservadora del cierre.
--
-- Solo toca filas que (a) son estados productivos del agente, (b) tienen un
-- ciclo identificado en el libro, (c) están en exactamente uno de los hechos
-- confirmado/cancelado, sin `fallido`, y (d) no tienen ya la fecha. Añade UNA
-- clave; no borra ni modifica nada más, y pasarla dos veces no cambia nada.
--
--
-- La identidad del libro es (negocio_id, conversacion_id). El mismo teléfono
-- puede escribirle a dos negocios y producir el mismo `agente:<tel>:cN`; unir
-- solo por conversacion_id cruzaría tenants y podría reabrir el pedido de un
-- negocio usando la hora del otro.
--
-- Antes de tocar cada fila se toma el MISMO lock que sostiene la continuidad
-- de WhatsApp durante un turno (`wa:<negocio>:<telefono>`). Así un turno que
-- ya leyó el estado legacy termina de guardarlo antes del backfill, y ningún
-- turno nuevo puede leer entre el UPDATE y el COMMIT para borrar luego la
-- clave con una fotografía vieja.

DO $migracion$
DECLARE
  objetivo RECORD;
BEGIN
  -- Un lock huérfano no puede dejar el deploy colgado indefinidamente. Cinco
  -- minutos permiten terminar un turno normal; después se aborta y conserva
  -- el build anterior.
  PERFORM set_config('lock_timeout', '5min', true);

  -- Se bloquean TODAS las sesiones existentes, no solo las que ya parecen
  -- candidatas. Una conversación en curso puede volverse terminal mientras
  -- la migración espera; enumerar solo terminales dejaría esa transición fuera
  -- de la protección cuando el SQL se ejecute sin su wrapper de predeploy.
  FOR objetivo IN
    SELECT ce.negocio_id, ce.session_id
      FROM conversacion_estado ce
     WHERE ce.session_id LIKE 'agente:%'
     ORDER BY ce.negocio_id, ce.session_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'wa:' || objetivo.negocio_id::text || ':' || substring(objetivo.session_id FROM 8), 0));
  END LOOP;

  UPDATE conversacion_estado ce
     SET estado = jsonb_set(ce.estado, '{terminadoEn}', to_jsonb(cierre.en), true)
    FROM (
      SELECT negocio_id, conversacion_id, herramienta,
             to_char(max(updated_at) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS en
        FROM agente_operaciones
       WHERE herramienta IN ('confirmar_pedido', 'cancelar_pedido')
         AND estado = 'ok'
         AND aplicada IS TRUE
         AND modo = 'productivo'
       GROUP BY negocio_id, conversacion_id, herramienta
    ) AS cierre
   WHERE ce.negocio_id = cierre.negocio_id
     AND ce.session_id LIKE 'agente:%'
     AND ce.estado->>'conversacionId' = cierre.conversacion_id
     AND (
       ce.estado->>'conversacionId' = ce.session_id
       OR (
         left(ce.estado->>'conversacionId', length(ce.session_id)) = ce.session_id
         AND substring(ce.estado->>'conversacionId' FROM length(ce.session_id) + 1)
               ~ '^:c[0-9]+$'
       )
     )
     AND ce.estado->>'terminadoEn' IS NULL
     AND COALESCE(ce.estado->'hechos'->>'fallido', 'false') <> 'true'
     AND (
       (ce.estado->'hechos'->>'confirmado' = 'true'
        AND COALESCE(ce.estado->'hechos'->>'cancelado', 'false') <> 'true'
        AND cierre.herramienta = 'confirmar_pedido')
       OR
       (ce.estado->'hechos'->>'cancelado' = 'true'
        AND COALESCE(ce.estado->'hechos'->>'confirmado', 'false') <> 'true'
        AND cierre.herramienta = 'cancelar_pedido')
     );

END
$migracion$;
