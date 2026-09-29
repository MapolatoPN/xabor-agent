import { definicionPedidoContinuo } from './definicion-flows-pedido.mjs';
import { MAX_OBSERVACIONES_PLATILLO } from '../src/mesero-agente/observacionesDelPlatillo.js';
const dato=k=>'${data.'+k+'}';
const string=(v='')=>({type:'string',__example__:v});
const boolean=()=>({type:'boolean',__example__:true});

// Un único platillo reutilizable mediante data_exchange. No publica en Meta.
export function definicionFlowRepetible() {
  const base=definicionPedidoContinuo().screens[0],form=base.layout.children[0];
  const comunes={revision:string('0'),resumen:string('Tu pedido'),error:string(),error_visible:boolean()};
  const porcion=k=>k==='productos0' || k.startsWith('l0_') || /^g[0-5]_/.test(k);
  const payload={revision:dato('revision'),observaciones:'${form.observaciones}'};
  for(const [k,v] of Object.entries(form.children.at(-1)['on-click-action'].payload))
    if(k==='producto0' || /^g[0-5]_[sm]$/.test(k))payload[k]=v;
  const intro=[{type:'TextSubheading',text:dato('resumen')},
    {type:'TextBody',text:dato('error'),visible:dato('error_visible')}];
  const children=form.children.filter(c=>c.name==='producto0' || /^g[0-5]_[sm]$/.test(c.name || '') || c.text===dato('l0_precio'));
  // La validación obligatoria ocurre en Xabor para ambas acciones. Esto permite
  // ORDEN COMPLETA con el selector vacío después del último Agregar más.
  for(const c of children)if(c.name) {c.required=false;if(c.name==='producto0')c.visible=dato('puede_elegir');}
  const pantalla={id:'PLATILLO',title:'Arma tu pedido',data:{...Object.fromEntries(Object.entries(base.data).filter(([k])=>porcion(k))),
    ...comunes,producto_inicial:string(),observaciones_inicial:string(),puede_agregar:boolean(),puede_elegir:boolean()},
    layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form','init-values':{
      ...Object.fromEntries(Object.entries(form['init-values']).filter(([k])=>/^g[0-5]_[sm]$/.test(k))),producto0:dato('producto_inicial'),
      observaciones:dato('observaciones_inicial')},
      children:[...intro,...children,{type:'TextArea',name:'observaciones',label:'Nota para cocina',required:false,
        'helper-text':'Opcional: sin crema, huevos bien cocidos. Extras: usa las opciones.',
        'max-length':MAX_OBSERVACIONES_PLATILLO,visible:dato('l0_visible')},
      {type:'EmbeddedLink',text:'Agregar más',visible:dato('puede_agregar'),
        'on-click-action':{name:'data_exchange',payload:{...payload,operacion:'agregar'}}},
      {type:'TextCaption',text:'ORDEN COMPLETA termina la selección. Revisarás el total antes de confirmar.'},
      {type:'Footer',label:'ORDEN COMPLETA','on-click-action':{name:'data_exchange',payload:{...payload,operacion:'terminar'}}}]}]}};
  const entrega={id:'ENTREGA',title:'Entrega y pago',terminal:true,data:{...comunes,
    ...Object.fromEntries(Object.entries(base.data).filter(([k])=>['modalidades','pagos','modalidad_inicial','pago_inicial'].includes(k)))},
    layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form','init-values':{
      modalidad:dato('modalidad_inicial'),pago:dato('pago_inicial')},children:[...intro,
      ...form.children.filter(c=>['modalidad','pago'].includes(c.name)),
      {type:'TextCaption',text:'Esto prepara el resumen. No confirma ni cobra tu pedido.'},
      {type:'Footer',label:'Revisar pedido','on-click-action':{name:'data_exchange',payload:{
        revision:dato('revision'),operacion:'revisar',modalidad:'${form.modalidad}',pago:'${form.pago}'}}}]}]}};
  return {version:'7.3',data_api_version:'3.0',routing_model:{PLATILLO:['ENTREGA'],ENTREGA:[]},screens:[pantalla,entrega]};
}
