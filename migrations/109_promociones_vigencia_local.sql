-- 109: vigencia de promociones en el día LOCAL del negocio.
--
-- Hasta aquí el panel mandaba la vigencia como 'YYYY-MM-DD' y se guardaba tal
-- cual en timestamptz: la medianoche UTC de ese día. En Matamoros eso es la
-- tarde del día ANTERIOR, así que «hasta el 30» vencía el 29 a las 19:00 y
-- «desde el 1» empezaba el 31 a las 19:00. Desde esta versión el servidor
-- guarda el inicio del día local (desde) y su último instante (hasta); esto
-- corrige las filas que ya existían.
--
-- Solo toca extremos EXACTAMENTE a la medianoche UTC (la huella de una fecha
-- capturada por día). Una vez corregidos ya no están a medianoche UTC en
-- ninguna zona de México, así que volver a correrla no cambia nada.

WITH zona AS (
  SELECT p.id,
         CASE WHEN tz.name IS NOT NULL THEN tz.name ELSE 'America/Matamoros' END AS tz
    FROM tienda_promociones p
    LEFT JOIN configuracion c
           ON c.negocio_id = p.negocio_id AND c.clave = 'timezone'
    LEFT JOIN pg_timezone_names tz ON tz.name = trim(c.valor)
)
UPDATE tienda_promociones p
   SET vigencia_desde = CASE
         WHEN p.vigencia_desde IS NOT NULL
          AND (p.vigencia_desde AT TIME ZONE 'UTC')::time = time '00:00'
         THEN ((p.vigencia_desde AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE z.tz)
         ELSE p.vigencia_desde END,
       vigencia_hasta = CASE
         WHEN p.vigencia_hasta IS NOT NULL
          AND (p.vigencia_hasta AT TIME ZONE 'UTC')::time = time '00:00'
         THEN (((p.vigencia_hasta AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE z.tz)
              - interval '1 millisecond'
         ELSE p.vigencia_hasta END
  FROM zona z
 WHERE z.id = p.id
   AND (   (p.vigencia_desde IS NOT NULL AND (p.vigencia_desde AT TIME ZONE 'UTC')::time = time '00:00')
        OR (p.vigencia_hasta IS NOT NULL AND (p.vigencia_hasta AT TIME ZONE 'UTC')::time = time '00:00'));
