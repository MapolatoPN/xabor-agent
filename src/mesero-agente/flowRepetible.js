// Borrador de una ventana, sin efectos en carrito, pedidos, pagos ni cocina.
// El almacenamiento y las barreras de sesión se resuelven en el adaptador SQL.
import { comandosFormulario,datosPantallaContinua } from './formularioAgrupado.js';

export const MAX_PLATILLOS_FLOW = 50; // Protección de tamaño; NO tres espacios fijos.
const objeto=v=>v && typeof v==='object' && !Array.isArray(v);
const campo=k=>/^producto0$|^g[0-5]_[sm]$/.test(k);
export const borradorInicial=()=>({revision:0,etapa:'PLATILLO',items:[]});

function valido(foto,items,modalidad='m0',pago='p0') {
  return comandosFormulario({...foto,version:'repetible_v1'},{items,modalidad,pago})!==null;
}

export function cambiarBorrador(foto,anterior,solicitud) {
  const actual=structuredClone(anterior),d=solicitud.data;
  if(solicitud.action==='INIT' || solicitud.action==='BACK')return {borrador:actual};
  if(solicitud.action!=='data_exchange' || !objeto(d))return {borrador:actual,error:'No pude leer la selección. Intenta de nuevo.'};
  if(String(actual.revision)!==d.revision || solicitud.screen!==actual.etapa)
    return {borrador:actual,error:'La ventana cambió. Conservamos tus platillos; revisa la selección actual.'};
  if(actual.etapa==='FINAL')return {borrador:actual};
  if(actual.etapa==='PLATILLO') {
    if(!['agregar','terminar'].includes(d.operacion)
      || Object.keys(d).some(k=>!campo(k) && !['revision','operacion'].includes(k)))
      return {borrador:actual,error:'Esa selección no está disponible.'};
    const item=Object.fromEntries(Object.entries(d).filter(([k])=>campo(k)));
    const vacio=Object.values(item).every(v=>v==null || v==='' || (Array.isArray(v) && v.length===0));
    // Después de Agregar más, se puede terminar sin inventar otro platillo.
    if(!(vacio && actual.items.length && d.operacion==='terminar')) {
      if(actual.items.length>=MAX_PLATILLOS_FLOW)return {borrador:actual,error:'Esta ventana llegó a 50 platillos. Pulsa ORDEN COMPLETA para revisar lo agregado.'};
      if(!valido(foto,[item]))return {borrador:actual,error:'Completa las opciones del platillo antes de continuar.'};
      actual.items.push(item);
    }
    actual.etapa=d.operacion==='terminar'?'ENTREGA':'PLATILLO';
  } else if(actual.etapa==='ENTREGA') {
    if(d.operacion!=='revisar' || Object.keys(d).some(k=>!['revision','operacion','modalidad','pago'].includes(k))
      || !valido(foto,actual.items,d.modalidad,d.pago))
      return {borrador:actual,error:'Elige entrega y forma de pago para revisar tu pedido.'};
    actual.modalidad=d.modalidad;actual.pago=d.pago;actual.etapa='FINAL';
  } else return {borrador:actual,error:'La ventana no está disponible.'};
  actual.revision++;
  return {borrador:actual};
}

export function respuestaBorrador(foto,borrador,flowToken,error='',seleccion=null) {
  if(borrador.etapa==='FINAL')return {screen:'SUCCESS',data:{extension_message_response:{params:{
    flow_token:flowToken,revision:String(borrador.revision)}}}};
  const d=datosPantallaContinua({...foto,version:'continuo_v1'},1);
  const data={revision:String(borrador.revision),error,error_visible:!!error,
    resumen:borrador.items.length ? `${borrador.items.length} platillo${borrador.items.length===1?'':'s'} agregado${borrador.items.length===1?'':'s'}.` : 'Elige y personaliza tu primer platillo.'};
  if(borrador.etapa==='ENTREGA') {
    for(const k of ['modalidades','pagos','modalidad_inicial','pago_inicial'])data[k]=d[k];
  } else {
    // Solo viaja UN selector, no tres copias del catálogo.
    for(const [k,v] of Object.entries(d))if(k==='productos0' || k.startsWith('l0_') || /^g[0-5]_/.test(k))data[k]=v;
    data.producto_inicial='';
    data.puede_agregar=borrador.items.length<MAX_PLATILLOS_FLOW;
    data.puede_elegir=data.puede_agregar;
    // Un error no borra lo que sí eligió el cliente. Una respuesta a una
    // revisión vieja tampoco restaura selecciones de otro paso.
    if(error && seleccion?.revision===String(borrador.revision)) {
      const p=data.productos0.find(p=>p.id===seleccion.producto0);
      if(p) {
        Object.assign(data,p['on-select-action'].payload);data.producto_inicial=p.id;
        for(let g=0;g<6;g++) {
          const ids=new Set(data[`g${g}_opciones`].map(o=>o.id));
          if(data[`g${g}_simple`] && ids.has(seleccion[`g${g}_s`]))data[`g${g}_inicial_s`]=seleccion[`g${g}_s`];
          if(data[`g${g}_multiple`] && Array.isArray(seleccion[`g${g}_m`]))data[`g${g}_inicial_m`]=
            [...new Set(seleccion[`g${g}_m`].filter(o=>ids.has(o)))].slice(0,data[`g${g}_max`]);
        }
      }
    }
  }
  return {screen:borrador.etapa,data};
}
