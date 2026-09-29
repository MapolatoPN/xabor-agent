// Flows es una vista del catálogo: los valores enviados por el cliente no
// contienen nombres, importes ni autoridad. Se resuelven contra la foto guardada.
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fichaPorId, opcionesDeLinea } from './vistaDelPedido.js';
import { productosVendibles } from '../mesero-whatsapp/consultasDelMenu.js';
import { cardinalidadSeleccionable } from '../services/modificadores.js';
import { modalidadesDisponibles, etiquetaTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { tiposDePagoDisponibles, etiquetaTipoPago } from './politicaDePagos.js';
import { esVerdadero, enElCanario } from '../orders/modoDelPedido.js';
import { accionInteractiva } from './autoridadInteractiva.js';
import { leerObservacionesPlatillo } from './observacionesDelPlatillo.js';

export const ACCIONES_FLOW = ['flow_productos', 'flow_configurar'];
export const MAX_LINEAS_FLOW = 3;
export const GRUPOS_POR_LINEA_FLOW = 6;
const repetibleActivo=cfg=>process.env.WHATSAPP_FLOW_ENDPOINT==='true'
  && !!process.env.WHATSAPP_FLOW_PRIVATE_KEY && !!process.env.META_APP_SECRET
  && /^\d{5,30}$/.test(cfg?.whatsapp_flow_repetible_id || '');
const obj = v => v && typeof v === 'object' && !Array.isArray(v);
const precio = v => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
const orden = v => Array.isArray(v) ? v.map(orden) : obj(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,orden(v[k])])) : v;
const igual = (a,b) => isDeepStrictEqual(orden(a),orden(b));
export const flowsActivos = (cfg,telefono) => esVerdadero(cfg?.whatsapp_flows_v1)
  && esVerdadero(cfg?.bot_whatsapp_solo_prueba)
  && enElCanario(telefono,{lista:cfg?.whatsapp_flows_telefonos,porcentaje:0}).dentro;

