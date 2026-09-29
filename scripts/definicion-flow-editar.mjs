import { definicionConfigurar } from './definicion-flows-pedido.mjs';
import { MAX_OBSERVACIONES_PLATILLO } from '../src/mesero-agente/observacionesDelPlatillo.js';
import { MAX_CANTIDAD_FLOW } from '../src/mesero-agente/catalogoFlowCategorias.js';
const dato=k=>'${data.'+k+'}';
const string=(v='')=>({type:'string',__example__:v});
const sinEjemplo=v=>Array.isArray(v)?v.map(sinEjemplo):v && typeof v==='object'
  ? Object.fromEntries(Object.entries(v).filter(([k])=>k!=='__example__').map(([k,x])=>[k,sinEjemplo(x)])):v;

// Elegir renglón → editar O confirmar eliminación, en la misma ventana.
// La pantalla de eliminación no contiene campos obligatorios de preparación.
export function definicionFlowEditar() {
  const base=definicionConfigurar().screens[0],form=base.layout.children[0];
  const keys=Object.keys(base.data).filter(k=>k.startsWith('l0_') || /^g[0-5]_/.test(k)
    || ['modalidades','pagos','modalidad_inicial','pago_inicial'].includes(k));
  const data={...Object.fromEntries(keys.map(k=>[k,base.data[k]])),linea:string('pedido'),observaciones_inicial:string(),cantidad_inicial:string('1')};
  const payload=Object.fromEntries(Object.keys(data).map(k=>[k,dato(k)]));
  const properties=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,sinEjemplo(v)]));
  const ejemplo=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.__example__]));
  const lista={type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},
    description:{type:'string'},metadata:{type:'string'},'on-select-action':{type:'object',properties:{
      name:{const:'update_data'},payload:{type:'object',properties}}}}},__example__:[{id:'pedido',
    title:'Entrega y pago',description:'Sin modificar los platillos',metadata:'',
    'on-select-action':{name:'update_data',payload:ejemplo}}]};
  const abrirEditor={type:'Footer',label:'Editar selección','on-click-action':{name:'navigate',next:{type:'screen',name:'EDITAR'},payload}};
  const elegir={id:'PEDIDO',title:'¿Qué deseas cambiar?',data:{...data,lineas:lista},
    layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form','init-values':{operacion:'editar'},children:[
      {type:'TextBody',text:'Elige un platillo para cambiar su cantidad, opciones o eliminarlo. Los demás se conservan.'},
      {type:'Dropdown',name:'seleccion',label:'Cambiar',required:true,'data-source':dato('lineas')},
      {type:'RadioButtonsGroup',name:'operacion',label:'¿Qué deseas hacer?',visible:dato('l0_visible'),required:false,
        'data-source':[{id:'editar',title:'Editar cantidad y opciones'},{id:'eliminar',title:'Eliminar este platillo'}]},
      {type:'If',condition:dato('l0_visible'),then:[{type:'If',condition:"${form.operacion} == 'eliminar'",then:[
        {type:'Footer',label:'Revisar eliminación','on-click-action':{name:'navigate',next:{type:'screen',name:'ELIMINAR'},
          payload:{linea:dato('linea'),l0_titulo:dato('l0_titulo')}}},
      ],else:[abrirEditor]}],else:[abrirEditor]},
    ]}]}};
  const children=form.children.filter(c=>/^g[0-5]_[sm]$/.test(c.name || '') || ['modalidad','pago'].includes(c.name)
    || c.text==='Para todo el pedido' || c.text===dato('l0_precio'));
  children.unshift({type:'TextBody',text:dato('l0_titulo')},
    {type:'Dropdown',name:'cantidad',label:'Cantidad',visible:dato('l0_visible'),required:dato('l0_visible'),
      'data-source':Array.from({length:MAX_CANTIDAD_FLOW},(_,i)=>({id:String(i+1),title:String(i+1)}))},
    {type:'TextCaption',text:'La cantidad comparte preparación y nota.',visible:dato('l0_visible')});
  const pos=children.findIndex(c=>c.text==='Para todo el pedido');
  children.splice(pos,0,{type:'TextArea',name:'observaciones',label:'Nota para cocina',required:false,
    'max-length':MAX_OBSERVACIONES_PLATILLO,visible:dato('l0_visible')});
  const respuesta={linea:dato('linea'),operacion:'editar',cantidad:'${form.cantidad}',observaciones:'${form.observaciones}'};
  for(const name of [...Array.from({length:6},(_,i)=>[`g${i}_s`,`g${i}_m`]).flat(),'modalidad','pago'])respuesta[name]='${form.'+name+'}';
  children.push({type:'TextCaption',text:'Guardar no confirma ni cobra. Revisarás el total actualizado en el chat.'},
    {type:'Footer',label:'Guardar cambios','on-click-action':{name:'complete',payload:respuesta}});
  const editar={id:'EDITAR',title:'Edita tu pedido',terminal:true,data,layout:{type:'SingleColumnLayout',children:[{
    type:'Form',name:'form','init-values':{...Object.fromEntries(Object.entries(form['init-values']).filter(([k])=>/^g[0-5]_[sm]$/.test(k)
      || ['modalidad','pago'].includes(k))),observaciones:dato('observaciones_inicial'),cantidad:dato('cantidad_inicial')},children}]}};
  const eliminar={id:'ELIMINAR',title:'Eliminar platillo',terminal:true,
    data:{linea:string('l0'),l0_titulo:string('1. 2 × Chilaquiles')},layout:{type:'SingleColumnLayout',children:[
      {type:'TextHeading',text:'¿Eliminar este platillo?'},
      {type:'TextBody',text:dato('l0_titulo')},
      {type:'TextBody',text:'Se quitarán todas las piezas de este renglón. Los demás platillos se conservan y el total se recalcula.'},
      {type:'TextCaption',text:'Para conservarlo, vuelve con la flecha. El pedido no se confirma ni se cobra.'},
      {type:'Footer',label:'Sí, eliminar platillo','on-click-action':{name:'complete',payload:{
        linea:dato('linea'),operacion:'eliminar',confirmar_eliminacion:true}}},
    ]}};
  return {version:'7.3',routing_model:{PEDIDO:['EDITAR','ELIMINAR'],EDITAR:[],ELIMINAR:[]},screens:[elegir,editar,eliminar]};
}
