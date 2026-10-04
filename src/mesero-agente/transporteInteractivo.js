import { barrerasDeBotones, interactivosActivos, TOKEN_BOTON } from './interactivos.js';
import { eleccionesActivas } from './eleccionesInteractivas.js';
import { flowsActivos } from './formularioAgrupado.js';
import { inicioMapoActivo } from './inicioMapo.js';
// Con la nota del pedido (contrato nota_v1) y la tienda (tienda_v1) sus flowId
// también tienen endpoint; sin sus claves la lista es la de siempre.
import { flowIdsConEndpointFormularios as flowIdsConEndpoint } from './disponibilidadTienda.js';

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
  if (!payloadInteractivoValido(interactivo,texto)) return { permitido:false };
  if (interactivo.type==='flow') {
    const id=interactivo.action.parameters.flow_id;
    return {permitido:true,interactivo:flowsActivos(b.cfg,telefono) && eleccionesActivas(b.cfg)
      && [b.cfg.whatsapp_flow_productos_id,b.cfg.whatsapp_flow_configurar_id,b.cfg.whatsapp_flow_editar_id,b.cfg.whatsapp_flow_pedido_id,b.cfg.whatsapp_flow_repetible_id,b.cfg.whatsapp_flow_categorias_id,b.cfg.whatsapp_flow_carrito_id,
        ...flowIdsConEndpoint(b.cfg),
        ...(inicioMapoActivo(b.cfg)?[b.cfg.whatsapp_flow_facturacion_id,b.cfg.whatsapp_flow_evento_id]:[])].includes(id)
      && (interactivo.action.parameters.flow_action!=='data_exchange' || (flowIdsConEndpoint(b.cfg).includes(id)
        && process.env.WHATSAPP_FLOW_ENDPOINT==='true' && !!process.env.WHATSAPP_FLOW_PRIVATE_KEY && !!process.env.META_APP_SECRET)) ? interactivo : null};
  }
  if (!eleccionesActivas(b.cfg) || !inicioMapoActivo(b.cfg)) {
    const token=interactivo.type==='list' ? interactivo.action.sections[0].rows[0].id : interactivo.action.buttons[0].reply.id;
    const {rows:[asociacion]}=await db.query(`SELECT b.accion FROM agente_botones b JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id
      WHERE b.token=$1 AND q.negocio_id=$2 AND q.session_id=$3`,[token,negocioId,`agente:${telefono}`]);
    if (asociacion?.accion==='menu_mapo' && !inicioMapoActivo(b.cfg)) return {permitido:false};
    if (!eleccionesActivas(b.cfg) && (!asociacion || !['confirmar','cambiar_algo','agregar_otro'].includes(asociacion.accion)))
      return {permitido:true,interactivo:null};
  }
  return { permitido: true, interactivo };
}

export function payloadInteractivoValido(p,texto) {
  if (!texto || texto.length > 1024 || p?.body?.text !== texto) return false;
  const valido = (r,limite) => typeof r?.id === 'string' && TOKEN_BOTON.test(r.id)
    && typeof r.title === 'string' && r.title.trim().length > 0 && r.title.length <= limite;
  let filas;
  if(p.type==='flow') {
    const a=p.action?.parameters;
    const pantalla=a?.flow_action_payload;
    const datos=pantalla?.data;
    // Meta exige un objeto no vacío si se incluye data. Los formularios
    // estáticos SERVICIO lo omiten; PEDIDO/PRODUCTOS necesitan su catálogo.
    const datosValidos=pantalla?.screen==='SERVICIO' && !Object.hasOwn(pantalla,'data')
      || !!datos && typeof datos==='object' && !Array.isArray(datos) && Object.keys(datos).length>0;
    return p.action?.name==='flow' && a?.flow_message_version==='3'
      && TOKEN_BOTON.test(a.flow_token || '') && /^\d{5,30}$/.test(a.flow_id || '')
      && typeof a.flow_cta==='string' && a.flow_cta.length>0 && a.flow_cta.length<=30
      && ((a.flow_action==='data_exchange' && a.flow_action_payload===undefined)
        || (a.flow_action==='navigate' && ['PRODUCTOS','PEDIDO','SERVICIO'].includes(a.flow_action_payload?.screen)
        && datosValidos));
  }
  if (p.type === 'button') {
    if (!Array.isArray(p.action?.buttons) || p.action.buttons.length < 1 || p.action.buttons.length > 3
      || !p.action.buttons.every(b => b.type === 'reply' && valido(b.reply,20))) return false;
    filas = p.action.buttons.map(b => b.reply);
  } else if (p.type === 'list') {
    if (typeof p.action?.button !== 'string' || !p.action.button.trim() || p.action.button.length > 20
      || !Array.isArray(p.action.sections) || p.action.sections.length !== 1) return false;
    filas = p.action.sections[0].rows;
    if (!Array.isArray(filas) || filas.length < 1 || filas.length > 10
      || !filas.every(r => valido(r,24) && (r.description === undefined
        || (typeof r.description === 'string' && r.description.length <= 72)))) return false;
  } else return false;
  return new Set(filas.map(r => r.id)).size === filas.length && new Set(filas.map(r => r.title)).size === filas.length;
}
