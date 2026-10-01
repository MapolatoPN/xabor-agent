import { randomBytes, randomUUID } from 'node:crypto';
import { intencionDeEntrada } from './intencionDeEntrada.js';

// La apertura general es una decisión explícita del negocio, independiente
// del piloto. No equivale a levantar las pausas de atención humana.
export const atencionGeneralActiva = cfg => String(cfg?.whatsapp_atencion_general_v1) === 'true'
  && String(cfg?.bot_whatsapp_solo_prueba) === 'false';
export const inicioMapoActivo = cfg => String(cfg?.whatsapp_inicio_mapo_v1) === 'true';
export const ACCIONES_SERVICIO = ['flow_facturacion', 'flow_evento'];
export const OPCIONES_MAPO = [
  { valor:'ordenar', title:'Ordenar', description:'Elegir mis platillos' },
  { valor:'facturacion', title:'Facturación', description:'Enviar mis datos para facturar' },
  { valor:'evento', title:'Servicio para eventos', description:'Solicitar una cotización' },
  { valor:'humano', title:'Otra duda', description:'Hablar con una persona' },
];
const libre = e => e && !e.folio && !e.evento && !e.confirmacionIncierta
  && !e.programacionRequerida && !Object.values(e.hechos || {}).some(Boolean);

export function entradaMapo({cfg,estado,mensaje,zona='America/Matamoros',ahora=new Date(),
  nombreNegocio=cfg?.nombre || cfg?.nombre_negocio}) {
  if (!inicioMapoActivo(cfg) || !libre(estado) || estado.carrito?.items?.length) return null;
  if (!['saludo','inicio'].includes(intencionDeEntrada(mensaje,{nombreNegocio}))) return null;
  const hora=Number(new Intl.DateTimeFormat('en-US',{timeZone:zona,hour:'numeric',hourCycle:'h23'}).format(ahora));
  const franja=hora<12?'buenos días':hora<19?'buenas tardes':'buenas noches';
  return {tipo:'inicio_mapo',sinSaludo:true,acciones:[],pendiente:{tipo:'inicio_mapo'},
    texto:`¡Hola, ${franja}! Soy *Mapo Bot*. Nuestro personal se encuentra algo ocupado, pero estoy aquí para servirte.\n\n¿Cómo puedo ayudarte?`};
}

export function respuestaOpcionMapo(reserva) {
  if (reserva?.accion!=='menu_mapo') return null;
  const v=reserva.datos?.valor;
  if (v==='ordenar') return {tipo:'mapo_ordenar',sinSaludo:true,acciones:[],pendiente:{tipo:'agregar_otro'},
    texto:'Elige y personaliza tus platillos. Revisarás el total antes de confirmar.'};
  if (v==='facturacion' || v==='evento') return {tipo:'mapo_servicio',sinSaludo:true,acciones:[],
    pendiente:{tipo:'formulario_servicio',servicio:v},texto:v==='facturacion'
      ? '*Solicita tu factura*\nCompleta tus datos fiscales y la referencia de tu compra. El equipo los revisará antes de emitirla.'
      : '*Servicio para eventos*\nCuéntanos los detalles de tu evento. El equipo revisará disponibilidad y cotización; enviar este formulario no hace una reserva.'};
  return null;
}

export function asociacionMapoVigente(q,{estado,cfg}) {
  if (!inicioMapoActivo(cfg) || !libre(estado)) return false;
  if (q.accion==='menu_mapo') return OPCIONES_MAPO.some(o=>o.valor===q.datos?.valor);
  const servicio=q.accion==='flow_facturacion'?'facturacion':q.accion==='flow_evento'?'evento':null;
  return !!servicio && estado.pendiente?.tipo==='formulario_servicio'
    && estado.pendiente.servicio===servicio && q.datos?.servicio===servicio
    && q.datos?.version==='servicios_v1'
    && q.datos.flowId===cfg[`whatsapp_flow_${servicio}_id`];
}

