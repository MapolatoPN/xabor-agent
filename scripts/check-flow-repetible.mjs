import assert from 'node:assert/strict';
import { borradorInicial,cambiarBorrador,respuestaBorrador,MAX_PLATILLOS_FLOW } from '../src/mesero-agente/flowRepetible.js';
import { comandosFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { definicionFlowRepetible } from './definicion-flow-repetible.mjs';
const foto={tipo:'flow_productos',version:'repetible_v1',productos:[{id:'1',nombre:'Mixtos',precio:205,grupos:[
  {nombre:'Salsa',minimo:1,maximo:2,opciones:[{nombre:'Roja',precio:0},{nombre:'Verde',precio:0}]},
  {nombre:'Proteína',minimo:1,maximo:1,opciones:[{nombre:'Pollo',precio:0}]}]}],
  modalidades:[{valor:'recoger en tienda',titulo:'Recoger'}],pagos:[{valor:'efectivo',titulo:'Efectivo'}]};
const item={producto0:'p0',g0_m:['p0g0o0','p0g0o1'],g1_s:'p0g1o0'};
const paso=(b,operacion,campos={})=>cambiarBorrador(foto,b,{action:'data_exchange',screen:b.etapa,
  data:{revision:String(b.revision),operacion,...campos}});
for(const n of [1,2,3,4,8]) {
  let b=borradorInicial();
  for(let i=0;i<n;i++) {
    b=paso(b,i===n-1?'terminar':'agregar',item).borrador;
    assert.equal(b.items.length,i+1);assert.equal(b.revision,i+1);
  }
  assert.equal(b.etapa,'ENTREGA');assert.equal(b.items.length,n);
  b=paso(b,'revisar',{modalidad:'m0',pago:'p0'}).borrador;
  const comandos=comandosFormulario(foto,{items:b.items,modalidad:b.modalidad,pago:b.pago});
  assert.equal(comandos.filter(c=>c.herramienta==='agregar_producto').length,n);
  assert.equal(comandos.filter(c=>c.herramienta==='definir_entrega').length,1);
  assert.equal(comandos.filter(c=>c.herramienta==='definir_pago').length,1);
  assert(comandos.every(c=>!['confirmar_pedido','crear_pago'].includes(c.herramienta)));
  assert.deepEqual(respuestaBorrador(foto,b,'token').data.extension_message_response.params,
    {flow_token:'token',revision:String(n+1)});
}
for(const malo of [{},{...item,g1_s:''},{...item,g0_m:['p0g0o0','p0g0o0']},{...item,g0_m:['p1g0o0']},
  {...item,total:1},{...item,producto0:'p00'},{...item,g5_m:['p0g5o0']}]) {
  const b=borradorInicial(),r=paso(b,'agregar',malo);assert(r.error);assert.deepEqual(r.borrador,b);
}
let b=paso(borradorInicial(),'agregar',item).borrador;
assert.equal(paso(b,'terminar').borrador.items.length,1,'terminar vacío no agrega otro');
assert.equal(respuestaBorrador(foto,b,'token').data.producto_inicial,'');
const incompleto={revision:'1',producto0:'p0',g0_m:['p0g0o1']};
const error=respuestaBorrador(foto,b,'token','Completa',incompleto);
assert.equal(error.data.producto_inicial,'p0');assert.deepEqual(error.data.g0_inicial_m,['p0g0o1']);
const vencida=cambiarBorrador(foto,b,{action:'data_exchange',screen:'PLATILLO',data:{...item,revision:'0',operacion:'agregar'}});
assert.deepEqual(vencida.borrador,b);assert(vencida.error);
while(b.items.length<MAX_PLATILLOS_FLOW)b=paso(b,'agregar',item).borrador;
assert(paso(b,'agregar',item).error);assert.equal(paso(b,'terminar').borrador.etapa,'ENTREGA');
const def=definicionFlowRepetible();assert.equal(def.data_api_version,'3.0');
const hijos=def.screens[0].layout.children[0].children;
assert.equal(hijos.filter(c=>c.name?.startsWith('producto')).length,1);
assert.equal(hijos.filter(c=>c.type==='Footer').length,1);
assert.equal(hijos.at(-1).label,'ORDEN COMPLETA');
assert(hijos.some(c=>c.type==='EmbeddedLink' && c.text==='Agregar más' && c['on-click-action'].name==='data_exchange'));
assert(hijos.every(c=>!['modalidad','pago'].includes(c.name)));
// Cada dato update_data está declarado, sin campos de otros renglones.
const vista=respuestaBorrador(foto,borradorInicial(),'token');
assert.deepEqual(Object.keys(vista.data).sort(),Object.keys(def.screens[0].data).sort());
for(const p of vista.data.productos0)assert(Object.keys(p['on-select-action'].payload).every(k=>k in def.screens[0].data));
console.log('OK Flow repetible: 1/2/3/4/8 platillos, dos acciones, una ventana, errores sin borrar elecciones, sin confirmar/cobrar.');
