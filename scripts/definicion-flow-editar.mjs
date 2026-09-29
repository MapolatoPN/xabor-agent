import { definicionConfigurar } from './definicion-flows-pedido.mjs';
import { MAX_OBSERVACIONES_PLATILLO } from '../src/mesero-agente/observacionesDelPlatillo.js';
const dato=k=>'${data.'+k+'}';
const string=(v='')=>({type:'string',__example__:v});
const sinEjemplo=v=>Array.isArray(v)?v.map(sinEjemplo):v && typeof v==='object'
  ? Object.fromEntries(Object.entries(v).filter(([k])=>k!=='__example__').map(([k,x])=>[k,sinEjemplo(x)])):v;

// Dos pantallas dentro de la misma ventana: elegir renglón → editar con sus
// valores actuales. Guardar NO confirma el pedido. No necesita un endpoint nuevo.
export function definicionFlowEditar() {
  const base=definicionConfigurar().screens[0],form=base.layout.children[0];
  const keys=Object.keys(base.data).filter(k=>k.startsWith('l0_') || /^g[0-5]_/.test(k)
    || ['modalidades','pagos','modalidad_inicial','pago_inicial'].includes(k));
  const data={...Object.fromEntries(keys.map(k=>[k,base.data[k]])),linea:string('pedido'),observaciones_inicial:string()};
  const payload=Object.fromEntries(Object.keys(data).map(k=>[k,dato(k)]));
  const properties=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,sinEjemplo(v)]));
  const ejemplo=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.__example__]));
  const lista={type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},
    description:{type:'string'},metadata:{type:'string'},'on-select-action':{type:'object',properties:{
      name:{const:'update_data'},payload:{type:'object',properties}}}}},__example__:[{id:'pedido',
    title:'Entrega y pago',description:'Sin modificar los platillos',metadata:'',
    'on-select-action':{name:'update_data',payload:ejemplo}}]};
  const elegir={id:'PEDIDO',title:'¿Qué deseas cambiar?',data:{...data,lineas:lista},
    layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form',children:[
      {type:'TextBody',text:'Elige un platillo o los datos de entrega y pago. Los demás platillos se conservan.'},
      {type:'Dropdown',name:'seleccion',label:'Cambiar',required:true,'data-source':dato('lineas')},
      {type:'Footer',label:'Editar selección','on-click-action':{name:'navigate',next:{type:'screen',name:'EDITAR'},payload}},
    ]}]}};
  const children=form.children.filter(c=>/^g[0-5]_[sm]$/.test(c.name || '') || ['modalidad','pago'].includes(c.name)
    || c.text==='Para todo el pedido' || c.text===dato('l0_precio'));
  children.unshift({type:'TextBody',text:dato('l0_titulo')});
  const pos=children.findIndex(c=>c.text==='Para todo el pedido');
  children.splice(pos,0,{type:'TextArea',name:'observaciones',label:'Nota para cocina',required:false,
    'max-length':MAX_OBSERVACIONES_PLATILLO,visible:dato('l0_visible')});
  const respuesta={linea:dato('linea'),observaciones:'${form.observaciones}'};
  for(const name of [...Array.from({length:6},(_,i)=>[`g${i}_s`,`g${i}_m`]).flat(),'modalidad','pago'])respuesta[name]='${form.'+name+'}';
  children.push({type:'TextCaption',text:'Guardar no confirma ni cobra. Revisarás el total actualizado en el chat.'},
    {type:'Footer',label:'Guardar cambios','on-click-action':{name:'complete',payload:respuesta}});
  const editar={id:'EDITAR',title:'Edita tu pedido',terminal:true,data,layout:{type:'SingleColumnLayout',children:[{
    type:'Form',name:'form','init-values':{...Object.fromEntries(Object.entries(form['init-values']).filter(([k])=>/^g[0-5]_[sm]$/.test(k)
      || ['modalidad','pago'].includes(k))),observaciones:dato('observaciones_inicial')},children}]}};
  return {version:'7.3',routing_model:{PEDIDO:['EDITAR'],EDITAR:[]},screens:[elegir,editar]};
}
