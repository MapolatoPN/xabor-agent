import assert from 'node:assert/strict';
import { conversionFormularioActiva, seleccionSinExtras, pideRepetir } from '../src/mesero-agente/conversionFormulario.js';
import { validarPropuesta, proponerPrellenado, filasParaRepetir, borradorPrellenado } from '../src/mesero-agente/prellenadoFormulario.js';
import { datosPersonalizar, datosEditar } from '../src/mesero-agente/catalogoFlowTienda.js';
import { eventoActividadFormulario } from '../src/mesero-agente/actividadFormulario.js';
import { seguimientoFormulario } from '../src/services/seguimientoFormulario.js';
import { resumirFormularios } from '../src/services/embudoFormularios.js';
const grupo=(nombre,opciones)=>({nombre,minimo:1,maximo:1,opciones:opciones.map(([nombre,precio])=>({nombre,precio}))});
const grupos=[grupo('Salsa',[['Verde',0],['Roja',0]]),grupo('Complementos',[['Sin complementos',0],['Granola',20]]),
  grupo('Tipo de leche',[['Entera',0],['Almendra',25]]),grupo('Flores',[['No',0],['Sí',100]])];
const foto={version:'tienda_v1',conversion_v1:true,productos:[{id:'c',nombre:'Chilaquiles Mixtos',precio:120,grupos}],
  lineas:[],modalidades:[{valor:'recoger en tienda'}],pagos:[{valor:'efectivo'}]};