export function entradaFormulario({estado,cfg,telefono,mensaje}) {
  if(!flowsActivos(cfg,telefono) || estado.carrito?.items?.length || estado.folio || estado.evento
    || estado.programacionRequerida || Object.values(estado.hechos || {}).some(Boolean))return null;
  const texto=String(mensaje || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  if(!/^(hola|buenos dias|buenas tardes|buenas noches|menu|quiero (ordenar|pedir)|hacer (un )?pedido)[!.?¡¿\s]*$/.test(texto))return null;
  return {tipo:'entrada_flow',sinSaludo:true,texto:'Elige tus platillos y personalízalos juntos.',acciones:[],
    pendiente:{tipo:'agregar_otro'}};
}

export function leerRespuestaFlow(message) {
  if (message?.type !== 'interactive' || message.interactive?.type !== 'nfm_reply') return null;
  const raw = message.interactive.nfm_reply?.response_json;
  if (typeof raw !== 'string' || Buffer.byteLength(raw)>16384) return null;
  try {
    const r=JSON.parse(raw);
    return obj(r) && typeof r.flow_token === 'string' ? r : null;
  } catch { return null; }
}

function fichaGuardable(f) {
  if (!f || !precio(f.precio) || f.grupos.length>GRUPOS_POR_LINEA_FLOW) return null;
  const grupos=f.grupos.map(g=>({...cardinalidadSeleccionable(g),nombre:g.nombre,
    opciones:g.opciones.map(o=>({nombre:o.nombre,precio:Number(o.precio_extra)}))}));
  if (grupos.some(g=>!g.opciones.length || g.opciones.length>20
    || g.minimo>g.opciones.length || g.maximo<1 || g.maximo>20
    || g.opciones.some(o=>!precio(o.precio)))) return null;
  return {id:String(f.id),nombre:f.nombre,precio:Number(f.precio),grupos};
}

export function fotoFormulario({estado,catalogo,modalidades,metodosPago,cfg}, accion) {
  if (accion==='flow_productos') {
    if(estado.pendiente?.tipo==='elegir_producto' && estado.pendiente.cantidad!==1)return null;
    // Es un límite de captura por ventana, NO del carrito del cliente.
    const espacio=MAX_LINEAS_FLOW;
    let productos=productosVendibles(catalogo).map(p=>fichaGuardable(fichaPorId(catalogo,p.id))).filter(Boolean);
    if (estado.pendiente?.tipo==='elegir_producto') {
      const ids=estado.pendiente.candidatos.map(c=>c.id);
      // El siguiente platillo puede ser de otra familia. Solo se prioriza la
      // búsqueda inicial, no se encierra toda la ventana en esos candidatos.
      if(repetibleActivo(cfg)) {
        const candidatos=new Set(ids.map(String));
        productos.sort((a,b)=>Number(candidatos.has(b.id))-Number(candidatos.has(a.id)));
      } else productos=productos.filter(p=>ids.includes(p.id));
    }
    if (!productos.length || productos.length>(cfg?.whatsapp_flow_pedido_id?199:200)) return null;
    if(repetibleActivo(cfg))return {tipo:'flow_productos',productos,version:'repetible_v1',
      flowId:cfg.whatsapp_flow_repetible_id,...datosEntrega({estado,modalidades,metodosPago})};
    return {tipo:'flow_productos',espacio,productos,...(/^\d{5,30}$/.test(cfg?.whatsapp_flow_pedido_id || '')
      ? {version:'continuo_v1',...datosEntrega({estado,modalidades,metodosPago})} : {})};
  }
  const items=estado.carrito?.items || [];
  if (!items.length) return null;
  const todas=items.map(item=>{
    const ficha=fichaGuardable(fichaPorId(catalogo,item.id));
    return ficha && {linea_id:item.lid,cantidad:item.cantidad,ficha,seleccion:opcionesDeLinea(item)};
  });
  if (todas.some(l=>!l)) return null;
  // Con más de tres renglones se atienden primero los incompletos. Los ya
  // configurados no vuelven a preguntarse ni bloquean al cuarto platillo.
  const pendientes=todas.filter(l=>l.ficha.grupos.some(g=>
    l.seleccion.filter(o=>o.grupo===g.nombre).length<g.minimo));
  if(todas.length>MAX_LINEAS_FLOW && !pendientes.length)return null;
  const lineas=(todas.length>MAX_LINEAS_FLOW && pendientes.length ? pendientes : todas).slice(0,MAX_LINEAS_FLOW);
  return {tipo:'flow_configurar',lineas,...datosEntrega({estado,modalidades,metodosPago})};
}

function datosEntrega({estado,modalidades,metodosPago}) {
  return {
    modalidades:modalidadesDisponibles(modalidades).map(m=>({valor:m.valor,titulo:etiquetaTipoModalidad(m.tipo)})),
    pagos:tiposDePagoDisponibles(metodosPago).map(valor=>({valor,titulo:etiquetaTipoPago(valor)})),
    modalidad:estado.carrito.datos?.modalidad || '',pago:estado.carrito.datos?.forma_pago || ''};
}

const opcion = (id,nombre,importe) => ({id,title:nombre.slice(0,30),
  description:nombre.length>30 ? nombre.slice(0,300) : '',metadata:importe ? `+$${importe}` : ''});

export function datosPantalla(foto) {
  if(foto.version==='continuo_v1')return datosPantallaContinua(foto);
  if (foto.tipo==='flow_productos') {
    const opciones=foto.productos.map((p,i)=>({...opcion(`p${i}`,p.nombre,0),metadata:`$${p.precio}`}));
    return {productos:opciones,segundo:foto.espacio>=2,tercero:foto.espacio>=3};
  }
  const data={};
  for(let l=0;l<MAX_LINEAS_FLOW;l++) {
    const linea=foto.lineas[l];
    data[`l${l}_visible`]=!!linea;
    data[`l${l}_titulo`]=linea ? `${l+1}. ${linea.cantidad} × ${linea.ficha.nombre}` : 'Platillo';
    data[`l${l}_precio`]=linea ? `Base: $${linea.ficha.precio} por unidad. Los extras se indican en cada opción.` : '';
    for(let g=0;g<GRUPOS_POR_LINEA_FLOW;g++) {
      const key=`g${l*GRUPOS_POR_LINEA_FLOW+g}`,grupo=linea?.ficha.grupos[g];
      const multiple=!!grupo && grupo.maximo>1;
      data[`${key}_simple`]=!!grupo && !multiple;
      data[`${key}_multiple`]=multiple;
      data[`${key}_label`]=(grupo?.nombre || 'Opciones').slice(0,20);
      data[`${key}_min`]=grupo?.minimo || 0;
      data[`${key}_max`]=grupo ? Math.min(grupo.maximo,grupo.opciones.length) : 1;
      data[`${key}_requerido`]=!!grupo && grupo.minimo>0;
      data[`${key}_opciones`]=grupo ? grupo.opciones.map((o,i)=>opcion(`o${i}`,o.nombre,o.precio)) : [{id:'oculto',title:'No aplica',description:'',metadata:''}];
      const seleccion=grupo ? grupo.opciones.flatMap((o,i)=>linea.seleccion.some(s=>s.grupo===grupo.nombre && s.opcion===o.nombre)?[`o${i}`]:[]) : [];
      data[`${key}_inicial_s`]=!multiple ? (seleccion[0] || '') : '';
      data[`${key}_inicial_m`]=multiple ? seleccion : [];
      data[`${key}_ayuda`]=multiple ? `Elige ${grupo.minimo===grupo.maximo ? grupo.minimo : `${grupo.minimo} a ${data[`${key}_max`]}`} opciones.` : '';
    }
  }
  data.modalidades=foto.modalidades.map((m,i)=>opcion(`m${i}`,m.titulo,0));
  data.pagos=foto.pagos.map((m,i)=>opcion(`p${i}`,m.titulo,0));
  data.modalidad_inicial=foto.modalidades.findIndex(m=>m.valor===foto.modalidad);
  data.modalidad_inicial=data.modalidad_inicial<0 ? '' : `m${data.modalidad_inicial}`;
  data.pago_inicial=foto.pagos.findIndex(m=>m.valor===foto.pago);
  data.pago_inicial=data.pago_inicial<0 ? '' : `p${data.pago_inicial}`;
  return data;
}

export function construirFormulario({estado,pedido,texto,cfg,telefono,aviso='',...ctx}) {
  if (!flowsActivos(cfg,telefono) || estado.folio || estado.evento || estado.programacionRequerida
    || estado.confirmacionIncierta || Object.values(estado.hechos || {}).some(Boolean)
    || estado.dialogo?.ciclo!==estado.conversacionId || estado.dialogo.texto!==texto) return null;
  const tipo=estado.pendiente?.tipo;
  const accion=['elegir_producto','agregar_otro'].includes(tipo) ? 'flow_productos'
    : ['elegir_opcion','modalidad','pago','configurar_pedido'].includes(tipo)
      || (!tipo && pedido.aclaraciones?.length) ? 'flow_configurar' : null;
  if (!accion) return null;
  const id=accion==='flow_productos' ? (repetibleActivo(cfg)?cfg.whatsapp_flow_repetible_id:cfg.whatsapp_flow_pedido_id || cfg.whatsapp_flow_productos_id) : cfg.whatsapp_flow_configurar_id;
  if (!/^\d{5,30}$/.test(id || '')) return null;
  const foto=fotoFormulario({estado,cfg,...ctx},accion);
  if (!foto || ((accion==='flow_configurar' || foto.version) && (!foto.modalidades.length || !foto.pagos.length))) return null;
  const token=`xb1:${randomBytes(16).toString('base64url')}`;
  const cuerpo=aviso+(accion==='flow_productos'
    ? foto.version==='repetible_v1' ? '*Arma tu pedido*\nElige y personaliza un platillo. Usa «Agregar más» para seguir o «ORDEN COMPLETA» cuando termines, sin salir de la ventana.'
      : foto.version ? '*Arma tu pedido*\nElige y personaliza hasta tres platillos sin salir de esta ventana. Puedes agregar más después.'
      : '*Arma tu pedido*\nElige tus platillos en una sola pantalla. Después podrás personalizarlos.'
    : '*Personaliza tu pedido*\nCompleta las opciones de tus platillos y elige entrega y pago en una sola pantalla. Después revisarás el total.');
  return {preguntaId:randomUUID(),ciclo:estado.conversacionId,dialogoId:estado.dialogo.id,
    huella:pedido.huella,total:pedido.total,
    botones:[{token,accion,title:'Formulario',datos:foto}],texto:cuerpo,
    textoFallback:'El formulario no está disponible en este momento. Conservo tu pedido; puedes pedir ayuda a una persona.',
    carga:{type:'flow',body:{text:cuerpo},action:{name:'flow',parameters:{flow_message_version:'3',
      flow_token:token,flow_id:id,flow_cta:accion==='flow_productos'?'Elegir platillos':'Personalizar pedido',
      ...(foto.version==='repetible_v1' ? {flow_action:'data_exchange'}
        : {flow_action:'navigate',flow_action_payload:{screen:accion==='flow_productos'?'PRODUCTOS':'PEDIDO',data:datosPantalla(foto)}})}}}};
}

export function formularioVigente(asociacion,ctx) {
  return ACCIONES_FLOW.includes(asociacion?.accion)
    && igual(asociacion.datos,fotoFormulario(ctx,asociacion.accion));
}

// Valida TODO antes de proponer una sola mutación. Campos desconocidos,
// selecciones de grupos ocultos, índices falsos y cardinalidad incorrecta fallan.
export function comandosFormulario(foto,respuesta) {
  if (!obj(respuesta)) return null;
  if(foto.version==='repetible_v1') {
    if(Object.keys(respuesta).some(k=>!['flow_token','items','modalidad','pago'].includes(k))
      || !Array.isArray(respuesta.items) || !respuesta.items.length || respuesta.items.length>50)return null;
    const acciones=[];
    for(const item of respuesta.items) {
      if(!obj(item) || Object.keys(item).some(k=>!/^producto0$|^g[0-5]_[sm]$|^observaciones$/.test(k)))return null;
      const {observaciones,...seleccion}=item;
      const nota=leerObservacionesPlatillo(observaciones);if(nota===null)return null;
      const comandos=comandosContinuos({...foto,version:'continuo_v1'},
        {...seleccion,modalidad:respuesta.modalidad,pago:respuesta.pago});
      if(!comandos)return null;
      acciones.push(...comandos.filter(c=>!['definir_entrega','definir_pago'].includes(c.herramienta)));
      if(nota)acciones.push({herramienta:'modificar_linea',argumentos:{nota},lineaNueva:true});
    }
    const cierre=comandosFormulario({...foto,version:undefined,tipo:'flow_configurar',lineas:[]},
      {modalidad:respuesta.modalidad,pago:respuesta.pago});
    return cierre ? [...acciones,...cierre] : null;
  }
  if(foto.version==='continuo_v1')return comandosContinuos(foto,respuesta);
  const permitidos=new Set(['flow_token']);
  const acciones=[];
  if (foto.tipo==='flow_productos') {
    let n=0;
    for(let i=0;i<3;i++) {
      const k=`producto${i}`;permitidos.add(k);
      const v=respuesta[k];
      if (v==null || v==='') {if(i===0)return null;continue;}
      if(i>=foto.espacio || typeof v!=='string' || !/^p\d+$/.test(v))return null;
      const p=foto.productos[Number(v.slice(1))];if(!p)return null;
      acciones.push({herramienta:'agregar_producto',argumentos:{producto_id:p.id,cantidad:1}});n++;
    }
    if(!n)return null;
  } else {
    for(let l=0;l<MAX_LINEAS_FLOW;l++) {
      const linea=foto.lineas[l],opciones=[],sin_opciones=[];
      for(let g=0;g<GRUPOS_POR_LINEA_FLOW;g++) {
        const key=`g${l*GRUPOS_POR_LINEA_FLOW+g}`,grupo=linea?.ficha.grupos[g];
        const s=respuesta[`${key}_s`],m=respuesta[`${key}_m`];
        permitidos.add(`${key}_s`);permitidos.add(`${key}_m`);
        if((s!=null && typeof s!=='string') || (m!=null && !Array.isArray(m)))return null;
        const multi=grupo && grupo.maximo>1;
        if((multi && s) || (!multi && m?.length) || (!grupo && s))return null;
        if(!grupo)continue;
        const ids=multi?(m || []):(s?[s]:[]);
        if(ids.length<grupo.minimo || ids.length>grupo.maximo || new Set(ids).size!==ids.length)return null;
        for(const id of ids) {
          if(typeof id!=='string' || !/^o\d+$/.test(id))return null;
          const o=grupo.opciones[Number(id.slice(1))];if(!o)return null;
          opciones.push({grupo:grupo.nombre,opcion:o.nombre});
        }
        if(!ids.length)sin_opciones.push(grupo.nombre);
      }
      if(linea && (opciones.length || sin_opciones.length))acciones.push({herramienta:'modificar_linea',argumentos:{
        linea_id:linea.linea_id,opciones,sin_opciones}});
    }
    for(const [key,prefijo,lista,herramienta,campo] of [
      ['modalidad','m',foto.modalidades,'definir_entrega','modalidad'],
      ['pago','p',foto.pagos,'definir_pago','forma_pago']]) {
      permitidos.add(key);const v=respuesta[key];
      if(typeof v!=='string' || !new RegExp(`^${prefijo}\\d+$`).test(v))return null;
      const o=lista[Number(v.slice(1))];if(!o)return null;
      acciones.push({herramienta,argumentos:{[campo]:o.valor}});
    }
  }
  if(Object.keys(respuesta).some(k=>!permitidos.has(k)))return null;
  return acciones;
}

// Ejecuta solamente mutaciones INTERNAS sobre una copia. O se conservan todas
// o ninguna. El commit de la conversación y del token se hace después, juntos,
// por persistenciaDelTurno. Jamás confirma, cobra, imprime o llama al modelo.
export async function aplicarFormulario(reserva,ctx) {
  if(!formularioVigente(reserva,ctx))return {ok:false};
  const comandos=comandosFormulario(reserva.datos,reserva.respuestaFlow);
  if(!comandos)return {ok:false};
  const {crearEjecutor}=await import('./ejecutorDeHerramientas.js');
  const copia=structuredClone(ctx.estado);
  const ejecutor=crearEjecutor({...ctx,estado:copia,mensaje:'',efectos:null});
  const operaciones=[];
  let nuevaLinea=null;
  for(const c of comandos) {
    const argumentos=c.lineaNueva ? {...c.argumentos,linea_id:nuevaLinea} : c.argumentos;
    if(c.lineaNueva && !nuevaLinea)return {ok:false};
    const anteriores=new Set(copia.carrito.items.map(i=>i.lid));
    const a=accionInteractiva(c.herramienta,argumentos,copia);
    const r=await ejecutor.ejecutar(c.herramienta,argumentos,{autorizacion:a.autorizacion});
    if(!r?.aplicado || r.parcial)return {ok:false};
    if(c.herramienta==='agregar_producto') {
      const nuevas=copia.carrito.items.filter(i=>!anteriores.has(i.lid));
      if(nuevas.length!==1)return {ok:false};
      nuevaLinea=nuevas[0].lid;
    }
    operaciones.push({...c,argumentos,resultado:r,origen:'determinista',motivo:'formulario_verificado'});
  }
  if(reserva.accion==='flow_configurar' || ['continuo_v1','repetible_v1'].includes(reserva.datos.version)) {
    delete copia.eleccionInteractiva;
    delete ctx.estado.eleccionInteractiva;
  }
  Object.assign(ctx.estado,copia);
  return {ok:true,operaciones};
}

// Cada producto transporta su vista cerrada de opciones. update_data de Meta
// cambia los controles en el dispositivo sin enviar un mensaje por selección.
// Los códigos incluyen producto+grupo: cambiar de producto no puede transferir
// silenciosamente las selecciones anteriores a opciones con el mismo índice.
export function datosPantallaContinua(foto,numeroLineas=MAX_LINEAS_FLOW) {
  const base=datosPantalla({...foto,tipo:'flow_configurar',version:undefined,lineas:[]});
  for(let l=0;l<numeroLineas;l++) {
    const vacio=Object.fromEntries(Object.entries(base).filter(([k])=>k.startsWith(`l${l}_`)
      || Array.from({length:6},(_,g)=>`g${l*6+g}_`).some(p=>k.startsWith(p))));
    const productos=foto.productos.map((p,i)=>{
      const d=datosPantalla({...foto,tipo:'flow_configurar',version:undefined,
        lineas:Array.from({length:l+1},(_,j)=>j===l?{ficha:p,cantidad:1,seleccion:[]}:null)});
      const payload=Object.fromEntries(Object.keys(vacio).map(k=>[k,d[k]]));
      for(let g=0;g<6;g++)payload[`g${l*6+g}_opciones`]=payload[`g${l*6+g}_opciones`]
        .map(o=>({...o,id:`p${i}g${g}${o.id}`}));
      return {...opcion(`p${i}`,p.nombre,0),metadata:`$${p.precio}`,
        'on-select-action':{name:'update_data',payload}};
    });
    base[`productos${l}`]=l ? [{id:'ninguno',title:'No agregar otro',description:'',metadata:'',
      'on-select-action':{name:'update_data',payload:vacio}},...productos] : productos;
  }
  return base;
}

function comandosContinuos(foto,respuesta) {
  const permitidos=new Set(['flow_token','modalidad','pago']),acciones=[];
  for(let l=0;l<MAX_LINEAS_FLOW;l++) {
    const key=`producto${l}`,v=respuesta[key];permitidos.add(key);
    const indice=typeof v==='string' && /^p(0|[1-9]\d*)$/.test(v)?Number(v.slice(1)):-1;
    const p=foto.productos[indice];
    if(!p && (l===0 || ![null,undefined,'','ninguno'].includes(v)))return null;
    const normalizada={modalidad:respuesta.modalidad,pago:respuesta.pago};
    for(let g=0;g<6;g++)for(const tipo of ['s','m']) {
      const k=`g${l*6+g}_${tipo}`;permitidos.add(k);
      const valor=respuesta[k];
      if(tipo==='m' ? valor!=null && !Array.isArray(valor) : valor!=null && typeof valor!=='string')return null;
      const ids=tipo==='m'?(valor || []):(valor?[valor]:[]);
      if(!p && ids.length)return null;
      const prefijo=`p${indice}g${g}`;
      if(ids.some(id=>typeof id!=='string' || !id.startsWith(prefijo) || !/^o(0|[1-9]\d*)$/.test(id.slice(prefijo.length))))return null;
      normalizada[`g${g}_${tipo}`]=tipo==='m'?ids.map(id=>id.slice(prefijo.length)):(ids[0]?.slice(prefijo.length) || '');
    }
    if(!p)continue;
    const config={...foto,version:undefined,tipo:'flow_configurar',lineas:[{linea_id:'nueva',ficha:p}]};
    const validadas=comandosFormulario(config,normalizada);if(!validadas)return null;
    acciones.push({herramienta:'agregar_producto',argumentos:{producto_id:p.id,cantidad:1}});
    for(const c of validadas.filter(c=>c.herramienta==='modificar_linea')) {
      const {linea_id,...argumentos}=c.argumentos;
      acciones.push({herramienta:c.herramienta,argumentos,lineaNueva:true});
    }
  }
  // Entrega y pago se aplican una sola vez al pedido completo.
  const cierre=comandosFormulario({...foto,version:undefined,tipo:'flow_configurar',lineas:[]},
    {modalidad:respuesta.modalidad,pago:respuesta.pago});
  if(!cierre || Object.keys(respuesta).some(k=>!permitidos.has(k)))return null;
  return [...acciones,...cierre];
}
