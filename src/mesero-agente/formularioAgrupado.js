// Flows es una vista del catálogo: los valores enviados por el cliente no
// contienen nombres, importes ni autoridad. Se resuelven contra la foto guardada.
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fichaPorId, opcionesDeLinea } from './vistaDelPedido.js';
import { productosVendibles } from '../mesero-whatsapp/consultasDelMenu.js';
import { cardinalidadSeleccionable } from '../services/modificadores.js';
import { modalidadesDisponibles, etiquetaTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { tiposDePagoDisponibles, etiquetaTipoPago, descripcionTipoPago } from './politicaDePagos.js';
import { esVerdadero, enElCanario } from '../orders/modoDelPedido.js';
import { aplicarComandosInternos } from './comandosInternosAtomicos.js';
import { leerObservacionesPlatillo } from './observacionesDelPlatillo.js';
import { cantidadFlow } from './catalogoFlowCategorias.js';
import { comandosCarrito } from './flowCarrito.js';
import { atencionGeneralActiva } from './inicioMapo.js';
import { solicitudDeEntrada } from './intencionDeEntrada.js';
import { CONTRATO_DIRECCION,contratoCategorias,contratoCarrito,fotoDireccion,fotoComparable,cierreConDireccion,esDomicilio } from './direccionFormulario.js';
import { CONTRATO_NOTA,notaCategorias,notaCarrito,fotoNota,cierreConNota } from './notaDelPedido.js';
import { VERSION_TIENDA,FLOW_TIENDA_ID,POR_OMISION_TIENDA } from './contratoTienda.js';
import { tiendaParaTelefono } from './disponibilidadTienda.js';
import { motivoSinTienda } from './catalogoFlowTienda.js';

export const ACCIONES_FLOW = ['flow_productos', 'flow_configurar'];
export const MAX_LINEAS_FLOW = 3;
export const GRUPOS_POR_LINEA_FLOW = 6;
const repetibleActivo=cfg=>process.env.WHATSAPP_FLOW_ENDPOINT==='true'
  && !!process.env.WHATSAPP_FLOW_PRIVATE_KEY && !!process.env.META_APP_SECRET
  && /^\d{5,30}$/.test(cfg?.whatsapp_flow_categorias_id || cfg?.whatsapp_flow_repetible_id || '');
const obj = v => v && typeof v === 'object' && !Array.isArray(v);
const precio = v => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
const orden = v => Array.isArray(v) ? v.map(orden) : obj(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,orden(v[k])])) : v;
const igual = (a,b) => isDeepStrictEqual(orden(a),orden(b));
export const flowsActivos = (cfg,telefono) => esVerdadero(cfg?.whatsapp_flows_v1)
  && (atencionGeneralActiva(cfg) || (esVerdadero(cfg?.bot_whatsapp_solo_prueba)
  && enElCanario(telefono,{lista:cfg?.whatsapp_flows_telefonos,porcentaje:0}).dentro));

