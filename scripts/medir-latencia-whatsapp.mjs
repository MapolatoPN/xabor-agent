// Diagnóstico agregado, solo lectura. No exporta teléfonos, textos o tokens.
// node scripts/medir-latencia-whatsapp.mjs UUID_NEGOCIO [HORAS=24]
import {pathToFileURL} from 'node:url';
export async function medirLatencia(db,negocioId,horas=24) {
  if(!/^[0-9a-f-]{36}$/i.test(negocioId) || !Number.isInteger(horas) || horas<1 || horas>48)throw Error('UUID y ventana de 1 a 48 horas requeridos');
  const {rows}=await db.query({text:`WITH turnos AS (
    SELECT t.id,t.recuperacion,t.motivo_handoff,t.errores_proveedor,t.latencias,
      COALESCE(t.latencias->>'modelo_intentos',t.latencias->>'modelo_llamadas') AS llamadas,
      extract(epoch FROM (o.aceptado-e.entrada))*1000 AS extremo_ms,
      extract(epoch FROM (t.created_at-e.entrada))*1000-(t.latencias->>'total_ms')::numeric AS cola_estimada_ms,
      extract(epoch FROM (o.aceptado-t.created_at))*1000 AS outbox_ms,o.estados
    FROM agente_turnos t
    LEFT JOIN LATERAL (SELECT min(recibido_at) AS entrada FROM whatsapp_entradas
      WHERE negocio_id=t.negocio_id AND wamid=ANY(t.wamids)) e ON true
    LEFT JOIN LATERAL (SELECT max(entregado_at) FILTER(WHERE estado='entregado') AS aceptado,
      array_agg(DISTINCT estado) AS estados FROM agente_outbox
      WHERE negocio_id=t.negocio_id AND evento_clave=ANY(t.outbox_claves) AND tipo='respuesta_cliente') o ON true
    WHERE t.negocio_id=$1 AND t.modo='productivo' AND t.created_at>now()-$2*interval '1 hour'
  ) SELECT CASE WHEN llamadas IS NULL THEN 'sin_clasificar' WHEN llamadas='0' THEN 'sin_modelo' ELSE 'con_modelo' END AS ruta,
    count(*)::int AS turnos,count(extremo_ms)::int AS con_acuse,
    count(*) FILTER(WHERE recuperacion IS NOT NULL)::int AS recuperaciones,
    count(*) FILTER(WHERE motivo_handoff IS NOT NULL)::int AS handoffs,
    count(*) FILTER(WHERE errores_proveedor<>'[]'::jsonb)::int AS errores_modelo,
    count(*) FILTER(WHERE estados && ARRAY['fallido','incierto'])::int AS salidas_con_error,
    count(*) FILTER(WHERE cola_estimada_ms<0 OR outbox_ms<0 OR extremo_ms<0)::int AS relojes_inconsistentes,
    round((percentile_cont(.95) WITHIN GROUP(ORDER BY extremo_ms) FILTER(WHERE extremo_ms>=0))::numeric) AS p95_entrada_a_aceptacion_ms,
    round((percentile_cont(.95) WITHIN GROUP(ORDER BY cola_estimada_ms) FILTER(WHERE cola_estimada_ms>=0))::numeric) AS p95_cola_estimada_ms,
    round((percentile_cont(.95) WITHIN GROUP(ORDER BY outbox_ms) FILTER(WHERE outbox_ms>=0))::numeric) AS p95_outbox_ms,
    round((percentile_cont(.95) WITHIN GROUP(ORDER BY (latencias->>'lecturas_ms')::numeric))::numeric) AS p95_lecturas_ms,
    round((percentile_cont(.95) WITHIN GROUP(ORDER BY (latencias->>'modelo_ms')::numeric))::numeric) AS p95_modelo_ms,
    round((percentile_cont(.95) WITHIN GROUP(ORDER BY (latencias->>'herramientas_ms')::numeric))::numeric) AS p95_herramientas_ms
  FROM turnos GROUP BY 1 ORDER BY 1`,values:[negocioId,horas],query_timeout:8000});
  return {horas,rutas:rows,limites:'Cola estimada incluye agrupación y espera. Outbox incluye commit, cola y HTTP. Aceptado por Meta no significa entregado al dispositivo. Sin acuse no entra al percentil; errores se cuentan por separado. No mide tiempo del cliente dentro del formulario.'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {pool}=await import('../src/services/database.js');const db=await pool.connect();
  try {await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='8s'");
    console.log(JSON.stringify(await medirLatencia(db,process.argv[2],Number(process.argv[3] || 24)),null,2));
  } finally {await db.query('ROLLBACK');db.release();await pool.end();}
}
