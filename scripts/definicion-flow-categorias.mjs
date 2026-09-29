import { definicionFlowRepetible } from './definicion-flow-repetible.mjs';
import { MAX_TACOS_LOTE,MAX_CANTIDAD_FLOW } from '../src/mesero-agente/catalogoFlowCategorias.js';
const dato=k=>'${data.'+k+'}',campo=k=>'${form.'+k+'}';
const str=(v='')=>({type:'string',__example__:v}),bool=()=>({type:'boolean',__example__:false});
const lista={type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'}}},__example__:[{id:'c0',title:'Categoría'}]};
export function definicionFlowCategorias() {
  const f=definicionFlowRepetible(),[p,entrega]=f.screens,form=p.layout.children[0];
  p.data.categoria_nombre=str('Categoría');p.data.cantidad_inicial=str('1');
  const acciones=p.data.productos0.items.properties['on-select-action'].properties.payload.properties;
  for(const k of ['observaciones_inicial','cantidad_inicial'])acciones[k]={type:'string'};
  p.data.productos0.__example__[0]['on-select-action'].payload.observaciones_inicial='';
  p.data.productos0.__example__[0]['on-select-action'].payload.cantidad_inicial='1';
  form['init-values'].cantidad=dato('cantidad_inicial');
  form.children.splice(2,0,{type:'TextSubheading',text:dato('categoria_nombre')});
  const indice=form.children.findIndex(c=>c.name==='observaciones');
  form.children.splice(indice,0,{type:'Dropdown',name:'cantidad',label:'Cantidad',required:false,visible:dato('l0_visible'),
    'data-source':Array.from({length:MAX_CANTIDAD_FLOW},(_,i)=>({id:String(i+1),title:String(i+1)}))});
  form.children.splice(indice+1,0,{type:'TextCaption',text:'La cantidad comparte opciones y nota. Para preparaciones distintas, agrega otro renglón.',visible:dato('l0_visible')});
  for(const c of form.children.filter(c=>c['on-click-action']))c['on-click-action'].payload.cantidad=campo('cantidad');
  const payload=form.children.at(-1)['on-click-action'].payload;
  form.children.splice(-1,0,{type:'EmbeddedLink',text:'Guardar y ver categorías','on-click-action':{name:'data_exchange',payload:{...payload,operacion:'categorias'}}});
  const comunes=Object.fromEntries(['revision','resumen','error','error_visible'].map(k=>[k,structuredClone(p.data[k])]));
  const intro=[{type:'TextSubheading',text:dato('resumen')},{type:'TextBody',text:dato('error'),visible:dato('error_visible')}];
  const menu={id:'MENU',title:'Menú por categorías',data:{...comunes,categorias:lista},layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form',children:[
    ...intro,{type:'Dropdown',name:'categoria',label:'Elige una categoría',required:false,'data-source':dato('categorias'),
      'on-select-action':{name:'data_exchange',payload:{revision:dato('revision'),operacion:'categoria',categoria:campo('categoria')}}},
    {type:'Footer',label:'ORDEN COMPLETA','on-click-action':{name:'data_exchange',payload:{revision:dato('revision'),operacion:'terminar'}}}]}]}};
  const data={...comunes,tortilla_inicial:str()},iniciales={tortilla:dato('tortilla_inicial')};
  const children=[...intro,{type:'TextBody',text:'Elige tortilla y cantidades. Cada cantidad es por pieza. Para tortillas diferentes, agrega otro lote.'},
    {type:'Dropdown',name:'tortilla',label:'Tortilla de este lote',required:false,'data-source':[{id:'harina',title:'Harina'},{id:'maiz',title:'Maíz'}]}];
  const lote={revision:dato('revision'),tortilla:campo('tortilla')};
  for(let i=0;i<MAX_TACOS_LOTE;i++) {
    const k=`t${i}`;
    data[`${k}_visible`]=bool();data[`${k}_titulo`]=str('Taco · $25 c/u');data[`${k}_inicial`]=str('0');data[`${k}_activo`]=bool();data[`${k}_nota`]=str();
    data[`${k}_cantidades`]={...structuredClone(lista),items:{type:'object',properties:{...lista.items.properties,
      'on-select-action':{type:'object',properties:{name:{const:'update_data'},payload:{type:'object',properties:{[`${k}_activo`]:{type:'boolean'},[`${k}_nota`]:{type:'string'}}}}}}},
      __example__:[{id:'0',title:'0','on-select-action':{name:'update_data',payload:{[`${k}_activo`]:false,[`${k}_nota`]:''}}}]};
    children.push({type:'TextSubheading',text:dato(`${k}_titulo`),visible:dato(`${k}_visible`)},
      {type:'Dropdown',name:`${k}_q`,label:'Cantidad',required:false,visible:dato(`${k}_visible`),'data-source':dato(`${k}_cantidades`)},
      {type:'TextArea',name:`${k}_nota`,label:'Nota para estos tacos',required:false,visible:dato(`${k}_activo`),'max-length':300,'helper-text':'Opcional. La nota aplica a estas piezas.'});
    iniciales[`${k}_q`]=dato(`${k}_inicial`);iniciales[`${k}_nota`]=dato(`${k}_nota`);
    lote[`${k}_q`]=campo(`${k}_q`);lote[`${k}_nota`]=campo(`${k}_nota`);
  }
  children.push({type:'Dropdown',name:'personalizar',label:'Otros tacos',required:false,
    'data-source':[{id:'individual',title:'Elegir y personalizar un taco'}],
    'on-select-action':{name:'data_exchange',payload:{...lote,operacion:'individual'}}});
  for(const [text,operacion] of [['Agregar más','agregar'],['Guardar y ver categorías','categorias']])children.push({type:'EmbeddedLink',text,'on-click-action':{name:'data_exchange',payload:{...lote,operacion}}});
  children.push({type:'Footer',label:'ORDEN COMPLETA','on-click-action':{name:'data_exchange',payload:{...lote,operacion:'terminar'}}});
  const tacos={id:'TACOS',title:'Tacos por cantidad',data,layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form','init-values':iniciales,children}]}};
  return {...f,routing_model:{MENU:['TACOS','PLATILLO','ENTREGA'],TACOS:['PLATILLO','ENTREGA'],PLATILLO:['ENTREGA'],ENTREGA:[]},
    screens:[menu,tacos,p,entrega].map(s=>({...s,refresh_on_back:true}))};
}
