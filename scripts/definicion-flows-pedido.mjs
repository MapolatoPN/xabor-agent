// JSON de Meta versionable, sin secretos, ids del negocio ni catálogo duplicado.
// Los ejemplos solo documentan tipos; en cada envío Xabor provee la foto real.
import { MAX_LINEAS_FLOW,GRUPOS_POR_LINEA_FLOW } from '../src/mesero-agente/formularioAgrupado.js';
const dato = k => '${data.'+k+'}';
const campo = k => '${form.'+k+'}';
const lista = {type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},description:{type:'string'},metadata:{type:'string'}}},
  __example__:[{id:'o0',title:'Opción',description:'',metadata:''}]};
const string = (v='')=>({type:'string',__example__:v});
const boolean = ()=>({type:'boolean',__example__:false});
const number = (v=0)=>({type:'number',__example__:v});
const flow=(id,title,data,children,iniciales={})=>({version:'7.3',screens:[{id,title,terminal:true,data,
  layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'form',...(Object.keys(iniciales).length?{'init-values':iniciales}:{}),children}]}}]});

export function definicionProductos() {
  const children=[{type:'TextBody',text:'Elige hasta tres platillos. Después podrás personalizarlos juntos.'}];
  const payload={};
  for(let i=0;i<3;i++) {
    children.push({type:'Dropdown',name:`producto${i}`,label:`Platillo ${i+1}`,
      required:i===0,'data-source':dato('productos'),...(i?{visible:dato(i===1?'segundo':'tercero')}: {})});
    payload[`producto${i}`]=campo(`producto${i}`);
  }
  children.push({type:'Footer',label:'Personalizar','on-click-action':{name:'complete',payload}});
  return flow('PRODUCTOS','Arma tu pedido',{productos:lista,segundo:boolean(),tercero:boolean()},children);
}

export function definicionConfigurar() {
  const data={},children=[],payload={},iniciales={};
  for(let l=0;l<MAX_LINEAS_FLOW;l++) {
    data[`l${l}_visible`]=boolean();data[`l${l}_titulo`]=string('Platillo');data[`l${l}_precio`]=string('Precio base');
    children.push({type:'TextSubheading',text:dato(`l${l}_titulo`),visible:dato(`l${l}_visible`)});
    children.push({type:'TextCaption',text:dato(`l${l}_precio`),visible:dato(`l${l}_visible`)});
    for(let g=0;g<GRUPOS_POR_LINEA_FLOW;g++) {
      const k=`g${l*GRUPOS_POR_LINEA_FLOW+g}`;
      for(const b of ['simple','multiple','requerido'])data[`${k}_${b}`]=boolean();
      data[`${k}_label`]=string('Opciones');data[`${k}_min`]=number();data[`${k}_max`]=number(1);
      data[`${k}_opciones`]=lista;data[`${k}_ayuda`]=string();
      data[`${k}_inicial_s`]=string();data[`${k}_inicial_m`]={type:'array',items:{type:'string'},__example__:[]};
      children.push({type:'Dropdown',name:`${k}_s`,label:dato(`${k}_label`),visible:dato(`${k}_simple`),
        required:dato(`${k}_requerido`),'data-source':dato(`${k}_opciones`)});
      children.push({type:'CheckboxGroup',name:`${k}_m`,label:dato(`${k}_label`),visible:dato(`${k}_multiple`),
        required:dato(`${k}_requerido`),'data-source':dato(`${k}_opciones`),
        'min-selected-items':dato(`${k}_min`),'max-selected-items':dato(`${k}_max`),description:dato(`${k}_ayuda`)});
      for(const tipo of ['s','m']) {
        payload[`${k}_${tipo}`]=campo(`${k}_${tipo}`);
        iniciales[`${k}_${tipo}`]=dato(`${k}_inicial_${tipo}`);
      }
    }
  }
  data.modalidades=lista;data.pagos=lista;data.modalidad_inicial=string();data.pago_inicial=string();
  children.push({type:'TextSubheading',text:'Para todo el pedido'});
  for(const [name,label,source] of [['modalidad','Entrega','modalidades'],['pago','Forma de pago','pagos']]) {
    children.push({type:'Dropdown',name,label,required:true,'data-source':dato(source)});
    iniciales[name]=dato(`${name}_inicial`);payload[name]=campo(name);
  }
  children.push({type:'TextCaption',text:'Revisarás el total antes de confirmar. Si eliges domicilio, te pediremos la dirección.'});
  children.push({type:'Footer',label:'Revisar pedido','on-click-action':{name:'complete',payload}});
  return flow('PEDIDO','Personaliza tu pedido',data,children,iniciales);
}
