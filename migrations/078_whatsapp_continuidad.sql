-- Estado del asistente e inbox por negocio. No modifica pedidos ni folios.
CREATE TABLE IF NOT EXISTS whatsapp_conversaciones (
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  telefono text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  requiere_revision boolean NOT NULL DEFAULT false,
  motivo text,
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, telefono)
);
CREATE TABLE IF NOT EXISTS whatsapp_entradas (
  id bigserial PRIMARY KEY,
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  telefono text NOT NULL,
  wamid text NOT NULL,
  payload jsonb NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','procesando','completado','revision','revisado')),
  recibido_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, wamid),
  FOREIGN KEY (negocio_id, telefono) REFERENCES whatsapp_conversaciones(negocio_id, telefono)
);
CREATE INDEX IF NOT EXISTS whatsapp_entradas_pendientes ON whatsapp_entradas(negocio_id,telefono,id)
  WHERE estado IN ('pendiente','procesando');

-- 076 sigue siendo la única fuente del carrito. 077 conserva el sobre.
-- Los sobres viejos no terminados pueden haber tenido efectos: se presentan
-- para revisión, nunca se reejecutan automáticamente al instalar 078.
DO $$
DECLARE r record;
BEGIN
 FOR r IN
  SELECT w.id AS sobre_id,ic.negocio_id,m AS mensaje,c->'value' AS valor
  FROM webhook_entrante w
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.payload->'entry')='array' THEN w.payload->'entry' ELSE '[]'::jsonb END) e
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'changes')='array' THEN e->'changes' ELSE '[]'::jsonb END) c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c->'value'->'messages')='array' THEN c->'value'->'messages' ELSE '[]'::jsonb END) m
  JOIN integraciones_canal ic ON ic.canal='whatsapp' AND ic.identificador=c->'value'->'metadata'->>'phone_number_id'
  WHERE w.estado IN ('pendiente','fallido') AND w.ultimo_error IS DISTINCT FROM 'MIGRADO_A_REVISION_078'
   AND m->>'type' IN ('text','image','document') AND coalesce(m->>'from','')<>'' AND coalesce(m->>'id','')<>''
 LOOP
  INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision,motivo)
   VALUES(r.negocio_id,r.mensaje->>'from',true,'SOBRE_LEGADO_INCOMPLETO')
   ON CONFLICT(negocio_id,telefono) DO UPDATE SET requiere_revision=true,motivo='SOBRE_LEGADO_INCOMPLETO';
  INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado)
   VALUES(r.negocio_id,r.mensaje->>'from',r.mensaje->>'id',jsonb_build_object('message',r.mensaje,'value',r.valor),'revision')
   ON CONFLICT(negocio_id,wamid) DO NOTHING;
  INSERT INTO mensajes(negocio_id,telefono,direccion,texto,origen,message_id_externo)
   VALUES(r.negocio_id,r.mensaje->>'from','entrante',coalesce(r.mensaje->'text'->>'body',r.mensaje->'image'->>'caption',r.mensaje->'document'->>'filename','Archivo recibido pendiente de revisión'),'cliente',r.mensaje->>'id')
   ON CONFLICT(message_id_externo) WHERE message_id_externo IS NOT NULL DO NOTHING;
  UPDATE webhook_entrante SET estado='fallido',ultimo_error='MIGRADO_A_REVISION_078' WHERE id=r.sobre_id;
 END LOOP;
END $$;