export function entradaFormulario({estado,cfg,telefono,mensaje}) {
  if(!flowsActivos(cfg,telefono) || estado.carrito?.items?.length || estado.folio || estado.evento || estado.confirmacionIncierta
    || estado.programacionRequerida || Object.values(estado.hechos || {}).some(Boolean))return null;
  // Un saludo no expresa intención de comprar. Menú conserva su vía de
  // imágenes; preguntas y atención humana siguen el canal conversacional.
  const solicitud=solicitudDeEntrada(mensaje);
  if(solicitud?.intencion!=='ordenar')return null;
  // No escribe la modalidad directamente: el ejecutor comprueba evidencia y
  // modalidades habilitadas con las mismas reglas que cualquier otro pedido.
  return {tipo:'entrada_flow',sinSaludo:true,texto:'Elige tus platillos y personalízalos juntos.',
    acciones:solicitud.modalidad?[{herramienta:'definir_entrega',argumentos:{modalidad:solicitud.modalidad}}]:[],
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

// Formulario «tienda» (contrato tienda_v1, bandera whatsapp_flow_tienda_v1):
// con la bandera encendida para este cliente ocupa el lugar de «Arma tu pedido»
// (categorias_v1) y de «Tu carrito» (carrito_v1), si su foto lo admite. Si no,
// sale el formulario de hoy marcado `sin_tienda` con el motivo (la barrera del
// endpoint lo distingue así de uno abierto antes de activarla). Con la bandera
// apagada fotoTienda devuelve null y la foto es, byte a byte, la de hoy.
// `ctx.telefono` decide el modo 'prueba': todos los que recalculan la foto
// (construirFormulario, formularioVigente, aplicarFormulario) lo pasan.
export function fotoFormulario(ctx, accion) {
  const tienda=fotoTienda(ctx,accion);
  if(tienda?.foto)return tienda.foto;
  const hoy=fotoDeHoy(ctx,accion);
  return tienda?.motivo && (hoy?.version==='carrito_v1' || hoy?.presentacion==='categorias_v1') ? {...hoy,sin_tienda:tienda.motivo} : hoy;
}

// Textos de la tienda en el chat (el cuerpo con sus avisos cabe en 1024; el CTA en 30).
export const TEXTOS_TIENDA=Object.freeze({
  // Sin «con fotos»: la carta de Obispado tiene foto en 10 de 76 platillos (3-oct).
  cuerpo:'*Haz tu pedido*\nMira el menú, elige y personaliza tus platillos y toca «Continuar» para elegir entrega y pago. Nada se confirma ni se cobra hasta el resumen.',
  cuerpoCarrito:'*Tu pedido*\nRevisa, cambia o quita platillos, o agrega más desde el menú. Toca «Continuar» para elegir entrega y pago. Nada se confirma ni se cobra hasta el resumen.',
  cta:'Ver menú',ctaCarrito:'Ver mi pedido'});

// → null (la tienda no es para este cliente: nada cambia), {foto} o {motivo}.
function fotoTienda(ctx,accion) {
  const {estado,catalogo,modalidades,metodosPago,cfg,reglas,telefono}=ctx;
  if(!ACCIONES_FLOW.includes(accion) || !tiendaParaTelefono(cfg,telefono))return null;
  const no=motivo=>({motivo});
  const tipo=estado.pendiente?.tipo;
  if(accion==='flow_productos') {
    if(!POR_OMISION_TIENDA.reemplazaArmaTuPedido)return no('no_reemplaza');
    // Hoy tampoco hay formulario para «quiero 3 de…» (fotoDeHoy devuelve null).
    if(tipo==='elegir_producto' && estado.pendiente.cantidad!==1)return no('cantidad_pedida');
  } else {
    if(!POR_OMISION_TIENDA.reemplazaTuCarrito)return no('no_reemplaza');
    // Solo donde hoy sale «Tu carrito»; «Personaliza tu pedido» (legado) sigue igual.
    if(tipo!=='editar_pedido' && cfg?.whatsapp_carrito_unificado_v1!=='true')return no('fuera_del_carrito');
  }
  // El catálogo es el de «Arma tu pedido» por categorías (orden comercial, sin
  // priorizar candidatos). Solo existe con el endpoint (repetibleActivo) y una
  // carta con platillos (hasta 200): sin él no hay tienda.
  const compra=fotoDeHoy({estado:{...estado,pendiente:{tipo:'agregar_otro'}},catalogo,modalidades,metodosPago,cfg,reglas},'flow_productos');
  if(compra?.presentacion!=='categorias_v1')return no('sin_categorias');
  const items=estado.carrito?.items || [];
  const lineas=items.map(item=>{
    const ficha=fichaGuardable(fichaPorId(catalogo,item.id));
    return ficha && {linea_id:item.lid,cantidad:item.cantidad,ficha,seleccion:opcionesDeLinea(item),nota:item.notas || ''};
  });
  if(lineas.some(l=>!l))return no('producto_fuera');
  // No hereda el contrato de «Arma tu pedido»: la tienda siempre lleva el suyo.
  const {contrato,zonas,costo_envio,direccion_inicial,contrato_nota,nota_inicial,presentacion,flowId,...base}=compra;
  const foto={...base,tipo:accion,version:VERSION_TIENDA,flowId:cfg[FLOW_TIENDA_ID],lineas,
    ...fotoDireccion({estado,reglas}),...fotoNota({estado})};
  const motivo=motivoSinTienda(foto,{variosTacos:POR_OMISION_TIENDA.variosTacos});
  if(motivo)return no(motivo);
  // «Escribir dirección»: abre en la dirección (como carrito_v1). Editar, o la
  // dirección con el pago sin elegir («toca Continuar…»): en el carrito.
  if(tipo==='direccion' && esDomicilio(base.modalidad) && base.pago)foto.abrir='DIRECCION';
  else if(['editar_pedido','direccion'].includes(tipo) && lineas.length)foto.abrir='CARRITO';
  return {foto};
}

function fotoDeHoy({estado,catalogo,modalidades,metodosPago,cfg,reglas}, accion) {
  if (accion==='flow_productos') {
    if(estado.pendiente?.tipo==='elegir_producto' && estado.pendiente.cantidad!==1)return null;
    // Es un límite de captura por ventana, NO del carrito del cliente.
    const espacio=MAX_LINEAS_FLOW;
    const categorias=repetibleActivo(cfg) && !!cfg.whatsapp_flow_categorias_id;
    // SQL puede devolver en distinto orden filas empatadas. La presentación
    // conserva orden comercial y desempata por identidad estable, sin mutar
    // el catálogo ni mover tokens entre productos al reconstruir su foto.
    const comparar=(a,b)=>(Number(a.orden)||0)-(Number(b.orden)||0)
      || String(a.id).localeCompare(String(b.id),'es',{numeric:true});
    const carta=categorias?[...catalogo].sort(comparar).map(c=>({...c,productos:[...(c.productos || [])].sort(comparar)})):catalogo;
    let productos=productosVendibles(carta).map(p=>fichaGuardable(fichaPorId(carta,p.id))).filter(Boolean);
    if(categorias) {
      const originales=new Map(productosVendibles(carta).map(p=>[String(p.id),p]));
      productos=productos.map(p=>({...p,categoria:originales.get(p.id).categoria,
        categoriaId:String(originales.get(p.id).categoriaId ?? originales.get(p.id).categoria)}));
    }
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
    // Contrato direccion_v1 (clave propia): la dirección se escribe en el formulario.
    const conDireccion=categorias && contratoCategorias(cfg);
    // Contrato nota_v1 (bandera y flowId propios, solo con dirección): la nota
    // del pedido va en «Entrega y pago». El flowId sigue a la nota: nunca uno sin la otra.
    const conNota=conDireccion && notaCategorias(cfg);
    if(repetibleActivo(cfg))return {tipo:'flow_productos',productos,version:'repetible_v1',
      ...(categorias?{presentacion:'categorias_v1'}:{}),
      flowId:conNota?cfg.whatsapp_flow_categorias_nota_id:conDireccion?cfg.whatsapp_flow_categorias_dir_id
        :cfg.whatsapp_flow_categorias_id || cfg.whatsapp_flow_repetible_id,
      ...datosEntrega({estado,modalidades,metodosPago}),...(conDireccion?fotoDireccion({estado,reglas}):{}),
      ...(conNota?fotoNota({estado}):{})};
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
  if (estado.pendiente?.tipo==='editar_pedido' || cfg?.whatsapp_carrito_unificado_v1==='true') {
    if(repetibleActivo(cfg) && /^\d{5,30}$/.test(cfg?.whatsapp_flow_carrito_id || '') && todas.length<=50) {
      const compra=fotoDeHoy({estado:{...estado,pendiente:{tipo:'agregar_otro'}},catalogo,modalidades,metodosPago,cfg,reglas},'flow_productos');
      if(compra?.presentacion==='categorias_v1' && todas.every(l=>cantidadFlow(String(l.cantidad)) && compra.productos.some(p=>p.id===l.ficha.id))) {
        // El carrito tiene su propio contrato: no hereda el de «Arma tu pedido»
        // (ni su dirección ni su nota).
        const {contrato,zonas,costo_envio,direccion_inicial,contrato_nota,nota_inicial,...base}=compra;
        const conDireccion=contratoCarrito(cfg);
        const conNota=conDireccion && notaCarrito(cfg);
        const entrega=datosEntrega({estado,modalidades,metodosPago});
        return {...base,tipo:'flow_configurar',version:'carrito_v1',flowId:conNota?cfg.whatsapp_flow_carrito_nota_id
          :conDireccion?cfg.whatsapp_flow_carrito_dir_id:cfg.whatsapp_flow_carrito_id,
          ...(cfg.whatsapp_flow_carrito_duplicar_v1==='true'?{duplicar:true}:{}),
          lineas:todas.map((l,i)=>({...l,nota:items[i].notas || ''})),
          ...(conDireccion?fotoDireccion({estado,reglas}):{}),
          ...(conNota?fotoNota({estado}):{}),
          // «Escribir dirección»: solo falta la dirección; el formulario abre en ella.
          ...(conDireccion && estado.pendiente?.tipo==='direccion' && esDomicilio(entrega.modalidad) && entrega.pago?{abrir:'DIRECCION'}:{})};
      }
    }
    if(estado.pendiente?.tipo!=='editar_pedido')return null;
    if (!/^\d{5,30}$/.test(cfg?.whatsapp_flow_editar_id || '') || todas.length>50) return null;
    return {tipo:'flow_configurar',version:'edicion_v1',flowId:cfg.whatsapp_flow_editar_id,
      lineas:todas.map((l,i)=>({...l,nota:items[i].notas || ''})),...datosEntrega({estado,modalidades,metodosPago})};
  }
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
  if(foto.version==='edicion_v1')return datosPantallaEdicion(foto);
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
  // Cada forma de pago se explica en su opción: el 1-oct el dueño salió del
  // formulario para preguntar qué era «enlace de pago». Solo la pantalla; la
  // foto del formulario (y su vigencia) no cambia.
  data.pagos=foto.pagos.map((m,i)=>{const o=opcion(`p${i}`,m.titulo,0);return {...o,description:descripcionTipoPago(m.valor) || o.description};});
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
  const usarCarrito=cfg?.whatsapp_carrito_unificado_v1==='true' && tipo==='agregar_otro' && estado.carrito?.items?.length;
  const accion=usarCarrito || (tipo==='direccion' && contratoCarrito(cfg))?'flow_configurar':['elegir_producto','agregar_otro'].includes(tipo) ? 'flow_productos'
    : ['elegir_opcion','modalidad','pago','configurar_pedido','editar_pedido'].includes(tipo)
      || (!tipo && pedido.aclaraciones?.length) ? 'flow_configurar' : null;
  if (!accion) return null;
  const id=accion==='flow_productos' ? (repetibleActivo(cfg)?cfg.whatsapp_flow_categorias_id || cfg.whatsapp_flow_repetible_id:cfg.whatsapp_flow_pedido_id || cfg.whatsapp_flow_productos_id)
    : tipo==='editar_pedido' ? (repetibleActivo(cfg) && cfg.whatsapp_flow_carrito_id || cfg.whatsapp_flow_editar_id) : cfg.whatsapp_flow_configurar_id;
  const foto=fotoFormulario({estado,cfg,telefono,...ctx},accion);
  // La pregunta de dirección solo cambia a formulario si este la captura (carrito
  // con contrato direccion_v1). Sin carrito unificado la foto sería el legado
  // «Personaliza tu pedido», sin dirección: la pregunta vuelve al texto de siempre.
  if (tipo==='direccion' && foto?.contrato!==CONTRATO_DIRECCION) return null;
  if (!/^\d{5,30}$/.test(foto?.flowId || id || '')) return null;
  if (!foto || ((accion==='flow_configurar' || foto.version) && (!foto.modalidades.length || !foto.pagos.length))) return null;
  const token=`xb1:${randomBytes(16).toString('base64url')}`;
  // La pregunta de dirección con el pago todavía sin elegir no puede abrir en la
  // dirección (el carrito la valida con entrega y pago): dice qué hacer.
  const pideDireccion=tipo==='direccion' && foto.contrato===CONTRATO_DIRECCION;
  let cuerpo=aviso+(foto.abrir==='DIRECCION' ? '*Dirección de entrega*\nEscríbela en el formulario: calle, colonia y referencias. Después revisarás tu pedido.'
    : pideDireccion ? '*Dirección de entrega*\nEn el formulario toca «Continuar», elige la forma de pago y enseguida escribes la dirección.'
    // Con el contrato el carrito ya no tiene entrega y pago: van en el paso siguiente.
    : foto.version===VERSION_TIENDA ? (foto.abrir==='CARRITO' ? TEXTOS_TIENDA.cuerpoCarrito : TEXTOS_TIENDA.cuerpo)
    : foto.version==='carrito_v1' && foto.contrato===CONTRATO_DIRECCION
      ? '*Tu carrito*\nAjusta cantidades, quita o agrega platillos y toca «Continuar» para elegir entrega y pago. Nada se confirma ni se cobra hasta el resumen.'
    : accion==='flow_productos'
    ? foto.version==='repetible_v1' ? '*Arma tu pedido*\nElige y personaliza un platillo. Usa «Agregar más» para seguir o «ORDEN COMPLETA» cuando termines, sin salir de la ventana.'
      : foto.version ? '*Arma tu pedido*\nElige y personaliza hasta tres platillos sin salir de esta ventana. Puedes agregar más después.'
      : '*Arma tu pedido*\nElige tus platillos en una sola pantalla. Después podrás personalizarlos.'
    : foto.version==='carrito_v1' ? '*Tu carrito*\nAjusta cantidades, quita varios platillos o agrega más sin salir de la ventana. Guardar no confirma ni cobra.'
    : foto.version==='edicion_v1' ? '*Edita tu pedido*\nCambia cantidades, opciones o elimina un platillo. Conservaremos los demás. También puedes ajustar entrega y pago.'
    : '*Personaliza tu pedido*\nCompleta las opciones de tus platillos y elige entrega y pago en una sola pantalla. Después revisarás el total.');
  // Con el contrato direccion_v1 la dirección también va en el formulario.
  if(foto.contrato===CONTRATO_DIRECCION && !pideDireccion)cuerpo+='\nSi es a domicilio, ahí mismo escribes la dirección.';
  // Contrato nota_v1: que sepa dónde va una dedicatoria antes de pedírsela a una persona.
  if(foto.contrato_nota===CONTRATO_NOTA && !pideDireccion)cuerpo+='\nPara una dedicatoria o indicaciones, usa «Nota del pedido» en «Entrega y pago».';
  return {preguntaId:randomUUID(),ciclo:estado.conversacionId,dialogoId:estado.dialogo.id,
    huella:pedido.huella,total:pedido.total,
    botones:[{token,accion,title:'Formulario',datos:foto}],texto:cuerpo,
    textoFallback:'El formulario no está disponible en este momento. Conservo tu pedido; puedes pedir ayuda a una persona.',
    carga:{type:'flow',body:{text:cuerpo},action:{name:'flow',parameters:{flow_message_version:'3',
      flow_token:token,flow_id:foto.flowId || id,flow_cta:foto.abrir==='DIRECCION'?'Escribir dirección'
        :foto.version===VERSION_TIENDA?(foto.abrir==='CARRITO'?TEXTOS_TIENDA.ctaCarrito:TEXTOS_TIENDA.cta):foto.version==='carrito_v1'?'Abrir carrito':accion==='flow_productos'?'Elegir platillos':'Personalizar pedido',
      ...(['repetible_v1','carrito_v1',VERSION_TIENDA].includes(foto.version) ? {flow_action:'data_exchange'}
        : {flow_action:'navigate',flow_action_payload:{screen:accion==='flow_productos'?'PRODUCTOS':'PEDIDO',data:datosPantalla(foto)}})}}}};
}

export function formularioVigente(asociacion,ctx) {
  // Activar el nuevo recorrido no invalida una respuesta agrupada que ya
  // estaba en manos del cliente. Se mantienen las demás comprobaciones de
  // vigencia, catálogo, cantidades y precios; la foto viene de SQL, no de él.
  const legacy=asociacion?.accion==='flow_configurar' && !asociacion.datos?.version;
  const contexto=legacy?{...ctx,cfg:{...ctx.cfg,whatsapp_carrito_unificado_v1:'false'}}:ctx;
  // «abrir» solo elige la primera pantalla (la pregunta pendiente ya cambió al
  // enviarlo) y la precarga de la dirección no es el pedido: fotoComparable.
  return ACCIONES_FLOW.includes(asociacion?.accion)
    && igual(fotoComparable(asociacion.datos),fotoComparable(fotoFormulario(contexto,asociacion.accion)));
}

// La primera pantalla selecciona un renglón de la foto persistida; navegar a
// la segunda inicializa sus opciones y nota. No se reconstruye una lista para
// resolver el índice ni se aplican cambios hasta recibir la respuesta completa.
export function datosPantallaEdicion(foto) {
  const bloque=(linea,i)=>{
    const d=datosPantalla({...foto,version:undefined,lineas:linea?[linea]:[]});
    const datos=Object.fromEntries(Object.entries(d).filter(([k])=>k.startsWith('l0_') || /^g[0-5]_/.test(k)
      || ['modalidades','pagos','modalidad_inicial','pago_inicial'].includes(k)));
    datos.linea=linea?`l${i}`:'pedido';datos.observaciones_inicial=linea?.nota || '';
    datos.cantidad_inicial=linea?String(linea.cantidad):'';
    datos.l0_titulo=linea?`${i+1}. ${linea.cantidad} × ${linea.ficha.nombre}`:'Entrega y pago';
    for(let g=0;g<6;g++) {
      const prefijo=`l${i}g${g}`;
      datos[`g${g}_opciones`]=datos[`g${g}_opciones`].map(o=>({...o,id:prefijo+o.id}));
      datos[`g${g}_inicial_s`]=datos[`g${g}_inicial_s`]?prefijo+datos[`g${g}_inicial_s`]:'';
      datos[`g${g}_inicial_m`]=datos[`g${g}_inicial_m`].map(id=>prefijo+id);
    }
    return datos;
  };
  const lineas=foto.lineas.map((l,i)=>({id:`l${i}`,title:`${i+1}. ${l.cantidad} × ${l.ficha.nombre}`.slice(0,30),
    description:[l.ficha.nombre,...l.seleccion.map(o=>o.opcion),l.nota].filter(Boolean).join(' · ').slice(0,300),metadata:'',
    'on-select-action':{name:'update_data',payload:bloque(l,i)}}));
  lineas.push({id:'pedido',title:'Entrega y pago',description:'Sin modificar los platillos',metadata:'',
    'on-select-action':{name:'update_data',payload:bloque(null,-1)}});
  return {...bloque(null,-1),lineas};
}

function comandosEdicion(foto,respuesta) {
  const i=typeof respuesta.linea==='string' && /^l(0|[1-9]\d*)$/.test(respuesta.linea)?Number(respuesta.linea.slice(1)):-1;
  const linea=foto.lineas[i];
  if(!linea && respuesta.linea!=='pedido')return null;
  // Eliminar es una acción independiente, no una cantidad cero ni opciones
  // vacías. Su pantalla de confirmación no envía ingredientes, pago o notas.
  if(respuesta.operacion==='eliminar') {
    if(!linea || respuesta.confirmar_eliminacion!==true
      || Object.keys(respuesta).some(k=>!['flow_token','linea','operacion','confirmar_eliminacion'].includes(k)))return null;
    return [{herramienta:'quitar_linea',argumentos:{linea_id:linea.linea_id}}];
  }
  if(respuesta.operacion!==undefined && respuesta.operacion!=='editar')return null;
  const permitidos=new Set(['flow_token','linea','modalidad','pago','observaciones','cantidad','operacion']);
  for(let g=0;g<6;g++)for(const t of ['s','m'])permitidos.add(`g${g}_${t}`);
  if(Object.keys(respuesta).some(k=>!permitidos.has(k)))return null;
  const cantidad=respuesta.cantidad===undefined?undefined:cantidadFlow(respuesta.cantidad);
  if(linea ? respuesta.cantidad!==undefined && !cantidad : ![undefined,null,''].includes(respuesta.cantidad))return null;
  const normalizada={modalidad:respuesta.modalidad,pago:respuesta.pago};
  for(let g=0;g<6;g++)for(const tipo of ['s','m']) {
    const valor=respuesta[`g${g}_${tipo}`],prefijo=`l${i}g${g}`;
    if(tipo==='m'?valor!=null && !Array.isArray(valor):valor!=null && typeof valor!=='string')return null;
    const ids=tipo==='m'?(valor || []):(valor?[valor]:[]);
    if(ids.length && !linea)return null;
    if(ids.some(id=>typeof id!=='string' || !id.startsWith(prefijo) || !/^o(0|[1-9]\d*)$/.test(id.slice(prefijo.length))))return null;
    normalizada[`g${g}_${tipo}`]=tipo==='m'?ids.map(id=>id.slice(prefijo.length)):(ids[0]?.slice(prefijo.length) || '');
  }
  const nota=leerObservacionesPlatillo(respuesta.observaciones);
  if(nota===null || (!linea && nota))return null;
  const comandos=comandosFormulario({...foto,version:undefined,lineas:linea?[linea]:[]},normalizada);
  if(!comandos)return null;
  // Omitir el campo no borra una nota. Una cadena vacía sí es una elección
  // explícita del formulario; se guarda junto a las opciones, atómicamente.
  if(linea && Object.hasOwn(respuesta,'observaciones') && respuesta.observaciones!==null)
    comandos.push({herramienta:'modificar_linea',argumentos:{linea_id:linea.linea_id,nota}});
  if(linea && cantidad!==undefined && cantidad!==linea.cantidad)
    comandos.push({herramienta:'modificar_linea',argumentos:{linea_id:linea.linea_id,cantidad}});
  return comandos;
}

// Valida TODO antes de proponer una sola mutación. Campos desconocidos,
// selecciones de grupos ocultos, índices falsos y cardinalidad incorrecta fallan.
export function comandosFormulario(foto,respuesta) {
  if (!obj(respuesta)) return null;
  // La tienda devuelve el mismo recibo que «Tu carrito» (filas eN/nN, entrega, dirección y nota).
  if(foto.version==='carrito_v1' || foto.version===VERSION_TIENDA)return comandosCarrito(foto,respuesta);
  if(foto.version==='edicion_v1')return comandosEdicion(foto,respuesta);
  if(foto.version==='repetible_v1') {
    if(Object.keys(respuesta).some(k=>!['flow_token','items','modalidad','pago',...(foto.contrato===CONTRATO_DIRECCION?['direccion']:[]),
      ...(foto.contrato_nota===CONTRATO_NOTA?['nota']:[])].includes(k))
      || !Array.isArray(respuesta.items) || !respuesta.items.length || respuesta.items.length>50)return null;
    const acciones=[];
    for(const item of respuesta.items) {
      if(!obj(item) || Object.keys(item).some(k=>!/^producto0$|^g[0-5]_[sm]$|^observaciones$/.test(k)
        && !(foto.presentacion==='categorias_v1' && k==='cantidad')))return null;
      const {observaciones,cantidad,...seleccion}=item;
      const unidades=cantidad===undefined?1:cantidadFlow(cantidad);if(!unidades)return null;
      const nota=leerObservacionesPlatillo(observaciones);if(nota===null)return null;
      const comandos=comandosContinuos({...foto,version:'continuo_v1'},
        {...seleccion,modalidad:respuesta.modalidad,pago:respuesta.pago});
      if(!comandos)return null;
      acciones.push(...comandos.filter(c=>!['definir_entrega','definir_pago'].includes(c.herramienta)).map(c=>
        c.herramienta==='agregar_producto'?{...c,argumentos:{...c.argumentos,cantidad:unidades}}:c));
      if(nota)acciones.push({herramienta:'modificar_linea',argumentos:{nota},lineaNueva:true});
    }
    const cierre=cierreConNota(foto,cierreConDireccion(foto,comandosFormulario({...foto,version:undefined,tipo:'flow_configurar',lineas:[]},
      {modalidad:respuesta.modalidad,pago:respuesta.pago}),respuesta.direccion),respuesta.nota);
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
  return aplicarComandosInternos(comandos,ctx,{cerrarEleccion:reserva.accion==='flow_configurar'
    || ['continuo_v1','repetible_v1',VERSION_TIENDA].includes(reserva.datos.version)});
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
