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

// El selector y las opciones comparten ventana. Las acciones de cada producto
// actualizan SOLO su bloque; no hay llamadas al modelo ni al servidor por toque.
export function definicionPedidoContinuo() {
  const f=definicionConfigurar(),s=f.screens[0],form=s.layout.children[0];
  s.id='PRODUCTOS';s.title='Arma tu pedido';
  const sinEjemplo=v=>Array.isArray(v)?v.map(sinEjemplo):v && typeof v==='object'
    ? Object.fromEntries(Object.entries(v).filter(([k])=>k!=='__example__').map(([k,x])=>[k,sinEjemplo(x)])) : v;
  form.children=form.children.filter(c=>c.type!=='TextSubheading' || c.text==='Para todo el pedido');
  form.children.unshift({type:'TextBody',text:'Elige un platillo y completa sus opciones aquí. El segundo y tercero son opcionales.'});
  const footer=form.children.at(-1);
  for(let l=0;l<MAX_LINEAS_FLOW;l++) {
    const keys=Object.keys(s.data).filter(k=>k.startsWith(`l${l}_`)
      || Array.from({length:6},(_,g)=>`g${l*6+g}_`).some(p=>k.startsWith(p)));
    const properties=Object.fromEntries(keys.map(k=>[k,sinEjemplo(s.data[k])]));
    const ejemplo=Object.fromEntries(keys.map(k=>[k,s.data[k].__example__]));
    s.data[`productos${l}`]={...structuredClone(lista),items:{type:'object',properties:{...lista.items.properties,
      'on-select-action':{type:'object',properties:{name:{const:'update_data'},payload:{type:'object',properties}}}}},
      __example__:[{id:'p0',title:'Platillo',description:'',metadata:'$100',
        'on-select-action':{name:'update_data',payload:ejemplo}}]};
    const at=form.children.findIndex(c=>c.text===dato(`l${l}_precio`));
    form.children.splice(at,0,{type:'Dropdown',name:`producto${l}`,label:l===0?'Elige tu platillo':`Agregar platillo ${l+1}`,
      required:l===0,'data-source':dato(`productos${l}`)});
    footer['on-click-action'].payload[`producto${l}`]=campo(`producto${l}`);
  }
  return f;
}
