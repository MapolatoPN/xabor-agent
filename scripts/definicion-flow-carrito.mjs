import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { definicionFlowEditar } from './definicion-flow-editar.mjs';
import { FILAS_PAGINA_CARRITO } from '../src/mesero-agente/flowCarrito.js';
import { MAX_CANTIDAD_FLOW } from '../src/mesero-agente/catalogoFlowCategorias.js';
const dato=k=>'${data.'+k+'}',campo=k=>'${form.'+k+'}';
const str=(v='')=>({type:'string',__example__:v}),bool=()=>({type:'boolean',__example__:true});
const lista={type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'}}},__example__:[{id:'e0',title:'Platillo'}]};

// Artefacto local. No crea, publica ni activa un Flow en Meta.
export function definicionFlowCarrito({duplicar=false}={}) {
  const base=definicionFlowCategorias(),screens=base.screens.filter(s=>s.id!=='ENTREGA');
  const data={revision:str('0'),resumen:str('Tu carrito'),importe:str(),error:str(),error_visible:bool(),
    pagina_inicial:str('p0'),paginas:structuredClone(lista),editar:structuredClone(lista),hay_items:bool(),puede_deshacer:bool(),puede_agregar:bool(),
    modalidades:structuredClone(lista),pagos:structuredClone(lista),modalidad_inicial:str('m0'),pago_inicial:str('p0')};
  const init={pagina:dato('pagina_inicial'),modalidad:dato('modalidad_inicial'),pago:dato('pago_inicial')};
  const payload={revision:dato('revision'),modalidad:campo('modalidad'),pago:campo('pago')};
  const children=[{type:'TextSubheading',text:dato('resumen')},{type:'TextBody',text:dato('error'),visible:dato('error_visible')},
    {type:'TextBody',text:'Cambia varias cantidades a la vez. Elige 0 · Quitar para retirar un renglón. Guardar aplica todos los cambios juntos.'}];
  for(let i=0;i<FILAS_PAGINA_CARRITO;i++) {
    data[`r${i}_visible`]=bool();data[`r${i}_titulo`]=str('Platillo');data[`r${i}_detalle`]=str();data[`q${i}_inicial`]=str('1');
    init[`q${i}`]=dato(`q${i}_inicial`);payload[`q${i}`]=campo(`q${i}`);
    children.push({type:'TextBody',text:dato(`r${i}_titulo`),'font-weight':'bold',visible:dato(`r${i}_visible`)},
      {type:'TextCaption',text:dato(`r${i}_detalle`),visible:dato(`r${i}_visible`)},
      {type:'Dropdown',name:`q${i}`,label:'Cantidad',required:dato(`r${i}_visible`),visible:dato(`r${i}_visible`),
        'data-source':Array.from({length:MAX_CANTIDAD_FLOW+1},(_,q)=>({id:String(q),title:q?String(q):'0 · Quitar'}))});
  }
  children.push({type:'Dropdown',name:'pagina',label:'Ver página',required:false,'data-source':dato('paginas'),
    'on-select-action':{name:'data_exchange',payload:{...payload,operacion:'pagina',pagina:campo('pagina')}}},
    {type:'Dropdown',name:'editar',label:'Preparación y notas',required:false,visible:dato('hay_items'),'data-source':dato('editar'),
      'on-select-action':{name:'data_exchange',payload:{...payload,operacion:'editar',editar:campo('editar')}}},
    {type:'Dropdown',name:'modalidad',label:'Entrega',required:false,'data-source':dato('modalidades')},
    {type:'Dropdown',name:'pago',label:'Forma de pago',required:false,'data-source':dato('pagos')},
    {type:'TextCaption',text:dato('importe')},
    {type:'EmbeddedLink',text:'Agregar más platillos',visible:dato('puede_agregar'),'on-click-action':{name:'data_exchange',payload:{...payload,operacion:'agregar'}}},
    {type:'EmbeddedLink',text:'Deshacer último cambio',visible:dato('puede_deshacer'),'on-click-action':{name:'data_exchange',payload:{revision:dato('revision'),operacion:'deshacer'}}},
    {type:'TextCaption',text:'Cerrar no cambia tu pedido. Guardar no confirma ni cobra. Después verás el total actualizado.'},
    {type:'Footer',label:'Guardar cambios','on-click-action':{name:'data_exchange',payload:{...payload,operacion:'guardar'}}});
  const carrito={id:'CARRITO',title:'Tu carrito',terminal:true,refresh_on_back:true,data,
    layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form','init-values':init,children}]}};
  if(duplicar) {
    data.puede_duplicar=bool();
    init.duplicar='';
    const lugar=children.findIndex(c=>c.name==='modalidad');
    children.splice(lugar,0,{type:'Dropdown',name:'duplicar',label:'Otro igual (1 pieza)',required:false,
      visible:dato('puede_duplicar'),'data-source':dato('editar'),
      'on-select-action':{name:'data_exchange',payload:{...payload,operacion:'duplicar',duplicar:campo('duplicar')}}});
  }
  const editar=definicionFlowEditar().screens.find(s=>s.id==='EDITAR');
  editar.terminal=false;editar.refresh_on_back=true;
  Object.assign(editar.data,{revision:str('0'),error:str(),error_visible:bool()});
  const form=editar.layout.children[0];
  delete form['init-values'].modalidad;delete form['init-values'].pago;
  form.children=form.children.filter(c=>!['modalidad','pago'].includes(c.name) && c.text!=='Para todo el pedido' && c.type!=='Footer'
    && !String(c.text).startsWith('Guardar no confirma'));
  form.children.unshift({type:'TextBody',text:dato('error'),visible:dato('error_visible')});
  const opcion={revision:dato('revision'),operacion:'aplicar_opciones',cantidad:campo('cantidad'),observaciones:campo('observaciones')};
  for(let g=0;g<6;g++)for(const t of ['s','m'])opcion[`g${g}_${t}`]=campo(`g${g}_${t}`);
  form.children.push({type:'Footer',label:'Volver al carrito','on-click-action':{name:'data_exchange',payload:opcion}});
  for(const s of screens) {
    const form=s.layout.children[0];
    const footer=form.children.find(c=>c.type==='Footer');if(footer)footer.label=s.id==='MENU'?'Ver carrito':'Agregar al carrito';
    for(const c of form.children)if(c.type==='TextCaption' && String(c.text).startsWith('ORDEN COMPLETA'))c.text='Puedes seguir agregando y editar antes de guardar el carrito.';
  }
  // Árbol de navegación; los regresos a ancestros usan el mismo endpoint y
  // refresh_on_back. No se dibujan ciclos en routing_model.
  return {...base,routing_model:{CARRITO:['MENU','EDITAR'],MENU:['TACOS','PLATILLO'],TACOS:['PLATILLO'],PLATILLO:[],EDITAR:[]},
    screens:[carrito,...screens,editar]};
}