const mensaje='Quiero 2 Chilaquiles Mixtos Verde';
const propuesta={lineas:[{producto_id:'c',cantidad:2,fragmento:'2 Chilaquiles Mixtos Verde',opciones:[{grupo:'Salsa',opcion:'Verde'}]}]};
let n=0;
async function caso(nombre,fn){await fn();console.log(`OK conversión ${++n}: ${nombre}`);}
await caso('bandera apagada por omisión y repetición explícita',()=>{
  assert(!conversionFormularioActiva({}));assert(pideRepetir('Quiero repetir mi último pedido'));
  assert(!pideRepetir('¿Me puedes repetir mi pedido? ¿ya salió?'));
});
await caso('solo omisiones gratuitas de extras; salsa/leche y cualquier extra de pago siguen sin elegir',()=>{
  assert.deepEqual(seleccionSinExtras(grupos),{1:[0],3:[0]});
  assert.deepEqual(seleccionSinExtras([grupo('Complementos',[['Sin complementos',5],['Granola',20]])]),{});
  assert.deepEqual(seleccionSinExtras(grupos,{1:[1]}),{1:[1],3:[0]});
  const d=datosPersonalizar(foto,0,null,{apertura:'r0.p0'});
  assert.equal(d.g1_inicial_r,'o0');assert.equal(d.g0_inicial_r,'');assert.equal(d.g2_inicial_r,'');
  assert.equal(datosPersonalizar({...foto,conversion_v1:false},0,null,{apertura:'r0.p0'}).g1_inicial_r,'');
});
await caso('precarga conserva cantidad y salsa explícitas, deja leche pendiente y no modifica foto',()=>{
  const copia=structuredClone(foto),filas=validarPropuesta(foto,mensaje,propuesta);
  assert.equal(filas.length,1);assert.equal(filas[0].item.cantidad,'2');assert.equal(filas[0].item.g0_s,'p0g0o0');
  assert.equal(filas[0].item.g2_s,'');assert.deepEqual(foto,copia);
  const b=borradorPrellenado(foto,filas);assert.equal(b.revision,0);assert.equal(b.etapa,'TIENDA');assert.equal(b.siguiente,1);
  assert.equal(datosEditar(foto,filas[0],null,{revision:0}).g1_inicial_r,'o0');
});
await caso('rechaza IDs inventados, cantidades sin evidencia, notas negadas y campos de confirmación/precio',()=>{
  for(const change of [{producto_id:'ajeno'},{cantidad:3},{fragmento:'2 Chilaquiles Mixtos sin crema'},
    {precio:1},{confirmar:true},{cantidad:21},{opciones:[{grupo:'Salsa',opcion:'Roja'}]}]){
    const p={lineas:[{...propuesta.lineas[0],...change}]};const r=validarPropuesta(foto,mensaje,p);
    if(change.opciones)assert.equal(r[0].item.g0_s,'');else assert.deepEqual(r,[]);
  }
  assert.deepEqual(validarPropuesta(foto,'2 Chilaquiles Mixtos sin crema',{lineas:[{...propuesta.lineas[0],fragmento:'2 Chilaquiles Mixtos sin crema'}]}),[]);
  assert.deepEqual(validarPropuesta(foto,mensaje,{lineas:[...propuesta.lineas,...propuesta.lineas]}).length,1);
  assert.deepEqual(validarPropuesta({...foto,productos:[...foto.productos,{...foto.productos[0],id:'otro'}]},mensaje,propuesta),[]);
  assert.deepEqual(validarPropuesta(foto,mensaje,{lineas:Array(21).fill(propuesta.lineas[0])}),[]);
});
await caso('modelo forzado; ignora texto libre, herramientas adicionales, truncado y timeout',async()=>{
  let llamadas=0;
  const respuesta={stop_reason:'tool_use',content:[{type:'tool_use',name:'proponer_borrador',input:propuesta}]};
  const llamarModelo=async p=>{
    llamadas++;assert.equal(p.tool_choice.name,'proponer_borrador');assert.equal(p.tools.length,1);
    // Contrato del proveedor real: rechaza maxItems/minimum/maximum en modo
    // estricto, aunque un doble permisivo aceptaría estos esquemas.
    const recorrer=nodo=>{if(!nodo || typeof nodo!=='object')return;
      for(const [k,v] of Object.entries(nodo)){assert(!['maxItems','minItems','minimum','maximum','maxLength','minLength'].includes(k),k);recorrer(v);}};
    recorrer(p.tools[0].input_schema);return respuesta;
  };
  assert.equal((await proponerPrellenado({foto,mensaje,llamarModelo})).length,1);assert.equal(llamadas,1);
  for(const r of [{stop_reason:'max_tokens',content:respuesta.content},{stop_reason:'end_turn',content:[{type:'text',text:'Ya cobré'}]},
    {...respuesta,content:[...respuesta.content,...respuesta.content]}])assert.deepEqual(await proponerPrellenado({foto,mensaje,llamarModelo:async()=>r}),[]);
  assert.deepEqual(await proponerPrellenado({foto,mensaje,llamarModelo:()=>new Promise(()=>{}),topeMs:5}),[]);
  assert.deepEqual(await proponerPrellenado({foto,mensaje,llamarModelo:async()=>{throw Error('sin proveedor');}}),[]);
});
await caso('repetir solo productos vigentes; no copia pago, fecha, domicilio, precio ni notas antiguos',()=>{
  const items=[{producto_id:'c',cantidad:3,precio_unitario:1,notas:'dirección antigua',forma_pago:'tarjeta'}];
  const r=filasParaRepetir(foto,items);assert.equal(r[0].item.cantidad,'3');assert.equal(r[0].item.observaciones,'');
  assert.equal(r[0].item.g0_s,'');assert.equal(foto.productos[0].precio,120);
  assert.deepEqual(filasParaRepetir(foto,[...items,{producto_id:'agotado',cantidad:1}]),[]);
});
await caso('telemetría de pantalla es enumerada y el panel recomienda ayuda solo con evidencia',()=>{
  const clave='a'.repeat(64),paso={borrador:{etapa:'TIENDA',revision:0,vista:{pantalla:'PERSONALIZAR'}}};
  const e=eventoActividadFormulario({action:'data_exchange'},paso,clave,{tienda:true,detalle:true});assert.equal(e.pantalla,'PERSONALIZAR');
  assert(!Object.hasOwn(eventoActividadFormulario({action:'INIT'},paso,clave,{tienda:true}),'pantalla'));
  assert.equal(eventoActividadFormulario({action:'INIT'},{borrador:{...paso.borrador,vista:{pantalla:'domicilio secreto'}}},clave,{tienda:true,detalle:true}).pantalla,null);
  const ahora=Date.now(),fila={estado:'disponible',created_at:new Date(ahora),eventos:[{...e,tipo:'validacion',observado_at:new Date(ahora)}]};
  const s=seguimientoFormulario(fila,{ahora});assert(s.sugerirAyuda);assert.equal(s.paso,'Personalización');
  fila.eventos.push({...e,tipo:'paso',observado_at:new Date(ahora+1)});assert(!seguimientoFormulario(fila,{ahora:ahora+2}).sugerirAyuda);
  fila.estado='terminada';assert(!seguimientoFormulario(fila,{ahora:ahora+20*60000}).sugerirAyuda);
});
await caso('embudo deduplica reenvíos; abrir/finalizar/aplicar no equivale a registrar ni pagar',()=>{
  const f={session_id:'agente:local',ciclo:'c1',estado:'disponible',eventos:[{tipo:'apertura',paso:'TIENDA',pantalla:'MENU',observado_at:'2026-10-18T12:00:00Z'}]};
  const otra={...f,eventos:[{tipo:'paso',paso:'TIENDA',pantalla:'PERSONALIZAR',observado_at:'2026-10-18T12:01:00Z'}]};
  const r=resumirFormularios([f,otra,{session_id:'otro',ciclo:'c2',eventos:[],registrado:true}]);
  assert.equal(r.ciclosOfrecidos,2);assert.equal(r.formulariosEntregados,3);assert.equal(r.conActividadObservada,1);
  assert.equal(r.sinAperturaObservada,1);assert.equal(r.pendientesPorPantalla.PERSONALIZAR,1);assert.equal(r.pedidosRegistrados,0);
  assert.equal(r.pagosConfirmados,0);assert.equal(r.conversionPorcentaje,0);assert.equal(resumirFormularios().conversionPorcentaje,null);
});
console.log(`CONVERSIÓN: ${n} pruebas correctas`);