export function construirInicioMapo({estado,pedido,texto,cfg}) {
  if (!inicioMapoActivo(cfg) || !libre(estado) || estado.dialogo?.texto!==texto
    || estado.dialogo?.ciclo!==estado.conversacionId) return null;
  const base={preguntaId:randomUUID(),ciclo:estado.conversacionId,dialogoId:estado.dialogo.id,
    huella:pedido.huella,total:pedido.total,texto};
  const token=()=>`xb1:${randomBytes(16).toString('base64url')}`;
  if (estado.pendiente?.tipo==='inicio_mapo') {
    const botones=OPCIONES_MAPO.map(o=>({...o,token:token(),accion:'menu_mapo',datos:{valor:o.valor}}));
    return {...base,botones,textoFallback:`${texto}\nEscribe qué necesitas: ordenar, facturación, eventos o atención de una persona.`,
      carga:{type:'list',body:{text:texto},action:{button:'¿Cómo te ayudo?',sections:[{title:'Mapolato',
        rows:botones.map(o=>({id:o.token,title:o.title,description:o.description}))}]}}};
  }
  if (estado.pendiente?.tipo!=='formulario_servicio') return null;
  const servicio=estado.pendiente.servicio,flowId=cfg[`whatsapp_flow_${servicio}_id`];
  if (!/^\d{5,30}$/.test(flowId || '')) return null;
  const t=token();
  return {...base,botones:[{token:t,accion:servicio==='facturacion'?'flow_facturacion':'flow_evento',
    datos:{servicio,version:'servicios_v1',flowId}}],
    textoFallback:'El formulario no está disponible. Escribe «quiero hablar con una persona» para que el equipo te ayude.',
    carga:{type:'flow',body:{text:texto},action:{name:'flow',parameters:{flow_message_version:'3',flow_id:flowId,
      flow_token:t,flow_cta:servicio==='facturacion'?'Datos de facturación':'Datos del evento',flow_action:'navigate',
      // SERVICIO no consume datos iniciales. Meta rechaza data:{} (131009);
      // omitir el campo opcional, sin añadir datos ficticios al formulario.
      flow_action_payload:{screen:'SERVICIO'}}}}};
}

const campo=(r,k,min,max)=> typeof r[k]==='string' && r[k].trim().length>=min && r[k].length<=max
  && !(k==='detalles' ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(r[k]) ? r[k].trim() : null;
export function validarServicio(accion,r) {
  if (!r || typeof r!=='object' || Array.isArray(r)) return null;
  const factura=accion==='flow_facturacion';
  if (!factura && accion!=='flow_evento') return null;
  const especificacion=factura ? {nombre:[3,150],rfc:[12,13],codigo_postal:[5,5],regimen:[3,120],uso_cfdi:[3,100],
    correo:[5,150],referencia:[1,120]} : {nombre:[2,100],tipo_evento:[2,100],fecha:[10,10],hora:[5,5],
    personas:[1,4],ubicacion:[3,200],detalles:[2,500]};
  if (Object.keys(r).some(k=>k!=='flow_token' && !Object.hasOwn(especificacion,k))) return null;
  const datos={};
  for (const [k,[min,max]] of Object.entries(especificacion)) {
    const v=campo(r,k,min,max);if(v===null)return null;datos[k]=v;
  }
  if (factura) {
    datos.rfc=datos.rfc.toUpperCase();
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(datos.rfc) || !/^\d{5}$/.test(datos.codigo_postal)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo)) return null;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(datos.hora)
      || !/^[1-9]\d{0,3}$/.test(datos.personas)) return null;
    const f=new Date(`${datos.fecha}T12:00:00Z`);
    if (!Number.isFinite(f.getTime()) || f.toISOString().slice(0,10)!==datos.fecha) return null;
    datos.personas=Number(datos.personas);
  }
  return {servicio:factura?'facturacion':'evento',datos};
}

export const textoReciboServicio = servicio => servicio==='facturacion'
  ? 'Recibimos tus datos de facturación. Una persona de Mapolato revisará tu compra y continuará contigo. La factura aún no se ha emitido.'
  : servicio==='evento' ? 'Recibimos los datos de tu evento. Una persona de Mapolato continuará contigo para revisar disponibilidad y cotización. Aún no hay una reserva confirmada.'
    : 'Te paso con una persona de Mapolato. Puedes escribir aquí tu duda; el equipo continuará contigo.';

export function resumenServicio({servicio,datos={}}) {
  const etiquetas={nombre:'Nombre',rfc:'RFC',codigo_postal:'Código postal fiscal',regimen:'Régimen fiscal',uso_cfdi:'Uso CFDI',
    correo:'Correo',referencia:'Referencia de compra',tipo_evento:'Tipo de evento',fecha:'Fecha solicitada',hora:'Hora solicitada',
    personas:'Personas',ubicacion:'Lugar',detalles:'Detalles'};
  return `${servicio==='facturacion'?'Solicitud de facturación':servicio==='evento'?'Solicitud de evento':'Atención personal'}\n`
    + Object.entries(datos).map(([k,v])=>`${etiquetas[k] || k}: ${v}`).join('\n');
}
