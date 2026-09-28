import { barrerasDeBotones, interactivosActivos, TOKEN_BOTON } from './interactivos.js';

// Se llama dentro del reclamo del outbox, justo antes de usar Meta.
export async function prepararEnvioInteractivo({ db, negocioId, telefono, interactivo, texto }) {
  if (!interactivo) return { permitido: true, interactivo: null };
  const b = await barrerasDeBotones(db, negocioId, telefono);
  if (!b.activo) return { permitido: false };
  const { rows: [v] } = await db.query(`SELECT max(
      CASE WHEN payload->'message'->>'timestamp' ~ '^[0-9]{9,11}$'
        THEN CASE WHEN to_timestamp((payload->'message'->>'timestamp')::double precision) <= clock_timestamp()
          THEN LEAST(recibido_at,to_timestamp((payload->'message'->>'timestamp')::double precision)) END
        ELSE NULL END) > clock_timestamp()-interval '24 hours' AS abierta
    FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2`,[negocioId,telefono]);
  if (v?.abierta !== true) return { permitido: false };
  if (!interactivosActivos(b.cfg)) return { permitido: true, interactivo: null };
  if (interactivo.type !== 'button' || interactivo.body?.text !== texto
    || !texto || texto.length > 1024
    || !Array.isArray(interactivo.action?.buttons) || interactivo.action.buttons.length !== 2
    || !interactivo.action.buttons.every(b => b.type === 'reply' && typeof b.reply?.id === 'string'
      && TOKEN_BOTON.test(b.reply.id) && typeof b.reply.title === 'string'
      && b.reply.title.trim().length > 0 && b.reply.title.length <= 20)) return { permitido: false };
  return { permitido: true, interactivo };
}
